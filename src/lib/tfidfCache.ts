/**
 * tfidfCache.ts — IndexedDB persistence for the TF-IDF index.
 *
 * When the vault is reopened and no files have changed, the cache is restored without recomputation.
 *
 * Cache key : vaultPath (string)
 * Invalidation : miss when the id + mtime fingerprint of the docs list differs
 * Schema version : miss when SerializedTfIdf.schemaVersion differs
 *
 * The cache also stores the precomputed `implicitLinks`. If the fingerprint matches, the
 * documents and WikiLinks are the same too, so the O(N²) implicit link search need not be repeated on every run.
 * (measured: 64s → 0s)
 */

import type { SerializedTfIdf } from './graphAnalysis'
import { TFIDF_SCHEMA_VERSION } from './graphAnalysis'
import type { LoadedDocument } from '@/types'
import { logger } from './logger'

const DB_NAME = 'strata-sync-tfidf-cache'
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
 * Builds a fingerprint from the vault document list for cache validation.
 * Adding/removing/modifying a file changes the fingerprint and causes a cache miss.
 */
export function buildFingerprint(docs: LoadedDocument[]): string {
  return [...docs]
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(d => `${encodeURIComponent(d.id)}:${d.mtime ?? 0}`)
    .join('|')
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Reads the TF-IDF cache from IndexedDB.
 * Returns null on cache miss (absent / fingerprint mismatch / schema version mismatch).
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
    logger.warn('[tfidfCache] Failed to read cache:', err)
    return null
  }
}

/**
 * Deletes a specific vault's TF-IDF cache from IndexedDB.
 * Called after the Edit Agent modifies files → index is rebuilt on the next search.
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
    logger.debug('[tfidfCache] Cache invalidated')
  } catch (err) {
    logger.warn('[tfidfCache] Failed to invalidate cache:', err)
  }
}

/**
 * Saves the TF-IDF index to IndexedDB.
 * Failure does not affect app behavior (only a warning is logged).
 */
export async function saveTfIdfCache(
  vaultPath: string,
  data: SerializedTfIdf,
): Promise<void> {
  try {
    const db = await openDB()
    await idbPut(db, vaultPath, data)
    logger.debug(`[tfidfCache] Cache saved (${data.docs.length} docs, ${data.implicitLinks?.length ?? 0} implicit links)`)
  } catch (err) {
    logger.warn('[tfidfCache] Failed to save cache:', err)
  }
}
