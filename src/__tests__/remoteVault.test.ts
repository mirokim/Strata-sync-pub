/**
 * Remote vault adapter (web mode) against an in-process fake of the Worker's sync protocol.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { RemoteVault, conflictName, testConnection, installRemoteVault, currentRemoteVault } from '@/web/remoteVault'
import { MemoryCacheBackend } from '@/web/remoteCache'
import { loadWebConfig, normalizeServerUrl, remoteVaultPath, saveWebConfig, clearWebConfig, WEB_CONFIG_KEY } from '@/web/config'

// ── Fake Worker ──────────────────────────────────────────────────────────────

interface Row { path: string; etag: string; size: number; mtime: number; author: string; deleted: boolean; seq: number; updatedAt: number }

class FakeWorker {
  rows = new Map<string, Row>()
  blobs = new Map<string, Uint8Array>()
  seq = 0
  token = 'tok'
  requests: string[] = []
  failNext: number | null = null

  private etagOf(bytes: Uint8Array): string {
    let h = 2166136261
    for (const b of bytes) { h ^= b; h = Math.imul(h, 16777619) >>> 0 }
    return `e${h.toString(16)}-${bytes.byteLength}`
  }

  /** Server-side write (another user, a bot, the nightly batch). */
  put(path: string, text: string, author = 'other'): Row {
    const bytes = new TextEncoder().encode(text)
    const row: Row = { path, etag: this.etagOf(bytes), size: bytes.byteLength, mtime: Date.now(), author, deleted: false, seq: ++this.seq, updatedAt: Date.now() }
    this.rows.set(path, row); this.blobs.set(path, bytes)
    return row
  }
  del(path: string): void {
    const cur = this.rows.get(path)
    if (!cur) return
    this.rows.set(path, { ...cur, deleted: true, seq: ++this.seq })
    this.blobs.delete(path)
  }
  reset(): void { this.rows.clear(); this.blobs.clear(); this.seq = 0 }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    const method = (init.method ?? 'GET').toUpperCase()
    this.requests.push(`${method} ${url.pathname}${url.search}`)
    if (this.failNext !== null) { const s = this.failNext; this.failNext = null; return new Response('boom', { status: s }) }
    const headers = new Headers(init.headers as Record<string, string>)
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } })

    if (url.pathname === '/health') return json(200, { ok: true })
    if (headers.get('authorization') !== `Bearer ${this.token}`) return json(401, { error: 'unauthorized' })

    if (url.pathname === '/v1/docs') {
      const after = Number(url.searchParams.get('after') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 200)
      const rows = [...this.rows.values()].filter(r => r.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit)
      const docs = rows.map(r => ({ ...r, content: !r.deleted && r.path.endsWith('.md') ? new TextDecoder().decode(this.blobs.get(r.path)!) : null }))
      return json(200, { head: this.seq, next: rows.length === limit ? rows[rows.length - 1].seq : null, docs })
    }
    if (url.pathname === '/v1/manifest') {
      const since = Number(url.searchParams.get('since') ?? 0)
      const files = [...this.rows.values()].filter(r => r.seq > since)
      return json(200, { head: this.seq, next: null, files })
    }
    if (url.pathname === '/v1/search') return json(200, { hits: [{ path: 'a.md', docId: 'a', heading: 'A', score: 0.9 }] })
    if (url.pathname === '/v1/file') {
      const path = url.searchParams.get('path')!
      if (path.startsWith('.strata-sync/')) return json(400, { error: 'invalid path' })
      const cur = this.rows.get(path)
      const live = cur && !cur.deleted ? cur : null
      if (method === 'GET') {
        if (!live) return json(404, { error: 'not found' })
        return new Response(this.blobs.get(path)!, { status: 200, headers: { etag: `"${live.etag}"`, 'x-mtime': String(live.mtime), 'content-type': path.endsWith('.md') ? 'text/markdown' : 'application/octet-stream' } })
      }
      if (method === 'PUT') {
        const ifMatch = headers.get('if-match')?.replace(/^"|"$/g, '')
        if (headers.get('if-none-match') === '*' && live) return json(409, { error: 'already exists', current: live })
        if (ifMatch && (!live || live.etag !== ifMatch)) return json(409, { error: 'etag mismatch', current: live })
        const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer())
        const etag = this.etagOf(bytes)
        if (live && live.etag === etag) return new Response(null, { status: 204, headers: { etag: `"${etag}"` } })
        const author = decodeURIComponent(headers.get('x-author') ?? '')
        const row: Row = { path, etag, size: bytes.byteLength, mtime: Number(headers.get('x-mtime')), author, deleted: false, seq: ++this.seq, updatedAt: Date.now() }
        this.rows.set(path, row); this.blobs.set(path, bytes)
        return json(live ? 200 : 201, row, { etag: `"${etag}"` })
      }
      if (method === 'DELETE') {
        const ifMatch = headers.get('if-match')?.replace(/^"|"$/g, '')
        if (!live) return json(404, { error: 'not found' })
        if (ifMatch && live.etag !== ifMatch) return json(409, { error: 'etag mismatch', current: live })
        this.del(path)
        return new Response(null, { status: 204 })
      }
    }
    return json(404, { error: 'not found' })
  }
}

