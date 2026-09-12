/**
 * Edit Agent scheduler hook.
 *
 * Wakes up on the configured interval and runs a file refinement cycle.
 * Also manages the vault auto-refresh countdown (ticks even when the panel is closed).
 *
 * Usage: call `useEditAgent()` once at the App level.
 */

import { useEffect, useRef } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useEditAgentStore } from '@/stores/editAgentStore'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import { runEditAgentCycle } from '@/services/editAgentRunner'
import { logger } from '@/lib/logger'

export function useEditAgent() {
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isRunningRef = useRef(false)
  const isMountedRef = useRef(true)

  const enabled         = useSettingsStore(s => s.editAgentConfig.enabled)
  const intervalMinutes = useSettingsStore(s => s.editAgentConfig.intervalMinutes)
  const vaultPath       = useVaultStore(s => s.vaultPath)

  // ── Vault auto-refresh countdown (global — ticks even when panel is closed) ─
  const vaultRefreshSession = useEditAgentStore(s => s.vaultRefreshSession)
  const { loadVault } = useVaultLoader()

  useEffect(() => {
    // Always clear previous interval before re-arming to prevent stacking
    if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null }
    if (useEditAgentStore.getState().vaultRefreshCountdown === null) return
    countdownRef.current = setInterval(() => {
      const current = useEditAgentStore.getState().vaultRefreshCountdown
      if (current === null) { clearInterval(countdownRef.current!); countdownRef.current = null; return }
      if (current <= 1) {
        clearInterval(countdownRef.current!); countdownRef.current = null
        useEditAgentStore.getState().cancelVaultRefreshCountdown()
        const path = useVaultStore.getState().vaultPath
        if (path) void loadVault(path)
      } else {
        useEditAgentStore.getState().tickVaultRefreshCountdown()
      }
    }, 1000)
    return () => { if (countdownRef.current) { clearInterval(countdownRef.current); countdownRef.current = null } }
  }, [vaultRefreshSession, loadVault]) // re-arm on each new countdown session

  // ── Wake cycle scheduler ───────────────────────────────────────────────────

  // Track mount state so async cycles can bail out after unmount
  useEffect(() => {
    isMountedRef.current = true
    return () => { isMountedRef.current = false }
  }, [])

  useEffect(() => {
    // Clear any existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }

    // Don't schedule if disabled, no vault, or invalid interval
    if (!enabled || !vaultPath || !intervalMinutes || intervalMinutes < 1) return

    const intervalMs = intervalMinutes * 60 * 1000

    const runCycle = async () => {
      if (!isMountedRef.current || isRunningRef.current) {
        if (!isMountedRef.current) logger.debug('[EditAgent] 언마운트됨 — 사이클 건너뜀')
        else logger.debug('[EditAgent] 이전 사이클 실행 중 — 건너뜀')
        return
      }
      isRunningRef.current = true
      try {
        await runEditAgentCycle()
      } catch (err) {
        logger.error('[EditAgent] 예상치 못한 오류:', err)
      } finally {
        if (isMountedRef.current) isRunningRef.current = false
      }
    }

    intervalRef.current = setInterval(runCycle, intervalMs)
    logger.debug(`[EditAgent] 스케줄러 시작: ${intervalMinutes}분 간격`)

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [enabled, intervalMinutes, vaultPath])
}
