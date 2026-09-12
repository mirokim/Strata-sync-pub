/**
 * graphRAG.ts — Graph-Augmented RAG
 *
 * Enhances ChromaDB search results using wiki-link graph relationships:
 *  1. Graph expansion: include content from neighbor sections
 *  2. Keyword reranking with speaker affinity: reorder candidates by term overlap
 *  3. Compressed formatting: token-efficient context for LLM
 *  4. TF-IDF vector search: cosine similarity seeding (graphAnalysis.ts)
 *  5. Graph metrics: PageRank + cluster info in context header
 *  6. Passage-level retrieval: query-aware section selection (B)
 *  7. Implicit link discovery: hidden semantic connections (A)
 *  8. Cluster topic labels: TF-IDF keywords per cluster (C)
 *  9. Bridge node detection: cross-cluster connector docs (D)
 */

import type { SearchResult, GraphLink, LoadedDocument, DocSection } from '@/types'
import { isProposalPath, PROPOSAL_SCORE_WEIGHT } from '@shared/proposals'
import { useGraphStore } from '@/stores/graphStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { logger } from '@/lib/logger'
import {
  tfidfIndex,
  getGraphMetrics,
  tokenize as _tokenize,
  detectBridgeNodes,
  getClusterTopics,
  getContentDate,
} from '@/lib/graphAnalysis'
import { runPPRInWorker } from '@/lib/pprWorkerClient'
import { expandTerms } from '@/lib/synonyms'

// ── Persona tag affinity map ──────────────────────────────────────────────────

/**
 * Maps each built-in director persona to its affinity tag.
 * Documents tagged with this value are boosted during retrieval.
 * Tags are matched case-insensitively.
 */
export const PERSONA_TAG_MAP: Record<string, string> = {
  chief_director: 'chief',
  art_director: 'art',
  plan_director: 'design',
  level_director: 'level',
  prog_director: 'tech',
}

// ── Domain → tag affinity map (query-based tag boost) ────────────────────────

/**
 * Boosts scores by matching domain keywords detected in the query against frontmatter tags.
 * Key: domain keyword to detect in the query (lowercase)
 * Value: list of tags related to that domain (lowercase)
 */
export const DOMAIN_TAG_MAP: Record<string, string[]> = {
  '밸런스': ['balance', 'design', '밸런스'],
  '캐릭터': ['character', '캐릭터', 'persona'],
  '전투': ['combat', '전투', 'battle'],
  '레벨': ['level', '레벨', 'map'],
  '아트': ['art', '아트', 'visual'],
  'ui': ['ui', 'ux', '인터페이스'],
  '사운드': ['sound', 'audio', '사운드'],
  '네트워크': ['network', 'server', '네트워크'],
  '스토리': ['story', 'narrative', '스토리', '세계관'],
}

/**
 * Detects DOMAIN_TAG_MAP keywords in the query text and
 * returns the set of related tags for all matched domains.
 */
