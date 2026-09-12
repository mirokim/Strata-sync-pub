/**
 * useCronExecutor.ts — Receives cron execution requests from the main process and runs renderer-side functions
 *
 * Mounted exactly once in App.tsx.
 * Daily run: edit-agent → vault-reload → vector-rebuild (main chains them sequentially)
 *
 * Event subscriptions:
 *   cron:state-update → pushes the full state/logs/runs into the store
 *   cron:log-append   → appends a single live log entry
 */
import { useEffect, useRef } from 'react'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import { useCronStore } from '@/stores/cronStore'
import type { CronLogEntry, CronRunSummary, CronJob } from '@/stores/cronStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useSettingsStore, getApiKey } from '@/stores/settingsStore'
import { runEditAgentCycle } from '@/services/editAgentRunner'
import { vectorEmbedIndex, isEmbeddingReady } from '@/lib/vectorEmbedIndex'
import { logger } from '@/lib/logger'

export function useCronExecutor() {
  const { loadVault, loadVaultCached } = useVaultLoader()
  const { fetchState, refreshLogFiles } = useCronStore()

  // H11. Prevent stale closures — handlers use the latest ref
  const loadVaultCachedRef = useRef(loadVaultCached)
  loadVaultCachedRef.current = loadVaultCached

  useEffect(() => {
    if (!window.cronAPI) return

    // Initial one-time load of the full state + history file list
    const initTimer = setTimeout(() => { fetchState(); refreshLogFiles() }, 1500)
    const cleanups: (() => void)[] = []

    // Full state update: re-inject jobs/logs/runs
    cleanups.push(window.cronAPI.onStateUpdate((data: Record<string, unknown>) => {
      const state = useCronStore.getState()
      const jobs = data.jobs as Record<string, CronJob> | undefined
      const logs = data.logs as CronLogEntry[] | undefined
      const runs = data.runs as CronRunSummary[] | undefined
      if (jobs) state.setJobs(jobs)
      if (logs) state.setLogs(logs)
      if (runs) state.setRuns(runs)
    }))

    // Append a single live log entry
    cleanups.push(window.cronAPI.onLogAppend((entry: Record<string, unknown>) => {
      useCronStore.getState().appendLog(entry as unknown as CronLogEntry)
    }))

    // ── Edit Agent ──
    cleanups.push(window.cronAPI.onExecuteJob('edit-agent', async ({ requestId, runId }) => {
      try {
        const vaultPath = useVaultStore.getState().vaultPath
        const { editAgentConfig } = useSettingsStore.getState()
        const apiKey = getApiKey('anthropic')
        if (!vaultPath) throw new Error('No vault path')
        if (!apiKey) throw new Error('Anthropic API key not configured')
        if (!editAgentConfig.refinementManual?.trim()) {
          throw new Error('Refinement manual not configured — set it up in the Edit Agent tab')
        }

        logger.debug('[CronExecutor] edit-agent started', { model: editAgentConfig.modelId, runId })
        await runEditAgentCycle({ cronRunId: runId })
        logger.debug('[CronExecutor] edit-agent finished')
        window.cronAPI!.sendResult(requestId, { ok: true })
      } catch (e) {
        const msg = (e as Error).message
        logger.error('[CronExecutor] edit-agent failed:', msg)
        if (runId) {
          window.cronAPI!.appendLog('edit-agent', 'error', `Failed: ${msg}`, { runId }).catch(() => {})
        }
        window.cronAPI!.sendResult(requestId, { error: msg })
      }
    }))

    // ── Vault Reload ──
    cleanups.push(window.cronAPI.onExecuteJob('vault-reload', async ({ requestId, runId }) => {
      try {
        const vaultPath = useVaultStore.getState().vaultPath
        if (vaultPath) await loadVaultCachedRef.current(vaultPath)
        window.cronAPI!.sendResult(requestId, { ok: true })
      } catch (e) {
        const msg = (e as Error).message
        if (runId) window.cronAPI!.appendLog('vault-reload', 'error', `Failed: ${msg}`, { runId }).catch(() => {})
        window.cronAPI!.sendResult(requestId, { error: msg })
      }
    }))

    // ── Vector Rebuild ──
    cleanups.push(window.cronAPI.onExecuteJob('vector-rebuild', async ({ requestId, runId }) => {
      try {
        const docs = useVaultStore.getState().loadedDocuments
        const apiKey = getApiKey('gemini')
        const vaultPath = useVaultStore.getState().vaultPath
        if (docs && vaultPath && await isEmbeddingReady(apiKey)) {
          await vectorEmbedIndex.buildIncremental(docs, apiKey ?? '', vaultPath)
        }
        if (runId) {
          window.cronAPI!.appendLog(
            'vector-rebuild', 'info', `Vector index build complete (${docs?.length ?? 0} docs)`,
            { runId, fileCount: docs?.length ?? 0 },
          ).catch(() => {})
        }
        window.cronAPI!.sendResult(requestId, { ok: true })
      } catch (e) {
        const msg = (e as Error).message
        if (runId) window.cronAPI!.appendLog('vector-rebuild', 'error', `Failed: ${msg}`, { runId }).catch(() => {})
        window.cronAPI!.sendResult(requestId, { error: msg })
      }
    }))

    return () => {
      clearTimeout(initTimer)
      cleanups.forEach(fn => fn())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
