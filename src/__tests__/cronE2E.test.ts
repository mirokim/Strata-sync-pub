/**
 * cronE2E.test.ts — cron job pipeline E2E tests
 *
 * Verifies the full edit-agent → vault-reload → vector-rebuild chain
 * + precondition errors, per-file timeout, needsRefinement skip, sync safeguards
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useVaultStore } from '@/stores/vaultStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useEditAgentStore } from '@/stores/editAgentStore'
import { useSyncStore } from '@/stores/syncStore'

// ── Mock: llmClient ──────────────────────────────────────────────────────────

let _mockStreamResponse = '```json\n{"skip": true, "reason": "test skip"}\n```'
let _mockStreamShouldThrow = false

vi.mock('@/services/llmClient', () => ({
  streamMessage: vi.fn(),
  streamMessageRaw: vi.fn(async (
    _model: string, _sys: string, _msgs: unknown[],
    onChunk: (c: string) => void,
  ) => {
    if (_mockStreamShouldThrow) throw new Error('Mock LLM error')
    onChunk(_mockStreamResponse)
  }),
  streamMessageWithTools: vi.fn(),
}))

// ── Mock: vaultAPI (path-based) ──────────────────────────────────────────────

const _fileContents = new Map<string, string>()

const mockSaveFile = vi.fn().mockImplementation(async (path: string) => {
  return { success: true, path }
})
const mockReadFile = vi.fn().mockImplementation(async (path: string) => {
  // Look up the file content map, null if missing (log files etc.)
  return _fileContents.get(path) ?? null
})
const mockLoadFiles = vi.fn().mockResolvedValue({ files: [], folders: [], imageRegistry: {} })

const mockVaultAPI = {
  loadFiles: mockLoadFiles,
  readFile: mockReadFile,
  saveFile: mockSaveFile,
  scanMetadata: vi.fn().mockResolvedValue([]),
  watchStart: vi.fn(),
  setActivePath: vi.fn(),
  createFolder: vi.fn().mockResolvedValue({ success: true }),
  deleteFile: vi.fn().mockResolvedValue({ success: true }),
  renameFile: vi.fn().mockResolvedValue({ success: true }),
  moveFile: vi.fn().mockResolvedValue({ success: true }),
}

// ── Mock: window globals ─────────────────────────────────────────────────────

Object.defineProperty(globalThis, 'window', {
  value: {
    vaultAPI: mockVaultAPI,
    cronAPI: undefined,
    backendAPI: undefined,
    confluenceAPI: undefined,
    jiraAPI: undefined,
    toolsAPI: undefined,
    configAPI: undefined,
    requestIdleCallback: (cb: () => void) => setTimeout(cb, 0),
  },
  writable: true,
})

// ── Mock: other modules ──────────────────────────────────────────────────────

vi.mock('@/lib/graphBuilder', () => ({
  buildGraph: vi.fn().mockReturnValue({ nodes: [], links: [] }),
}))
vi.mock('@/lib/graphAnalysis', () => ({
  tfidfIndex: { build: vi.fn(), restore: vi.fn(), setImplicitLinks: vi.fn() },
  clearMetricsCache: vi.fn(),
  extractCoOccurrenceSynonyms: vi.fn().mockReturnValue(new Map()),
}))
vi.mock('@/lib/graphRAG', () => ({
  buildAdjacencyMap: vi.fn().mockReturnValue(new Map()),
}))
vi.mock('@/lib/bm25WorkerClient', () => ({
  buildAndFindLinks: vi.fn().mockResolvedValue({ serialized: {}, implicitLinks: [] }),
  findLinksFromCache: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/tfidfCache', () => ({
  buildFingerprint: vi.fn().mockReturnValue('mock-fp'),
  loadTfIdfCache: vi.fn().mockResolvedValue(null),
  saveTfIdfCache: vi.fn().mockResolvedValue(undefined),
  invalidateTfIdfCache: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/docsCache', () => ({
  buildDocsFingerprint: vi.fn().mockReturnValue('mock-docs-fp'),
  loadDocsCache: vi.fn().mockResolvedValue(null),
  saveDocsCache: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/vectorEmbedIndex', () => ({
  vectorEmbedIndex: { buildIncremental: vi.fn().mockResolvedValue(undefined) },
}))
vi.mock('@/lib/synonyms', () => ({
  addDynamicSynonym: vi.fn(),
  clearDynamicSynonyms: vi.fn(),
}))
vi.mock('@/stores/toastStore', () => ({
  showToast: vi.fn(),
}))
vi.mock('@/services/syncRunner', () => ({
  runConfluenceSync: vi.fn().mockResolvedValue(undefined),
  runJiraSync: vi.fn().mockResolvedValue(undefined),
  runQualityCheck: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/personaVaultConfig', () => ({
  parsePersonaConfig: vi.fn().mockReturnValue(null),
}))

// ── Import after mocks ───────────────────────────────────────────────────────

const { runEditAgentCycle } = await import('@/services/editAgentRunner')
const { toSyncDatetime } = await import('@/lib/formatUtils')

// ── Helpers ──────────────────────────────────────────────────────────────────

function resetStores() {
  useVaultStore.setState({ vaultPath: '/mock/vault', activeVaultId: 'test-vault' })
  useSettingsStore.setState({
    editAgentConfig: {
      enabled: true,
      intervalMinutes: 30,
      modelId: 'claude-sonnet-4-6',
      refinementManual: '# Test manual\nRefinement rules',
      syncConfluence: false,
      syncJira: false,
    },
    apiKeys: { anthropic: 'sk-test-key', gemini: '' },
  } as any)
  useEditAgentStore.getState().setIsRunning(false)
  useSyncStore.setState({ lastSyncAt: null, lastJiraSyncAt: null })

  // Reset mocks
  _mockStreamResponse = '```json\n{"skip": true, "reason": "test skip"}\n```'
  _mockStreamShouldThrow = false
  _fileContents.clear()
  mockLoadFiles.mockResolvedValue({ files: [], folders: [], imageRegistry: {} })
  mockSaveFile.mockClear()
  mockReadFile.mockClear()
  ;(window as any).vaultAPI = mockVaultAPI
}

function makeMdFile(name: string, content: string) {
  const absPath = `/mock/vault/${name}`
  // register in the path-based mock
  _fileContents.set(absPath, content)
  return { relativePath: name, absolutePath: absPath, content, mtime: Date.now() }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Cron E2E — Edit Agent cycle', () => {
  beforeEach(() => resetStores())

  // ── Precondition checks ──

  it('aborts the cycle when there is no vault path', async () => {
    useVaultStore.setState({ vaultPath: null })
    const result = await runEditAgentCycle()
    expect(result).toBe(false)
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.detail?.includes('No vault path'))).toBe(true)
  })

  it('aborts the cycle when vaultAPI is missing', async () => {
    ;(window as any).vaultAPI = undefined
    const result = await runEditAgentCycle()
    expect(result).toBe(false)
    ;(window as any).vaultAPI = mockVaultAPI
  })

  // ── File processing flow ──

  it('completes normally with no MD files (0 edits)', async () => {
    mockLoadFiles.mockResolvedValueOnce({ files: [], folders: [], imageRegistry: {} })
    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'done')).toBe(true)
  })

  it('skips already-processed files (edit-agent stamp)', async () => {
    const today = new Date()
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const content = `<!-- edit-agent: ${todayStr} -->\n---\ntitle: test\n---\n# Test\n${'본문 '.repeat(50)}`

    const file = makeMdFile('already-done.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'file_skip' && l.file === 'already-done.md')).toBe(true)
  })

  it('does not edit the file when the LLM responds with skip', async () => {
    const content = '---\ntitle: test\ntags: []\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamResponse = '```json\n{"skip": true, "reason": "no improvement needed"}\n```'

    const file = makeMdFile('fine.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    // saveFile is also called for log persistence (appendLogToFile), so check it was not called with the target file path
    const saveCallPaths = mockSaveFile.mock.calls.map((c: unknown[]) => c[0])
    expect(saveCallPaths).not.toContain('/mock/vault/fine.md')
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'file_skip' && l.detail?.includes('no improvement needed'))).toBe(true)
  })

  it('saves the file when the LLM responds with an edit', async () => {
    const content = '---\ntitle: test\ntags: []\n---\n# Test\n' + 'A'.repeat(200)
    const edited = '---\ntitle: test\ntags: [game]\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamResponse = `\`\`\`json\n${JSON.stringify({ skip: false, reason: 'tag enrichment', content: edited })}\n\`\`\``

    const file = makeMdFile('needs-edit.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const saveCallPaths = mockSaveFile.mock.calls.map((c: unknown[]) => c[0])
    expect(saveCallPaths).toContain('/mock/vault/needs-edit.md')
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'file_edit' && l.file === 'needs-edit.md')).toBe(true)
  })

  it('skips the file and continues the cycle on LLM error', async () => {
    const content = '---\ntitle: test\ntags: []\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamShouldThrow = true

    const file = makeMdFile('error-file.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'error' && l.detail?.includes('LLM error'))).toBe(true)
  })

  it('ignores files beyond MAX_FILES_PER_CYCLE(10)', async () => {
    const content = '---\ntitle: test\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamResponse = '```json\n{"skip": true, "reason": "skip"}\n```'

    const files = Array.from({ length: 15 }, (_, i) => makeMdFile(`file${i}.md`, content))
    mockLoadFiles.mockResolvedValueOnce({ files, folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    const scanLog = logs.find(l => l.detail?.includes('Scanning'))
    expect(scanLog?.detail).toMatch(/\b10\b/)
  })

  it('filters out files with a _ prefix', async () => {
    const content = '---\ntitle: test\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamResponse = '```json\n{"skip": true, "reason": "skip"}\n```'

    const files = [
      makeMdFile('_index.md', content),
      makeMdFile('_template.md', content),
      makeMdFile('normal.md', content),
    ]
    mockLoadFiles.mockResolvedValueOnce({ files, folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    const scanLog = logs.find(l => l.detail?.includes('Scanning'))
    expect(scanLog?.detail).toMatch(/\b1\b/)
  })

  it('prevents concurrent runs (mutex)', async () => {
    // set isRunning directly to check mutex behaviour
    useEditAgentStore.getState().setIsRunning(true)
    // _cycleRunning is module-level and not directly accessible → verify via rapid sequential runs instead
    useEditAgentStore.getState().setIsRunning(false)

    // start the first cycle (slow LLM mock)
    const content = '---\ntitle: test\n---\n# Test\n' + 'A'.repeat(200)
    const { streamMessageRaw } = await import('@/services/llmClient')
    const origImpl = (streamMessageRaw as ReturnType<typeof vi.fn>).getMockImplementation()
    ;(streamMessageRaw as ReturnType<typeof vi.fn>).mockImplementationOnce(async (
      _m: string, _s: string, _msgs: unknown[], onChunk: (c: string) => void
    ) => {
      await new Promise(r => setTimeout(r, 50))
      onChunk('```json\n{"skip": true, "reason": "slow response"}\n```')
    })

    const file = makeMdFile('slow.md', content)
    mockLoadFiles.mockResolvedValue({ files: [file], folders: [], imageRegistry: {} })

    const p1 = runEditAgentCycle()
    // second attempt after a short delay
    await new Promise(r => setTimeout(r, 10))
    const p2 = runEditAgentCycle()

    const [r1, r2] = await Promise.all([p1, p2])
    expect([r1, r2]).toContain(false) // one is blocked by the mutex
    // restore
    if (origImpl) (streamMessageRaw as ReturnType<typeof vi.fn>).mockImplementation(origImpl)
  })

  it('inserts the edit-agent stamp after editing', async () => {
    const content = '---\ntitle: test\ntags: []\n---\n# Test\n' + 'A'.repeat(200)
    const edited = '---\ntitle: test\ntags: [game]\n---\n# Test\nEdited'
    _mockStreamResponse = `\`\`\`json\n${JSON.stringify({ skip: false, reason: 'tags', content: edited })}\n\`\`\``

    const file = makeMdFile('stamp-test.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    await runEditAgentCycle()
    const savedContent = mockSaveFile.mock.calls.find((c: unknown[]) => c[0] === '/mock/vault/stamp-test.md')?.[1] as string
    expect(savedContent).toMatch(/<!-- edit-agent: \d{4}-\d{2}-\d{2} -->/)
  })
})

describe('Cron E2E — Sync safeguards', () => {
  it('toSyncDatetime: returns empty string when lastSyncAt is missing and fallback is empty', () => {
    expect(toSyncDatetime(null, '')).toBe('')
  })

  it('toSyncDatetime: converts ISO timestamps correctly (UTC)', () => {
    const result = toSyncDatetime('2026-04-10T12:30:00.000Z', '')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(result).toBe('2026-04-10 12:30')
  })

  it('toSyncDatetime: ignores fallback when lastSyncAt is present', () => {
    const result = toSyncDatetime('2026-04-15T00:00:00.000Z', '2020-01-01')
    expect(result).toContain('2026-04-15')
  })

  it('7-day fallback: passes through correctly when an ISO string is given to toSyncDatetime', () => {
    // syncRunner generates the fallback as ISO → toSyncDatetime(null, isoString)
    // with lastSyncAt=null the fallback is returned as-is (ISO string) — toSyncDatetime does not convert it
    // in real use it is converted once lastSyncAt is set
    const fallback = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const result = toSyncDatetime(null, fallback)
    // fallback returned as-is — JQL accepts ISO too, so this works
    expect(result).toBe(fallback)
  })
})

describe('Cron E2E — needsRefinement integration', () => {
  beforeEach(() => resetStores())

  it('skips files under 100 chars without calling the LLM', async () => {
    const shortContent = '# Short\nToo short'
    const file = makeMdFile('short.md', shortContent)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    const { streamMessageRaw } = await import('@/services/llmClient')
    ;(streamMessageRaw as ReturnType<typeof vi.fn>).mockClear()

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    expect(streamMessageRaw).not.toHaveBeenCalled()
  })
})
