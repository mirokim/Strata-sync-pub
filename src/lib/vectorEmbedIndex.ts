/**
 * vectorEmbedIndex.ts — Vector embedding index (v3: incremental build)
 *
 * Up to v2 the whole-fingerprint match approach meant editing a single document triggered a full rebuild.
 * From v3, per-document mtime comparison re-embeds only changed documents.
 *
 * Documents with 2+ sections are embedded per section; single-section documents are embedded as a whole.
 * Built in the background after vault load and stored in a file cache.
 *
 * Usage flow:
 *   1. After vault load → buildIncremental(docs, apiKey, vaultPath)
 *   2. On search → fullVectorSearch(query, apiKey, topK, docs)
 */

import type { LoadedDocument, DocSection, SearchResult } from '@/types'
import { loadVectorEmbedCacheIncremental, saveVectorEmbedCacheIncremental, invalidateVectorEmbedCache } from './vectorEmbedCache'
import type { EmbedProvider } from './vectorEmbedCache'
import { logger } from './logger'

/**
 * Documents with more sections than this are embedded per section; at or below, as a whole document.
 *
 * When it was 3, the vault's median section count was exactly 3, so 58.4% of documents
 * took the "whole document = 1 vector" path — the longer the document, the more its details were diluted.
 * Lowered to 1 so any document with 2+ sections is embedded per section.
 */
const SECTION_EMBED_THRESHOLD = 1

/**
 * Embedding text slice limit (chars).
 * Server MAXLEN 4096 tokens × Korean 1 token ≈ 1.2 chars ≈ 4,900 chars. Cut at 4,500 to be safe.
 */
const EMBED_TEXT_MAX_CHARS = 4500

// ── Internal state ───────────────────────────────────────────────────────────

interface EmbedState {
  embeddings: Map<string, Float32Array>  // sectionId → embedding vector (Float32 for 50% memory saving)
  sectionDocMap: Map<string, string>     // sectionId → docId (for cache saving)
  built: boolean
  building: boolean
  progress: number  // 0~100
  lastError: string | null
  generation: number  // incremented on every reset() — prevents a stale build from overwriting results
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

// ── Section/document text extraction ─────────────────────────────────────────

// The boilerplate prefixes (docTypePrefix / queryPrefix) were removed.
//   - There are 1,184 type: spec documents (45% of the vault), so that much embedding text
//     literally began with "게임 기획 문서: " (game design document). Every section of the same document
//     shared the identical prefix, so sections could not be distinguished during document-level max-pooling.
//   - Removing queryPrefix alone improved Recall@5 from 3/6 → 5/6.
//   - Removing it on only one side (document/query) skews the distribution and makes things worse. Always keep them together.
//   - tags/speaker are already used in search filters/boosts, so they are left out of the embedding text.

/** Section-level embedding text: document title + section heading + body */
function sectionText(section: DocSection, doc: LoadedDocument): string {
  const title = doc.filename.replace(/\.md$/i, '')
  return `${title}\n${section.heading}\n${section.body}`.slice(0, EMBED_TEXT_MAX_CHARS)
}

/** Whole document as a single vector — fallback for documents with SECTION_EMBED_THRESHOLD or fewer sections */
function docText(doc: LoadedDocument): string {
  const title = doc.filename.replace(/\.md$/i, '')
  const body = doc.sections.map(s => `${s.heading}\n${s.body}`).join('\n\n')
  return `${title}\n${body}`.slice(0, EMBED_TEXT_MAX_CHARS)
}

/** Query text — raw, without a prefix (matches the distribution on the document side) */
function queryText(query: string): string {
  return query
}

/** Embedding unit: per section if sections exceed SECTION_EMBED_THRESHOLD, otherwise per document */
interface EmbedItem { id: string; text: string; docId: string }

function extractEmbedItems(docs: LoadedDocument[]): EmbedItem[] {
  const items: EmbedItem[] = []
  for (const doc of docs) {
    if (doc.sections.length > SECTION_EMBED_THRESHOLD) {
      for (const sec of doc.sections) {
        items.push({ id: sec.id, text: sectionText(sec, doc), docId: doc.id })
      }
    } else {
      // Sections at or below the threshold — document level (key is docId)
      items.push({ id: doc.id, text: docText(doc), docId: doc.id })
    }
  }
  return items
}

/** Build a docId → mtime map from the document list */
function buildDocMtimes(docs: LoadedDocument[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const doc of docs) {
    map.set(doc.id, doc.mtime ?? 0)
  }
  return map
}

// ── Google Gemini embedding API (gemini-embedding-001, 3072 dims) ─────────────

/** Gemini taskType — distinguishing query/document improves embedding quality */
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

// ── Local embedding server (BGE-M3, 1024 dims) ───────────────────────────────
//
// If scripts/local_embed_server.py is running, it is used instead of Gemini.
// Internal documents never leave for an external API, and there is no cost.
//
// Note: the cache (.vector_cache_v6.json) and queries must be produced by the same provider.
// Mixing providers changes the dimension, so cosineSim is guarded to return 0.

const LOCAL_EMBED_URL = 'http://127.0.0.1:8077'
const LOCAL_PROBE_TIMEOUT_MS = 1500

/** null = not checked yet */
let _localEmbedAvailable: boolean | null = null

/** Check local server availability (once per process) */
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
      logger.debug(`[vector] Using local embedding server: ${info.model} (${info.dim} dims)`)
    }
  } catch {
    _localEmbedAvailable = false
  }
  return _localEmbedAvailable
}

