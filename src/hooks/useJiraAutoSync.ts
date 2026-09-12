/**
 * useJiraAutoSync.ts — Jira issue auto-sync hook
 *
 * When JiraConfig.autoSync=true, fetches changed issues from Jira at the configured interval and saves them to the vault.
 * On app start, runs an immediate catch-up if no sync has happened today yet.
 * Passes lastJiraSyncAt to JQL as a "YYYY-MM-DD HH:mm" (UTC) datetime for minute-level incremental sync.
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
        // Safety net: if neither lastJiraSyncAt nor cfg.dateFrom is set, fetch only the last 7 days
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
          setLastJiraSyncAt(now)  // Update the timestamp even when nothing changed
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
        setNotification({ message: 'Jira auto-sync complete', count: issues.length, at: now })
      } catch (e) {
        logger.warn('[JiraAutoSync] Sync failed:', e instanceof Error ? e.message : String(e))
      } finally {
        isSyncingRef.current = false
      }
    }

    // Catch-up: run immediately on app start if no sync has happened today yet
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
