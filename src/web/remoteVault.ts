/**
 * Remote vault adapter — implements `window.vaultAPI` (and `window.syncAPI`) over the Strata Sync
 * Worker so the React app runs unchanged in a browser (Vercel) with no Electron main process.
 *
 * Model: the Worker is the vault. The browser keeps a local mirror (RemoteCache, IndexedDB) that
 * it advances with `GET /v1/docs?after=<cursor>`; writes go straight to the server with an
 * optimistic lock (`If-Match: <etag we last saw>`). A lost race never overwrites anyone: the
 * server version keeps the file name and the local text is saved next to it as
 * `<name> (conflict <author> <time>).md` — the same rule as the desktop sync engine.
 *
 * "Absolute" paths handed to the UI are `remote://<host>/<vault path>`; dot-paths
 * (`.strata-sync/…`, per-vault persona config) never leave the browser and live in localStorage.
 */
import { remoteVaultPath, saveWebConfig, type WebConfig } from './config'
import { RemoteClient, RemoteError, type FetchLike } from './remoteClient'
import { RemoteCache, defaultCacheBackend, type CacheBackend, type CachedRow } from './remoteCache'
import { conflictName, numberedName } from '@/lib/conflictCopy'

export { conflictName }

type VaultAPI = NonNullable<Window['vaultAPI']>
type SyncAPI = NonNullable<Window['syncAPI']>
type ChangeListener = Parameters<VaultAPI['onChanged']>[0]

const IMAGE_EXT = /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif|tiff?|heic)$/i
const PRIVATE_KEY = 'strata-sync-web-private'
const IMAGE_CACHE_MAX = 48

export interface RemoteVaultOptions {
  fetchImpl?: FetchLike
  backend?: CacheBackend
  /** Poll interval for `watchStart` (ms). */
  pollIntervalMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
  /** Surface a message to the user (toast). */
  notify?: (message: string, kind: 'info' | 'warn' | 'error') => void
  /** OAuth sessions: refresh `config.token` after a 401 and return true to retry. */
  onUnauthorized?: () => Promise<boolean>
}

