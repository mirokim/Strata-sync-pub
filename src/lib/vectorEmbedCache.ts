/**
 * vectorEmbedCache.ts — File-based vector embedding cache (v5: incremental cache)
 *
 * Up to v4 the whole-fingerprint match approach meant editing a single document triggered a full rebuild.
 * From v5, per-document mtimes are stored individually so only changed documents are re-embedded.
 *
 * The vault loader ignores dot files, so the cache is not exposed in the vault document list.
 */

/** Individual embedding entry — vector per sectionId + mtime of the owning document */
interface CacheEntry {
  embedding: number[]
  docId: string
  mtime: number
}

/** Embedding provider — recorded in the cache because dimension and vector space differ per provider. */
export type EmbedProvider = 'gemini' | 'local'

interface VectorCacheV6 {
  version: 6
  /** chunker version — bump this when parseSections logic changes → automatic invalidation */
  chunkerVersion: number
  /**
   * Embedding provider and dimension. If absent, the cache is treated as an old version and invalidated.
   *
   * Without this, switching providers leaves mtimes unchanged so the cache restores with a 100% hit rate,
   * only the query vector has a different dimension, and every similarity becomes 0 — vector search dies silently.
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
 * Loads the cache and returns only the entries still valid against the current document list.
 * @returns { cached: map of valid embeddings, staleDocIds: document IDs that need re-embedding }
 */
export async function loadVectorEmbedCacheIncremental(
  vaultPath: string,
  docMtimes: Map<string, number>,  // docId → mtime
  provider?: EmbedProvider,        // currently active provider — full rebuild on mismatch
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
    // Full rebuild on chunker version mismatch (section ID scheme differs)
    if (record.version !== 6 || !record.entries) return result
    if (record.chunkerVersion !== CHUNKER_VERSION) return result
    // Full rebuild on provider mismatch (different vector space and dimension)
    if (provider && record.provider !== provider) {
      logger.debug(`[vector] Embedding provider changed (${record.provider ?? 'unrecorded'} → ${provider}) — full rebuild`)
      return result
    }

    // Validate against the docId → current mtime mapping
    const freshDocIds = new Set<string>()

    for (const [sectionId, entry] of Object.entries(record.entries)) {
      const currentMtime = docMtimes.get(entry.docId)
      // Cache entry is valid if the document exists and the mtime matches
      if (currentMtime !== undefined && currentMtime === entry.mtime) {
        result.cached.set(sectionId, new Float32Array(entry.embedding))
        freshDocIds.add(entry.docId)
      }
    }

    // staleDocIds = all documents - documents validly restored from cache
    result.staleDocIds = new Set(
      [...docMtimes.keys()].filter(id => !freshDocIds.has(id)),
    )
  } catch {
    // Cache parse failure → full rebuild
  }

  return result
}

/**
 * Incremental save: merges new embeddings into the existing cache and saves.
 * Entries for deleted documents (not in docMtimes) are cleaned up.
 */
export async function saveVectorEmbedCacheIncremental(
  vaultPath: string,
  embeddings: Map<string, Float32Array>,
  sectionDocMap: Map<string, string>,  // sectionId → docId
  docMtimes: Map<string, number>,      // docId → mtime
  provider?: EmbedProvider,            // provider that produced this cache
): Promise<void> {
  if (!vaultPath) return
  try {
    const entries: Record<string, CacheEntry> = {}
    for (const [sectionId, vec] of embeddings) {
      const docId = sectionDocMap.get(sectionId)
      if (!docId) continue
      const mtime = docMtimes.get(docId)
      if (mtime === undefined) continue  // skip deleted documents
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
    // Cache save failure is silent
  }
}

/** Delete the cache file (only used for a full reset) */
export async function invalidateVectorEmbedCache(vaultPath: string): Promise<void> {
  if (!vaultPath) return
  try {
    await window.vaultAPI?.deleteFile(cachePath(vaultPath))
  } catch {
    // silent
  }
  // Also clean up the legacy v4 cache
  try {
    await window.vaultAPI?.deleteFile(oldCachePath(vaultPath))
  } catch {
    // silent
  }
}
