/**
 * bm25Worker.ts — Runs BM25 index build + implicit links + co-occurrence synonyms
 * off the main thread
 *
 * Message protocol:
 *   IN  { type: 'build',     docs, adjacency, threshold, topN, fingerprint }
 *         → BM25 build + findImplicitLinks → { type: 'done', serialized, implicitLinks }
 *   IN  { type: 'findLinks', serialized, adjacency, threshold, topN }
 *         → cache restore + findImplicitLinks → { type: 'done', implicitLinks }
 *   IN  { type: 'updateDoc', serialized, doc, adjacency, threshold, topN, fingerprint }
 *         → single-document incremental update → { type: 'done', serialized, implicitLinks }
 *   IN  { type: 'updateDocs', serialized, docs, removedIds, adjacency, threshold, topN, fingerprint }
 *         → several documents changed/removed at once (a server pull) → { type: 'done', serialized, implicitLinks }
 *   IN  { type: 'synonyms',  sections }
 *         → co-occurrence synonym extraction → { type: 'done', synonyms }
 *   OUT { type: 'error', message }
 */

import { TfIdfIndex, extractCoOccurrenceSynonymsFromSections } from '@/lib/graphAnalysis'
import type { SerializedTfIdf, ImplicitLink } from '@/lib/graphAnalysis'
import type { LoadedDocument } from '@/types'

type InMsg =
  | { type: 'build';      requestId: string; docs: LoadedDocument[]; adjacency: [string, string[]][]; threshold: number; topN: number; fingerprint: string }
  | { type: 'findLinks';  requestId: string; serialized: SerializedTfIdf; adjacency: [string, string[]][]; threshold: number; topN: number }
  | { type: 'updateDoc';  requestId: string; serialized: SerializedTfIdf; doc: LoadedDocument; adjacency: [string, string[]][]; threshold: number; topN: number; fingerprint: string }
  | { type: 'updateDocs'; requestId: string; serialized: SerializedTfIdf; docs: LoadedDocument[]; removedIds: string[]; adjacency: [string, string[]][]; threshold: number; topN: number; fingerprint: string }
  | { type: 'synonyms';   requestId: string; sections: string[]; minCoOccurrence?: number; pmiThreshold?: number }

type OutMsg =
  | { type: 'done';  requestId: string; serialized?: SerializedTfIdf; implicitLinks?: ImplicitLink[]; synonyms?: [string, string[]][] }
  | { type: 'error'; requestId: string; message: string }

self.onmessage = (e: MessageEvent<InMsg>) => {
  const { requestId } = e.data
  try {
    const msg = e.data

    // co-occurrence synonym extraction — independent path, unrelated to the BM25 index
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
      // Incremental update: restore existing index, then rebuild only the single document
      index.restore(msg.serialized)
      index.updateDoc(msg.doc)
      serialized = index.serialize(msg.fingerprint)
    } else if (msg.type === 'updateDocs') {
      index.restore(msg.serialized)
      for (const id of msg.removedIds) index.removeDoc(id)
      for (const doc of msg.docs) index.updateDoc(doc)
      serialized = index.serialize(msg.fingerprint)
    } else {
      index.restore(msg.serialized)
    }

    const adj = new Map(msg.adjacency)
    const implicitLinks = index.findImplicitLinks(adj, msg.topN, msg.threshold)

    // Store links alongside the index so the cache-hit path can skip the O(N²) recomputation
    if (serialized) serialized.implicitLinks = implicitLinks

    const result: OutMsg = { type: 'done', requestId, implicitLinks }
    if (serialized) result.serialized = serialized
    self.postMessage(result)
  } catch (err) {
    self.postMessage({ type: 'error', requestId, message: String(err) } satisfies OutMsg)
  }
}
