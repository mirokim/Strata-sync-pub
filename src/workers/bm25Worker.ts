/**
 * bm25Worker.ts — BM25 인덱스 빌드 + 묵시적 링크 + co-occurrence 동의어를
 * 메인 스레드 밖에서 실행
 *
 * 메시지 프로토콜:
 *   IN  { type: 'build',     docs, adjacency, threshold, topN, fingerprint }
 *         → BM25 빌드 + findImplicitLinks → { type: 'done', serialized, implicitLinks }
 *   IN  { type: 'findLinks', serialized, adjacency, threshold, topN }
 *         → 캐시 복원 + findImplicitLinks → { type: 'done', implicitLinks }
 *   IN  { type: 'updateDoc', serialized, doc, adjacency, threshold, topN, fingerprint }
 *         → 단일 문서 증분 갱신 → { type: 'done', serialized, implicitLinks }
 *   IN  { type: 'synonyms',  sections }
 *         → co-occurrence 동의어 추출 → { type: 'done', synonyms }
 *   OUT { type: 'error', message }
 */

import { TfIdfIndex, extractCoOccurrenceSynonymsFromSections } from '@/lib/graphAnalysis'
import type { SerializedTfIdf, ImplicitLink } from '@/lib/graphAnalysis'
import type { LoadedDocument } from '@/types'

type InMsg =
  | { type: 'build';      requestId: string; docs: LoadedDocument[]; adjacency: [string, string[]][]; threshold: number; topN: number; fingerprint: string }
  | { type: 'findLinks';  requestId: string; serialized: SerializedTfIdf; adjacency: [string, string[]][]; threshold: number; topN: number }
  | { type: 'updateDoc';  requestId: string; serialized: SerializedTfIdf; doc: LoadedDocument; adjacency: [string, string[]][]; threshold: number; topN: number; fingerprint: string }
  | { type: 'synonyms';   requestId: string; sections: string[]; minCoOccurrence?: number; pmiThreshold?: number }

type OutMsg =
  | { type: 'done';  requestId: string; serialized?: SerializedTfIdf; implicitLinks?: ImplicitLink[]; synonyms?: [string, string[]][] }
  | { type: 'error'; requestId: string; message: string }

self.onmessage = (e: MessageEvent<InMsg>) => {
  const { requestId } = e.data
  try {
    const msg = e.data

    // co-occurrence 동의어 추출 — BM25 인덱스와 무관한 독립 경로
    if (msg.type === 'synonyms') {
      const syn = extractCoOccurrenceSynonymsFromSections(
        msg.sections, msg.minCoOccurrence, msg.pmiThreshold,
      )
      self.postMessage({ type: 'done', requestId, synonyms: [...syn.entries()] } satisfies OutMsg)
      return
    }

    const index = new TfIdfIndex()
    let serialized: SerializedTfIdf | undefined

    if (msg.type === 'build') {
      index.build(msg.docs)
      serialized = index.serialize(msg.fingerprint)
    } else if (msg.type === 'updateDoc') {
      // 증분 업데이트: 기존 인덱스 복원 후 단일 문서만 재빌드
      index.restore(msg.serialized)
      index.updateDoc(msg.doc)
      serialized = index.serialize(msg.fingerprint)
    } else {
      index.restore(msg.serialized)
    }

    const adj = new Map(msg.adjacency)
    const implicitLinks = index.findImplicitLinks(adj, msg.topN, msg.threshold)

    // 캐시 히트 경로에서 O(N²) 재계산을 건너뛰도록 링크를 인덱스에 동봉해 저장
    if (serialized) serialized.implicitLinks = implicitLinks

    const result: OutMsg = { type: 'done', requestId, implicitLinks }
    if (serialized) result.serialized = serialized
    self.postMessage(result)
  } catch (err) {
    self.postMessage({ type: 'error', requestId, message: String(err) } satisfies OutMsg)
  }
}
