import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { StateStorage } from 'zustand/middleware'

// ── 헬퍼: 모듈을 매번 새로 임포트하여 싱글턴 상태(pendingWrites 등) 초기화 ─────
async function importFresh(): Promise<StateStorage> {
  vi.resetModules()
  const mod = await import('@/lib/electronStorage')
  return mod.electronStorage
}

// ── settingsAPI 모킹 헬퍼 ─────────────────────────────────────────────────────
function installSettingsAPI(overrides?: Partial<NonNullable<Window['settingsAPI']>>) {
  window.settingsAPI = {
    read: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  }
}

function removeSettingsAPI() {
  delete (window as Record<string, unknown>).settingsAPI
}

// ─────────────────────────────────────────────────────────────────────────────
// getItem
// ─────────────────────────────────────────────────────────────────────────────

describe('electronStorage — getItem', () => {
  afterEach(() => {
    removeSettingsAPI()
    vi.restoreAllMocks()
  })

  it('비-Electron 환경: localStorage 값을 반환한다', async () => {
    removeSettingsAPI()
    localStorage.setItem('rembrandt-settings', '{"theme":"dark"}')
    const storage = await importFresh()

    const result = await storage.getItem('rembrandt-settings')
    expect(result).toBe('{"theme":"dark"}')
  })

  it('비-Electron 환경: 키가 없으면 null을 반환한다', async () => {
    removeSettingsAPI()
    const storage = await importFresh()

    const result = await storage.getItem('rembrandt-settings')
    expect(result).toBeNull()
  })

  it('Electron 환경: settingsAPI.read 결과를 JSON 문자열로 반환한다', async () => {
    installSettingsAPI({
      read: vi.fn().mockResolvedValue({ theme: 'dark', fontSize: 14 }),
    })
    const storage = await importFresh()

    const result = await storage.getItem('rembrandt-settings')
    expect(result).toBe(JSON.stringify({ theme: 'dark', fontSize: 14 }))
    expect(window.settingsAPI!.read).toHaveBeenCalledWith('settings.json')
  })

  it('Electron 환경: KEY_TO_FILE에 없는 키는 localStorage로 폴백한다', async () => {
    installSettingsAPI()
    localStorage.setItem('unknown-key', '{"x":1}')
    const storage = await importFresh()

    const result = await storage.getItem('unknown-key')
    expect(result).toBe('{"x":1}')
    expect(window.settingsAPI!.read).not.toHaveBeenCalled()
  })

  it('Electron 환경, IPC 실패: localStorage로 폴백한다', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installSettingsAPI({
      read: vi.fn().mockRejectedValue(new Error('IPC timeout')),
    })
    localStorage.setItem('rembrandt-settings', '{"fallback":true}')
    const storage = await importFresh()

    const result = await storage.getItem('rembrandt-settings')
    expect(result).toBe('{"fallback":true}')
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('Electron 환경, 마이그레이션: 파일 미존재 시 localStorage → 파일로 복사 후 반환한다', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({
      read: vi.fn().mockResolvedValue(null),
      write: writeMock,
    })
    localStorage.setItem('rembrandt-settings', '{"migrated":true}')
    const storage = await importFresh()

    const result = await storage.getItem('rembrandt-settings')

    expect(result).toBe('{"migrated":true}')
    expect(writeMock).toHaveBeenCalledWith('settings.json', { migrated: true })
  })

  it('Electron 환경, 마이그레이션: 파일도 localStorage도 없으면 null을 반환한다', async () => {
    installSettingsAPI({
      read: vi.fn().mockResolvedValue(null),
    })
    const storage = await importFresh()

    const result = await storage.getItem('rembrandt-settings')
    expect(result).toBeNull()
  })

  it('Electron 환경, 마이그레이션: write 실패 시 경고 후 localStorage 값을 반환한다', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installSettingsAPI({
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockRejectedValue(new Error('disk full')),
    })
    localStorage.setItem('rembrandt-vault', '{"docs":[]}')
    const storage = await importFresh()

    const result = await storage.getItem('rembrandt-vault')

    expect(result).toBe('{"docs":[]}')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// setItem
// ─────────────────────────────────────────────────────────────────────────────

describe('electronStorage — setItem', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    removeSettingsAPI()
    vi.restoreAllMocks()
  })

  it('비-Electron 환경: localStorage에만 기록한다', async () => {
    removeSettingsAPI()
    const storage = await importFresh()

    storage.setItem('rembrandt-settings', '{"a":1}')
    expect(localStorage.getItem('rembrandt-settings')).toBe('{"a":1}')
  })

  it('Electron 환경: localStorage에 즉시 기록하고 500ms 후 IPC write를 실행한다', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('rembrandt-settings', '{"b":2}')

    // localStorage에 즉시 기록됨
    expect(localStorage.getItem('rembrandt-settings')).toBe('{"b":2}')
    // IPC는 아직 호출되지 않음
    expect(writeMock).not.toHaveBeenCalled()

    // 500ms 경과
    vi.advanceTimersByTime(500)
    expect(writeMock).toHaveBeenCalledWith('settings.json', { b: 2 })
  })

  it('Electron 환경, 디바운스: 빠른 연속 호출 시 마지막 값으로 한 번만 IPC write한다', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('rembrandt-settings', '{"v":1}')
    vi.advanceTimersByTime(200)
    storage.setItem('rembrandt-settings', '{"v":2}')
    vi.advanceTimersByTime(200)
    storage.setItem('rembrandt-settings', '{"v":3}')

    // 아직 마지막 호출 후 500ms가 지나지 않았으므로 호출 없음
    expect(writeMock).not.toHaveBeenCalled()

    // 마지막 setItem 후 500ms 경과
    vi.advanceTimersByTime(500)
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(writeMock).toHaveBeenCalledWith('settings.json', { v: 3 })
  })

  it('Electron 환경: KEY_TO_FILE에 없는 키는 IPC write를 건너뛴다', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('custom-key', '{"x":1}')
    vi.advanceTimersByTime(1000)

    expect(localStorage.getItem('custom-key')).toBe('{"x":1}')
    expect(writeMock).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// flushWrite (beforeunload)
// ─────────────────────────────────────────────────────────────────────────────

describe('electronStorage — flushWrite (beforeunload)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    removeSettingsAPI()
    vi.restoreAllMocks()
  })

  it('beforeunload 이벤트 시 대기 중인 디바운스 쓰기를 즉시 실행한다', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('rembrandt-settings', '{"flush":true}')
    expect(writeMock).not.toHaveBeenCalled()

    // beforeunload 이벤트 발생
    window.dispatchEvent(new Event('beforeunload'))

    expect(writeMock).toHaveBeenCalledWith('settings.json', { flush: true })
  })

  it('flushWrite 시 JSON.parse 에러가 발생해도 크래시하지 않는다', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    // invalid JSON을 setItem — localStorage에는 기록되고 pendingWrites에도 등록됨
    storage.setItem('rembrandt-settings', 'not-valid-json{{{')

    // beforeunload — JSON.parse 실패해도 에러 없이 진행
    expect(() => {
      window.dispatchEvent(new Event('beforeunload'))
    }).not.toThrow()

    // write는 호출되지 않아야 한다 (JSON.parse 실패)
    expect(writeMock).not.toHaveBeenCalled()
    // 에러 로그가 출력됨
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('대기 중인 쓰기가 없으면 beforeunload가 아무 작업도 하지 않는다', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    await importFresh()

    window.dispatchEvent(new Event('beforeunload'))

    expect(writeMock).not.toHaveBeenCalled()
  })

  it('여러 키에 대한 대기 쓰기를 한 번에 모두 flush한다', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('rembrandt-settings', '{"s":1}')
    storage.setItem('rembrandt-vault', '{"v":1}')

    window.dispatchEvent(new Event('beforeunload'))

    expect(writeMock).toHaveBeenCalledTimes(2)
    expect(writeMock).toHaveBeenCalledWith('settings.json', { s: 1 })
    expect(writeMock).toHaveBeenCalledWith('vault.json', { v: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// removeItem
// ─────────────────────────────────────────────────────────────────────────────

describe('electronStorage — removeItem', () => {
  afterEach(() => {
    removeSettingsAPI()
  })

  it('localStorage에서 항목을 제거한다', async () => {
    localStorage.setItem('rembrandt-settings', '{"del":true}')
    const storage = await importFresh()

    storage.removeItem('rembrandt-settings')
    expect(localStorage.getItem('rembrandt-settings')).toBeNull()
  })

  it('존재하지 않는 키를 제거해도 에러가 발생하지 않는다', async () => {
    const storage = await importFresh()

    expect(() => {
      storage.removeItem('nonexistent-key')
    }).not.toThrow()
  })
})
