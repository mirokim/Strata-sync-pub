import { expect, it, vi } from 'vitest'
import { RemoteVault } from '@/web/remoteVault'
import { MemoryCacheBackend } from '@/web/remoteCache'

vi.mock('@/web/remoteCache', async importOriginal => {
  const original = await importOriginal<typeof import('@/web/remoteCache')>()
  const disks = new Map<string, InstanceType<typeof original.MemoryCacheBackend>>()
  return { ...original, defaultCacheBackend: (key: string) => {
    if (!disks.has(key)) disks.set(key, new original.MemoryCacheBackend())
    return disks.get(key)!
  } }
})

it('uses independent durable cursors for two accounts on the same server', async () => {
  const cursors: Record<string, number[]> = { alice: [], bob: [] }
  const make = (sub: string) => new RemoteVault({ url: 'https://switch.example', token: sub, author: sub, auth: 'oauth' }, {
    fetchImpl: async input => {
      const url = new URL(String(input))
      if (url.pathname === '/v1/me') return Response.json({ sub, service: false })
      if (url.pathname === '/v1/bundle') return new Response('', { status: 404 })
      const after = Number(url.searchParams.get('after'))
      cursors[sub].push(after)
      return Response.json({ head: 1, generation: 1, next: null, docs: sub === 'alice' && after === 0 ? [
        { path: '_personal/alice/secret.md', content: 'ALICE SECRET', etag: 'a', seq: 1, author: sub, size: 10, mtime: 1000, deleted: false },
      ] : [] })
    },
  })
  const alice = make('alice'); await alice.api.loadFiles(alice.vaultPath); await alice.cache.flush()
  const bob = make('bob'); expect((await bob.api.loadFiles(bob.vaultPath)).files).toEqual([]); await bob.cache.flush()
  const returning = make('alice')
  expect((await returning.api.loadFiles(returning.vaultPath)).files[0].content).toBe('ALICE SECRET')
  expect(cursors).toEqual({ alice: [0, 1], bob: [0] })
  await returning.cache.flush()
})

it('does not expose another identity private document from a stale backend', async () => {
  const backend = new MemoryCacheBackend()
  await backend.write({ cursor: 1, generation: 1, emptyFolders: [], removed: [], rows: [
    { path: '_personal/alice/secret.md', content: 'ALICE SECRET', etag: 'a', seq: 1, author: 'Alice', size: 10, mtime: 1000 },
  ] })
  const v = new RemoteVault({ url: 'https://identity.example', token: 'bob', author: 'Bob', auth: 'oauth' }, { backend,
    fetchImpl: async input => Response.json(String(input).includes('/v1/me') ? { sub: 'bob', service: false } : { docs: [], head: 1, generation: 1, next: null }),
  })
  expect((await v.api.loadFiles(v.vaultPath)).files).toEqual([])
  await v.cache.flush()
  expect((await backend.load())!.rows).toEqual([])
})

it('fails closed on identity lookup failure and retries on a later load', async () => {
  let failed = true
  const v = new RemoteVault({ url: 'https://identity.example', token: 'bob', author: 'Bob', auth: 'oauth' }, {
    backend: new MemoryCacheBackend(), fetchImpl: async input => {
      if (String(input).includes('/v1/me')) return failed ? new Response('', { status: 503 }) : Response.json({ sub: 'bob', service: false })
      return Response.json({ docs: [], head: 0, generation: 1, next: null })
    },
  })
  await expect(v.api.loadFiles(v.vaultPath)).rejects.toThrow()
  expect(v.personalEnabled).toBe(false)
  failed = false
  await v.api.loadFiles(v.vaultPath)
  expect(v.personalEnabled).toBe(true)
  await v.cache.flush()
})
