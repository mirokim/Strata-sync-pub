/**
 * syncRunner.ts — Confluence / Jira sync logic
 *
 * Pure functions extracted from the useConfluenceAutoSync / useJiraAutoSync hooks.
 * Called from the Edit Agent wake cycle; runs as plain async functions rather than hooks.
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
 * Run check_quality.py and surface key metrics to EditAgentLog.
 * Extracts only WARN items and the total issue count for brevity.
 */
export async function runQualityCheck(vaultPath: string, store: EditAgentState): Promise<void> {
  const api = getScriptAPI()
  if (typeof api?.runScript !== 'function') return
  try {
    const r = await api.runScript('check_quality.py', [vaultPath, '--vault', vaultPath])
    if (!r?.stdout) return
    const lines = r.stdout.split('\n')
    // Total issue count (last summary line)
    const summaryLine = lines.find(l => l.includes('수정 권장 이슈'))
    if (summaryLine) store.addLog({ action: 'diff_check', detail: `📊 Quality: ${summaryLine.trim()}` })
    // Extract only WARN items (max 5)
    const warnLines = lines.filter(l => l.startsWith('[WARN]')).slice(0, 5)
    for (const w of warnLines) {
      store.addLog({ action: 'error', detail: w.trim() })
    }
  } catch (e) {
    logger.warn('[syncRunner] check_quality failed:', e)
  }
}

/** Whether the sync call succeeded, plus a message on failure */
export type SyncResult = { ok: boolean; message?: string }

export async function runConfluenceSync(store: EditAgentState): Promise<SyncResult> {
  const { activeVaultId } = useVaultStore.getState()
  const { confluenceConfigs } = useSettingsStore.getState()
  const cfg = confluenceConfigs[activeVaultId] ?? confluenceConfigs[MIGRATED_CONFIG_KEY]
  const vaultPath = useVaultStore.getState().vaultPath
  const { lastSyncAt, setLastSyncAt, setNotification } = useSyncStore.getState()

  if (!vaultPath || !cfg?.baseUrl || !cfg.apiToken) {
    const msg = 'Confluence not configured — check Settings > Confluence'
    store.addLog({ action: 'error', detail: msg })
    return { ok: false, message: msg }
  }

  store.addLog({ action: 'diff_check', detail: 'Starting Confluence sync...' })

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
    // Safety: if neither lastSyncAt nor cfg.dateFrom is set, fetch only the last 7 days (prevents fetching every page)
    const fallbackDate = cfg.dateFrom || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const dateFrom = toSyncDatetime(lastSyncAt, fallbackDate)
    const pages = await confApi.fetchPages({
      baseUrl: cfg.baseUrl, email: cfg.email, apiToken: cfg.apiToken,
      spaceKey: cfg.spaceKey, dateFrom, dateTo: '', authType: cfg.authType, bypassSSL: cfg.bypassSSL,
    })

    if (!pages || pages.length === 0) {
      // Consistent with Jira: update lastSyncAt even when nothing changed (baseline dateFrom for the next call)
      const nowEmpty = new Date().toISOString()
      setLastSyncAt(nowEmpty)
      store.addLog({ action: 'file_skip', detail: 'Confluence: no changes' })
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

    store.addLog({ action: 'file_edit', detail: `Confluence: saved ${pages.length} pages${attachFailed > 0 ? ` (${attachFailed} attachments failed)` : ''}` })

    await runPostSyncScripts(vaultPath, store)

    const now = new Date().toISOString()
    setLastSyncAt(now)
    setNotification({ message: `Confluence sync complete (Edit Agent)`, count: pages.length, at: now })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    store.addLog({ action: 'error', detail: `Confluence sync failed: ${msg}` })
    logger.warn('[syncRunner] Confluence failed:', msg)
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
    const msg = 'Jira not configured — check Settings > Jira'
    store.addLog({ action: 'error', detail: msg })
    return { ok: false, message: msg }
  }

  store.addLog({ action: 'diff_check', detail: 'Starting Jira sync...' })

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
    // Safety: if neither lastJiraSyncAt nor cfg.dateFrom is set, fetch only the last 7 days (prevents fetching every issue)
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
      store.addLog({ action: 'file_skip', detail: 'Jira: no changes' })
      return { ok: true }
    }

    const converted = issues.map(issue => issueToVaultMarkdown(issue, cfg.baseUrl))
    await jiraApi.saveIssues(vaultPath, cfg.targetFolder, converted.map(p => ({ filename: p.filename, content: p.content })))

    store.addLog({ action: 'file_edit', detail: `Jira: saved ${issues.length} issues` })
    setLastJiraSyncAt(now)
    setNotification({ message: `Jira sync complete (Edit Agent)`, count: issues.length, at: now })
    return { ok: true }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    store.addLog({ action: 'error', detail: `Jira sync failed: ${msg}` })
    logger.warn('[syncRunner] Jira failed:', msg)
    return { ok: false, message: msg }
  }
}
