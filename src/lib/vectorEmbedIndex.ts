/**
 * vectorEmbedIndex.ts — 벡터 임베딩 인덱스 (v3: 증분 빌드)
 *
 * v2까지는 전체 fingerprint 일치 방식 → 문서 1개 수정 시 전량 재빌드.
 * v3부터 문서별 mtime 비교로 변경된 문서만 재임베딩합니다.
 *
 * 섹션 2개 이상 문서는 섹션별 임베딩, 1개면 문서 단위 임베딩.
 * 볼트 로드 후 백그라운드에서 빌드되며 파일 캐시에 저장됩니다.
 *
 * 사용 흐름:
 *   1. vault 로드 후 → buildIncremental(docs, apiKey, vaultPath)
 *   2. 검색 시 → fullVectorSearch(query, apiKey, topK, docs)
 */

import type { LoadedDocument, DocSection, SearchResult } from '@/types'
import { loadVectorEmbedCacheIncremental, saveVectorEmbedCacheIncremental, invalidateVectorEmbedCache } from './vectorEmbedCache'
import type { EmbedProvider } from './vectorEmbedCache'
import { logger } from './logger'

/**
 * 이 값 초과 섹션을 가진 문서는 섹션별 임베딩, 이하는 문서 단위 임베딩.
 *
 * 3이었을 때 볼트 섹션 수 중앙값이 정확히 3이라 문서의 58.4%가
 * "문서 전체 = 벡터 1개" 경로를 탔다 — 긴 문서일수록 세부 내용이 희석된다.
 * 1로 낮춰 섹션이 2개 이상이면 섹션별로 임베딩한다.
 */
const SECTION_EMBED_THRESHOLD = 1

/**
 * 임베딩 텍스트 슬라이스 한도(문자).
 * 서버 MAXLEN 4096 토큰 × 한국어 1토큰≈1.2자 ≈ 4,900자. 안전하게 4,500자로 자른다.
 */
const EMBED_TEXT_MAX_CHARS = 4500

// ── 내부 상태 ────────────────────────────────────────────────────────────────

interface EmbedState {
  embeddings: Map<string, Float32Array>  // sectionId → embedding vector (Float32 for 50% memory saving)
  sectionDocMap: Map<string, string>     // sectionId → docId (캐시 저장용)
  built: boolean
  building: boolean
  progress: number  // 0~100
  lastError: string | null
  generation: number  // reset() 호출마다 증가 — 구버전 빌드가 결과를 덮어쓰지 못하게
}

const _state: EmbedState = {
  embeddings: new Map(),
  sectionDocMap: new Map(),
  built: false,
  building: false,
  progress: 0,
  lastError: null,
  generation: 0,
}

// ── 섹션/문서 텍스트 추출 ─────────────────────────────────────────────────────

// 보일러플레이트 접두사(docTypePrefix / queryPrefix)는 제거했다.
//   - type: spec 문서가 1,184개(볼트의 45%)라 그만큼의 임베딩 텍스트가
//     문자 그대로 "게임 기획 문서: " 로 시작했다. 같은 문서의 모든 섹션이
//     동일 접두사를 공유해 문서 단위 max-pooling 시 섹션 변별이 되지 않았다.
//   - queryPrefix 제거만으로 Recall@5 가 3/6 → 5/6 으로 개선됐다.
//   - 문서/쿼리 중 한쪽만 제거하면 분포가 어긋나 오히려 나빠진다. 반드시 함께 둔다.
//   - tags/speaker 는 검색 필터·부스트에서 이미 쓰므로 임베딩 텍스트에서 뺀다.

/** 섹션 단위 임베딩 텍스트: 문서 제목 + 섹션 헤딩 + 본문 */
function sectionText(section: DocSection, doc: LoadedDocument): string {
  const title = doc.filename.replace(/\.md$/i, '')
  return `${title}\n${section.heading}\n${section.body}`.slice(0, EMBED_TEXT_MAX_CHARS)
}

/** 문서 전체를 하나의 벡터로 — 섹션이 SECTION_EMBED_THRESHOLD 이하인 문서용 폴백 */
function docText(doc: LoadedDocument): string {
  const title = doc.filename.replace(/\.md$/i, '')
  const body = doc.sections.map(s => `${s.heading}\n${s.body}`).join('\n\n')
  return `${title}\n${body}`.slice(0, EMBED_TEXT_MAX_CHARS)
}

