/**
 * graphAnalysis.ts
 *
 * Provides six analysis tools:
 *   A. TfIdfIndex      — cosine-similarity document search + implicit connection discovery
 *   B. computePageRank — document ranking by link importance (popular hub detection)
 *   C. detectClusters  — Union-Find connected components; detectTopicClusters — Louvain communities (shared core)
 *   D. detectBridgeNodes — detect bridge nodes connecting multiple clusters
 *   E. getClusterTopics  — extract top TF-IDF keywords per cluster
 *   F. findImplicitLinks — discover hidden semantically similar connections without WikiLinks
 */

import type { LoadedDocument } from '@/types'
import { detectCommunities } from '@shared/lint/community'
import { logger } from '@/lib/logger'
import { expandTerms, SYNONYM_MAP } from '@/lib/synonyms'

// ── Shared tokenizer ─────────────────────────────────────────────────────────

const KO_SUFFIXES = [
  '이라는', '이라고', '에서는', '에게서', '한테서', '으로서', '으로써', '으로는',
  '에서의', '으로의', '에서도', '으로도',
  '이라', '에서', '에게', '한테', '까지', '부터', '처럼', '같은', '같이',
  '만큼', '으로', '이랑', '라는', '라고', '이란', '에는', '하고',
  '님의', '님이', '님을', '님은', '님께', '님도', '님과',
  '은', '는', '이', '가', '을', '를', '와', '과',
  '에', '도', '만', '의', '로', '님',
]

const _stemCache = new Map<string, string[]>()
const _stemPrimaryCache = new Map<string, string[]>()

/**
 * BM25 additive weight for 2-gram subtokens (original term = 1.0).
 *
 * tokenize() breaks Korean tokens of 3+ syllables into sliding 2-grams and puts them
 * alongside the original into both the index and the query. Summing them as-is structurally
 * over-weights multi-syllable proper nouns: "캐릭터G" → 캐릭터G/다이/이잔, 3 terms all added so one concept
 * counts 3x, while 2-syllable "루모"/"에녹" count only 1x. Meaningless subtokens like
 * "세계관" → "계관" (255 docs) are also treated on par with the original.
 * → search() adds subtokens attenuated by this weight, and excludes them from both the
 *   numerator and denominator of the coverage calculation.
 *
 * Why subtokens share the term space instead of a separate namespace (prefix):
 * graphRAG's directVaultSearch / rerank do substring matching on tokenize() output and
 * divide by `terms.length` / `queryStems.size`, so adding a prefix would put unmatchable
 * tokens into the denominator and uniformly shrink those coverage scores.
 */
export const SUBTOKEN_WEIGHT = 0.3

/** Extract only Hangul syllables (가~힣) */
function koSyllables(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xAC00 && c <= 0xD7A3) out.push(s[i])
  }
  return out
}

/** Up to the particle-stripped stem (excluding 2-gram subtokens) */
function stemPrimary(token: string): string[] {
  const cached = _stemPrimaryCache.get(token)
  if (cached) return cached
  const results = [token]
  for (const suffix of KO_SUFFIXES) {
    if (token.endsWith(suffix) && token.length > suffix.length + 1) {
      results.push(token.slice(0, -suffix.length))
      break
    }
  }
  _stemPrimaryCache.set(token, results)
  return results
}

/** Sliding 2-gram subtokens when the stem has 3+ syllables ("전투시스템" → 전투/시스/스템) */
function subtokensOf(token: string): string[] {
  const primary = stemPrimary(token)
  const syl = koSyllables(primary[primary.length - 1])
  if (syl.length < 3) return []
  const subs: string[] = []
  for (let i = 0; i <= syl.length - 2; i++) subs.push(syl[i] + syl[i + 1])
  return subs
}

function stemKorean(token: string): string[] {
  const cached = _stemCache.get(token)
  if (cached) return cached
  const out = [...new Set([...stemPrimary(token), ...subtokensOf(token)])]
  _stemCache.set(token, out)
  return out
}

/** Korean number+unit separation: "28일" → "28 일" (so it matches "28" in the filename "[2026.01.28]") */
function normalizeForTokenize(text: string): string {
  return text.replace(/(\d+)(년|월|일|주|시간|시|분|초|개|명|번|회|차)/g, '$1 $2')
}