export function detectDomainTags(query: string): Set<string> {
  const q = query.toLowerCase()
  const matched = new Set<string>()
  for (const [domain, tags] of Object.entries(DOMAIN_TAG_MAP)) {
    if (q.includes(domain)) {
      for (const t of tags) matched.add(t)
    }
  }
  return matched
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface NeighborContext {
  sectionId: string
  heading: string
  content: string
  linkedFrom: string
  filename: string
}

/**
 * Tokenize a Korean/English query string into search stems.
 * Delegates to graphAnalysis.tokenize — includes Korean particle stripping.
 * Exported so llmClient.ts can pass query terms to context builders.
 */
export function tokenizeQuery(text: string): string[] {
  return _tokenize(text)
}

// ── Generic heading filter (removes PPTX/PDF slide/page heading noise) ──────
const GENERIC_HEADING_RE = /^(슬라이드|페이지|slide|page)\s*\d+$/i

/** Replaces generic headings that do not contribute to search scoring with an empty string */
function headingForScore(heading: string): string {
  return GENERIC_HEADING_RE.test(heading.trim()) ? '' : heading
}

// ── Archive / outdated detection ─────────────────────────────────────────────

const ARCHIVE_PATH_RE = /(?:^|[\\/])\.?archive[\\/]/i

/** Determines whether a document is archived or in outdated/deprecated status */
function isOutdatedDoc(doc: { status?: string; folderPath?: string; absolutePath?: string } | undefined): boolean {
  if (!doc) return false
  if (doc.status === 'outdated' || doc.status === 'deprecated') return true
  const path = (doc.folderPath ?? (doc as any).absolutePath ?? '')
  return ARCHIVE_PATH_RE.test(path)
}

// ── Status weighting (document lifecycle ≠ Jira workflow) ────────────────────

/**
 * The frontmatter `status:` field mixes two kinds of values.
 *  - Document lifecycle: active(71.1%) / outdated(1.7%) / deprecated
 *  - Jira workflow: 할 일 (to do) / in dev / check issue / 닫힘 (closed) / 해결됨 (resolved)
 *
 * `active` covers 71% of the vault, so boosting it effectively acts as a penalty on the
 * remaining 29% (278 docs without status + 439 with Jira statuses).
 * Therefore `active` stays neutral (0) and only Jira workflow statuses get a slight weight.
 * The outdated/deprecated penalty is maintained separately in isOutdatedDoc().
 */
const JIRA_OPEN_STATUS = new Set([
  'in dev', 'in progress', 'in-progress', 'check issue',
  '할 일', 'to do', 'todo', 'open', 'reopened', '진행중', '진행 중',
])
const JIRA_CLOSED_STATUS = new Set([
  '닫힘', 'closed', 'done', '완료', '해결됨', 'resolved', 'wontfix', "won't do",
])

/** status string → additive score multiplier (boost/penalty). active/unspecified = 0. */
function statusBoostFor(status: string | undefined): number {
  if (!status) return 0
  const s = status.toLowerCase().trim()
  if (JIRA_OPEN_STATUS.has(s)) return 0.05    // in-progress issue = most recent information
  if (JIRA_CLOSED_STATUS.has(s)) return -0.05 // closed issue = relatively old
  return 0
}

// ── Recency helpers ──────────────────────────────────────────────────────────

/** getContentDate imported from graphAnalysis.ts */

/**
 * Returns a short date label (YYYY-MM-DD) for context headers.
 * Empty string when date is unavailable.
 */
function getDocDateLabel(doc: LoadedDocument): string {
  const t = getContentDate(doc)
  if (t > 0) return new Date(t).toISOString().slice(0, 10)
  return ''
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Build an undirected adjacency map from graph links.
 * Handles both string IDs and resolved GraphNode objects (d3-force mutates these).
 * Exported for use in useVaultLoader (implicit link pre-computation).
 */
export function buildAdjacencyMap(links: GraphLink[]): Map<string, string[]> {
  const adj = new Map<string, string[]>()

  for (const link of links) {
    const source = typeof link.source === 'string' ? link.source : link.source.id
    const target = typeof link.target === 'string' ? link.target : link.target.id

    if (!adj.has(source)) adj.set(source, [])
    if (!adj.has(target)) adj.set(target, [])
    adj.get(source)!.push(target)
    adj.get(target)!.push(source)
  }

  return adj
}

/** Build a lookup map: section_id → { section, filename, docId } */
function buildSectionMap(
  docs: LoadedDocument[]
): Map<string, { section: DocSection; filename: string; docId: string }> {
  const map = new Map<string, { section: DocSection; filename: string; docId: string }>()
  for (const doc of docs) {
    for (const section of doc.sections) {
      map.set(section.id, { section, filename: doc.filename, docId: doc.id })
    }
  }
  return map
}

// ── 0. Frontend search (TF-IDF first, keyword fallback) ─────────────────────

/**
 * Searches vault documents.
 *
 * Pipeline:
 *   1. TF-IDF cosine similarity search (when tfidfIndex is built)
 *      — finds semantically close documents, solving the title-mismatch problem
 *   2. Keyword-based fallback search when TF-IDF returns nothing
 *
 * @param query  user query
 * @param topN   maximum number of results to return
 */
export function frontendKeywordSearch(
  query: string,
  topN: number = 8,
  currentSpeaker?: string,
  contextTerms?: string[],
): SearchResult[] {
  const { loadedDocuments } = useVaultStore.getState()
  if (!loadedDocuments || loadedDocuments.length === 0) return []

  // O(1) lookup map — reuse cached version if available, else build once
  const { links } = useGraphStore.getState()
  const docMap = links.length > 0
    ? getCachedMaps(links, loadedDocuments).docMap
    : new Map(loadedDocuments.map(d => [d.id, d]))

  const personaTag = currentSpeaker ? PERSONA_TAG_MAP[currentSpeaker] : undefined
  const TAG_BOOST = 0.1

  // Domain tag detection for query-based boost
  const domainTags = detectDomainTags(query)

  // ── Prepare history context keywords (0.3 weight boost) ────────────────────
  const ctxTerms = contextTerms?.filter(t => t.length >= 2).slice(0, 6) ?? []
  const CTX_WEIGHT = 0.3

  // ── TF-IDF search first ───────────────────────────────────────────────────
  if (tfidfIndex.isBuilt) {
    const tfidfHits = tfidfIndex.search(query, topN * 2)  // over-fetch for tag re-sort
    if (tfidfHits.length > 0) {
      const queryStems = tokenizeQuery(query)  // shared — not recomputed inside the map
      const results = tfidfHits.map(hit => {
        const doc = docMap.get(hit.docId)
        // Pick the section within the document that best matches the query
        let bestSection = doc?.sections.find(s => s.body.trim())
        let bestSectionScore = -1
        if (doc && queryStems.length > 0) {
          for (const section of doc.sections) {
            if (!section.body.trim()) continue
            const text = `${headingForScore(section.heading)} ${section.body}`.toLowerCase()
            let matchCount = 0
            for (const s of queryStems) { if (text.includes(s)) matchCount++ }
            if (matchCount > bestSectionScore) {
              bestSectionScore = matchCount
              bestSection = section
            }
          }
        }
        const tags = doc?.tags ?? []
        const tagsLower = tags.map(t => t.toLowerCase())
        const hasPersonaTag = personaTag
          ? tagsLower.some(t => t === personaTag)
          : false
        // Domain tag boost: tags matching the query domain +15~20%
        let domainBoost = 0
        if (domainTags.size > 0 && tagsLower.length > 0) {
          const matchCount = tagsLower.filter(t => domainTags.has(t)).length
          domainBoost = Math.min(0.20, matchCount * 0.10)
        }
        // Status: active(71%) boost removed — only Jira in-progress +5% / closed -5% slight weighting
        const statusBoost = statusBoostFor(doc?.status)
        // Penalty for outdated/deprecated/archive documents
        const outdatedPenalty = isOutdatedDoc(doc) ? -0.25 : 0
        // History context keyword boost
        let ctxBoost = 0
        if (ctxTerms.length > 0 && doc) {
          const raw = (doc.rawContent ?? '').toLowerCase()
          let ctxHits = 0
          for (const t of ctxTerms) { if (raw.includes(t)) ctxHits++ }
          ctxBoost = (ctxHits / ctxTerms.length) * CTX_WEIGHT
        }
        // Agent proposals (_agent/) rank below promoted documents until a person promotes them
        const proposalWeight = isProposalPath(doc?.folderPath ?? '') ? PROPOSAL_SCORE_WEIGHT : 1
        const scoreMultiplier = (1 + (hasPersonaTag ? TAG_BOOST : 0) + domainBoost + statusBoost) * proposalWeight
        return {
          doc_id: hit.docId,
          filename: hit.filename,
          section_id: bestSection?.id ?? '',
          heading: bestSection?.heading ?? '',
          speaker: hit.speaker,
          content: bestSection
            ? (bestSection.body.length > 400
              ? bestSection.body.slice(0, 400).trimEnd() + '…'
              : bestSection.body)
            : '',
          score: Math.max(0, Math.min(1, hit.score * scoreMultiplier + outdatedPenalty + ctxBoost)),
          tags,
        } satisfies SearchResult
      })
      results.sort((a, b) => b.score - a.score)
      return results.slice(0, topN)
    }
  }

  // ── Keyword fallback search (when TF-IDF index is not built) ──────────────
  const queryStems = tokenizeQuery(query)
  if (queryStems.length === 0) return []

  const scored: { result: SearchResult; score: number }[] = []

  for (const doc of loadedDocuments) {
    for (const section of doc.sections) {
      if (!section.body.trim()) continue

      const headingLower = section.heading.toLowerCase()
      const bodyLower = section.body.toLowerCase()

      let score = 0
      let matchedTerms = 0
      for (const stem of queryStems) {
        const inHeading = headingLower.includes(stem)
        let bodyCount = 0
        if (bodyLower.includes(stem)) {  // fast path: skip indexOf loop if no match
          let pos = 0
          while ((pos = bodyLower.indexOf(stem, pos)) !== -1) { bodyCount++; pos += Math.max(stem.length, 1) }
        }
        if (inHeading || bodyCount > 0) {
          matchedTerms++
          score += inHeading ? 0.3 : 0
          score += bodyCount > 0 ? 0.1 * (1 + Math.log(bodyCount)) : 0
        }
      }

      if (matchedTerms === 0 && ctxTerms.length === 0) continue

      const coverage = matchedTerms / queryStems.length
      score = Math.min(1, score * 0.6 + coverage * 0.4)

      // History context keyword boost (fallback path)
      if (ctxTerms.length > 0) {
        let ctxHits = 0
        for (const t of ctxTerms) {
          if (headingLower.includes(t) || bodyLower.includes(t)) ctxHits++
        }
        if (matchedTerms === 0 && ctxHits === 0) continue
        score += (ctxHits / ctxTerms.length) * CTX_WEIGHT
      }

      const tags = doc.tags ?? []
      const tagsLower = tags.map(t => t.toLowerCase())
      const hasPersonaTag = personaTag
        ? tagsLower.some(t => t === personaTag)
        : false
      // Domain tag boost
      let kwDomainBoost = 0
      if (domainTags.size > 0 && tagsLower.length > 0) {
        const matchCount = tagsLower.filter(t => domainTags.has(t)).length
        kwDomainBoost = Math.min(0.20, matchCount * 0.10)
      }
      // Status: active boost removed — only Jira in-progress/closed slight weighting
      const kwStatusBoost = statusBoostFor(doc.status)
      const boostedScore = Math.min(1, score * (1 + (hasPersonaTag ? TAG_BOOST : 0) + kwDomainBoost + kwStatusBoost))

      scored.push({
        score: boostedScore,
        result: {
          doc_id: doc.id,
          filename: doc.filename,
          section_id: section.id,
          heading: section.heading,
          speaker: doc.speaker,
          content: section.body.length > 400
            ? section.body.slice(0, 400).trimEnd() + '…'
            : section.body,
          score: boostedScore,
          tags,
        },
      })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, topN).map(s => s.result)
}

// ── Direct string search (simple grep-style fallback) ────────────────────────

/**
 * Direct string search over all vault documents using the query words.
 *
 * A simple fallback that supplements documents TF-IDF/BFS failed to find.
 * Filename matches are weighted 2x, body matches 1x.
 */
/**
 * Token containment check — only numeric tokens respect boundaries.
 *
 * Filename matching was a pure substring match, so token "160" from query "SGEATF-160"
 * matched "SGEATF-12160" and an unrelated Jira ticket got a perfect filename score.
 * Korean/English word boundaries are ambiguous, so the existing substring matching is kept for them.
 */
function containsTerm(haystack: string, term: string): boolean {
  if (!/^\d+$/.test(term)) return haystack.includes(term)
  for (let from = 0; ; ) {
    const i = haystack.indexOf(term, from)
    if (i < 0) return false
    const before = i > 0 ? haystack[i - 1] : ''
    const after = haystack[i + term.length] ?? ''
    if (!/\d/.test(before) && !/\d/.test(after)) return true
    from = i + 1
  }
}

export function directVaultSearch(
  query: string,
  topN: number = 5,
  contextTerms?: string[],
): SearchResult[] {
  const { loadedDocuments } = useVaultStore.getState()
  if (!loadedDocuments?.length) return []

  // Strip particles/punctuation via the tokenizer (includes Korean particle stripping, "이사장님의" → "이사장님")
  const tokenized = expandTerms(_tokenize(query))
  // Supplement with 2+ digit numbers: so components of date-style filenames like "[2026.01.28]" match reliably
  const numericTerms = query.match(/\d{2,}/g) ?? []
  const terms = [...new Set([...tokenized, ...numericTerms])]
  if (terms.length === 0) return []

  // History context keywords (de-duplicated, only those not already in terms)
  const ctxTerms = contextTerms
    ? contextTerms.filter(t => !terms.includes(t)).slice(0, 6)
    : []
  const CTX_WEIGHT = 0.3

  const scored: { doc: LoadedDocument; score: number; bestSection: DocSection | null }[] = []
  const now = Date.now()

  for (const doc of loadedDocuments) {
    const filename = doc.filename.toLowerCase()
    // 7-9: Look up lowercase rawContent/section text from the mtime-keyed cache
    // (recomputed automatically when mtime changes after an edit — prevents the stale-body bug)
    const lower = getLowerEntry(doc)
    const raw = lower.raw

    // Match count per query word (pure coverage, no weighting)
    let filenameHits = 0
    let bodyHits = 0
    for (const term of terms) {
      if (containsTerm(filename, term)) filenameHits++
      if (containsTerm(raw, term)) bodyHits++
    }

    // History context keyword matching (low weight)
    let ctxFilenameHits = 0
    let ctxBodyHits = 0
    for (const term of ctxTerms) {
      if (containsTerm(filename, term)) ctxFilenameHits++
      if (containsTerm(raw, term)) ctxBodyHits++
    }

    if (filenameHits === 0 && bodyHits === 0 && ctxFilenameHits === 0 && ctxBodyHits === 0) continue

    // Coverage-based score: filename 60%, body 40% — ratio of query words covered
    const n = terms.length
    let score = (filenameHits / n) * 0.6 + (bodyHits / n) * 0.4

    // History context keyword addition (0.3 weight)
    if (ctxTerms.length > 0) {
      const ctxScore = (ctxFilenameHits / ctxTerms.length) * 0.6 + (ctxBodyHits / ctxTerms.length) * 0.4
      score += ctxScore * CTX_WEIGHT
    }

    // Filename match boost: scale up to the 0.3~1.0 range (a single match alone does not pin)
    if (filenameHits > 0) {
      score = 0.3 + score * 0.7  // 0-1 → 0.3-1.0
    }

    // Pick the section overlapping the most query words
    // 7-9: section lowercase text also comes from the cache — removes the concat+toLowerCase that took 26ms of a measured 91ms
    let bestSection: DocSection | null = null
    let bestSectionScore = -1
    const sectionTexts = lower.sectionTexts
    for (let si = 0; si < doc.sections.length; si++) {
      const text = sectionTexts[si]
      if (!text) continue  // sections with empty body are cached as ''
      let sScore = 0
      for (const t of terms) { if (text.includes(t)) sScore++ }
      if (sScore > bestSectionScore) {
        bestSectionScore = sScore
        bestSection = doc.sections[si]
      }
    }

    scored.push({ doc, score, bestSection })
  }

  // Sort by coverage score (absolute filename priority removed)
  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, topN).map(({ doc, score, bestSection }) => ({
    doc_id: doc.id,
    filename: doc.filename,
    section_id: bestSection?.id ?? '',
    heading: bestSection?.heading ?? '',
    speaker: doc.speaker,
    content: bestSection
      ? (bestSection.body.length > 500 ? bestSection.body.slice(0, 500).trimEnd() + '…' : bestSection.body)
      : '',
    score,  // already in the 0-1 range (coverage ratio)
    tags: doc.tags ?? [],
  } satisfies SearchResult))
}

// ── Graph data cache ────────────────────────────────────────────────────────

let _cachedAdjacency: Map<string, string[]> | null = null
let _cachedSectionMap: Map<string, { section: DocSection; filename: string; docId: string }> | null = null
let _cachedDocMap: Map<string, LoadedDocument> | null = null
let _cachedMetrics: ReturnType<typeof getGraphMetrics> | null = null
let _cachedLinksKey: string = ''
let _cachedDocsKey: string = ''

/**
 * 7-9: Lowercase conversion cache — removes the cost of toLowerCase() over the whole vault on every search.
 *
 * docId → { key, raw, sectionTexts }
 *  - key: `${doc.id}:${doc.mtime}` — recomputed automatically when mtime changes (= document saved)
 *  - raw: rawContent.toLowerCase()
 *  - sectionTexts: lowercase `heading body` text, index-aligned with doc.sections
 *
 * A size cap (LOWER_CACHE_MAX_CHARS) prevents unbounded growth.
 * Past the cap the policy is "stop inserting" — FIFO eviction during a sequential scan
 * would thrash the cache by turning it over on every pass.
 */
interface LowerEntry {
  key: string
  raw: string
  sectionTexts: string[]
  chars: number
}
const _lowerCache = new Map<string, LowerEntry>()
/**
 * Cap on total characters in the lowercase cache (≈48MB in UTF-16).
 * A real vault (2,635 docs) fits entirely: rawContent 11.5M + section text 10.8M = 22.4M chars.
 * For larger vaults, only new insertions stop once the cap is reached (no eviction) — FIFO
 * eviction during a sequential scan would thrash the cache by turning it over on every call.
 */
const LOWER_CACHE_MAX_CHARS = 24_000_000
let _lowerCacheChars = 0

function lowerCacheKey(doc: LoadedDocument): string {
  return `${doc.id}:${doc.mtime ?? 0}:${doc.rawContent?.length ?? 0}`
}

/** Returns the document's lowercase cache entry (recomputed if mtime changed) */
function getLowerEntry(doc: LoadedDocument): LowerEntry {
  const key = lowerCacheKey(doc)
  const hit = _lowerCache.get(doc.id)
  if (hit && hit.key === key) return hit

  const raw = (doc.rawContent ?? '').toLowerCase()
  const sectionTexts: string[] = []
  let chars = raw.length
  for (const s of doc.sections) {
    const t = s.body.trim()
      ? `${headingForScore(s.heading)} ${s.body}`.toLowerCase()
      : ''
    sectionTexts.push(t)
    chars += t.length
  }
  const entry: LowerEntry = { key, raw, sectionTexts, chars }

  if (hit) {
    // Replace the stale entry for the same document — mtime-based removal
    _lowerCacheChars -= hit.chars
    _lowerCache.delete(doc.id)
  }
  if (_lowerCacheChars + chars <= LOWER_CACHE_MAX_CHARS) {
    _lowerCache.set(doc.id, entry)
    _lowerCacheChars += chars
  }
  return entry
}

/** Clear the entire lowercase cache */
function clearLowerCache(): void {
  _lowerCache.clear()
  _lowerCacheChars = 0
}

/**
 * Link array fingerprint — length + evenly spaced `source→target` samples.
 *
 * GraphLink has no `id` field (see `src/types/index.ts`), so the old arrayKey() always
 * returned `"N:::::::"` and **only the link count** served as the fingerprint.
 * A graph with the same count but different content was never invalidated.
 */
function linksFingerprint(links: GraphLink[]): string {
  const n = links.length
  if (n === 0) return '0'
  const step = Math.max(1, Math.floor(n / 16))
  const parts: string[] = []
  for (let i = 0; i < n; i += step) {
    const l = links[i]
    const s = typeof l.source === 'string' ? l.source : l.source?.id ?? ''
    const t = typeof l.target === 'string' ? l.target : l.target?.id ?? ''
    parts.push(`${s}>${t}`)
  }
  const last = links[n - 1]
  const ls = typeof last.source === 'string' ? last.source : last.source?.id ?? ''
  const lt = typeof last.target === 'string' ? last.target : last.target?.id ?? ''
  return `${n}:${parts.join('|')}|${ls}>${lt}`
}

/**
 * Document array fingerprint — condenses id, mtime and body length of every document into a 32-bit rolling hash.
 *
 * Why a full pass instead of sampling: if the edited document is not at a sample position,
 * the fingerprint stays the same and `_cachedDocMap` **keeps returning the pre-edit document object**,
 * so the entire RAG context passed to the LLM becomes the pre-edit body.
 * The full pass costs under 1ms for 2,635 documents.
 */
function docsFingerprint(docs: LoadedDocument[]): string {
  const n = docs.length
  if (n === 0) return '0'
  let h = 0x811c9dc5
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = docs[i]
    const id = d.id
    for (let c = 0; c < id.length; c++) {
      h = Math.imul(h ^ id.charCodeAt(c), 0x01000193) >>> 0
    }
    const m = d.mtime ?? 0
    const lo = m % 0x100000000
    const hi = Math.floor(m / 0x100000000)
    const len = d.rawContent?.length ?? 0
    h = Math.imul(h ^ lo, 0x01000193) >>> 0
    h = Math.imul(h ^ hi, 0x01000193) >>> 0
    h = Math.imul(h ^ len, 0x01000193) >>> 0
    sum = (sum + len + (m % 1_000_003)) % 0x7fffffff
  }
  return `${n}:${h.toString(36)}:${sum.toString(36)}`
}

/**
 * Forcibly invalidates graphRAG's internal caches (adjacency/sectionMap/docMap/metrics/lowercase).
 * Call right after a vault switch or document update.
 */
export function invalidateGraphRAGCache(): void {
  _cachedAdjacency = null
  _cachedSectionMap = null
  _cachedDocMap = null
  _cachedMetrics = null
  _cachedLinksKey = ''
  _cachedDocsKey = ''
  clearLowerCache()
}

function getCachedMaps(links: GraphLink[], docs: LoadedDocument[]) {
  const linksKey = linksFingerprint(links)
  const docsKey = docsFingerprint(docs)
  if (linksKey !== _cachedLinksKey || docsKey !== _cachedDocsKey || !_cachedDocMap) {
    _cachedAdjacency = buildAdjacencyMap(links)
    _cachedSectionMap = buildSectionMap(docs)
    _cachedDocMap = new Map(docs.map(d => [d.id, d]))
    _cachedMetrics = null  // invalidate metrics — recomputed on next call
    // Reclaim lowercase cache for documents gone after a vault switch etc. (individual entries self-invalidate via the mtime key)
    for (const [docId, entry] of _lowerCache) {
      if (!_cachedDocMap.has(docId)) {
        _lowerCacheChars -= entry.chars
        _lowerCache.delete(docId)
      }
    }
    _cachedLinksKey = linksKey
    _cachedDocsKey = docsKey
  }
  return {
    adjacency: _cachedAdjacency!,
    sectionMap: _cachedSectionMap!,
    docMap: _cachedDocMap!,
    /** Lazily compute and cache graph metrics (PageRank + clusters) */
    getMetrics: () => {
      if (!_cachedMetrics) _cachedMetrics = getGraphMetrics(_cachedAdjacency!, links)
      return _cachedMetrics
    },
  }
}

// ── 1. Graph expansion ───────────────────────────────────────────────────────

/**
 * Expand search results with graph-connected neighbor sections.
 *
 * For each ChromaDB result, looks up wiki-link neighbors in the graph
 * and includes truncated content from connected sections.
 *
 * @param results                ChromaDB search results (already reranked)
 * @param maxNeighborsPerResult  Max neighbor sections to include per result
 */
export function expandWithGraphNeighbors(
  results: SearchResult[],
  maxNeighborsPerResult: number = 2
): NeighborContext[] {
  const { links } = useGraphStore.getState()
  const { loadedDocuments } = useVaultStore.getState()

  if (!loadedDocuments || loadedDocuments.length === 0 || links.length === 0) {
    return []
  }

  const { adjacency, sectionMap, docMap } = getCachedMaps(links, loadedDocuments)

  // Map result section_ids to their parent doc IDs
  const primaryDocIds = new Set<string>()
  for (const r of results) {
    if (!r.section_id) continue
    const entry = sectionMap.get(r.section_id)
    if (entry) primaryDocIds.add(entry.docId)
  }

  const seenDocIds = new Set<string>()
  const neighbors: NeighborContext[] = []

  for (const result of results) {
    if (!result.section_id) continue

    // Find the parent doc ID for this result
    const resultEntry = sectionMap.get(result.section_id)
    if (!resultEntry) continue
    const resultDocId = resultEntry.docId

    // Graph adjacency is now document-level (doc.id → doc.id)
    const connectedDocIds = adjacency.get(resultDocId) ?? []
    let added = 0

    for (const neighborDocId of connectedDocIds) {
      if (added >= maxNeighborsPerResult) break
      if (primaryDocIds.has(neighborDocId)) continue
      if (seenDocIds.has(neighborDocId)) continue

      // Find first non-empty section from the neighbor document
      const neighborDoc = docMap.get(neighborDocId)
      if (!neighborDoc) continue
      const firstSection = neighborDoc.sections.find(s => s.body.trim())
      if (!firstSection) continue

      seenDocIds.add(neighborDocId)
      const body = firstSection.body
      neighbors.push({
        sectionId: firstSection.id,
        heading: firstSection.heading,
        content: body.length > 300 ? body.slice(0, 300).trimEnd() + '…' : body,
        linkedFrom: result.section_id,
        filename: neighborDoc.filename,
      })
      added++
    }
  }

  return neighbors
}

// ── 2. 2-stage reranking ─────────────────────────────────────────────────────

/**
 * Rerank search results by combining vector similarity score
 * with keyword overlap and optional speaker affinity.
 *
 * Formula:
 *   keyword_score = |query_terms ∩ content_terms| / |query_terms|
 *   speaker_boost = 0.1 if speaker matches current persona, else 0
 *   final_score   = 0.6 × vector_score + 0.3 × keyword_score + speaker_boost
 *
 * @param results         ChromaDB search results (pre-filtered by score > 0.3)
 * @param query           Original user query
 * @param topN            Number of results to return after reranking
 * @param currentSpeaker  Current director persona (for speaker affinity boost)
 */
export function rerankResults(
  results: SearchResult[],
  query: string,
  topN: number = 3,
  currentSpeaker?: string
): SearchResult[] {
  // The purpose is "ordering", not "truncating the count".
  // Returning early on `results.length <= topN` would skip all speaker/persona/domain/type/status
  // boosts and the outdated penalty whenever there are rerankSeeds (default 5) or fewer candidates.
  if (results.length <= 1) return results

  // Tokenize query with Korean particle stripping
  const queryStems = new Set(tokenizeQuery(query))

  if (queryStems.size === 0) return results.slice(0, topN)

  // 7-11: Reuse the docMap cache from getCachedMaps() to avoid rebuilding the Map on every call
  const { links } = useGraphStore.getState()
  const { loadedDocuments: _docs } = useVaultStore.getState()
  const _docMap = _docs?.length && links?.length
    ? getCachedMaps(links, _docs).docMap
    : _docs ? new Map(_docs.map(d => [d.id, d])) : new Map<string, LoadedDocument>()
  const { rerankVectorWeight, rerankKeywordWeight } = useSettingsStore.getState().searchConfig

  // Domain tag detection: detect domain keywords in the query → set of related tags
  const domainTags = detectDomainTags(query)

  const scored = results.map(r => {
    const contentLower = (r.content + ' ' + (r.heading ?? '')).toLowerCase()

    let overlap = 0
    for (const stem of queryStems) {
      if (contentLower.includes(stem)) overlap++
    }
    const keywordScore = overlap / queryStems.size

    // Speaker affinity boost
    const speakerBoost =
      currentSpeaker && currentSpeaker !== 'unknown' && r.speaker === currentSpeaker
        ? 0.1
        : 0

    // Persona tag affinity boost
    const pTag = currentSpeaker ? PERSONA_TAG_MAP[currentSpeaker] : undefined
    const personaTagBoost = pTag && r.tags?.some(t => t.toLowerCase() === pTag) ? 0.15 : 0

    // Domain tag boost: +15~20% when document tags match the query domain
    const docTags = r.tags?.map(t => t.toLowerCase()) ?? []
    const doc = _docMap.get(r.doc_id)
    let domainTagBoost = 0
    if (domainTags.size > 0 && docTags.length > 0) {
      const matchCount = docTags.filter(t => domainTags.has(t)).length
      // +10% per matching tag, max +20%
      domainTagBoost = Math.min(0.20, matchCount * 0.10)
    }

    // Document type boost: slight addition when a type field is present (spec/guide preferred)
    const docType = doc?.type?.toLowerCase() ?? ''
    const typeBoost = (docType === 'spec' || docType === 'guide' || docType === 'reference') ? 0.05 : 0

    // Status: active (71% of vault) boost removed — Jira in-progress +5% / closed -5%
    const statusBoost = statusBoostFor(doc?.status)

    // Outdated/deprecated/archive penalty (recency boost is already handled in fetchRAGContext Stage 1)
    const outdatedPenalty = isOutdatedDoc(doc) ? -0.3 : 0

    const baseScore = rerankVectorWeight * r.score + rerankKeywordWeight * keywordScore
    const finalScore = baseScore * (1 + speakerBoost + personaTagBoost + domainTagBoost + typeBoost + statusBoost) + outdatedPenalty

    return { result: r, finalScore }
  })

  scored.sort((a, b) => b.finalScore - a.finalScore)

  return scored.slice(0, topN).map(s => s.result)
}

// ── 3.5 Version deduplication ────────────────────────────────────────────────

const VERSION_RE = /[_\s]v(\d+(?:\.\d+)?)(?:\.md)?$/i
// Korean ordinal version: _2차, _3차
const KO_VERSION_RE = /[_\s](\d+)차(?:\.md)?$/i
// Final/revised markers: _최종, _final, _revised, _개정
const FINAL_RE = /[_\s](최종|final|revised|개정)(?:\.md)?$/i

/** Extracts the base name by stripping every version suffix (English, Korean, final markers). */
function stripVersionSuffix(filename: string): string {
  return filename
    .replace(VERSION_RE, '')
    .replace(KO_VERSION_RE, '')
    .replace(FINAL_RE, '')
    .replace(/\.md$/i, '')
    .toLowerCase()
    .trim()
}

/** Extracts the version number from a filename (English v<number> or Korean N차). */
function extractVersionNumber(filename: string): number {
  const enMatch = filename.match(VERSION_RE)
  if (enMatch) return parseFloat(enMatch[1])
  const koMatch = filename.match(KO_VERSION_RE)
  if (koMatch) return parseFloat(koMatch[1])
  return 0
}

/** Checks whether the filename contains a final/revised marker. */
function isFinalVersion(filename: string): boolean {
  return FINAL_RE.test(filename)
}

/**
 * Parses filename version suffixes (_v2, _v3, _2차, _최종, etc.) and removes older versions of the same document.
 * Final/revised-marked documents take top priority, then the highest version number; ties keep the one with the newest frontmatter date.
 */
export function deduplicateVersions(
  results: SearchResult[],
  docMap: Map<string, LoadedDocument>,
): SearchResult[] {
  const groups = new Map<string, SearchResult[]>()
  for (const r of results) {
    const base = stripVersionSuffix(r.filename)
    if (!groups.has(base)) groups.set(base, [])
    groups.get(base)!.push(r)
  }

  const deduped: SearchResult[] = []
  for (const [, group] of groups) {
    if (group.length <= 1) { deduped.push(group[0]); continue }
    // Final marker first → highest version number → newest date
    group.sort((a, b) => {
      const fa = isFinalVersion(a.filename) ? 1 : 0
      const fb = isFinalVersion(b.filename) ? 1 : 0
      if (fa !== fb) return fb - fa
      const va = extractVersionNumber(a.filename)
      const vb = extractVersionNumber(b.filename)
      if (va !== vb) return vb - va
      const da = docMap.get(a.doc_id)?.date ?? ''
      const db = docMap.get(b.doc_id)?.date ?? ''
      return db.localeCompare(da)
    })
    deduped.push(group[0])  // keep only the latest version
  }
  return deduped
}

// ── 3a. Deep graph traversal (BFS) ───────────────────────────────────────────

/**
 * Returns the document body text with the frontmatter YAML removed.
 *
 * Priority:
 *   1. Combined sections (output from which gray-matter has already stripped the frontmatter)
 *   2. Manually strip frontmatter from rawContent (when all sections are empty)
 *
 * Why rawContent is not used as-is: rawContent includes the YAML frontmatter, so the
 * AI misreads "---\nspeaker: ...\ntags: ..." etc. as actual content.
 */
/** Convert raw wikilinks to display text: [[target|display]] → display, [[target]] → target */
function cleanWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
}

