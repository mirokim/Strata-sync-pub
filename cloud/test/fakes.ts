import type { BlobStore, FileRow, MetaStore } from '../src/sync.js'

/** In-memory MetaStore with the same seq semantics as the D1 implementation. */
export class MemoryMeta implements MetaStore {
  rows = new Map<string, FileRow>()
  seq = 0
  async get(path: string) { return this.rows.get(path) ?? null }
  async listSince(since: number, limit: number) {
    return [...this.rows.values()].filter(r => r.seq > since).sort((a, b) => a.seq - b.seq).slice(0, limit)
  }
  async head() { return this.seq }
  async upsert(row: Omit<FileRow, 'seq'>) {
    const stored = { ...row, seq: ++this.seq }
    this.rows.set(row.path, stored)
    return stored
  }
}

export class MemoryBlobs implements BlobStore {
  objects = new Map<string, Uint8Array>()
  async get(path: string) { return this.objects.get(path) ?? null }
  async put(path: string, body: Uint8Array) { this.objects.set(path, new Uint8Array(body)) }
  async delete(path: string) { this.objects.delete(path) }
}

export const enc = (s: string) => new TextEncoder().encode(s)
export const dec = (b: Uint8Array) => new TextDecoder().decode(b)
