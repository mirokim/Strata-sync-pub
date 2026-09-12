/**
 * useJiraAutoSync.ts — Jira 이슈 자동 동기화 훅
 *
 * JiraConfig.autoSync=true 이면 설정된 주기마다 Jira에서 변경된 이슈를 가져와 볼트에 저장.
 * 앱 시작 시 오늘 아직 동기화 안 됐으면 즉시 catch-up 실행.
 * lastJiraSyncAt을 "YYYY-MM-DD HH:mm" (UTC) datetime으로 JQL에 전달해 분 단위 증분 동기화.
 */
import { useEffect, useRef } from 'react'
import { useSettingsStore, MIGRATED_CONFIG_KEY } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useSyncStore } from '@/stores/syncStore'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import { issueToVaultMarkdown, type JiraIssue } from '@/lib/jiraToMarkdown'
import { logger } from '@/lib/logger'

import { toSyncDatetime } from '@/lib/formatUtils'

export function useJiraAutoSync() {
  const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const isSyncingRef = useRef(false)
  const isMountedRef = useRef(false)
  const activeVaultId   = useVaultStore(s => s.activeVaultId)
  const autoSync        = useSettingsStore(s => s.jiraConfigs[activeVaultId]?.autoSync ?? false)
  const intervalMinutes = useSettingsStore(s => s.jiraConfigs[activeVaultId]?.autoSyncIntervalMinutes ?? 60)
  const { loadVault } = useVaultLoader()

  useEffect(() => {
    isMountedRef.current = true
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (!autoSync || !intervalMinutes) return

    const runSync = async () => {
      if (!isMountedRef.current || isSyncingRef.current) return
      isSyncingRef.current = true

      const { activeVaultId: vaultId } = useVaultStore.getState()
      const { jiraConfigs } = useSettingsStore.getState()
      const cfg = jiraConfigs[vaultId] ?? jiraConfigs[MIGRATED_CONFIG_KEY]
      if (!cfg) { isSyncingRef.current = false; return }

      const vaultPath = useVaultStore.getState().vaultPath
      const { lastJiraSyncAt, setLastJiraSyncAt, setNotification } = useSyncStore.getState()

      if (!vaultPath || !cfg.baseUrl || !cfg.apiToken) { isSyncingRef.current = false; return }

      try {
        // 안전장치: lastJiraSyncAt과 cfg.dateFrom 모두 없으면 최근 7일만 가져옴
        const fallbackDate = cfg.dateFrom || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const dateFrom = toSyncDatetime(lastJiraSyncAt, fallbackDate)

        const issues: JiraIssue[] = await (window as any).jiraAPI.fetchIssues({
          baseUrl:    cfg.baseUrl,
          email:      cfg.email,
          apiToken:   cfg.apiToken,
          projectKey: cfg.projectKey,
          jql:        cfg.jql || undefined,
          dateFrom,
          dateTo:     '',
          authType:   cfg.authType,
          bypassSSL:  cfg.bypassSSL,
        })

        const now = new Date().toISOString()

        if (!issues || issues.length === 0) {
          setLastJiraSyncAt(now)  // 변경사항 없어도 타임스탬프 갱신
          return
        }

        const converted = issues.map(issue => issueToVaultMarkdown(issue, cfg.baseUrl))
        const targetFolder = cfg.targetFolder || 'jira'

        await (window as any).jiraAPI.saveIssues(
          vaultPath,
          targetFolder,
          converted.map(p => ({ filename: p.filename, content: p.content })),
        )

        await loadVault(vaultPath)

        setLastJiraSyncAt(now)
        setNotification({ message: 'Jira 자동 동기화 완료', count: issues.length, at: now })
      } catch (e) {
        logger.warn('[JiraAutoSync] 동기화 실패:', e instanceof Error ? e.message : String(e))
      } finally {
        isSyncingRef.current = false
      }
    }

    // Catch-up: 앱 시작 시 오늘 아직 동기화 안 됐으면 즉시 실행
    const { lastJiraSyncAt } = useSyncStore.getState()
    const last = lastJiraSyncAt ? new Date(lastJiraSyncAt) : null
    const isStale = !last || last.toDateString() !== new Date().toDateString()
    if (isStale) runSync()

    const ms = intervalMinutes * 60 * 1000
    intervalRef.current = setInterval(runSync, ms)

    return () => {
      isMountedRef.current = false
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [autoSync, intervalMinutes, activeVaultId, loadVault])
}
