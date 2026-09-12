/**
 * pprWorkerClient.ts — PPR Web Worker client
 *
 * Delegates PPR (Personalized PageRank) computation to a worker thread.
 * The worker is created lazily on first call and reused for the app's lifetime.
 */

import type { GraphLink } from '@/types'

type WorkerResult =
  | { type: 'done';  requestId: string; scores: [string, number][] }
  | { type: 'error'; requestId: string; message: string }

let _worker: Worker | null = null
let _reqCounter = 0
const _pending = new Map<string, (err: Error) => void>()

function getWorker(): Worker {
  if (!_worker) {
    _worker = new Worker(new URL('../workers/pprWorker.ts', import.meta.url), { type: 'module' })
    _worker.onerror = (e) => {
      console.error('[pprWorker] Worker error:', e)
      _worker = null
      const err = new Error(`PPR Worker error: ${e.message ?? 'unknown'}`)
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
      if (e.data.requestId !== requestId) return
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

/** PPR seed — id plus a weight based on the search score */
export interface PPRSeed {
  id: string
  /** Relative weight (>0), e.g. the search score. The personalization vector is built in this proportion. */
  weight: number
}

/**
 * Takes GraphLink[] (source/target is string | GraphNode),
 * runs the PPR computation in the worker, and returns the result Map.
 *
 * @param seeds       Score-weighted seeds. Do not use uniform seeds — they discard the search ranking.
 * @param alpha       Restart probability. 0.15 is too low: 85% of the mass flows out into the
 *                    graph every iteration, and nodes with many in-edges (like `_index.md`
 *                    or year hubs) end up scoring higher than the seeds. Default 0.4.
 * @param iterations  Number of power iterations
 */
export function runPPRInWorker(
  seeds: PPRSeed[],
  links: GraphLink[],
  alpha = 0.4,
  iterations = 20,
): Promise<Map<string, number>> {
  // GraphLink source/target is string | GraphNode — normalize to string before sending to the worker
  const normalizedLinks = links.map(l => ({
    source: typeof l.source === 'string' ? l.source : (l.source as { id: string }).id,
    target: typeof l.target === 'string' ? l.target : (l.target as { id: string }).id,
    strength: l.strength ?? 0.5,
  }))

  return callWorker(
    { type: 'ppr', seeds, links: normalizedLinks, alpha, iterations },
    (r) => new Map(r.scores),
  )
}
