import { expect, it } from 'vitest'
import { MemoryCacheBackend, RemoteCache, type CacheBackend } from '@/web/remoteCache'

const row = (path: string, seq: number, deleted = false) => ({ path, seq, deleted, etag: String(seq), content: path, size: 10, mtime: 1000, updatedAt: 1000, author: 'test', authorSub: '' })

it('retries failed rows before persisting a later cursor, even with flushes already queued', async () => {
  const disk = new MemoryCacheBackend()
  let release!: () => void
  const blocked = new Promise<void>(r => { release = r })
  let fail = true
  const backend: CacheBackend = { load: () => disk.load(), clear: () => disk.clear(), write: async d => {
    if (fail) { fail = false; await blocked; throw new Error('temporary storage failure') }
    await disk.write(d)
  } }
  const cache = new RemoteCache(backend)
  cache.apply([row('a.md', 1)])
  const first = cache.flush()
  await Promise.resolve()
  cache.apply([row('b.md', 2)])
  const second = cache.flush()
  release()
  await Promise.all([first, second])
  const reloaded = new RemoteCache(disk)
  await reloaded.load()
  expect(reloaded.cursor).toBe(2)
  expect([...reloaded.rows.keys()].sort()).toEqual(['a.md', 'b.md'])
})

it('retries failed deletions and reset does not resurrect failed writes', async () => {
  const disk = new MemoryCacheBackend()
  let fail = false
  const cache = new RemoteCache({ load: () => disk.load(), clear: () => disk.clear(), write: async d => {
    if (fail) { fail = false; throw new Error('temporary') }; await disk.write(d)
  } })
  cache.apply([row('a.md', 1)]); await cache.flush()
  fail = true
  cache.apply([row('a.md', 2, true)]); await cache.flush()
  cache.apply([row('b.md', 3)]); await cache.flush()
  expect((await disk.load())!.rows.map(r => r.path)).toEqual(['b.md'])
  fail = true
  cache.apply([row('c.md', 4)])
  const writing = cache.flush()
  await cache.reset(); await writing
  await cache.flush()
  expect((await disk.load())!.rows).toEqual([])
  expect((await disk.load())!.cursor).toBe(0)
})
