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

// ── Domain → tag affinity map (쿼리 기반 태그 부스트) ────────────────────────

/**
 * 쿼리에서 감지된 도메인 키워드를 frontmatter 태그와 매칭하여 스코어 부스트.
 * 키: 쿼리에서 검출할 도메인 키워드 (lowercase)
 * 값: 해당 도메인과 관련된 태그 목록 (lowercase)
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
 * 쿼리 텍스트에서 DOMAIN_TAG_MAP 키워드를 감지하고,
 * 매칭된 모든 도메인의 관련 태그 집합을 반환.
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
 * graphAnalysis.tokenize 위임 — 한국어 조사 제거 포함.
 * Exported so llmClient.ts can pass query terms to context builders.
 */
export function tokenizeQuery(text: string): string[] {
  return _tokenize(text)
}

// ── Generic heading filter (PPTX/PDF 슬라이드/페이지 헤딩 노이즈 제거) ──────
const GENERIC_HEADING_RE = /^(슬라이드|페이지|slide|page)\s*\d+$/i

/** 검색 스코어링에 기여하지 않는 제너릭 헤딩을 빈 문자열로 치환 */
function headingForScore(heading: string): string {
  return GENERIC_HEADING_RE.test(heading.trim()) ? '' : heading
}

// ── Archive / outdated detection ─────────────────────────────────────────────

const ARCHIVE_PATH_RE = /(?:^|[\\/])\.?archive[\\/]/i

/** 문서가 아카이브 또는 outdated/deprecated 상태인지 판별 */
function isOutdatedDoc(doc: { status?: string; folderPath?: string; absolutePath?: string } | undefined): boolean {
  if (!doc) return false
  if (doc.status === 'outdated' || doc.status === 'deprecated') return true
  const path = (doc.folderPath ?? (doc as any).absolutePath ?? '')
  return ARCHIVE_PATH_RE.test(path)
}

// ── Status weighting (문서 생명주기 ≠ Jira 워크플로) ─────────────────────────

/**
 * frontmatter `status:` 필드에는 두 종류의 값이 섞여 있습니다.
 *  - 문서 생명주기: active(71.1%) / outdated(1.7%) / deprecated
 *  - Jira 워크플로: 할 일 / in dev / check issue / 닫힘 / 해결됨
 *
 * `active` 는 볼트의 71%에 해당하므로 부스트를 주면 사실상 나머지 29%
 * (status 없는 278개 + Jira 상태 439개)에 대한 패널티로 동작합니다.
 * 따라서 `active` 는 중립(0)으로 두고, Jira 워크플로만 소폭 가중합니다.
 * outdated/deprecated 패널티는 isOutdatedDoc()에서 별도로 유지됩니다.
 */
const JIRA_OPEN_STATUS = new Set([
  'in dev', 'in progress', 'in-progress', 'check issue',
  '할 일', 'to do', 'todo', 'open', 'reopened', '진행중', '진행 중',
])
const JIRA_CLOSED_STATUS = new Set([
  '닫힘', 'closed', 'done', '완료', '해결됨', 'resolved', 'wontfix', "won't do",
])

