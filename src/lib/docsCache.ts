/**
 * docsCache.ts — IndexedDB persistence for parsed vault documents.
 *
 * 볼트가 바뀌지 않았으면 IPC 파일 로드 + gray-matter 파싱 전체를 건너뜁니다.
 * folders + imageRegistry도 함께 캐시하여 두 번째 시작 시 loadFiles IPC 자체를 건너뜁니다.
 *
 * Cache key  : vaultPath
 * Invalidation: mtime 기반 fingerprint가 달라지면 miss
 */

import type { LoadedDocument } from '@/types'
import { logger } from './logger'

const DB_NAME = 'rembrandt-docs-cache'
const STORE   = 'docs'
const DB_VERSION = 1
const SCHEMA_VERSION = 2  // v2: folders + imageRegistry 포함

type ImageRegistry = Record<string, { relativePath: string; absolutePath: string }>

interface DocsCacheEntry {
  schemaVersion: number
  fingerprint:   string
  docs:          LoadedDocument[]
  folders:       string[]
  imageRegistry: ImageRegistry | null
}

export interface DocsCacheResult {
  docs:          LoadedDocument[]
  folders:       string[]
  imageRegistry: ImageRegistry | null
}

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
    req.onsuccess  = () => resolve(req.result)
    req.onerror    = () => { _dbPromise = null; reject(req.error) }
  })
  return _dbPromise
}

// ── Path normalization ─────────────────────────────────────────────────────

/** 경로 구분자 통일 + 트레일 슬래시 제거 → IDB 키 일관성 확보 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/$/, '')
}

// ── Fingerprint ────────────────────────────────────────────────────────────

/** mtime 기반 지문: 파일 추가/삭제/수정 감지 */
export function buildDocsFingerprint(
  meta: { relativePath: string; mtime: number }[]
): string {
  return [...meta]
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : 1)
    .map(m => `${m.relativePath}:${m.mtime}`)
    .join('|')
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function loadDocsCache(
  vaultPath: string,
  fingerprint: string,
): Promise<DocsCacheResult | null> {
  try {
    const db  = await openDB()
    const tx  = db.transaction(STORE, 'readonly')
    const raw = await new Promise<unknown>((res, rej) => {
      const req = tx.objectStore(STORE).get(normalizePath(vaultPath))
      req.onsuccess = () => res(req.result)
      req.onerror   = () => rej(req.error)
    })
    if (!raw || typeof raw !== 'object') return null
    const cached = raw as DocsCacheEntry
    if (cached.schemaVersion !== SCHEMA_VERSION) return null
    if (cached.fingerprint   !== fingerprint)     return null
    if (!Array.isArray(cached.docs))              return null
    logger.debug(`[docsCache] 캐시 히트 (${cached.docs.length}개 문서, loadFiles 건너뜀)`)
    return { docs: cached.docs, folders: cached.folders ?? [], imageRegistry: cached.imageRegistry ?? null }
  } catch (err) {
    logger.warn('[docsCache] 캐시 읽기 실패:', err)
    return null
  }
}

export async function saveDocsCache(
  vaultPath:    string,
  fingerprint:  string,
  docs:         LoadedDocument[],
  folders:      string[],
  imageRegistry: ImageRegistry | null,
): Promise<void> {
  try {
    const db    = await openDB()
    const entry: DocsCacheEntry = { schemaVersion: SCHEMA_VERSION, fingerprint, docs, folders, imageRegistry }
    await new Promise<void>((res, rej) => {
      const tx  = db.transaction(STORE, 'readwrite')
      const req = tx.objectStore(STORE).put(entry, normalizePath(vaultPath))
      req.onsuccess = () => res()
      req.onerror   = () => rej(req.error)
    })
    logger.debug(`[docsCache] 캐시 저장 완료 (${docs.length}개 문서)`)
  } catch (err) {
    logger.warn('[docsCache] 캐시 저장 실패:', err)
  }
}
