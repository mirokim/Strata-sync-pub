import { useEffect, useRef } from 'react'
import { useSettingsStore, MIGRATED_CONFIG_KEY } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useSyncStore } from '@/stores/syncStore'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import { pageToVaultMarkdown } from '@/lib/confluenceToMarkdown'
import { logger } from '@/lib/logger'
import { toSyncDatetime } from '@/lib/formatUtils'
import { POST_SYNC_SCRIPTS } from '@/lib/scriptConfig'

export function useConfluenceAutoSync() {
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isSyncingRef = useRef(false)
  const isMountedRef = useRef(false)
  const activeVaultId   = useVaultStore(s => s.activeVaultId)
  const autoSync        = useSettingsStore(s => s.confluenceConfigs[activeVaultId]?.autoSync ?? false)
  const intervalMinutes = useSettingsStore(s => s.confluenceConfigs[activeVaultId]?.autoSyncIntervalMinutes ?? 60)
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
      const { confluenceConfigs } = useSettingsStore.getState()
      const cfg = confluenceConfigs[vaultId] ?? confluenceConfigs[MIGRATED_CONFIG_KEY]
      if (!cfg) { isSyncingRef.current = false; return }
      const vaultPath = useVaultStore.getState().vaultPath
      const { lastSyncAt, setLastSyncAt, setNotification } = useSyncStore.getState()

      if (!vaultPath || !cfg.baseUrl || !cfg.apiToken) { isSyncingRef.current = false; return }

      try {
        // lastSyncAt → "YYYY-MM-DD HH:mm" (UTC) — truncating to the date alone causes same-day duplicates
        // Safety net: if neither lastSyncAt nor cfg.dateFrom is set, fetch only the last 7 days
        const fallbackDate = cfg.dateFrom || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const dateFrom = toSyncDatetime(lastSyncAt, fallbackDate)

        const pages = await (window as any).confluenceAPI.fetchPages({
          baseUrl:   cfg.baseUrl,
          email:     cfg.email,
          apiToken:  cfg.apiToken,
          spaceKey:  cfg.spaceKey,
          dateFrom,
          dateTo:    '',
          authType:  cfg.authType,
          bypassSSL: cfg.bypassSSL,
        })

        if (!pages || pages.length === 0) return

        // convert → save (includes §4.0 automatic frontmatter generation)
        // Inject _baseUrl: needed to build the source URL field (§6.1 required)
        const pagesWithMd = (pages as any[]).map(page =>
          pageToVaultMarkdown({ ...page, _baseUrl: cfg.baseUrl })
        )
        await (window as any).confluenceAPI.savePages(vaultPath, cfg.targetFolder, pagesWithMd)

        // Attachment download — failures are counted and logged as warnings
        let attachFailed = 0
        const attachCfg = {
          baseUrl:   cfg.baseUrl,
          authType:  cfg.authType,
          email:     cfg.email,
          apiToken:  cfg.apiToken,
          bypassSSL: cfg.bypassSSL,
        }
        for (const page of pages as any[]) {
          await (window as any).confluenceAPI
            .downloadAttachments(attachCfg, vaultPath, cfg.targetFolder, page.id)
            .catch((e: unknown) => {
              attachFailed++
              logger.warn('[AutoSync] Attachment download failed:', page.id, e instanceof Error ? e.message : String(e))
            })
        }

        // §17.1.4 post-sync: audit_and_fix → gen_index
        const api = (window as any).confluenceAPI
        if (typeof api?.runScript === 'function') {
          // If this script fails the vault index is inconsistent — warn the user and leave lastSyncAt unchanged
          const CRITICAL_SCRIPTS = new Set(['gen_index.py', 'audit_and_fix.py'])
          let criticalFailed = ''
          for (const script of POST_SYNC_SCRIPTS) {
            try {
              const r = await api.runScript(script.name, script.buildArgs(vaultPath))
              if (r?.exitCode !== 0) {
                logger.warn(`[AutoSync] ${script.name} exit ${r?.exitCode}: ${r?.stderr?.slice(0, 200)}`)
                if (CRITICAL_SCRIPTS.has(script.name) && !criticalFailed) criticalFailed = script.name
              }
            } catch (e) {
              logger.warn(`[AutoSync] Script execution failed: ${script.name}`, e instanceof Error ? e.message : String(e))
              if (CRITICAL_SCRIPTS.has(script.name) && !criticalFailed) criticalFailed = script.name
            }
          }
          if (criticalFailed) {
            const failNoteAttach = attachFailed > 0 ? ` + ${attachFailed} attachment(s) failed` : ''
            setNotification({
              message: `Confluence sync warning: ${criticalFailed} failed — index may be inconsistent${failNoteAttach}`,
              count: pages.length,
              at: new Date().toISOString(),
            })
            return  // lastSyncAt not updated → changes are reprocessed on the next sync
          }
        }

        // Reload the vault — so new documents show up in-app
        await loadVault(vaultPath)

        // Record lastSyncAt only after a successful completion
        const now = new Date().toISOString()
        setLastSyncAt(now)

        const failNote = attachFailed > 0 ? ` (${attachFailed} attachment(s) failed)` : ''
        setNotification({
          message: `Confluence auto-sync complete${failNote}`,
          count: pages.length,
          at: now,
        })
      } catch (e) {
        logger.warn('[AutoSync] Auto-sync failed:', e instanceof Error ? e.message : String(e))
      } finally {
        isSyncingRef.current = false
      }
    }

    // Catch-up: run immediately on app start if no sync has happened today yet
    const { lastSyncAt: lastAt } = useSyncStore.getState()
    const last = lastAt ? new Date(lastAt) : null
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