/** status 문자열 → 스코어 배수 가산치 (부스트/패널티). active·미지정은 0. */
function statusBoostFor(status: string | undefined): number {
  if (!status) return 0
  const s = status.toLowerCase().trim()
  if (JIRA_OPEN_STATUS.has(s)) return 0.05    // 진행 중 이슈 = 가장 최신 정보
  if (JIRA_CLOSED_STATUS.has(s)) return -0.05 // 종료된 이슈 = 상대적으로 오래됨
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

// ── 0. Frontend search (TF-IDF 우선, 키워드 폴백) ──────────────────────────

/**
 * 볼트 문서를 검색합니다.
 *
 * 파이프라인:
 *   1. TF-IDF 코사인 유사도 검색 (tfidfIndex가 빌드된 경우)
 *      — 의미적으로 가까운 문서를 찾아 제목 미스매치 문제 해결
 *   2. TF-IDF 결과가 없으면 키워드 기반 폴백 검색
 *
 * @param query  사용자 쿼리
 * @param topN   반환할 최대 결과 수
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

  // ── 히스토리 맥락 키워드 준비 (0.3 가중치 부스트) ──────────────────────────
  const ctxTerms = contextTerms?.filter(t => t.length >= 2).slice(0, 6) ?? []
  const CTX_WEIGHT = 0.3

  // ── TF-IDF 우선 검색 ──────────────────────────────────────────────────────
  if (tfidfIndex.isBuilt) {
    const tfidfHits = tfidfIndex.search(query, topN * 2)  // over-fetch for tag re-sort
    if (tfidfHits.length > 0) {
      const queryStems = tokenizeQuery(query)  // 공유 — map 내부에서 반복 계산하지 않음
      const results = tfidfHits.map(hit => {
        const doc = docMap.get(hit.docId)
        // 문서 내에서 쿼리와 가장 잘 매칭되는 섹션 선택
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
        // Domain tag boost: 쿼리 도메인 매칭 태그 +15~20%
        let domainBoost = 0
        if (domainTags.size > 0 && tagsLower.length > 0) {
          const matchCount = tagsLower.filter(t => domainTags.has(t)).length
          domainBoost = Math.min(0.20, matchCount * 0.10)
        }
        // Status: active(71%) 부스트 제거 — Jira 진행중 +5% / 종료 -5% 만 소폭 가중
        const statusBoost = statusBoostFor(doc?.status)
        // outdated/deprecated/archive 문서 패널티
        const outdatedPenalty = isOutdatedDoc(doc) ? -0.25 : 0
        // 히스토리 맥락 키워드 부스트
        let ctxBoost = 0
        if (ctxTerms.length > 0 && doc) {
          const raw = (doc.rawContent ?? '').toLowerCase()
          let ctxHits = 0
          for (const t of ctxTerms) { if (raw.includes(t)) ctxHits++ }
          ctxBoost = (ctxHits / ctxTerms.length) * CTX_WEIGHT
        }
        const scoreMultiplier = 1 + (hasPersonaTag ? TAG_BOOST : 0) + domainBoost + statusBoost
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

  // ── 키워드 폴백 검색 (TF-IDF 인덱스 미빌드 시) ───────────────────────────
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

      // 히스토리 맥락 키워드 부스트 (폴백 경로)
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
      // Status: active 부스트 제거 — Jira 진행중/종료만 소폭 가중
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
 * 볼트 전체 문서를 쿼리 단어로 직접 문자열 검색합니다.
 *
 * TF-IDF/BFS로 찾지 못한 문서를 보완하는 단순 폴백.
 * 파일명 매칭은 가중치 2배, 본문 매칭은 1배.
 */
/**
 * 토큰 포함 여부 — 숫자 토큰만 경계를 따진다.
 *
 * 파일명 매칭이 순수 부분문자열이라 쿼리 "SGEATF-160" 의 토큰 "160" 이
 * "SGEATF-12160" 에 걸려 무관한 Jira 티켓이 파일명 만점을 받았다.
 * 한글·영문은 어절 경계가 불분명하므로 기존 부분문자열 매칭을 유지한다.
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

  // 토크나이저로 조사·구두점 제거 (한국어 조사 제거 포함, "이사장님의" → "이사장님")
  const tokenized = expandTerms(_tokenize(query))
  // 2자리 이상 숫자 보완: 날짜형 파일명 "[2026.01.28]"의 컴포넌트와 확실히 매칭되도록
  const numericTerms = query.match(/\d{2,}/g) ?? []
  const terms = [...new Set([...tokenized, ...numericTerms])]
  if (terms.length === 0) return []

  // 히스토리 맥락 키워드 (중복 제거, 기존 terms에 없는 것만)
  const ctxTerms = contextTerms
    ? contextTerms.filter(t => !terms.includes(t)).slice(0, 6)
    : []
  const CTX_WEIGHT = 0.3

  const scored: { doc: LoadedDocument; score: number; bestSection: DocSection | null }[] = []
  const now = Date.now()

  for (const doc of loadedDocuments) {
    const filename = doc.filename.toLowerCase()
    // 7-9: rawContent/섹션 소문자 텍스트를 mtime 키 캐시에서 조회
    // (편집 후 mtime이 바뀌면 자동 재계산 — 옛 본문 반환 버그 방지)
    const lower = getLowerEntry(doc)
    const raw = lower.raw

    // 쿼리 단어별 매칭 카운트 (가중치 없이 순수 커버리지)
    let filenameHits = 0
    let bodyHits = 0
    for (const term of terms) {
      if (containsTerm(filename, term)) filenameHits++
      if (containsTerm(raw, term)) bodyHits++
    }

    // 히스토리 맥락 키워드 매칭 (낮은 가중치)
    let ctxFilenameHits = 0
    let ctxBodyHits = 0
    for (const term of ctxTerms) {
      if (containsTerm(filename, term)) ctxFilenameHits++
      if (containsTerm(raw, term)) ctxBodyHits++
    }

    if (filenameHits === 0 && bodyHits === 0 && ctxFilenameHits === 0 && ctxBodyHits === 0) continue

    // 커버리지 기반 점수: 파일명 60%, 본문 40% — 쿼리 단어 커버리지 비율
    const n = terms.length
    let score = (filenameHits / n) * 0.6 + (bodyHits / n) * 0.4

    // 히스토리 맥락 키워드 가산 (0.3 가중치)
    if (ctxTerms.length > 0) {
      const ctxScore = (ctxFilenameHits / ctxTerms.length) * 0.6 + (ctxBodyHits / ctxTerms.length) * 0.4
      score += ctxScore * CTX_WEIGHT
    }

    // 파일명 매칭 부스트: 0.3~1.0 범위로 스케일업 (1개 매치만으론 핀 고정 안 됨)
    if (filenameHits > 0) {
      score = 0.3 + score * 0.7  // 0-1 → 0.3-1.0
    }

    // 쿼리 단어와 가장 많이 겹치는 섹션 선택
    // 7-9: 섹션 소문자 텍스트도 캐시에서 조회 — 실측 91ms 중 26ms를 차지하던 concat+toLowerCase 제거
    let bestSection: DocSection | null = null
    let bestSectionScore = -1
    const sectionTexts = lower.sectionTexts
    for (let si = 0; si < doc.sections.length; si++) {
      const text = sectionTexts[si]
      if (!text) continue  // 빈 본문 섹션은 '' 로 캐시됨
      let sScore = 0
      for (const t of terms) { if (text.includes(t)) sScore++ }
      if (sScore > bestSectionScore) {
        bestSectionScore = sScore
        bestSection = doc.sections[si]
      }
    }

    scored.push({ doc, score, bestSection })
  }

  // 커버리지 점수 기반 정렬 (파일명 절대 우선 제거)
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
    score,  // 이미 0-1 범위 (커버리지 비율)
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
 * 7-9: 소문자 변환 캐시 — 매 검색마다 볼트 전체를 toLowerCase() 하는 비용 제거.
 *
 * docId → { key, raw, sectionTexts }
 *  - key: `${doc.id}:${doc.mtime}` — mtime이 바뀌면(=문서 저장) 자동 재계산
 *  - raw: rawContent.toLowerCase()
 *  - sectionTexts: doc.sections와 인덱스 정렬된 `헤딩 본문` 소문자 텍스트
 *
 * 크기 상한(LOWER_CACHE_MAX_CHARS)을 두어 무제한 증가를 막습니다.
 * 상한 초과 시에는 "더 이상 넣지 않음" 정책 — 순차 스캔에서 FIFO 축출이
 * 매번 캐시를 갈아엎는 thrash를 유발하기 때문입니다.
 */
interface LowerEntry {
  key: string
  raw: string
  sectionTexts: string[]
  chars: number
}
const _lowerCache = new Map<string, LowerEntry>()
/**
 * 소문자 캐시 총 문자 수 상한 (UTF-16 기준 ≈48MB).
 * 실측 볼트(2,635문서)는 rawContent 11.5M + 섹션텍스트 10.8M = 22.4M chars 로 전량 수용된다.
 * 더 큰 볼트에서는 상한 도달 후 신규 삽입만 중단(축출 없음) — 순차 스캔에서
 * FIFO 축출은 매 호출마다 캐시를 갈아엎는 thrash를 유발하기 때문.
 */
const LOWER_CACHE_MAX_CHARS = 24_000_000
let _lowerCacheChars = 0

function lowerCacheKey(doc: LoadedDocument): string {
  return `${doc.id}:${doc.mtime ?? 0}:${doc.rawContent?.length ?? 0}`
}

/** 문서의 소문자 캐시 엔트리를 반환 (mtime이 바뀌었으면 재계산) */
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
    // 같은 문서의 낡은 엔트리 교체 — mtime 기반 제거
    _lowerCacheChars -= hit.chars
    _lowerCache.delete(doc.id)
  }
  if (_lowerCacheChars + chars <= LOWER_CACHE_MAX_CHARS) {
    _lowerCache.set(doc.id, entry)
    _lowerCacheChars += chars
  }
  return entry
}

