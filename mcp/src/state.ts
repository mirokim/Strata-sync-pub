/**
 * In-memory state for MCP server — loaded documents, graph, BM25 index.
 */
import type { LoadedDocument } from './parser.js'
import { loadVaultDocuments } from './vault.js'
import { getConfig, getApiKey, getConfigPath } from './config.js'
import { expandTerms, SYNONYM_MAP } from './synonyms.js'
import { normalizeWikiLink } from './lint/graph.js'
import { detectCommunities } from './lint/community.js'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { resolve, dirname } from 'path'

// ── State ────────────────────────────────────────────────────────────────────

let _documents: LoadedDocument[] = []
let _graphBuilt = false

export interface GraphNode {
  id: string
  docId: string
  speaker: string
  label: string
  folderPath?: string
  tags?: string[]
}

export interface GraphLink {
  source: string
  target: string
  strength?: number
}

let _nodes: GraphNode[] = []
let _links: GraphLink[] = []

// ── BM25 lightweight index ───────────────────────────────────────────────────

const KO_SUFFIXES = [
  '이라는', '이라고', '에서는', '에게서', '한테서', '으로서', '으로써', '으로는',
  '에서의', '으로의', '에서도', '으로도',
  '이라', '에서', '에게', '한테', '까지', '부터', '처럼', '같은', '같이',
  '만큼', '으로', '이랑', '라는', '라고', '이란', '에는', '하고',
  '님의', '님이', '님을', '님은', '님께', '님도', '님과',
  '은', '는', '이', '가', '을', '를', '와', '과', '에', '도', '만', '의', '로', '님',
]

// BUG5 fix: stem cache — avoid re-stemming the same token
const _stemCache = new Map<string, string[]>()

/** Count Hangul syllables (U+AC00–U+D7A3) */
function koCharCount(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xAC00 && c <= 0xD7A3) n++
  }
  return n
}

// BUG6 fix: decompose Hangul tokens of 3+ syllables into 2-gram sub-tokens
function decomposeKo2gram(stem: string): string[] {
  const syllables: string[] = []
  for (let i = 0; i < stem.length; i++) {
    const c = stem.charCodeAt(i)
    if (c >= 0xAC00 && c <= 0xD7A3) syllables.push(stem[i])
  }
  if (syllables.length < 3) return []
  const subs: string[] = []
  for (let i = 0; i <= syllables.length - 2; i++) {
    subs.push(syllables[i] + syllables[i + 1])
  }
  return subs
}

function stemKorean(token: string): string[] {
  const cached = _stemCache.get(token)
  if (cached) return cached
  const results = [token]
  let stem = token
  for (const suffix of KO_SUFFIXES) {
    if (token.endsWith(suffix) && token.length > suffix.length + 1) {
      stem = token.slice(0, -suffix.length)
      results.push(stem)
      break
    }
  }
  // BUG6 fix: add 2-gram sub-tokens for 3+ syllables
  if (koCharCount(stem) >= 3) {
    for (const sub of decomposeKo2gram(stem)) results.push(sub)
  }
  const out = [...new Set(results)]
  _stemCache.set(token, out)
  return out
}