/** Reset the availability cache — for re-checking when the server is started later */
export function resetLocalEmbedProbe(): void {
  _localEmbedAvailable = null
}

/**
 * Whether embeddings can be produced — true if the local server is up or a Gemini key exists.
 *
 * If call sites gate only on the presence of a Gemini key, a user who runs only the local server
 * without a key (= exactly the case this feature targets) never gets an index built at all.
 * Always gate through this function.
 */
export async function isEmbeddingReady(apiKey?: string): Promise<boolean> {
  if (await probeLocalEmbed()) return true
  return Boolean(apiKey?.trim())
}

/** Last probe result (synchronous). false before probing. For UI display. */
export function isLocalEmbedReadySync(): boolean {
  return _localEmbedAvailable === true
}

/** Currently active embedding provider — used to decide cache invalidation. */
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
  if (!res.ok) throw new Error(`Local embedding server ${res.status}`)
  const json = await res.json() as { embeddings: number[][] }
  return json.embeddings.map(v => new Float32Array(v))
}

/**
 * Embeds an array of texts.
 * Uses the local server if it is up, otherwise the Gemini API.
 * Local mode does not fall back to Gemini — mixing dimensions would invalidate the cache.
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
 * Combines ranking lists with different score distributions by rank.
 * ranks: rank in each ranking list (1-based). Infinity if absent from a list.
 * k: decay parameter (default 60). Higher = less sensitive to rank differences.
 */
export function rrfScore(ranks: number[], k = 60): number {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0)
}

// ── Cosine similarity ────────────────────────────────────────────────────────