export interface RemoteVaultStatus {
  inFlight: boolean
  lastSyncAt: number | null
  lastSeq: number
  pending: number
  conflicts: { path: string; keptAs: string; at: number; remoteAuthor: string }[]
  errors: { path: string; message: string; at: number }[]
  lastError: string | null
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export class RemoteVault {
  readonly vaultPath: string
  readonly client: RemoteClient
  readonly cache: RemoteCache
  readonly api: VaultAPI
  readonly sync: SyncAPI
  status: RemoteVaultStatus = { inFlight: false, lastSyncAt: null, lastSeq: 0, pending: 0, conflicts: [], errors: [], lastError: null }

  private loaded: Promise<void> | null = null
  private pulling: Promise<{ changed: string[]; removed: string[] }> | null = null
  private listeners = new Set<ChangeListener>()
  private statusListeners = new Set<(s: TeamSyncState) => void>()
  private pollTimer: unknown = null
  private imageCache = new Map<string, string>()
  private authWarned = false
  /**
   * Files whose server version changed under the app (a lost save race) and which the app has
   * not re-read since. Saves to them keep going to the conflict copy — never over the teammate's
   * version — until loadFiles/readFile hands the app the current content.
   */
  private staleAfterConflict = new Map<string, string>()
  private readonly now: () => number
  private readonly fetchImpl?: FetchLike
  private readonly opts: Required<Pick<RemoteVaultOptions, 'pollIntervalMs' | 'setTimer' | 'clearTimer' | 'notify'>>

  constructor(private readonly config: WebConfig, options: RemoteVaultOptions = {}) {
    this.vaultPath = remoteVaultPath(config.url)
    this.fetchImpl = options.fetchImpl
    this.client = new RemoteClient(config, options.fetchImpl, options.onUnauthorized)
    this.cache = new RemoteCache(options.backend ?? defaultCacheBackend(new URL(config.url).host))
    this.now = options.now ?? (() => Date.now())
    this.opts = {
      pollIntervalMs: options.pollIntervalMs ?? 15_000,
      setTimer: options.setTimer ?? ((fn, ms) => setInterval(fn, ms)),
      clearTimer: options.clearTimer ?? (id => clearInterval(id as ReturnType<typeof setInterval>)),
      notify: options.notify ?? (() => {}),
    }
    this.api = this.buildVaultApi()
    this.sync = this.buildSyncApi()
  }

  // ── Paths ──────────────────────────────────────────────────────────────────

  abs(rel: string): string { return rel ? `${this.vaultPath}/${rel}` : this.vaultPath }

  /** `remote://host/a/b.md` → `a/b.md`; tolerates plain relative paths and backslashes. */
  rel(absOrRel: string): string {
    let p = absOrRel.replace(/\\/g, '/')
    if (p === this.vaultPath) return ''
    if (p.startsWith(this.vaultPath + '/')) p = p.slice(this.vaultPath.length + 1)
    return p.replace(/^\/+/, '').replace(/\/+$/, '')
  }

  /** Dot-folders and dot-files (`.strata-sync/`, `.obsidian/`, caches) never leave the browser — same rule as the desktop engine and the server. */
  private isPrivate(rel: string): boolean { return rel.split('/').some(seg => seg.startsWith('.')) }

  // ── Sync core ──────────────────────────────────────────────────────────────

  private ensureLoaded(): Promise<void> {
    return this.loaded ??= this.cache.load()
  }

  /**
   * Advance the mirror to the server head. Concurrent callers share one pull. Rejects only when
   * the server is unreachable AND the mirror is empty (nothing to show).
   */
  pull(): Promise<{ changed: string[]; removed: string[] }> {
    if (this.pulling) return this.pulling
    this.pulling = this.doPull().finally(() => { this.pulling = null })
    return this.pulling
  }

  private async doPull(): Promise<{ changed: string[]; removed: string[] }> {
    await this.ensureLoaded()
    this.setStatus({ inFlight: true })
    const changed: string[] = []
    const removed: string[] = []
    try {
      let after = this.cache.cursor
      for (;;) {
        const page = await this.client.docs(after)
        const otherServer = typeof page.generation === 'number' && this.cache.generation !== null && page.generation !== this.cache.generation
        if (page.head < this.cache.cursor || otherServer) {
          // The server was wiped or re-imported: our cursor (and every row) is meaningless
          await this.cache.reset()
          after = 0
          continue
        }
        if (typeof page.generation === 'number') this.cache.generation = page.generation
        const r = this.cache.apply(page.docs)
        changed.push(...r.changed); removed.push(...r.removed)
        if (page.next === null) break
        after = page.next
      }
      for (const p of [...changed, ...removed]) this.imageCache.delete(p)
      this.setStatus({ inFlight: false, lastSyncAt: this.now(), lastSeq: this.cache.cursor, lastError: null })
      return { changed, removed }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.setStatus({ inFlight: false, lastError: message })
      if (e instanceof RemoteError && e.status === 401 && !this.authWarned) {
        this.authWarned = true
        this.opts.notify(this.config.auth === 'oauth' ? 'Your session expired — sign in again from Settings → Server' : 'The team token was rejected — reconnect in Settings → Server', 'error')
      }
      if (this.cache.rows.size === 0) throw e
      return { changed, removed }
    }
  }

  private emitChanged(changedFile?: string): void {
    for (const cb of this.listeners) {
      try { cb({ vaultPath: this.vaultPath, changedFile }) } catch { /* listener error must not stop others */ }
    }
  }

  private setStatus(patch: Partial<RemoteVaultStatus>): void {
    this.status = { ...this.status, ...patch }
    const state = this.state()
    for (const cb of this.statusListeners) { try { cb(state) } catch { /* ignore */ } }
  }

  private recordError(path: string, message: string): void {
    this.setStatus({ errors: [...this.status.errors.slice(-19), { path, message, at: this.now() }], lastError: message })
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  private async write(rel: string, bytes: Uint8Array, opts: { createOnly?: boolean } = {}): Promise<CachedRow> {
    const idx = this.cache.rows.get(rel)
    const res = await this.client.putFile(rel, bytes, { ifMatch: opts.createOnly ? undefined : idx?.etag, createOnly: opts.createOnly || !idx, mtime: this.now() })
    const isMd = rel.toLowerCase().endsWith('.md')
    const row: CachedRow = res.row
      ? { path: rel, etag: res.row.etag, size: res.row.size, mtime: res.row.mtime, author: res.row.author, seq: res.row.seq, content: isMd ? dec.decode(bytes) : null }
      : { ...(idx ?? { path: rel, size: bytes.byteLength, mtime: this.now(), author: this.config.author, seq: this.cache.cursor }), path: rel, etag: res.etag, content: isMd ? dec.decode(bytes) : null }
    // The cursor is deliberately NOT advanced to this write's seq: other clients' rows may sit
    // between the old cursor and ours, and skipping ahead would lose them. The next pull returns
    // our own row again, and apply() ignores it because the etag already matches.
    this.cache.setRow(row)
    return row
  }

  /** Save markdown text; on a lost race keep both versions (conflict copy). */
  private async saveText(rel: string, content: string): Promise<string> {
    // The app is still editing a version the server has moved past: keep feeding the copy
    const existingCopy = this.staleAfterConflict.get(rel)
    if (existingCopy) {
      await this.write(existingCopy, enc.encode(content))
      return existingCopy
    }
    try {
      await this.write(rel, enc.encode(content))
      return rel
    } catch (e) {
      if (!(e instanceof RemoteError) || e.status !== 409) throw e
      // Someone else changed the file since we loaded it. Take theirs as the canonical file,
      // keep ours next to it, and hand the UI the server version.
      const remote = await this.client.getFile(rel)
      if (remote) {
        this.cache.setRow({ path: rel, etag: remote.etag, size: remote.bytes.byteLength, mtime: remote.mtime, author: e.current?.author ?? '', seq: e.current?.seq ?? this.cache.cursor, content: dec.decode(remote.bytes) })
      } else {
        this.cache.removeRow(rel)
      }
      const base = conflictName(rel, this.config.author, this.now())
      let copy = base
      for (let n = 2; ; n++) {
        try { await this.write(copy, enc.encode(content), { createOnly: true }); break }
        catch (e2) {
          if (!(e2 instanceof RemoteError) || e2.status !== 409 || n > 20) throw e2
          copy = numberedName(base, n)
        }
      }
      this.staleAfterConflict.set(rel, copy)
      this.setStatus({ conflicts: [...this.status.conflicts.slice(-19), { path: rel, keptAs: copy, at: this.now(), remoteAuthor: e.current?.author ?? 'unknown' }] })
      this.opts.notify(`${rel} was changed by ${e.current?.author || 'someone else'} — your version is kept as "${copy}"`, 'warn')
      this.emitChanged(rel)
      return copy
    }
  }

  private async copyThenDelete(srcRel: string, destRel: string): Promise<void> {
    if (srcRel === destRel) return
    const idx = this.cache.rows.get(srcRel)
    let bytes: Uint8Array
    if (idx?.content != null) bytes = enc.encode(idx.content)
    else {
      const remote = await this.client.getFile(srcRel)
      if (!remote) throw new Error(`File does not exist: ${srcRel}`)
      bytes = remote.bytes
    }
    try {
      await this.write(destRel, bytes, { createOnly: true })
    } catch (e) {
      if (e instanceof RemoteError && e.status === 409) throw new Error(`Destination already exists: ${destRel}`)
      throw e
    }
    await this.client.deleteFile(srcRel, idx?.etag)
    this.cache.removeRow(srcRel)
    this.imageCache.delete(srcRel)
  }

  // ── Private (browser-only) files ───────────────────────────────────────────

  private privateRead(rel: string): string | null {
    try { return localStorage.getItem(`${PRIVATE_KEY}:${this.vaultPath}/${rel}`) } catch { return null }
  }
  private privateWrite(rel: string, content: string): void {
    try { localStorage.setItem(`${PRIVATE_KEY}:${this.vaultPath}/${rel}`, content) } catch { /* quota */ }
  }

  // ── Images ─────────────────────────────────────────────────────────────────

  private async imageDataUrl(rel: string): Promise<string | null> {
    const hit = this.imageCache.get(rel)
    if (hit) { this.imageCache.delete(rel); this.imageCache.set(rel, hit); return hit }
    const remote = await this.client.getFile(rel).catch(() => null)
    if (!remote) return null
    const mime = mimeFor(rel, remote.contentType)
    const url = await bytesToDataUrl(remote.bytes, mime)
    this.imageCache.set(rel, url)
    if (this.imageCache.size > IMAGE_CACHE_MAX) this.imageCache.delete(this.imageCache.keys().next().value as string)
    return url
  }

  imageRegistry(): Record<string, { relativePath: string; absolutePath: string }> {
    const out: Record<string, { relativePath: string; absolutePath: string }> = {}
    for (const path of [...this.cache.rows.keys()].sort()) {
      if (!IMAGE_EXT.test(path)) continue
      const name = path.slice(path.lastIndexOf('/') + 1)
      if (!out[name]) out[name] = { relativePath: path, absolutePath: this.abs(path) }
    }
    return out
  }

  // ── window.vaultAPI ────────────────────────────────────────────────────────

  private buildVaultApi(): VaultAPI {
    const mdRows = () => [...this.cache.rows.values()].filter(r => r.path.toLowerCase().endsWith('.md') && r.content != null)
    return {
      selectFolder: async () => this.vaultPath,

      loadFiles: async () => {
        await this.pull()
        this.staleAfterConflict.clear() // the app is about to receive every current version
        return {
          files: mdRows().map(r => ({ relativePath: r.path, absolutePath: this.abs(r.path), content: r.content!, mtime: r.mtime })),
          folders: this.cache.folders(),
          imageRegistry: this.imageRegistry(),
        }
      },

      scanMetadata: async () => {
        await this.pull()
        return mdRows().map(r => ({ relativePath: r.path, absolutePath: this.abs(r.path), mtime: r.mtime }))
      },

      watchStart: async () => {
        this.api.watchStop()
        this.pollTimer = this.opts.setTimer(() => void this.poll(), this.opts.pollIntervalMs)
        return true
      },

      watchStop: () => {
        if (this.pollTimer !== null) { this.opts.clearTimer(this.pollTimer); this.pollTimer = null }
        return Promise.resolve(true)
      },

      onChanged: (cb) => {
        this.listeners.add(cb)
        return () => { this.listeners.delete(cb) }
      },

      saveFile: async (filePath, content) => {
        const rel = this.rel(filePath)
        if (!rel) throw new Error('Invalid file path')
        if (this.isPrivate(rel)) { this.privateWrite(rel, content); return { success: true, path: filePath } }
        try {
          const saved = await this.saveText(rel, content)
          return { success: true, path: this.abs(saved) }
        } catch (e) {
          this.recordError(rel, e instanceof Error ? e.message : String(e))
          throw e
        }
      },

      setActivePath: async () => true,

      renameFile: async (absolutePath, newFilename) => {
        const rel = this.rel(absolutePath)
        if (!rel || !newFilename || /[\\/]/.test(newFilename)) throw new Error('Invalid filename')
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
        const dest = dir + newFilename
        await this.copyThenDelete(rel, dest)
        return { success: true, newPath: this.abs(dest) }
      },

      deleteFile: async (absolutePath) => {
        const rel = this.rel(absolutePath)
        if (!rel) throw new Error('Invalid path')
        if (this.isPrivate(rel)) { try { localStorage.removeItem(`${PRIVATE_KEY}:${this.vaultPath}/${rel}`) } catch { /* ignore */ } return { success: true } }
        const idx = this.cache.rows.get(rel)
        await this.client.deleteFile(rel, idx?.etag)
        this.cache.removeRow(rel)
        this.imageCache.delete(rel)
        return { success: true }
      },

      readFile: async (filePath) => {
        const rel = this.rel(filePath)
        if (!rel) return null
        if (this.isPrivate(rel)) return this.privateRead(rel)
        this.staleAfterConflict.delete(rel) // the app now sees the server version
        const idx = this.cache.rows.get(rel)
        if (idx?.content != null) return idx.content
        const remote = await this.client.getFile(rel).catch(() => null)
        return remote ? dec.decode(remote.bytes) : null
      },

      readImage: async (filePath) => {
        const rel = this.rel(filePath)
        return rel ? this.imageDataUrl(rel) : null
      },

      findImageByName: async (filename) => {
        const want = filename.toLowerCase().replace(/\s+/g, '_')
        for (const path of this.cache.rows.keys()) {
          if (!IMAGE_EXT.test(path)) continue
          const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase().replace(/\s+/g, '_')
          if (name === want) return this.imageDataUrl(path)
        }
        return null
      },

      createFolder: async (folderPath) => {
        const rel = this.rel(folderPath)
        if (!rel) throw new Error('Invalid folder path')
        this.cache.addEmptyFolder(rel)
        return { success: true, path: this.abs(rel) }
      },

      moveFile: async (absolutePath, destFolderPath) => {
        const rel = this.rel(absolutePath)
        if (!rel) throw new Error('Invalid file path')
        const folder = this.rel(destFolderPath)
        const name = rel.slice(rel.lastIndexOf('/') + 1)
        const dest = folder ? `${folder}/${name}` : name
        await this.copyThenDelete(rel, dest)
        return { success: true, newPath: this.abs(dest) }
      },
    }
  }

  /** One watch tick: pull and tell the UI what moved. */
  async poll(): Promise<void> {
    let r: { changed: string[]; removed: string[] }
    try { r = await this.pull() } catch { return }
    const changed = r.changed.filter(p => !this.isPrivate(p))
    const removed = r.removed.filter(p => !this.isPrivate(p))
    if (changed.length === 0 && removed.length === 0) return
    // Exactly one markdown edit → incremental update; anything else → full reload
    const single = changed.length === 1 && removed.length === 0 && changed[0].toLowerCase().endsWith('.md')
    this.emitChanged(single ? changed[0] : undefined)
  }

  // ── window.syncAPI (team search + status for the Server tab) ───────────────

  state(): TeamSyncState {
    return {
      config: { enabled: true, url: this.config.url, token: '', author: this.config.author, pullIntervalMs: this.opts.pollIntervalMs, hasToken: Boolean(this.config.token) },
      status: { enabled: true, ...this.status },
      vaultPath: this.vaultPath,
    }
  }

  private buildSyncApi(): SyncAPI {
    return {
      getState: async () => this.state(),
      updateConfig: async (patch) => {
        // URL/token changes take effect after a reload (the mirror is bound to one server)
        // In place: RemoteClient holds the same object, so the next request carries the new author
        Object.assign(this.config, {
          url: typeof patch.url === 'string' && patch.url ? patch.url : this.config.url,
          token: patch.clearToken ? '' : (typeof patch.token === 'string' && patch.token ? patch.token : this.config.token),
          author: typeof patch.author === 'string' ? patch.author : this.config.author,
        })
        saveWebConfig(this.config)
        return this.state()
      },
      syncNow: async () => { await this.poll(); return this.state() },
      testConnection: async (url, token) => testConnection(url ?? this.config.url, token ?? this.config.token, this.fetchImpl),
      search: async (query, topK = 10) => {
        try { return { ok: true, hits: await this.client.search(query, topK) } }
        catch (e) { return { ok: false, hits: [], reason: e instanceof Error ? e.message : String(e) } }
      },
      onStatus: (cb) => { this.statusListeners.add(cb); return () => { this.statusListeners.delete(cb) } },
    }
  }

  dispose(): void {
    void this.api.watchStop()
    this.listeners.clear()
    this.statusListeners.clear()
  }
}

/** Reachability + token check used by the connect screen and the Server tab. */
export async function testConnection(url: string, token: string, fetchImpl?: FetchLike): Promise<{ ok: boolean; error?: string; head?: number; files?: number }> {
  try {
    const client = new RemoteClient({ url, token, author: '' }, fetchImpl)
    if (!(await client.health())) return { ok: false, error: 'server did not answer /health' }
    const m = await client.manifest(0)
    return { ok: true, head: m.head, files: m.files.filter(f => !f.deleted).length }
  } catch (e) {
    if (e instanceof RemoteError && e.status === 401) return { ok: false, error: 'team token rejected' }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function mimeFor(path: string, fallback: string): string {
  if (fallback && fallback !== 'application/octet-stream') return fallback
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic' } as Record<string, string>)[ext] ?? 'application/octet-stream'
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  if (typeof FileReader !== 'undefined' && typeof Blob !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }))
    })
  }
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return Promise.resolve(`data:${mime};base64,${btoa(bin)}`)
}

let installed: RemoteVault | null = null

/** Create the adapter for `config` and expose it as window.vaultAPI / window.syncAPI. */
export function installRemoteVault(config: WebConfig, options: RemoteVaultOptions = {}): RemoteVault {
  installed?.dispose()
  installed = new RemoteVault(config, options)
  window.vaultAPI = installed.api
  window.syncAPI = installed.sync
  return installed
}

export function currentRemoteVault(): RemoteVault | null { return installed }
