/**
 * Team vault sync engine (Electron main process).
 *
 * Keeps a local vault folder in step with the Strata Sync cloud Worker (cloud/src/sync.ts):
 *   - pull: ask for every change after the last sequence number we processed, apply it
 *   - push: after a local edit, upload with `If-Match` on the hash we last saw from the server
 *   - conflict: when both sides changed, the local version is kept next to the file as
 *     `<name> (conflict <author> <time>).md` and the server version takes the original name —
 *     nothing is ever silently lost, and the team sees the disagreement in the vault itself
 *
 * All I/O goes through `deps` (fs, fetch, clock, timers) so the engine is unit-tested against a
 * temp directory and an in-process fake of the Worker. `start()` is idempotent; everything runs
 * on one internal queue so a pull never interleaves with a push.
 */
'use strict'

const path = require('node:path')
const crypto = require('node:crypto')

const STATE_DIR = '.strata-sync'
const STATE_FILE = 'sync-state.json'
const DEFAULT_PULL_INTERVAL_MS = 30_000
const MAX_PULL_INTERVAL_MS = 5 * 60_000
const PUSH_DEBOUNCE_MS = 2_000
const SYNC_EXTENSIONS = new Set(['.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.canvas'])

/** Relative path (forward slashes) is eligible for sync. Dot-folders/files are private to a machine. */
function isSyncable(relPath) {
  const p = relPath.replace(/\\/g, '/')
  if (!p || p.includes('..')) return false
  const segments = p.split('/')
  if (segments.some(s => s.startsWith('.') || s === 'node_modules')) return false
  return SYNC_EXTENSIONS.has(path.posix.extname(p).toLowerCase())
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function conflictName(relPath, author, when) {
  const ext = path.posix.extname(relPath)
  const base = relPath.slice(0, relPath.length - ext.length)
  const d = new Date(when)
  const pad = n => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`
  const who = (author || 'local').replace(/[\\/:*?"<>|]/g, '_')
  return `${base} (conflict ${who} ${stamp})${ext}`
}

class SyncEngine {
  /**
   * @param {object} o
   * @param {string} o.vaultPath
   * @param {{ url: string, token: string, author: string, maxFileBytes?: number, pullIntervalMs?: number }} o.config
   * @param {{ fs: typeof import('node:fs/promises'), fetch: typeof fetch, now?: () => number,
   *           setTimeout?: typeof setTimeout, clearTimeout?: typeof clearTimeout, log?: (msg: string) => void }} o.deps
   * @param {(status: object) => void} [o.onStatus]
   */
  constructor({ vaultPath, config, deps, onStatus }) {
    this.vaultPath = vaultPath
    this.config = { maxFileBytes: 10 * 1024 * 1024, pullIntervalMs: DEFAULT_PULL_INTERVAL_MS, ...config }
    this.deps = { now: () => Date.now(), setTimeout, clearTimeout, log: () => {}, ...deps }
    this.onStatus = onStatus || (() => {})

    /** @type {{ version: 1, lastSeq: number, index: Record<string, { etag: string, mtime: number, size: number }> }} */
    this.state = { version: 1, lastSeq: 0, index: {} }
    this.stateLoaded = false
    this.queue = Promise.resolve()
    this.running = false
    this.pullTimer = null
    this.pushTimers = new Map()          // relPath → timeout
    this.pendingPush = new Set()         // relPaths waiting for a push
    this.consecutiveErrors = 0
    this.status = { enabled: false, inFlight: false, lastSyncAt: null, lastSeq: 0, pending: 0, conflicts: [], errors: [], lastError: null }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start() {
    if (this.running) return
    this.running = true
    await this.loadState()
    this.setStatus({ enabled: true, lastSeq: this.state.lastSeq })
    await this.syncNow()
    this.schedulePull()
  }

  stop() {
    this.running = false
    if (this.pullTimer) { this.deps.clearTimeout(this.pullTimer); this.pullTimer = null }
    for (const t of this.pushTimers.values()) this.deps.clearTimeout(t)
    this.pushTimers.clear()
    this.setStatus({ enabled: false, inFlight: false })
  }

  /** Full cycle: pull remote changes, reconcile the local tree, push what is pending. */
  syncNow() {
    return this.enqueue(async () => {
      this.setStatus({ inFlight: true })
      try {
        await this.pull()
        await this.reconcileLocal()
        await this.flushPushes()
        await this.saveState()
        this.consecutiveErrors = 0
        this.setStatus({ inFlight: false, lastSyncAt: this.deps.now(), lastSeq: this.state.lastSeq, lastError: null, pending: this.pendingPush.size })
      } catch (e) {
        this.consecutiveErrors++
        this.setStatus({ inFlight: false, lastError: String(e && e.message || e), pending: this.pendingPush.size })
        this.deps.log(`[sync] cycle failed: ${e && e.message || e}`)
      }
    })
  }

  /**
   * Called by the file watcher for every change under the vault. Echoes of our own pull writes
   * are harmless: pushOne hashes the file and finds it already matches the index, so no request
   * is made.
   */
  noteLocalChange(relPath) {
    const rel = relPath.replace(/\\/g, '/')
    if (!isSyncable(rel) || !this.running) return
    this.schedulePush(rel)
  }

  getStatus() { return { ...this.status, pending: this.pendingPush.size } }

  // ── Internals: scheduling ──────────────────────────────────────────────────

  enqueue(fn) {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => {})
    return run
  }

  schedulePull() {
    if (!this.running) return
    const backoff = Math.min(this.config.pullIntervalMs * 2 ** Math.min(this.consecutiveErrors, 4), MAX_PULL_INTERVAL_MS)
    this.pullTimer = this.deps.setTimeout(() => { this.pullTimer = null; this.syncNow().finally(() => this.schedulePull()) }, backoff)
  }

  schedulePush(rel) {
    this.pendingPush.add(rel)
    this.setStatus({ pending: this.pendingPush.size })
    const prev = this.pushTimers.get(rel)
    if (prev) this.deps.clearTimeout(prev)
    this.pushTimers.set(rel, this.deps.setTimeout(() => {
      this.pushTimers.delete(rel)
      this.enqueue(() => this.pushOne(rel).then(() => this.saveState()).catch(e => this.deps.log(`[sync] push ${rel} failed: ${e.message}`)))
    }, PUSH_DEBOUNCE_MS))
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch }
    this.onStatus(this.getStatus())
  }

  // ── Internals: state ───────────────────────────────────────────────────────

  abs(rel) { return path.join(this.vaultPath, rel) }
  statePath() { return path.join(this.vaultPath, STATE_DIR, STATE_FILE) }

  async loadState() {
    try {
      const raw = await this.deps.fs.readFile(this.statePath(), 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && parsed.version === 1 && typeof parsed.lastSeq === 'number' && parsed.index) this.state = parsed
    } catch { /* first run */ }
    this.stateLoaded = true
  }

  async saveState() {
    await this.deps.fs.mkdir(path.join(this.vaultPath, STATE_DIR), { recursive: true })
    await this.deps.fs.writeFile(this.statePath(), JSON.stringify(this.state), 'utf-8')
  }

  // ── Internals: local files ─────────────────────────────────────────────────

  async statLocal(rel) {
    try { const s = await this.deps.fs.stat(this.abs(rel)); return s.isFile() ? { mtime: Math.floor(s.mtimeMs), size: s.size } : null }
    catch { return null }
  }

  /** sha256 of the local file, or null if it does not exist. Uses the index when mtime+size match. */
  async hashLocal(rel, stat) {
    const s = stat === undefined ? await this.statLocal(rel) : stat
    if (!s) return null
    const idx = this.state.index[rel]
    if (idx && idx.mtime === s.mtime && idx.size === s.size) return idx.etag
    return sha256(await this.deps.fs.readFile(this.abs(rel)))
  }

  async writeLocal(rel, bytes, mtime, etag) {
    const file = this.abs(rel)
    await this.deps.fs.mkdir(path.dirname(file), { recursive: true })
    await this.deps.fs.writeFile(file, bytes)
    const when = new Date(mtime)
    try { await this.deps.fs.utimes(file, when, when) } catch { /* not fatal */ }
    const s = await this.statLocal(rel)
    this.state.index[rel] = { etag, mtime: s ? s.mtime : mtime, size: bytes.byteLength }
  }

  async listLocal() {
    const out = []
    const walk = async (dir) => {
      let entries
      try { entries = await this.deps.fs.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        const full = path.join(dir, e.name)
        const rel = path.relative(this.vaultPath, full).replace(/\\/g, '/')
        if (e.isDirectory()) await walk(full)
        else if (e.isFile() && isSyncable(rel)) out.push(rel)
      }
    }
    await walk(this.vaultPath)
    return out
  }

  // ── Internals: HTTP ────────────────────────────────────────────────────────

  async api(method, route, { headers = {}, body, query = {} } = {}) {
    const url = new URL(route, this.config.url.endsWith('/') ? this.config.url : this.config.url + '/')
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))
    const res = await this.deps.fetch(url.toString(), {
      method, body,
      // HTTP header values are Latin-1 only; a Korean display name would make fetch throw.
      headers: { authorization: `Bearer ${this.config.token}`, 'x-author': encodeURIComponent(this.config.author || ''), ...headers },
    })
    return res
  }

  // ── Internals: pull ────────────────────────────────────────────────────────

  async pull() {
    let since = this.state.lastSeq
    for (;;) {
      const res = await this.api('GET', 'v1/manifest', { query: { since } })
      if (!res.ok) throw new Error(`manifest ${res.status}`)
      const { files, next, head } = await res.json()
      // The server was reset (new deployment, wiped database): its sequence restarted below ours.
      // Start over from 0 so nothing is skipped; local files are reconciled by hash afterwards.
      if (typeof head === 'number' && head < this.state.lastSeq) {
        this.deps.log(`[sync] server sequence ${head} is behind ours (${this.state.lastSeq}) — resetting cursor`)
        // Forget what the old server had: local files then re-index against the new one (matching
        // hashes are simply indexed, unknown ones are uploaded, disagreements become conflict copies).
        this.state = { version: 1, lastSeq: 0, index: {} }
        since = 0
        continue
      }
      for (const row of files) {
        await this.applyRemote(row)
        this.state.lastSeq = Math.max(this.state.lastSeq, row.seq)
      }
      if (next === null || next === undefined) break
      since = next
    }
  }

  /** Bring one path in line with a manifest row (or a 409 `current` row). */
  async applyRemote(row) {
    const rel = row.path
    if (!isSyncable(rel)) return
    const idx = this.state.index[rel]
    const stat = await this.statLocal(rel)
    const localHash = await this.hashLocal(rel, stat)
    const localModified = stat !== null && (!idx || localHash !== idx.etag)

    if (row.deleted) {
      if (stat && !localModified) {
        await this.deps.fs.unlink(this.abs(rel)).catch(() => {})
        delete this.state.index[rel]
      } else if (stat && localModified) {
        // Someone deleted a file we edited: keep our copy and let push recreate it
        delete this.state.index[rel]
        this.schedulePush(rel)
      } else {
        delete this.state.index[rel]
      }
      return
    }

    // The server still holds exactly what we last synced: nothing new arrived. Any local edit is
    // simply pending (it will be pushed), not a conflict.
    if (idx && row.etag === idx.etag) return

    if (localHash === row.etag) {
      this.state.index[rel] = { etag: row.etag, mtime: stat ? stat.mtime : row.mtime, size: stat ? stat.size : row.size }
      this.pendingPush.delete(rel)
      return
    }

    const res = await this.api('GET', 'v1/file', { query: { path: rel } })
    if (res.status === 404) return   // raced with a delete; the tombstone will arrive
    if (!res.ok) throw new Error(`download ${rel}: ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const etag = (res.headers.get('etag') || '').replace(/^"|"$/g, '') || sha256(bytes)
    const mtime = Number(res.headers.get('x-mtime')) || row.mtime || this.deps.now()

    if (localModified) {
      const copy = conflictName(rel, this.config.author, this.deps.now())
      const localBytes = await this.deps.fs.readFile(this.abs(rel))
      // Plain local write, deliberately not indexed: the copy is a new local file that pushOne
      // must upload (If-None-Match: *) so the rest of the team sees the disagreement too.
      await this.deps.fs.writeFile(this.abs(copy), localBytes)
      this.status.conflicts = [...this.status.conflicts.slice(-49), { path: rel, keptAs: copy, at: this.deps.now(), remoteAuthor: row.author || '' }]
      this.schedulePush(copy)
      this.deps.log(`[sync] conflict on ${rel}: local copy kept as ${copy}`)
    }
    await this.writeLocal(rel, bytes, mtime, etag)
    this.pendingPush.delete(rel)
  }

  // ── Internals: reconcile & push ────────────────────────────────────────────

  /** Local files the index does not know about, or whose mtime/size moved, need a push. */
  async reconcileLocal() {
    const present = new Set(await this.listLocal())
    for (const rel of present) {
      const idx = this.state.index[rel]
      const s = await this.statLocal(rel)
      if (!idx || !s || idx.mtime !== s.mtime || idx.size !== s.size) this.pendingPush.add(rel)
    }
    // Indexed files that vanished locally were deleted while we were not watching
    for (const rel of Object.keys(this.state.index)) {
      if (!present.has(rel)) this.pendingPush.add(rel)
    }
  }

  async flushPushes() {
    for (const rel of [...this.pendingPush]) await this.pushOne(rel)
  }

  async pushOne(rel) {
    const idx = this.state.index[rel]
    const stat = await this.statLocal(rel)

    if (!stat) {
      // Deleted locally
      this.pendingPush.delete(rel)
      if (!idx) return
      const res = await this.api('DELETE', 'v1/file', { query: { path: rel }, headers: { 'if-match': `"${idx.etag}"` } })
      if (res.status === 409) { const { current } = await res.json(); await this.applyRemote(current); return }
      if (!res.ok && res.status !== 404) throw new Error(`delete ${rel}: ${res.status}`)
      delete this.state.index[rel]
      return
    }

    if (stat.size > this.config.maxFileBytes) {
      this.pendingPush.delete(rel)
      this.recordError(rel, `skipped: ${stat.size} bytes exceeds the ${this.config.maxFileBytes} byte limit`)
      return
    }

    const bytes = await this.deps.fs.readFile(this.abs(rel))
    const etag = sha256(bytes)
    if (idx && idx.etag === etag) {
      this.state.index[rel] = { etag, mtime: stat.mtime, size: stat.size }
      this.pendingPush.delete(rel)
      return
    }

    const headers = { 'x-mtime': String(stat.mtime), 'content-type': 'application/octet-stream' }
    if (idx) headers['if-match'] = `"${idx.etag}"`
    else headers['if-none-match'] = '*'
    const res = await this.api('PUT', 'v1/file', { query: { path: rel }, headers, body: bytes })

    if (res.status === 409) {
      const { current } = await res.json()
      if (current && !current.deleted) {
        await this.applyRemote(current)          // keeps our version as a conflict copy
      } else if (idx) {
        // Server has a tombstone but we still hold the file: recreate it
        delete this.state.index[rel]
        this.pendingPush.add(rel)
      }
      return
    }
    if (res.status === 413 || res.status === 400) {
      this.pendingPush.delete(rel)
      this.recordError(rel, `rejected by server (${res.status})`)
      return
    }
    if (!res.ok && res.status !== 204) throw new Error(`upload ${rel}: ${res.status}`)

    // lastSeq is deliberately NOT advanced here: other clients' changes may sit between our old
    // lastSeq and this upload's seq, and skipping ahead would lose them. The next pull returns our
    // own row and applyRemote sees a matching hash (no-op).
    this.state.index[rel] = { etag, mtime: stat.mtime, size: stat.size }
    this.pendingPush.delete(rel)
  }

  recordError(rel, message) {
    this.status.errors = [...this.status.errors.slice(-49), { path: rel, message, at: this.deps.now() }]
    this.deps.log(`[sync] ${rel}: ${message}`)
  }
}

module.exports = { SyncEngine, isSyncable, conflictName, sha256, STATE_DIR, STATE_FILE }
