/**
 * vaultStore.ts — Phase 6 + Multi-Vault
 *
 * Stores the user's selected vault path and parsed documents.
 * Supports multiple vaults: vaults[] + activeVaultId are persisted.
 * Documents are re-loaded from the filesystem on each vault switch.
 */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { electronStorage as electronStorageAdapter } from '@/lib/electronStorage'
import type { LoadedDocument } from '@/types'
import { invalidateGraphRAGCache } from '@/lib/graphRAG'

/** Image file path registry: filename → { relativePath, absolutePath } */
export type ImagePathRegistry = Record<string, { relativePath: string; absolutePath: string }>

/** A registered vault entry */
export interface VaultEntry {
  path: string
  label: string
}

interface VaultState {
  /** Persisted: registered vault list */
  vaults: Record<string, VaultEntry>
  /** Persisted: currently active vault ID */
  activeVaultId: string
  /** Persisted: absolute path to the selected vault root (derived from vaults[activeVaultId]) */
  vaultPath: string | null
  /** Runtime: parsed documents (not persisted) */
  loadedDocuments: LoadedDocument[] | null
  /** Runtime: per-vault document cache — for Slack bot all-vault search */
  vaultDocsCache: Record<string, LoadedDocument[]>
  /** Runtime: per-vault metadata cache (imageRegistry + folders) */
  vaultMetaCache: Record<string, { imageRegistry: ImagePathRegistry | null; folders: string[] }>
  /** Runtime: all known subfolder paths in the vault (relative to vault root) */
  vaultFolders: string[]
  /** Runtime: image filename → path lookup table (from vault load) */
  imagePathRegistry: ImagePathRegistry | null
  /** Runtime: pre-indexed image data cache: filename → base64 dataUrl */
  imageDataCache: Record<string, string>
  /** Runtime: true while loading/parsing files */
  isLoading: boolean
  /** Runtime: true after the first load attempt completes (success or failure) */
  vaultReady: boolean
  /** Runtime: loading progress 0-100 */
  loadingProgress: number
  /** Runtime: human-readable loading phase description */
  loadingPhase: string
  /** Runtime: last error message, null if none */
  error: string | null
  /** Runtime: total MD file count detected at load start (null = not yet known) */
  pendingFileCount: number | null
  /** Runtime: background vault indexing progress */
  bgLoadingInfo: { label: string; done: number; total: number } | null
  /** Runtime: last file-change diff info */
  watchDiff: { filePath: string; added: number; removed: number; preview: string } | null

  // ── Setters ────────────────────────────────────────────────────────────────
  setVaultPath: (path: string | null) => void
  setLoadedDocuments: (docs: LoadedDocument[] | null) => void
  /** For the Slack bot: returns all vault documents merged */
  getAllVaultDocs: () => LoadedDocument[]
  setVaultFolders: (folders: string[]) => void
  setImagePathRegistry: (registry: ImagePathRegistry | null) => void
  addImageDataCache: (entries: Record<string, string>) => void
  touchImageCache: (key: string) => void
  clearImageDataCache: () => void
  setIsLoading: (loading: boolean) => void
  setVaultReady: (ready: boolean) => void
  setLoadingProgress: (progress: number, phase?: string) => void
  setError: (error: string | null) => void
  setPendingFileCount: (count: number | null) => void
  /** Clear vault path + documents + error */
  clearVault: () => void
  /** Store vault documents in the cache (for background pre-indexing) */
  cacheVaultDocs: (vaultId: string, docs: LoadedDocument[]) => void
  /** Set background indexing progress */
  setBgLoadingInfo: (info: { label: string; done: number; total: number } | null) => void
  /** Set the file-change diff */
  setWatchDiff: (diff: VaultState['watchDiff']) => void

  // ── Multi-Vault ────────────────────────────────────────────────────────────
  /** Registers a new vault and returns its ID. Does not switch automatically. */
  addVault: (path: string, label?: string) => string
  /** Removes a vault. If it is the active vault, switches to another one. */
  removeVault: (id: string) => void
  /** Switches the active vault and updates vaultPath. */
  switchVault: (id: string) => void
  /** Renames a vault label. */
  updateVaultLabel: (id: string, label: string) => void
}