function splitRawTokens(normalized: string): string[] {
  return normalized
    .toLowerCase()
    .split(/[\s,.\-_?!;:()[\]{}'"《》「」【】]+/)
    .filter(t => t.length > 1 || t in SYNONYM_MAP)
}

/** Date padding: single-digit number + 월/일 → restore zero-padded token ("1월" → "01") */
function collectDatePadTokens(normalized: string, out: (t: string) => void): void {
  const dateUnitRe = /(\d{1,2})\s*(월|일)/g
  let m: RegExpExecArray | null
  while ((m = dateUnitRe.exec(normalized)) !== null) {
    const num = m[1]
    if (num.length === 1) out(num.padStart(2, '0'))
  }
}

export function tokenize(text: string): string[] {
  const normalized = normalizeForTokenize(text)
  const raw = splitRawTokens(normalized)

  const stems: string[] = []
  for (const token of raw) {
    for (const stem of stemKorean(token)) {
      stems.push(stem)
    }
  }

  collectDatePadTokens(normalized, t => stems.push(t))
  return stems
}

/**
 * Query-only tokenization — returns a term → BM25 additive weight map.
 *
 * Original tokens, particle-stripped stems and date-padded tokens get 1.0;
 * 2-gram subtokens derived from 3+ syllable tokens get SUBTOKEN_WEIGHT (0.3).
 * If a subtoken is also an original token, 1.0 takes precedence.
 */
export function tokenizeQueryWeighted(query: string): Map<string, number> {
  const normalized = normalizeForTokenize(query)
  const raw = splitRawTokens(normalized)

  const primary = new Set<string>()
  const subs = new Set<string>()
  for (const token of raw) {
    for (const s of stemPrimary(token)) primary.add(s)
    for (const s of subtokensOf(token)) subs.add(s)
  }
  collectDatePadTokens(normalized, t => primary.add(t))

  const out = new Map<string, number>()
  for (const t of subs) out.set(t, SUBTOKEN_WEIGHT)
  for (const t of primary) out.set(t, 1)
  return out
}

// ── A. BM25 Index (TF-IDF → BM25 migration) ─────────────────────────────────

export interface TfIdfResult {
  docId: string
  filename: string
  speaker: string
  score: number
}

/**
 * Extract the content creation date from a filename (ms since epoch).
 * Patterns: [2023_05_02], 20250723, _250328, _260106, etc.
 * Returns 0 when nothing matches.
 */
export function parseFilenameDate(filename: string): number {
  const now = Date.now() + 30 * 86_400_000  // 30-day slack (allows future-scheduled documents)
  // Boundary: word boundary or non-digit (brackets, underscores, spaces, hyphens, etc.)
  const B = '(?:^|[^\\d])'   // leading boundary
  const A = '(?:[^\\d]|$)'   // trailing boundary

  // YYYY_MM_DD or YYYY-MM-DD (underscore/hyphen separated, with or without brackets)
  let m = filename.match(new RegExp(`${B}(20[0-3]\\d)[_\\-](0[1-9]|1[0-2])[_\\-](0[1-9]|[12]\\d|3[01])${A}`))
  if (m) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  // YYYYMMDD (8 consecutive digits) — year limited to 2000~2039
  m = filename.match(new RegExp(`${B}(20[0-3]\\d)(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])${A}`))
  if (m) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  // YY_MM_DD (underscore/hyphen separated, e.g. 25_03_28)
  m = filename.match(new RegExp(`${B}(\\d{2})[_\\-](0[1-9]|1[0-2])[_\\-](0[1-9]|[12]\\d|3[01])${A}`))
  if (m) {
    const yy = parseInt(m[1], 10)
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy
    const ms = Date.parse(`${yyyy}-${m[2]}-${m[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  // YYMMDD (6 digits, e.g. 260106)
  m = filename.match(new RegExp(`${B}(\\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])${A}`))
  if (m) {
    const yy = parseInt(m[1], 10)
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy
    const ms = Date.parse(`${yyyy}-${m[2]}-${m[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  return 0
}

/** Extract the document's content date (filename > frontmatter > mtime > 0) */
export function getContentDate(doc: LoadedDocument): number {
  const fromFilename = parseFilenameDate(doc.filename)
  if (fromFilename > 0) return fromFilename
  if (doc.date) {
    const ms = Date.parse(doc.date)
    if (!isNaN(ms)) return ms
  }
  if (doc.mtime) return doc.mtime
  return 0
}

interface BM25Doc {
  docId: string
  filename: string
  speaker: string
  termFreqs: Map<string, number>  // raw term frequencies
  docLen: number                   // total token count of the document
  contentDate: number              // content date (ms), 0 = unknown
  bm25Vec: Map<string, number>    // normalized BM25 vector (for implicit link similarity)
  bm25Norm: number
}

export interface ImplicitLink {
  docAId: string
  docBId: string
  filenameA: string
  filenameB: string
  similarity: number
}

/** BM25 parameters */
const BM25_K1 = 1.5   // term saturation coefficient — controls diminishing returns of frequency
const BM25_B  = 0.75  // document length normalization coefficient

/** Max boost for recent documents (same as mcp/src/state.ts) */
const RECENCY_MAX_BOOST = 0.1
/** Recency exponential decay constant (days) */
const RECENCY_DECAY_DAYS = 180

/**
 * IndexedDB cache schema version — bumping this value on a format change auto-invalidates the cache.
 *
 * v8: (a) Removed rawContent from allText (fixes double-counting the body → all tf/docLen/idf change)
 *     (b) Bundled implicitLinks in the cache (removes O(N²) recomputation on cache hit)
 */
export const TFIDF_SCHEMA_VERSION = 9

export interface SerializedTfIdf {
  schemaVersion: typeof TFIDF_SCHEMA_VERSION
  fingerprint: string
  idf: [string, number][]
  avgdl: number
  /**
   * Precomputed implicit links (avoids O(N²) recomputation).
   * If the fingerprint matches, documents and WikiLinks are the same too, so they can be reused as-is.
   */
  implicitLinks?: ImplicitLink[]
  docs: {
    docId: string
    filename: string
    speaker: string
    termFreqs: [string, number][]
    docLen: number
    contentDate: number
    bm25Vec: [string, number][]
    bm25Norm: number
  }[]
}

export class TfIdfIndex {
  private docs: BM25Doc[] = []
  private idf: Map<string, number> = new Map()
  private avgdl = 0
  private built = false
  private _implicitLinks: ImplicitLink[] | null = null
  private _implicitAdjRef: Map<string, string[]> | null = null

  get isBuilt() { return this.built }
  get docCount() { return this.docs.length }

  /** Inject implicit links precomputed in the Worker (cache warm-up) */
  setImplicitLinks(links: ImplicitLink[], adjacency: Map<string, string[]>): void {
    this._implicitLinks = links
    this._implicitAdjRef = adjacency
  }

  serialize(fingerprint: string): SerializedTfIdf {
    return {
      schemaVersion: TFIDF_SCHEMA_VERSION,
      fingerprint,
      idf: [...this.idf.entries()],
      avgdl: this.avgdl,
      docs: this.docs.map(d => ({
        docId: d.docId,
        filename: d.filename,
        speaker: d.speaker,
        termFreqs: [...d.termFreqs.entries()],
        docLen: d.docLen,
        contentDate: d.contentDate,
        bm25Vec: [...d.bm25Vec.entries()],
        bm25Norm: d.bm25Norm,
      })),
    }
  }

  restore(data: SerializedTfIdf): void {
    this.idf = new Map(data.idf)
    this.avgdl = data.avgdl
    this.docs = data.docs.map(d => ({
      docId: d.docId,
      filename: d.filename,
      speaker: d.speaker,
      termFreqs: new Map(d.termFreqs),
      docLen: d.docLen,
      contentDate: d.contentDate ?? 0,
      bm25Vec: new Map(d.bm25Vec),
      bm25Norm: d.bm25Norm,
    }))
    this._implicitLinks = null
    this._implicitAdjRef = null
    this.built = true
    logger.debug(`[graphAnalysis] BM25 index restored from cache: ${this.docs.length} docs`)
  }

  build(loadedDocuments: LoadedDocument[]): void {
    this.docs = []
    this.idf = new Map()
    this.avgdl = 0
    this.built = false

    const rawTermFreqs = new Map<string, Map<string, number>>()
    const docLens = new Map<string, number>()
    const docFreq = new Map<string, number>()

    for (const doc of loadedDocuments) {
      if ((doc as any).graphWeight === 'skip') continue   // skip docs are excluded from the BM25 index
      // rawContent is the source of sections, so including it too counts the body twice.
      // (All tf doubled → lenNorm distorted, relative weight of filename/tags/speaker diluted by half,
      //  source URL and related filename list from the YAML frontmatter leak in as body terms)
      const allText = [
        doc.filename.replace(/\.md$/i, ''),
        doc.title ?? '',
        // source contains the Jira key (…/browse/SGEATF-160). Putting in rawContent wholesale
        // would count the body twice, so pick only the frontmatter fields we need.
        doc.source ?? '',
        doc.tags?.join(' ') ?? '',
        doc.speaker ?? '',
        ...doc.sections.map(s => `${s.heading} ${s.body}`),
      ].join(' ')

      const tokens = tokenize(allText)
      const termFreq = new Map<string, number>()
      for (const token of tokens) {
        termFreq.set(token, (termFreq.get(token) ?? 0) + 1)
      }
      rawTermFreqs.set(doc.id, termFreq)
      docLens.set(doc.id, tokens.length)

      for (const term of termFreq.keys()) {
        docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
      }
    }

    const N = docLens.size  // based on the count of docs after the skip filter
    const totalLen = [...docLens.values()].reduce((a, b) => a + b, 0)
    this.avgdl = N > 0 ? totalLen / N : 1

    // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1))
    }

    // BM25 weight vector + L2 norm (for implicit link similarity)
    for (const doc of loadedDocuments) {
      if ((doc as any).graphWeight === 'skip') continue   // skip docs are excluded from vectors too
      const termFreq = rawTermFreqs.get(doc.id)!
      const docLen = docLens.get(doc.id)!
      const lenNorm = 1 - BM25_B + BM25_B * (docLen / this.avgdl)

      const bm25Vec = new Map<string, number>()
      let normSq = 0
      for (const [term, tf] of termFreq) {
        const idfVal = this.idf.get(term) ?? 0
        if (idfVal <= 0) continue
        const w = idfVal * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lenNorm)
        bm25Vec.set(term, w)
        normSq += w * w
      }

      this.docs.push({
        docId: doc.id,
        filename: doc.filename,
        speaker: doc.speaker ?? 'unknown',
        termFreqs: termFreq,
        docLen,
        contentDate: getContentDate(doc),
        bm25Vec,
        bm25Norm: Math.sqrt(normSq),
      })
    }

    this._implicitLinks = null
    this._implicitAdjRef = null
    this.built = true
    logger.debug(`[graphAnalysis] BM25 index built: ${this.docs.length} docs, avgdl=${this.avgdl.toFixed(1)}`)
  }

  /**
   * Single-document incremental update — replaces one file without a full rebuild.
   * IDF of existing terms is kept (approximation), but **new terms get their df measured and registered in this.idf**.
   * (Without registering, `idf.get(term) ?? 0; if (idfVal <= 0) continue` in search() means
   *  searching for a new proper noun from the just-saved document returns 0 results.)
   */
  updateDoc(doc: LoadedDocument): void {
    if (!this.built) return

    // Remove the existing document
    const existingIdx = this.docs.findIndex(d => d.docId === doc.id)
    if (existingIdx !== -1) this.docs.splice(existingIdx, 1)

    // Tokenize the new document (excluding rawContent, same as build() — avoids double-counting the body)
    const allText = [
      doc.filename.replace(/\.md$/i, ''),
      doc.title ?? '',
      doc.source ?? '',   // Jira key (…/browse/SGEATF-160)
      doc.tags?.join(' ') ?? '',
      doc.speaker ?? '',
      ...doc.sections.map(s => `${s.heading} ${s.body}`),
    ].join(' ')
    const tokens = tokenize(allText)
    const termFreq = new Map<string, number>()
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1)

    const docLen = tokens.length
    const totalLen = this.docs.reduce((a, d) => a + d.docLen, 0) + docLen
    const N = this.docs.length + 1
    this.avgdl = totalLen / N

    // ── Register IDF for new terms ────────────────────────────────────────
    // Collect only terms absent from the existing index and measure their df across the other docs.
    const newTerms: string[] = []
    for (const term of termFreq.keys()) {
      if (!this.idf.has(term)) newTerms.push(term)
    }
    if (newTerms.length > 0) {
      const newDf = new Int32Array(newTerms.length).fill(1)  // includes this document itself
      for (const other of this.docs) {
        const tf = other.termFreqs
        for (let i = 0; i < newTerms.length; i++) {
          if (tf.has(newTerms[i])) newDf[i]++
        }
      }
      for (let i = 0; i < newTerms.length; i++) {
        const df = newDf[i]
        this.idf.set(newTerms[i], Math.log((N - df + 0.5) / (df + 0.5) + 1))
      }
    }

    // Compute BM25 vector (existing terms reuse existing IDF)
    const lenNorm = 1 - BM25_B + BM25_B * (docLen / this.avgdl)
    const bm25Vec = new Map<string, number>()
    let normSq = 0
    for (const [term, tf] of termFreq) {
      const idfVal = this.idf.get(term) ?? 0
      if (idfVal <= 0) continue
      const w = idfVal * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lenNorm)
      bm25Vec.set(term, w)
      normSq += w * w
    }

    this.docs.push({
      docId: doc.id,
      filename: doc.filename,
      speaker: doc.speaker ?? 'unknown',
      termFreqs: termFreq,
      docLen,
      contentDate: getContentDate(doc),
      bm25Vec,
      bm25Norm: Math.sqrt(normSq),
    })
    this._implicitLinks = null
  }

  search(query: string, topN: number = 8): TfIdfResult[] {
    if (!this.built || this.docs.length === 0) return []

    // Query tokens + subtoken weights (subtokens are added attenuated to 0.3)
    const baseWeights = tokenizeQueryWeighted(query)
    if (baseWeights.size === 0) return []

    // ── Concept groups ────────────────────────────────────────────────────
    // 1 original query term = 1 concept. Its synonym expansions are the **same concept**.
    // If the coverage denominator were the post-expansion term count, exact matches would
    // lose ground as synonyms grow ("사운드 밸런스" → 6 terms expand to 15, so a document
    //  containing it exactly scores 6/15=0.40 while a sound glossary without 밸런스 gets 7/15=0.47 and overtakes it).
    // Subtokens are not concepts, so they are excluded from both numerator and denominator.
    const conceptGroups: string[][] = []
    for (const [t, w] of baseWeights) {
      if (w < 1) continue   // subtoken
      conceptGroups.push(expandTerms([t]))
    }
    const termConcept = new Map<string, number>()
    conceptGroups.forEach((group, ci) => {
      for (const t of group) if (!termConcept.has(t)) termConcept.set(t, ci)
    })

    // All terms to be scored (including synonym expansions + date combination tokens)
    const allTerms = new Set(expandTerms([...baseWeights.keys()]))

    // Precompute valid terms — moves idf lookups out of the document loop
    const qTerms: string[] = []
    const qIdf: number[] = []
    const qWeight: number[] = []
    const qConcept: number[] = []
    // Max contribution per concept (absolute-scale normalization denominator)
    const conceptMaxIdf = new Float64Array(Math.max(1, conceptGroups.length))
    let ungroupedMax = 0
    let subMax = 0

    for (const term of allTerms) {
      const idfVal = this.idf.get(term) ?? 0
      if (idfVal <= 0) continue
      // Synonym-expanded terms get the same weight (1) as the original term
      const weight = baseWeights.get(term) ?? 1
      const isSub = weight < 1
      const ci = isSub ? -1 : (termConcept.get(term) ?? -1)
      qTerms.push(term)
      qIdf.push(idfVal)
      qWeight.push(weight)
      qConcept.push(ci)
      if (ci >= 0) conceptMaxIdf[ci] = Math.max(conceptMaxIdf[ci], idfVal)
      else if (isSub) subMax += weight * idfVal
      else ungroupedMax += idfVal
    }
    if (qTerms.length === 0) return []

    // ── Compact empty concepts ────────────────────────────────────────────
    // A concept made only of terms absent from the index (particle-suffixed variants like
    // "루모와", "캐릭터G의") can never match any document. Leaving it in the coverage
    // denominator permanently penalizes every document.
    const conceptRemap = new Int32Array(Math.max(1, conceptGroups.length)).fill(-1)
    let conceptCount = 0
    for (let i = 0; i < conceptGroups.length; i++) {
      if (conceptMaxIdf[i] > 0) conceptRemap[i] = conceptCount++
    }
    for (let i = 0; i < qConcept.length; i++) {
      if (qConcept[i] >= 0) qConcept[i] = conceptRemap[qConcept[i]]
    }

    // ── Absolute-scale normalization denominator ──────────────────────────
    // BM25 upper bound of "the ideal document containing every concept most strongly" = Σ concept cap * (k1+1).
    // The old approach of dividing by the top-scoring document made #1 always 1.0 even when
    // irrelevant to the query, so the caller's minBm25Score / BM25_SCORE_THRESHOLD only acted as a pass-through filter.
    //
    // A concept's cap is based on the most informative (max idf) term in its group.
    // Caps are not force-clamped per concept — tightening to the idf of a common head term ("사운드")
    // pins most documents to the cap and collapses the ranking (confirmed empirically).
    const conceptCap = new Float64Array(Math.max(1, conceptCount))
    let denom = 0
    for (let i = 0; i < conceptGroups.length; i++) {
      const ci = conceptRemap[i]
      if (ci < 0) continue
      const cap = conceptMaxIdf[i] * (BM25_K1 + 1)
      conceptCap[ci] = cap
      denom += cap
    }
    denom += (ungroupedMax + subMax) * (BM25_K1 + 1)
    if (denom <= 0) {
      // All concept terms unregistered — only subtokens remain
      for (let i = 0; i < qTerms.length; i++) denom += qWeight[i] * qIdf[i] * (BM25_K1 + 1)
    }
    if (denom <= 0) return []
    // Include the max recency boost in the denominator — so the clamp does not bunch top results at 1.0
    denom *= 1 + RECENCY_MAX_BOOST
    // Reusable buffers using the document index as a stamp (avoids Set/array allocation per document)
    const conceptMark = new Int32Array(Math.max(1, conceptCount)).fill(-1)
    const conceptScore = new Float64Array(Math.max(1, conceptCount))
    const matchedList = new Int32Array(Math.max(1, conceptCount))
    const now = Date.now()
    const scored: { doc: BM25Doc; score: number }[] = []

    for (let di = 0; di < this.docs.length; di++) {
      const doc = this.docs[di]
      const lenNorm = 1 - BM25_B + BM25_B * (doc.docLen / this.avgdl)
      let rawScore = 0          // contribution of terms not belonging to a concept (subtokens, date combinations)
      let matchedConcepts = 0

      for (let i = 0; i < qTerms.length; i++) {
        const tf = doc.termFreqs.get(qTerms[i]) ?? 0
        if (tf === 0) continue
        const contrib = qWeight[i] * qIdf[i] * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lenNorm)
        const ci = qConcept[i]
        if (ci < 0) { rawScore += contrib; continue }
        if (conceptMark[ci] !== di) {
          conceptMark[ci] = di
          conceptScore[ci] = 0
          matchedList[matchedConcepts++] = ci
        }
        conceptScore[ci] += contrib
      }

      // Even when several synonyms within one concept match at once, only limit it to
      // at most 2x that concept's cap. (Clamping fully to the cap flattens the ranking;
      // no limit at all lets top results hit the final clamp and bunch at 1.0)
      for (let k = 0; k < matchedConcepts; k++) {
        const ci = matchedList[k]
        const s = conceptScore[ci]
        const cap = conceptCap[ci] * 2
        rawScore += s < cap ? s : cap
      }

      if (rawScore <= 0) continue

      // Coverage correction: a document matching only 1 of 3 concepts is penalized (gently, via coverage^0.5)
      const coverage = conceptCount > 1 ? matchedConcepts / conceptCount : 1
      let score = rawScore * Math.sqrt(coverage)

      // Recency boost — max +10%, 180-day decay (same formula as mcp/src/state.ts).
      // contentDate comes from getContentDate() (filename date first), so documents
      // without a date frontmatter (27.6% of the vault) still get a date from the filename.
      if (doc.contentDate > 0) {
        const daysOld = (now - doc.contentDate) / 86_400_000
        score *= 1 + RECENCY_MAX_BOOST * Math.exp(-Math.max(0, daysOld) / RECENCY_DECAY_DAYS)
      }

      scored.push({ doc, score })
    }

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, topN).map(s => ({
      docId: s.doc.docId,
      filename: s.doc.filename,
      speaker: s.doc.speaker,
      score: Math.min(1, s.score / denom),
    }))
  }

  /**
   * Returns semantically similar pairs among documents not connected by WikiLinks.
   * Targets pairs whose BM25 weight vector cosine similarity is at or above threshold.
   *
   * To avoid an exhaustive O(N²) comparison (hundreds of unique terms per doc × 3.5M pairs ≈ 1.9B Map lookups):
   *  1. build an inverted index from only each document's top-weighted (= high-idf) terms to narrow down **candidate pairs**,
   *  2. compute the exact cosine only for candidates, and
   *  3. use a size-limited top-K min-heap instead of collecting all pairs into an array and sorting.
   *
   * Returns the cached result if the adjacency reference has not changed.
   * (The cache holds at most IMPLICIT_HEAP_CAP entries, so a larger topN is truncated.)
   */
  findImplicitLinks(
    adjacency: Map<string, string[]>,
    topN: number = 6,
    threshold: number = 0.25
  ): ImplicitLink[] {
    if (!this.built || this.docs.length < 2) return []

    if (this._implicitLinks && this._implicitAdjRef === adjacency) {
      return this._implicitLinks.slice(0, topN)
    }

    const docs = this.docs
    const n = docs.length

    const docIdxMap = new Map<string, number>()
    docs.forEach((d, idx) => docIdxMap.set(d.docId, idx))

    const existingLinks = new Set<number>()
    for (const [from, neighbors] of adjacency) {
      const fi = docIdxMap.get(from)
      if (fi === undefined) continue
      for (const to of neighbors) {
        const ti = docIdxMap.get(to)
        if (ti === undefined) continue
        existingLinks.add(fi < ti ? fi * n + ti : ti * n + fi)
      }
    }

    // ── 1. Select top-weighted terms per document (min-heap, avoids full sort) ──
    const topTerms: string[][] = new Array(n)
    const topWeights: Float64Array[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const hT: string[] = []
      const hW: number[] = []
      for (const [term, w] of docs[i].bm25Vec) {
        if (hW.length < IMPLICIT_TOP_TERMS) {
          minHeapPush(hT, hW, term, w)
        } else if (w > hW[0]) {
          minHeapPop(hT, hW)
          minHeapPush(hT, hW, term, w)
        }
      }
      topTerms[i] = hT
      topWeights[i] = Float64Array.from(hW)
    }

    // ── 2. Build inverted index (term → documents where that term is top-ranked) ──
    const postDocs = new Map<string, number[]>()
    const postWeights = new Map<string, number[]>()
    for (let i = 0; i < n; i++) {
      const ts = topTerms[i], ws = topWeights[i]
      for (let k = 0; k < ts.length; k++) {
        let pd = postDocs.get(ts[k])
        if (pd === undefined) {
          pd = []
          postDocs.set(ts[k], pd)
          postWeights.set(ts[k], [])
        }
        pd.push(i)
        postWeights.get(ts[k])!.push(ws[k])
      }
    }

    // ── 3. Score candidate pairs ──────────────────────────────────────────
    const acc = new Float64Array(n)          // partial dot-product accumulator (reused)
    const touched = new Int32Array(n)        // list of j touched in this i iteration
    const candCut = threshold * IMPLICIT_CAND_RATIO
    const heapCap = Math.max(topN, IMPLICIT_HEAP_CAP)
    const hLink: ImplicitLink[] = []
    const hSim: number[] = []
    let candidateCount = 0

    for (let i = 0; i < n; i++) {
      const a = docs[i]
      if (a.bm25Norm === 0) continue
      let tCount = 0
      const ts = topTerms[i], ws = topWeights[i]
      for (let k = 0; k < ts.length; k++) {
        const pd = postDocs.get(ts[k])!
        // High-frequency (low-idf) terms add cost without contributing to candidate generation
        if (pd.length > IMPLICIT_MAX_POSTING) continue
        const pw = postWeights.get(ts[k])!
        const wi = ws[k]
        for (let p = 0; p < pd.length; p++) {
          const j = pd[p]
          if (j <= i) continue
          if (acc[j] === 0) touched[tCount++] = j
          acc[j] += wi * pw[p]
        }
      }

      for (let t = 0; t < tCount; t++) {
        const j = touched[t]
        const partial = acc[j]
        acc[j] = 0
        const b = docs[j]
        if (b.bm25Norm === 0) continue
        const normProd = a.bm25Norm * b.bm25Norm
        // partial is a lower bound of the true dot product (reflects only the top-term intersection)
        if (partial < candCut * normProd) continue
        if (existingLinks.has(i * n + j)) continue

        // Exact cosine — iterate the smaller vector to reduce Map lookups
        const small = a.bm25Vec.size <= b.bm25Vec.size ? a.bm25Vec : b.bm25Vec
        const large = small === a.bm25Vec ? b.bm25Vec : a.bm25Vec
        let dot = 0
        for (const [term, w] of small) {
          const o = large.get(term)
          if (o !== undefined) dot += w * o
        }
        candidateCount++
        const sim = dot / normProd
        if (sim < threshold) continue

        const link: ImplicitLink = {
          docAId: a.docId,
          docBId: b.docId,
          filenameA: a.filename,
          filenameB: b.filename,
          similarity: sim,
        }
        if (hSim.length < heapCap) {
          minHeapPush(hLink, hSim, link, sim)
        } else if (sim > hSim[0]) {
          minHeapPop(hLink, hSim)
          minHeapPush(hLink, hSim, link, sim)
        }
      }
    }

    const pairs = hLink.slice().sort((x, y) => y.similarity - x.similarity)
    this._implicitLinks = pairs
    this._implicitAdjRef = adjacency
    logger.debug(
      `[graphAnalysis] Implicit links top-${pairs.length} finalized ` +
      `(docs=${n}, candidates=${candidateCount}, threshold=${threshold})`
    )

    return pairs.slice(0, topN)
  }
}

