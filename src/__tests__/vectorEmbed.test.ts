import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { LoadedDocument } from '@/types'
import {
  loadVectorEmbedCacheIncremental,
  saveVectorEmbedCacheIncremental,
  invalidateVectorEmbedCache,
} from '@/lib/vectorEmbedCache'
import { rrfScore, vectorEmbedIndex } from '@/lib/vectorEmbedIndex'
import { CHUNKER_VERSION } from '@/lib/markdownParser'

// ── vaultAPI mock ─────────────────────────────────────────────────────────────

const mockVaultAPI = {
  readFile: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
}
Object.defineProperty(window, 'vaultAPI', { value: mockVaultAPI, writable: true })

// ── helpers ───────────────────────────────────────────────────────────────────

const VAULT = '/test/vault'

function makeV6Cache(entries: Record<string, { embedding: number[]; docId: string; mtime: number }>) {
  // provider must match the active one ('gemini' when no local server was probed) or the loader forces a full rebuild
  return JSON.stringify({ version: 6, chunkerVersion: CHUNKER_VERSION, provider: 'gemini', dim: 8, entries })
}

const mockDoc = (id: string, mtime: number, sectionCount: number): LoadedDocument => ({
  id,
  filename: `${id}.md`,
  folderPath: '',
  absolutePath: `/vault/${id}.md`,
  mtime,
  type: 'meeting',
  tags: ['test'],
  speaker: '',
  date: '2026-01-01',
  links: [],
  rawContent: 'test content',
  sections: Array.from({ length: sectionCount }, (_, i) => ({
    id: `${id}#sec${i}`,
    heading: `Section ${i}`,
    body: `Body ${i}`,
    wikiLinks: [],
  })),
  images: [],
})

// ── vectorEmbedCache.ts ─────────────────────────────────────────────────────

