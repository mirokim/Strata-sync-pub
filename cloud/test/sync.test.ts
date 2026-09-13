import { describe, it, expect, beforeEach } from 'vitest'
import { getManifest, getFile, putFile, deleteFile, normalizeVaultPath, parseIfMatch, sha256Hex, MANIFEST_PAGE, type SyncDeps } from '../src/sync.js'
import { tokenMatches } from '../src/index.js'
import { MemoryMeta, MemoryBlobs, enc, dec } from './fakes.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs
let clock = 1_000

beforeEach(() => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs(); clock = 1_000
  deps = { meta, blobs, maxFileBytes: 1024, now: () => clock }
})

const put = (path: string, text: string, extra: Partial<Parameters<typeof putFile>[1]> = {}) =>
  putFile(deps, { path, body: enc(text), mtime: 1_700_000_000_000, author: 'miro', ...extra })

describe('path rules', () => {
  it('rejects names carrying the replacement character (a client mis-decoded its own bytes)', () => {
    expect(normalizeVaultPath('_inbox/Lee/2026-09-13 \ufffd\ufffd-\ufffd.md')).toBeNull()
    expect(normalizeVaultPath('온다/이슈/ISS-0001 배터리.md')).toBe('온다/이슈/ISS-0001 배터리.md')
  })
})

describe('normalizeVaultPath', () => {
  it('accepts vault-style names with spaces, brackets and unicode', () => {
    expect(normalizeVaultPath('active/[2026.01.28] 피드백 회의.md')).toBe('active/[2026.01.28] 피드백 회의.md')
    expect(normalizeVaultPath('\\active\\doc.md')).toBe('active/doc.md')
  })
  it('rejects traversal, empty segments, control chars and the private folder', () => {
    for (const bad of ['', '../x.md', 'a/../b.md', 'a//b.md', './a.md', 'a/./b.md', '.strata-sync/personas.md', 'a\u0000b.md', '.obsidian/workspace.json', 'notes/.hidden.md', 'x'.repeat(1025)]) {
      expect(normalizeVaultPath(bad)).toBeNull()
    }
  })
})

describe('parseIfMatch', () => {
  it('strips quotes and weak prefix, treats * and absence as no precondition', () => {
    expect(parseIfMatch(null)).toBeUndefined()
    expect(parseIfMatch('*')).toBeUndefined()
    expect(parseIfMatch('"abc"')).toBe('abc')
    expect(parseIfMatch('W/"abc"')).toBe('abc')
  })
})

describe('putFile / getFile', () => {
  it('creates, then replaces with a matching If-Match, and returns the stored row', async () => {
    const created = await put('notes/a.md', 'hello')
    expect(created.status).toBe(201)
    const row = created.body as { etag: string; seq: number; author: string }
    expect(row.seq).toBe(1)
    expect(row.author).toBe('miro')
    expect(row.etag).toBe(await sha256Hex(enc('hello')))

    const replaced = await put('notes/a.md', 'hello again', { ifMatch: row.etag })
    expect(replaced.status).toBe(200)
    expect((replaced.body as { seq: number }).seq).toBe(2)

    const got = await getFile(deps, 'notes/a.md')
    expect(got.status).toBe(200)
    expect(dec((got as { bytes: Uint8Array }).bytes)).toBe('hello again')
    expect((got as { headers: Record<string, string> }).headers['X-Author']).toBe('miro')
  })

  it('409s when the server copy moved on, and hands back the current row', async () => {
    const a = await put('doc.md', 'v1')
    const etagV1 = (a.body as { etag: string }).etag
    await put('doc.md', 'v2 by someone else', { ifMatch: etagV1, author: 'dana' })
    const stale = await put('doc.md', 'v2 by me', { ifMatch: etagV1 })
    expect(stale.status).toBe(409)
    const current = (stale.body as { current: { author: string; etag: string } }).current
    expect(current.author).toBe('dana')
    expect(current.etag).toBe(await sha256Hex(enc('v2 by someone else')))
    // the losing write did not touch storage
    expect(dec((await blobs.get('doc.md'))!)).toBe('v2 by someone else')
  })

  it('create-only (If-None-Match: *) refuses to overwrite an existing file', async () => {
    await put('doc.md', 'v1')
    expect((await put('doc.md', 'v2', { createOnly: true })).status).toBe(409)
    expect((await put('new.md', 'v1', { createOnly: true })).status).toBe(201)
  })

  it('identical content is a 204 and does not burn a seq', async () => {
    await put('doc.md', 'same')
    const again = await put('doc.md', 'same')
    expect(again.status).toBe(204)
    expect(await meta.head()).toBe(1)
  })

  it('rejects bad paths, missing mtime and oversized bodies', async () => {
    expect((await put('../evil.md', 'x')).status).toBe(400)
    expect((await put('doc.md', 'x', { mtime: NaN })).status).toBe(400)
    expect((await put('big.md', 'x'.repeat(2000))).status).toBe(413)
    expect(await meta.head()).toBe(0)
  })

  it('getFile 404s for unknown and deleted paths', async () => {
    expect((await getFile(deps, 'nope.md')).status).toBe(404)
    const a = await put('doc.md', 'v1')
    await deleteFile(deps, 'doc.md', (a.body as { etag: string }).etag, 'miro')
    expect((await getFile(deps, 'doc.md')).status).toBe(404)
  })
})