// ── Harness ──────────────────────────────────────────────────────────────────

let server: FakeWorker
let vault: RemoteVault
let notices: string[]
let timers: { fn: () => void; ms: number }[]
let clock: number
const CONFIG = { url: 'https://strata.example', token: 'tok', author: '미로' }

function makeVault(backend = new MemoryCacheBackend()) {
  return new RemoteVault(CONFIG, {
    fetchImpl: server.fetch,
    backend,
    pollIntervalMs: 1000,
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimer: () => { timers.length = 0 },
    notify: m => { notices.push(m) },
  })
}

beforeEach(() => {
  server = new FakeWorker()
  notices = []; timers = []; clock = new Date('2026-09-12T10:30:00').getTime()
  server.put('active/Combat System.md', '# Combat\n\nMelee and [[Stamina]].')
  server.put('active/Stamina.md', '# Stamina\n\nRegen.')
  server.put('assets/logo.png', 'PNGDATA')
  vault = makeVault()
})

const A = (rel: string) => `remote://strata.example/${rel}`

describe('config', () => {
  it('normalises server URLs and derives a stable pseudo vault path', () => {
    expect(normalizeServerUrl('strata.example')).toBe('https://strata.example')
    expect(normalizeServerUrl('https://strata.example/some/path/')).toBe('https://strata.example')
    expect(normalizeServerUrl('ftp://x')).toBeNull()
    expect(normalizeServerUrl('')).toBeNull()
    expect(remoteVaultPath('https://strata-sync.miro.workers.dev')).toBe('remote://strata-sync.miro.workers.dev')
  })
  it('round-trips through localStorage and rejects incomplete configs', () => {
    clearWebConfig()
    expect(loadWebConfig()).toBeNull()
    saveWebConfig(CONFIG)
    expect(loadWebConfig()).toEqual(CONFIG)
    localStorage.setItem(WEB_CONFIG_KEY, JSON.stringify({ url: 'https://x.example' }))
    expect(loadWebConfig()).toBeNull()
    clearWebConfig()
  })
})