describe('vectorEmbedCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('loadVectorEmbedCacheIncremental', () => {
    it('no cache → returns all staleDocIds', async () => {
      mockVaultAPI.readFile.mockResolvedValue(null)
      const docMtimes = new Map([['doc1', 100], ['doc2', 200]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.size).toBe(0)
      expect(staleDocIds).toEqual(new Set(['doc1', 'doc2']))
    })

    it('restores only entries with matching mtime from v6 cache', async () => {
      const cacheData = makeV6Cache({
        'doc1#sec0': { embedding: [1, 2, 3], docId: 'doc1', mtime: 100 },
        'doc2#sec0': { embedding: [4, 5, 6], docId: 'doc2', mtime: 200 },
      })
      mockVaultAPI.readFile.mockResolvedValue(cacheData)
      const docMtimes = new Map([['doc1', 100], ['doc2', 200]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.size).toBe(2)
      expect(cached.get('doc1#sec0')).toBeInstanceOf(Float32Array)
      expect(Array.from(cached.get('doc1#sec0')!)).toEqual([1, 2, 3])
      expect(staleDocIds.size).toBe(0)
    })

    it('mtime mismatch → included in staleDocIds', async () => {
      const cacheData = makeV6Cache({
        'doc1#sec0': { embedding: [1, 2, 3], docId: 'doc1', mtime: 100 },
      })
      mockVaultAPI.readFile.mockResolvedValue(cacheData)
      // doc1 mtime changed (100 → 999)
      const docMtimes = new Map([['doc1', 999]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.size).toBe(0)
      expect(staleDocIds.has('doc1')).toBe(true)
    })

    it('deleted document (not in docMtimes) → not included in cached', async () => {
      const cacheData = makeV6Cache({
        'deleted#sec0': { embedding: [1, 2, 3], docId: 'deleted', mtime: 100 },
        'alive#sec0': { embedding: [4, 5, 6], docId: 'alive', mtime: 200 },
      })
      mockVaultAPI.readFile.mockResolvedValue(cacheData)
      // the 'deleted' document is not in docMtimes
      const docMtimes = new Map([['alive', 200]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.has('deleted#sec0')).toBe(false)
      expect(cached.has('alive#sec0')).toBe(true)
      expect(staleDocIds.size).toBe(0)
    })

    it('cache with version other than 5 → everything stale', async () => {
      const oldCache = JSON.stringify({ version: 4, entries: { 'doc1#sec0': { embedding: [1], docId: 'doc1', mtime: 100 } } })
      mockVaultAPI.readFile.mockResolvedValue(oldCache)
      const docMtimes = new Map([['doc1', 100]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.size).toBe(0)
      expect(staleDocIds).toEqual(new Set(['doc1']))
    })
  })

  describe('saveVectorEmbedCacheIncremental', () => {
    it('validates JSON structure after a normal save', async () => {
      mockVaultAPI.saveFile.mockResolvedValue(undefined)

      const embeddings = new Map<string, Float32Array>([
        ['doc1#sec0', new Float32Array([1, 2, 3])],
        ['doc1#sec1', new Float32Array([4, 5, 6])],
      ])
      const sectionDocMap = new Map([['doc1#sec0', 'doc1'], ['doc1#sec1', 'doc1']])
      const docMtimes = new Map([['doc1', 100]])

      await saveVectorEmbedCacheIncremental(VAULT, embeddings, sectionDocMap, docMtimes)

      expect(mockVaultAPI.saveFile).toHaveBeenCalledOnce()
      const [path, json] = mockVaultAPI.saveFile.mock.calls[0]
      expect(path).toContain('.vector_cache_v6.json')

      const parsed = JSON.parse(json)
      expect(parsed.version).toBe(6)
      expect(parsed.chunkerVersion).toBe(CHUNKER_VERSION)
      expect(parsed.entries['doc1#sec0'].embedding).toEqual([1, 2, 3])
      expect(parsed.entries['doc1#sec0'].docId).toBe('doc1')
      expect(parsed.entries['doc1#sec0'].mtime).toBe(100)
      expect(parsed.entries['doc1#sec1']).toBeDefined()
    })

    it('sectionId missing from sectionDocMap → not saved', async () => {
      mockVaultAPI.saveFile.mockResolvedValue(undefined)

      const embeddings = new Map<string, Float32Array>([
        ['doc1#sec0', new Float32Array([1, 2])],
        ['orphan#sec0', new Float32Array([3, 4])],
      ])
      const sectionDocMap = new Map([['doc1#sec0', 'doc1']])
      // orphan#sec0 is not in sectionDocMap
      const docMtimes = new Map([['doc1', 100]])

      await saveVectorEmbedCacheIncremental(VAULT, embeddings, sectionDocMap, docMtimes)

      const parsed = JSON.parse(mockVaultAPI.saveFile.mock.calls[0][1])
      expect(parsed.entries['doc1#sec0']).toBeDefined()
      expect(parsed.entries['orphan#sec0']).toBeUndefined()
    })
  })

  describe('invalidateVectorEmbedCache', () => {
    it('calls delete for both the v6 and legacy v5 files', async () => {
      mockVaultAPI.deleteFile.mockResolvedValue(undefined)

      await invalidateVectorEmbedCache(VAULT)

      expect(mockVaultAPI.deleteFile).toHaveBeenCalledTimes(2)
      const paths = mockVaultAPI.deleteFile.mock.calls.map((c: unknown[]) => c[0])
      expect(paths.some((p: string) => p.includes('v6'))).toBe(true)
      expect(paths.some((p: string) => p.includes('v5'))).toBe(true)
    })
  })
})

// ── vectorEmbedIndex.ts — rrfScore ──────────────────────────────────────────

describe('rrfScore', () => {
  it('single rank with default k=60 → 1/(60+rank)', () => {
    expect(rrfScore([1])).toBeCloseTo(1 / 61, 10)
    expect(rrfScore([5])).toBeCloseTo(1 / 65, 10)
  })

  it('sums two ranks', () => {
    const result = rrfScore([1, 3])
    const expected = 1 / 61 + 1 / 63
    expect(result).toBeCloseTo(expected, 10)
  })

  it('custom k value', () => {
    expect(rrfScore([1], 0)).toBeCloseTo(1, 10)
    expect(rrfScore([2], 10)).toBeCloseTo(1 / 12, 10)
  })
})

// ── vectorEmbedIndex.buildIncremental integration tests ─────────────────────

describe('vectorEmbedIndex.buildIncremental', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vectorEmbedIndex.reset()
  })

  it('100% cache hit → 0 API calls, built=true', async () => {
    // doc1 has 4+ sections → per-section embedding
    const doc = mockDoc('doc1', 100, 4)
    const cacheEntries: Record<string, { embedding: number[]; docId: string; mtime: number }> = {}
    for (const sec of doc.sections) {
      cacheEntries[sec.id] = {
        embedding: Array(8).fill(0.5),
        docId: 'doc1',
        mtime: 100,
      }
    }
    mockVaultAPI.readFile.mockResolvedValue(makeV6Cache(cacheEntries))

    // fetch must not be called
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy

    await vectorEmbedIndex.buildIncremental([doc], 'fake-key', VAULT)

    expect(vectorEmbedIndex.isBuilt).toBe(true)
    expect(vectorEmbedIndex.size).toBe(4)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('partial cache hit → API called only for stale documents', async () => {
    const doc1 = mockDoc('doc1', 100, 4) // cached
    const doc2 = mockDoc('doc2', 200, 4) // not cached (stale)

    // only doc1 is in the cache
    const cacheEntries: Record<string, { embedding: number[]; docId: string; mtime: number }> = {}
    for (const sec of doc1.sections) {
      cacheEntries[sec.id] = {
        embedding: Array(8).fill(0.5),
        docId: 'doc1',
        mtime: 100,
      }
    }
    mockVaultAPI.readFile.mockResolvedValue(makeV6Cache(cacheEntries))
    mockVaultAPI.saveFile.mockResolvedValue(undefined)

    const fetchCalls: string[] = []
    global.fetch = vi.fn().mockImplementation((_url: string, opts: RequestInit) => {
      const body = JSON.parse(opts.body as string)
      fetchCalls.push(body.content.parts[0].text)
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ embedding: { values: Array(8).fill(0.1) } }),
      })
    })

    await vectorEmbedIndex.buildIncremental([doc1, doc2], 'fake-key', VAULT)

    expect(vectorEmbedIndex.isBuilt).toBe(true)
    // API called only for doc2's 4 sections
    expect(fetchCalls.length).toBe(4)
    // text sent to the API must contain only doc2 content
    for (const text of fetchCalls) {
      expect(text).toContain('doc2')
    }
  })

  it('API failure → sets lastError', async () => {
    const doc = mockDoc('doc1', 100, 4)
    mockVaultAPI.readFile.mockResolvedValue(null) // no cache

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { message: 'Forbidden' } }),
    })

    await vectorEmbedIndex.buildIncremental([doc], 'bad-key', VAULT)

    expect(vectorEmbedIndex.lastError).toBeTruthy()
    expect(vectorEmbedIndex.lastError).toContain('403')
  })

  it('resets state after reset()', () => {
    vectorEmbedIndex.reset()

    expect(vectorEmbedIndex.isBuilt).toBe(false)
    expect(vectorEmbedIndex.isBuilding).toBe(false)
    expect(vectorEmbedIndex.size).toBe(0)
    expect(vectorEmbedIndex.progress).toBe(0)
    expect(vectorEmbedIndex.lastError).toBeNull()
  })
})
