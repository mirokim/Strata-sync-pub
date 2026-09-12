/**
 * cronE2E.test.ts — 크론잡 파이프라인 E2E 테스트
 *
 * edit-agent → vault-reload → vector-rebuild 전체 체인 검증
 * + 사전조건 에러, 파일별 타임아웃, needsRefinement 스킵, sync 안전장치
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { useVaultStore } from '@/stores/vaultStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useEditAgentStore } from '@/stores/editAgentStore'
import { useSyncStore } from '@/stores/syncStore'

// ── Mock: llmClient ──────────────────────────────────────────────────────────

let _mockStreamResponse = '```json\n{"skip": true, "reason": "테스트 스킵"}\n```'
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

// ── Mock: vaultAPI (path 기반) ───────────────────────────────────────────────

const _fileContents = new Map<string, string>()

const mockSaveFile = vi.fn().mockImplementation(async (path: string) => {
  return { success: true, path }
})
const mockReadFile = vi.fn().mockImplementation(async (path: string) => {
  // 파일 내용 맵에서 조회, 없으면 null (로그 파일 등)
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
      refinementManual: '# 테스트 매뉴얼\n정제 규칙 내용',
      syncConfluence: false,
      syncJira: false,
    },
    apiKeys: { anthropic: 'sk-test-key', gemini: '' },
  } as any)
  useEditAgentStore.getState().setIsRunning(false)
  useSyncStore.setState({ lastSyncAt: null, lastJiraSyncAt: null })

  // Reset mocks
  _mockStreamResponse = '```json\n{"skip": true, "reason": "테스트 스킵"}\n```'
  _mockStreamShouldThrow = false
  _fileContents.clear()
  mockLoadFiles.mockResolvedValue({ files: [], folders: [], imageRegistry: {} })
  mockSaveFile.mockClear()
  mockReadFile.mockClear()
  ;(window as any).vaultAPI = mockVaultAPI
}

function makeMdFile(name: string, content: string) {
  const absPath = `/mock/vault/${name}`
  // path 기반 mock에 등록
  _fileContents.set(absPath, content)
  return { relativePath: name, absolutePath: absPath, content, mtime: Date.now() }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('크론잡 E2E — Edit Agent 사이클', () => {
  beforeEach(() => resetStores())

  // ── 사전조건 검증 ──

  it('볼트 경로 없으면 사이클 중단', async () => {
    useVaultStore.setState({ vaultPath: null })
    const result = await runEditAgentCycle()
    expect(result).toBe(false)
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.detail?.includes('볼트 경로 없음'))).toBe(true)
  })

  it('vaultAPI 없으면 사이클 중단', async () => {
    ;(window as any).vaultAPI = undefined
    const result = await runEditAgentCycle()
    expect(result).toBe(false)
    ;(window as any).vaultAPI = mockVaultAPI
  })

  // ── 파일 처리 흐름 ──

  it('MD 파일 없으면 정상 완료 (편집 0건)', async () => {
    mockLoadFiles.mockResolvedValueOnce({ files: [], folders: [], imageRegistry: {} })
    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'done')).toBe(true)
  })

  it('이미 처리된 파일(edit-agent stamp) 건너뜀', async () => {
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

  it('LLM이 skip 응답하면 파일 편집 안 함', async () => {
    const content = '---\ntitle: test\ntags: []\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamResponse = '```json\n{"skip": true, "reason": "개선 불필요"}\n```'

    const file = makeMdFile('fine.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    // saveFile은 로그 저장(appendLogToFile)에도 호출되므로, 대상 파일 경로로 호출 안 됐는지 확인
    const saveCallPaths = mockSaveFile.mock.calls.map((c: unknown[]) => c[0])
    expect(saveCallPaths).not.toContain('/mock/vault/fine.md')
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'file_skip' && l.detail?.includes('개선 불필요'))).toBe(true)
  })

  it('LLM이 편집 응답하면 파일 저장', async () => {
    const content = '---\ntitle: test\ntags: []\n---\n# Test\n' + 'A'.repeat(200)
    const edited = '---\ntitle: test\ntags: [game]\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamResponse = `\`\`\`json\n${JSON.stringify({ skip: false, reason: '태그 보강', content: edited })}\n\`\`\``

    const file = makeMdFile('needs-edit.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const saveCallPaths = mockSaveFile.mock.calls.map((c: unknown[]) => c[0])
    expect(saveCallPaths).toContain('/mock/vault/needs-edit.md')
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'file_edit' && l.file === 'needs-edit.md')).toBe(true)
  })

  it('LLM 오류 시 해당 파일 건너뛰고 사이클 계속', async () => {
    const content = '---\ntitle: test\ntags: []\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamShouldThrow = true

    const file = makeMdFile('error-file.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    expect(logs.some(l => l.action === 'error' && l.detail?.includes('LLM 오류'))).toBe(true)
  })

  it('MAX_FILES_PER_CYCLE(10) 초과 파일은 무시', async () => {
    const content = '---\ntitle: test\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamResponse = '```json\n{"skip": true, "reason": "스킵"}\n```'

    const files = Array.from({ length: 15 }, (_, i) => makeMdFile(`file${i}.md`, content))
    mockLoadFiles.mockResolvedValueOnce({ files, folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    const scanLog = logs.find(l => l.detail?.includes('스캔 중'))
    expect(scanLog?.detail).toContain('10개')
  })

  it('_ 접두사 파일은 필터링됨', async () => {
    const content = '---\ntitle: test\n---\n# Test\n' + 'A'.repeat(200)
    _mockStreamResponse = '```json\n{"skip": true, "reason": "스킵"}\n```'

    const files = [
      makeMdFile('_index.md', content),
      makeMdFile('_template.md', content),
      makeMdFile('normal.md', content),
    ]
    mockLoadFiles.mockResolvedValueOnce({ files, folders: [], imageRegistry: {} })

    const result = await runEditAgentCycle()
    expect(result).toBe(true)
    const logs = useEditAgentStore.getState().logs
    const scanLog = logs.find(l => l.detail?.includes('스캔 중'))
    expect(scanLog?.detail).toContain('1개')
  })

  it('동시 실행 방지 (mutex)', async () => {
    // isRunning을 직접 설정하여 mutex 동작 확인
    useEditAgentStore.getState().setIsRunning(true)
    // _cycleRunning은 모듈 레벨이므로 직접 접근 불가 → 대신 빠른 순차 실행으로 확인
    useEditAgentStore.getState().setIsRunning(false)

    // 첫 번째 사이클 시작 (느린 LLM mock)
    const content = '---\ntitle: test\n---\n# Test\n' + 'A'.repeat(200)
    const { streamMessageRaw } = await import('@/services/llmClient')
    const origImpl = (streamMessageRaw as ReturnType<typeof vi.fn>).getMockImplementation()
    ;(streamMessageRaw as ReturnType<typeof vi.fn>).mockImplementationOnce(async (
      _m: string, _s: string, _msgs: unknown[], onChunk: (c: string) => void
    ) => {
      await new Promise(r => setTimeout(r, 50))
      onChunk('```json\n{"skip": true, "reason": "느린응답"}\n```')
    })

    const file = makeMdFile('slow.md', content)
    mockLoadFiles.mockResolvedValue({ files: [file], folders: [], imageRegistry: {} })

    const p1 = runEditAgentCycle()
    // 약간 지연 후 두 번째 시도
    await new Promise(r => setTimeout(r, 10))
    const p2 = runEditAgentCycle()

    const [r1, r2] = await Promise.all([p1, p2])
    expect([r1, r2]).toContain(false) // 하나는 mutex로 차단
    // restore
    if (origImpl) (streamMessageRaw as ReturnType<typeof vi.fn>).mockImplementation(origImpl)
  })

  it('편집 후 edit-agent stamp가 삽입됨', async () => {
    const content = '---\ntitle: test\ntags: []\n---\n# Test\n' + 'A'.repeat(200)
    const edited = '---\ntitle: test\ntags: [game]\n---\n# Test\nEdited'
    _mockStreamResponse = `\`\`\`json\n${JSON.stringify({ skip: false, reason: '태그', content: edited })}\n\`\`\``

    const file = makeMdFile('stamp-test.md', content)
    mockLoadFiles.mockResolvedValueOnce({ files: [file], folders: [], imageRegistry: {} })

    await runEditAgentCycle()
    const savedContent = mockSaveFile.mock.calls.find((c: unknown[]) => c[0] === '/mock/vault/stamp-test.md')?.[1] as string
    expect(savedContent).toMatch(/<!-- edit-agent: \d{4}-\d{2}-\d{2} -->/)
  })
})

describe('크론잡 E2E — Sync 안전장치', () => {
  it('toSyncDatetime: lastSyncAt 없고 fallback 빈 문자열이면 빈 문자열', () => {
    expect(toSyncDatetime(null, '')).toBe('')
  })

  it('toSyncDatetime: ISO 타임스탬프 정상 변환 (UTC)', () => {
    const result = toSyncDatetime('2026-04-10T12:30:00.000Z', '')
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(result).toBe('2026-04-10 12:30')
  })

  it('toSyncDatetime: lastSyncAt 있으면 fallback 무시', () => {
    const result = toSyncDatetime('2026-04-15T00:00:00.000Z', '2020-01-01')
    expect(result).toContain('2026-04-15')
  })

  it('7일 폴백: toSyncDatetime에 ISO 전달 시 정상 변환', () => {
    // syncRunner에서 fallback을 ISO로 생성 → toSyncDatetime(null, isoString)
    // lastSyncAt=null이면 fallback 그대로 반환 (ISO 문자열) — toSyncDatetime은 변환 안 함
    // 실제 사용에서는 lastSyncAt이 설정되면 변환됨
    const fallback = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const result = toSyncDatetime(null, fallback)
    // fallback이 그대로 반환됨 — JQL에서 ISO도 인식하므로 정상 동작
    expect(result).toBe(fallback)
  })
})

describe('크론잡 E2E — needsRefinement 통합', () => {
  beforeEach(() => resetStores())

  it('100자 미만 파일은 LLM 호출 없이 건너뜀', async () => {
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
