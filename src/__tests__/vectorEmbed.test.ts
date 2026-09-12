import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { LoadedDocument } from '@/types'
import {
  loadVectorEmbedCacheIncremental,
  saveVectorEmbedCacheIncremental,
  invalidateVectorEmbedCache,
} from '@/lib/vectorEmbedCache'
import { rrfScore, vectorEmbedIndex } from '@/lib/vectorEmbedIndex'

// ── vaultAPI mock ─────────────────────────────────────────────────────────────

const mockVaultAPI = {
  readFile: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
}
Object.defineProperty(window, 'vaultAPI', { value: mockVaultAPI, writable: true })

// ── helpers ───────────────────────────────────────────────────────────────────

const VAULT = '/test/vault'

function makeV5Cache(entries: Record<string, { embedding: number[]; docId: string; mtime: number }>) {
  return JSON.stringify({ version: 5, entries })
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
    it('캐시 없을 때 → 전체 staleDocIds 반환', async () => {
      mockVaultAPI.readFile.mockResolvedValue(null)
      const docMtimes = new Map([['doc1', 100], ['doc2', 200]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.size).toBe(0)
      expect(staleDocIds).toEqual(new Set(['doc1', 'doc2']))
    })

    it('v5 캐시에서 mtime 일치하는 엔트리만 복원', async () => {
      const cacheData = makeV5Cache({
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

    it('mtime 불일치 → staleDocIds에 포함', async () => {
      const cacheData = makeV5Cache({
        'doc1#sec0': { embedding: [1, 2, 3], docId: 'doc1', mtime: 100 },
      })
      mockVaultAPI.readFile.mockResolvedValue(cacheData)
      // doc1 mtime이 변경됨 (100 → 999)
      const docMtimes = new Map([['doc1', 999]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.size).toBe(0)
      expect(staleDocIds.has('doc1')).toBe(true)
    })

    it('삭제된 문서(docMtimes에 없는) → cached에 미포함', async () => {
      const cacheData = makeV5Cache({
        'deleted#sec0': { embedding: [1, 2, 3], docId: 'deleted', mtime: 100 },
        'alive#sec0': { embedding: [4, 5, 6], docId: 'alive', mtime: 200 },
      })
      mockVaultAPI.readFile.mockResolvedValue(cacheData)
      // 'deleted' 문서는 docMtimes에 없음
      const docMtimes = new Map([['alive', 200]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.has('deleted#sec0')).toBe(false)
      expect(cached.has('alive#sec0')).toBe(true)
      expect(staleDocIds.size).toBe(0)
    })

    it('version이 5가 아닌 캐시 → 전량 stale', async () => {
      const oldCache = JSON.stringify({ version: 4, entries: { 'doc1#sec0': { embedding: [1], docId: 'doc1', mtime: 100 } } })
      mockVaultAPI.readFile.mockResolvedValue(oldCache)
      const docMtimes = new Map([['doc1', 100]])

      const { cached, staleDocIds } = await loadVectorEmbedCacheIncremental(VAULT, docMtimes)

      expect(cached.size).toBe(0)
      expect(staleDocIds).toEqual(new Set(['doc1']))
    })
  })

  describe('saveVectorEmbedCacheIncremental', () => {
    it('정상 저장 후 JSON 구조 검증', async () => {
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
      expect(path).toContain('.vector_cache_v5.json')

      const parsed = JSON.parse(json)
      expect(parsed.version).toBe(5)
      expect(parsed.entries['doc1#sec0'].embedding).toEqual([1, 2, 3])
      expect(parsed.entries['doc1#sec0'].docId).toBe('doc1')
      expect(parsed.entries['doc1#sec0'].mtime).toBe(100)
      expect(parsed.entries['doc1#sec1']).toBeDefined()
    })

    it('sectionDocMap에 없는 sectionId → 저장 안 됨', async () => {
      mockVaultAPI.saveFile.mockResolvedValue(undefined)

      const embeddings = new Map<string, Float32Array>([
        ['doc1#sec0', new Float32Array([1, 2])],
        ['orphan#sec0', new Float32Array([3, 4])],
      ])
      const sectionDocMap = new Map([['doc1#sec0', 'doc1']])
      // orphan#sec0은 sectionDocMap에 없음
      const docMtimes = new Map([['doc1', 100]])

      await saveVectorEmbedCacheIncremental(VAULT, embeddings, sectionDocMap, docMtimes)

      const parsed = JSON.parse(mockVaultAPI.saveFile.mock.calls[0][1])
      expect(parsed.entries['doc1#sec0']).toBeDefined()
      expect(parsed.entries['orphan#sec0']).toBeUndefined()
    })
  })

  describe('invalidateVectorEmbedCache', () => {
    it('v5, v4 두 파일 모두 삭제 호출', async () => {
      mockVaultAPI.deleteFile.mockResolvedValue(undefined)

      await invalidateVectorEmbedCache(VAULT)

      expect(mockVaultAPI.deleteFile).toHaveBeenCalledTimes(2)
      const paths = mockVaultAPI.deleteFile.mock.calls.map((c: unknown[]) => c[0])
      expect(paths.some((p: string) => p.includes('v5'))).toBe(true)
      expect(paths.some((p: string) => p.includes('v4'))).toBe(true)
    })
  })
})

// ── vectorEmbedIndex.ts — rrfScore ──────────────────────────────────────────

describe('rrfScore', () => {
  it('기본 k=60에서 단일 랭크 → 1/(60+rank)', () => {
    expect(rrfScore([1])).toBeCloseTo(1 / 61, 10)
    expect(rrfScore([5])).toBeCloseTo(1 / 65, 10)
  })

  it('두 랭크 합산 검증', () => {
    const result = rrfScore([1, 3])
    const expected = 1 / 61 + 1 / 63
    expect(result).toBeCloseTo(expected, 10)
  })

  it('커스텀 k 값', () => {
    expect(rrfScore([1], 0)).toBeCloseTo(1, 10)
    expect(rrfScore([2], 10)).toBeCloseTo(1 / 12, 10)
  })
})

// ── vectorEmbedIndex.buildIncremental 통합 테스트 ────────────────────────────

describe('vectorEmbedIndex.buildIncremental', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vectorEmbedIndex.reset()
  })

  it('캐시 100% 히트 시 → API 호출 0회, built=true', async () => {
    // doc1은 섹션 4개 이상 → 섹션별 임베딩
    const doc = mockDoc('doc1', 100, 4)
    const cacheEntries: Record<string, { embedding: number[]; docId: string; mtime: number }> = {}
    for (const sec of doc.sections) {
      cacheEntries[sec.id] = {
        embedding: Array(8).fill(0.5),
        docId: 'doc1',
        mtime: 100,
      }
    }
    mockVaultAPI.readFile.mockResolvedValue(makeV5Cache(cacheEntries))

    // fetch가 호출되지 않아야 함
    const fetchSpy = vi.fn()
    global.fetch = fetchSpy

    await vectorEmbedIndex.buildIncremental([doc], 'fake-key', VAULT)

    expect(vectorEmbedIndex.isBuilt).toBe(true)
    expect(vectorEmbedIndex.size).toBe(4)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('캐시 부분 히트 시 → stale 문서만 API 호출', async () => {
    const doc1 = mockDoc('doc1', 100, 4) // 캐시 있음
    const doc2 = mockDoc('doc2', 200, 4) // 캐시 없음 (stale)

    // doc1만 캐시에 있음
    const cacheEntries: Record<string, { embedding: number[]; docId: string; mtime: number }> = {}
    for (const sec of doc1.sections) {
      cacheEntries[sec.id] = {
        embedding: Array(8).fill(0.5),
        docId: 'doc1',
        mtime: 100,
      }
    }
    mockVaultAPI.readFile.mockResolvedValue(makeV5Cache(cacheEntries))
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
    // doc2의 4개 섹션만 API 호출
    expect(fetchCalls.length).toBe(4)
    // API로 전달된 텍스트에 doc2 내용만 포함되어야 함
    for (const text of fetchCalls) {
      expect(text).toContain('doc2')
    }
  })

  it('API 실패 시 → lastError 설정', async () => {
    const doc = mockDoc('doc1', 100, 4)
    mockVaultAPI.readFile.mockResolvedValue(null) // 캐시 없음

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: { message: 'Forbidden' } }),
    })

    await vectorEmbedIndex.buildIncremental([doc], 'bad-key', VAULT)

    expect(vectorEmbedIndex.lastError).toBeTruthy()
    expect(vectorEmbedIndex.lastError).toContain('403')
  })

  it('reset() 후 상태 초기화', () => {
    vectorEmbedIndex.reset()

    expect(vectorEmbedIndex.isBuilt).toBe(false)
    expect(vectorEmbedIndex.isBuilding).toBe(false)
    expect(vectorEmbedIndex.size).toBe(0)
    expect(vectorEmbedIndex.progress).toBe(0)
    expect(vectorEmbedIndex.lastError).toBeNull()
  })
})