function cosineSim(a: Float32Array, b: Float32Array): number {
  // Dimension mismatch guard — when the embedding provider changes (local 1024 ↔ Gemini 3072)
  // the cache and query vector dimensions differ. Return 0 instead of silently producing wrong scores.
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
   * Incremental build: re-embeds only changed documents.
   * 1. Load cache → classify valid/stale by mtime comparison
   * 2. Call the API only for stale documents to generate embeddings
   * 3. Merge valid cache + new embeddings and save
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
    const myGen = ++_state.generation  // assign a new generation number

    try {
      const docMtimes = buildDocMtimes(docs)

      // 1) Load cache — restore embeddings of unchanged documents
      const provider = activeEmbedProvider()
      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(vaultPath, docMtimes, provider)
      if (_state.generation !== myGen) return

      // Build sectionDocMap (for cache saving)
      const sectionDocMap = new Map<string, string>()
      const allItems = extractEmbedItems(docs)
      for (const item of allItems) {
        sectionDocMap.set(item.id, item.docId)
      }

      // 2) No stale documents means a 100% cache hit — done immediately
      if (staleDocIds.size === 0 && cached.size > 0) {
        _state.embeddings = cached
        _state.sectionDocMap = sectionDocMap
        _state.built = true
        _state.progress = 100
        logger.debug(`[vector] 100% cache hit: restored ${cached.size} embeddings`)
        return
      }

      // 3) Extract only changed documents and embed them
      const staleItems = allItems.filter(it => staleDocIds.has(it.docId))
      const totalItems = allItems.length
      const cachedCount = totalItems - staleItems.length

      logger.debug(`[vector] Incremental build: keeping ${cachedCount} cached, re-embedding ${staleItems.length}`)

      // Reflect the cached portion in the progress
      _state.progress = totalItems > 0 ? Math.round((cachedCount / totalItems) * 100) : 0

      const newEmbeddings = new Map(cached)  // start from the cached entries
      let processed = cachedCount
      let firstError: string | null = null
      /**
       * Documents containing items whose embedding failed. Excluded from docMtimes on save
       * so they are picked up as stale again on the next run.
       *
       * Previously a failed batch was only logged as a warning and then the cache was saved with
       * "the current mtime of every document". On the next run the surviving sections were judged
       * as mtime-matching, the document dropped out of staleDocIds, and the failed sections were
       * never re-embedded until the file was touched (while the log said "100% cache hit").
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
          logger.warn(`[vector] Batch embedding failed (${i}~${i + BATCH}):`, msg)
          if (!firstError) firstError = msg
          for (const it of batch) failedDocIds.add(it.docId)
          // Abort on first-batch failure — likely an API key error
          if (i === 0) {
            // The remaining items will not be attempted either, so mark them all as failed
            for (const it of staleItems.slice(i + BATCH)) failedDocIds.add(it.docId)
            _state.lastError = cached.size > 0
              ? `Partial API error: ${msg}`
              : `API error: ${msg}`
            break
          }
        }

        processed += batch.length
        _state.progress = Math.round((processed / totalItems) * 100)

        // Avoid rate limits
        if (i + BATCH < staleItems.length) await new Promise(r => setTimeout(r, 100))
      }

      if (_state.generation !== myGen) return

      _state.embeddings = newEmbeddings
      _state.sectionDocMap = sectionDocMap
      // If any item failed, the index is incomplete — do not mark it as built
      _state.built = newEmbeddings.size > 0 && failedDocIds.size === 0
      _state.progress = 100

      if (newEmbeddings.size > 0) {
        if (firstError) _state.lastError = `Partial failure (${newEmbeddings.size} succeeded): ${firstError}`
        // Remove failed documents from the mtime record so they are picked up as stale on the next run
        const saveMtimes = failedDocIds.size === 0
          ? docMtimes
          : new Map([...docMtimes].filter(([id]) => !failedDocIds.has(id)))
        if (failedDocIds.size > 0) {
          logger.warn(`[vector] Excluded ${failedDocIds.size} documents from cache mtimes — will retry on next run`)
        }
        saveVectorEmbedCacheIncremental(vaultPath, newEmbeddings, sectionDocMap, saveMtimes, provider)
          .catch((e: unknown) => logger.warn('[vector] Failed to save cache:', e))
        logger.debug(`[vector] Embedding complete: ${newEmbeddings.size} sections/documents`)
      } else if (!_state.lastError) {
        _state.lastError = firstError ?? 'Unknown error — check the browser console'
      }
    } finally {
      if (_state.generation === myGen) _state.building = false
    }
  },

  /**
   * Full rebuild (after deleting the cache). Used for manual runs from the settings UI.
   */
  async buildFull(
    docs: LoadedDocument[],
    apiKey: string,
    vaultPath: string,
  ): Promise<void> {
    resetLocalEmbedProbe()  // re-check, since the server may have been started later
    await invalidateVectorEmbedCache(vaultPath)
    this.reset()
    return this.buildIncremental(docs, apiKey, vaultPath)
  },

  /**
   * Vector search over all embeddings (pure semantic similarity).
   * Compares section vectors against the query, then aggregates per document (max score).
   * Returns null if the index is not built or the API fails → caller falls back to BM25.
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

    // Document metadata map (id → doc)
    const docMap = new Map(docs.map(d => [d.id, d]))

    // sectionId → docId mapping + section metadata
    const sectionDocMapping = new Map<string, { docId: string; section: DocSection | null }>()
    for (const doc of docs) {
      if (doc.sections.length > SECTION_EMBED_THRESHOLD) {
        for (const sec of doc.sections) {
          sectionDocMapping.set(sec.id, { docId: doc.id, section: sec })
        }
      } else {
        // Document-level fallback — key is docId
        sectionDocMapping.set(doc.id, { docId: doc.id, section: null })
      }
    }

    // Compute per-section similarity, then aggregate the max score per document
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

  /** Reset state on vault switch */
  reset(): void {
    _state.generation++  // invalidate any in-progress build
    _state.embeddings = new Map()
    _state.sectionDocMap = new Map()
    _state.built = false
    _state.building = false
    _state.progress = 0
    _state.lastError = null
  },
}
