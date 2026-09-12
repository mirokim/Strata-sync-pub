/**
 * pprWorkerClient.ts — PPR Web Worker 클라이언트
 *
 * PPR (Personalized PageRank) 계산을 워커 스레드에 위임합니다.
 * 워커는 최초 호출 시 lazy하게 생성되며, 앱 생명주기 동안 재사용됩니다.
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
      console.error('[pprWorker] 워커 오류:', e)
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

/** PPR 시드 — id와 검색 점수 기반 가중치 */
export interface PPRSeed {
  id: string
  /** 검색 점수 등 상대 가중치 (>0). 개인화 벡터가 이 비율로 구성됩니다. */
  weight: number
}

/**
 * GraphLink[] (source/target이 string | GraphNode)를 받아
 * PPR 계산을 워커에서 실행하고 결과 Map을 반환합니다.
 *
 * @param seeds       점수 가중 시드. 균등 시드는 검색 랭킹을 소실시키므로 사용하지 마세요.
 * @param alpha       restart 확률. 0.15는 너무 낮아 매 iteration 질량의 85%가
 *                    그래프로 흘러나가고, `_index.md`·연도 허브처럼 in-edge가 많은
 *                    노드가 시드보다 높은 점수를 받습니다. 기본 0.4.
 * @param iterations  Power iteration 횟수
 */
export function runPPRInWorker(
  seeds: PPRSeed[],
  links: GraphLink[],
  alpha = 0.4,
  iterations = 20,
): Promise<Map<string, number>> {
  // GraphLink의 source/target은 string | GraphNode — 워커 전송 전 string으로 정규화
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
