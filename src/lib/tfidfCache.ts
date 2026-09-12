/**
 * tfidfCache.ts — IndexedDB persistence for the TF-IDF index.
 *
 * 볼트를 다시 열 때 파일이 바뀌지 않았으면 재계산 없이 캐시를 복원합니다.
 *
 * Cache key : vaultPath (string)
 * Invalidation : docs 목록의 id + mtime 지문(fingerprint)이 달라지면 miss
 * Schema version : SerializedTfIdf.schemaVersion 이 다르면 miss
 *
 * 캐시에는 사전 계산된 `implicitLinks` 도 함께 저장된다. 지문이 같으면 문서와
 * WikiLink 도 같으므로 O(N²) 묵시적 링크 탐색을 실행마다 반복할 필요가 없다.
 * (실측 64초 → 0초)
 */

import type { SerializedTfIdf } from './graphAnalysis'
import { TFIDF_SCHEMA_VERSION } from './graphAnalysis'
import type { LoadedDocument } from '@/types'
import { logger } from './logger'

const DB_NAME = 'rembrandt-tfidf-cache'
const STORE = 'index'
const DB_VERSION = 1

// ── IndexedDB singleton ────────────────────────────────────────────────────

let _dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => { _dbPromise = null; reject(req.error) }
  })
  return _dbPromise
}

async function idbGet(db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    const req = tx.objectStore(STORE).put(value, key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

// ── Fingerprint ────────────────────────────────────────────────────────────

/**
 * 볼트 문서 목록으로부터 캐시 유효성 검사용 지문을 생성합니다.
 * 파일이 추가/삭제/수정되면 지문이 달라져 캐시 미스가 발생합니다.
 */
export function buildFingerprint(docs: LoadedDocument[]): string {
  return [...docs]
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(d => `${encodeURIComponent(d.id)}:${d.mtime ?? 0}`)
    .join('|')
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * IndexedDB에서 TF-IDF 캐시를 읽습니다.
 * 캐시 미스(없음 / 지문 불일치 / 스키마 버전 불일치) 시 null을 반환합니다.
 */
export async function loadTfIdfCache(
  vaultPath: string,
  fingerprint: string,
): Promise<SerializedTfIdf | null> {
  try {
    const db = await openDB()
    const raw = await idbGet(db, vaultPath)
    if (!raw || typeof raw !== 'object') return null
    const cached = raw as SerializedTfIdf
    if (cached.schemaVersion !== TFIDF_SCHEMA_VERSION) return null
    if (typeof cached.fingerprint !== 'string') return null
    if (!Array.isArray(cached.docs) || !cached.idf || typeof cached.idf !== 'object') return null
    if (cached.fingerprint !== fingerprint) return null
    return cached
  } catch (err) {
    logger.warn('[tfidfCache] 캐시 읽기 실패:', err)
    return null
  }
}

/**
 * 특정 볼트의 TF-IDF 캐시를 IndexedDB에서 삭제합니다.
 * Edit Agent가 파일을 수정한 후 호출 → 다음 검색 시 인덱스 재빌드.
 */
export async function invalidateTfIdfCache(vaultPath: string): Promise<void> {
  try {
    const db = await openDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      const req = tx.objectStore(STORE).delete(vaultPath)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
    logger.debug('[tfidfCache] 캐시 무효화 완료')
  } catch (err) {
    logger.warn('[tfidfCache] 캐시 무효화 실패:', err)
  }
}

/**
 * TF-IDF 인덱스를 IndexedDB에 저장합니다.
 * 실패해도 앱 동작에는 영향 없음 (경고 로그만 출력).
 */
export async function saveTfIdfCache(
  vaultPath: string,
  data: SerializedTfIdf,
): Promise<void> {
  try {
    const db = await openDB()
    await idbPut(db, vaultPath, data)
    logger.debug(`[tfidfCache] 캐시 저장 완료 (${data.docs.length}개 문서, 묵시적 링크 ${data.implicitLinks?.length ?? 0}개)`)
  } catch (err) {
    logger.warn('[tfidfCache] 캐시 저장 실패:', err)
  }
}
