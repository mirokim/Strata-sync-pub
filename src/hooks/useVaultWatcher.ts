/**
 * useVaultWatcher — keeps the loaded vault in step with changes that happen outside the editor:
 * another app writing to the folder (Electron fs.watch), the desktop sync engine pulling a
 * teammate's edit, or the web adapter's server poll.
 *
 * One markdown file changed → parse just that file and patch documents/graph/BM25 in place.
 * Anything else (several files, deletes, unknown) → full reload. Mounted once in App so the
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
import { updateDocInWorker } from '@/lib/bm25WorkerClient'
import { buildAdjacencyMap } from '@/lib/graphRAG'
import { parseMarkdownFile } from '@/lib/markdownParser'
import { invalidateTfIdfCache } from '@/lib/tfidfCache'
import { buildGraph } from '@/lib/graphBuilder'

let suppressed = false
let suppressTimer: ReturnType<typeof setTimeout> | null = null

/** Ignore vault change events for the next 3 seconds (vault switch / reload in progress). */
export function suppressVaultWatch(ms = 3000): void {
  if (suppressTimer) clearTimeout(suppressTimer)
  suppressed = true
  suppressTimer = setTimeout(() => { suppressed = false }, ms)
}

export function useVaultWatcher(): void {
  const vaultPath = useVaultStore(s => s.vaultPath)
  const setWatchDiff = useVaultStore(s => s.setWatchDiff)
  const { loadVault } = useVaultLoader()

  useEffect(() => {
    if (!window.vaultAPI || !vaultPath) return
    return window.vaultAPI.onChanged(async ({ vaultPath: changedVaultPath, changedFile }) => {
      const currentVaultPath = useVaultStore.getState().vaultPath
      if (!currentVaultPath) return
      if (useVaultStore.getState().isLoading) return
      if (suppressed) return
      if (!useGraphStore.getState().graphLayoutReady) return

      // Only attempt incremental update when a specific changed file is identified
      if (changedFile && tfidfIndex.isBuilt && window.vaultAPI?.readFile) {
        try {
          const sep = currentVaultPath.includes('\\') ? '\\' : '/'
          const absolutePath = `${currentVaultPath}${sep}${changedFile}`
          const content = await window.vaultAPI.readFile(absolutePath)
          if (content != null) {
            const relativePath = changedFile.replace(/\\/g, '/')
            const file = { relativePath, absolutePath, content, mtime: Date.now() }
            const parsedDoc = parseMarkdownFile(file)
            const { loadedDocuments, setLoadedDocuments, setWatchDiff } = useVaultStore.getState()
            // parseMarkdownFile does not go through pushWithUniqueId, so it reverts a
            // collision-resolved id (`_2`) to the raw id. Keep the existing id when a document at the same path exists.
            const existing = loadedDocuments?.find(d => d.absolutePath === absolutePath)
            // Electron's fs.watch also fires for the editor's own save; the store already holds
            // that text, so there is nothing to update (and no "changed" banner to show).
            if (existing && existing.rawContent === content) return
            // The incremental path builds the file without server metadata: keep what the full load knew
            const updatedDoc = existing ? { ...parsedDoc, id: existing.id, ...(existing.personal ? { personal: true } : {}) } : parsedDoc

            // Diff calculation — compare with previous rawContent
            const prevDoc = loadedDocuments?.find(d => d.id === updatedDoc.id)
            if (prevDoc?.rawContent != null) {
              const prevLines = prevDoc.rawContent.split('\n')
              const newLines = content.split('\n')
              const prevSet = new Set(prevLines)
              const newSet = new Set(newLines)
              const added = newLines.filter(l => l.trim() && !prevSet.has(l)).length
              const removed = prevLines.filter(l => l.trim() && !newSet.has(l)).length
              const previewLine = newLines.find(l => l.trim() && !prevSet.has(l)) ?? ''
              setWatchDiff({
                filePath: relativePath,
                added,
                removed,
                preview: previewLine.slice(0, 80),
              })
              // Auto-close after 8 seconds
              setTimeout(() => {
                if (useVaultStore.getState().watchDiff?.filePath === relativePath) {
                  setWatchDiff(null)
                }
              }, 8000)
            }

            if (loadedDocuments) {
              // Incremental document list update
              const newDocs = loadedDocuments.map(d => d.id === updatedDoc.id ? updatedDoc : d)
              const isNew = !loadedDocuments.some(d => d.id === updatedDoc.id)
              if (isNew) newDocs.push(updatedDoc)
              setLoadedDocuments(newDocs)

              // Incremental graph update
              const { nodes: newNodes, links: newLinks } = buildGraph(newDocs)
              useGraphStore.getState().setGraph(newNodes, newLinks)

              // BM25 incremental update (worker)
              const fingerprint = String(Date.now())
              const adj = buildAdjacencyMap(newLinks)
              const { serialized, implicitLinks } = await updateDocInWorker(
                tfidfIndex.serialize(fingerprint), updatedDoc, adj, fingerprint
              )
              tfidfIndex.restore(serialized)
              tfidfIndex.setImplicitLinks(implicitLinks, adj)
              // Saving with a Date.now() fingerprint never matches loadTfIdfCache's
              // buildFingerprint(id:mtime), overwriting a valid cache and forcing a full rebuild on
              // every startup. Only invalidate, and let the next vault load rewrite it with the correct fingerprint.
              invalidateTfIdfCache(currentVaultPath).catch(() => {})
            }
            return  // Incremental update complete — full reload not needed
          }
        } catch {
          // Fallback to full reload on incremental failure
        }
      }

      loadVault(currentVaultPath)
    })
  }, [vaultPath, loadVault, setWatchDiff])
}