// ── Implicit link search tuning constants ─────────────────────────────────────

/** Number of top-weighted terms per document used for candidate generation */
const IMPLICIT_TOP_TERMS = 64
/** Posting lists longer than this (= low-idf generic terms) are excluded from candidate generation */
const IMPLICIT_MAX_POSTING = 600
/** Exact computation is done when the partial dot product is at least this ratio of threshold */
const IMPLICIT_CAND_RATIO = 0.45
/** Result heap capacity — callers only use topN=4~6, so keep just some headroom */
const IMPLICIT_HEAP_CAP = 32

/** Parallel-array (payload[], key[]) min-heap push */
function minHeapPush<T>(items: T[], keys: number[], item: T, key: number): void {
  items.push(item)
  keys.push(key)
  let i = keys.length - 1
  while (i > 0) {
    const parent = (i - 1) >> 1
    if (keys[parent] <= keys[i]) break
    ;[keys[parent], keys[i]] = [keys[i], keys[parent]]
    ;[items[parent], items[i]] = [items[i], items[parent]]
    i = parent
  }
}

/** Parallel-array min-heap pop (removes the minimum) */
function minHeapPop<T>(items: T[], keys: number[]): void {
  const last = keys.length - 1
  keys[0] = keys[last]
  items[0] = items[last]
  keys.pop()
  items.pop()
  const size = keys.length
  let i = 0
  for (;;) {
    const l = 2 * i + 1, r = l + 1
    let m = i
    if (l < size && keys[l] < keys[m]) m = l
    if (r < size && keys[r] < keys[m]) m = r
    if (m === i) break
    ;[keys[m], keys[i]] = [keys[i], keys[m]]
    ;[items[m], items[i]] = [items[i], items[m]]
    i = m
  }
}

