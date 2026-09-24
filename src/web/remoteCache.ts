/**
 * Local mirror of the remote vault: every live row (with markdown content) plus the sync cursor,
 * so a reload of the web app only fetches what changed since last time.
 *
 * IndexedDB when available (one database per server host), memory otherwise (tests, private
 * windows where IDB throws). All access goes through the in-memory Map; the store is write-through.
 */
import type { RemoteDoc } from './remoteClient'

export interface CachedRow {
  path: string
  etag: string
  size: number
  mtime: number
  author: string
  seq: number
  /** Markdown text; null for binaries (images), which are fetched on demand. */
  content: string | null
}

export interface CacheSnapshot {
  cursor: number
  /** Server generation the cursor belongs to; null until the server reports one. */
  generation: number | null
  rows: CachedRow[]
  /** Folders created in the UI that have no file yet (the server has no folder objects). */
  emptyFolders: string[]
}

/** What changed since the last write; `rows` are upserts, `removed` are deleted paths. */
export interface CacheDelta {
  cursor: number
  generation: number | null
  emptyFolders: string[]
  rows: CachedRow[]
  removed: string[]
}

export interface CacheBackend {
  load(): Promise<CacheSnapshot | null>
  /** Apply a delta; the backend must already hold the rest of the snapshot. */
  write(delta: CacheDelta): Promise<void>
  clear(): Promise<void>
}

export class MemoryCacheBackend implements CacheBackend {
  private rows = new Map<string, CachedRow>()
  private cursor: number | null = null
  private generation: number | null = null
  private emptyFolders: string[] = []
  async load(): Promise<CacheSnapshot | null> {
    if (this.cursor === null) return null
    return structuredCloneSafe({ cursor: this.cursor, generation: this.generation, rows: [...this.rows.values()], emptyFolders: this.emptyFolders })
  }
  async write(d: CacheDelta) {
    for (const p of d.removed) this.rows.delete(p)
    for (const r of d.rows) this.rows.set(r.path, structuredCloneSafe(r))
    this.cursor = d.cursor; this.generation = d.generation; this.emptyFolders = [...d.emptyFolders]
  }
  async clear() { this.rows.clear(); this.cursor = null; this.generation = null; this.emptyFolders = [] }
}

function structuredCloneSafe<T>(v: T): T {
  return typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v))
}

const DB_VERSION = 1

/** One IndexedDB database per server so switching servers never mixes documents. */
export class IndexedDbCacheBackend implements CacheBackend {
  constructor(private readonly dbName: string) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('rows')) db.createObjectStore('rows', { keyPath: 'path' })
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }

  async load(): Promise<CacheSnapshot | null> {
    const db = await this.open()
    try {
      return await new Promise<CacheSnapshot | null>((resolve, reject) => {
        const tx = db.transaction(['rows', 'meta'], 'readonly')
        const rowsReq = tx.objectStore('rows').getAll()
        const cursorReq = tx.objectStore('meta').get('cursor')
        const genReq = tx.objectStore('meta').get('generation')
        const foldersReq = tx.objectStore('meta').get('emptyFolders')
        tx.oncomplete = () => {
          const cursor = typeof cursorReq.result === 'number' ? cursorReq.result : null
          if (cursor === null) return resolve(null)
          resolve({
            cursor,
            generation: typeof genReq.result === 'number' ? genReq.result : null,
            rows: rowsReq.result as CachedRow[],
            emptyFolders: Array.isArray(foldersReq.result) ? foldersReq.result : [],
          })
        }
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }

  async write(delta: CacheDelta): Promise<void> {
    const db = await this.open()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['rows', 'meta'], 'readwrite')
        const rows = tx.objectStore('rows')
        for (const p of delta.removed) rows.delete(p)
        for (const r of delta.rows) rows.put(r)
        tx.objectStore('meta').put(delta.cursor, 'cursor')
        tx.objectStore('meta').put(delta.generation, 'generation')
        tx.objectStore('meta').put(delta.emptyFolders, 'emptyFolders')
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  }

  async clear(): Promise<void> {
    // Not resolved on `blocked`: every operation closes its connection, so the delete goes
    // through once in-flight work finishes — resolving early would let a queued write revive old rows.
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(this.dbName)
      req.onsuccess = req.onerror = () => resolve()
    })
  }
}