/** 쿼리 텍스트 — 접두사 없이 원문 그대로 (문서 쪽과 분포를 맞춘다) */
function queryText(query: string): string {
  return query
}

/** 임베딩 단위: 섹션이 SECTION_EMBED_THRESHOLD 초과면 섹션별, 아니면 문서 단위 */
interface EmbedItem { id: string; text: string; docId: string }

function extractEmbedItems(docs: LoadedDocument[]): EmbedItem[] {
  const items: EmbedItem[] = []
  for (const doc of docs) {
    if (doc.sections.length > SECTION_EMBED_THRESHOLD) {
      for (const sec of doc.sections) {
        items.push({ id: sec.id, text: sectionText(sec, doc), docId: doc.id })
      }
    } else {
      // 섹션이 임계값 이하 — 문서 단위 (키는 docId)
      items.push({ id: doc.id, text: docText(doc), docId: doc.id })
    }
  }
  return items
}

/** 문서 목록에서 docId → mtime 맵 생성 */
function buildDocMtimes(docs: LoadedDocument[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const doc of docs) {
    map.set(doc.id, doc.mtime ?? 0)
  }
  return map
}

// ── Google Gemini 임베딩 API (gemini-embedding-001, 3072차원) ─────────────────

/** Gemini taskType — 쿼리/문서 구분으로 임베딩 품질 향상 */
type GeminiTaskType = 'RETRIEVAL_QUERY' | 'RETRIEVAL_DOCUMENT'

async function embedSingle(text: string, apiKey: string, retries = 2, taskType?: GeminiTaskType): Promise<Float32Array> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent`
  for (let attempt = 0; attempt <= retries; attempt++) {
    const body: Record<string, unknown> = {
      model: 'models/gemini-embedding-001',
      content: { parts: [{ text }] },
    }
    if (taskType) body.taskType = taskType
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    })
    if (res.status === 429 && attempt < retries) {
      const delay = Math.min(1000 * Math.pow(2, attempt), 8000)
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}))
      throw new Error(`Gemini embeddings ${res.status}: ${JSON.stringify(errBody)}`)
    }
    const json = await res.json() as { embedding: { values: number[] } }
    return new Float32Array(json.embedding.values)
  }
  throw new Error('embedSingle: exhausted retries')
}

// ── 로컬 임베딩 서버 (BGE-M3, 1024차원) ───────────────────────────────────────
//
// scripts/local_embed_server.py 가 떠 있으면 Gemini 대신 이쪽을 씁니다.
// 사내 문서가 외부 API로 나가지 않고, 비용도 들지 않습니다.
//
// 주의: 캐시(.vector_cache_v6.json)와 쿼리는 반드시 같은 제공자로 만들어야 합니다.
// 제공자가 섞이면 차원이 달라지므로 cosineSim 이 0을 반환하도록 방어해 두었습니다.

const LOCAL_EMBED_URL = 'http://127.0.0.1:8077'
const LOCAL_PROBE_TIMEOUT_MS = 1500

/** null = 아직 확인 안 함 */
let _localEmbedAvailable: boolean | null = null

/** 로컬 서버 가용성 확인 (프로세스당 1회) */
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
      logger.debug(`[vector] 로컬 임베딩 서버 사용: ${info.model} (${info.dim}차원)`)
    }
  } catch {
    _localEmbedAvailable = false
  }
  return _localEmbedAvailable
}

/** 가용성 캐시 초기화 — 서버를 나중에 띄운 경우 재확인용 */
export function resetLocalEmbedProbe(): void {
  _localEmbedAvailable = null
}

/**
 * 임베딩을 만들 수 있는 상태인지 — 로컬 서버가 떠 있거나 Gemini 키가 있으면 true.
 *
 * 호출 지점들이 Gemini 키 유무만 보고 게이트하면, 로컬 서버만 띄우고 키를 두지 않은
 * 사용자(= 이 기능이 노리는 바로 그 경우)는 인덱스가 아예 빌드되지 않는다.
 * 게이트는 반드시 이 함수를 쓸 것.
 */
export async function isEmbeddingReady(apiKey?: string): Promise<boolean> {
  if (await probeLocalEmbed()) return true
  return Boolean(apiKey?.trim())
}

/** 마지막 프로브 결과 (동기). 프로브 전이면 false. UI 표시용. */
export function isLocalEmbedReadySync(): boolean {
  return _localEmbedAvailable === true
}

/** 현재 활성 임베딩 제공자 — 캐시 무효화 판정에 쓴다. */
export function activeEmbedProvider(): EmbedProvider {
  return _localEmbedAvailable === true ? 'local' : 'gemini'
}

async function embedLocalBatch(texts: string[], taskType?: GeminiTaskType): Promise<Float32Array[]> {
  const res = await fetch(`${LOCAL_EMBED_URL}/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      texts,
      type: taskType === 'RETRIEVAL_QUERY' ? 'query' : 'document',
    }),
  })
  if (!res.ok) throw new Error(`로컬 임베딩 서버 ${res.status}`)
  const json = await res.json() as { embeddings: number[][] }
  return json.embeddings.map(v => new Float32Array(v))
}