describe('loadFiles / scanMetadata', () => {
  it('returns markdown files with content, folders and an image registry', async () => {
    const r = await vault.api.loadFiles(vault.vaultPath)
    expect(r.files.map(f => f.relativePath).sort()).toEqual(['active/Combat System.md', 'active/Stamina.md'])
    expect(r.files[0].absolutePath).toBe(A(r.files[0].relativePath))
    expect(r.files.find(f => f.relativePath === 'active/Stamina.md')!.content).toContain('Regen')
    expect(r.folders).toEqual(['active', 'assets'])
    expect(r.imageRegistry).toEqual({ 'logo.png': { relativePath: 'assets/logo.png', absolutePath: A('assets/logo.png') } })
    const meta = await vault.api.scanMetadata!(vault.vaultPath)
    expect(meta.map(m => m.relativePath).sort()).toEqual(['active/Combat System.md', 'active/Stamina.md'])
  })

  it('only fetches what changed since the cursor and survives a reload from the cache', async () => {
    const backend = new MemoryCacheBackend()
    const v1 = makeVault(backend)
    await v1.api.loadFiles(v1.vaultPath)
    await v1.cache.flush()
    server.put('active/New.md', '# New')
    server.del('active/Stamina.md')

    const v2 = makeVault(backend)
    server.requests.length = 0
    const r = await v2.api.loadFiles(v2.vaultPath)
    expect(server.requests[0]).toBe('GET /v1/docs?after=3&limit=500')
    expect(r.files.map(f => f.relativePath).sort()).toEqual(['active/Combat System.md', 'active/New.md'])
  })

  it('persists deletions and our own writes as deltas', async () => {
    const backend = new MemoryCacheBackend()
    const v1 = makeVault(backend)
    await v1.api.loadFiles(v1.vaultPath)
    await v1.api.saveFile(A('active/Mine.md'), 'mine')
    await v1.api.deleteFile(A('active/Stamina.md'))
    await v1.cache.flush()
    const snap = await backend.load()
    expect(snap!.rows.map(r => r.path).sort()).toEqual(['active/Combat System.md', 'active/Mine.md', 'assets/logo.png'])
    expect(snap!.rows.find(r => r.path === 'active/Mine.md')!.content).toBe('mine')
  })

  it('warns once when the token is rejected', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    server.token = 'rotated'
    await vault.poll(); await vault.poll()
    expect(notices.filter(n => n.includes('token'))).toHaveLength(1)
    expect(vault.status.lastError).toContain('token')
  })

  it('serves the mirror when the server is down, and fails only when the mirror is empty', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    server.failNext = 502
    const r = await vault.api.loadFiles(vault.vaultPath)
    expect(r.files).toHaveLength(2)
    expect(vault.status.lastError).toContain('502')

    const empty = makeVault()
    server.failNext = 502
    await expect(empty.api.loadFiles(empty.vaultPath)).rejects.toThrow()
  })

  it('drops the mirror when the server sequence went backwards (reset server)', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    server.reset()
    server.put('fresh/Only.md', '# Only')
    const r = await vault.api.loadFiles(vault.vaultPath)
    expect(r.files.map(f => f.relativePath)).toEqual(['fresh/Only.md'])
  })
})

