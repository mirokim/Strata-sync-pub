/**
 * vectorEmbedCache.ts — 파일 기반 벡터 임베딩 캐시 (v5: 증분 캐시)
 *
 * v4까지는 전체 fingerprint 일치 방식 → 문서 1개만 수정해도 전량 재빌드.
 * v5부터 문서별 mtime을 개별 저장하여, 변경된 문서만 재임베딩합니다.
 *
 * dot 파일은 vault 로더가 무시하므로 볼트 문서 목록에 노출되지 않습니다.
 */

/** 개별 임베딩 엔트리 — sectionId별 벡터 + 소속 문서의 mtime */
interface CacheEntry {
  embedding: number[]
  docId: string
  mtime: number
}

/** 임베딩 제공자 — 제공자마다 차원과 벡터 공간이 다르므로 캐시에 기록한다. */
export type EmbedProvider = 'gemini' | 'local'

interface VectorCacheV6 {
  version: 6
  /** chunker 버전 — parseSections 로직이 바뀌면 이 값 상승 → 자동 무효화 */
  chunkerVersion: number
  /**
   * 임베딩 제공자와 차원. 없으면 구버전 캐시로 보고 무효화한다.
   *
   * 이게 없으면 제공자를 바꿔도 mtime 이 그대로라 캐시가 100% 히트로 복원되고,
   * 쿼리 벡터만 차원이 달라져 모든 유사도가 0 이 된다 — 경고 없이 벡터 검색이 죽는다.
   */
  provider?: EmbedProvider
  dim?: number
  /** sectionId → { embedding, docId, mtime } */
  entries: Record<string, CacheEntry>
}

import { CHUNKER_VERSION } from './markdownParser'
import { logger } from '@/lib/logger'

function cachePath(vaultPath: string): string {
  return `${vaultPath}/.vector_cache_v6.json`
}

function oldCachePath(vaultPath: string): string {
  return `${vaultPath}/.vector_cache_v5.json`
}

/**
 * 캐시를 로드하고, 현재 문서 목록과 비교하여 유효한 엔트리만 반환합니다.
 * @returns { cached: 유효한 임베딩 맵, staleDocIds: 재임베딩 필요한 문서 ID 목록 }
 */
export async function loadVectorEmbedCacheIncremental(
  vaultPath: string,
  docMtimes: Map<string, number>,  // docId → mtime
  provider?: EmbedProvider,        // 현재 활성 제공자 — 불일치 시 전량 재빌드
): Promise<{
  cached: Map<string, Float32Array>
  staleDocIds: Set<string>
}> {
  const result = { cached: new Map<string, Float32Array>(), staleDocIds: new Set(docMtimes.keys()) }
  if (!vaultPath) return result

  try {
    const raw = await window.vaultAPI?.readFile(cachePath(vaultPath))
    if (!raw) return result
    const record = JSON.parse(raw) as VectorCacheV6
    // chunker 버전 불일치 시 전량 재빌드 (section ID 체계가 달라짐)
    if (record.version !== 6 || !record.entries) return result
    if (record.chunkerVersion !== CHUNKER_VERSION) return result
    // 제공자 불일치 시 전량 재빌드 (벡터 공간과 차원이 다름)
    if (provider && record.provider !== provider) {
      logger.debug(`[vector] 임베딩 제공자 변경 (${record.provider ?? '미기록'} → ${provider}) — 전량 재빌드`)
      return result
    }

    // docId → 현재 mtime 매핑으로 유효성 검증
    const freshDocIds = new Set<string>()

    for (const [sectionId, entry] of Object.entries(record.entries)) {
      const currentMtime = docMtimes.get(entry.docId)
      // 문서가 존재하고 mtime이 같으면 캐시 유효
      if (currentMtime !== undefined && currentMtime === entry.mtime) {
        result.cached.set(sectionId, new Float32Array(entry.embedding))
        freshDocIds.add(entry.docId)
      }
    }

    // staleDocIds = 전체 문서 - 캐시에서 유효하게 복원된 문서
    result.staleDocIds = new Set(
      [...docMtimes.keys()].filter(id => !freshDocIds.has(id)),
    )
  } catch {
    // 캐시 파싱 실패 → 전량 재빌드
  }

  return result
}

/**
 * 증분 저장: 기존 캐시에 새 임베딩을 머지하여 저장합니다.
 * 삭제된 문서(docMtimes에 없는)의 엔트리는 정리됩니다.
 */
export async function saveVectorEmbedCacheIncremental(
  vaultPath: string,
  embeddings: Map<string, Float32Array>,
  sectionDocMap: Map<string, string>,  // sectionId → docId
  docMtimes: Map<string, number>,      // docId → mtime
  provider?: EmbedProvider,            // 이 캐시를 만든 제공자
): Promise<void> {
  if (!vaultPath) return
  try {
    const entries: Record<string, CacheEntry> = {}
    for (const [sectionId, vec] of embeddings) {
      const docId = sectionDocMap.get(sectionId)
      if (!docId) continue
      const mtime = docMtimes.get(docId)
      if (mtime === undefined) continue  // 삭제된 문서 제외
      entries[sectionId] = {
        embedding: Array.from(vec),
        docId,
        mtime,
      }
    }
    const dim = embeddings.values().next().value?.length
    const record: VectorCacheV6 = {
      version: 6,
      chunkerVersion: CHUNKER_VERSION,
      provider,
      dim,
      entries,
    }
    await window.vaultAPI?.saveFile(cachePath(vaultPath), JSON.stringify(record))
  } catch {
    // 캐시 저장 실패는 silent
  }
}

/** 캐시 파일 삭제 (전체 초기화 시에만 사용) */
export async function invalidateVectorEmbedCache(vaultPath: string): Promise<void> {
  if (!vaultPath) return
  try {
    await window.vaultAPI?.deleteFile(cachePath(vaultPath))
  } catch {
    // silent
  }
  // v4 구버전 캐시도 정리
  try {
    await window.vaultAPI?.deleteFile(oldCachePath(vaultPath))
  } catch {
    // silent
  }
}