/** 소문자 캐시 전체 비우기 */
function clearLowerCache(): void {
  _lowerCache.clear()
  _lowerCacheChars = 0
}

/**
 * 링크 배열 fingerprint — 길이 + 등간격 `source→target` 샘플.
 *
 * GraphLink에는 `id` 필드가 없으므로(=`src/types/index.ts`) 예전 arrayKey()는
 * 항상 `"N:::::::"` 를 반환해 **링크 개수만** 지문이 되었습니다.
 * 개수가 같고 내용만 바뀐 그래프는 절대 무효화되지 않았습니다.
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
 * 문서 배열 fingerprint — 전체 문서의 id·mtime·본문 길이를 32bit 롤링 해시로 축약.
 *
 * 샘플링이 아니라 전수 순회하는 이유: 편집된 문서가 샘플 위치에 없으면
 * 지문이 그대로라 `_cachedDocMap`이 **편집 전 문서 객체를 계속 반환**하고,
 * 그 결과 LLM에 넘어가는 RAG 컨텍스트 전체가 편집 이전 본문이 됩니다.
 * 2,635문서 기준 순회 비용은 1ms 미만입니다.
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
 * graphRAG 내부 캐시(adjacency/sectionMap/docMap/metrics/소문자)를 강제 무효화합니다.
 * 볼트 전환·문서 갱신 직후 호출하세요.
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
    // 볼트 전환 등으로 사라진 문서의 소문자 캐시 회수 (개별 엔트리는 mtime 키로 자가 무효화)
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
  // 목적은 "개수 자르기"가 아니라 "순서 정하기"다.
  // `results.length <= topN` 로 조기 반환하면 후보가 rerankSeeds(기본 5) 이하일 때
  // speaker/persona/domain/type/status 부스트와 outdated 패널티가 전부 스킵된다.
  if (results.length <= 1) return results

  // Tokenize query with Korean particle stripping
  const queryStems = new Set(tokenizeQuery(query))

  if (queryStems.size === 0) return results.slice(0, topN)

  // 7-11: getCachedMaps()의 docMap 캐시를 재사용하여 매 호출마다 Map 재생성 방지
  const { links } = useGraphStore.getState()
  const { loadedDocuments: _docs } = useVaultStore.getState()
  const _docMap = _docs?.length && links?.length
    ? getCachedMaps(links, _docs).docMap
    : _docs ? new Map(_docs.map(d => [d.id, d])) : new Map<string, LoadedDocument>()
  const { rerankVectorWeight, rerankKeywordWeight } = useSettingsStore.getState().searchConfig

  // Domain tag detection: 쿼리에서 도메인 키워드 감지 → 관련 태그 집합
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

    // Domain tag boost: 쿼리 도메인과 문서 태그 매칭 시 +15~20%
    const docTags = r.tags?.map(t => t.toLowerCase()) ?? []
    const doc = _docMap.get(r.doc_id)
    let domainTagBoost = 0
    if (domainTags.size > 0 && docTags.length > 0) {
      const matchCount = docTags.filter(t => domainTags.has(t)).length
      // 매칭 태그 1개당 +10%, 최대 +20%
      domainTagBoost = Math.min(0.20, matchCount * 0.10)
    }

    // Document type boost: type 필드가 있으면 약간의 가산 (spec/guide 우선)
    const docType = doc?.type?.toLowerCase() ?? ''
    const typeBoost = (docType === 'spec' || docType === 'guide' || docType === 'reference') ? 0.05 : 0

    // Status: active(볼트 71%) 부스트 제거 — Jira 진행중 +5% / 종료 -5%
    const statusBoost = statusBoostFor(doc?.status)

    // Outdated/deprecated/archive 패널티 (recency boost는 fetchRAGContext Stage 1에서 이미 처리됨)
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
// 한국어 차수 버전: _2차, _3차
const KO_VERSION_RE = /[_\s](\d+)차(?:\.md)?$/i
// 최종/개정 표기: _최종, _final, _revised, _개정
const FINAL_RE = /[_\s](최종|final|revised|개정)(?:\.md)?$/i

/** 버전 접미사(영문·한국어·최종 표기)를 모두 제거하여 base name을 추출합니다. */
function stripVersionSuffix(filename: string): string {
  return filename
    .replace(VERSION_RE, '')
    .replace(KO_VERSION_RE, '')
    .replace(FINAL_RE, '')
    .replace(/\.md$/i, '')
    .toLowerCase()
    .trim()
}