/** BM25 index singleton — build() must be called on vault load */
export const tfidfIndex = new TfIdfIndex()

// ── B. PageRank ───────────────────────────────────────────────────────────────

/**
 * Computes PageRank over the document graph.
 * Documents referenced by many others rank higher.
 *
 * @returns Map<docId, normalizedRank 0..1>
 */
export function computePageRank(
  adjacency: Map<string, string[]>,
  iterations: number = 25,
  damping: number = 0.85
): Map<string, number> {
  const nodes = [...adjacency.keys()]
  const N = nodes.length
  if (N === 0) return new Map()

  // Precompute reverse edges (in-edges) — for O(N+M) traversal
  const inEdges = new Map<string, string[]>()
  for (const id of nodes) inEdges.set(id, [])
  for (const [from, neighbors] of adjacency) {
    for (const to of neighbors) {
      if (!inEdges.has(to)) inEdges.set(to, [])
      inEdges.get(to)!.push(from)
    }
  }

  const rank = new Map<string, number>()
  for (const id of nodes) rank.set(id, 1 / N)

  for (let iter = 0; iter < iterations; iter++) {
    // Sum of ranks of nodes without outlinks (dangling nodes)
    const danglingSum = nodes
      .filter(id => (adjacency.get(id)?.length ?? 0) === 0)
      .reduce((sum, id) => sum + (rank.get(id) ?? 0), 0)

    const newRank = new Map<string, number>()
    for (const id of nodes) {
      const inSum = (inEdges.get(id) ?? []).reduce((sum, from) => {
        const outDegree = adjacency.get(from)?.length ?? 1
        return sum + (rank.get(from) ?? 0) / outDegree
      }, 0)
      newRank.set(id, (1 - damping) / N + damping * (inSum + danglingSum / N))
    }

    for (const [id, r] of newRank) rank.set(id, r)
  }

  // Normalize to 0..1
  const max = Math.max(1e-10, ...rank.values())
  for (const [id, r] of rank) rank.set(id, r / max)

  return rank
}

