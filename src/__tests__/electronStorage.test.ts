import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { StateStorage } from 'zustand/middleware'

// ── Helper: re-import the module each time to reset singleton state (pendingWrites etc.) ──
async function importFresh(): Promise<StateStorage> {
  vi.resetModules()
  const mod = await import('@/lib/electronStorage')
  return mod.electronStorage
}

// ── settingsAPI mock helper ───────────────────────────────────────────────────
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

  it('non-Electron environment: returns the localStorage value', async () => {
    removeSettingsAPI()
    localStorage.setItem('strata-sync-settings', '{"theme":"dark"}')
    const storage = await importFresh()

    const result = await storage.getItem('strata-sync-settings')
    expect(result).toBe('{"theme":"dark"}')
  })

  it('non-Electron environment: returns null when the key is missing', async () => {
    removeSettingsAPI()
    const storage = await importFresh()

    const result = await storage.getItem('strata-sync-settings')
    expect(result).toBeNull()
  })

  it('Electron environment: returns the settingsAPI.read result as a JSON string', async () => {
    installSettingsAPI({
      read: vi.fn().mockResolvedValue({ theme: 'dark', fontSize: 14 }),
    })
    const storage = await importFresh()

    const result = await storage.getItem('strata-sync-settings')
    expect(result).toBe(JSON.stringify({ theme: 'dark', fontSize: 14 }))
    expect(window.settingsAPI!.read).toHaveBeenCalledWith('settings.json')
  })

  it('Electron environment: keys not in KEY_TO_FILE fall back to localStorage', async () => {
    installSettingsAPI()
    localStorage.setItem('unknown-key', '{"x":1}')
    const storage = await importFresh()

    const result = await storage.getItem('unknown-key')
    expect(result).toBe('{"x":1}')
    expect(window.settingsAPI!.read).not.toHaveBeenCalled()
  })

  it('Electron environment, IPC failure: falls back to localStorage', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installSettingsAPI({
      read: vi.fn().mockRejectedValue(new Error('IPC timeout')),
    })
    localStorage.setItem('strata-sync-settings', '{"fallback":true}')
    const storage = await importFresh()

    const result = await storage.getItem('strata-sync-settings')
    expect(result).toBe('{"fallback":true}')
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('Electron environment, migration: when the file is missing, copies localStorage → file and returns it', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({
      read: vi.fn().mockResolvedValue(null),
      write: writeMock,
    })
    localStorage.setItem('strata-sync-settings', '{"migrated":true}')
    const storage = await importFresh()

    const result = await storage.getItem('strata-sync-settings')

    expect(result).toBe('{"migrated":true}')
    expect(writeMock).toHaveBeenCalledWith('settings.json', { migrated: true })
  })

  it('Electron environment, migration: returns null when neither file nor localStorage exists', async () => {
    installSettingsAPI({
      read: vi.fn().mockResolvedValue(null),
    })
    const storage = await importFresh()

    const result = await storage.getItem('strata-sync-settings')
    expect(result).toBeNull()
  })

  it('Electron environment, migration: on write failure, warns and returns the localStorage value', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    installSettingsAPI({
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockRejectedValue(new Error('disk full')),
    })
    localStorage.setItem('strata-sync-vault', '{"docs":[]}')
    const storage = await importFresh()

    const result = await storage.getItem('strata-sync-vault')

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

  it('non-Electron environment: writes only to localStorage', async () => {
    removeSettingsAPI()
    const storage = await importFresh()

    storage.setItem('strata-sync-settings', '{"a":1}')
    expect(localStorage.getItem('strata-sync-settings')).toBe('{"a":1}')
  })

  it('Electron environment: writes to localStorage immediately and runs IPC write after 500ms', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('strata-sync-settings', '{"b":2}')

    // written to localStorage immediately
    expect(localStorage.getItem('strata-sync-settings')).toBe('{"b":2}')
    // IPC not called yet
    expect(writeMock).not.toHaveBeenCalled()

    // 500ms elapsed
    vi.advanceTimersByTime(500)
    expect(writeMock).toHaveBeenCalledWith('settings.json', { b: 2 })
  })

  it('Electron environment, debounce: rapid successive calls trigger a single IPC write with the last value', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('strata-sync-settings', '{"v":1}')
    vi.advanceTimersByTime(200)
    storage.setItem('strata-sync-settings', '{"v":2}')
    vi.advanceTimersByTime(200)
    storage.setItem('strata-sync-settings', '{"v":3}')

    // no call yet since 500ms have not passed since the last call
    expect(writeMock).not.toHaveBeenCalled()

    // 500ms elapsed after the last setItem
    vi.advanceTimersByTime(500)
    expect(writeMock).toHaveBeenCalledTimes(1)
    expect(writeMock).toHaveBeenCalledWith('settings.json', { v: 3 })
  })

  it('Electron environment: keys not in KEY_TO_FILE skip the IPC write', async () => {
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

  it('flushes pending debounced writes immediately on beforeunload', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('strata-sync-settings', '{"flush":true}')
    expect(writeMock).not.toHaveBeenCalled()

    // beforeunload event fires
    window.dispatchEvent(new Event('beforeunload'))

    expect(writeMock).toHaveBeenCalledWith('settings.json', { flush: true })
  })

  it('does not crash when JSON.parse throws during flushWrite', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    // setItem with invalid JSON — written to localStorage and registered in pendingWrites
    storage.setItem('strata-sync-settings', 'not-valid-json{{{')

    // beforeunload — proceeds without error even if JSON.parse fails
    expect(() => {
      window.dispatchEvent(new Event('beforeunload'))
    }).not.toThrow()

    // write must not be called (JSON.parse failed)
    expect(writeMock).not.toHaveBeenCalled()
    // error log is emitted
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('beforeunload does nothing when there are no pending writes', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    await importFresh()

    window.dispatchEvent(new Event('beforeunload'))

    expect(writeMock).not.toHaveBeenCalled()
  })

  it('flushes pending writes for multiple keys at once', async () => {
    const writeMock = vi.fn().mockResolvedValue({ ok: true })
    installSettingsAPI({ write: writeMock })
    const storage = await importFresh()

    storage.setItem('strata-sync-settings', '{"s":1}')
    storage.setItem('strata-sync-vault', '{"v":1}')

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

  it('removes the item from localStorage', async () => {
    localStorage.setItem('strata-sync-settings', '{"del":true}')
    const storage = await importFresh()

    storage.removeItem('strata-sync-settings')
    expect(localStorage.getItem('strata-sync-settings')).toBeNull()
  })

  it('does not throw when removing a non-existent key', async () => {
    const storage = await importFresh()

    expect(() => {
      storage.removeItem('nonexistent-key')
    }).not.toThrow()
  })
})
