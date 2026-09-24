/**
 * useVaultLoader — Shared vault loading logic.
 *
 * Extracted so it can be used by both:
 *   - App.tsx (auto-load on startup when vaultPath is persisted)
 *   - VaultSelector.tsx (manual load/reload from settings UI)
 */

import { useCallback } from 'react'
import { PERSONA_CONFIG_PATH } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { t } from '@/i18n'
import { isEmbeddingReady } from '@/lib/vectorEmbedIndex'
import { useVaultStore } from '@/stores/vaultStore'
import { useGraphStore } from '@/stores/graphStore'
import { useBackendStore } from '@/stores/backendStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { parseVaultFilesAsync } from '@/lib/markdownParser'
import { buildGraph } from '@/lib/graphBuilder'
import { vaultDocsToChunks } from '@/lib/vaultToChunks'
import { parsePersonaConfig } from '@/lib/personaVaultConfig'
import { tfidfIndex, clearMetricsCache } from '@/lib/graphAnalysis'
import { buildAdjacencyMap } from '@/lib/graphRAG'
import { buildAndFindLinks, findLinksFromCache, extractSynonymsInWorker } from '@/lib/bm25WorkerClient'
import { addDynamicSynonym, clearDynamicSynonyms } from '@/lib/synonyms'
import { buildFingerprint, loadTfIdfCache, saveTfIdfCache } from '@/lib/tfidfCache'
import { buildDocsFingerprint, loadDocsCache, saveDocsCache } from '@/lib/docsCache'
import { vectorEmbedIndex } from '@/lib/vectorEmbedIndex'
import { buildStatsSnapshot, saveStatsSnapshot } from '@/lib/vaultStatsLog'
import type { VaultFile, LoadedDocument, GraphLink } from '@/types'

// A watcher refresh (background) may start while the previous load is still indexing;
// only the newest load may apply its deferred results.
let loadRevision = 0

// Progress bar share for the web sync phase; parsing continues from PULL_END.
const PULL_START = 2
const PULL_END = 40

// Link reveal after a load: below this many links the graph just appears whole
const PROGRESSIVE_MIN_LINKS = 200
const REVEAL_STEPS = 24
const REVEAL_INTERVAL_MS = 90

/**
 * Hand the graph its links a slice at a time so the connections form on screen. The simulation
 * swaps links in place (useGraphSimulation), so node positions carry over between slices.
 * `stillCurrent` stops the reveal when another load replaced the graph.
 */
function revealLinks(links: GraphLink[], stillCurrent: () => boolean): void {
  const order = [...links]
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
  const per = Math.ceil(order.length / REVEAL_STEPS)
  let shown = 0
  const step = () => {
    if (!stillCurrent()) return
    shown = Math.min(order.length, shown + per)
    // The last slice is the original array, so everything else sees the graph it expects
    useGraphStore.getState().setLinks(shown >= order.length ? links : order.slice(0, shown))
    if (shown < order.length) setTimeout(step, REVEAL_INTERVAL_MS)
  }
  setTimeout(step, REVEAL_INTERVAL_MS)
}

/**
 * Co-occurrence based dynamic synonym registration — runs in a worker.
 *
 * Previously `extractCoOccurrenceSynonyms(docs)` was called directly on the main thread,
 * blocked for 13 seconds and then died with `RangeError: Map maximum size exceeded`;
 * the caller's try/catch silently swallowed it, so **no synonyms were registered while
 * the full cost was still paid**. It now runs in a worker and failures are logged.
 */
async function registerDynamicSynonyms(docs: LoadedDocument[]): Promise<void> {
  const sectionTexts: string[] = []
  for (const doc of docs) {
    for (const s of doc.sections) sectionTexts.push(`${s.heading} ${s.body}`)
  }
  if (sectionTexts.length < 3) return
  const t0 = Date.now()
  const entries = await extractSynonymsInWorker(sectionTexts)
  for (const [term, synonyms] of entries) {
    for (const syn of synonyms) addDynamicSynonym(term, syn)
  }
  logger.debug(`[vault] Registered ${entries.length} dynamic synonym terms (worker ${Date.now() - t0}ms)`)
}