// ── C. Cluster detection (Union-Find) ────────────────────────────────────────

/**
 * Detects connected components (clusters) using Union-Find.
 * Documents connected through the same WikiLink network receive the same cluster number.
 *
 * @returns Map<docId, clusterId> — clusterId 0 is the largest cluster
 */
export function detectClusters(
  adjacency: Map<string, string[]>
): Map<string, number> {
  const parent = new Map<string, string>()

  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x)
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
    return parent.get(x)!
  }

  function union(a: string, b: string) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const [id, neighbors] of adjacency) {
    for (const nb of neighbors) union(id, nb)
  }

  // Group by root
  const groups = new Map<string, string[]>()
  for (const id of adjacency.keys()) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(id)
  }

  // Sort by cluster size descending (0 = largest cluster)
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length)
  const clusterMap = new Map<string, number>()
  sorted.forEach((members, idx) => {
    for (const id of members) clusterMap.set(id, idx)
  })

  return clusterMap
}

/**
 * Topic clusters = Louvain communities over the link graph (from the shared graph core).
 *
 * Connected components are useless as "topics" on a real vault: one hub page joins everything
 * into a single component, and a bridge between components is then impossible by definition —
 * which is why detectBridgeNodes used to return nothing. Louvain splits the giant component into
 * densely linked groups. Singletons keep their own id so every node has a cluster.
 *
 * @returns Map<docId, clusterId> — clusterId 0 is the largest community
 */
