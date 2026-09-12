/**
 * graphAnalysis.ts
 *
 * 여섯 가지 분석 도구를 제공합니다:
 *   A. TfIdfIndex      — 코사인 유사도 기반 문서 검색 + 묵시적 연결 발견
 *   B. computePageRank — 연결 중요도 기반 문서 순위 (인기 허브 감지)
 *   C. detectClusters  — Union-Find 연결 컴포넌트 (주제 클러스터 감지)
 *   D. detectBridgeNodes — 여러 클러스터를 연결하는 브릿지 노드 탐지
 *   E. getClusterTopics  — 클러스터별 TF-IDF 상위 키워드 추출
 *   F. findImplicitLinks — WikiLink 없이 의미적으로 유사한 숨겨진 연결 발견
 */

import type { LoadedDocument } from '@/types'
import { logger } from '@/lib/logger'
import { expandTerms, SYNONYM_MAP } from '@/lib/synonyms'

// ── 공유 토크나이저 ──────────────────────────────────────────────────────────

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
 * 2-gram 서브토큰의 BM25 가산 가중치 (원본 term = 1.0).
 *
 * tokenize()는 3음절 이상 한글 토큰을 sliding 2-gram 으로 분해해 원본과 함께
 * 인덱스·쿼리 양쪽에 넣는다. 이를 그대로 합산하면 다음절 고유명사가 구조적으로
 * 과대평가된다: "캐릭터G" → 캐릭터G/다이/이잔 3개 term 이 모두 가산돼 개념 1개가
 * 3배가 되는데, 2음절 "루모"·"에녹"은 1배뿐이다. "세계관" → "계관"(255문서)
 * 같은 무의미한 서브토큰도 원본과 동급으로 취급된다.
 * → search() 는 서브토큰을 이 가중치로 감쇠 가산하고, 커버리지 계산에서는
 *   분모·분자 양쪽에서 제외한다.
 *
 * 서브토큰을 별도 네임스페이스(접두사)로 분리하지 않고 term 공간을 공유하는 이유:
 * graphRAG 의 directVaultSearch / rerank 가 tokenize() 결과로 substring 매칭을
 * 수행하고 `terms.length`·`queryStems.size` 로 나누기 때문에, 접두사를 붙이면
 * 매칭될 수 없는 토큰이 분모에 들어가 그쪽 커버리지 점수가 일괄 축소된다.
 */
export const SUBTOKEN_WEIGHT = 0.3

/** 한글 음절(가~힣)만 추출 */
function koSyllables(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xAC00 && c <= 0xD7A3) out.push(s[i])
  }
  return out
}

/** 조사를 제거한 어간까지 (2-gram 서브토큰 제외) */
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

/** 어간이 3음절 이상일 때의 sliding 2-gram 서브토큰 ("전투시스템" → 전투/시스/스템) */
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

/** 한국어 숫자+단위 분리: "28일" → "28 일" (파일명 "[2026.01.28]"의 "28"과 매칭되도록) */
function normalizeForTokenize(text: string): string {
  return text.replace(/(\d+)(년|월|일|주|시간|시|분|초|개|명|번|회|차)/g, '$1 $2')
}

