/**
 * electronStorage.ts — Electron IPC file storage adapter for Zustand persist (singleton)
 *
 * Electron environment: saved as JSON files in the userData directory (settings:read/write IPC)
 * Web/dev mode: localStorage fallback
 *
 * Robustness:
 * - main.cjs side does atomic write (tmp → rename) + .bak backup/recovery
 * - setItem: immediate localStorage write + 500ms debounced IPC
 * - pending debounced writes are flushed immediately on beforeunload
 * - on first run, if the file does not exist, auto-migrate from localStorage
 */
import type { StateStorage } from 'zustand/middleware'

/** Zustand persist key → userData filename mapping */
const KEY_TO_FILE: Record<string, string> = {
  'strata-sync-settings': 'settings.json',
  'strata-sync-vault': 'vault.json',
}

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.settingsAPI
}

/** Tracks pending debounced writes */
const pendingWrites = new Map<string, string>()
const writeTimers: Record<string, ReturnType<typeof setTimeout>> = {}
const loggedQuotaErrors = new Set<string>()

function flushWrite(name: string) {
  if (writeTimers[name]) {
    clearTimeout(writeTimers[name])
    delete writeTimers[name]
  }
  const value = pendingWrites.get(name)
  if (!value) return
  pendingWrites.delete(name)
  const filename = KEY_TO_FILE[name]
  if (!filename || !isElectron()) return

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(value)
  } catch (err) {
    console.error(`[electronStorage] flushWrite JSON.parse failed (${filename}):`, (err as Error).message,
      '— valueLength:', value.length, ', sample:', value.slice(0, 80))
    return // already written to localStorage
  }

  window.settingsAPI!.write(filename, parsed).catch(err => {
    console.error(`[electronStorage] flushWrite IPC failed (${filename}):`, err)
  })
}

/** Flush pending writes immediately on app exit/reload */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const name of [...pendingWrites.keys()]) {
      flushWrite(name)
    }
  })
}

/** Singleton StateStorage — shared by both stores */
export const electronStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (isElectron()) {
      const filename = KEY_TO_FILE[name]
      if (!filename) return localStorage.getItem(name)

      // IPC read — falls back to localStorage on failure
      let data: Record<string, unknown> | null = null
      try {
        data = await window.settingsAPI!.read(filename)
      } catch (err) {
        console.error(`[electronStorage] IPC read failed (${filename}):`, err)
        return localStorage.getItem(name)
      }
      if (data) return JSON.stringify(data)

      // Migration: if the file does not exist, one-time copy from localStorage → file
      const localData = localStorage.getItem(name)
      if (localData) {
        try {
          await window.settingsAPI!.write(filename, JSON.parse(localData))
        } catch (err) {
          console.warn(`[electronStorage] Migration failed (${filename}):`, err)
        }
        return localData
      }
      return null
    }
    return localStorage.getItem(name)
  },

  setItem: (name: string, value: string): void => {
    // Write to localStorage immediately (synchronous backup — safety net if IPC fails)
    try {
      localStorage.setItem(name, value)
    } catch (err) {
      if (!loggedQuotaErrors.has(name)) {
        console.warn(`[electronStorage] localStorage write failed (${name}):`, (err as Error).message)
        loggedQuotaErrors.add(name)
      }
    }

    if (isElectron()) {
      const filename = KEY_TO_FILE[name]
      if (!filename) return
      pendingWrites.set(name, value)
      if (writeTimers[name]) clearTimeout(writeTimers[name])
      writeTimers[name] = setTimeout(() => {
        delete writeTimers[name]
        flushWrite(name)
      }, 500)
    }
  },

  removeItem: (name: string): void => {
    localStorage.removeItem(name)
  },
}