export function detectTopicClusters(adjacency: Map<string, string[]>): Map<string, number> {
  const sets = new Map<string, Set<string>>()
  for (const [id, nbs] of adjacency) {
    if (!sets.has(id)) sets.set(id, new Set())
    for (const nb of nbs) {
      sets.get(id)!.add(nb)
      if (!sets.has(nb)) sets.set(nb, new Set())
      sets.get(nb)!.add(id)
    }
  }
  return detectCommunities(sets).membership
}

// ── Graph metrics cache ──────────────────────────────────────────────────────

export interface GraphMetrics {
  pageRank: Map<string, number>
  clusters: Map<string, number>
  clusterCount: number
}

let _metricsCache: GraphMetrics | null = null
let _metricsLinksRef: unknown = null

/** Explicitly clears the cache when the vault is swapped. */
export function clearMetricsCache(): void {
  _metricsCache = null
  _metricsLinksRef = null
  _stemCache.clear()
  _stemPrimaryCache.clear()
}

/**
 * Computes PageRank + clusters once and caches them.
 * Recomputed automatically when the links array reference changes.
 */
export function getGraphMetrics(
  adjacency: Map<string, string[]>,
  linksRef: unknown
): GraphMetrics {
  if (_metricsCache && _metricsLinksRef === linksRef) return _metricsCache

  const pageRank = computePageRank(adjacency)
  const clusters = detectTopicClusters(adjacency)
  const clusterCount = new Set(clusters.values()).size

  _metricsCache = { pageRank, clusters, clusterCount }
  _metricsLinksRef = linksRef
  return _metricsCache
}

// ── D. Bridge node detection ─────────────────────────────────────────────────

export interface BridgeNode {
  docId: string
  /** Number of distinct clusters this node connects (including its own) */
  clusterCount: number
}

/**
 * Detects bridge nodes that have neighbors across multiple clusters.
 *
 * Bridge node = a node with at least one neighbor belonging to a different cluster than its own.
 * Such nodes are architecturally key documents connecting topic areas.
 *
 * @returns array sorted by clusterCount descending
 */
export function detectBridgeNodes(
  adjacency: Map<string, string[]>,
  clusters: Map<string, number>
): BridgeNode[] {
  const results: BridgeNode[] = []

  for (const [docId, neighbors] of adjacency) {
    const ownCluster = clusters.get(docId)
    if (ownCluster === undefined) continue

    const neighborClusters = new Set<number>([ownCluster])
    for (const nb of neighbors) {
      const nbCluster = clusters.get(nb)
      if (nbCluster !== undefined) neighborClusters.add(nbCluster)
    }

    if (neighborClusters.size >= 2) {
      results.push({ docId, clusterCount: neighborClusters.size })
    }
  }

  return results.sort((a, b) => b.clusterCount - a.clusterCount)
}

// ── E. Cluster topic keywords ────────────────────────────────────────────────

/** Generic Korean stopwords excluded from cluster topic extraction */
const KO_STOPWORDS = new Set([
  '게임', '회의', '문서', '내용', '진행', '확인', '관련', '작업', '기획', '개발',
  '결과', '현재', '이후', '정리', '사항', '대한', '통해', '위해', '가능', '필요',
  '부분', '경우', '정도', '추가', '변경', '적용', '처리', '검토', '완료', '예정',
])

/**
 * Extracts the top TF-IDF keywords for each cluster.
 *
 * Computes IDF (Inverse Document Frequency) over all vault documents and returns
 * cluster-specific keywords, rather than generic terms, using TF × IDF scores within the cluster.
 * Used in the structure header in the form "Cluster 1 [combat/skills/balance]".
 *
 * @param clusters  Map<docId, clusterId>
 * @param docs      vault document array
 * @param topK      number of keywords to return per cluster
 * @returns Map<clusterId, topKeywords[]>
 */
// Cluster topic cache — skips recomputation when the clusters Map reference and topK are the same
let _cachedClusterTopicsResult: Map<number, string[]> | null = null
let _cachedClusterTopicsClusters: Map<string, number> | null = null
let _cachedClusterTopicsTopK = 0

