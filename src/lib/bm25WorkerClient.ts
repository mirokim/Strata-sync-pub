/**
 * bm25WorkerClient.ts — BM25 Web Worker client
 *
 * Delegates the heavy BM25 build / O(N²) implicit link computation to a worker thread.
 * The worker is created lazily on first call and reused for the app's lifetime.
 */

import type { SerializedTfIdf, ImplicitLink } from './graphAnalysis'
import type { LoadedDocument } from '@/types'

type WorkerResult =
  | { type: 'done';  requestId: string; serialized?: SerializedTfIdf; implicitLinks?: ImplicitLink[]; synonyms?: [string, string[]][] }
  | { type: 'error'; requestId: string; message: string }

let _worker: Worker | null = null
let _reqCounter = 0
const _pending = new Map<string, (err: Error) => void>()  // requestId → reject

function getWorker(): Worker {
  if (!_worker) {
    _worker = new Worker(new URL('../workers/bm25Worker.ts', import.meta.url), { type: 'module' })
    _worker.onerror = (e) => {
      console.error('[bm25Worker] Worker error:', e)
      _worker = null  // recreated on next call
      // Reject all pending Promises — prevents infinite hang
      const err = new Error(`Worker error: ${e.message ?? 'unknown'}`)
      for (const reject of _pending.values()) reject(err)
      _pending.clear()
    }
  }
  return _worker
}

type DoneMsg = Extract<WorkerResult, { type: 'done' }>

function callWorker<T>(msg: object, extract: (r: DoneMsg) => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = String(++_reqCounter)
    const worker = getWorker()
    _pending.set(requestId, reject)
    const handler = (e: MessageEvent<WorkerResult>) => {
      if (e.data.requestId !== requestId) return  // response for another request — ignore
      worker.removeEventListener('message', handler)
      _pending.delete(requestId)
      if (e.data.type === 'error') {
        reject(new Error(e.data.message))
      } else {
        resolve(extract(e.data as DoneMsg))
      }
    }
    worker.addEventListener('message', handler)
    worker.postMessage({ ...msg, requestId })
  })
}

/**
 * On cache miss: takes LoadedDocument[] and runs BM25 build + findImplicitLinks in the worker.
 * Returns the serialized index together with the implicit links.
 */
export function buildAndFindLinks(
  docs: LoadedDocument[],
  adjacency: Map<string, string[]>,
  fingerprint: string,
  threshold = 0.25,
  topN = 6,
): Promise<{ serialized: SerializedTfIdf; implicitLinks: ImplicitLink[] }> {
  const adj = [...adjacency.entries()]
  return callWorker(
    { type: 'build', docs, adjacency: adj, threshold, topN, fingerprint },
    (r) => {
      if (!r.serialized) throw new Error('Worker response is missing serialized')
      return { serialized: r.serialized, implicitLinks: r.implicitLinks ?? [] }
    },
  )
}

/**
 * Runs co-occurrence-based synonym extraction in the worker.
 *
 * Sends only the array of section texts instead of whole documents (LoadedDocument[]) to reduce structured-clone cost.
 * This job used to block the main thread for 13s and then end with `RangeError: Map maximum size
 * exceeded`, yielding 0 results — moved to the worker so it no longer blocks UI frames.
 */
export function extractSynonymsInWorker(
  sectionTexts: string[],
): Promise<[string, string[]][]> {
  return callWorker(
    { type: 'synonyms', sections: sectionTexts },
    (r) => r.synonyms ?? [],
  )
}

/**
 * Single-document incremental update — reprocesses only the one changed file, then returns the new index + implicit links.
 */
export function updateDocInWorker(
  serialized: SerializedTfIdf,
  doc: LoadedDocument,
  adjacency: Map<string, string[]>,
  fingerprint: string,
  threshold = 0.25,
  topN = 6,
): Promise<{ serialized: SerializedTfIdf; implicitLinks: ImplicitLink[] }> {
  const adj = [...adjacency.entries()]
  return callWorker(
    { type: 'updateDoc', serialized, doc, adjacency: adj, threshold, topN, fingerprint },
    (r) => {
      if (!r.serialized) throw new Error('Worker response is missing serialized')
      return { serialized: r.serialized, implicitLinks: r.implicitLinks ?? [] }
    },
  )
}

/**
 * Several documents changed or disappeared at once (a server pull): one round trip to the worker
 * instead of a full rebuild.
 */
export function updateDocsInWorker(
  serialized: SerializedTfIdf,
  docs: LoadedDocument[],
  removedIds: string[],
  adjacency: Map<string, string[]>,
  fingerprint: string,
  threshold = 0.25,
  topN = 6,
): Promise<{ serialized: SerializedTfIdf; implicitLinks: ImplicitLink[] }> {
  const adj = [...adjacency.entries()]
  return callWorker(
    { type: 'updateDocs', serialized, docs, removedIds, adjacency: adj, threshold, topN, fingerprint },
    (r) => {
      if (!r.serialized) throw new Error('Worker response is missing serialized')
      return { serialized: r.serialized, implicitLinks: r.implicitLinks ?? [] }
    },
  )
}

/**
 * On cache hit: takes the already-serialized index and runs only findImplicitLinks in the worker.
 *
 * Sends only the bm25Vec + bm25Norm + id that findImplicitLinks needs —
 * dropping the idf Map, termFreqs, docLen and avgdl minimizes the postMessage structured-clone size.
 * (~20MB → ~10MB on large vaults, shorter main-thread serialization time)
 */
export function findLinksFromCache(
  serialized: SerializedTfIdf,
  adjacency: Map<string, string[]>,
  threshold = 0.25,
  topN = 6,
): Promise<ImplicitLink[]> {
  const adj = [...adjacency.entries()]
  // Keep only the fields findImplicitLinks needs, drop the rest
  const slim: SerializedTfIdf = {
    schemaVersion: serialized.schemaVersion,
    fingerprint: serialized.fingerprint,
    idf: [],       // unused by findImplicitLinks
    avgdl: 0,      // unused by findImplicitLinks
    docs: serialized.docs.map(d => ({
      docId: d.docId,
      filename: d.filename,
      speaker: d.speaker,
      termFreqs: [],         // unused by findImplicitLinks
      docLen: 0,             // unused by findImplicitLinks
      contentDate: d.contentDate ?? 0,
      bm25Vec: d.bm25Vec,    // needed for cosine similarity
      bm25Norm: d.bm25Norm,  // needed for normalization
    })),
  }
  return callWorker(
    { type: 'findLinks', serialized: slim, adjacency: adj, threshold, topN },
    (r) => r.implicitLinks ?? [],
  )
}
