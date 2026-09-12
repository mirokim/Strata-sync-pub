/**
 * useCronExecutor.ts — Main process 의 cron 실행 요청을 수신해 렌더러 측 함수 실행
 *
 * App.tsx 에서 한 번만 마운트.
 * 일일 실행: edit-agent → vault-reload → vector-rebuild (main 이 순차 체인)
 *
 * 이벤트 구독:
 *   cron:state-update → 전체 상태/logs/runs 를 스토어로 반영
 *   cron:log-append   → 라이브 로그 엔트리 1건 추가
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

  // H11. stale closure 방지 — 핸들러는 최신 ref 사용
  const loadVaultCachedRef = useRef(loadVaultCached)
  loadVaultCachedRef.current = loadVaultCached

  useEffect(() => {
    if (!window.cronAPI) return

    // 초기 1회 풀 state + 이력 파일 목록 로드
    const initTimer = setTimeout(() => { fetchState(); refreshLogFiles() }, 1500)
    const cleanups: (() => void)[] = []

    // 전체 상태 업데이트: jobs/logs/runs 재주입
    cleanups.push(window.cronAPI.onStateUpdate((data: Record<string, unknown>) => {
      const state = useCronStore.getState()
      const jobs = data.jobs as Record<string, CronJob> | undefined
      const logs = data.logs as CronLogEntry[] | undefined
      const runs = data.runs as CronRunSummary[] | undefined
      if (jobs) state.setJobs(jobs)
      if (logs) state.setLogs(logs)
      if (runs) state.setRuns(runs)
    }))

    // 라이브 로그 엔트리 1건 추가
    cleanups.push(window.cronAPI.onLogAppend((entry: Record<string, unknown>) => {
      useCronStore.getState().appendLog(entry as unknown as CronLogEntry)
    }))

    // ── Edit Agent ──
    cleanups.push(window.cronAPI.onExecuteJob('edit-agent', async ({ requestId, runId }) => {
      try {
        const vaultPath = useVaultStore.getState().vaultPath
        const { editAgentConfig } = useSettingsStore.getState()
        const apiKey = getApiKey('anthropic')
        if (!vaultPath) throw new Error('볼트 경로 없음')
        if (!apiKey) throw new Error('Anthropic API 키 미설정')
        if (!editAgentConfig.refinementManual?.trim()) {
          throw new Error('정제 매뉴얼 미설정 — 편집 에이전트 탭에서 매뉴얼을 설정하세요')
        }

        logger.debug('[CronExecutor] edit-agent 시작', { model: editAgentConfig.modelId, runId })
        await runEditAgentCycle({ cronRunId: runId })
        logger.debug('[CronExecutor] edit-agent 완료')
        window.cronAPI!.sendResult(requestId, { ok: true })
      } catch (e) {
        const msg = (e as Error).message
        logger.error('[CronExecutor] edit-agent 실패:', msg)
        if (runId) {
          window.cronAPI!.appendLog('edit-agent', 'error', `실패: ${msg}`, { runId }).catch(() => {})
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
        if (runId) window.cronAPI!.appendLog('vault-reload', 'error', `실패: ${msg}`, { runId }).catch(() => {})
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
            'vector-rebuild', 'info', `벡터 인덱스 빌드 완료 (${docs?.length ?? 0}건)`,
            { runId, fileCount: docs?.length ?? 0 },
          ).catch(() => {})
        }
        window.cronAPI!.sendResult(requestId, { ok: true })
      } catch (e) {
        const msg = (e as Error).message
        if (runId) window.cronAPI!.appendLog('vector-rebuild', 'error', `실패: ${msg}`, { runId }).catch(() => {})
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