/**
 * texts 배열 임베딩.
 * 로컬 서버가 떠 있으면 로컬로, 아니면 Gemini API 로 처리합니다.
 * 로컬 모드에서는 Gemini 로 폴백하지 않습니다 — 차원이 섞이면 캐시가 무효해지기 때문입니다.
 */
async function embedBatch(texts: string[], apiKey: string, taskType?: GeminiTaskType): Promise<Float32Array[]> {
  if (await probeLocalEmbed()) {
    return embedLocalBatch(texts, taskType)
  }
  const CONCURRENCY = 5
  const results: Float32Array[] = new Array(texts.length)
  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const chunk = texts.slice(i, i + CONCURRENCY)
    const vecs = await Promise.all(chunk.map(t => embedSingle(t, apiKey, 2, taskType)))
    for (let j = 0; j < chunk.length; j++) results[i + j] = vecs[j]
  }
  return results
}

// ── Reciprocal Rank Fusion (RRF) ─────────────────────────────────────────────

/**
 * 서로 다른 스코어 분포를 가진 랭킹 리스트를 순위 기반으로 합산합니다.
 * ranks: 각 랭킹 리스트에서의 순위 (1-based). 리스트에 없으면 Infinity.
 * k: 감쇠 파라미터 (기본 60). 높을수록 순위 차이에 둔감.
 */
export function rrfScore(ranks: number[], k = 60): number {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0)
}

// ── 코사인 유사도 ─────────────────────────────────────────────────────────────