/** 파일명에서 버전 번호를 추출합니다 (영문 v숫자 또는 한국어 N차). */
function extractVersionNumber(filename: string): number {
  const enMatch = filename.match(VERSION_RE)
  if (enMatch) return parseFloat(enMatch[1])
  const koMatch = filename.match(KO_VERSION_RE)
  if (koMatch) return parseFloat(koMatch[1])
  return 0
}

/** 파일명이 최종/개정 표기를 포함하는지 확인합니다. */
function isFinalVersion(filename: string): boolean {
  return FINAL_RE.test(filename)
}

/**
 * 파일명 버전 접미사(_v2, _v3, _2차, _최종 등)를 파싱하여 동일 문서의 구버전을 제거합니다.
 * 최종/개정 표기 문서를 최우선, 그 다음 버전 번호 높은 순, 동점이면 frontmatter date가 최신인 것을 유지.
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
    // 최종 표기 우선 → 버전 번호 높은 순 → date 최신 순
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
    deduped.push(group[0])  // 최신 버전만 유지
  }
  return deduped
}

// ── 3a. Deep graph traversal (BFS) ───────────────────────────────────────────

/**
 * frontmatter YAML이 제거된 문서 본문 텍스트를 반환합니다.
 *
 * 우선순위:
 *   1. 섹션 조합 (gray-matter가 이미 frontmatter를 제거한 결과물)
 *   2. rawContent에서 수동으로 frontmatter 제거 (섹션이 모두 비어있을 때)
 *
 * rawContent를 그대로 쓰지 않는 이유: rawContent는 YAML frontmatter를 포함하므로
 * AI가 "---\nspeaker: ...\ntags: ..." 등을 실제 내용으로 오독합니다.
 */