export function useVaultLoader() {
  const { vaultPath, setLoadedDocuments, setVaultFolders, setImagePathRegistry, clearImageDataCache, setIsLoading, setVaultReady, setLoadingProgress, setError, setPendingFileCount, cacheVaultDocs, setBgLoadingInfo } =
    useVaultStore()
  const { setGraph, resetToMock, setGraphLayoutReady } = useGraphStore()
  const { setIndexing, setChunkCount, setError: setBackendError } = useBackendStore()
  const { loadVaultPersonas, resetVaultPersonas } = useSettingsStore()

  const loadVault = useCallback(
    async (dirPath: string, background = false) => {
      const revision = ++loadRevision
      if (!window.vaultAPI) {
        setError('Not running in Electron. Vaults cannot be loaded in the browser.')
        return
      }
      if (!background) {
        setIsLoading(true)
        setVaultReady(false)
        setLoadingProgress(0, 'Initializing vault...')
      }
      setError(null)
      try {
        // ── Step 1: scanMetadata (mtime only, no file contents) → check cache fingerprint ──
        let docs = null
        let folders: string[] = []
        let imageRegistry: Record<string, { relativePath: string; absolutePath: string }> | null = null

        let files: VaultFile[] | null = null
        let parseBase = 5
        if (window.vaultAPI.loadSnapshot) {
          // Web: the overlay stays until the mirror has caught up with the server (or the server
          // is unreachable and the mirror stands in). Background refreshes read the mirror only.
          let loaded
          if (background) {
            loaded = await window.vaultAPI.loadSnapshot(dirPath)
          } else {
            setLoadingProgress(PULL_START, t('Syncing documents…'))
            const unsubscribe = window.syncAPI?.onStatus(({ status }) => {
              if (status.received === undefined) return
              const share = status.expected ? Math.min(1, status.received / status.expected) : 0
              setLoadingProgress(PULL_START + Math.round((PULL_END - PULL_START) * share), t('Syncing documents… {count} received', { count: status.received }))
            })
            try { loaded = await window.vaultAPI.loadFiles(dirPath) } finally { unsubscribe?.() }
            parseBase = PULL_END
          }
          files = loaded.files
          folders = loaded.folders
          imageRegistry = loaded.imageRegistry ?? null
          setVaultFolders(folders)
          setImagePathRegistry(imageRegistry)
          const hit = await loadDocsCache(dirPath, buildDocsFingerprint(files.map(f => ({ relativePath: f.relativePath, mtime: f.mtime ?? 0 }))))
          if (hit) docs = hit.docs
        } else if (window.vaultAPI.scanMetadata) {
          try {
            setLoadingProgress(2, 'Scanning metadata...')
            const meta = await window.vaultAPI.scanMetadata(dirPath)
            if (meta && meta.length > 0) {
              const docsFingerprint = buildDocsFingerprint(
                meta.map(m => ({ relativePath: m.relativePath, mtime: m.mtime }))
              )
              const hit = await loadDocsCache(dirPath, docsFingerprint)
              if (hit) {
                logger.debug(`[vault] Cache hit — skipping loadFiles and parsing (${hit.docs.length} docs)`)
                setLoadingProgress(90, 'Restoring from cache...')
                docs = hit.docs
                folders = hit.folders
                imageRegistry = hit.imageRegistry
                setPendingFileCount(hit.docs.length)
                setVaultFolders(folders)
                setImagePathRegistry(imageRegistry)
              }
            }
          } catch { /* scanMetadata failed → loadFiles fallback */ }
        }

        // ── Step 2: on cache miss, loadFiles (with file contents) ──────────
        if (!docs && !files) {
          const loaded = await window.vaultAPI.loadFiles(dirPath)
          files = loaded.files
          folders = loaded.folders ?? []
          imageRegistry = loaded.imageRegistry ?? null
          logger.debug(`[vault] Loaded ${files?.length ?? 0} files, ${folders.length} folders, ${Object.keys(imageRegistry ?? {}).length} images (${dirPath})`)
          setVaultFolders(folders)
          setImagePathRegistry(imageRegistry)
          setPendingFileCount(files?.length ?? 0)
          setLoadingProgress(5, 'File list loaded')

          if (!files || files.length === 0) {
            setLoadedDocuments(null)
            resetToMock()
            setIsLoading(false)
            return
          }
        }

        // ── Step 3: on cache miss, full parse ─────────────────────────────
        if (!docs) {
          const total = files!.length
          // A background refresh shows no progress: each update re-renders whatever reads the vault store
          docs = await parseVaultFilesAsync(files!, background ? undefined : (parsed) => {
            const pct = parseBase + Math.round((parsed / total) * (85 - parseBase))
            setLoadingProgress(pct, `Parsing documents... (${parsed}/${total})`)
          })
          logger.debug(`[vault] Parsed ${docs.length}/${files!.length} documents successfully`)

          // Save the cache after parsing (background, includes folders+imageRegistry)
          const metaForCache = files!.map(f => ({ relativePath: f.relativePath, mtime: f.mtime ?? 0 }))
          const fp = buildDocsFingerprint(metaForCache)
          saveDocsCache(dirPath, fp, docs, folders, imageRegistry)
            .catch((e: unknown) => logger.warn('[docsCache] Save failed:', e))
        }
        setLoadedDocuments(docs)

        // Load vault-scoped persona config (.strata-sync/personas.md)
        try {
          const configPath = `${dirPath}/${PERSONA_CONFIG_PATH}`
          const configContent = await window.vaultAPI!.readFile(configPath)
          if (configContent) {
            const config = parsePersonaConfig(configContent)
            if (config) {
              loadVaultPersonas(config)
              logger.debug('[vault] Persona settings loaded')
            } else {
              resetVaultPersonas()
            }
          } else {
            resetVaultPersonas()
          }
        } catch {
          resetVaultPersonas()
        }

        // Reset dynamic synonyms (drop previous vault data) + co-occurrence analysis for the new vault
        clearDynamicSynonyms()

        // Update graph (clear stale metrics cache from previous vault)
        clearMetricsCache()
        setLoadingProgress(95, 'Finishing...')

        // Graph build: run synchronously before finally(setVaultReady) to avoid the
        // setGraph → graphLayoutReady=false → overlay re-activation race
        let graphLinks: GraphLink[] | null = null
        try {
          const { nodes, links } = buildGraph(docs)
          logger.debug(`[vault] Graph: ${nodes.length} nodes, ${links.length} links`)
          graphLinks = links
          if (background || links.length < PROGRESSIVE_MIN_LINKS) {
            setGraph(nodes, links)
          } else {
            // Documents first, connections after: the graph visibly links itself up
            setGraph(nodes, [])
            revealLinks(links, () => revision === loadRevision && useGraphStore.getState().nodes === nodes)
          }
        } catch (e: unknown) {
          logger.warn('[vault] Graph build failed:', e instanceof Error ? e.message : String(e))
        }
        // Dismiss the overlay immediately without waiting for the D3 simulation to converge
        // (the simulation keeps running in the background and fitView is called later)
        setGraphLayoutReady(true)

        // BM25 index + follow-up work: yield UI frames via requestIdleCallback
        // BM25 build/findImplicitLinks run in a Web Worker (removes O(N²) main-thread blocking)
        const fingerprint = buildFingerprint(docs)
        const startVaultId = useVaultStore.getState().activeVaultId  // Captured: used to check whether the vault changed by the time async work completes
        const deferToIdle = () => new Promise<void>(r => {
          (window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 16)))((() => r()) as IdleRequestCallback)
        })
        setTimeout(async () => {
          if (revision !== loadRevision) return
          // BM25 index: cache hit  → restore (fast) + compute implicit links in the worker
          //             cache miss → build in the worker + compute implicit links (non-blocking main thread)
          // The full set, not the store's: links may still be arriving on screen
          const currentLinks = graphLinks ?? useGraphStore.getState().links
          const adj = buildAdjacencyMap(currentLinks)
          try {
            const cached = await loadTfIdfCache(dirPath, fingerprint)
            // If the vault changed while the async work ran, do not apply the stale result to tfidfIndex
            if (revision !== loadRevision || useVaultStore.getState().activeVaultId !== startVaultId) return
            if (cached) {
              tfidfIndex.restore(cached)
              if (cached.implicitLinks) {
                // If the cache has precomputed implicit links, skip the O(N²) recomputation entirely
                tfidfIndex.setImplicitLinks(cached.implicitLinks, adj)
              } else if (currentLinks.length > 0) {
                // Legacy cache — compute once and backfill the cache
                findLinksFromCache(cached, adj)
                  .then(links => {
                    if (revision !== loadRevision) return
                    tfidfIndex.setImplicitLinks(links, adj)
                    return saveTfIdfCache(dirPath, { ...cached, implicitLinks: links })
                  })
                  .catch((e: unknown) => logger.warn('[BM25] Implicit link computation failed:', e instanceof Error ? e.message : String(e)))
              }
            } else {
              try {
                const { serialized, implicitLinks } = await buildAndFindLinks(docs, adj, fingerprint)
                if (revision !== loadRevision || useVaultStore.getState().activeVaultId !== startVaultId) return
                tfidfIndex.restore(serialized)
                tfidfIndex.setImplicitLinks(implicitLinks, adj)
                saveTfIdfCache(dirPath, serialized)
                  .catch((e: unknown) => logger.warn('[BM25] Cache save failed:', e instanceof Error ? e.message : String(e)))
              } catch (e: unknown) {
                logger.warn('[BM25] Worker build failed, falling back to main thread:', e instanceof Error ? e.message : String(e))
                if (revision === loadRevision && useVaultStore.getState().activeVaultId === startVaultId) {
                  try { tfidfIndex.build(docs) } catch { /* silent if the rebuild also fails */ }
                }
              }
            }
          } catch (e: unknown) {
            logger.warn('[BM25] Index init failed, attempting rebuild:', e instanceof Error ? e.message : String(e))
            if (revision === loadRevision && useVaultStore.getState().activeVaultId === startVaultId) {
              try { tfidfIndex.build(docs) } catch { /* silent if the rebuild also fails */ }
            }
          }

          await deferToIdle() // Yield a UI frame after BM25 completes

          // Incremental vector embedding build (when a local embedding server or Gemini key is available)
          const geminiKey = useSettingsStore.getState().apiKeys['gemini']?.trim()
          const canEmbed = await isEmbeddingReady(geminiKey)
          if (revision === loadRevision && canEmbed && docs.length > 0 && useVaultStore.getState().activeVaultId === startVaultId) {
            vectorEmbedIndex.buildIncremental(docs, geminiKey ?? '', dirPath)
              .catch((e: unknown) => logger.warn('[vector] Embedding build failed:', e instanceof Error ? e.message : String(e)))
          }

          // Co-occurrence based dynamic synonym extraction (worker, background)
          if (revision === loadRevision && docs.length > 0 && useVaultStore.getState().activeVaultId === startVaultId) {
            registerDynamicSynonyms(docs).catch((e: unknown) =>
              logger.warn('[vault] Co-occurrence synonym extraction failed:', e instanceof Error ? e.message : String(e)))
          }
        }, 0)

        // Index into backend if available (check readiness first to avoid noisy errors)
        if (window.backendAPI && docs.length > 0) {
          try {
            const status = await window.backendAPI.getStatus()
            if (status?.ready) {
              const chunks = vaultDocsToChunks(docs)
              setIndexing(true)
              window.backendAPI
                .indexDocuments(chunks)
                .then(({ indexed }) => setChunkCount(indexed))
                .catch((err: unknown) =>
                  setBackendError(err instanceof Error ? err.message : String(err))
                )
                .finally(() => setIndexing(false))
            }
          } catch {
            // Backend not running — silently skip indexing
          }
        }
        // Images are loaded on demand (ChatInput.tsx readImage IPC fallback)
        // Skipping full pre-indexing at vault load saves memory
        clearImageDataCache()

        // Record a vault stats snapshot (background)
        if (docs && docs.length > 0) {
          const snapshot = buildStatsSnapshot(docs)
          saveStatsSnapshot(dirPath, snapshot).catch(() => {})
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'File load failed'
        logger.error('[vault] Load failed:', msg)
        setError(msg)
        if (!background) {
          setLoadedDocuments(null)
          resetToMock()
        }
      } finally {
        setLoadingProgress(100, '')
        setVaultReady(true)
        setIsLoading(false)
        setPendingFileCount(null)
      }
    },
    [setLoadedDocuments, setVaultFolders, setImagePathRegistry, clearImageDataCache,
     setIsLoading, setVaultReady, setLoadingProgress, setError, setPendingFileCount,
     setGraph, resetToMock, setIndexing, setChunkCount, setBackendError,
     loadVaultPersonas, resetVaultPersonas]
  )

  const loadVaultCached = useCallback(
    async (dirPath: string) => {
      const { activeVaultId: startVaultId, vaultDocsCache, vaultMetaCache } = useVaultStore.getState()
      const cachedDocs = startVaultId ? vaultDocsCache[startVaultId] : null
      const cachedMeta = startVaultId ? vaultMetaCache[startVaultId] : null

      if (!cachedDocs?.length) {
        // Cache miss → full load
        return loadVault(dirPath)
      }

      if (!window.vaultAPI) return
      // Update currentVaultPath up front — so usePersonaVaultSaver's vault:save-file security check passes
      try { await window.vaultAPI.setActivePath?.(dirPath) } catch { /* cache restore continues even on failure */ }
      setIsLoading(true)
      setVaultReady(false)
      setError(null)
      // Do not set pendingFileCount on cache restore → prevents re-showing the quality picker
      try {
        // Restore image registry + folders from cache (or empty defaults)
        setImagePathRegistry(cachedMeta?.imageRegistry ?? null)
        setVaultFolders(cachedMeta?.folders ?? [])

        // Persona config (quick single file read)
        try {
          const configContent = await window.vaultAPI.readFile(`${dirPath}/${PERSONA_CONFIG_PATH}`)
          if (configContent) {
            const config = parsePersonaConfig(configContent)
            config ? loadVaultPersonas(config) : resetVaultPersonas()
          } else {
            resetVaultPersonas()
          }
        } catch { resetVaultPersonas() }

        setLoadedDocuments(cachedDocs)
        clearDynamicSynonyms()
        clearMetricsCache()

        // buildGraph: deferred by one tick — avoids blocking the main thread
        await new Promise<void>(r => setTimeout(r, 0))
        if (useVaultStore.getState().activeVaultId !== startVaultId) return
        try {
          const { nodes, links } = buildGraph(cachedDocs)
          setGraph(nodes, links)
        } catch (e: unknown) {
          logger.warn('[vault] Graph build failed:', e instanceof Error ? e.message : String(e))
        }
        setGraphLayoutReady(true)

        const fingerprint = buildFingerprint(cachedDocs)
        setTimeout(async () => {
          // Abort if another vault was activated before the async callback ran (prevents a stale index)
          if (useVaultStore.getState().activeVaultId !== startVaultId) return
          const { links: currentLinks } = useGraphStore.getState()
          const adj = buildAdjacencyMap(currentLinks)
          try {
            const cached = await loadTfIdfCache(dirPath, fingerprint)
            if (useVaultStore.getState().activeVaultId !== startVaultId) return
            if (cached) {
              tfidfIndex.restore(cached)
              if (cached.implicitLinks) {
                tfidfIndex.setImplicitLinks(cached.implicitLinks, adj)
              } else if (currentLinks.length > 0) {
                findLinksFromCache(cached, adj)
                  .then(links => {
                    tfidfIndex.setImplicitLinks(links, adj)
                    return saveTfIdfCache(dirPath, { ...cached, implicitLinks: links })
                  })
                  .catch((e: unknown) => logger.warn('[BM25] Implicit link computation failed:', e instanceof Error ? e.message : String(e)))
              }
            } else {
              try {
                const { serialized, implicitLinks } = await buildAndFindLinks(cachedDocs, adj, fingerprint)
                tfidfIndex.restore(serialized)
                tfidfIndex.setImplicitLinks(implicitLinks, adj)
                saveTfIdfCache(dirPath, serialized)
                  .catch((e: unknown) => logger.warn('[BM25] Cache save failed:', e instanceof Error ? e.message : String(e)))
              } catch (e: unknown) {
                logger.warn('[BM25] Worker build failed, falling back to main thread:', e instanceof Error ? e.message : String(e))
                try { tfidfIndex.build(cachedDocs) } catch { /* silent if the rebuild also fails */ }
              }
            }
          } catch (e: unknown) {
            logger.warn('[BM25] Index init failed, attempting rebuild:', e instanceof Error ? e.message : String(e))
            try { tfidfIndex.build(cachedDocs) } catch { /* silent if the rebuild also fails */ }
          }

          if (useVaultStore.getState().activeVaultId !== startVaultId) return

          // ── Vector index reset + rebuild ─────────────────────────────────
          // Switching vaults via tabs leaves the previous vault's embeddings in place,
          // scoring the other vault's documents. Reset then rebuild incrementally, same as loadVault().
          vectorEmbedIndex.reset()
          const geminiKey = useSettingsStore.getState().apiKeys['gemini']?.trim()
          const canEmbed = await isEmbeddingReady(geminiKey)
          if (canEmbed && cachedDocs.length > 0 && useVaultStore.getState().activeVaultId === startVaultId) {
            vectorEmbedIndex.buildIncremental(cachedDocs, geminiKey ?? '', dirPath)
              .catch((e: unknown) => logger.warn('[vector] Embedding build failed:', e instanceof Error ? e.message : String(e)))
          }

          // Co-occurrence based dynamic synonym extraction (worker, background)
          if (cachedDocs.length > 0 && useVaultStore.getState().activeVaultId === startVaultId) {
            registerDynamicSynonyms(cachedDocs).catch((e: unknown) =>
              logger.warn('[vault] Co-occurrence synonym extraction failed:', e instanceof Error ? e.message : String(e)))
          }
        }, 0)

        clearImageDataCache()
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Restore failed'
        setError(msg)
        setLoadedDocuments(null)
        resetToMock()
      } finally {
        setVaultReady(true)
        setIsLoading(false)
        setPendingFileCount(null)
      }
    },
    [loadVault, setLoadedDocuments, setImagePathRegistry, setVaultFolders, clearImageDataCache,
     setIsLoading, setVaultReady, setError, setPendingFileCount,
     setGraph, setGraphLayoutReady, resetToMock, loadVaultPersonas, resetVaultPersonas]
  )

  const loadVaultBackground = useCallback(
    async (vaultId: string, dirPath: string) => {
      if (!window.vaultAPI) return
      const { vaultDocsCache } = useVaultStore.getState()
      if (vaultDocsCache[vaultId]?.length) return  // already in-memory
      try {
        // ── On docsCache hit, skip file reading and parsing entirely ───────
        if (window.vaultAPI.scanMetadata) {
          try {
            const meta = await window.vaultAPI.scanMetadata(dirPath)
            if (meta?.length) {
              const fp = buildDocsFingerprint(meta.map(m => ({ relativePath: m.relativePath, mtime: m.mtime })))
              const hit = await loadDocsCache(dirPath, fp)
              if (hit) {
                useVaultStore.getState().cacheVaultDocs(vaultId, hit.docs)
                useVaultStore.setState((s) => ({
                  vaultMetaCache: {
                    ...s.vaultMetaCache,
                    [vaultId]: { imageRegistry: hit.imageRegistry ?? null, folders: hit.folders ?? [] }
                  }
                }))
                return
              }
            }
          } catch { /* docsCache miss → fall through to loadFiles */ }
        }

        // ── Cache miss: read files + parse, then save ──────────────────────
        const { files, folders, imageRegistry } = await window.vaultAPI.loadFiles(dirPath)
        if (!files?.length) return
        const docs = await parseVaultFilesAsync(files)
        useVaultStore.getState().cacheVaultDocs(vaultId, docs)
        useVaultStore.setState((s) => ({
          vaultMetaCache: {
            ...s.vaultMetaCache,
            [vaultId]: { imageRegistry: imageRegistry ?? null, folders: folders ?? [] }
          }
        }))
        // Save so the next restart gets a cache hit
        const metaForFp = files.map(f => ({ relativePath: f.relativePath, mtime: f.mtime ?? 0 }))
        saveDocsCache(dirPath, buildDocsFingerprint(metaForFp), docs, folders ?? [], imageRegistry ?? null)
          .catch(() => { /* background save failures are silent */ })
      } catch {
        // Silent failure
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Expose cacheVaultDocs and setBgLoadingInfo via closure (used in App.tsx)
  void cacheVaultDocs
  void setBgLoadingInfo

  return { vaultPath, loadVault, loadVaultCached, loadVaultBackground }
}