function generateVaultId(): string {
  return `vault_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function labelFromPath(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

/** LRU access-order tracking array — the end of the array is the most recent */
let _imageAccessOrder: string[] = []

export const useVaultStore = create<VaultState>()(
  persist(
    (set, get) => ({
      vaults: {},
      activeVaultId: '',
      vaultPath: null,
      loadedDocuments: null,
      vaultDocsCache: {},
      vaultMetaCache: {},
      vaultFolders: [],
      imagePathRegistry: null,
      imageDataCache: {},
      isLoading: false,
      vaultReady: false,
      loadingProgress: 0,
      loadingPhase: '',
      error: null,
      pendingFileCount: null,
      bgLoadingInfo: null,
      watchDiff: null,

      setVaultPath: (vaultPath) => {
        // Sync vault path to mcp-config.json
        if (vaultPath) {
          window.configAPI?.writeMcp({ vaultPath })
        }
        return set((s) => {
        // Also update the active vault's path record
        if (vaultPath && s.activeVaultId && s.vaults[s.activeVaultId]) {
          return {
            vaultPath,
            vaults: {
              ...s.vaults,
              [s.activeVaultId]: {
                ...s.vaults[s.activeVaultId],
                path: vaultPath,
                label: s.vaults[s.activeVaultId].label || labelFromPath(vaultPath),
              },
            },
          }
        }
        // No active vault yet → create one
        if (vaultPath) {
          const id = s.activeVaultId || generateVaultId()
          return {
            vaultPath,
            activeVaultId: id,
            vaults: {
              ...s.vaults,
              [id]: { path: vaultPath, label: labelFromPath(vaultPath) },
            },
          }
        }
        return { vaultPath }
        })
      },

      setLoadedDocuments: (loadedDocuments) => set((s) => {
        // Explicitly clear graphRAG's docMap/sectionMap/lowercase caches whenever the document set changes.
        // Fingerprint-based self-invalidation exists, but this reliably covers every path
        // (vault switch, editor save, file watcher, ...) from a single place.
        invalidateGraphRAGCache()
        if (loadedDocuments && s.activeVaultId) {
          const label = s.vaults[s.activeVaultId]?.label ?? s.activeVaultId
          // Skip full remap if all docs already carry the correct label
          const needsStamp = loadedDocuments.some(d => d.vaultLabel !== label)
          const stamped = needsStamp
            ? loadedDocuments.map(d => d.vaultLabel === label ? d : { ...d, vaultLabel: label })
            : loadedDocuments
          return { loadedDocuments: stamped, vaultDocsCache: { ...s.vaultDocsCache, [s.activeVaultId]: stamped } }
        }
        return { loadedDocuments }
      }),
      getAllVaultDocs: () => Object.values(get().vaultDocsCache).flat(),
      setVaultFolders: (vaultFolders) => set((s) => {
        if (!s.activeVaultId) return { vaultFolders }
        const prev = s.vaultMetaCache[s.activeVaultId] ?? { imageRegistry: null, folders: [] }
        return {
          vaultFolders,
          vaultMetaCache: { ...s.vaultMetaCache, [s.activeVaultId]: { ...prev, folders: vaultFolders } }
        }
      }),
      setImagePathRegistry: (imagePathRegistry) => set((s) => {
        if (!s.activeVaultId) return { imagePathRegistry }
        const prev = s.vaultMetaCache[s.activeVaultId] ?? { imageRegistry: null, folders: [] }
        return {
          imagePathRegistry,
          vaultMetaCache: { ...s.vaultMetaCache, [s.activeVaultId]: { ...prev, imageRegistry: imagePathRegistry } }
        }
      }),
      addImageDataCache: (entries) =>
        set((s) => {
          const merged = { ...s.imageDataCache, ...entries }
          // Update LRU access order: move touched keys to end
          const newKeys = Object.keys(entries)
          const newKeySet = new Set(newKeys)
          _imageAccessOrder = _imageAccessOrder.filter(k => !newKeySet.has(k))
          // Add existing keys that aren't yet tracked
          for (const k of Object.keys(merged)) {
            if (!_imageAccessOrder.includes(k) && !newKeySet.has(k)) {
              _imageAccessOrder.push(k)
            }
          }
          // Newly added/updated entries go to the end (most recent)
          _imageAccessOrder.push(...newKeys)

          // Cap cache at ~20MB (base64 string length ≈ byte size)
          const MAX_BYTES = 20 * 1024 * 1024
          const TARGET_BYTES = MAX_BYTES * 0.75  // evict to 75% on overflow
          let totalBytes = Object.values(merged).reduce((sum, v) => sum + v.length, 0)
          if (totalBytes > MAX_BYTES) {
            // Evict from the front of _imageAccessOrder (least recently used)
            while (totalBytes > TARGET_BYTES && _imageAccessOrder.length > 1) {
              const evictKey = _imageAccessOrder.shift()!
              if (merged[evictKey]) {
                totalBytes -= merged[evictKey].length
                delete merged[evictKey]
              }
            }
          }
          return { imageDataCache: merged }
        }),
      touchImageCache: (key) => {
        const idx = _imageAccessOrder.indexOf(key)
        if (idx !== -1) {
          _imageAccessOrder.splice(idx, 1)
          _imageAccessOrder.push(key)
        }
      },
      clearImageDataCache: () => {
        _imageAccessOrder = []
        set({ imageDataCache: {} })
      },
      setIsLoading: (isLoading) => set({ isLoading }),
      setVaultReady: (vaultReady) => set({ vaultReady }),
      setLoadingProgress: (loadingProgress, loadingPhase = '') =>
        set({ loadingProgress, loadingPhase }),
      setError: (error) => set({ error }),
      setPendingFileCount: (pendingFileCount) => set({ pendingFileCount }),
      clearVault: () => {
        _imageAccessOrder = []
        set({ vaultPath: null, loadedDocuments: null, vaultFolders: [], imagePathRegistry: null, imageDataCache: {}, error: null, isLoading: false, vaultReady: false, loadingProgress: 0, loadingPhase: '', pendingFileCount: null })
      },

      cacheVaultDocs: (vaultId, docs) => set((s) => {
        const label = s.vaults[vaultId]?.label ?? vaultId
        const needsStamp = docs.some(d => d.vaultLabel !== label)
        const stamped = needsStamp
          ? docs.map(d => d.vaultLabel === label ? d : { ...d, vaultLabel: label })
          : docs
        return { vaultDocsCache: { ...s.vaultDocsCache, [vaultId]: stamped } }
      }),

      setBgLoadingInfo: (bgLoadingInfo) => set({ bgLoadingInfo }),
      setWatchDiff: (watchDiff) => set({ watchDiff }),

      // ── Multi-Vault actions ──────────────────────────────────────────────────
      addVault: (path, label) => {
        const { vaults } = get()
        // If path already exists, return that ID
        const existing = Object.entries(vaults).find(([, v]) => v.path === path)
        if (existing) return existing[0]
        if (Object.keys(vaults).length >= 8) return ''
        const id = generateVaultId()
        set((s) => ({
          vaults: { ...s.vaults, [id]: { path, label: label ?? labelFromPath(path) } },
        }))
        return id
      },

      removeVault: (id) => {
        const { vaults, activeVaultId, vaultDocsCache, vaultMetaCache } = get()
        const newVaults = { ...vaults }
        delete newVaults[id]
        // Clean up caches for the removed vault
        const newDocsCache = { ...vaultDocsCache }
        delete newDocsCache[id]
        const newMetaCache = { ...vaultMetaCache }
        delete newMetaCache[id]
        const ids = Object.keys(newVaults)
        if (id === activeVaultId && ids.length > 0) {
          const nextId = ids[0]
          set({ vaults: newVaults, activeVaultId: nextId, vaultPath: newVaults[nextId].path, vaultDocsCache: newDocsCache, vaultMetaCache: newMetaCache })
        } else if (id === activeVaultId) {
          set({ vaults: newVaults, activeVaultId: '', vaultPath: null, vaultDocsCache: newDocsCache, vaultMetaCache: newMetaCache })
        } else {
          set({ vaults: newVaults, vaultDocsCache: newDocsCache, vaultMetaCache: newMetaCache })
        }
      },

      switchVault: (id) => {
        const { vaults, clearImageDataCache } = get()
        const entry = vaults[id]
        if (!entry) return
        // Sync vault path to mcp-config.json
        window.configAPI?.writeMcp({ vaultPath: entry.path })
        // Release image data from previous vault to prevent memory leak
        clearImageDataCache()
        set({ activeVaultId: id, vaultPath: entry.path, loadedDocuments: null, vaultFolders: [], imagePathRegistry: null })
      },

      updateVaultLabel: (id, label) => {
        set((s) => ({
          vaults: s.vaults[id]
            ? { ...s.vaults, [id]: { ...s.vaults[id], label } }
            : s.vaults,
        }))
      },
    }),
    {
      name: 'strata-sync-vault',
      storage: createJSONStorage(() => electronStorageAdapter),
      // Persist vaultPath, vaults, activeVaultId
      partialize: (state) => ({
        vaultPath: state.vaultPath,
        vaults: state.vaults,
        activeVaultId: state.activeVaultId,
      }),
      // Migration: old state had only vaultPath, no vaults
      merge: (persisted: any, current) => {
        const merged = { ...current, ...persisted }
        // If old state: vaultPath exists but vaults is empty → create default entry
        if (merged.vaultPath && (!merged.vaults || Object.keys(merged.vaults).length === 0)) {
          const id = merged.activeVaultId || generateVaultId()
          merged.vaults = { [id]: { path: merged.vaultPath, label: labelFromPath(merged.vaultPath) } }
          merged.activeVaultId = id
        }
        return merged
      },
    }
  )
)
