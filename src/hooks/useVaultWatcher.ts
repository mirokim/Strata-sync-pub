/**
 * useVaultWatcher — keeps the loaded vault in step with changes that happen outside the editor:
 * another app writing to the folder (Electron fs.watch), the desktop sync engine pulling a
 * teammate's edit, or the web adapter's server poll.
 *
 * Known markdown files changed or deleted → parse just those and patch documents/graph/BM25 in
 * place (desktop: the one `changedFile`; web: the `changedFiles`/`removedFiles` a pull reports).
 * Anything else (images, bulk imports, unknown) → full reload. Mounted once in App so the
 * subscription lives as long as the app, not as long as a settings tab.
 *
 * `suppressVaultWatch()` mutes events for a few seconds around vault switches, whose own
 * writes/reads would otherwise be mistaken for foreign changes.
 */
import { useEffect } from 'react'
import { useVaultStore } from '@/stores/vaultStore'
import { useGraphStore } from '@/stores/graphStore'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import { tfidfIndex } from '@/lib/graphAnalysis'
import { updateDocsInWorker } from '@/lib/bm25WorkerClient'
import { buildAdjacencyMap } from '@/lib/graphRAG'
import { parseMarkdownFile } from '@/lib/markdownParser'
import { invalidateTfIdfCache } from '@/lib/tfidfCache'
import { buildGraph } from '@/lib/graphBuilder'
import type { GraphNode, LoadedDocument } from '@/types'

let suppressed = false
let suppressTimer: ReturnType<typeof setTimeout> | null = null

/** Ignore vault change events for the next 3 seconds (vault switch / reload in progress). */
export function suppressVaultWatch(ms = 3000): void {
  if (suppressTimer) clearTimeout(suppressTimer)
  suppressed = true
  suppressTimer = setTimeout(() => { suppressed = false }, ms)
}

/** Same node ids and labels → the simulation can keep its layout and only swap links. */
function sameNodes(a: GraphNode[], b: GraphNode[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].id !== b[i].id || a[i].label !== b[i].label) return false
  return true
}

/** "N lines added / removed" banner for a single edited document. */
function showDiff(relativePath: string, before: string, after: string): void {
  const prevLines = before.split('\n')
  const newLines = after.split('\n')
  const prevSet = new Set(prevLines)
  const newSet = new Set(newLines)
  const { setWatchDiff } = useVaultStore.getState()
  setWatchDiff({
    filePath: relativePath,
    added: newLines.filter(l => l.trim() && !prevSet.has(l)).length,
    removed: prevLines.filter(l => l.trim() && !newSet.has(l)).length,
    preview: (newLines.find(l => l.trim() && !prevSet.has(l)) ?? '').slice(0, 80),
  })
  // Auto-close after 8 seconds
  setTimeout(() => {
    if (useVaultStore.getState().watchDiff?.filePath === relativePath) setWatchDiff(null)
  }, 8000)
}

/**
 * Patch the loaded vault with these changed and removed files (vault-relative paths). Returns
 * false when it cannot (no index yet, an id collision, a read failure) — the caller reloads.
 */