function cosineSim(a: Float32Array, b: Float32Array): number {
  // 차원 불일치 방어 — 임베딩 제공자가 바뀌면(로컬 1024 ↔ Gemini 3072)
  // 캐시와 쿼리 벡터의 차원이 달라진다. 조용히 틀린 점수를 내지 않고 0을 반환한다.
  if (a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

// ── Public API (singleton) ────────────────────────────────────────────────────

export const vectorEmbedIndex = {
  get isBuilt(): boolean { return _state.built },
  get isBuilding(): boolean { return _state.building },
  get progress(): number { return _state.progress },
  get size(): number { return _state.embeddings.size },
  get lastError(): string | null { return _state.lastError },

  /**
   * 증분 빌드: 변경된 문서만 재임베딩합니다.
   * 1. 캐시 로드 → mtime 비교로 유효/무효 분류
   * 2. 무효 문서만 API 호출하여 임베딩 생성
   * 3. 유효 캐시 + 새 임베딩 머지하여 저장
   */
  async buildIncremental(
    docs: LoadedDocument[],
    apiKey: string,
    vaultPath: string,
  ): Promise<void> {
    if (_state.building) return
    _state.building = true
    _state.progress = 0
    _state.lastError = null
    const myGen = ++_state.generation  // 새 세대 번호 할당

    try {
      const docMtimes = buildDocMtimes(docs)

      // 1) 캐시 로드 — 변경되지 않은 문서의 임베딩 복원
      const provider = activeEmbedProvider()
      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(vaultPath, docMtimes, provider)
      if (_state.generation !== myGen) return

      // sectionDocMap 구축 (캐시 저장용)
      const sectionDocMap = new Map<string, string>()
      const allItems = extractEmbedItems(docs)
      for (const item of allItems) {
        sectionDocMap.set(item.id, item.docId)
      }

      // 2) stale 문서가 없으면 캐시 100% 히트 — 즉시 완료
      if (staleDocIds.size === 0 && cached.size > 0) {
        _state.embeddings = cached
        _state.sectionDocMap = sectionDocMap
        _state.built = true
        _state.progress = 100
        logger.debug(`[vector] 캐시 100% 히트: ${cached.size}개 임베딩 복원`)
        return
      }

      // 3) 변경된 문서만 추출하여 임베딩
      const staleItems = allItems.filter(it => staleDocIds.has(it.docId))
      const totalItems = allItems.length
      const cachedCount = totalItems - staleItems.length

      logger.debug(`[vector] 증분 빌드: 캐시 ${cachedCount}개 유지, ${staleItems.length}개 재임베딩`)

      // 캐시된 부분의 진행률 반영
      _state.progress = totalItems > 0 ? Math.round((cachedCount / totalItems) * 100) : 0

      const newEmbeddings = new Map(cached)  // 캐시 엔트리를 기반으로 시작
      let processed = cachedCount
      let firstError: string | null = null
      /**
       * 임베딩에 실패한 항목이 속한 문서. 저장 시 docMtimes 에서 제외해
       * 다음 실행에 stale 로 다시 잡히게 한다.
       *
       * 예전에는 실패한 배치를 경고만 찍고 넘어간 뒤 "전체 문서의 현재 mtime"으로
       * 캐시를 저장했다. 그러면 다음 실행에서 살아남은 섹션이 mtime 일치로 판정되어
       * 문서가 staleDocIds 에서 빠지고, 실패한 섹션은 파일을 고치기 전까지
       * 영원히 재임베딩되지 않는다 (로그는 "캐시 100% 히트"라고 찍힌다).
       */
      const failedDocIds = new Set<string>()
      const BATCH = 20

      for (let i = 0; i < staleItems.length; i += BATCH) {
        if (_state.generation !== myGen) return

        const batch = staleItems.slice(i, i + BATCH)
        const texts = batch.map(it => it.text)

        try {
          const vecs = await embedBatch(texts, apiKey, 'RETRIEVAL_DOCUMENT')
          for (let j = 0; j < batch.length; j++) {
            newEmbeddings.set(batch[j].id, vecs[j])
            sectionDocMap.set(batch[j].id, batch[j].docId)
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          logger.warn(`[vector] 배치 임베딩 실패 (${i}~${i + BATCH}):`, msg)
          if (!firstError) firstError = msg
          for (const it of batch) failedDocIds.add(it.docId)
          // 첫 배치 실패 시 중단 — API 키 오류 가능성이 높음
          if (i === 0) {
            // 남은 항목도 시도하지 않으므로 전부 실패로 표시한다
            for (const it of staleItems.slice(i + BATCH)) failedDocIds.add(it.docId)
            _state.lastError = cached.size > 0
              ? `일부 API 오류: ${msg}`
              : `API 오류: ${msg}`
            break
          }
        }

        processed += batch.length
        _state.progress = Math.round((processed / totalItems) * 100)

        // Rate limit 방지
        if (i + BATCH < staleItems.length) await new Promise(r => setTimeout(r, 100))
      }

      if (_state.generation !== myGen) return

      _state.embeddings = newEmbeddings
      _state.sectionDocMap = sectionDocMap
      // 실패 항목이 하나라도 있으면 인덱스는 불완전하다 — built 로 표시하지 않는다
      _state.built = newEmbeddings.size > 0 && failedDocIds.size === 0
      _state.progress = 100

      if (newEmbeddings.size > 0) {
        if (firstError) _state.lastError = `일부 실패 (${newEmbeddings.size}개 성공): ${firstError}`
        // 실패한 문서는 mtime 기록에서 빼서 다음 실행에 stale 로 잡히게 한다
        const saveMtimes = failedDocIds.size === 0
          ? docMtimes
          : new Map([...docMtimes].filter(([id]) => !failedDocIds.has(id)))
        if (failedDocIds.size > 0) {
          logger.warn(`[vector] ${failedDocIds.size}개 문서를 캐시 mtime 에서 제외 — 다음 실행에 재시도`)
        }
        saveVectorEmbedCacheIncremental(vaultPath, newEmbeddings, sectionDocMap, saveMtimes, provider)
          .catch((e: unknown) => logger.warn('[vector] 캐시 저장 실패:', e))
        logger.debug(`[vector] 임베딩 완료: ${newEmbeddings.size}개 섹션/문서`)
      } else if (!_state.lastError) {
        _state.lastError = firstError ?? '알 수 없는 오류 — 브라우저 콘솔 확인'
      }
    } finally {
      if (_state.generation === myGen) _state.building = false
    }
  },

  /**
   * 전체 재빌드 (캐시 삭제 후). 설정 UI에서 수동 실행 시 사용.
   */
  async buildFull(
    docs: LoadedDocument[],
    apiKey: string,
    vaultPath: string,
  ): Promise<void> {
    resetLocalEmbedProbe()  // 서버를 나중에 띄웠을 수 있으므로 재확인
    await invalidateVectorEmbedCache(vaultPath)
    this.reset()
    return this.buildIncremental(docs, apiKey, vaultPath)
  },

  /**
   * 전체 임베딩 대상 벡터 검색 (순수 의미 유사도).
   * 섹션 벡터와 쿼리를 비교한 뒤 문서 단위로 집계 (max score).
   * 인덱스 미빌드 또는 API 실패 시 null 반환 → 호출 측에서 BM25 폴백.
   */
  async fullVectorSearch(
    query: string,
    apiKey: string,
    topK: number,
    docs: LoadedDocument[],
  ): Promise<SearchResult[] | null> {
    if (!_state.built || _state.embeddings.size === 0) return null

    let queryVec: Float32Array
    try {
      queryVec = (await embedBatch([queryText(query)], apiKey, 'RETRIEVAL_QUERY'))[0]
    } catch {
      return null
    }

    // 문서 메타데이터 맵 (id → doc)
    const docMap = new Map(docs.map(d => [d.id, d]))

    // sectionId → docId 매핑 + 섹션 메타
    const sectionDocMapping = new Map<string, { docId: string; section: DocSection | null }>()
    for (const doc of docs) {
      if (doc.sections.length > SECTION_EMBED_THRESHOLD) {
        for (const sec of doc.sections) {
          sectionDocMapping.set(sec.id, { docId: doc.id, section: sec })
        }
      } else {
        // 문서 단위 폴백 — 키가 docId
        sectionDocMapping.set(doc.id, { docId: doc.id, section: null })
      }
    }

    // 섹션별 유사도 계산 후 문서 단위 max score 집계
    const docScores = new Map<string, { score: number; section: DocSection | null }>()
    for (const [embKey, embVec] of _state.embeddings) {
      const mapping = sectionDocMapping.get(embKey)
      if (!mapping) continue
      const sim = cosineSim(queryVec, embVec)
      if (sim <= 0) continue
      const prev = docScores.get(mapping.docId)
      if (!prev || sim > prev.score) {
        docScores.set(mapping.docId, { score: sim, section: mapping.section })
      }
    }

    const scored: SearchResult[] = []
    for (const [docId, { score, section }] of docScores) {
      const doc = docMap.get(docId)
      if (!doc) continue
      scored.push({
        doc_id: docId,
        filename: doc.filename,
        section_id: section?.id ?? null,
        heading: section?.heading ?? null,
        speaker: doc.speaker ?? '',
        content: section?.body ?? doc.sections[0]?.body ?? doc.rawContent?.slice(0, 500) ?? '',
        score,
        tags: doc.tags ?? [],
      })
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
  },

  /** 볼트 전환 시 상태 초기화 */
  reset(): void {
    _state.generation++  // 진행 중인 빌드를 무효화
    _state.embeddings = new Map()
    _state.sectionDocMap = new Map()
    _state.built = false
    _state.building = false
    _state.progress = 0
    _state.lastError = null
  },
}
