/**
 * Cloudflare-backed implementations of the sync.ts store interfaces.
 */
import type { BlobStore, FileRow, MetaStore } from './sync.js'

interface FileRecord {
  path: string; etag: string; size: number; mtime: number; author: string
  deleted: number; seq: number; updated_at: number
}

function toRow(r: FileRecord): FileRow {
  return { path: r.path, etag: r.etag, size: r.size, mtime: r.mtime, author: r.author, deleted: r.deleted === 1, seq: r.seq, updatedAt: r.updated_at }
}

export class D1MetaStore implements MetaStore {
  constructor(private db: D1Database) {}

  async get(path: string): Promise<FileRow | null> {
    const r = await this.db.prepare('SELECT * FROM files WHERE path = ?').bind(path).first<FileRecord>()
    return r ? toRow(r) : null
  }

  async listSince(since: number, limit: number): Promise<FileRow[]> {
    const { results } = await this.db.prepare('SELECT * FROM files WHERE seq > ? ORDER BY seq ASC LIMIT ?').bind(since, limit).all<FileRecord>()
    return results.map(toRow)
  }

  async head(): Promise<number> {
    const r = await this.db.prepare("SELECT value FROM counters WHERE name = 'seq'").first<{ value: number }>()
    return r?.value ?? 0
  }

  async generation(): Promise<number> {
    const r = await this.db.prepare("SELECT value FROM counters WHERE name = 'generation'").first<{ value: number }>()
    // 0 = database predates migration 0002; clients treat it like any other stable value
    return r?.value ?? 0
  }

  /**
   * seq allocation and the row write happen in one D1 batch, which D1 runs as a transaction, so
   * two concurrent writers cannot end up with the same seq or a row whose seq was never handed out.
   */
  async upsert(row: Omit<FileRow, 'seq'>): Promise<FileRow> {
    const results = await this.db.batch([
      this.db.prepare("UPDATE counters SET value = value + 1 WHERE name = 'seq' RETURNING value"),
      this.db.prepare(`
        INSERT INTO files (path, etag, size, mtime, author, deleted, seq, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT value FROM counters WHERE name = 'seq'), ?7)
        ON CONFLICT(path) DO UPDATE SET
          etag = excluded.etag, size = excluded.size, mtime = excluded.mtime, author = excluded.author,
          deleted = excluded.deleted, seq = excluded.seq, updated_at = excluded.updated_at
        RETURNING *`).bind(row.path, row.etag, row.size, row.mtime, row.author, row.deleted ? 1 : 0, row.updatedAt),
    ])
    const stored = results[1].results?.[0] as FileRecord | undefined
    if (!stored) throw new Error('upsert returned no row')
    return toRow(stored)
  }
}

export class R2BlobStore implements BlobStore {
  constructor(private bucket: R2Bucket) {}

  async get(path: string): Promise<Uint8Array | null> {
    const obj = await this.bucket.get(path)
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null
  }

  async put(path: string, body: Uint8Array): Promise<void> {
    await this.bucket.put(path, body)
  }

  async delete(path: string): Promise<void> {
    await this.bucket.delete(path)
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    const out: { key: string; size: number }[] = []
    let cursor: string | undefined
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 })
      for (const o of page.objects) out.push({ key: o.key, size: o.size })
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return out
  }
}
