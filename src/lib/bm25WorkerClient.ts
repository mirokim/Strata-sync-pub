/**
 * bm25WorkerClient.ts — BM25 Web Worker 클라이언트
 *
 * 무거운 BM25 빌드 / O(N²) 묵시적 링크 계산을 워커 스레드에 위임합니다.
 * 워커는 최초 호출 시 lazy하게 생성되며, 앱 생명주기 동안 재사용됩니다.
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
      console.error('[bm25Worker] 워커 오류:', e)
      _worker = null  // 다음 호출에서 재생성
      // 대기 중인 모든 Promise를 reject — 무한 hang 방지
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
      if (e.data.requestId !== requestId) return  // 다른 요청의 응답 — 무시
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
 * 캐시 미스 시: LoadedDocument[]를 받아 BM25 빌드 + findImplicitLinks를 워커에서 실행.
 * serialized 인덱스와 묵시적 링크를 함께 반환합니다.
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
      if (!r.serialized) throw new Error('워커 응답에 serialized 없음')
      return { serialized: r.serialized, implicitLinks: r.implicitLinks ?? [] }
    },
  )
}

/**
 * Co-occurrence 기반 동의어 추출을 워커에서 실행.
 *
 * 문서 전체(LoadedDocument[]) 대신 섹션 텍스트 배열만 전송해 구조적 복제 비용을 줄인다.
 * 이 작업은 예전에 메인 스레드에서 13초를 블로킹한 뒤 `RangeError: Map maximum size
 * exceeded` 로 끝나 결과가 0개였다 — 워커로 옮겨 UI 프레임을 막지 않게 한다.
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
 * 단일 문서 증분 업데이트 — 변경된 파일 하나만 재처리 후 새 인덱스 + 묵시적 링크 반환.
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
      if (!r.serialized) throw new Error('워커 응답에 serialized 없음')
      return { serialized: r.serialized, implicitLinks: r.implicitLinks ?? [] }
    },
  )
}

/**
 * 캐시 히트 시: 이미 직렬화된 인덱스를 받아 findImplicitLinks만 워커에서 실행.
 *
 * findImplicitLinks에 필요한 bm25Vec + bm25Norm + id 만 전송 —
 * idf Map·termFreqs·docLen·avgdl 제거로 postMessage 구조적 복제 크기를 최소화.
 * (대형 볼트에서 ~20MB → ~10MB, 메인 스레드 직렬화 시간 단축)
 */
export function findLinksFromCache(
  serialized: SerializedTfIdf,
  adjacency: Map<string, string[]>,
  threshold = 0.25,
  topN = 6,
): Promise<ImplicitLink[]> {
  const adj = [...adjacency.entries()]
  // findImplicitLinks가 필요한 필드만 남기고 나머지 제거
  const slim: SerializedTfIdf = {
    schemaVersion: serialized.schemaVersion,
    fingerprint: serialized.fingerprint,
    idf: [],       // findImplicitLinks 미사용
    avgdl: 0,      // findImplicitLinks 미사용
    docs: serialized.docs.map(d => ({
      docId: d.docId,
      filename: d.filename,
      speaker: d.speaker,
      termFreqs: [],         // findImplicitLinks 미사용
      docLen: 0,             // findImplicitLinks 미사용
      contentDate: d.contentDate ?? 0,
      bm25Vec: d.bm25Vec,    // 코사인 유사도 계산에 필요
      bm25Norm: d.bm25Norm,  // 정규화에 필요
    })),
  }
  return callWorker(
    { type: 'findLinks', serialized: slim, adjacency: adj, threshold, topN },
    (r) => r.implicitLinks ?? [],
  )
}
