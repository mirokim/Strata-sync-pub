/**
 * VaultSelector.tsx — Multi-vault manager
 *
 * Settings panel section for multi-vault management:
 * - Lists all registered vaults with doc counts
 * - Switch active vault, reload, remove
 * - Add new vault (max 8)
 * (change watching lives in useVaultWatcher, mounted in App)
 */

import { useCallback } from 'react'
import { FolderOpen, RefreshCw, X, Loader2, AlertCircle, Plus } from 'lucide-react'
import { useVaultStore } from '@/stores/vaultStore'
import { useGraphStore } from '@/stores/graphStore'
import { useBackendStore } from '@/stores/backendStore'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import { suppressVaultWatch } from '@/hooks/useVaultWatcher'
import { isWebMode } from '@/web/config'

export default function VaultSelector() {
  const {
    vaults, activeVaultId, vaultPath, loadedDocuments,
    isLoading, error, vaultDocsCache,
    addVault, removeVault, switchVault, clearVault,
  } = useVaultStore()
  const { isIndexing, chunkCount } = useBackendStore()
  const { loadVault, loadVaultCached } = useVaultLoader()

  const suppressWatch = suppressVaultWatch


  // Adding/switching vaults needs a folder picker; the web build is bound to one team server
  const isElectron   = Boolean(window.vaultAPI) && !isWebMode()
  const vaultEntries = Object.entries(vaults)

  // ── Add new vault ──────────────────────────────────────────────────────────

  const handleAdd = useCallback(async () => {
    if (!window.vaultAPI) return
    if (vaultEntries.length >= 8) return
    const selected = await window.vaultAPI.selectFolder()
    if (!selected) return
    const id = addVault(selected)
    if (!id) return
    switchVault(id)
    window.vaultAPI.watchStop()
    suppressWatch()
    await loadVault(selected)
    suppressWatch()
    await window.vaultAPI.watchStart(selected)
  }, [vaultEntries.length, addVault, switchVault, loadVault, suppressWatch])

  // ── Switch to a vault ──────────────────────────────────────────────────────

  const handleSwitch = useCallback(async (id: string) => {
    if (id === activeVaultId) return
    const entry = vaults[id]
    if (!entry?.path) return
    switchVault(id)
    window.vaultAPI?.watchStop()
    suppressWatch()
    await loadVaultCached(entry.path)
    suppressWatch()
    await window.vaultAPI?.watchStart(entry.path)
  }, [activeVaultId, vaults, switchVault, loadVaultCached, suppressWatch])

  // ── Reload active vault ────────────────────────────────────────────────────

  const handleReload = useCallback(async () => {
    if (!vaultPath) return
    suppressWatch()
    await loadVault(vaultPath)
  }, [vaultPath, loadVault, suppressWatch])

  // ── Remove a vault ─────────────────────────────────────────────────────────

  const handleRemove = useCallback(async (id: string) => {
    if (id === activeVaultId) {
      const otherId = Object.keys(vaults).find(k => k !== id)
      if (otherId) {
        switchVault(otherId)
        const entry = vaults[otherId]
        if (entry?.path) {
          window.vaultAPI?.watchStop()
          suppressWatch()
          await loadVaultCached(entry.path)
          await window.vaultAPI?.watchStart(entry.path)
        }
      } else {
        window.vaultAPI?.watchStop()
        clearVault()
        useGraphStore.getState().resetToMock?.()
        if (window.backendAPI) window.backendAPI.clearIndex().catch(() => {})
      }
    }
    removeVault(id)
  }, [activeVaultId, vaults, switchVault, removeVault, clearVault, loadVaultCached, suppressWatch])

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div data-testid="vault-selector">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <p
          className="text-[11px] font-semibold tracking-widest"
          style={{ color: 'var(--color-text-muted)' }}
        >
          VAULT ({vaultEntries.length}/8)
        </p>

        {isElectron && vaultEntries.length < 8 && (
          <button
            onClick={handleAdd}
            disabled={isLoading}
            className="flex items-center gap-1 text-[12px] px-2.5 py-1 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
            style={{
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
              opacity: isLoading ? 0.4 : 1,
            }}
            title="Add new vault"
          >
            <Plus size={11} />
            Add Vault
          </button>
        )}
      </div>

      {!isElectron && (
        <p className="text-xs mb-3 px-2 py-1.5 rounded" style={{
          color: 'var(--color-warning)',
          background: 'rgba(245,158,11,0.08)',
          border: '1px solid rgba(245,158,11,0.2)',
        }}>
          {isWebMode() ? 'This browser is connected to the team vault. Change the server in Settings → Server.' : 'Vault selection is only available in the Electron app.'}
        </p>
      )}

      {/* Vault list */}
      {vaultEntries.length === 0 ? (
        <div
          className="text-[13px] px-3 py-4 rounded text-center"
          style={{
            color: 'var(--color-text-muted)',
            border: '1px dashed var(--color-border)',
          }}
        >
          No vaults registered.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {vaultEntries.map(([id, entry]) => {
            const isActive  = id === activeVaultId
            const cachedDocs = vaultDocsCache[id]
            const docCount  = isActive
              ? (loadedDocuments?.length ?? cachedDocs?.length ?? 0)
              : (cachedDocs?.length ?? 0)
            const label = entry.label || entry.path.split(/[/\\]/).pop() || id

            return (
              <div
                key={id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '9px 12px', borderRadius: 6,
                  background: isActive ? 'var(--color-bg-surface)' : 'transparent',
                  border: `1px solid ${isActive ? 'var(--color-accent)' : 'var(--color-border)'}`,
                  cursor: isActive ? 'default' : 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onClick={() => !isActive && handleSwitch(id)}
              >
                {/* Active indicator */}
                <div style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                  background: isActive ? 'var(--color-accent)' : 'var(--color-border)',
                }} />

                {/* Label + path */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 12, fontWeight: isActive ? 600 : 400,
                    color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {label}
                  </div>
                  <div style={{
                    fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    fontFamily: 'monospace',
                  }}>
                    {entry.path}
                  </div>
                </div>

                {/* Doc count */}
                <div style={{
                  fontSize: 11, color: 'var(--color-text-muted)',
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}>
                  {docCount > 0 ? `${docCount} docs` : '–'}
                  {isActive && isIndexing && ' · Indexing...'}
                  {isActive && !isLoading && chunkCount > 0 && ` · ${chunkCount} chunks`}
                </div>

                {/* Actions */}
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {isActive && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleReload() }}
                      disabled={isLoading}
                      className="flex items-center justify-center w-6 h-6 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
                      style={{
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text-muted)',
                        opacity: isLoading ? 0.4 : 1,
                      }}
                      title="Refresh"
                    >
                      {isLoading
                        ? <Loader2 size={10} className="animate-spin" />
                        : <RefreshCw size={10} />
                      }
                    </button>
                  )}
                  {!isActive && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleSwitch(id) }}
                      disabled={isLoading}
                      className="text-[11px] px-2 py-0.5 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
                      style={{
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text-muted)',
                        opacity: isLoading ? 0.4 : 1,
                      }}
                      title="Switch to this vault"
                    >
                      Switch
                    </button>
                  )}
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRemove(id) }}
                    disabled={isLoading}
                    className="flex items-center justify-center w-6 h-6 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
                    style={{
                      border: '1px solid var(--color-border)',
                      color: 'var(--color-text-muted)',
                      opacity: isLoading ? 0.4 : 1,
                    }}
                    title="Remove vault"
                  >
                    <X size={10} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Active vault error */}
      {error && (
        <p
          className="text-xs flex items-center gap-1 mt-2"
          style={{ color: 'var(--color-error)' }}
          data-testid="vault-error"
        >
          <AlertCircle size={10} />
          {error}
        </p>
      )}

      {/* Non-Electron: add vault placeholder */}
      {isElectron && vaultEntries.length === 0 && (
        <button
          onClick={handleAdd}
          disabled={isLoading}
          className="flex items-center gap-1.5 text-[13px] px-3 py-2 rounded mt-3 transition-colors hover:bg-[var(--color-bg-hover)]"
          style={{
            border: '1px dashed var(--color-border)',
            color: 'var(--color-text-muted)',
            width: '100%', justifyContent: 'center',
          }}
          data-testid="vault-select-btn"
        >
          <FolderOpen size={12} />
          Select Vault Folder
        </button>
      )}
    </div>
  )
}