describe('saveFile', () => {
  it('creates and updates with an optimistic lock, and records the author', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    await vault.api.saveFile(A('active/Notes.md'), 'v1')
    expect(server.rows.get('active/Notes.md')!.author).toBe('미로')
    server.requests.length = 0
    await vault.api.saveFile(A('active/Notes.md'), 'v2')
    expect(server.requests).toEqual(['PUT /v1/file?path=active%2FNotes.md'])
    expect(new TextDecoder().decode(server.blobs.get('active/Notes.md'))).toBe('v2')
    expect(await vault.api.readFile(A('active/Notes.md'))).toBe('v2')
    // unchanged content → 204, still fine
    await expect(vault.api.saveFile(A('active/Notes.md'), 'v2')).resolves.toMatchObject({ success: true })
  })

  it('keeps both versions on a lost race: server text stays, ours becomes a conflict copy', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    server.put('active/Stamina.md', '# Stamina\n\nTheirs.', 'bob')
    const changes: (string | undefined)[] = []
    vault.api.onChanged(d => changes.push(d.changedFile))

    const r = await vault.api.saveFile(A('active/Stamina.md'), '# Stamina\n\nOurs.')
    const copy = conflictName('active/Stamina.md', '미로', clock)
    expect(copy).toBe('active/Stamina (conflict 미로 2026-09-12 1030).md')
    expect(r.path).toBe(A(copy))
    expect(new TextDecoder().decode(server.blobs.get('active/Stamina.md'))).toContain('Theirs')
    expect(new TextDecoder().decode(server.blobs.get(copy))).toContain('Ours')
    expect(await vault.api.readFile(A('active/Stamina.md'))).toContain('Theirs')
    expect(vault.status.conflicts).toHaveLength(1)
    expect(vault.status.conflicts[0]).toMatchObject({ path: 'active/Stamina.md', keptAs: copy, remoteAuthor: 'bob' })
    expect(notices[0]).toContain('bob')
    expect(changes).toEqual([undefined]) // full reload requested
  })

  it("never skips a teammate's row that landed just before our own write", async () => {
    await vault.api.loadFiles(vault.vaultPath)              // cursor = 3
    server.put('active/Stamina.md', 'bob was here', 'bob')  // seq 4, not yet pulled
    await vault.api.saveFile(A('active/Mine.md'), 'mine')  // seq 5
    const events: (string | undefined)[] = []
    vault.api.onChanged(d => events.push(d.changedFile))
    await vault.poll()
    expect(events).toEqual(['active/Stamina.md'])
    expect(await vault.api.readFile(A('active/Stamina.md'))).toBe('bob was here')
  })

  it('numbers conflict copies when two races land in the same minute', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    server.put('active/Stamina.md', 'theirs 1', 'bob')
    const first = await vault.api.saveFile(A('active/Stamina.md'), 'ours 1')
    server.put('active/Stamina.md', 'theirs 2', 'bob')
    const second = await vault.api.saveFile(A('active/Stamina.md'), 'ours 2')
    expect(first.path).toBe(A('active/Stamina (conflict 미로 2026-09-12 1030).md'))
    expect(second.path).toBe(A('active/Stamina (conflict 미로 2026-09-12 1030)-2.md'))
    expect(new TextDecoder().decode(server.blobs.get('active/Stamina (conflict 미로 2026-09-12 1030)-2.md'))).toBe('ours 2')
  })

  it('keeps .strata-sync/ files in the browser only', async () => {
    await vault.api.saveFile(A('.strata-sync/personas.md'), 'persona config')
    expect(server.rows.has('.strata-sync/personas.md')).toBe(false)
    expect(await vault.api.readFile(A('.strata-sync/personas.md'))).toBe('persona config')
    expect(await vault.api.readFile(A('.strata-sync/missing.md'))).toBeNull()
  })

  it('surfaces write failures in the status log', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    server.failNext = 500
    await expect(vault.api.saveFile(A('active/Stamina.md'), 'x')).rejects.toThrow()
    expect(vault.status.errors[0].path).toBe('active/Stamina.md')
  })
})

describe('rename / move / delete / folders', () => {
  beforeEach(async () => { await vault.api.loadFiles(vault.vaultPath) })

  it('renames by copying then deleting, refusing to clobber', async () => {
    const r = await vault.api.renameFile(A('active/Stamina.md'), 'Endurance.md')
    expect(r.newPath).toBe(A('active/Endurance.md'))
    expect(server.rows.get('active/Stamina.md')!.deleted).toBe(true)
    expect(new TextDecoder().decode(server.blobs.get('active/Endurance.md'))).toContain('Regen')
    await expect(vault.api.renameFile(A('active/Endurance.md'), 'Combat System.md')).rejects.toThrow(/exists/)
    await expect(vault.api.renameFile(A('active/Endurance.md'), 'sub/x.md')).rejects.toThrow()
  })

  it('moves markdown and binaries (fetched from the server) between folders', async () => {
    const r = await vault.api.moveFile(A('assets/logo.png'), A('archive'))
    expect(r.newPath).toBe(A('archive/logo.png'))
    expect(server.blobs.has('archive/logo.png')).toBe(true)
    expect(server.rows.get('assets/logo.png')!.deleted).toBe(true)
    await vault.api.moveFile(A('active/Stamina.md'), vault.vaultPath) // to the root
    expect(server.blobs.has('Stamina.md')).toBe(true)
    expect((await vault.api.loadFiles(vault.vaultPath)).folders).toEqual(['active', 'archive'])
  })

  it('deletes with the last-seen etag and forgets the row', async () => {
    await vault.api.deleteFile(A('active/Stamina.md'))
    expect(server.rows.get('active/Stamina.md')!.deleted).toBe(true)
    expect((await vault.api.loadFiles(vault.vaultPath)).files).toHaveLength(1)
    // someone edited in between → refuse rather than delete their work
    server.put('active/Combat System.md', 'edited', 'bob')
    await expect(vault.api.deleteFile(A('active/Combat System.md'))).rejects.toThrow()
  })

  it('remembers empty folders locally until a file lands in them', async () => {
    await vault.api.createFolder(A('drafts/ideas'))
    expect((await vault.api.loadFiles(vault.vaultPath)).folders).toEqual(['active', 'assets', 'drafts', 'drafts/ideas'])
    await vault.api.saveFile(A('drafts/ideas/One.md'), '# One')
    expect((await vault.api.loadFiles(vault.vaultPath)).folders).toEqual(['active', 'assets', 'drafts', 'drafts/ideas'])
  })
})