export function tokenize(text: string): string[] {
  // Split number + Korean unit (e.g. "2026년" → "2026 년")
  const normalized = text.replace(/(\d+)(년|월|일|주|시간|시|분|초|개|명|번|회|차)/g, '$1 $2')
  const raw = normalized.toLowerCase().split(/[\s,.\-_?!;:()[\]{}'"《》「」【】]+/).filter(t => t.length > 1 || t in SYNONYM_MAP)
  const stems: string[] = []
  for (const token of raw) for (const stem of stemKorean(token)) stems.push(stem)

  // Date padding: "1월" → restore single-digit number + month/day dropped from tokens as a 0-padded token
  const dateUnitRe = /(\d{1,2})\s*(월|일)/g
  let m: RegExpExecArray | null
  while ((m = dateUnitRe.exec(normalized)) !== null) {
    const num = m[1]
    if (num.length === 1) stems.push(num.padStart(2, '0'))
  }
  return stems
}

// ── Filename date parsing (same as frontend graphAnalysis.ts) ─────────────

function parseFilenameDate(filename: string): number {
  const now = Date.now() + 30 * 86_400_000
  const B = '(?:^|[^\\d])'
  const A = '(?:[^\\d]|$)'

  let mt = filename.match(new RegExp(`${B}(20[0-3]\\d)[_\\-](0[1-9]|1[0-2])[_\\-](0[1-9]|[12]\\d|3[01])${A}`))
  if (mt) { const ms = Date.parse(`${mt[1]}-${mt[2]}-${mt[3]}`); if (!isNaN(ms) && ms <= now) return ms }

  mt = filename.match(new RegExp(`${B}(20[0-3]\\d)(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])${A}`))
  if (mt) { const ms = Date.parse(`${mt[1]}-${mt[2]}-${mt[3]}`); if (!isNaN(ms) && ms <= now) return ms }

  mt = filename.match(new RegExp(`${B}(\\d{2})[_\\-](0[1-9]|1[0-2])[_\\-](0[1-9]|[12]\\d|3[01])${A}`))
  if (mt) {
    const yy = parseInt(mt[1], 10)
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy
    const ms = Date.parse(`${yyyy}-${mt[2]}-${mt[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  mt = filename.match(new RegExp(`${B}(\\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])${A}`))
  if (mt) {
    const yy = parseInt(mt[1], 10)
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy
    const ms = Date.parse(`${yyyy}-${mt[2]}-${mt[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }
  return 0
}

function getContentDate(doc: LoadedDocument): number {
  const fromFilename = parseFilenameDate(doc.filename)
  if (fromFilename > 0) return fromFilename
  if (doc.date) {
    const ms = Date.parse(doc.date)
    if (!isNaN(ms)) return ms
  }
  return 0
}

interface BM25Doc {
  docId: string
  filename: string
  speaker: string
  termFreqs: Map<string, number>
  docLen: number
  filenameTokens: Set<string>  // BUG3 fix: precomputed
  contentDate: number           // BUG2 fix: for recency boost
}

const BM25_K1 = 1.5
const BM25_B = 0.55
/**
 * Filename boost — multiplier applied to the term's idf*tf component.
 * Because it is not an additive constant, low-idf (= non-discriminative) sub-tokens receive a small boost too.
 */
const FILENAME_BOOST = 1.5
let _bm25Docs: BM25Doc[] = []
let _idf: Map<string, number> = new Map()
let _avgdl = 0

function buildBM25() {
  _bm25Docs = []
  _idf = new Map()
  _stemCache.clear()
  const docFreq = new Map<string, number>()
  const allDocLens: number[] = []

  for (const doc of _documents) {
    // BUG1 fix: exclude graphWeight: skip documents from the BM25 index
    if (doc.graphWeight === 'skip') continue

    const text = [doc.filename.replace(/\.md$/i, ''), doc.tags?.join(' ') ?? '', doc.speaker ?? '',
      ...doc.sections.map(s => `${s.heading} ${s.body}`), doc.rawContent ?? ''].join(' ')
    const tokens = tokenize(text)
    const termFreq = new Map<string, number>()
    for (const t of tokens) termFreq.set(t, (termFreq.get(t) ?? 0) + 1)
    _bm25Docs.push({
      docId: doc.id, filename: doc.filename, speaker: doc.speaker,
      termFreqs: termFreq, docLen: tokens.length,
      filenameTokens: new Set(tokenize(doc.filename)),  // BUG3 fix
      contentDate: getContentDate(doc),                   // BUG2 fix
    })
    allDocLens.push(tokens.length)
    for (const term of termFreq.keys()) docFreq.set(term, (docFreq.get(term) ?? 0) + 1)
  }

  const N = _bm25Docs.length
  _avgdl = N > 0 ? allDocLens.reduce((a, b) => a + b, 0) / N : 1
  for (const [term, df] of docFreq) {
    _idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1))
  }
}

export interface SearchResult {
  docId: string
  filename: string
  speaker: string
  score: number
}

export function bm25Search(query: string, topK = 10): SearchResult[] {
  const queryTokens = expandTerms(tokenize(query))
  if (queryTokens.length === 0) return []

  const queryTermSet = new Set(queryTokens)
  const queryTermCount = queryTermSet.size
  const now = Date.now()
  const scores: { docId: string; filename: string; speaker: string; score: number }[] = []

  for (const doc of _bm25Docs) {
    let rawScore = 0
    let matchedTerms = 0
    const lenNorm = 1 - BM25_B + BM25_B * (doc.docLen / _avgdl)
    for (const qt of queryTermSet) {
      const tf = doc.termFreqs.get(qt) ?? 0
      if (tf === 0) continue
      const idfVal = _idf.get(qt) ?? 0
      // Same as the app (graphAnalysis.ts): terms with idf<=0 do not count as matches.
      // Previously matchedTerms++ ran without continue, inflating coverage.
      if (idfVal <= 0) continue
      const termScore = idfVal * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lenNorm)
      // Filename boost is a multiplier — when it was an additive constant (2.0), a near-zero-idf
      // 2-gram noise sub-token merely matching the filename received a near-maximum bonus.
      rawScore += doc.filenameTokens.has(qt) ? termScore * FILENAME_BOOST : termScore
      matchedTerms++
    }
    if (rawScore <= 0) continue

    // BUG2 fix: query term coverage correction
    const coverage = queryTermCount > 1 ? matchedTerms / queryTermCount : 1
    let score = rawScore * Math.pow(coverage, 0.5)

    // BUG2 fix: recency boost — score *= 1 + 0.1 * exp(-daysOld / 180)
    if (doc.contentDate > 0) {
      const daysOld = (now - doc.contentDate) / 86_400_000
      score *= 1 + 0.1 * Math.exp(-daysOld / 180)
    }

    scores.push({ docId: doc.docId, filename: doc.filename, speaker: doc.speaker, score })
  }

  return scores.sort((a, b) => b.score - a.score).slice(0, topK)
}

// ── Vector embedding index ───────────────────────────────────────────────────
//
// Uses the same provider selection rules as the app (src/lib/vectorEmbedIndex.ts):
//   1) If the local BGE-M3 server (http://127.0.0.1:8077, 1024 dims) is running, use it.
//   2) Otherwise fall back to Gemini gemini-embedding-001 (3072 dims).
// The two providers have different vector spaces and dimensions, so the cache records provider/dim
// and is invalidated on mismatch. (Without the record, cosineSim yields NaN and sort becomes random.)

export type EmbedProvider = 'local' | 'gemini'

const LOCAL_EMBED_URL = process.env.STRATA_SYNC_EMBED_URL ?? 'http://127.0.0.1:8077'
const LOCAL_PROBE_TIMEOUT_MS = 1500
/** Local server MAXLEN 4096 tokens × ~1.2 chars per Korean token ≈ 4,900 chars → 4,500 chars to be safe */
const EMBED_TEXT_MAX_CHARS = 4500
const LOCAL_EMBED_BATCH = 20
const GEMINI_CONCURRENCY = 5

/** null = not probed yet */
let _localEmbedAvailable: boolean | null = null

/** Check local embedding server availability (once per process) */
async function probeLocalEmbed(): Promise<boolean> {
  if (_localEmbedAvailable !== null) return _localEmbedAvailable
  try {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), LOCAL_PROBE_TIMEOUT_MS)
    const res = await fetch(`${LOCAL_EMBED_URL}/health`, { signal: ctl.signal })
    clearTimeout(timer)
    _localEmbedAvailable = res.ok
    if (res.ok) {
      const info = await res.json().catch(() => ({})) as { model?: string; dim?: number }
      console.error(`[vector] Using local embedding server: ${info.model ?? '?'} (${info.dim ?? '?'} dims)`)
    }
  } catch {
    _localEmbedAvailable = false
  }
  return _localEmbedAvailable
}

