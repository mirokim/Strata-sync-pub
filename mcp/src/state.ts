/**
 * In-memory state for MCP server — loaded documents, graph, BM25 index.
 */
import type { LoadedDocument } from './parser.js'
import { loadVaultDocuments } from './vault.js'
import { getConfig, getApiKey, getConfigPath } from './config.js'
import { expandTerms, SYNONYM_MAP } from './synonyms.js'
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

// BUG5 fix: 스템 캐시 — 동일 토큰 반복 스테밍 방지
const _stemCache = new Map<string, string[]>()

/** 한글 음절 범위 (가~힣) */
function koCharCount(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xAC00 && c <= 0xD7A3) n++
  }
  return n
}

// BUG6 fix: 3음절 이상 한글 토큰 → 2-gram 서브토큰 분해
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
  // BUG6 fix: 3음절 이상이면 2-gram 서브토큰 추가
  if (koCharCount(stem) >= 3) {
    for (const sub of decomposeKo2gram(stem)) results.push(sub)
  }
  const out = [...new Set(results)]
  _stemCache.set(token, out)
  return out
}

export function tokenize(text: string): string[] {
  // 숫자+한국어 단위 분리 (예: "2026년" → "2026 년")
  const normalized = text.replace(/(\d+)(년|월|일|주|시간|시|분|초|개|명|번|회|차)/g, '$1 $2')
  const raw = normalized.toLowerCase().split(/[\s,.\-_?!;:()[\]{}'"《》「」【】]+/).filter(t => t.length > 1 || t in SYNONYM_MAP)
  const stems: string[] = []
  for (const token of raw) for (const stem of stemKorean(token)) stems.push(stem)

  // 날짜 패딩: "1월" → 토큰에서 탈락한 1자리 숫자+월/일을 0-패딩 토큰으로 복원
  const dateUnitRe = /(\d{1,2})\s*(월|일)/g
  let m: RegExpExecArray | null
  while ((m = dateUnitRe.exec(normalized)) !== null) {
    const num = m[1]
    if (num.length === 1) stems.push(num.padStart(2, '0'))
  }
  return stems
}

// ── 파일명 날짜 파싱 (프론트엔드 graphAnalysis.ts와 동일) ──────────────────

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
  filenameTokens: Set<string>  // BUG3 fix: 사전 계산
  contentDate: number           // BUG2 fix: recency boost용
}

const BM25_K1 = 1.5
const BM25_B = 0.55
/**
 * 파일명 부스트 — 해당 용어의 idf*tf 항에 곱하는 배수.
 * 가산 상수가 아니므로 idf 가 낮은(=변별력 없는) 서브토큰은 부스트도 작게 받는다.
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
    // BUG1 fix: graphWeight: skip 문서는 BM25 인덱스에서 제외
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
      // 앱(graphAnalysis.ts)과 동일: idf<=0 인 용어는 매칭으로 세지 않는다.
      // 예전에는 continue 없이 matchedTerms++ 만 되어 커버리지가 부풀려졌다.
      if (idfVal <= 0) continue
      const termScore = idfVal * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * lenNorm)
      // 파일명 부스트는 배수 — 가산 상수(2.0)였을 때는 idf 가 거의 0 인
      // 2-gram 노이즈 서브토큰이 파일명에 걸리기만 해도 만점급 가산을 받았다.
      rawScore += doc.filenameTokens.has(qt) ? termScore * FILENAME_BOOST : termScore
      matchedTerms++
    }
    if (rawScore <= 0) continue

    // BUG2 fix: 쿼리 용어 커버리지 보정
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
// 앱(src/lib/vectorEmbedIndex.ts)과 동일한 제공자 선택 규칙을 쓴다:
//   1) 로컬 BGE-M3 서버(http://127.0.0.1:8077, 1024차원)가 떠 있으면 그쪽을 쓴다.
//   2) 없으면 Gemini gemini-embedding-001(3072차원)로 폴백한다.
// 두 제공자는 벡터 공간과 차원이 다르므로 캐시에 provider/dim 을 기록하고
// 불일치하면 무효화한다. (기록이 없으면 cosineSim 이 NaN 을 내고 sort 가 무작위가 된다)

export type EmbedProvider = 'local' | 'gemini'

const LOCAL_EMBED_URL = process.env.STRATA_SYNC_EMBED_URL ?? 'http://127.0.0.1:8077'
const LOCAL_PROBE_TIMEOUT_MS = 1500
/** 로컬 서버 MAXLEN 4096토큰 × 한국어 1토큰≈1.2자 ≈ 4,900자 → 안전하게 4,500자 */
const EMBED_TEXT_MAX_CHARS = 4500
const LOCAL_EMBED_BATCH = 20
const GEMINI_CONCURRENCY = 5

/** null = 아직 프로브하지 않음 */
let _localEmbedAvailable: boolean | null = null

/** 로컬 임베딩 서버 가용성 확인 (프로세스당 1회) */
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
      console.error(`[vector] 로컬 임베딩 서버 사용: ${info.model ?? '?'} (${info.dim ?? '?'}차원)`)
    }
  } catch {
    _localEmbedAvailable = false
  }
  return _localEmbedAvailable
}