export function getClusterTopics(
  clusters: Map<string, number>,
  docs: LoadedDocument[],
  topK: number = 3
): Map<number, string[]> {
  if (
    _cachedClusterTopicsResult !== null &&
    _cachedClusterTopicsClusters === clusters &&
    _cachedClusterTopicsTopK === topK
  ) {
    return _cachedClusterTopicsResult
  }

  // ── 1. Compute vault-wide IDF: number of documents each token appears in (DF) ──
  const globalDF = new Map<string, number>()
  const totalDocs = docs.length

  for (const doc of docs) {
    const text = [
      doc.filename.replace(/\.md$/i, ''),
      ...(doc.tags ?? []),
      ...doc.sections.map(s => `${s.heading} ${s.body}`),
    ].join(' ')
    const seen = new Set<string>()
    for (const token of tokenize(text)) {
      if (token.length >= 2 && !seen.has(token)) {
        seen.add(token)
        globalDF.set(token, (globalDF.get(token) ?? 0) + 1)
      }
    }
  }

  // ── 2. Collect text per cluster ──
  const clusterTexts = new Map<number, string[]>()

  for (const doc of docs) {
    const cId = clusters.get(doc.id)
    if (cId === undefined) continue
    if (!clusterTexts.has(cId)) clusterTexts.set(cId, [])

    const text = [
      doc.filename.replace(/\.md$/i, ''),
      ...(doc.tags ?? []),
      ...doc.sections.map(s => `${s.heading} ${s.body}`),
    ].join(' ')
    clusterTexts.get(cId)!.push(text)
  }

  // ── 3. Extract keywords per cluster by TF × IDF score ──
  const result = new Map<number, string[]>()
  for (const [cId, texts] of clusterTexts) {
    const freq = new Map<string, number>()
    for (const text of texts) {
      for (const token of tokenize(text)) {
        freq.set(token, (freq.get(token) ?? 0) + 1)
      }
    }
    const keywords = [...freq.entries()]
      .filter(([t]) => t.length >= 2 && !KO_STOPWORDS.has(t))
      .map(([t, tf]) => {
        const df = globalDF.get(t) ?? 1
        const idf = Math.log((totalDocs + 1) / (df + 1))
        return [t, tf * idf] as [string, number]
      })
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([t]) => t)
    result.set(cId, keywords)
  }

  _cachedClusterTopicsResult = result
  _cachedClusterTopicsClusters = clusters
  _cachedClusterTopicsTopK = topK
  return result
}

// ── F. Vault insight analysis ────────────────────────────────────────────────

export interface InsightResult {
  /** Hub documents referenced by many other documents */
  bridgeNodes: { docId: string; filename: string; inboundCount: number; outboundCount: number }[]
  /** Orphan documents with neither inbound nor outbound links */
  orphanDocs: { docId: string; filename: string }[]
  /** Topics referenced by several documents but with no actual file (needs writing) */
  gapTopics: { topic: string; referenceCount: number }[]
  /** Connected-component cluster summary */
  clusters: { size: number; representative: string; clusterIdx: number }[]
}

/**
 * Analyzes the whole vault and generates insights.
 * - Bridge nodes: heavily referenced hub documents
 * - Orphan documents: documents with no links at all
 * - Gap topics: [[links]] referenced from several places but with no file
 * - Clusters: connected-component summary
 */
export function computeInsights(docs: LoadedDocument[]): InsightResult {
  if (docs.length === 0) return { bridgeNodes: [], orphanDocs: [], gapTopics: [], clusters: [] }

  const docIds = new Set(docs.map(d => d.id))
  // stem → docId mapping (filename-based reverse lookup)
  const stemToId = new Map<string, string>()
  for (const doc of docs) {
    const stem = doc.filename.replace(/\.md$/i, '').toLowerCase()
    stemToId.set(stem, doc.id)
    stemToId.set(doc.id, doc.id)
  }

  const outbound = new Map<string, Set<string>>()
  const inbound  = new Map<string, number>()
  const phantom  = new Map<string, number>()

  for (const doc of docs) {
    outbound.set(doc.id, new Set())
    inbound.set(doc.id, 0)
  }

  for (const doc of docs) {
    const links = doc.sections.flatMap(s => s.wikiLinks ?? [])
    for (const raw of links) {
      const stem = raw.split('|')[0].trim().toLowerCase()
      const targetId = stemToId.get(stem)
      if (targetId && targetId !== doc.id && docIds.has(targetId)) {
        outbound.get(doc.id)!.add(targetId)
        inbound.set(targetId, (inbound.get(targetId) ?? 0) + 1)
      } else if (!targetId) {
        phantom.set(raw, (phantom.get(raw) ?? 0) + 1)
      }
    }
  }

  // Bridge nodes (high inbound)
  const bridgeNodes = docs
    .map(d => ({
      docId: d.id,
      filename: d.filename,
      inboundCount: inbound.get(d.id) ?? 0,
      outboundCount: outbound.get(d.id)?.size ?? 0,
    }))
    .filter(n => n.inboundCount >= 3)
    .sort((a, b) => b.inboundCount - a.inboundCount)
    .slice(0, 12)

  // Orphan docs (0 in + 0 out, not _index)
  const orphanDocs = docs
    .filter(d =>
      (inbound.get(d.id) ?? 0) === 0 &&
      (outbound.get(d.id)?.size ?? 0) === 0 &&
      !/_index|currentSituation/i.test(d.filename)
    )
    .map(d => ({ docId: d.id, filename: d.filename }))
    .slice(0, 20)

  // Gap topics (phantom links referenced ≥2 times)
  const gapTopics = [...phantom.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([topic, referenceCount]) => ({ topic, referenceCount }))

  // Clusters: BFS over bidirectional edges
  const edges = new Map<string, Set<string>>()
  for (const doc of docs) edges.set(doc.id, new Set())
  for (const [from, targets] of outbound) {
    for (const to of targets) {
      edges.get(from)!.add(to)
      if (edges.has(to)) edges.get(to)!.add(from)
    }
  }

  const visited = new Set<string>()
  const clusterList: { size: number; representative: string; clusterIdx: number }[] = []
  let clusterIdx = 0

  for (const doc of docs) {
    if (visited.has(doc.id)) continue
    const component: string[] = []
    const queue = [doc.id]
    let qi = 0
    while (qi < queue.length) {
      const cur = queue[qi++]
      if (visited.has(cur)) continue
      visited.add(cur)
      component.push(cur)
      for (const nb of (edges.get(cur) ?? [])) {
        if (!visited.has(nb)) queue.push(nb)
      }
    }
    if (component.length >= 2) {
      clusterList.push({
        size: component.length,
        representative: docs.find(d => d.id === component[0])?.filename ?? component[0],
        clusterIdx: clusterIdx++,
      })
    }
  }

  clusterList.sort((a, b) => b.size - a.size)

  return { bridgeNodes, orphanDocs, gapTopics, clusters: clusterList.slice(0, 5) }
}

// ── G. Co-occurrence-based synonym extraction ────────────────────────────────

/** Generic stopwords (particles, conjunctions, articles, etc.) — excluded from synonym candidates */
const CO_STOPWORDS = new Set([
  '그리고', '그러나', '하지만', '그래서', '또는', '혹은', '및', '등',
  '있다', '없다', '하다', '되다', '이다', '것이', '수가', '때문',
  '위해', '대해', '통해', '관련', '경우', '이후', '이전', '사이',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was',
  'not', 'but', 'have', 'has', 'had', 'will', 'can', 'all', 'been',
])

/**
 * Extracts synonym candidates from vault documents via section-level co-occurrence analysis.
 *
 * Algorithm:
 *  1. Tokenize each section and extract its set of unique terms
 *  2. Count co-occurrence frequency for every term pair appearing in the same section
 *  3. Compute PMI (Pointwise Mutual Information) to remove coincidental co-occurrences
 *  4. Return only pairs with co-occurrence count >= 3 && PMI >= threshold
 *
 * @param docs vault document array
 * @param minCoOccurrence minimum co-occurrence count (default 3)
 * @param pmiThreshold minimum PMI threshold (default 2.0)
 * @returns Map<term, synonym[]> — bidirectional synonym pairs
 */