export function getStrippedBody(doc: LoadedDocument): string {
  // Single pass — accumulate directly without filter+map intermediate arrays
  const parts: string[] = []
  for (const s of doc.sections) {
    if (!s.body.trim()) continue
    const h = s.heading && s.heading !== '(intro)' ? `### ${s.heading}\n` : ''
    parts.push(h + s.body)
  }
  const sectionText = parts.join('\n\n').trim()
  if (sectionText) return cleanWikiLinks(sectionText)

  // All sections empty — manually strip frontmatter from rawContent
  // indexOf-based to prevent ReDoS (replaces the regex [\s\S]*?)
  const raw = doc.rawContent ?? ''
  if (raw.startsWith('---')) {
    const closeIdx = raw.indexOf('\n---', 3)
    if (closeIdx >= 0) return cleanWikiLinks(raw.slice(closeIdx + 4).trim())
  }
  return cleanWikiLinks(raw.trim())
}

/**
 * B. Passage-level content selection.
 *
 * When queryTerms is provided, selects the section matching the most query tokens.
 * Without queryTerms, returns the full getStrippedBody() from the beginning.
 *
 * The frontmatter YAML is excluded in every case.
 */
function getDocContent(
  doc: LoadedDocument,
  budget: number,
  queryTerms?: string[]
): string {
  // No queryTerms → leading part of the body with frontmatter removed
  if (!queryTerms || queryTerms.length === 0) {
    const body = getStrippedBody(doc)
    return body.length > budget ? body.slice(0, budget).trimEnd() + '…' : body
  }

  // Passage-level: select the section matching the most query tokens
  // The intro section body includes the H1 title (e.g. "# 방열 시스템"), so when the filename overlaps
  // the query, a short intro can outscore a long H2 section.
  // To prevent this, strip the leading markdown heading from the intro section body before scoring.
  let bestSection: DocSection | null = null
  let bestScore = -1

  for (const section of doc.sections) {
    if (!section.body.trim()) continue
    // Score after stripping the leading H1 title from the intro section body (prevents filename inflation)
    const bodyForScore = section.heading === '(intro)'
      ? section.body.replace(/^#[^\n]*\n?/, '').trim()
      : section.body
    const text = `${headingForScore(section.heading)} ${bodyForScore}`.toLowerCase()
    let score = 0
    for (const term of queryTerms) {
      if (text.includes(term)) score++
    }
    if (score > bestScore) {
      bestScore = score
      bestSection = section
    }
  }

  // Use the full body if no section matched or the selected section is too short
  const fullBody = getStrippedBody(doc)
  if (!bestSection || bestScore <= 0) {
    return fullBody.length > budget ? fullBody.slice(0, budget).trimEnd() + '…' : fullBody
  }

  const h = bestSection.heading && bestSection.heading !== '(intro)' ? `### ${bestSection.heading}\n` : ''
  const passageText = h + bestSection.body

  // Use the full body if the selected passage is too short and the full body has far more content
  // (e.g. prevents discarding the real content sections when a short intro section was selected)
  if (passageText.length < 200 && fullBody.length > passageText.length * 3) {
    return fullBody.length > budget ? fullBody.slice(0, budget).trimEnd() + '…' : fullBody
  }

  return passageText.length > budget
    ? passageText.slice(0, budget).trimEnd() + '…'
    : passageText
}


/**
 * BFS traversal from starting document IDs.
 * Returns a map of docId → minimum hop distance from any starting node.
 * Phantom nodes (no rawContent) are visited but not included in output.
 */
function bfsFromDocIds(
  startDocIds: string[],
  adjacency: Map<string, string[]>,
  maxHops: number,
  maxDocs: number
): Map<string, number> {
  const visited = new Map<string, number>()
  const queue: [string, number][] = []

  for (const id of startDocIds) {
    if (!visited.has(id)) {
      visited.set(id, 0)
      queue.push([id, 0])
    }
  }

  let queueIdx = 0
  while (queueIdx < queue.length && visited.size < maxDocs) {
    const [docId, hop] = queue[queueIdx++]
    if (hop >= maxHops) continue
    for (const neighborId of adjacency.get(docId) ?? []) {
      if (!visited.has(neighborId) && visited.size < maxDocs) {
        visited.set(neighborId, hop + 1)
        queue.push([neighborId, hop + 1])
      }
    }
  }
  return visited
}

/**
 * Total context budget (chars).
 * 16000 chars ≈ ~4800 tokens — plenty of headroom against Claude's 200k context.
 * Tuning guide: increase if coverage matters more than response quality,
 * decrease if cost/speed is the priority.
 */
const DEEP_CONTEXT_BUDGET = 16_000

/** Max content length per document by hop distance (chars) */
const HOP_CHAR_BUDGET = [1_500, 900, 500, 250] as const

/**
 * Collects related document context via Personalized PageRank graph traversal.
 *
 * Uses the search results as **score-weighted seeds** to run strength-weighted PPR, then
 * fuses normalized search score 0.6 + normalized PPR 0.4 for the final ranking and selects maxDocs.
 * (Sorting by PPR alone let `_index.md` and year hubs push the seeds out.)
 * Unlike BFS, it automatically captures strongly connected hub documents with no hop limit.
 *
 * Use cases: queries that need information gathered across many documents,
 * e.g. "insights related to this topic", "give me feedback on the project".
 *
 * @param maxHops    unused (kept for API compatibility — PPR has no notion of hops)
 */
export async function buildDeepGraphContext(
  results: SearchResult[],
  maxHops: number = 2,
  maxDocs: number = 14,
  queryTerms?: string[],
  currentSpeaker?: string,
): Promise<string> {
  const { links } = useGraphStore.getState()
  const { loadedDocuments } = useVaultStore.getState()
  if (!loadedDocuments?.length) {
    logger.warn('[RAG] No loadedDocuments — vault is not loaded')
    return ''
  }

  const { adjacency, docMap, getMetrics } = getCachedMaps(links, loadedDocuments)

  // Vault without WikiLinks — graph traversal impossible, format TF-IDF results directly
  if (!links.length) {
    if (results.length === 0) return ''
    const parts: string[] = ['## Related Documents (Direct Search)\n']
    let charCount = 20
    for (const r of results.slice(0, maxDocs)) {
      const doc = docMap.get(r.doc_id)
      if (!doc) continue
      const name = doc.filename.replace(/\.md$/i, '')
      const content = getDocContent(doc, 1200, queryTerms)
      if (!content) continue
      const entry = `[Document] ${name}\n${content}\n\n`
      if (charCount + entry.length > DEEP_CONTEXT_BUDGET) break
      parts.push(entry)
      charCount += entry.length
    }
    return parts.length <= 1 ? '' : parts.join('') + '\n'
  }

  // Start nodes: top search-result documents — **preserve the search score as seed weight**.
  // (The old code put only doc_id into a Set and discarded the score, and the worker used uniform 1/N seeds,
  //  so the top vector-search document, the 20th supplementary directHit and `_index.md` (lowered to 0.15) all became equal.)
  const _seedScores = new Map<string, number>()
  for (const r of results) {
    if (!r.doc_id) continue
    const prev = _seedScores.get(r.doc_id) ?? 0
    if (r.score > prev) _seedScores.set(r.doc_id, r.score)
  }

  // If keyword matching is sparse, automatically add hub nodes as supplementary seeds (low weight)
  if (_seedScores.size < 2) {
    const hubIds = getHubDocIds(adjacency, 5)
    for (const id of hubIds) {
      if (!_seedScores.has(id)) _seedScores.set(id, 0.05)
      if (_seedScores.size >= 6) break
    }
  }

  if (_seedScores.size === 0) return ''

  const seedSet = new Set(_seedScores.keys())
  // Apply a floor (0.01) so weight-0 seeds do not vanish entirely from the personalization vector
  const seeds = [..._seedScores].map(([id, w]) => ({ id, weight: Math.max(0.01, w) }))

  // Run PPR — computed asynchronously in a Web Worker (no main-thread blocking)
  const pprScores = await runPPRInWorker(seeds, links)

  // ── Final ranking = search score ⊕ PPR fusion ─────────────────────────────
  // Sorting by PPR alone lets nodes with many in-edges (like `_index.md` and year hubs)
  // push the seeds out and take the top-N. Fuse at 0.6:0.4 after normalization.
  // status: outdated/deprecated documents get a 70% score decay (addresses recency bug §18.1)
  let maxSearch = 0
  for (const s of _seedScores.values()) if (s > maxSearch) maxSearch = s
  let maxPPR = 0
  for (const s of pprScores.values()) if (s > maxPPR) maxPPR = s

  const SEARCH_W = 0.6
  const PPR_W = 0.4

  const _pprEntries: [string, number][] = []
  for (const [id, score] of pprScores) {
    const searchScore = _seedScores.get(id) ?? 0
    if (score <= 0 && searchScore <= 0) continue
    const doc = docMap.get(id)
    // phantom/gallery nodes have no body and are skipped in the render loop below anyway.
    // Filtering here avoids wasting maxDocs slots.
    if (!doc) continue
    // graph_weight: skip → fully excluded from BFS traversal (link-only hubs, 500+ outbound)
    // Seed documents are exempt from the filter — the user explicitly searched for them
    if (!seedSet.has(id) && doc.graphWeight === 'skip') continue
    const decay = (!seedSet.has(id) && isOutdatedDoc(doc)) ? 0.3 : 1.0
    // graph_weight: low → link weight decayed to 0.3 (100-499 outbound links)
    const weightDecay = doc.graphWeight === 'low' ? 0.15 : 1.0  // stronger low decay (0.3→0.15)
    // Speaker affinity boost: doc.speaker matches current persona → +10%
    const speakerBoost = (currentSpeaker && currentSpeaker !== 'unknown' && doc.speaker === currentSpeaker) ? 1.1 : 1.0

    const normSearch = maxSearch > 0 ? searchScore / maxSearch : 0
    const normPPR = maxPPR > 0 ? score / maxPPR : 0
    const fused = SEARCH_W * normSearch + PPR_W * normPPR
    if (fused <= 0) continue
    _pprEntries.push([id, fused * decay * weightDecay * speakerBoost])
  }
  _pprEntries.sort((a, b) => b[1] - a[1])
  const sorted = _pprEntries.slice(0, maxDocs)

  if (sorted.length === 0) return ''

  // visited Map for buildStructureHeader compatibility (seed=0, others=1)
  const visited = new Map<string, number>(
    sorted.map(([id]) => [id, seedSet.has(id) ? 0 : 1])
  )

  // Yield to the UI before PageRank + cluster computation
  await new Promise<void>(r => setTimeout(r, 0))

  // Structure header (PageRank + cluster overview)
  const structureHeader = await buildStructureHeader(visited, adjacency, links, loadedDocuments, docMap, getMetrics)

  // Labels and char budgets by PPR rank
  // Top 3: Core (1500 chars), 4-8: Related (900 chars), 9+: Peripheral (500 chars)
  const parts: string[] = [structureHeader, '## Related Documents (PPR Traversal)\n']
  let charCount = structureHeader.length + 20
  let docHits = 0

  sorted.forEach(([docId, fusedScore], rank) => {
    if (charCount >= DEEP_CONTEXT_BUDGET) return

    const doc = docMap.get(docId)
    if (!doc) return  // phantom node — skip

    // Adaptive budget: allocate more budget to large documents (10K+ chars), up to 2x
    const docLen = doc.rawContent?.length ?? 0
    const baseBudget = rank < 3 ? 1_500 : rank < 8 ? 900 : 500
    const budget = docLen > 10_000
      ? Math.min(baseBudget * 2, Math.max(baseBudget, Math.floor(docLen * 0.03)))
      : baseBudget
    const label = seedSet.has(docId) ? 'Core' : rank < 3 ? 'Core' : rank < 8 ? 'Related' : 'Peripheral'
    const name = doc.filename.replace(/\.md$/i, '')
    const speaker = doc.speaker && doc.speaker !== 'unknown' ? ` (${doc.speaker})` : ''
    const dateLabel = getDocDateLabel(doc)
    const sourceLabel = doc.source ? ` [source: ${doc.source}]` : ''
    const typeLabel = doc.type ? ` [${doc.type}]` : ''
    // Show the fused score (search 0.6 + PPR 0.4) on a 0-100 scale
    const scorePct = Math.round(fusedScore * 1000) / 10
    const outdatedLabel = (doc.status === 'outdated' || doc.status === 'deprecated')
      ? ` ⚠️outdated${doc.supersededBy ? `→${doc.supersededBy}` : ''}`
      : ''
    const header = `[${label}|Score ${scorePct}]${outdatedLabel}${typeLabel} ${name}${speaker}${dateLabel ? ` [${dateLabel}]` : ''}${sourceLabel}`

    const content = getDocContent(doc, budget, queryTerms)
    const entry = `${header}\n${content}\n\n`
    if (charCount + entry.length > DEEP_CONTEXT_BUDGET) return

    parts.push(entry)
    charCount += entry.length
    docHits++
  })

  logger.debug(`[RAG] PPR complete: candidates=${sorted.length}, content included=${docHits}, total ${charCount} chars`)

  // Fall back to directly formatted TF-IDF results if no document content was included at all
  if (docHits === 0) {
    if (results.length === 0) return ''
    const fallback: string[] = ['## Related Documents (Direct Search)\n']
    let fallbackChars = 20
    for (const r of results.slice(0, maxDocs)) {
      const doc = docMap.get(r.doc_id)
      if (!doc) continue
      const content = getDocContent(doc, 1200, queryTerms)
      if (!content) continue
      const entry = `[Direct] ${doc.filename.replace(/\.md$/i, '')}\n${content}\n\n`
      if (fallbackChars + entry.length > DEEP_CONTEXT_BUDGET) break
      fallback.push(entry)
      fallbackChars += entry.length
    }
    return fallback.length <= 1 ? '' : fallback.join('') + '\n'
  }

  return parts.join('') + '\n'
}

/**
 * Collects related context by BFS-traversing the graph from a specific document ID.
 *
 * Same as buildDeepGraphContext but bypasses keyword search entirely.
 * Use this when the user selects a node directly in the graph.
 *
 * @param startDocId  starting document ID (graphStore.selectedNodeId)
 * @param maxHops     maximum hops to traverse (default 3)
 * @param maxDocs     maximum documents to collect (default 20)
 */
export async function buildDeepGraphContextFromDocId(
  startDocId: string,
  maxHops: number = 3,
  maxDocs: number = 20
): Promise<string> {
  const { links } = useGraphStore.getState()
  const { loadedDocuments } = useVaultStore.getState()
  if (!loadedDocuments?.length || !links.length) return ''

  const { adjacency, docMap, getMetrics } = getCachedMaps(links, loadedDocuments)

  const visited = bfsFromDocIds([startDocId], adjacency, maxHops, maxDocs)
  if (visited.size === 0) return ''

  await new Promise<void>(r => setTimeout(r, 0))
  const structureHeader = await buildStructureHeader(visited, adjacency, links, loadedDocuments, docMap, getMetrics)

  const recMap2 = new Map<string, number>()
  for (const id of visited.keys()) { const d = docMap.get(id); recMap2.set(id, d ? getContentDate(d) : 0) }
  const sorted = [...visited.entries()].sort((a, b) =>
    a[1] !== b[1] ? a[1] - b[1] : (recMap2.get(b[0]) ?? 0) - (recMap2.get(a[0]) ?? 0)
  )
  const hopLabel = ['Selected', '1-hop', '2-hop', '3-hop']
  const parts: string[] = [structureHeader, '## Selected Node Related Documents (Graph Traversal)\n']
  let charCount = structureHeader.length + 25

  for (const [docId, hop] of sorted) {
    if (charCount >= DEEP_CONTEXT_BUDGET) break
    const doc = docMap.get(docId)
    if (!doc) continue

    const budget = HOP_CHAR_BUDGET[hop] ?? 80
    const label = hopLabel[hop] ?? `${hop}-hop`
    const name = doc.filename.replace(/\.md$/i, '')
    const speaker = doc.speaker && doc.speaker !== 'unknown' ? ` (${doc.speaker})` : ''
    const dateLabel = getDocDateLabel(doc)
    const sourceLabel = doc.source ? ` [source: ${doc.source}]` : ''
    const header = `[${label}] ${name}${speaker}${dateLabel ? ` [${dateLabel}]` : ''}${sourceLabel}`
    const content = getDocContent(doc, budget)
    const entry = `${header}\n${content}\n\n`
    if (charCount + entry.length > DEEP_CONTEXT_BUDGET) break
    parts.push(entry)
    charCount += entry.length
  }

  if (parts.length <= 1) return ''
  return parts.join('') + '\n'
}

// ── 3a-helper. Structure header generation ───────────────────────────────────

/**
 * Generates an AI context header from the structural information of the explored documents.
 *
 * Includes:
 *  - Top PageRank hub documents
 *  - C. TF-IDF topic keyword labels per cluster
 *  - D. Bridge documents connecting multiple clusters
 *  - A. Hidden semantically connected document pairs without WikiLinks
 */
async function buildStructureHeader(
  visited: Map<string, number>,
  adjacency: Map<string, string[]>,
  links: GraphLink[],
  loadedDocuments: LoadedDocument[],
  docMap: Map<string, LoadedDocument>,
  getMetrics: () => ReturnType<typeof getGraphMetrics>
): Promise<string> {
  const metrics = getMetrics()  // cached — no recomputation if adjacency/links unchanged
  const { pageRank, clusters, clusterCount } = metrics

  // Top 5 by PageRank (explored documents only)
  const topDocs = [...visited.keys()]
    .map(id => ({ id, rank: pageRank.get(id) ?? 0 }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 5)
    .map(({ id }) => docMap.get(id)?.filename.replace(/\.md$/i, '') ?? id)

  // C. Document groups per cluster + TF-IDF topic keyword labels (costly on cache miss — yield to UI)
  await new Promise<void>(r => setTimeout(r, 0))
  const clusterTopics = getClusterTopics(clusters, loadedDocuments, 3)
  const clusterGroups = new Map<number, string[]>()
  for (const [docId] of visited) {
    const cId = clusters.get(docId)
    if (cId === undefined) continue
    if (!clusterGroups.has(cId)) clusterGroups.set(cId, [])
    const name = docMap.get(docId)?.filename.replace(/\.md$/i, '') ?? docId
    clusterGroups.get(cId)!.push(name)
  }
  const clusterLines = [...clusterGroups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 4)
    .map(([cId, names]) => {
      const topics = clusterTopics.get(cId) ?? []
      const topicLabel = topics.length > 0 ? ` [${topics.join('/')}]` : ''
      return `  • Cluster ${cId + 1}${topicLabel} (${names.length}): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''}`
    })
    .join('\n')

  // D. Bridge node detection (explored documents only, top 3)
  const visitedAdj = new Map<string, string[]>()
  for (const [docId] of visited) {
    visitedAdj.set(docId, adjacency.get(docId) ?? [])
  }
  const bridges = detectBridgeNodes(visitedAdj, clusters)
    .slice(0, 3)
    .map(b => {
      const name = docMap.get(b.docId)?.filename.replace(/\.md$/i, '') ?? b.docId
      return `${name}(${b.clusterCount} clusters connected)`
    })

  // A. Implicit link discovery (semantically similar pairs without WikiLinks, top 4) — costly on cache miss, yield to UI
  await new Promise<void>(r => setTimeout(r, 0))
  const implicitLinks = tfidfIndex.findImplicitLinks(adjacency, 4, 0.25)
    .map(l => {
      const a = l.filenameA.replace(/\.md$/i, '')
      const b = l.filenameB.replace(/\.md$/i, '')
      const pct = Math.round(l.similarity * 100)
      return `  • "${a}" ↔ "${b}" (similarity ${pct}%)`
    })

  const lines: string[] = [
    `## Project Structure Overview`,
    `Total clusters: ${clusterCount} | Explored documents: ${visited.size}`,
    `Key hub documents (top PageRank): ${topDocs.join(', ')}`,
  ]

  if (clusterLines) {
    lines.push(`\nCluster topic groups:`)
    lines.push(clusterLines)
  }

  if (bridges.length > 0) {
    lines.push(`\nKey bridge documents (multi-cluster connection): ${bridges.join(', ')}`)
  }

  if (implicitLinks.length > 0) {
    lines.push(`\nHidden semantic connections (no WikiLink):`)
    lines.push(implicitLinks.join('\n'))
  }

  lines.push('')
  return lines.join('\n') + '\n'
}

// ── 3a-extra. BFS node ID helpers (for graph highlight) ──────────────────────

/** Shared setup: read stores + build adjacency. Returns null when no data. */
function getAdjacency(): Map<string, string[]> | null {
  const { links } = useGraphStore.getState()
  const { loadedDocuments } = useVaultStore.getState()
  if (!loadedDocuments?.length || !links.length) return null
  return getCachedMaps(links, loadedDocuments).adjacency
}

/**
 * Returns the doc IDs visited by BFS from a given starting document.
 * Used to highlight nodes in the graph while AI is analyzing.
 */
export function getBfsContextDocIds(
  startDocId: string,
  maxHops: number = 3,
  maxDocs: number = 20
): string[] {
  const adjacency = getAdjacency()
  if (!adjacency) return [startDocId]
  return [...bfsFromDocIds([startDocId], adjacency, maxHops, maxDocs).keys()]
}

/**
 * Returns the doc IDs visited by the hub-seeded global BFS traversal.
 * Used to highlight nodes in the graph during a full-project AI analysis.
 */
export function getGlobalContextDocIds(
  maxDocs: number = 35,
  maxHops: number = 4
): string[] {
  const adjacency = getAdjacency()
  if (!adjacency) return []
  const hubIds = getHubDocIds(adjacency, 8)
  if (hubIds.length === 0) return []
  return [...bfsFromDocIds(hubIds, adjacency, maxHops, maxDocs).keys()]
}

// ── 3b. Hub-seeded global graph context ──────────────────────────────────────

/**
 * Returns the top N hub document IDs by degree (connectivity).
 * Hub nodes connect to many documents, making them good starting points for global traversal.
 */
function getHubDocIds(adjacency: Map<string, string[]>, topN: number = 10): string[] {
  return [...adjacency.entries()]
    .filter(([, neighbors]) => neighbors.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, topN)
    .map(([id]) => id)
}

/**
 * Collects context by BFS-traversing the whole graph starting from hub nodes.
 *
 * Used for broad queries like "overall project insights" or "general feedback",
 * or when the AI analysis button is pressed without a node selected.
 *
 * @param maxDocs   maximum documents to collect (default 35)
 * @param maxHops   maximum BFS hops (default 4)
 */
export async function buildGlobalGraphContext(
  maxDocs: number = 35,
  maxHops: number = 4
): Promise<string> {
  const { links } = useGraphStore.getState()
  const { loadedDocuments } = useVaultStore.getState()
  if (!loadedDocuments?.length || !links.length) return ''

  const { adjacency, docMap, getMetrics } = getCachedMaps(links, loadedDocuments)

  const hubIds = getHubDocIds(adjacency, 8)
  if (hubIds.length === 0) return ''

  const visited = bfsFromDocIds(hubIds, adjacency, maxHops, maxDocs)
  if (visited.size === 0) return ''

  await new Promise<void>(r => setTimeout(r, 0))
  const structureHeader = await buildStructureHeader(visited, adjacency, links, loadedDocuments, docMap, getMetrics)

  const GLOBAL_BUDGET = 24000
  const recMap3 = new Map<string, number>()
  for (const id of visited.keys()) { const d = docMap.get(id); recMap3.set(id, d ? getContentDate(d) : 0) }
  const sorted = [...visited.entries()].sort((a, b) =>
    a[1] !== b[1] ? a[1] - b[1] : (recMap3.get(b[0]) ?? 0) - (recMap3.get(a[0]) ?? 0)
  )
  const parts: string[] = [structureHeader, '## Overall Project Related Documents (Hub-Based Traversal)\n']
  let charCount = structureHeader.length + 28

  for (const [docId, hop] of sorted) {
    if (charCount >= GLOBAL_BUDGET) break
    const doc = docMap.get(docId)
    if (!doc) continue

    const budget = HOP_CHAR_BUDGET[Math.min(hop, HOP_CHAR_BUDGET.length - 1)] ?? 80
    const name = doc.filename.replace(/\.md$/i, '')
    const speaker = doc.speaker && doc.speaker !== 'unknown' ? ` (${doc.speaker})` : ''
    const dateLabel = getDocDateLabel(doc)
    const header = `[Explored] ${name}${speaker}${dateLabel ? ` [${dateLabel}]` : ''}`
    const content = getDocContent(doc, budget)
    const entry = `${header}\n${content}\n\n`
    if (charCount + entry.length > GLOBAL_BUDGET) break
    parts.push(entry)
    charCount += entry.length
  }

  if (parts.length <= 2) return ''
  return parts.join('') + '\n'
}

// ── 3. Compressed context formatting ─────────────────────────────────────────

/**
 * Format search results and neighbor contexts into a compressed,
 * token-efficient context string for LLM injection.
 *
 * Format:
 *   ## Related Documents
 *   [Document] filename > heading (speaker)
 *   content...
 *
 *   ### Connected Documents
 *   [Connected] filename > heading
 *   neighbor content...
 */
/**
 * Max total characters for the context string.
 * ~2000 chars ≈ ~600 tokens — keeps LLM context lean while providing
 * enough reference material for accurate answers.
 */
const CONTEXT_BUDGET = 3000

export function formatCompressedContext(
  results: SearchResult[],
  neighbors: NeighborContext[]
): string {
  if (results.length === 0) return ''

  const parts: string[] = ['## Related Documents\n']
  let charCount = 10 // header length

  for (const r of results) {
    const header = [
      `[Document]`,
      r.filename,
      r.heading ? `> ${r.heading}` : null,
      r.speaker && r.speaker !== 'unknown' ? `(${r.speaker})` : null,
    ]
      .filter(Boolean)
      .join(' ')

    // Truncate content to fit budget
    const maxContent = Math.min(300, CONTEXT_BUDGET - charCount - header.length - 10)
    if (maxContent <= 0) break
    const content = r.content.length > maxContent
      ? r.content.slice(0, maxContent).trimEnd() + '…'
      : r.content

    parts.push(header)
    parts.push(content)
    parts.push('')
    charCount += header.length + content.length + 2
  }

  if (neighbors.length > 0 && charCount < CONTEXT_BUDGET - 100) {
    parts.push('### Connected Documents\n')
    charCount += 12

    for (const n of neighbors) {
      const nHeader = `[Connected] ${n.filename} > ${n.heading}`
      const maxContent = Math.min(200, CONTEXT_BUDGET - charCount - nHeader.length - 10)
      if (maxContent <= 0) break
      const content = n.content.length > maxContent
        ? n.content.slice(0, maxContent).trimEnd() + '…'
        : n.content

      parts.push(nHeader)
      parts.push(content)
      parts.push('')
      charCount += nHeader.length + content.length + 2
    }
  }

  return parts.join('\n') + '\n'
}