function splitRawTokens(normalized: string): string[] {
  return normalized
    .toLowerCase()
    .split(/[\s,.\-_?!;:()[\]{}'"《》「」【】]+/)
    .filter(t => t.length > 1 || t in SYNONYM_MAP)
}

/** 날짜 패딩: 1자리 숫자+월/일 → 0-패딩 토큰 복원 ("1월" → "01") */
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
 * 쿼리 전용 토큰화 — term → BM25 가산 가중치 맵을 반환합니다.
 *
 * 원본 토큰·조사 제거 어간·날짜 패딩 토큰은 1.0,
 * 3음절 이상 토큰에서 파생된 2-gram 서브토큰은 SUBTOKEN_WEIGHT (0.3).
 * 서브토큰이 동시에 원본 토큰이기도 하면 1.0 이 우선한다.
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

// ── A. BM25 Index (TF-IDF → BM25 전환) ──────────────────────────────────────

export interface TfIdfResult {
  docId: string
  filename: string
  speaker: string
  score: number
}

/**
 * 파일명에서 콘텐츠 작성일을 추출 (ms since epoch).
 * 패턴: [2023_05_02], 20250723, _250328, _260106 등.
 * 매칭 실패 시 0.
 */
export function parseFilenameDate(filename: string): number {
  const now = Date.now() + 30 * 86_400_000  // 30일 여유 (미래 예약 문서 허용)
  // 경계: 단어 경계 또는 비숫자(괄호·밑줄·공백·하이픈 등)
  const B = '(?:^|[^\\d])'   // 앞 경계
  const A = '(?:[^\\d]|$)'   // 뒤 경계

  // YYYY_MM_DD 또는 YYYY-MM-DD (밑줄/하이픈 구분, 대괄호 유무 무관)
  let m = filename.match(new RegExp(`${B}(20[0-3]\\d)[_\\-](0[1-9]|1[0-2])[_\\-](0[1-9]|[12]\\d|3[01])${A}`))
  if (m) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  // YYYYMMDD (8자리 연속) — 연도 2000~2039 제한
  m = filename.match(new RegExp(`${B}(20[0-3]\\d)(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])${A}`))
  if (m) {
    const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  // YY_MM_DD (밑줄/하이픈 구분, 25_03_28 등)
  m = filename.match(new RegExp(`${B}(\\d{2})[_\\-](0[1-9]|1[0-2])[_\\-](0[1-9]|[12]\\d|3[01])${A}`))
  if (m) {
    const yy = parseInt(m[1], 10)
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy
    const ms = Date.parse(`${yyyy}-${m[2]}-${m[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  // YYMMDD (6자리, 260106 등)
  m = filename.match(new RegExp(`${B}(\\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\\d|3[01])${A}`))
  if (m) {
    const yy = parseInt(m[1], 10)
    const yyyy = yy >= 50 ? 1900 + yy : 2000 + yy
    const ms = Date.parse(`${yyyy}-${m[2]}-${m[3]}`)
    if (!isNaN(ms) && ms <= now) return ms
  }

  return 0
}

/** 문서의 콘텐츠 작성일 추출 (파일명 > frontmatter > mtime > 0) */
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
  termFreqs: Map<string, number>  // 원시 용어 빈도
  docLen: number                   // 문서 총 토큰 수
  contentDate: number              // 콘텐츠 작성일 (ms), 0 = 미상
  bm25Vec: Map<string, number>    // 정규화 BM25 벡터 (묵시적 링크 유사도용)
  bm25Norm: number
}

export interface ImplicitLink {
  docAId: string
  docBId: string
  filenameA: string
  filenameB: string
  similarity: number
}

/** BM25 파라미터 */
const BM25_K1 = 1.5   // 용어 포화 계수 — 빈도 증가의 한계 수익 조절
const BM25_B  = 0.75  // 문서 길이 정규화 계수

/** 최신 문서 가산 상한 (mcp/src/state.ts 와 동일) */
const RECENCY_MAX_BOOST = 0.1
/** 최신성 지수 감쇠 상수 (일) */
const RECENCY_DECAY_DAYS = 180

/**
 * IndexedDB 캐시 스키마 버전 — 포맷 변경 시 이 값만 올리면 캐시 자동 무효화.
 *
 * v8: (a) allText 에서 rawContent 제거 (본문 이중 계수 해소 → 모든 tf/docLen/idf 변경)
 *     (b) implicitLinks 를 캐시에 동봉 (캐시 히트 시 O(N²) 재계산 제거)
 */
export const TFIDF_SCHEMA_VERSION = 9

export interface SerializedTfIdf {
  schemaVersion: typeof TFIDF_SCHEMA_VERSION
  fingerprint: string
  idf: [string, number][]
  avgdl: number
  /**
   * 사전 계산된 묵시적 링크 (O(N²) 재계산 회피).
   * 지문(fingerprint)이 같으면 문서·WikiLink 도 같으므로 그대로 재사용 가능.
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

  /** Worker에서 사전 계산한 묵시적 링크를 주입 (캐시 웜업) */
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
    logger.debug(`[graphAnalysis] BM25 인덱스 캐시 복원: ${this.docs.length}개 문서`)
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
      if ((doc as any).graphWeight === 'skip') continue   // skip 문서는 BM25 인덱스 제외
      // rawContent 는 sections 의 원본이므로 함께 넣으면 본문이 두 번 계수된다.
      // (모든 tf 2배 → lenNorm 왜곡, 파일명·태그·speaker 의 상대 가중치가 절반으로 희석,
      //  YAML 프론트매터의 source URL·related 파일명 목록이 본문 term 으로 유입)
      const allText = [
        doc.filename.replace(/\.md$/i, ''),
        doc.title ?? '',
        // source 에는 Jira 키가 들어 있다 (…/browse/SGEATF-160). rawContent 를 통째로
        // 넣으면 본문이 두 번 세어지므로, 필요한 프론트매터 필드만 골라 넣는다.
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

    const N = docLens.size  // skip 필터된 문서 수 기준
    const totalLen = [...docLens.values()].reduce((a, b) => a + b, 0)
    this.avgdl = N > 0 ? totalLen / N : 1

    // BM25 IDF: log((N - df + 0.5) / (df + 0.5) + 1)
    for (const [term, df] of docFreq) {
      this.idf.set(term, Math.log((N - df + 0.5) / (df + 0.5) + 1))
    }

    // BM25 가중치 벡터 + L2 norm (묵시적 링크 유사도용)
    for (const doc of loadedDocuments) {
      if ((doc as any).graphWeight === 'skip') continue   // skip 문서는 벡터도 제외
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
    logger.debug(`[graphAnalysis] BM25 인덱스 빌드 완료: ${this.docs.length}개 문서, avgdl=${this.avgdl.toFixed(1)}`)
  }

  /**
   * 단일 문서 증분 업데이트 — 전체 재빌드 없이 한 파일만 교체.
   * 기존 용어의 IDF는 유지(근사치)하되, **신규 용어는 df를 실측해 this.idf에 등록**한다.
   * (등록하지 않으면 search() 의 `idf.get(term) ?? 0; if (idfVal <= 0) continue` 때문에
   *  방금 저장한 문서의 새 고유명사로 검색하면 0건이 나온다.)
   */
  updateDoc(doc: LoadedDocument): void {
    if (!this.built) return

    // 기존 문서 제거
    const existingIdx = this.docs.findIndex(d => d.docId === doc.id)
    if (existingIdx !== -1) this.docs.splice(existingIdx, 1)

    // 새 문서 토큰화 (build()와 동일하게 rawContent 제외 — 본문 이중 계수 방지)
    const allText = [
      doc.filename.replace(/\.md$/i, ''),
      doc.title ?? '',
      doc.source ?? '',   // Jira 키 (…/browse/SGEATF-160)
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

    // ── 신규 용어 IDF 등록 ────────────────────────────────────────────────
    // 기존 인덱스에 없던 term 만 모아 나머지 문서에서 df 를 실측한다.
    const newTerms: string[] = []
    for (const term of termFreq.keys()) {
      if (!this.idf.has(term)) newTerms.push(term)
    }
    if (newTerms.length > 0) {
      const newDf = new Int32Array(newTerms.length).fill(1)  // 이 문서 자신 포함
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

    // BM25 벡터 계산 (기존 용어는 기존 IDF 재사용)
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

    // 쿼리 토큰 + 서브토큰 가중치 (서브토큰은 0.3 으로 감쇠 가산)
    const baseWeights = tokenizeQueryWeighted(query)
    if (baseWeights.size === 0) return []

    // ── 개념(concept) 그룹 ────────────────────────────────────────────────
    // 원본 쿼리 term 1개 = 개념 1개. 그 term 의 동의어 확장은 **같은 개념**이다.
    // 커버리지 분모를 확장 후 term 수로 잡으면 동의어를 늘릴수록 정확 매칭이
    // 손해를 본다 ("사운드 밸런스" → 6 term 이 15 term 으로 확장되어
    //  정확히 담은 문서는 6/15=0.40, 밸런스가 없는 사운드 용어집은 7/15=0.47 로 역전).
    // 서브토큰은 개념이 아니므로 분모·분자 모두에서 제외한다.
    const conceptGroups: string[][] = []
    for (const [t, w] of baseWeights) {
      if (w < 1) continue   // 서브토큰
      conceptGroups.push(expandTerms([t]))
    }
    const termConcept = new Map<string, number>()
    conceptGroups.forEach((group, ci) => {
      for (const t of group) if (!termConcept.has(t)) termConcept.set(t, ci)
    })

    // 채점 대상 term 전체 (동의어 확장 + 날짜 조합 토큰 포함)
    const allTerms = new Set(expandTerms([...baseWeights.keys()]))

    // 유효 term 사전 계산 — idf 조회를 문서 루프 밖으로 뺀다
    const qTerms: string[] = []
    const qIdf: number[] = []
    const qWeight: number[] = []
    const qConcept: number[] = []
    // 개념별 최대 기여도 (절대 스케일 정규화 분모)
    const conceptMaxIdf = new Float64Array(Math.max(1, conceptGroups.length))
    let ungroupedMax = 0
    let subMax = 0

    for (const term of allTerms) {
      const idfVal = this.idf.get(term) ?? 0
      if (idfVal <= 0) continue
      // 동의어로 확장된 term 은 원본 term 과 동일한 가중치(1)를 갖는다
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

    // ── 빈 개념 압축 ──────────────────────────────────────────────────────
    // 인덱스에 존재하지 않는 term 만으로 이뤄진 개념(조사가 붙은 변형 "루모와",
    // "캐릭터G의" 등)은 어떤 문서도 매칭할 수 없다. 커버리지 분모에 남겨두면
    // 모든 문서가 영구히 감점된다.
    const conceptRemap = new Int32Array(Math.max(1, conceptGroups.length)).fill(-1)
    let conceptCount = 0
    for (let i = 0; i < conceptGroups.length; i++) {
      if (conceptMaxIdf[i] > 0) conceptRemap[i] = conceptCount++
    }
    for (let i = 0; i < qConcept.length; i++) {
      if (qConcept[i] >= 0) qConcept[i] = conceptRemap[qConcept[i]]
    }

    // ── 절대 스케일 정규화 분모 ───────────────────────────────────────────
    // "각 개념을 가장 강하게 담은 이상적인 문서"의 BM25 상한 = Σ 개념 상한 * (k1+1).
    // 최고점 문서로 나누는 기존 방식은 쿼리와 무관해도 1위가 항상 1.0 이 되어
    // 호출자의 minBm25Score / BM25_SCORE_THRESHOLD 가 통과 필터로만 동작했다.
    //
    // 개념의 상한은 그룹 안에서 가장 정보량이 큰(idf 최대) term 기준.
    // 개념별로 상한을 강제 clamp 하지는 않는다 — 흔한 head term("사운드")의 idf 로
    // 조이면 대부분의 문서가 상한에 붙어 순위가 무너진다(실측 확인).
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
      // 개념 term 이 모두 미등록 — 서브토큰만 남은 경우
      for (let i = 0; i < qTerms.length; i++) denom += qWeight[i] * qIdf[i] * (BM25_K1 + 1)
    }
    if (denom <= 0) return []
    // 최신성 부스트 상한까지 분모에 반영 — clamp 때문에 상위권이 1.0 으로 뭉치지 않도록
    denom *= 1 + RECENCY_MAX_BOOST
    // 문서 인덱스를 스탬프로 쓰는 재사용 버퍼 (문서마다 Set/배열 할당 회피)
    const conceptMark = new Int32Array(Math.max(1, conceptCount)).fill(-1)
    const conceptScore = new Float64Array(Math.max(1, conceptCount))
    const matchedList = new Int32Array(Math.max(1, conceptCount))
    const now = Date.now()
    const scored: { doc: BM25Doc; score: number }[] = []

    for (let di = 0; di < this.docs.length; di++) {
      const doc = this.docs[di]
      const lenNorm = 1 - BM25_B + BM25_B * (doc.docLen / this.avgdl)
      let rawScore = 0          // 개념에 속하지 않는 term(서브토큰·날짜 조합)의 기여
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

      // 한 개념 안에서 동의어가 여러 개 동시에 매칭돼도 그 개념 상한의 2배를
      // 넘지 못하게만 제한한다. (완전히 상한으로 조이면 순위가 뭉개지고,
      // 전혀 제한하지 않으면 상위권이 최종 clamp 에 걸려 1.0 으로 뭉친다)
      for (let k = 0; k < matchedConcepts; k++) {
        const ci = matchedList[k]
        const s = conceptScore[ci]
        const cap = conceptCap[ci] * 2
        rawScore += s < cap ? s : cap
      }

      if (rawScore <= 0) continue

      // 커버리지 보정: 개념 3개 중 1개만 매칭된 문서는 감점 (coverage^0.5 로 완만하게)
      const coverage = conceptCount > 1 ? matchedConcepts / conceptCount : 1
      let score = rawScore * Math.sqrt(coverage)

      // 최신성 부스트 — 최대 +10%, 감쇠 180일 (mcp/src/state.ts 와 동일 공식).
      // contentDate 는 getContentDate() 기준(파일명 날짜 우선)이라
      // date frontmatter 가 없는 문서(볼트의 27.6%)도 파일명에서 날짜를 얻는다.
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
   * WikiLink로 연결되지 않은 문서 중 의미적으로 유사한 쌍을 반환합니다.
   * BM25 가중치 벡터의 코사인 유사도가 threshold 이상인 쌍이 대상입니다.
   *
   * 전수 O(N²) 비교(문서당 고유 term 수백 개 × 350만 쌍 ≈ 19억 Map 조회)를 피하기 위해
   *  1. 문서별 상위 가중치(=고-idf) term 만으로 역인덱스를 만들어 **후보 쌍**만 추리고
   *  2. 후보에 대해서만 정확한 코사인을 계산하며
   *  3. 전체 쌍을 배열에 모아 정렬하는 대신 크기 제한 top-K 최소 힙을 쓴다.
   *
   * adjacency 참조가 바뀌지 않으면 캐시된 결과를 반환합니다.
   * (캐시에는 최대 IMPLICIT_HEAP_CAP 개만 보관되므로 그보다 큰 topN 은 잘린다.)
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

    // ── 1. 문서별 상위 가중치 term 선별 (최소 힙, 전체 정렬 회피) ──────────
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

    // ── 2. 역인덱스 구축 (term → 해당 term 이 상위인 문서들) ───────────────
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

    // ── 3. 후보 쌍 채점 ───────────────────────────────────────────────────
    const acc = new Float64Array(n)          // 부분 내적 누적 (재사용)
    const touched = new Int32Array(n)        // 이번 i 에서 건드린 j 목록
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
        // 고빈도(저-idf) term 은 후보 생성에 기여하지 않으면서 비용만 크다
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
        // partial 은 실제 내적의 하한 (상위 term 교집합만 반영)
        if (partial < candCut * normProd) continue
        if (existingLinks.has(i * n + j)) continue

        // 정확 코사인 — 작은 벡터를 순회해 Map 조회 횟수를 줄인다
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
      `[graphAnalysis] 묵시적 연결 top-${pairs.length} 확정 ` +
      `(docs=${n}, 후보=${candidateCount}, threshold=${threshold})`
    )

    return pairs.slice(0, topN)
  }
}

// ── 묵시적 링크 탐색 튜닝 상수 ────────────────────────────────────────────────

/** 후보 생성에 쓰는 문서별 상위 가중치 term 수 */
const IMPLICIT_TOP_TERMS = 64
/** 이보다 긴 포스팅 리스트(=저-idf 범용어)는 후보 생성에서 제외 */
const IMPLICIT_MAX_POSTING = 600
/** 부분 내적이 threshold 의 이 비율 이상이면 정확 계산 대상 */
const IMPLICIT_CAND_RATIO = 0.45
/** 결과 힙 용량 — 호출자는 topN=4~6 만 쓰므로 여유분만 보관 */
const IMPLICIT_HEAP_CAP = 32

/** 병렬 배열(payload[], key[]) 최소 힙 push */
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

/** 병렬 배열 최소 힙 pop (최솟값 제거) */
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

/** BM25 인덱스 싱글톤 — 볼트 로드 시 build() 호출 필요 */
export const tfidfIndex = new TfIdfIndex()

// ── B. PageRank ───────────────────────────────────────────────────────────────

/**
 * 문서 그래프에서 PageRank를 계산합니다.
 * 많은 문서로부터 참조될수록 높은 순위를 받습니다.
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

  // 역방향 엣지 (in-edges) 사전 계산 — O(N+M) 순회를 위해
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
    // 아웃링크 없는 노드의 랭크 합 (dangling nodes)
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

  // 0..1 정규화
  const max = Math.max(1e-10, ...rank.values())
  for (const [id, r] of rank) rank.set(id, r / max)

  return rank
}

// ── C. 클러스터 감지 (Union-Find) ─────────────────────────────────────────────

/**
 * Union-Find로 연결 컴포넌트(클러스터)를 감지합니다.
 * 같은 WikiLink 네트워크로 연결된 문서들은 같은 클러스터 번호를 받습니다.
 *
 * @returns Map<docId, clusterId> — clusterId 0이 가장 큰 클러스터
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

  // 루트별 그룹화
  const groups = new Map<string, string[]>()
  for (const id of adjacency.keys()) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(id)
  }

  // 클러스터 크기 내림차순 정렬 (0 = 가장 큰 클러스터)
  const sorted = [...groups.values()].sort((a, b) => b.length - a.length)
  const clusterMap = new Map<string, number>()
  sorted.forEach((members, idx) => {
    for (const id of members) clusterMap.set(id, idx)
  })

  return clusterMap
}

// ── 그래프 메트릭 캐시 ────────────────────────────────────────────────────────

export interface GraphMetrics {
  pageRank: Map<string, number>
  clusters: Map<string, number>
  clusterCount: number
}

let _metricsCache: GraphMetrics | null = null
let _metricsLinksRef: unknown = null

/** 볼트 교체 시 캐시를 명시적으로 초기화합니다. */
export function clearMetricsCache(): void {
  _metricsCache = null
  _metricsLinksRef = null
  _stemCache.clear()
  _stemPrimaryCache.clear()
}

/**
 * PageRank + 클러스터를 한 번 계산하고 캐시합니다.
 * links 배열 참조가 바뀌면 자동으로 재계산됩니다.
 */
export function getGraphMetrics(
  adjacency: Map<string, string[]>,
  linksRef: unknown
): GraphMetrics {
  if (_metricsCache && _metricsLinksRef === linksRef) return _metricsCache

  const pageRank = computePageRank(adjacency)
  const clusters = detectClusters(adjacency)
  const clusterCount = new Set(clusters.values()).size

  _metricsCache = { pageRank, clusters, clusterCount }
  _metricsLinksRef = linksRef
  return _metricsCache
}

// ── D. 브릿지 노드 탐지 ───────────────────────────────────────────────────────

export interface BridgeNode {
  docId: string
  /** 이 노드가 연결하는 서로 다른 클러스터 수 (자신의 클러스터 포함) */
  clusterCount: number
}

/**
 * 여러 클러스터에 걸쳐 이웃을 가진 브릿지 노드를 탐지합니다.
 *
 * 브릿지 노드 = 자신과 다른 클러스터에 속한 이웃을 1개 이상 가진 노드.
 * 이런 노드는 주제 영역들을 연결하는 아키텍처 핵심 문서입니다.
 *
 * @returns clusterCount 내림차순으로 정렬된 배열
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

// ── E. 클러스터 주제 키워드 ──────────────────────────────────────────────────

/** 클러스터 토픽 추출 시 제외할 한국어 범용 불용어 */
const KO_STOPWORDS = new Set([
  '게임', '회의', '문서', '내용', '진행', '확인', '관련', '작업', '기획', '개발',
  '결과', '현재', '이후', '정리', '사항', '대한', '통해', '위해', '가능', '필요',
  '부분', '경우', '정도', '추가', '변경', '적용', '처리', '검토', '완료', '예정',
])

/**
 * 각 클러스터의 TF-IDF 상위 키워드를 추출합니다.
 *
 * 전체 볼트 문서에서 IDF(Inverse Document Frequency)를 계산하고,
 * 클러스터 내 TF × IDF 점수로 범용어 대신 클러스터 고유 키워드를 반환합니다.
 * 구조 헤더에 "클러스터 1 [전투/스킬/밸런스]" 형태로 활용됩니다.
 *
 * @param clusters  Map<docId, clusterId>
 * @param docs      볼트 문서 배열
 * @param topK      클러스터당 반환할 키워드 수
 * @returns Map<clusterId, topKeywords[]>
 */
// 클러스터 토픽 캐시 — clusters Map 참조와 topK가 동일하면 재계산 생략
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

  // ── 1. 전체 볼트 IDF 계산: 각 토큰이 등장하는 문서 수(DF) ──
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

  // ── 2. 클러스터별 텍스트 수집 ──
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

  // ── 3. 클러스터별 TF × IDF 점수로 키워드 추출 ──
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

// ── F. 볼트 인사이트 종합 분석 ───────────────────────────────────────────────

export interface InsightResult {
  /** 많은 문서에서 참조되는 허브 문서들 */
  bridgeNodes: { docId: string; filename: string; inboundCount: number; outboundCount: number }[]
  /** 인바운드/아웃바운드 링크가 모두 없는 고립 문서 */
  orphanDocs: { docId: string; filename: string }[]
  /** 여러 문서에서 참조되지만 실제 파일이 없는 주제 (작성 필요) */
  gapTopics: { topic: string; referenceCount: number }[]
  /** 연결 컴포넌트 클러스터 요약 */
  clusters: { size: number; representative: string; clusterIdx: number }[]
}

/**
 * 볼트 전체를 분석하여 인사이트를 생성합니다.
 * - 브리지 노드: 많이 참조되는 허브 문서
 * - 고립 문서: 링크가 전혀 없는 문서
 * - 빈틈 주제: 여러 곳에서 참조되지만 파일이 없는 [[링크]]
 * - 클러스터: 연결 컴포넌트 요약
 */
export function computeInsights(docs: LoadedDocument[]): InsightResult {
  if (docs.length === 0) return { bridgeNodes: [], orphanDocs: [], gapTopics: [], clusters: [] }

  const docIds = new Set(docs.map(d => d.id))
  // stem → docId 매핑 (파일명 기반 역조회)
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

// ── G. Co-occurrence 기반 동의어 추출 ────────────────────────────────────────

/** 범용 불용어 (조사, 접속사, 관사 등) — 동의어 후보에서 제외 */
const CO_STOPWORDS = new Set([
  '그리고', '그러나', '하지만', '그래서', '또는', '혹은', '및', '등',
  '있다', '없다', '하다', '되다', '이다', '것이', '수가', '때문',
  '위해', '대해', '통해', '관련', '경우', '이후', '이전', '사이',
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was',
  'not', 'but', 'have', 'has', 'had', 'will', 'can', 'all', 'been',
])

/**
 * 볼트 문서들에서 섹션 단위 co-occurrence 분석으로 동의어 후보를 추출합니다.
 *
 * 알고리즘:
 *  1. 각 섹션을 토크나이즈하여 고유 용어 집합 추출
 *  2. 같은 섹션에 등장하는 모든 용어 쌍의 공동 출현 빈도 집계
 *  3. PMI(Pointwise Mutual Information) 계산으로 우연적 공동 출현 제거
 *  4. 공동 출현 빈도 >= 3 && PMI >= 임계값인 쌍만 반환
 *
 * @param docs 볼트 문서 배열
 * @param minCoOccurrence 최소 공동 출현 횟수 (기본 3)
 * @param pmiThreshold PMI 최소 임계값 (기본 2.0)
 * @returns Map<term, synonym[]> — 양방향 동의어 쌍
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

/** 섹션당 쌍 생성에 사용할 최대 용어 수 (df 가 낮은 = 변별력 높은 순으로 선택) */
const CO_MAX_TERMS_PER_SECTION = 60
/** co-occurrence Map 안전 상한 (JS Map 한계는 2^24) */
const CO_MAX_PAIRS = 8_000_000
/** 용어당 등록할 최대 동의어 수 — expandTerms 폭발 방지 */
const CO_MAX_SYNONYMS = 3

/**
 * 최소 포함도(containment) — count / min(dfA, dfB).
 *
 * PMI 는 저빈도 편향이 심해서 df=10 짜리 두 용어가 3번만 같이 나와도 PMI≈9 가 되어
 * 통과한다. 그 결과는 "동의어"가 아니라 단순 주제 연관어이고, 쿼리 확장에 넣으면
 * 검색 품질이 떨어진다(실측: 무제한 등록 시 "사운드 밸런스" 1위가 관련 없는
 * 문서로 바뀜). 드문 쪽 용어가 등장하는 섹션의 절반 이상에서 함께 등장할 때만
 * 동의어 후보로 인정한다.
 */
const CO_MIN_CONTAINMENT = 0.5

/**
 * 섹션 텍스트 배열에서 co-occurrence 동의어를 추출합니다.
 * (워커에 문서 전체 대신 섹션 문자열만 전송할 수 있도록 분리된 진입점)
 *
 * 기존 구현은 섹션마다 최대 80개 용어의 **전체 쌍**을 문자열 키 Map 에 집계해
 * C(80,2)=3,160 × 섹션 수 ≈ 2,500만 회 연산 후 `RangeError: Map maximum size
 * exceeded` 로 죽었다(결과 0개, 비용은 전액 지불). 개선점:
 *  - df < minCoOccurrence 인 용어는 **쌍 생성 전에** 제거. 3개 미만 섹션에
 *    등장하는 용어는 정의상 임계값을 넘을 수 없는데 전체 쌍의 대부분을 차지한다.
 *  - 용어를 정수 id 로 매핑해 `idA * V + idB` 숫자 키 사용 (문자열 concat 제거).
 *  - 2-gram 서브토큰 제외 (의미 없는 쌍의 주요 발생원).
 *  - Map 크기 상한 도달 시 신규 키만 차단하고 경고 (예외로 죽지 않음).
 */
export function extractCoOccurrenceSynonymsFromSections(
  sectionTexts: string[],
  minCoOccurrence: number = 3,
  pmiThreshold: number = 2.0,
): Map<string, string[]> {
  // ── 1. 섹션별 고유 용어를 플랫 버퍼에 수집 + df(등장 섹션 수) 집계 ──────
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

  // ── 2. df 필터 + 정수 id 매핑 ─────────────────────────────────────────
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

  // ── 3. 공동 출현 빈도 집계 (숫자 키) ──────────────────────────────────
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
      // df 오름차순 = 변별력 높은 용어 우선
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
    logger.warn(`[coOccurrence] 쌍 상한 ${CO_MAX_PAIRS} 도달 — 일부 쌍이 누락됩니다 (섹션=${totalSections}, 어휘=${V})`)
  }

  // ── 4. PMI 필터 + 용어당 상위 N개만 등록 ──────────────────────────────
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
    // 포함도 필터 — PMI 저빈도 편향으로 들어오는 단순 주제 연관어 제거
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
    `[coOccurrence] ${result.size}개 용어의 동적 동의어 추출 완료 ` +
    `(섹션=${totalSections}, 어휘=${V}, 쌍=${coOccurrence.size})`
  )
  return result
}