/** 위키링크 원문을 표시 텍스트로 변환: [[target|display]] → display, [[target]] → target */
function cleanWikiLinks(text: string): string {
  return text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/\[\[([^\]]+)\]\]/g, '$1')
}

export function getStrippedBody(doc: LoadedDocument): string {
  // 단일 패스 — filter+map 중간 배열 없이 직접 누적
  const parts: string[] = []
  for (const s of doc.sections) {
    if (!s.body.trim()) continue
    const h = s.heading && s.heading !== '(intro)' ? `### ${s.heading}\n` : ''
    parts.push(h + s.body)
  }
  const sectionText = parts.join('\n\n').trim()
  if (sectionText) return cleanWikiLinks(sectionText)

  // 섹션이 모두 비어있는 경우 — rawContent에서 frontmatter 수동 제거
  // indexOf 기반으로 ReDoS 방지 (regex [\s\S]*? 대체)
  const raw = doc.rawContent ?? ''
  if (raw.startsWith('---')) {
    const closeIdx = raw.indexOf('\n---', 3)
    if (closeIdx >= 0) return cleanWikiLinks(raw.slice(closeIdx + 4).trim())
  }
  return cleanWikiLinks(raw.trim())
}

/**
 * B. 패시지-레벨 콘텐츠 선택.
 *
 * queryTerms가 제공되면 쿼리 토큰과 가장 많이 매칭되는 섹션을 선택합니다.
 * queryTerms가 없으면 getStrippedBody() 전체를 앞에서부터 반환합니다.
 *
 * 모든 경우에서 frontmatter YAML은 제외됩니다.
 */
