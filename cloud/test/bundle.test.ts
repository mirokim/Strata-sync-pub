import { describe, it, expect, beforeEach } from 'vitest'
import { buildBundle, serveBundle, readBundle, DOCS_BUNDLE_KEY } from '../src/bundle.js'
import { route, type Env } from '../src/index.js'
import { putFile, deleteFile, type SyncDeps } from '../src/sync.js'
import { MemoryMeta, MemoryBlobs, enc } from './fakes.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs
let reads: string[]

beforeEach(() => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs(); reads = []
  const get = blobs.get.bind(blobs)
  blobs.get = async (p: string) => { reads.push(p); return get(p) }
  deps = { meta, blobs, maxFileBytes: 1024 * 1024 }
})

const put = (path: string, text: string, authorSub = '') => putFile(deps, { path, body: enc(text), mtime: 1, author: 'miro', authorSub })

describe('docs bundle', () => {
  it('holds every live team document with its text, and nobody\'s personal documents', async () => {
    await put('a.md', 'A'); await put('b.md', 'B'); await put('img.png', 'png')
    await put('_personal/alice/secret.md', 'S', 'alice')
    await put('gone.md', 'x'); await deleteFile(deps, 'gone.md', undefined, 'miro', '')
    const bundle = (await readBundle(await serveBundle(deps)))!
    expect(bundle.head).toBe(await meta.head())
    expect(bundle.docs.map(d => [d.path, d.content])).toEqual([['a.md', 'A'], ['b.md', 'B'], ['img.png', null]])
    expect(blobs.objects.has(DOCS_BUNDLE_KEY)).toBe(true)
  })

  it('reuses unchanged documents from the previous bundle and reads only what moved', async () => {
    await put('a.md', 'A'); await put('b.md', 'B')
    const first = await buildBundle(deps, null)
    await put('b.md', 'B2'); await put('c.md', 'C')
    reads = []
    const second = await buildBundle(deps, first.bundle)
    expect(reads.sort()).toEqual(['b.md', 'c.md'])
    expect(Object.fromEntries(second.bundle.docs.map(d => [d.path, d.content]))).toEqual({ 'a.md': 'A', 'b.md': 'B2', 'c.md': 'C' })
  })

  it('stops its head before the first unread row when the read budget runs out', async () => {
    for (let i = 0; i < 5; i++) await put(`d${i}.md`, `D${i}`)
    const partial = await buildBundle(deps, null, { maxReads: 2 })
    expect(partial.partial).toBe(true)
    expect(partial.bundle.head).toBe(2)                       // d2 (seq 3) is the first unread row
    expect(partial.bundle.docs.map(d => d.path)).toEqual(['d0.md', 'd1.md'])
    const next = await buildBundle(deps, partial.bundle, { maxReads: 2 })
    expect(next.bundle.head).toBe(4)
    const done = await buildBundle(deps, next.bundle, { maxReads: 2 })
    expect(done.partial).toBe(false)
    expect(done.bundle.docs).toHaveLength(5)
  })

  it('serves a slightly stale bundle at once and refreshes it in the background', async () => {
    await put('a.md', 'A')
    await serveBundle(deps)
    await put('b.md', 'B')
    const later: Promise<unknown>[] = []
    const served = (await readBundle(await serveBundle(deps, { background: w => later.push(w) })))!
    expect(served.docs.map(d => d.path)).toEqual(['a.md'])  // the client's delta brings b.md
    await Promise.all(later)
    const refreshed = (await readBundle(blobs.objects.get(DOCS_BUNDLE_KEY)!))!
    expect(refreshed.docs.map(d => d.path)).toEqual(['a.md', 'b.md'])
  })

  it('rebuilds when the server was re-created (generation changed)', async () => {
    await put('a.md', 'A')
    await serveBundle(deps)
    meta.gen = 2
    reads = []
    const bundle = (await readBundle(await serveBundle(deps, { background: () => { throw new Error('must rebuild inline') } })))!
    expect(bundle.generation).toBe(2)
    expect(reads).toEqual([DOCS_BUNDLE_KEY])                // unchanged text is reused (etag = content hash)
  })
})

describe('routes', () => {
  const env = { TEAM_TOKEN: 'secret', ALLOWED_ORIGINS: '*' } as unknown as Env
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext

  it('GET /v1/bundle returns the gzip bundle', async () => {
    await put('a.md', 'A')
    const res = await route(new Request('https://w/v1/bundle', { headers: { authorization: 'Bearer secret' } }), env, ctx, deps)
    expect(res.status).toBe(200)
    const bundle = (await readBundle(new Uint8Array(await res.arrayBuffer())))!
    expect(bundle.docs.map(d => d.content)).toEqual(['A'])
  })

  it('GET /v1/docs?personal=1 returns only the viewer\'s own personal documents', async () => {
    await put('team.md', 'T')
    await put('_personal/alice/mine.md', 'M', 'alice')
    await put('_personal/bob/theirs.md', 'X', 'bob')
    const res = await route(new Request('https://w/v1/docs?personal=1'), env, ctx, deps, { sub: 'alice', email: '', name: 'Alice' })
    const body = await res.json() as { docs: { path: string; content: string }[] }
    expect(body.docs.map(d => [d.path, d.content])).toEqual([['_personal/alice/mine.md', 'M']])
    const service = await route(new Request('https://w/v1/docs?personal=1', { headers: { authorization: 'Bearer secret' } }), env, ctx, deps)
    expect(((await service.json()) as { docs: unknown[] }).docs).toEqual([])
  })
})