export async function applyIncrementalChanges(vaultPath: string, changed: string[], removed: string[]): Promise<boolean> {
  const api = window.vaultAPI
  const { loadedDocuments, setLoadedDocuments } = useVaultStore.getState()
  if (!api?.readFile || !loadedDocuments || !tfidfIndex.isBuilt) return false
  const sep = vaultPath.includes('\\') ? '\\' : '/'
  const absOf = (rel: string) => `${vaultPath}${sep}${rel.replace(/[/\\]/g, sep)}`
  const byPath = new Map(loadedDocuments.map(d => [d.absolutePath, d]))
  const byId = new Map(loadedDocuments.map(d => [d.id, d]))

  const updated: LoadedDocument[] = []
  for (const rel of changed) {
    const absolutePath = absOf(rel)
    const content = await api.readFile(absolutePath)
    if (content == null) return false
    const existing = byPath.get(absolutePath)
    // A personal document written from outside the app (MCP) is new here, so the store cannot
    // say whether it is personal: the vault knows. Without that answer keep what the full load knew.
    const personal = api.isPersonal?.(absolutePath) ?? existing?.personal ?? false
    // Electron's fs.watch also fires for the editor's own save; the store already holds that text
    if (existing && existing.rawContent === content && !!existing.personal === personal) continue
    const relativePath = rel.replace(/\\/g, '/')
    const parsed = parseMarkdownFile({ relativePath, absolutePath, content, mtime: Date.now(), ...(personal ? { personal: true } : {}) })
    // parseMarkdownFile skips pushWithUniqueId: keep the existing id (it may be collision-resolved),
    // and leave a new document whose id another file already has to the full load's resolver
    if (!existing && byId.has(parsed.id)) return false
    updated.push(existing ? { ...parsed, id: existing.id } : parsed)
    if (changed.length === 1 && existing?.rawContent != null && existing.rawContent !== content) showDiff(relativePath, existing.rawContent, content)
  }
  const removedIds = removed.map(rel => byPath.get(absOf(rel))?.id).filter((id): id is string => Boolean(id))
  if (updated.length === 0 && removedIds.length === 0) return true

  const gone = new Set(removedIds)
  const replaced = new Map(updated.map(d => [d.id, d]))
  const newDocs = loadedDocuments.filter(d => !gone.has(d.id)).map(d => replaced.get(d.id) ?? d)
  for (const d of updated) if (!byId.has(d.id)) newDocs.push(d)
  setLoadedDocuments(newDocs)

  // Graph: an edit that keeps the node set only swaps links, so the layout stays where it is.
  // setGraph clears graphLayoutReady and only a mounted graph view sets it back — in the editor
  // nothing would, and every later change would be dropped by the watcher's guard.
  const graph = useGraphStore.getState()
  const { nodes, links } = buildGraph(newDocs)
  if (sameNodes(graph.nodes, nodes)) graph.setLinks(links)
  else { graph.setGraph(nodes, links); graph.setGraphLayoutReady(true) }

  // BM25: one worker round trip for the whole batch
  const fingerprint = String(Date.now())
  const adj = buildAdjacencyMap(links)
  const { serialized, implicitLinks } = await updateDocsInWorker(tfidfIndex.serialize(fingerprint), updated, removedIds, adj, fingerprint)
  tfidfIndex.restore(serialized)
  tfidfIndex.setImplicitLinks(implicitLinks, adj)
  // Saving with a Date.now() fingerprint never matches loadTfIdfCache's buildFingerprint(id:mtime),
  // overwriting a valid cache and forcing a full rebuild on every startup. Only invalidate, and
  // let the next vault load rewrite it with the correct fingerprint.
  invalidateTfIdfCache(vaultPath).catch(() => {})
  return true
}

export function useVaultWatcher(): void {
  const vaultPath = useVaultStore(s => s.vaultPath)
  const setWatchDiff = useVaultStore(s => s.setWatchDiff)
  const { loadVault } = useVaultLoader()

  useEffect(() => {
    if (!window.vaultAPI || !vaultPath) return
    // Web: changes arriving while one refresh runs are merged and applied after it
    let refreshing = false
    let pendingFull = false
    const pendingChanged = new Set<string>()
    const pendingRemoved = new Set<string>()

    return window.vaultAPI.onChanged(async ({ vaultPath: changedVaultPath, changedFile, changedFiles, removedFiles }) => {
      const currentVaultPath = useVaultStore.getState().vaultPath
      if (!currentVaultPath) return
      if (changedVaultPath !== currentVaultPath) return
      if (useVaultStore.getState().isLoading) return
      if (suppressed) return
      if (!useGraphStore.getState().graphLayoutReady) return

      // A web sync already updated the mirror: patch the listed documents, or refresh from the
      // snapshot — never another network pull or the loading overlay
      if (window.vaultAPI?.loadSnapshot) {
        if (changedFiles && removedFiles) {
          for (const p of changedFiles) { pendingRemoved.delete(p); pendingChanged.add(p) }
          for (const p of removedFiles) { pendingChanged.delete(p); pendingRemoved.add(p) }
        } else {
          pendingFull = true
        }
        if (refreshing) return
        refreshing = true
        try {
          while ((pendingFull || pendingChanged.size || pendingRemoved.size) && useVaultStore.getState().vaultPath === currentVaultPath) {
            const full = pendingFull
            const changed = [...pendingChanged]
            const removed = [...pendingRemoved]
            pendingFull = false; pendingChanged.clear(); pendingRemoved.clear()
            const patched = !full && await applyIncrementalChanges(currentVaultPath, changed, removed).catch(() => false)
            if (!patched) await loadVault(currentVaultPath, true)
          }
        } finally { refreshing = false }
        return
      }

      // Desktop: one identified file is patched in place; anything else reloads
      if (changedFile && await applyIncrementalChanges(currentVaultPath, [changedFile], []).catch(() => false)) return
      void loadVault(currentVaultPath)
    })
  }, [vaultPath, loadVault, setWatchDiff])
}