describe('deleteFile', () => {
  it('tombstones the row, removes the blob, and honours If-Match', async () => {
    const a = await put('doc.md', 'v1')
    const etag = (a.body as { etag: string }).etag
    expect((await deleteFile(deps, 'doc.md', 'wrong', 'miro')).status).toBe(409)
    const del = await deleteFile(deps, 'doc.md', etag, 'miro')
    expect(del.status).toBe(200)
    expect((del.body as { deleted: boolean; seq: number }).deleted).toBe(true)
    expect(await blobs.get('doc.md')).toBeNull()
    expect((await deleteFile(deps, 'doc.md', undefined, 'miro')).status).toBe(404)
  })

  it('a deleted path can be recreated with create-only', async () => {
    const a = await put('doc.md', 'v1')
    await deleteFile(deps, 'doc.md', (a.body as { etag: string }).etag, 'miro')
    const back = await put('doc.md', 'v2', { createOnly: true })
    expect(back.status).toBe(201)
    expect((back.body as { deleted: boolean }).deleted).toBe(false)
  })
})

describe('getManifest', () => {
  it('returns changes after `since` in order, including tombstones, with head', async () => {
    await put('a.md', '1'); await put('b.md', '2'); const c = await put('c.md', '3')
    await deleteFile(deps, 'c.md', (c.body as { etag: string }).etag, 'miro')
    const m = await getManifest(deps, 2)
    expect(m.status).toBe(200)
    const body = m.body as { head: number; next: number | null; files: { path: string; deleted: boolean; seq: number }[] }
    expect(body.head).toBe(4)
    expect(body.next).toBeNull()
    // c.md was written at seq 3 then tombstoned at seq 4 — only the latest row exists
    expect(body.files.map(f => [f.path, f.deleted, f.seq])).toEqual([['c.md', true, 4]])
  })

  it('pages with `next` when more than one page of changes exists', async () => {
    for (let i = 0; i < MANIFEST_PAGE + 5; i++) await put(`f${i}.md`, String(i))
    const first = (await getManifest(deps, 0)).body as { next: number | null; files: unknown[] }
    expect(first.files.length).toBe(MANIFEST_PAGE)
    expect(first.next).toBe(MANIFEST_PAGE)
    const second = (await getManifest(deps, first.next!)).body as { next: number | null; files: unknown[] }
    expect(second.files.length).toBe(5)
    expect(second.next).toBeNull()
  })

  it('rejects a negative since', async () => {
    expect((await getManifest(deps, -1)).status).toBe(400)
  })
})

describe('tokenMatches', () => {
  it('compares exactly and never accepts empty tokens', () => {
    expect(tokenMatches('secret', 'secret')).toBe(true)
    expect(tokenMatches('secret ', 'secret')).toBe(false)
    expect(tokenMatches('', '')).toBe(false)
    expect(tokenMatches(null, 'secret')).toBe(false)
  })
})
