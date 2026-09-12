/**
 * electronStorage.ts — Zustand persist용 Electron IPC 파일 스토리지 어댑터 (싱글턴)
 *
 * Electron 환경: userData 디렉토리에 JSON 파일로 저장 (settings:read/write IPC)
 * 웹/개발 모드: localStorage fallback
 *
 * 안정성:
 * - main.cjs 쪽에서 atomic write (tmp → rename) + .bak 백업/복구
 * - setItem: localStorage 즉시 기록 + IPC 500ms 디바운스
 * - beforeunload 시 대기 중인 디바운스 즉시 flush
 * - 최초 실행 시 파일이 없으면 localStorage에서 자동 마이그레이션
 */
import type { StateStorage } from 'zustand/middleware'

/** Zustand persist 키 → userData 파일명 매핑 */
const KEY_TO_FILE: Record<string, string> = {
  'rembrandt-settings': 'settings.json',
  'rembrandt-vault': 'vault.json',
}

function isElectron(): boolean {
  return typeof window !== 'undefined' && !!window.settingsAPI
}

/** 대기 중인 디바운스 쓰기 추적 */
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
    console.error(`[electronStorage] flushWrite JSON.parse 실패 (${filename}):`, (err as Error).message,
      '— valueLength:', value.length, ', sample:', value.slice(0, 80))
    return // localStorage에는 이미 기록됨
  }

  window.settingsAPI!.write(filename, parsed).catch(err => {
    console.error(`[electronStorage] flushWrite IPC 실패 (${filename}):`, err)
  })
}

/** 앱 종료/새로고침 시 대기 중인 쓰기 즉시 실행 */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const name of [...pendingWrites.keys()]) {
      flushWrite(name)
    }
  })
}

/** 싱글턴 StateStorage — 두 스토어가 공유 */
export const electronStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (isElectron()) {
      const filename = KEY_TO_FILE[name]
      if (!filename) return localStorage.getItem(name)

      // IPC 읽기 — 실패 시 localStorage fallback
      let data: Record<string, unknown> | null = null
      try {
        data = await window.settingsAPI!.read(filename)
      } catch (err) {
        console.error(`[electronStorage] IPC read 실패 (${filename}):`, err)
        return localStorage.getItem(name)
      }
      if (data) return JSON.stringify(data)

      // 마이그레이션: 파일 미존재 시 localStorage → 파일로 일회성 복사
      const localData = localStorage.getItem(name)
      if (localData) {
        try {
          await window.settingsAPI!.write(filename, JSON.parse(localData))
        } catch (err) {
          console.warn(`[electronStorage] 마이그레이션 실패 (${filename}):`, err)
        }
        return localData
      }
      return null
    }
    return localStorage.getItem(name)
  },

  setItem: (name: string, value: string): void => {
    // localStorage에 즉시 기록 (동기 백업 — IPC 실패 시 안전망)
    try {
      localStorage.setItem(name, value)
    } catch (err) {
      if (!loggedQuotaErrors.has(name)) {
        console.warn(`[electronStorage] localStorage 쓰기 실패 (${name}):`, (err as Error).message)
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