describe('images', () => {
  it('reads images as data URLs (cached) and finds them by name', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    const url = await vault.api.readImage(A('assets/logo.png'))
    expect(url).toMatch(/^data:image\/png;base64,/)
    server.requests.length = 0
    expect(await vault.api.readImage(A('assets/logo.png'))).toBe(url)
    expect(server.requests).toEqual([]) // served from the image cache
    expect(await vault.api.findImageByName!('LOGO.png')).toBe(url)
    expect(await vault.api.findImageByName!('nope.png')).toBeNull()
    expect(await vault.api.readImage(A('assets/missing.png'))).toBeNull()
  })
})

describe('watch (polling)', () => {
  it('emits a single changedFile for one edit and a full reload for several, ignoring our own writes', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    const events: (string | undefined)[] = []
    vault.api.onChanged(d => events.push(d.changedFile))
    await vault.api.watchStart(vault.vaultPath)
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(1000)

    await vault.poll()
    expect(events).toEqual([]) // nothing happened

    await vault.api.saveFile(A('active/Mine.md'), 'mine')
    await vault.poll()
    expect(events).toEqual([]) // our own write is not a foreign change

    server.put('active/Stamina.md', 'edited by bob', 'bob')
    await vault.poll()
    expect(events).toEqual(['active/Stamina.md'])

    server.put('active/A.md', 'a'); server.put('active/B.md', 'b')
    await vault.poll()
    expect(events).toEqual(['active/Stamina.md', undefined])

    server.del('active/A.md')
    await vault.poll()
    expect(events).toEqual(['active/Stamina.md', undefined, undefined])

    await vault.api.watchStop()
    expect(timers).toHaveLength(0)
  })
})

describe('syncAPI shim', () => {
  it('reports state, searches the team index and tests connections', async () => {
    await vault.api.loadFiles(vault.vaultPath)
    const s = await vault.sync.getState()
    expect(s.vaultPath).toBe('remote://strata.example')
    expect(s.config.hasToken).toBe(true)
    expect(s.config.token).toBe('') // never handed back to the UI
    expect(s.status.lastSeq).toBe(3)

    const hits = await vault.sync.search('a')
    expect(hits.ok).toBe(true)
    expect(hits.hits[0].path).toBe('a.md')

    expect(await vault.sync.testConnection()).toEqual({ ok: true, head: 3, files: 3 })
    expect(await testConnection('https://strata.example', 'wrong', server.fetch)).toMatchObject({ ok: false, error: 'team token rejected' })
  })

  it('updateConfig persists the author', async () => {
    clearWebConfig()
    await vault.sync.updateConfig({ author: 'Kim' })
    expect(loadWebConfig()).toMatchObject({ author: 'Kim', url: CONFIG.url, token: CONFIG.token })
    clearWebConfig()
  })
})

describe('installRemoteVault', () => {
  it('exposes window.vaultAPI / window.syncAPI and replaces a previous install', () => {
    const first = installRemoteVault(CONFIG, { fetchImpl: server.fetch, backend: new MemoryCacheBackend() })
    expect(window.vaultAPI).toBe(first.api)
    expect(window.syncAPI).toBe(first.sync)
    const second = installRemoteVault(CONFIG, { fetchImpl: server.fetch, backend: new MemoryCacheBackend() })
    expect(currentRemoteVault()).toBe(second)
    expect(window.vaultAPI).toBe(second.api)
    delete (window as { vaultAPI?: unknown }).vaultAPI
    delete (window as { syncAPI?: unknown }).syncAPI
  })
})