/** Reset probe result — to re-check when the server is started later */
export function resetLocalEmbedProbe(): void { _localEmbedAvailable = null }

/**
 * Whether embeddings can be produced — true if the local server is running or a Gemini key exists.
 * Gates must use this function, not the presence of a Gemini key.
 */
export async function isEmbeddingReady(apiKey?: string): Promise<boolean> {
  if (await probeLocalEmbed()) return true
  return Boolean(apiKey?.trim())
}

/** Currently active embedding provider — used to decide cache invalidation. */
export function activeEmbedProvider(): EmbedProvider {
  return _localEmbedAvailable === true ? 'local' : 'gemini'
}

async function embedLocalBatch(texts: string[], type: 'query' | 'document'): Promise<number[][]> {
  const res = await fetch(`${LOCAL_EMBED_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, type }),
  })
  if (!res.ok) throw new Error(`Local embedding server ${res.status}: ${res.statusText}`)
  const json = await res.json() as { embeddings: number[][] }
  return json.embeddings
}

async function embedGeminiSingle(text: string, apiKey: string, type: 'query' | 'document', retries = 2): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        model: 'models/gemini-embedding-001',
        content: { parts: [{ text }] },
        taskType: type === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
      }),
    })
    if (res.status === 429 && attempt < retries) {
      await new Promise(r => setTimeout(r, Math.min(1000 * Math.pow(2, attempt), 8000)))
      continue
    }
    if (!res.ok) throw new Error(`Gemini embeddings ${res.status}: ${await res.text().catch(() => res.statusText)}`)
    const json = await res.json() as { embedding: { values: number[] } }
    return json.embedding.values
  }
  throw new Error('embedGeminiSingle: retries exhausted')
}

/**
 * Embed an array of texts. Uses the local server if running, otherwise Gemini.
 * In local mode there is no fallback to Gemini — mixing dimensions would invalidate the cache.
 */
async function embedBatch(texts: string[], apiKey: string, type: 'query' | 'document'): Promise<number[][]> {
  if (await probeLocalEmbed()) return embedLocalBatch(texts, type)
  if (!apiKey) throw new Error(`No embedding provider — start the local server (${LOCAL_EMBED_URL}) or set apiKeys.gemini`)
  const out: number[][] = new Array(texts.length)
  for (let i = 0; i < texts.length; i += GEMINI_CONCURRENCY) {
    const chunk = texts.slice(i, i + GEMINI_CONCURRENCY)
    const vecs = await Promise.all(chunk.map(t => embedGeminiSingle(t, apiKey, type)))
    for (let j = 0; j < chunk.length; j++) out[i + j] = vecs[j]
  }
  return out
}

// ── Vector cache (records provider/dim) ───────────────────────────────────────

interface VectorDoc {
  docId: string
  filename: string
  speaker: string
  embedding: number[]
  fingerprint: string
}

/** Same shape as the app's vectorEmbedCache.ts — treated as legacy and discarded if provider/dim is missing. */
interface VectorCacheFile {
  version: number
  provider?: EmbedProvider
  dim?: number
  entries: VectorDoc[]
}

const VECTOR_CACHE_VERSION = 2
/** The vector path is not enabled if embedding coverage over documents is below this value. */
const VECTOR_COVERAGE_MIN = 0.8

let _vectorDocs: Map<string, VectorDoc> = new Map()
let _vectorProvider: EmbedProvider | null = null
let _vectorDim = 0

function getVectorCachePath(): string {
  return resolve(dirname(getConfigPath()), 'vector_cache.json')
}

function fingerprint(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

function clearVectorIndex(): void {
  _vectorDocs = new Map()
  _vectorProvider = null
  _vectorDim = 0
}

function loadVectorCache(): void {
  clearVectorIndex()
  const cachePath = getVectorCachePath()
  if (!existsSync(cachePath)) return
  try {
    const raw = JSON.parse(readFileSync(cachePath, 'utf-8')) as VectorCacheFile | VectorDoc[]
    if (Array.isArray(raw)) {
      // v1 (array) cache — no provider/dim record, so dimensions cannot be verified. Discard.
      console.error('[vector] Legacy cache (no provider/dim record) — invalidating and rebuilding')
      return
    }
    if (raw.version !== VECTOR_CACHE_VERSION || !raw.provider || !raw.dim || !Array.isArray(raw.entries)) {
      console.error('[vector] Cache version/metadata mismatch — invalidating and rebuilding')
      return
    }
    const entries = raw.entries.filter(e => Array.isArray(e.embedding) && e.embedding.length === raw.dim)
    if (entries.length !== raw.entries.length) {
      console.error(`[vector] Excluded ${raw.entries.length - entries.length} entries with mismatched dimensions (dim=${raw.dim})`)
    }
    _vectorDocs = new Map(entries.map(e => [e.docId, e]))
    _vectorProvider = raw.provider
    _vectorDim = raw.dim
  } catch (e) {
    console.error('[vector] Cache load failed:', e)
    clearVectorIndex()
  }
}

function saveVectorCache(): void {
  if (!_vectorProvider || _vectorDim <= 0) return
  const record: VectorCacheFile = {
    version: VECTOR_CACHE_VERSION,
    provider: _vectorProvider,
    dim: _vectorDim,
    entries: [..._vectorDocs.values()],
  }
  try { writeFileSync(getVectorCachePath(), JSON.stringify(record), 'utf-8') }
  catch (e) { console.error('[vector] Cache save failed:', e) }
}

/** Invalidate the whole cache if the active provider differs from the cached provider. */
async function ensureVectorCacheProvider(): Promise<EmbedProvider> {
  await probeLocalEmbed()
  const provider = activeEmbedProvider()
  if (_vectorDocs.size > 0 && _vectorProvider !== provider) {
    console.error(`[vector] Embedding provider changed (${_vectorProvider ?? 'unrecorded'} → ${provider}) — full rebuild`)
    clearVectorIndex()
  }
  return provider
}

function cosineSim(a: number[], b: number[]): number {
  // Dimension mismatch guard — a provider switch (local 1024 ↔ Gemini 3072) silently yields NaN.
  if (a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

function docFullText(doc: LoadedDocument): string {
  return [doc.filename.replace(/\.md$/i, ''), doc.tags?.join(' ') ?? '', doc.speaker ?? '',
    ...doc.sections.map(s => `${s.heading} ${s.body}`), doc.rawContent ?? ''].join(' ').slice(0, EMBED_TEXT_MAX_CHARS)
}

/** Documents to embed — excludes graph_weight: skip, same as BM25. */
function embeddableDocs(): LoadedDocument[] {
  return _documents.filter(d => d.graphWeight !== 'skip')
}

/**
 * Whether the vector index is usable for search.
 * Checking only size === 0 would let a partial build with 5 of 500 docs embedded pass,
 * so every query returns the same 5 documents — judge by coverage ratio instead.
 */
function isVectorIndexUsable(): boolean {
  const total = embeddableDocs().length
  if (total === 0 || _vectorDocs.size === 0 || _vectorDim <= 0) return false
  return _vectorDocs.size / total >= VECTOR_COVERAGE_MIN
}

export interface VectorBuildResult {
  embedded: number
  skipped: number
  failed: number
  provider: EmbedProvider
  dim: number
  indexed: number
  total: number
  coverage: number
  usable: boolean
  error?: string
}

/** Build or incrementally update vector embedding index. */
export async function buildVectorIndex(): Promise<VectorBuildResult> {
  const apiKey = getApiKey('gemini')
  const base = { embedded: 0, skipped: 0, failed: 0, dim: 0, indexed: 0, total: embeddableDocs().length, coverage: 0, usable: false }
  if (!(await isEmbeddingReady(apiKey))) {
    return {
      ...base, provider: activeEmbedProvider(),
      error: `No embedding provider — start the local embedding server (${LOCAL_EMBED_URL}) or set apiKeys.gemini in mcp-config.json`,
    }
  }

  loadVectorCache()
  const provider = await ensureVectorCacheProvider()

  const docs = embeddableDocs()
  const stale: { doc: LoadedDocument; text: string; fp: string }[] = []
  let skipped = 0
  for (const doc of docs) {
    const text = docFullText(doc)
    const fp = fingerprint(text)
    if (_vectorDocs.get(doc.id)?.fingerprint === fp) { skipped++; continue }
    stale.push({ doc, text, fp })
  }

  // Clean up entries for deleted documents
  const liveIds = new Set(docs.map(d => d.id))
  for (const id of [..._vectorDocs.keys()]) if (!liveIds.has(id)) _vectorDocs.delete(id)

  let embedded = 0, failed = 0
  let firstError: string | undefined
  const batchSize = provider === 'local' ? LOCAL_EMBED_BATCH : GEMINI_CONCURRENCY

  for (let i = 0; i < stale.length; i += batchSize) {
    const batch = stale.slice(i, i + batchSize)
    try {
      const vecs = await embedBatch(batch.map(b => b.text), apiKey, 'document')
      for (let j = 0; j < batch.length; j++) {
        const vec = vecs[j]
        if (!Array.isArray(vec) || vec.length === 0) { failed++; continue }
        if (_vectorDim === 0) _vectorDim = vec.length
        if (vec.length !== _vectorDim) { failed++; continue }
        const { doc, fp } = batch[j]
        _vectorDocs.set(doc.id, { docId: doc.id, filename: doc.filename, speaker: doc.speaker, embedding: vec, fingerprint: fp })
        embedded++
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      failed += batch.length
      if (!firstError) firstError = msg
      console.error(`[vector] Batch embedding failed (${i}~${i + batch.length}):`, msg)
      // Failure on the very first batch most likely means a configuration problem — abort
      if (i === 0) { failed = stale.length; break }
    }
    if (provider !== 'local' && i + batchSize < stale.length) await new Promise(r => setTimeout(r, 100))
  }

  _vectorProvider = provider
  if (embedded > 0) saveVectorCache()

  const total = docs.length
  const coverage = total > 0 ? _vectorDocs.size / total : 0
  return {
    embedded, skipped, failed, provider, dim: _vectorDim,
    indexed: _vectorDocs.size, total, coverage: Math.round(coverage * 1000) / 1000,
    usable: isVectorIndexUsable(),
    error: failed > 0 ? `${failed} failed${firstError ? `: ${firstError}` : ''}` : undefined,
  }
}

/**
 * Vector-only search — scans the whole index independently of BM25 candidates.
 * Returns null if there is no index or query embedding fails (caller falls back to BM25).
 */
async function vectorSearch(query: string, topK: number): Promise<SearchResult[] | null> {
  if (!isVectorIndexUsable()) return null
  const apiKey = getApiKey('gemini')
  if (!(await isEmbeddingReady(apiKey))) return null
  await ensureVectorCacheProvider()
  // May have just been invalidated by a provider mismatch
  if (!isVectorIndexUsable()) return null

  let queryVec: number[]
  try {
    queryVec = (await embedBatch([query.slice(0, EMBED_TEXT_MAX_CHARS)], apiKey, 'query'))[0]
  } catch (e) {
    console.error('[vector] Query embedding failed:', e instanceof Error ? e.message : e)
    return null
  }
  if (!Array.isArray(queryVec) || queryVec.length !== _vectorDim) {
    console.error(`[vector] Query dimension mismatch (query=${queryVec?.length ?? 0}, index=${_vectorDim}) — vector path disabled`)
    return null
  }

  const scored: SearchResult[] = []
  for (const v of _vectorDocs.values()) {
    const sim = cosineSim(queryVec, v.embedding)
    if (sim <= 0) continue
    scored.push({ docId: v.docId, filename: v.filename, speaker: v.speaker, score: sim })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, topK)
}

// ── Reciprocal Rank Fusion ───────────────────────────────────────────────────

/**
 * Combines rankings with different score distributions by rank (same as the app).
 * ranks are 1-based; Infinity if not in the list.
 */
export function rrfScore(ranks: number[], k = 60): number {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0)
}

const RRF_K = 60

/**
 * Hybrid search: searches BM25 and vector **independently**, then fuses with RRF.
 *
 * The old implementation fixed BM25 top-50 as candidates and only reranked within them by vector:
 *   - Documents BM25 missed were never candidates, so vectors could not improve recall.
 *   - In 0.4*(bm25/max) + 0.6*vecSim, vecSim sits in a narrow 0.5~0.85 band,
 *     so 0.6*vecSim became quasi-constant and BM25 order effectively dominated.
 */
export async function hybridSearch(query: string, topK = 10): Promise<SearchResult[]> {
  const candidates = Math.max(topK * 5, 50)
  const bm25 = bm25Search(query, candidates)
  const vec = await vectorSearch(query, candidates)

  if (!vec || vec.length === 0) return bm25.slice(0, topK)
  if (bm25.length === 0) return vec.slice(0, topK)

  const meta = new Map<string, SearchResult>()
  const bmRank = new Map<string, number>()
  bm25.forEach((r, i) => { bmRank.set(r.docId, i + 1); meta.set(r.docId, r) })
  const vecRank = new Map<string, number>()
  vec.forEach((r, i) => { vecRank.set(r.docId, i + 1); if (!meta.has(r.docId)) meta.set(r.docId, r) })

  const fused: SearchResult[] = []
  for (const [docId, m] of meta) {
    fused.push({
      docId, filename: m.filename, speaker: m.speaker,
      score: rrfScore([bmRank.get(docId) ?? Infinity, vecRank.get(docId) ?? Infinity], RRF_K),
    })
  }
  return fused.sort((a, b) => b.score - a.score).slice(0, topK)
}

export function getVectorIndexStats(): {
  indexed: number; total: number; coverage: number; usable: boolean
  provider: EmbedProvider | null; dim: number; coverageMin: number
} {
  const total = embeddableDocs().length
  return {
    indexed: _vectorDocs.size,
    total,
    coverage: total > 0 ? Math.round((_vectorDocs.size / total) * 1000) / 1000 : 0,
    usable: isVectorIndexUsable(),
    provider: _vectorProvider,
    dim: _vectorDim,
    coverageMin: VECTOR_COVERAGE_MIN,
  }
}

// ── Graph builder ────────────────────────────────────────────────────────────

function buildGraph() {
  _nodes = []
  _links = []
  const nodeMap = new Map<string, GraphNode>()

  for (const doc of _documents) {
    const node: GraphNode = {
      id: doc.id, docId: doc.id, speaker: doc.speaker,
      label: doc.filename.replace(/\.md$/i, ''), folderPath: doc.folderPath, tags: doc.tags,
    }
    _nodes.push(node)
    nodeMap.set(doc.id, node)
  }

  // Build links from wikilinks
  const filenameToId = new Map<string, string>()
  for (const doc of _documents) {
    filenameToId.set(doc.filename.replace(/\.md$/i, '').toLowerCase(), doc.id)
  }

  const linkSet = new Set<string>()
  for (const doc of _documents) {
    const allLinks = [...doc.links, ...doc.sections.flatMap(s => s.wikiLinks)]
    for (const link of allLinks) {
      // [[Doc|alias]], [[Doc#heading]] and [[folder/Doc]] all resolve to Doc
      const targetId = filenameToId.get(normalizeWikiLink(link))
      if (!targetId || targetId === doc.id) continue
      const key = [doc.id, targetId].sort().join('::')
      if (linkSet.has(key)) continue
      linkSet.add(key)
      _links.push({ source: doc.id, target: targetId })
    }
  }

  _graphBuilt = true
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getDocuments(): LoadedDocument[] { return _documents }
export function getNodes(): GraphNode[] { return _nodes }
export function getLinks(): GraphLink[] { return _links }
export function isGraphBuilt(): boolean { return _graphBuilt }

export async function reloadVault(vaultPath?: string): Promise<{ docCount: number; nodeCount: number; linkCount: number }> {
  _documents = await loadVaultDocuments(vaultPath)
  buildGraph()
  buildBM25()
  loadVectorCache()
  // The vault changed, so drop the implicit link memo and refresh the fingerprint
  _vaultFingerprint = computeVaultFingerprint()
  _implicitMemo = null
  _implicitDiskChecked = false
  return { docCount: _documents.length, nodeCount: _nodes.length, linkCount: _links.length }
}

/** PageRank computation */
export function computePageRank(topK = 20): { docId: string; filename: string; score: number }[] {
  const adj = new Map<string, string[]>()
  for (const link of _links) {
    const s = typeof link.source === 'string' ? link.source : link.source
    const t = typeof link.target === 'string' ? link.target : link.target
    if (!adj.has(s)) adj.set(s, [])
    if (!adj.has(t)) adj.set(t, [])
    adj.get(s)!.push(t)
    adj.get(t)!.push(s)
  }

  const N = _nodes.length
  if (N === 0) return []
  const d = 0.85
  let scores = new Map<string, number>()
  for (const node of _nodes) scores.set(node.id, 1 / N)

  for (let iter = 0; iter < 30; iter++) {
    const newScores = new Map<string, number>()
    for (const node of _nodes) {
      let sum = 0
      const neighbors = adj.get(node.id) ?? []
      for (const nb of neighbors) {
        const nbDeg = (adj.get(nb) ?? []).length
        if (nbDeg > 0) sum += (scores.get(nb) ?? 0) / nbDeg
      }
      newScores.set(node.id, (1 - d) / N + d * sum)
    }
    scores = newScores
  }

  const idToFilename = new Map(_documents.map(d => [d.id, d.filename]))
  return [...scores.entries()]
    .map(([id, score]) => ({ docId: id, filename: idToFilename.get(id) ?? id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}

/** Cluster detection (Union-Find) */
export function detectClusters(): { clusterId: number; docIds: string[]; topTerms: string[] }[] {
  // Louvain communities rather than connected components: a vault with a hub page is one giant
  // component, which says nothing about topic structure (and makes "bridges" impossible).
  return detectCommunities(buildAdjacency()).communities
    .filter(ids => ids.length >= 2)
    .map((docIds, i) => ({ clusterId: i, docIds, topTerms: [] }))
}

function buildAdjacency(): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  for (const node of _nodes) adj.set(node.id, new Set())
  for (const link of _links) {
    adj.get(link.source)?.add(link.target)
    adj.get(link.target)?.add(link.source)
  }
  return adj
}

/** Documents whose neighbours span two or more Louvain communities (their own included). */
export function findBridgeNodes(topK = 10): { docId: string; filename: string; clusterCount: number; degree: number }[] {
  const adj = buildAdjacency()
  const { membership } = detectCommunities(adj)
  const idToFilename = new Map(_documents.map(d => [d.id, d.filename]))
  const bridges: { docId: string; filename: string; clusterCount: number; degree: number }[] = []
  for (const [nodeId, neighbors] of adj) {
    const own = membership.get(nodeId)
    if (own === undefined || neighbors.size === 0) continue
    const clusters = new Set<number>([own])
    for (const nb of neighbors) { const c = membership.get(nb); if (c !== undefined) clusters.add(c) }
    if (clusters.size >= 2) bridges.push({ docId: nodeId, filename: idToFilename.get(nodeId) ?? nodeId, clusterCount: clusters.size, degree: neighbors.size })
  }
  return bridges.sort((a, b) => b.clusterCount - a.clusterCount || b.degree - a.degree).slice(0, topK)
}

// ── Implicit links (BM25 cosine) ─────────────────────────────────────────────
//
// The original implementation rebuilt weight vectors for 2,635 documents on every call
// and ran 3.47M pairs × hundreds of Map lookups per document (≈1.9 billion), freezing the
// single-threaded server for 100+ seconds per tool call. Three fixes:
//   1) Inverted index + sparse accumulation — same results, Map lookups replaced by array indexing
//   2) Memoization — no recomputation if the vault fingerprint is unchanged
//   3) Disk cache — no recomputation even after a process restart

export interface ImplicitPair { docA: string; docB: string; similarity: number }

/** Default floor used when building the memo — requests with a higher minScore are answered from the memo directly */
const IMPLICIT_MEMO_FLOOR = 0.10
/** Maximum number of pairs kept in the memo (memory cap) */
const IMPLICIT_MEMO_MAX = 20_000
const IMPLICIT_CACHE_VERSION = 1

interface ImplicitMemo {
  fingerprint: string
  /** Similarity floor used for the computation */
  floor: number
  /** Whether truncated by IMPLICIT_MEMO_MAX */
  truncated: boolean
  pairs: ImplicitPair[]
}

let _vaultFingerprint = ''
let _implicitMemo: ImplicitMemo | null = null
let _implicitDiskChecked = false

/** Fingerprint of vault contents + BM25 parameters — any change invalidates the cache */
function computeVaultFingerprint(): string {
  const h = createHash('md5')
  h.update(`bm25:${BM25_K1}:${BM25_B}:fb${FILENAME_BOOST}:v1\n`)
  for (const doc of _documents) h.update(`${doc.id}:${doc.mtime ?? 0}\n`)
  return h.digest('hex')
}

function getImplicitCachePath(): string {
  return resolve(dirname(getConfigPath()), 'implicit_links_cache.json')
}

function loadImplicitCache(): void {
  if (_implicitDiskChecked) return
  _implicitDiskChecked = true
  const p = getImplicitCachePath()
  if (!existsSync(p)) return
  try {
    const rec = JSON.parse(readFileSync(p, 'utf-8')) as ImplicitMemo & { version?: number }
    if (rec.version !== IMPLICIT_CACHE_VERSION) return
    if (rec.fingerprint !== _vaultFingerprint) return
    if (!Array.isArray(rec.pairs)) return
    _implicitMemo = { fingerprint: rec.fingerprint, floor: rec.floor, truncated: Boolean(rec.truncated), pairs: rec.pairs }
    console.error(`[implicit] Disk cache hit: ${rec.pairs.length} pairs (floor=${rec.floor})`)
  } catch (e) {
    console.error('[implicit] Cache load failed:', e instanceof Error ? e.message : e)
  }
}

function saveImplicitCache(): void {
  if (!_implicitMemo) return
  try {
    writeFileSync(getImplicitCachePath(), JSON.stringify({ version: IMPLICIT_CACHE_VERSION, ..._implicitMemo }), 'utf-8')
  } catch (e) {
    console.error('[implicit] Cache save failed:', e instanceof Error ? e.message : e)
  }
}

/**
 * Computes all upper-triangular pair similarities via inverted index + sparse accumulation.
 * Results are identical to the old O(n²) double loop (only floating-point summation order differs).
 */
function computeImplicitPairs(floor: number): ImplicitMemo {
  const t0 = Date.now()
  const N = _bm25Docs.length
  const existingLinks = new Set<string>()
  for (const l of _links) existingLinks.add([l.source, l.target].sort().join('::'))

  // 1) Per-document BM25 weight vector + norm, and per-term df
  const termsPerDoc: string[][] = new Array(N)
  const weightsPerDoc: Float64Array[] = new Array(N)
  const norms = new Float64Array(N)
  const df = new Map<string, number>()

  for (let i = 0; i < N; i++) {
    const doc = _bm25Docs[i]
    const lenNorm = 1 - BM25_B + BM25_B * (doc.docLen / _avgdl)
    const terms: string[] = []
    const ws: number[] = []
    let normSq = 0
    for (const [term, tf] of doc.termFreqs) {
      const idfVal = _idf.get(term) ?? 0
      if (idfVal <= 0) continue
      const w = idfVal * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lenNorm)
      terms.push(term)
      ws.push(w)
      normSq += w * w
      df.set(term, (df.get(term) ?? 0) + 1)
    }
    termsPerDoc[i] = terms
    weightsPerDoc[i] = Float64Array.from(ws)
    norms[i] = Math.sqrt(normSq)
  }

  // 2) Inverted index — term → (document indices ascending, weights)
  interface Posting { docs: Int32Array; ws: Float64Array; fill: number; cursor: number }
  const postings = new Map<string, Posting>()
  for (const [term, n] of df) {
    postings.set(term, { docs: new Int32Array(n), ws: new Float64Array(n), fill: 0, cursor: 0 })
  }
  for (let i = 0; i < N; i++) {
    const terms = termsPerDoc[i], ws = weightsPerDoc[i]
    for (let k = 0; k < terms.length; k++) {
      const p = postings.get(terms[k])!
      p.docs[p.fill] = i
      p.ws[p.fill] = ws[k]
      p.fill++
    }
  }

  // 3) Sparse accumulation — for document i, accumulate only pairs with j > i
  const acc = new Float64Array(N)
  const touched = new Int32Array(N)
  const idOf: string[] = _bm25Docs.map(d => d.docId)
  let results: ImplicitPair[] = []
  let truncated = false
  let effectiveFloor = floor

  for (let i = 0; i < N; i++) {
    const normA = norms[i]
    const terms = termsPerDoc[i], ws = weightsPerDoc[i]
    let nTouched = 0

    for (let k = 0; k < terms.length; k++) {
      const p = postings.get(terms[k])!
      // i increases monotonically, so the cursor advances monotonically too — never rescans the j <= i range
      let c = p.cursor
      const docs = p.docs
      while (c < docs.length && docs[c] <= i) c++
      p.cursor = c
      if (normA === 0) continue
      const wA = ws[k]
      const pw = p.ws
      for (let q = c; q < docs.length; q++) {
        const j = docs[q]
        if (acc[j] === 0) touched[nTouched++] = j
        acc[j] += wA * pw[q]
      }
    }

    for (let x = 0; x < nTouched; x++) {
      const j = touched[x]
      const dot = acc[j]
      acc[j] = 0
      const normB = norms[j]
      if (normA === 0 || normB === 0) continue
      const sim = dot / (normA * normB)
      if (sim < effectiveFloor) continue
      const a = idOf[i], b = idOf[j]
      const key = a < b ? `${a}::${b}` : `${b}::${a}`
      if (existingLinks.has(key)) continue
      results.push({ docA: a, docB: b, similarity: sim })
    }

    // Memory cap — on overflow keep only the top IMPLICIT_MEMO_MAX and raise the floor
    if (results.length > IMPLICIT_MEMO_MAX * 2) {
      results.sort((p, q) => q.similarity - p.similarity)
      results.length = IMPLICIT_MEMO_MAX
      truncated = true
      effectiveFloor = Math.max(effectiveFloor, results[results.length - 1].similarity)
    }
  }

  results.sort((a, b) => b.similarity - a.similarity)
  if (results.length > IMPLICIT_MEMO_MAX) {
    results = results.slice(0, IMPLICIT_MEMO_MAX)
    truncated = true
  }
  const finalFloor = truncated && results.length > 0
    ? Math.max(floor, results[results.length - 1].similarity)
    : floor

  console.error(`[implicit] Recomputed: ${N} docs, ${results.length} pairs (floor=${finalFloor.toFixed(4)}, ${Date.now() - t0}ms)`)
  return { fingerprint: _vaultFingerprint, floor: finalFloor, truncated, pairs: results }
}

/**
 * Find implicit links via BM25 cosine similarity.
 * No recomputation if the vault is unchanged and minScore is at or above the memo floor.
 */
export function findImplicitLinks(minScore = 0.15, topK = 30): ImplicitPair[] {
  if (_bm25Docs.length === 0) return []
  if (!_vaultFingerprint) _vaultFingerprint = computeVaultFingerprint()
  loadImplicitCache()

  const memo = _implicitMemo
  let usable = memo !== null && memo.fingerprint === _vaultFingerprint
  if (usable && minScore < memo!.floor) {
    // minScore is below the memo floor. The memo holds the **global top** pairs and
    // every missing pair has lower similarity, so the result is exact as long as topK can be filled.
    let n = 0
    for (const p of memo!.pairs) {
      if (p.similarity >= minScore) n++
      if (n >= topK) break
    }
    usable = n >= topK
  }

  if (!usable) {
    _implicitMemo = computeImplicitPairs(Math.min(minScore, IMPLICIT_MEMO_FLOOR))
    saveImplicitCache()
  }

  const pairs = _implicitMemo!.pairs
  const out: ImplicitPair[] = []
  for (const p of pairs) {
    if (p.similarity < minScore) continue
    out.push(p)
    if (out.length >= topK) break
  }
  return out
}