export function extractCoOccurrenceSynonyms(
  docs: LoadedDocument[],
  minCoOccurrence: number = 3,
  pmiThreshold: number = 2.0,
): Map<string, string[]> {
  const sectionTexts: string[] = []
  for (const doc of docs) {
    for (const section of doc.sections) sectionTexts.push(`${section.heading} ${section.body}`)
  }
  return extractCoOccurrenceSynonymsFromSections(sectionTexts, minCoOccurrence, pmiThreshold)
}

/** Max terms per section used for pair generation (selected by lowest df = most discriminative) */
const CO_MAX_TERMS_PER_SECTION = 60
/** Safe upper bound for the co-occurrence Map (JS Map limit is 2^24) */
const CO_MAX_PAIRS = 8_000_000
/** Max synonyms to register per term — prevents expandTerms explosion */
const CO_MAX_SYNONYMS = 3

/**
 * Minimum containment — count / min(dfA, dfB).
 *
 * PMI has a strong low-frequency bias: two terms with df=10 co-occurring only 3 times get
 * PMI≈9 and pass. The result is not a "synonym" but a mere topical associate, and adding it
 * to query expansion degrades search quality (measured: with unlimited registration, the #1 result
 * for "사운드 밸런스" changed to an unrelated document). Only accept a synonym candidate when the
 * pair co-occurs in at least half of the sections where the rarer term appears.
 */
const CO_MIN_CONTAINMENT = 0.5

/**
 * Extracts co-occurrence synonyms from an array of section texts.
 * (Separate entry point so the worker can receive only section strings instead of whole documents)
 *
 * The previous implementation aggregated **all pairs** of up to 80 terms per section into a
 * string-keyed Map, and after C(80,2)=3,160 × section count ≈ 25M operations died with
 * `RangeError: Map maximum size exceeded` (0 results, full cost paid). Improvements:
 *  - Terms with df < minCoOccurrence are removed **before pair generation**. Terms appearing in
 *    fewer than 3 sections can by definition never pass the threshold, yet make up most of the pairs.
 *  - Terms are mapped to integer ids and a numeric key `idA * V + idB` is used (no string concat).
 *  - 2-gram subtokens are excluded (the main source of meaningless pairs).
 *  - When the Map size cap is reached, only new keys are blocked and a warning is logged (no fatal exception).
 */
export function extractCoOccurrenceSynonymsFromSections(
  sectionTexts: string[],
  minCoOccurrence: number = 3,
  pmiThreshold: number = 2.0,
): Map<string, string[]> {
  // ── 1. Collect unique terms per section into a flat buffer + count df (number of sections) ──
  const flat: string[] = []
  const offsets: number[] = [0]
  const df = new Map<string, number>()

  for (const text of sectionTexts) {
    const seen = new Set<string>()
    for (const t of tokenize(text)) {
      if (t.length <= 1 || CO_STOPWORDS.has(t)) continue
      seen.add(t)
    }
    if (seen.size < 2) continue
    for (const t of seen) {
      flat.push(t)
      df.set(t, (df.get(t) ?? 0) + 1)
    }
    offsets.push(flat.length)
  }

  const totalSections = offsets.length - 1
  if (totalSections < 3) return new Map()

  // ── 2. df filter + integer id mapping ─────────────────────────────────
  const termId = new Map<string, number>()
  const idTerm: string[] = []
  for (const [t, d] of df) {
    if (d < minCoOccurrence) continue
    termId.set(t, idTerm.length)
    idTerm.push(t)
  }
  const V = idTerm.length
  if (V < 2) return new Map()
  const dfById = new Int32Array(V)
  for (let i = 0; i < V; i++) dfById[i] = df.get(idTerm[i])!

  // ── 3. Count co-occurrence frequency (numeric keys) ───────────────────
  const coOccurrence = new Map<number, number>()
  const buf: number[] = []
  let truncated = false

  for (let s = 0; s < totalSections; s++) {
    buf.length = 0
    const end = offsets[s + 1]
    for (let k = offsets[s]; k < end; k++) {
      const id = termId.get(flat[k])
      if (id !== undefined) buf.push(id)
    }
    if (buf.length < 2) continue
    let ids = buf
    if (ids.length > CO_MAX_TERMS_PER_SECTION) {
      // df ascending = most discriminative terms first
      ids = buf.slice().sort((a, b) => dfById[a] - dfById[b]).slice(0, CO_MAX_TERMS_PER_SECTION)
    }
    ids.sort((a, b) => a - b)
    const len = ids.length
    for (let i = 0; i < len; i++) {
      const base = ids[i] * V
      for (let j = i + 1; j < len; j++) {
        const key = base + ids[j]
        const prev = coOccurrence.get(key)
        if (prev === undefined) {
          if (coOccurrence.size >= CO_MAX_PAIRS) { truncated = true; continue }
          coOccurrence.set(key, 1)
        } else {
          coOccurrence.set(key, prev + 1)
        }
      }
    }
  }
  if (truncated) {
    logger.warn(`[coOccurrence] Pair cap ${CO_MAX_PAIRS} reached — some pairs will be dropped (sections=${totalSections}, vocab=${V})`)
  }

  // ── 4. PMI filter + register only top N per term ──────────────────────
  const cand = new Map<number, { id: number; pmi: number }[]>()
  const addCand = (a: number, b: number, pmi: number) => {
    let list = cand.get(a)
    if (list === undefined) { list = []; cand.set(a, list) }
    list.push({ id: b, pmi })
  }

  for (const [key, count] of coOccurrence) {
    if (count < minCoOccurrence) continue
    const a = Math.floor(key / V)
    const b = key - a * V
    const dfA = dfById[a], dfB = dfById[b]
    // Containment filter — removes mere topical associates let in by PMI's low-frequency bias
    if (count < CO_MIN_CONTAINMENT * (dfA < dfB ? dfA : dfB)) continue
    // PMI = log2( P(a,b) / (P(a) * P(b)) )
    const pmi = Math.log2((count * totalSections) / (dfA * dfB))
    if (pmi < pmiThreshold) continue
    addCand(a, b, pmi)
    addCand(b, a, pmi)
  }

  const result = new Map<string, string[]>()
  for (const [id, list] of cand) {
    if (list.length > CO_MAX_SYNONYMS) list.sort((x, y) => y.pmi - x.pmi)
    result.set(idTerm[id], list.slice(0, CO_MAX_SYNONYMS).map(e => idTerm[e.id]))
  }

  logger.debug(
    `[coOccurrence] Dynamic synonym extraction complete for ${result.size} terms ` +
    `(sections=${totalSections}, vocab=${V}, pairs=${coOccurrence.size})`
  )
  return result
}
