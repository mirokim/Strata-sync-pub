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

/** 이미지 파일 경로 레지스트리: filename → { relativePath, absolutePath } */
export type ImagePathRegistry = Record<string, { relativePath: string; absolutePath: string }>

/** 등록된 볼트 항목 */
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
  /** Runtime: 볼트별 문서 캐시 — Slack 봇 전체 볼트 검색용 */
  vaultDocsCache: Record<string, LoadedDocument[]>
  /** Runtime: 볼트별 메타 캐시 (imageRegistry + folders) */
  vaultMetaCache: Record<string, { imageRegistry: ImagePathRegistry | null; folders: string[] }>
  /** Runtime: all known subfolder paths in the vault (relative to vault root) */
  vaultFolders: string[]
  /** Runtime: image filename → path lookup table (from vault load) */
  imagePathRegistry: ImagePathRegistry | null
  /** Runtime: 사전 인덱싱된 이미지 데이터 캐시: filename → base64 dataUrl */
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
  /** Runtime: 백그라운드 볼트 인덱싱 진행 정보 */
  bgLoadingInfo: { label: string; done: number; total: number } | null
  /** Runtime: 마지막 파일 변경 diff 정보 */
  watchDiff: { filePath: string; added: number; removed: number; preview: string } | null

  // ── Setters ────────────────────────────────────────────────────────────────
  setVaultPath: (path: string | null) => void
  setLoadedDocuments: (docs: LoadedDocument[] | null) => void
  /** Slack 봇용: 모든 볼트 문서를 병합해서 반환 */
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
  /** 볼트 문서를 캐시에 저장 (백그라운드 사전 인덱싱용) */
  cacheVaultDocs: (vaultId: string, docs: LoadedDocument[]) => void
  /** 백그라운드 인덱싱 진행 정보 설정 */
  setBgLoadingInfo: (info: { label: string; done: number; total: number } | null) => void
  /** 파일 변경 diff 설정 */
  setWatchDiff: (diff: VaultState['watchDiff']) => void

  // ── Multi-Vault ────────────────────────────────────────────────────────────
  /** 새 볼트를 등록하고 ID를 반환합니다. 자동 전환 없음. */
  addVault: (path: string, label?: string) => string
  /** 볼트를 제거합니다. 현재 활성 볼트라면 다른 볼트로 전환. */
  removeVault: (id: string) => void
  /** 활성 볼트를 전환하고 vaultPath를 업데이트합니다. */
  switchVault: (id: string) => void
  /** 볼트 라벨을 변경합니다. */
  updateVaultLabel: (id: string, label: string) => void
}

function generateVaultId(): string {
  return `vault_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
}

function labelFromPath(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

/** LRU 접근 순서 추적 배열 — 배열 끝이 가장 최근 접근 */
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
        // 문서 집합이 바뀌면 graphRAG 의 docMap/sectionMap/소문자 캐시를 명시적으로 비운다.
        // 지문 기반 자가 무효화가 있지만, 볼트 전환·에디터 저장·파일 워처 등 모든 경로를
        // 한 곳에서 확실히 커버하기 위한 것이다.
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
      name: 'rembrandt-vault',
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