/** 프로브 결과 초기화 — 서버를 나중에 띄운 경우 재확인용 */
export function resetLocalEmbedProbe(): void { _localEmbedAvailable = null }

/**
 * 임베딩을 만들 수 있는 상태인지 — 로컬 서버가 떠 있거나 Gemini 키가 있으면 true.
 * 게이트는 Gemini 키 유무가 아니라 반드시 이 함수를 쓸 것.
 */
export async function isEmbeddingReady(apiKey?: string): Promise<boolean> {
  if (await probeLocalEmbed()) return true
  return Boolean(apiKey?.trim())
}

/** 현재 활성 임베딩 제공자 — 캐시 무효화 판정에 쓴다. */
export function activeEmbedProvider(): EmbedProvider {
  return _localEmbedAvailable === true ? 'local' : 'gemini'
}

async function embedLocalBatch(texts: string[], type: 'query' | 'document'): Promise<number[][]> {
  const res = await fetch(`${LOCAL_EMBED_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texts, type }),
  })
  if (!res.ok) throw new Error(`로컬 임베딩 서버 ${res.status}: ${res.statusText}`)
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
  throw new Error('embedGeminiSingle: 재시도 소진')
}

/**
 * 텍스트 배열 임베딩. 로컬 서버가 떠 있으면 로컬로, 아니면 Gemini 로.
 * 로컬 모드에서는 Gemini 로 폴백하지 않는다 — 차원이 섞이면 캐시가 무효해진다.
 */
async function embedBatch(texts: string[], apiKey: string, type: 'query' | 'document'): Promise<number[][]> {
  if (await probeLocalEmbed()) return embedLocalBatch(texts, type)
  if (!apiKey) throw new Error(`임베딩 제공자 없음 — 로컬 서버(${LOCAL_EMBED_URL})를 띄우거나 apiKeys.gemini 를 설정하세요`)
  const out: number[][] = new Array(texts.length)
  for (let i = 0; i < texts.length; i += GEMINI_CONCURRENCY) {
    const chunk = texts.slice(i, i + GEMINI_CONCURRENCY)
    const vecs = await Promise.all(chunk.map(t => embedGeminiSingle(t, apiKey, type)))
    for (let j = 0; j < chunk.length; j++) out[i + j] = vecs[j]
  }
  return out
}

// ── 벡터 캐시 (provider/dim 기록) ─────────────────────────────────────────────

interface VectorDoc {
  docId: string
  filename: string
  speaker: string
  embedding: number[]
  fingerprint: string
}

/** 앱의 vectorEmbedCache.ts 와 같은 형태 — provider/dim 이 없으면 구버전으로 보고 버린다. */
interface VectorCacheFile {
  version: number
  provider?: EmbedProvider
  dim?: number
  entries: VectorDoc[]
}

const VECTOR_CACHE_VERSION = 2
/** 문서 대비 임베딩 커버리지가 이 값 미만이면 벡터 경로를 켜지 않는다. */
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
      // v1(배열) 캐시 — provider/dim 기록이 없어 차원 검증이 불가능하다. 버린다.
      console.error('[vector] 구버전 캐시(provider/dim 미기록) — 무효화하고 재빌드합니다')
      return
    }
    if (raw.version !== VECTOR_CACHE_VERSION || !raw.provider || !raw.dim || !Array.isArray(raw.entries)) {
      console.error('[vector] 캐시 버전/메타 불일치 — 무효화하고 재빌드합니다')
      return
    }
    const entries = raw.entries.filter(e => Array.isArray(e.embedding) && e.embedding.length === raw.dim)
    if (entries.length !== raw.entries.length) {
      console.error(`[vector] 차원 불일치 엔트리 ${raw.entries.length - entries.length}개 제외 (dim=${raw.dim})`)
    }
    _vectorDocs = new Map(entries.map(e => [e.docId, e]))
    _vectorProvider = raw.provider
    _vectorDim = raw.dim
  } catch (e) {
    console.error('[vector] 캐시 로드 실패:', e)
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
  catch (e) { console.error('[vector] 캐시 저장 실패:', e) }
}

/** 활성 제공자와 캐시 제공자가 다르면 캐시를 통째로 무효화한다. */
async function ensureVectorCacheProvider(): Promise<EmbedProvider> {
  await probeLocalEmbed()
  const provider = activeEmbedProvider()
  if (_vectorDocs.size > 0 && _vectorProvider !== provider) {
    console.error(`[vector] 임베딩 제공자 변경 (${_vectorProvider ?? '미기록'} → ${provider}) — 전량 재빌드`)
    clearVectorIndex()
  }
  return provider
}

function cosineSim(a: number[], b: number[]): number {
  // 차원 불일치 방어 — 제공자가 바뀌면(로컬 1024 ↔ Gemini 3072) 조용히 NaN 이 나온다.
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

/** 임베딩 대상 문서 — BM25 와 동일하게 graph_weight: skip 은 제외한다. */
function embeddableDocs(): LoadedDocument[] {
  return _documents.filter(d => d.graphWeight !== 'skip')
}

/**
 * 벡터 인덱스를 검색에 쓸 수 있는지.
 * size === 0 만 보면 500개 중 5개만 임베딩된 부분 빌드도 통과해서
 * 모든 쿼리가 같은 5개 문서를 반환한다 — 커버리지 비율로 판정한다.
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
      error: `임베딩 제공자가 없습니다 — 로컬 임베딩 서버(${LOCAL_EMBED_URL})를 띄우거나 mcp-config.json 의 apiKeys.gemini 를 설정하세요`,
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

  // 삭제된 문서 엔트리 정리
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
      console.error(`[vector] 배치 임베딩 실패 (${i}~${i + batch.length}):`, msg)
      // 첫 배치부터 실패하면 설정 문제일 가능성이 높다 — 중단
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
    error: failed > 0 ? `${failed}개 실패${firstError ? `: ${firstError}` : ''}` : undefined,
  }
}

/**
 * 벡터 전용 검색 — BM25 후보와 무관하게 인덱스 전체를 훑는다.
 * 인덱스가 없거나 쿼리 임베딩에 실패하면 null (호출 측에서 BM25 폴백).
 */
async function vectorSearch(query: string, topK: number): Promise<SearchResult[] | null> {
  if (!isVectorIndexUsable()) return null
  const apiKey = getApiKey('gemini')
  if (!(await isEmbeddingReady(apiKey))) return null
  await ensureVectorCacheProvider()
  // 제공자 불일치로 방금 무효화됐을 수 있다
  if (!isVectorIndexUsable()) return null

  let queryVec: number[]
  try {
    queryVec = (await embedBatch([query.slice(0, EMBED_TEXT_MAX_CHARS)], apiKey, 'query'))[0]
  } catch (e) {
    console.error('[vector] 쿼리 임베딩 실패:', e instanceof Error ? e.message : e)
    return null
  }
  if (!Array.isArray(queryVec) || queryVec.length !== _vectorDim) {
    console.error(`[vector] 쿼리 차원 불일치 (query=${queryVec?.length ?? 0}, index=${_vectorDim}) — 벡터 경로 비활성`)
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
 * 스코어 분포가 다른 랭킹들을 순위 기반으로 합산한다 (앱과 동일).
 * ranks 는 1-based, 리스트에 없으면 Infinity.
 */
export function rrfScore(ranks: number[], k = 60): number {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0)
}

const RRF_K = 60

/**
 * Hybrid search: BM25 와 벡터를 **독립적으로** 검색한 뒤 RRF 로 융합한다.
 *
 * 예전 구현은 BM25 top-50 을 후보로 고정하고 그 안에서만 벡터로 리랭킹했다:
 *   - BM25 가 놓친 문서는 영원히 후보에 없어 벡터가 recall 을 늘리지 못했다.
 *   - 0.4*(bm25/max) + 0.6*vecSim 은 vecSim 이 0.5~0.85 좁은 대역이라
 *     0.6*vecSim 이 준-상수가 되어 사실상 BM25 순서가 지배했다.
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
      const targetId = filenameToId.get(link.toLowerCase())
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
  // 볼트가 바뀌었으므로 implicit link 메모를 버리고 지문을 갱신한다
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
  const parent = new Map<string, string>()
  function find(x: string): string {
    if (!parent.has(x)) parent.set(x, x)
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!))
    return parent.get(x)!
  }
  function union(a: string, b: string) { parent.set(find(a), find(b)) }

  for (const node of _nodes) find(node.id)
  for (const link of _links) union(link.source, link.target)

  const clusters = new Map<string, string[]>()
  for (const node of _nodes) {
    const root = find(node.id)
    if (!clusters.has(root)) clusters.set(root, [])
    clusters.get(root)!.push(node.id)
  }

  return [...clusters.values()]
    .filter(ids => ids.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((docIds, i) => ({ clusterId: i, docIds, topTerms: [] }))
}

/** Find bridge nodes (nodes connecting multiple clusters) */
export function findBridgeNodes(topK = 10): { docId: string; filename: string; clusterCount: number }[] {
  const clusterOf = new Map<string, number>()
  const clusters = detectClusters()
  clusters.forEach((c, i) => c.docIds.forEach(id => clusterOf.set(id, i)))

  const bridges: { docId: string; filename: string; clusterCount: number }[] = []
  const adj = new Map<string, Set<string>>()
  for (const link of _links) {
    if (!adj.has(link.source)) adj.set(link.source, new Set())
    if (!adj.has(link.target)) adj.set(link.target, new Set())
    adj.get(link.source)!.add(link.target)
    adj.get(link.target)!.add(link.source)
  }

  const idToFilename = new Map(_documents.map(d => [d.id, d.filename]))
  for (const [nodeId, neighbors] of adj) {
    const neighborClusters = new Set<number>()
    for (const nb of neighbors) {
      const c = clusterOf.get(nb)
      if (c !== undefined) neighborClusters.add(c)
    }
    if (neighborClusters.size >= 2) {
      bridges.push({ docId: nodeId, filename: idToFilename.get(nodeId) ?? nodeId, clusterCount: neighborClusters.size })
    }
  }

  return bridges.sort((a, b) => b.clusterCount - a.clusterCount).slice(0, topK)
}

// ── Implicit links (BM25 코사인) ─────────────────────────────────────────────
//
// 원래 구현은 호출마다 2,635개 문서의 가중치 벡터를 처음부터 만들고
// 347만 쌍 × 문서당 수백 개 Map 조회(≈19억 회)를 돌려 툴 호출 1회당
// 단일 스레드 서버를 100초 이상 정지시켰다. 세 가지를 고쳤다:
//   1) 역색인 + 희소 누산 — 결과는 그대로, Map 조회를 배열 인덱싱으로 대체
//   2) 메모이제이션 — 볼트 지문이 같으면 재계산하지 않음
//   3) 디스크 캐시 — 프로세스를 재시작해도 재계산하지 않음

export interface ImplicitPair { docA: string; docB: string; similarity: number }

/** 메모를 만들 때 쓰는 기본 하한 — 이보다 높은 minScore 요청은 메모에서 바로 응답 */
const IMPLICIT_MEMO_FLOOR = 0.10
/** 메모에 보관할 최대 쌍 수 (메모리 상한) */
const IMPLICIT_MEMO_MAX = 20_000
const IMPLICIT_CACHE_VERSION = 1

interface ImplicitMemo {
  fingerprint: string
  /** 계산에 사용한 유사도 하한 */
  floor: number
  /** IMPLICIT_MEMO_MAX 로 잘렸는지 */
  truncated: boolean
  pairs: ImplicitPair[]
}

let _vaultFingerprint = ''
let _implicitMemo: ImplicitMemo | null = null
let _implicitDiskChecked = false

/** 볼트 내용 + BM25 파라미터 지문 — 하나라도 바뀌면 캐시 무효 */
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
    console.error(`[implicit] 디스크 캐시 적중: ${rec.pairs.length}쌍 (floor=${rec.floor})`)
  } catch (e) {
    console.error('[implicit] 캐시 로드 실패:', e instanceof Error ? e.message : e)
  }
}

function saveImplicitCache(): void {
  if (!_implicitMemo) return
  try {
    writeFileSync(getImplicitCachePath(), JSON.stringify({ version: IMPLICIT_CACHE_VERSION, ..._implicitMemo }), 'utf-8')
  } catch (e) {
    console.error('[implicit] 캐시 저장 실패:', e instanceof Error ? e.message : e)
  }
}

/**
 * 상삼각 전체 쌍 유사도를 역색인 + 희소 누산으로 계산한다.
 * 결과는 기존 O(n²) 이중 루프와 동일하다 (부동소수 합산 순서만 다름).
 */
function computeImplicitPairs(floor: number): ImplicitMemo {
  const t0 = Date.now()
  const N = _bm25Docs.length
  const existingLinks = new Set<string>()
  for (const l of _links) existingLinks.add([l.source, l.target].sort().join('::'))

  // 1) 문서별 BM25 가중치 벡터 + norm, 그리고 term 별 df
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

  // 2) 역색인 — term → (문서 인덱스 오름차순, 가중치)
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

  // 3) 희소 누산 — 문서 i 에 대해 j > i 인 쌍만 누적
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
      // i 는 단조 증가하므로 커서도 단조 전진 — j <= i 구간을 반복해서 훑지 않는다
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

    // 메모리 상한 — 넘치면 상위 IMPLICIT_MEMO_MAX 만 남기고 하한을 올린다
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

  console.error(`[implicit] 재계산 완료: ${N}문서, ${results.length}쌍 (floor=${finalFloor.toFixed(4)}, ${Date.now() - t0}ms)`)
  return { fingerprint: _vaultFingerprint, floor: finalFloor, truncated, pairs: results }
}

/**
 * Find implicit links via BM25 cosine similarity.
 * 볼트가 바뀌지 않았고 minScore 가 메모 하한 이상이면 재계산하지 않는다.
 */
export function findImplicitLinks(minScore = 0.15, topK = 30): ImplicitPair[] {
  if (_bm25Docs.length === 0) return []
  if (!_vaultFingerprint) _vaultFingerprint = computeVaultFingerprint()
  loadImplicitCache()

  const memo = _implicitMemo
  let usable = memo !== null && memo.fingerprint === _vaultFingerprint
  if (usable && minScore < memo!.floor) {
    // 메모 하한보다 낮은 minScore 요청. 메모가 보관하는 것은 **전역 상위** 쌍이고
    // 빠진 쌍은 모두 그보다 유사도가 낮으므로, topK 를 채울 수만 있으면 결과는 정확하다.
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