export function defaultCacheBackend(host: string): CacheBackend {
  try {
    if (typeof indexedDB !== 'undefined') return new IndexedDbCacheBackend(`strata-sync-remote-vault:${host}`)
  } catch { /* accessing indexedDB can throw in sandboxed contexts */ }
  return new MemoryCacheBackend()
}

/** In-memory mirror with write-through persistence (debounced so a burst of rows is one save). */
export class RemoteCache {
  rows = new Map<string, CachedRow>()
  cursor = 0
  generation: number | null = null
  emptyFolders = new Set<string>()
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private saving: Promise<void> = Promise.resolve()
  /** Paths touched since the last flush (upserts and deletes); only these are written. */
  private dirty = new Set<string>()

  constructor(private readonly backend: CacheBackend) {}

  async load(): Promise<void> {
    const snap = await this.backend.load().catch(() => null)
    if (!snap) return
    this.cursor = snap.cursor
    this.generation = snap.generation
    this.rows = new Map(snap.rows.map(r => [r.path, r]))
    this.emptyFolders = new Set(snap.emptyFolders)
  }

  /** Apply a page of server rows; returns the paths that changed (live or removed). */
  apply(docs: RemoteDoc[]): { changed: string[]; removed: string[] } {
    const changed: string[] = []
    const removed: string[] = []
    for (const d of docs) {
      this.dirty.add(d.path)
      if (d.deleted) {
        if (this.rows.delete(d.path)) removed.push(d.path)
      } else {
        const prev = this.rows.get(d.path)
        const isMd = d.path.toLowerCase().endsWith('.md')
        // A binary row arrives with content null; keep it as a registry entry (fetched on demand)
        this.rows.set(d.path, { path: d.path, etag: d.etag, size: d.size, mtime: d.mtime, author: d.author, seq: d.seq, content: isMd ? d.content : null })
        if (!prev || prev.etag !== d.etag) changed.push(d.path)
      }
      if (d.seq > this.cursor) this.cursor = d.seq
      // Any file under a folder makes it non-empty
      const folder = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : ''
      if (folder) for (const f of [...this.emptyFolders]) if (folder === f || folder.startsWith(f + '/')) this.emptyFolders.delete(f)
    }
    if (docs.length > 0) this.scheduleSave() // a quiet poll touches nothing on disk
    return { changed, removed }
  }

  /** Record a write we made ourselves so the next pull recognises it as already applied. */
  setRow(row: CachedRow): void { this.rows.set(row.path, row); this.dirty.add(row.path); this.scheduleSave() }
  removeRow(path: string): void { this.rows.delete(path); this.dirty.add(path); this.scheduleSave() }

  addEmptyFolder(folder: string): void { this.emptyFolders.add(folder); this.scheduleSave() }

  /** Forget everything (server sequence reset or disconnect). */
  async reset(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    await this.saving // a queued flush must not land in the fresh store
    this.rows.clear(); this.cursor = 0; this.generation = null; this.emptyFolders.clear(); this.dirty.clear()
    await this.backend.clear().catch(() => {})
  }

  /** All folders implied by the rows plus the explicitly created empty ones, sorted, deduped. */
  folders(): string[] {
    const out = new Set<string>()
    const addParents = (parts: string[], upTo: number) => { for (let i = 1; i <= upTo; i++) out.add(parts.slice(0, i).join('/')) }
    for (const path of this.rows.keys()) { const parts = path.split('/'); addParents(parts, parts.length - 1) }
    for (const folder of this.emptyFolders) { const parts = folder.split('/'); addParents(parts, parts.length) }
    return [...out].sort()
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush() }, 300)
  }

  /** Persist what changed since the last flush (also awaited by tests). */
  flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null }
    // Snapshot inside the queue: a failed predecessor must restore its dirty paths before
    // the next delta can advance the durable cursor. New edits during I/O stay dirty.
    this.saving = this.saving.then(async () => {
      const touched = [...this.dirty]; this.dirty.clear()
      const delta: CacheDelta = {
        cursor: this.cursor, generation: this.generation, emptyFolders: [...this.emptyFolders],
        rows: touched.map(p => this.rows.get(p)).filter((r): r is CachedRow => Boolean(r)),
        removed: touched.filter(p => !this.rows.has(p)),
      }
      try { await this.backend.write(delta) }
      catch { for (const path of touched) this.dirty.add(path) }
    })
    return this.saving
  }
}
