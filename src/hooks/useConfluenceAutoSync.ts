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
        // lastSyncAt → "YYYY-MM-DD HH:mm" (UTC) — 날짜만 자르면 당일 중복 발생
        // 안전장치: lastSyncAt과 cfg.dateFrom 모두 없으면 최근 7일만 가져옴
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

        // convert → save (§4.0 frontmatter 자동 생성 포함)
        // _baseUrl 주입: source URL 필드 생성에 필요 (§6.1 필수)
        const pagesWithMd = (pages as any[]).map(page =>
          pageToVaultMarkdown({ ...page, _baseUrl: cfg.baseUrl })
        )
        await (window as any).confluenceAPI.savePages(vaultPath, cfg.targetFolder, pagesWithMd)

        // 첨부파일 다운로드 — 실패는 카운트 후 경고 로그
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
              logger.warn('[AutoSync] 첨부파일 다운로드 실패:', page.id, e instanceof Error ? e.message : String(e))
            })
        }

        // §17.1.4 post-sync: audit_and_fix → gen_index
        const api = (window as any).confluenceAPI
        if (typeof api?.runScript === 'function') {
          // 이 스크립트가 실패하면 볼트 인덱스 불일치 — 사용자에게 경고하고 lastSyncAt 미갱신
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
              logger.warn(`[AutoSync] 스크립트 실행 실패: ${script.name}`, e instanceof Error ? e.message : String(e))
              if (CRITICAL_SCRIPTS.has(script.name) && !criticalFailed) criticalFailed = script.name
            }
          }
          if (criticalFailed) {
            const failNoteAttach = attachFailed > 0 ? ` + 첨부 ${attachFailed}개 실패` : ''
            setNotification({
              message: `Confluence 동기화 경고: ${criticalFailed} 실패 — 인덱스 불일치 가능${failNoteAttach}`,
              count: pages.length,
              at: new Date().toISOString(),
            })
            return  // lastSyncAt 미갱신 → 다음 싱크에서 변경분 재처리
          }
        }

        // 볼트 리로드 — 새 문서가 in-app에 반영되도록
        await loadVault(vaultPath)

        // lastSyncAt은 성공적으로 완료된 후에만 기록
        const now = new Date().toISOString()
        setLastSyncAt(now)

        const failNote = attachFailed > 0 ? ` (첨부 ${attachFailed}개 실패)` : ''
        setNotification({
          message: `Confluence 자동 동기화 완료${failNote}`,
          count: pages.length,
          at: now,
        })
      } catch (e) {
        logger.warn('[AutoSync] 자동 동기화 실패:', e instanceof Error ? e.message : String(e))
      } finally {
        isSyncingRef.current = false
      }
    }

    // Catch-up: 앱 시작 시 오늘 아직 동기화 안 됐으면 즉시 실행
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
