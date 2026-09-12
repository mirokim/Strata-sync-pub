/**
 * syncRunner.ts — Confluence / Jira 동기화 로직
 *
 * useConfluenceAutoSync / useJiraAutoSync 훅에서 추출한 순수 함수.
 * Edit Agent 웨이크 사이클에서 호출되며, 훅 형태가 아닌 일반 async 함수로 동작.
 */

import { useSettingsStore, MIGRATED_CONFIG_KEY } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useSyncStore } from '@/stores/syncStore'
import { pageToVaultMarkdown } from '@/lib/confluenceToMarkdown'
import { issueToVaultMarkdown, type JiraIssue } from '@/lib/jiraToMarkdown'
import { logger } from '@/lib/logger'
import { toSyncDatetime } from '@/lib/formatUtils'
import { POST_SYNC_SCRIPTS } from '@/lib/scriptConfig'
import type { EditAgentState } from '@/stores/editAgentStore'

type ScriptResult = { exitCode: number; stderr?: string; stdout?: string }
type ScriptAPI = { runScript?: (n: string, a: string[]) => Promise<ScriptResult> }

function getScriptAPI(): ScriptAPI | undefined {
  return (window as unknown as Record<string, unknown>)['confluenceAPI'] as ScriptAPI | undefined
}

async function runPostSyncScripts(vaultPath: string, store: EditAgentState): Promise<void> {
  const api = getScriptAPI()
  if (typeof api?.runScript !== 'function') return
  for (const script of POST_SYNC_SCRIPTS) {
    try {
      const r = await api.runScript(script.name, script.buildArgs(vaultPath))
      if (r?.exitCode !== 0) {
        store.addLog({ action: 'error', detail: `${script.name} exit ${r?.exitCode}: ${r?.stderr?.slice(0, 120) ?? ''}` })
      } else {
        store.addLog({ action: 'diff_check', detail: `✓ ${script.name}` })
      }
    } catch (e) {
      store.addLog({ action: 'error', detail: `${script.name}: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
}

/**
 * check_quality.py 실행 후 핵심 지표를 EditAgentLog에 노출.
 * WARN 항목과 총 이슈 건수만 추출해 간결하게 표시.
 */
export async function runQualityCheck(vaultPath: string, store: EditAgentState): Promise<void> {
  const api = getScriptAPI()
  if (typeof api?.runScript !== 'function') return
  try {
    const r = await api.runScript('check_quality.py', [vaultPath, '--vault', vaultPath])
    if (!r?.stdout) return
    const lines = r.stdout.split('\n')
    // 총 이슈 수 (마지막 요약 줄)
    const summaryLine = lines.find(l => l.includes('수정 권장 이슈'))
    if (summaryLine) store.addLog({ action: 'diff_check', detail: `📊 품질: ${summaryLine.trim()}` })
    // WARN 항목만 추출 (최대 5개)
    const warnLines = lines.filter(l => l.startsWith('[WARN]')).slice(0, 5)
    for (const w of warnLines) {
      store.addLog({ action: 'error', detail: w.trim() })
    }
  } catch (e) {
    logger.warn('[syncRunner] check_quality 실패:', e)
  }
}

/** 동기화 호출의 성공 여부 + 실패 시 메시지 */
export type SyncResult = { ok: boolean; message?: string }

export async function runConfluenceSync(store: EditAgentState): Promise<SyncResult> {
  const { activeVaultId } = useVaultStore.getState()
  const { confluenceConfigs } = useSettingsStore.getState()
  const cfg = confluenceConfigs[activeVaultId] ?? confluenceConfigs[MIGRATED_CONFIG_KEY]
  const vaultPath = useVaultStore.getState().vaultPath
  const { lastSyncAt, setLastSyncAt, setNotification } = useSyncStore.getState()

  if (!vaultPath || !cfg?.baseUrl || !cfg.apiToken) {
    const msg = 'Confluence 설정 없음 — 설정 > Confluence 확인'
    store.addLog({ action: 'error', detail: msg })
    return { ok: false, message: msg }
  }

  store.addLog({ action: 'diff_check', detail: 'Confluence 동기화 시작...' })

  const confApi = (window as unknown as Record<string, unknown>)['confluenceAPI'] as {
    fetchPages: (c: unknown) => Promise<unknown[]>
    savePages: (vaultPath: string, folder: string, pages: unknown[]) => Promise<void>
    downloadAttachments: (c: unknown, vaultPath: string, folder: string, pageId: string) => Promise<void>
  } | undefined

  if (!confApi) {
    const msg = 'confluenceAPI unavailable (Electron only)'
    store.addLog({ action: 'error', detail: msg })
    return { ok: false, message: msg }
  }

  try {
    // 안전장치: lastSyncAt과 cfg.dateFrom 모두 없으면 최근 7일만 가져옴 (전체 페이지 가져오기 방지)
    const fallbackDate = cfg.dateFrom || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const dateFrom = toSyncDatetime(lastSyncAt, fallbackDate)
    const pages = await confApi.fetchPages({
      baseUrl: cfg.baseUrl, email: cfg.email, apiToken: cfg.apiToken,
      spaceKey: cfg.spaceKey, dateFrom, dateTo: '', authType: cfg.authType, bypassSSL: cfg.bypassSSL,
    })

    if (!pages || pages.length === 0) {
      // Jira 와 일관되게 변경 없음 케이스에서도 lastSyncAt 갱신 (다음 호출의 dateFrom 기준점)
      const nowEmpty = new Date().toISOString()
      setLastSyncAt(nowEmpty)
      store.addLog({ action: 'file_skip', detail: 'Confluence 변경 없음' })
      return { ok: true }
    }

    const pagesWithMd = (pages as unknown[]).map(page =>
      pageToVaultMarkdown({ ...(page as object), _baseUrl: cfg.baseUrl } as Parameters<typeof pageToVaultMarkdown>[0])
    )
    await confApi.savePages(vaultPath, cfg.targetFolder, pagesWithMd)

    let attachFailed = 0
    const attachCfg = { baseUrl: cfg.baseUrl, authType: cfg.authType, email: cfg.email, apiToken: cfg.apiToken, bypassSSL: cfg.bypassSSL }
    for (const page of pages as Array<{ id: string }>) {
      await confApi.downloadAttachments(attachCfg, vaultPath, cfg.targetFolder, page.id)
        .catch(() => { attachFailed++ })
    }

    store.addLog({ action: 'file_edit', detail: `Confluence ${pages.length}개 페이지 저장${attachFailed > 0 ? ` (첨부 ${attachFailed}개 실패)` : ''}` })

    await runPostSyncScripts(vaultPath, store)

    const now = new Date().toISOString()
    setLastSyncAt(now)
    setNotification({ message: `Confluence 동기화 완료 (Edit Agent)`, count: pages.length, at: now })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    store.addLog({ action: 'error', detail: `Confluence 동기화 실패: ${msg}` })
    logger.warn('[syncRunner] Confluence 실패:', msg)
    return { ok: false, message: msg }
  }
}

export async function runJiraSync(store: EditAgentState): Promise<SyncResult> {
  const { activeVaultId } = useVaultStore.getState()
  const { jiraConfigs } = useSettingsStore.getState()
  const cfg = jiraConfigs[activeVaultId] ?? jiraConfigs[MIGRATED_CONFIG_KEY as string]
  const vaultPath = useVaultStore.getState().vaultPath
  const { lastJiraSyncAt, setLastJiraSyncAt, setNotification } = useSyncStore.getState()

  if (!vaultPath || !cfg?.baseUrl || !cfg.apiToken) {
    const msg = 'Jira 설정 없음 — 설정 > Jira 확인'
    store.addLog({ action: 'error', detail: msg })
    return { ok: false, message: msg }
  }

  store.addLog({ action: 'diff_check', detail: 'Jira 동기화 시작...' })

  const jiraApi = (window as unknown as Record<string, unknown>)['jiraAPI'] as {
    fetchIssues: (c: unknown) => Promise<JiraIssue[]>
    saveIssues: (vaultPath: string, folder: string, issues: { filename: string; content: string }[]) => Promise<void>
  } | undefined

  if (!jiraApi) {
    const msg = 'jiraAPI unavailable (Electron only)'
    store.addLog({ action: 'error', detail: msg })
    return { ok: false, message: msg }
  }

  try {
    // 안전장치: lastJiraSyncAt과 cfg.dateFrom 모두 없으면 최근 7일만 가져옴 (전체 이슈 가져오기 방지)
    const fallbackDate = cfg.dateFrom || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const dateFrom = toSyncDatetime(lastJiraSyncAt, fallbackDate)
    const issues = await jiraApi.fetchIssues({
      baseUrl: cfg.baseUrl, email: cfg.email, apiToken: cfg.apiToken,
      projectKey: cfg.projectKey, jql: cfg.jql || undefined,
      dateFrom, dateTo: '', authType: cfg.authType, bypassSSL: cfg.bypassSSL,
    })

    const now = new Date().toISOString()
    if (!issues || issues.length === 0) {
      setLastJiraSyncAt(now)
      store.addLog({ action: 'file_skip', detail: 'Jira 변경 없음' })
      return { ok: true }
    }

    const converted = issues.map(issue => issueToVaultMarkdown(issue, cfg.baseUrl))
    await jiraApi.saveIssues(vaultPath, cfg.targetFolder, converted.map(p => ({ filename: p.filename, content: p.content })))

    store.addLog({ action: 'file_edit', detail: `Jira ${issues.length}개 이슈 저장` })
    setLastJiraSyncAt(now)
    setNotification({ message: `Jira 동기화 완료 (Edit Agent)`, count: issues.length, at: now })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    store.addLog({ action: 'error', detail: `Jira 동기화 실패: ${msg}` })
    logger.warn('[syncRunner] Jira 실패:', msg)
    return { ok: false, message: msg }
  }
}