function getDocContent(
  doc: LoadedDocument,
  budget: number,
  queryTerms?: string[]
): string {
  // queryTerms 없음 → frontmatter 제거된 본문 앞부분
  if (!queryTerms || queryTerms.length === 0) {
    const body = getStrippedBody(doc)
    return body.length > budget ? body.slice(0, budget).trimEnd() + '…' : body
  }

  // 패시지-레벨: 쿼리 토큰과 가장 많이 매칭되는 섹션 선택
  // intro 섹션 body에는 H1 제목("# 방열 시스템")이 포함되어 파일명이 쿼리와 겹치면
  // 짧은 intro가 긴 H2 섹션보다 높은 점수를 받는 문제가 있음.
  // 이를 방지하기 위해 intro 섹션 body에서 선두 마크다운 heading을 제거한 뒤 스코어링.
  let bestSection: DocSection | null = null
  let bestScore = -1

  for (const section of doc.sections) {
    if (!section.body.trim()) continue
    // intro 섹션 body의 선두 H1 제목 제거 후 스코어링 (파일명 인플레이션 방지)
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

  // 어떤 섹션에도 매칭 없거나, 선택된 섹션이 너무 짧으면 전체 본문 사용
  const fullBody = getStrippedBody(doc)
  if (!bestSection || bestScore <= 0) {
    return fullBody.length > budget ? fullBody.slice(0, budget).trimEnd() + '…' : fullBody
  }

  const h = bestSection.heading && bestSection.heading !== '(intro)' ? `### ${bestSection.heading}\n` : ''
  const passageText = h + bestSection.body

  // 선택된 패시지가 너무 짧고 전체 본문이 훨씬 더 많은 내용을 가지고 있으면 전체 본문 사용
  // (예: 짧은 intro 섹션이 선택됐을 때 실제 내용 섹션들을 날리는 것 방지)
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
 * 총 컨텍스트 예산 (chars).
 * 16000자 ≈ ~4800 토큰 — Claude 200k 컨텍스트 대비 여유 충분.
 * 조정 가이드: 응답 품질보다 커버리지가 중요하면 늘리고,
 * 비용/속도가 우선이면 줄이세요.
 */
const DEEP_CONTEXT_BUDGET = 16_000

/** 홉 거리별 문서당 최대 내용 길이 (chars) */
const HOP_CHAR_BUDGET = [1_500, 900, 500, 250] as const

/**
 * Personalized PageRank 기반 그래프 탐색으로 관련 문서 컨텍스트 수집.
 *
 * 검색 결과를 **점수 가중 시드**로 삼아 strength 가중 PPR을 실행하고,
 * 최종 랭킹은 정규화 검색 점수 0.6 + 정규화 PPR 0.4 로 융합해 maxDocs개를 선택한다.
 * (PPR 단독 정렬은 `_index.md`·연도 허브가 시드를 밀어내는 문제가 있었다.)
 * BFS와 달리 hop 수 제한 없이 강하게 연결된 허브 문서를 자동으로 캡처합니다.
 *
 * 사용 시나리오: "이 주제와 관련된 인사이트", "프로젝트 피드백 주세요" 등
 * 여러 문서에 걸쳐 정보를 수집해야 하는 쿼리.
 *
 * @param maxHops    미사용 (API 호환성 유지 — PPR은 hop 개념 없음)
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
    logger.warn('[RAG] loadedDocuments 없음 — 볼트가 로드되지 않았습니다')
    return ''
  }

  const { adjacency, docMap, getMetrics } = getCachedMaps(links, loadedDocuments)

  // WikiLink 없는 볼트 — 그래프 탐색 불가, TF-IDF 결과를 직접 포맷
  if (!links.length) {
    if (results.length === 0) return ''
    const parts: string[] = ['## 관련 문서 (직접 검색)\n']
    let charCount = 20
    for (const r of results.slice(0, maxDocs)) {
      const doc = docMap.get(r.doc_id)
      if (!doc) continue
      const name = doc.filename.replace(/\.md$/i, '')
      const content = getDocContent(doc, 1200, queryTerms)
      if (!content) continue
      const entry = `[문서] ${name}\n${content}\n\n`
      if (charCount + entry.length > DEEP_CONTEXT_BUDGET) break
      parts.push(entry)
      charCount += entry.length
    }
    return parts.length <= 1 ? '' : parts.join('') + '\n'
  }

  // 시작 노드: 검색 결과 상위 문서 — **검색 점수를 시드 가중치로 보존**한다.
  // (예전 코드는 Set에 doc_id만 넣어 점수를 버렸고, 워커가 1/N 균등 시드를 써서
  //  벡터 1위 문서와 20번째 보완 directHit, 0.15로 낮춘 `_index.md`가 동일해졌다.)
  const _seedScores = new Map<string, number>()
  for (const r of results) {
    if (!r.doc_id) continue
    const prev = _seedScores.get(r.doc_id) ?? 0
    if (r.score > prev) _seedScores.set(r.doc_id, r.score)
  }

  // 키워드 매칭이 빈약하면 허브 노드를 자동 보완 시드로 추가 (낮은 가중치)
  if (_seedScores.size < 2) {
    const hubIds = getHubDocIds(adjacency, 5)
    for (const id of hubIds) {
      if (!_seedScores.has(id)) _seedScores.set(id, 0.05)
      if (_seedScores.size >= 6) break
    }
  }

  if (_seedScores.size === 0) return ''

  const seedSet = new Set(_seedScores.keys())
  // weight 0 시드가 개인화 벡터에서 완전히 사라지지 않도록 하한(0.01) 적용
  const seeds = [..._seedScores].map(([id, w]) => ({ id, weight: Math.max(0.01, w) }))

  // PPR 실행 — Web Worker에서 비동기 계산 (메인 스레드 블로킹 없음)
  const pprScores = await runPPRInWorker(seeds, links)

  // ── 최종 랭킹 = 검색 점수 ⊕ PPR 융합 ────────────────────────────────────
  // PPR 단독으로 정렬하면 `_index.md`·연도 허브처럼 in-edge가 많은 노드가
  // 시드를 밀어내고 top-N을 차지한다. 정규화 후 0.6:0.4로 융합한다.
  // status: outdated/deprecated 문서는 점수 70% 감쇠 (최신성 버그 §18.1 대응)
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
    // phantom/gallery 노드는 본문이 없어 아래 렌더 루프에서 어차피 스킵된다.
    // 여기서 걸러야 maxDocs 슬롯을 낭비하지 않는다.
    if (!doc) continue
    // graph_weight: skip → BFS 탐색에서 완전 제외 (링크 전용 허브, 500+ outbound)
    // 시드 문서는 필터 제외 — 사용자가 명시적으로 검색한 문서
    if (!seedSet.has(id) && doc.graphWeight === 'skip') continue
    const decay = (!seedSet.has(id) && isOutdatedDoc(doc)) ? 0.3 : 1.0
    // graph_weight: low → 링크 가중치 0.3 감쇠 (100-499 outbound links)
    const weightDecay = doc.graphWeight === 'low' ? 0.15 : 1.0  // low 감쇄 강화 (0.3→0.15)
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

  // buildStructureHeader 호환용 visited Map (시드=0, 나머지=1)
  const visited = new Map<string, number>(
    sorted.map(([id]) => [id, seedSet.has(id) ? 0 : 1])
  )

  // PageRank + 클러스터 계산 전 UI 양보
  await new Promise<void>(r => setTimeout(r, 0))

  // 구조 헤더 (PageRank + 클러스터 개요)
  const structureHeader = await buildStructureHeader(visited, adjacency, links, loadedDocuments, docMap, getMetrics)

  // PPR 순위별 레이블 및 문자 예산
  // 상위 3개: 핵심 (1500자), 4-8위: 연관 (900자), 9위+: 주변 (500자)
  const parts: string[] = [structureHeader, '## 관련 문서 (PPR 탐색)\n']
  let charCount = structureHeader.length + 20
  let docHits = 0

  sorted.forEach(([docId, fusedScore], rank) => {
    if (charCount >= DEEP_CONTEXT_BUDGET) return

    const doc = docMap.get(docId)
    if (!doc) return  // phantom node — skip

    // adaptive 예산: 대형 문서(10K+ chars)에 더 많은 예산 배분 (최대 2배)
    const docLen = doc.rawContent?.length ?? 0
    const baseBudget = rank < 3 ? 1_500 : rank < 8 ? 900 : 500
    const budget = docLen > 10_000
      ? Math.min(baseBudget * 2, Math.max(baseBudget, Math.floor(docLen * 0.03)))
      : baseBudget
    const label = seedSet.has(docId) ? '핵심' : rank < 3 ? '핵심' : rank < 8 ? '연관' : '주변'
    const name = doc.filename.replace(/\.md$/i, '')
    const speaker = doc.speaker && doc.speaker !== 'unknown' ? ` (${doc.speaker})` : ''
    const dateLabel = getDocDateLabel(doc)
    const sourceLabel = doc.source ? ` [출처: ${doc.source}]` : ''
    const typeLabel = doc.type ? ` [${doc.type}]` : ''
    // 융합 점수(검색 0.6 + PPR 0.4)를 0-100 스케일로 표시
    const scorePct = Math.round(fusedScore * 1000) / 10
    const outdatedLabel = (doc.status === 'outdated' || doc.status === 'deprecated')
      ? ` ⚠️구버전${doc.supersededBy ? `→${doc.supersededBy}` : ''}`
      : ''
    const header = `[${label}|점수 ${scorePct}]${outdatedLabel}${typeLabel} ${name}${speaker}${dateLabel ? ` [${dateLabel}]` : ''}${sourceLabel}`

    const content = getDocContent(doc, budget, queryTerms)
    const entry = `${header}\n${content}\n\n`
    if (charCount + entry.length > DEEP_CONTEXT_BUDGET) return

    parts.push(entry)
    charCount += entry.length
    docHits++
  })

  logger.debug(`[RAG] PPR 완료: 후보=${sorted.length}, 콘텐츠 포함=${docHits}개, 총 ${charCount}자`)

  // 실제 문서 콘텐츠가 하나도 없으면 TF-IDF 결과 직접 포맷으로 폴백
  if (docHits === 0) {
    if (results.length === 0) return ''
    const fallback: string[] = ['## 관련 문서 (직접 검색)\n']
    let fallbackChars = 20
    for (const r of results.slice(0, maxDocs)) {
      const doc = docMap.get(r.doc_id)
      if (!doc) continue
      const content = getDocContent(doc, 1200, queryTerms)
      if (!content) continue
      const entry = `[직접] ${doc.filename.replace(/\.md$/i, '')}\n${content}\n\n`
      if (fallbackChars + entry.length > DEEP_CONTEXT_BUDGET) break
      fallback.push(entry)
      fallbackChars += entry.length
    }
    return fallback.length <= 1 ? '' : fallback.join('') + '\n'
  }

  return parts.join('') + '\n'
}

/**
 * 특정 문서 ID를 시작점으로 그래프를 BFS 탐색하여 관련 컨텍스트를 수집.
 *
 * buildDeepGraphContext와 동일하지만 키워드 검색을 완전히 우회합니다.
 * 사용자가 그래프에서 노드를 직접 선택했을 때 사용하세요.
 *
 * @param startDocId  시작 문서 ID (graphStore.selectedNodeId)
 * @param maxHops     탐색할 최대 홉 수 (기본 3)
 * @param maxDocs     수집할 최대 문서 수 (기본 20)
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
  const hopLabel = ['선택', '1홉', '2홉', '3홉']
  const parts: string[] = [structureHeader, '## 선택 노드 관련 문서 (그래프 탐색)\n']
  let charCount = structureHeader.length + 25

  for (const [docId, hop] of sorted) {
    if (charCount >= DEEP_CONTEXT_BUDGET) break
    const doc = docMap.get(docId)
    if (!doc) continue

    const budget = HOP_CHAR_BUDGET[hop] ?? 80
    const label = hopLabel[hop] ?? `${hop}홉`
    const name = doc.filename.replace(/\.md$/i, '')
    const speaker = doc.speaker && doc.speaker !== 'unknown' ? ` (${doc.speaker})` : ''
    const dateLabel = getDocDateLabel(doc)
    const sourceLabel = doc.source ? ` [출처: ${doc.source}]` : ''
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

// ── 3a-helper. 구조 헤더 생성 ────────────────────────────────────────────────

/**
 * 탐색된 문서들의 구조 정보를 AI 컨텍스트 헤더로 생성합니다.
 *
 * 포함 내용:
 *  - PageRank 상위 허브 문서
 *  - C. 클러스터별 TF-IDF 주제 키워드 레이블
 *  - D. 여러 클러스터를 연결하는 브릿지 문서
 *  - A. WikiLink 없이 의미적으로 연결된 숨겨진 연관 문서 쌍
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

  // PageRank 상위 5개 (탐색 문서 한정)
  const topDocs = [...visited.keys()]
    .map(id => ({ id, rank: pageRank.get(id) ?? 0 }))
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 5)
    .map(({ id }) => docMap.get(id)?.filename.replace(/\.md$/i, '') ?? id)

  // C. 클러스터별 문서 그룹 + TF-IDF 주제 키워드 레이블 (캐시 미스 시 비용↑ — UI 양보)
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
      return `  • 클러스터 ${cId + 1}${topicLabel} (${names.length}개): ${names.slice(0, 5).join(', ')}${names.length > 5 ? ' …' : ''}`
    })
    .join('\n')

  // D. 브릿지 노드 탐지 (탐색 문서 한정, 상위 3개)
  const visitedAdj = new Map<string, string[]>()
  for (const [docId] of visited) {
    visitedAdj.set(docId, adjacency.get(docId) ?? [])
  }
  const bridges = detectBridgeNodes(visitedAdj, clusters)
    .slice(0, 3)
    .map(b => {
      const name = docMap.get(b.docId)?.filename.replace(/\.md$/i, '') ?? b.docId
      return `${name}(${b.clusterCount}개 클러스터 연결)`
    })

  // A. 묵시적 연결 발견 (WikiLink 없는 의미적 유사 쌍, 상위 4개) — 캐시 미스 시 비용↑, UI 양보
  await new Promise<void>(r => setTimeout(r, 0))
  const implicitLinks = tfidfIndex.findImplicitLinks(adjacency, 4, 0.25)
    .map(l => {
      const a = l.filenameA.replace(/\.md$/i, '')
      const b = l.filenameB.replace(/\.md$/i, '')
      const pct = Math.round(l.similarity * 100)
      return `  • "${a}" ↔ "${b}" (유사도 ${pct}%)`
    })

  const lines: string[] = [
    `## 프로젝트 구조 개요`,
    `총 클러스터: ${clusterCount}개 | 탐색 문서: ${visited.size}개`,
    `주요 허브 문서 (PageRank 상위): ${topDocs.join(', ')}`,
  ]

  if (clusterLines) {
    lines.push(`\n클러스터별 주제 그룹:`)
    lines.push(clusterLines)
  }

  if (bridges.length > 0) {
    lines.push(`\n핵심 브릿지 문서 (다중 클러스터 연결): ${bridges.join(', ')}`)
  }

  if (implicitLinks.length > 0) {
    lines.push(`\n숨겨진 의미적 연관 (WikiLink 없음):`)
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
 * 연결도(degree) 기준 상위 N개 허브 문서 ID 반환.
 * 허브 노드는 많은 문서와 연결되어 있어 전체 탐색 시작점으로 적합.
 */
function getHubDocIds(adjacency: Map<string, string[]>, topN: number = 10): string[] {
  return [...adjacency.entries()]
    .filter(([, neighbors]) => neighbors.length > 0)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, topN)
    .map(([id]) => id)
}

/**
 * 허브 노드를 시작점으로 전체 그래프를 BFS 탐색하여 컨텍스트 수집.
 *
 * "전체 프로젝트 인사이트", "전반적인 피드백" 등 광범위한 쿼리나
 * 노드 선택 없이 AI 분석 버튼을 눌렀을 때 사용.
 *
 * @param maxDocs   수집할 최대 문서 수 (기본 35)
 * @param maxHops   BFS 최대 홉 수 (기본 4)
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
  const parts: string[] = [structureHeader, '## 전체 프로젝트 관련 문서 (허브 기반 탐색)\n']
  let charCount = structureHeader.length + 28

  for (const [docId, hop] of sorted) {
    if (charCount >= GLOBAL_BUDGET) break
    const doc = docMap.get(docId)
    if (!doc) continue

    const budget = HOP_CHAR_BUDGET[Math.min(hop, HOP_CHAR_BUDGET.length - 1)] ?? 80
    const name = doc.filename.replace(/\.md$/i, '')
    const speaker = doc.speaker && doc.speaker !== 'unknown' ? ` (${doc.speaker})` : ''
    const dateLabel = getDocDateLabel(doc)
    const header = `[탐색] ${name}${speaker}${dateLabel ? ` [${dateLabel}]` : ''}`
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
 *   ## 관련 문서
 *   [문서] filename > heading (speaker)
 *   content...
 *
 *   ### 연결 문서
 *   [연결] filename > heading
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

  const parts: string[] = ['## 관련 문서\n']
  let charCount = 10 // header length

  for (const r of results) {
    const header = [
      `[문서]`,
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
    parts.push('### 연결 문서\n')
    charCount += 12

    for (const n of neighbors) {
      const nHeader = `[연결] ${n.filename} > ${n.heading}`
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
