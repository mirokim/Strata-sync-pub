/**
 * R2 event → D1 bridge.
 *
 * Obsidian's Remotely Save (or anything with S3 credentials) writes straight into the bucket and
 * never touches the sync API, so the D1 index would not know about those files. R2 event
 * notifications land on a Queue; this consumer hashes each new object and upserts its row so the
 * change shows up in the next manifest like any other edit. Deletions become tombstones.
 *
 * Objects written by the API itself arrive here too; they are recognised by an unchanged hash
 * and skipped, so nothing is double-counted.
 */
import { normalizeVaultPath, sha256Hex, type SyncDeps } from './sync.js'

export interface R2EventMessage {
  action: 'PutObject' | 'CopyObject' | 'CompleteMultipartUpload' | 'DeleteObject' | 'LifecycleDeletion' | string
  object: { key: string; size?: number; eTag?: string }
  eventTime?: string
}

export const EXTERNAL_AUTHOR = 'external'
const SYNC_EXT = /\.(md|png|jpe?g|gif|webp|svg|pdf|canvas)$/i

export interface BridgeResult { indexed: number; tombstoned: number; skipped: number }

export async function applyR2Events(deps: SyncDeps, messages: R2EventMessage[], log: (msg: string) => void = () => {}): Promise<BridgeResult> {
  const result: BridgeResult = { indexed: 0, tombstoned: 0, skipped: 0 }
  const now = (deps.now ?? Date.now)()

  for (const msg of messages) {
    const key = msg.object?.key ?? ''
    // Server bookkeeping and dot-paths are not vault documents
    if (key.startsWith('_system/') || key.split('/').some(s => s.startsWith('.')) || !SYNC_EXT.test(key)) { result.skipped++; continue }
    const path = normalizeVaultPath(key)
    if (!path) { result.skipped++; continue }

    if (deps.writer) {
      const part = await deps.writer.reconcile({ ...msg, object: { ...msg.object, key: path } })
      result.indexed += part.indexed; result.tombstoned += part.tombstoned; result.skipped += part.skipped
      continue
    }

    const current = await deps.meta.get(path)
    const isDelete = msg.action === 'DeleteObject' || msg.action === 'LifecycleDeletion'

    if (isDelete) {
      // The API's own deletes already tombstoned the row; an external delete has a live row.
      if (!current || current.deleted) { result.skipped++; continue }
      // Guard against a stale event ordering: if the object is back, leave the row alone.
      if (await deps.blobs.get(path)) { result.skipped++; continue }
      await deps.meta.upsert({ path, etag: current.etag, size: 0, mtime: current.mtime, author: EXTERNAL_AUTHOR, authorSub: '', deleted: true, updatedAt: now })
      result.tombstoned++
      continue
    }

    const bytes = await deps.blobs.get(path)
    if (!bytes) { result.skipped++; continue }                 // deleted again before we got here
    if (bytes.byteLength > deps.maxFileBytes) { result.skipped++; log(`[r2events] ${path}: too large, not indexed`); continue }
    const etag = await sha256Hex(bytes)
    if (current && !current.deleted && current.etag === etag) { result.skipped++; continue }   // our own API write
    const mtime = msg.eventTime ? Date.parse(msg.eventTime) || now : now
    await deps.meta.upsert({ path, etag, size: bytes.byteLength, mtime, author: EXTERNAL_AUTHOR, authorSub: '', deleted: false, updatedAt: now })
    result.indexed++
  }
  return result
}
