/**
 * VaultTabs — TopBar 중앙에 표시되는 멀티볼트 탭 컴포넌트
 *
 * 등록된 볼트들을 탭으로 보여주고:
 * - 클릭 → 볼트 전환 (switchVault + loadVault)
 * - + 버튼 → 새 볼트 추가 (폴더 선택)
 * - × 버튼 → 볼트 제거
 */

import { useCallback } from 'react'
import { Plus, X } from 'lucide-react'
import { useVaultStore } from '@/stores/vaultStore'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import { useGraphStore } from '@/stores/graphStore'

export default function VaultTabs() {
  const { vaults, activeVaultId, switchVault, addVault, removeVault } = useVaultStore()
  const { loadVault, loadVaultCached } = useVaultLoader()

  const isElectron = Boolean(typeof window !== 'undefined' && window.vaultAPI)
  const vaultEntries = Object.entries(vaults)

  const handleSwitch = useCallback(async (id: string) => {
    if (id === activeVaultId) return
    switchVault(id)
    const entry = vaults[id]
    if (entry?.path) {
      window.vaultAPI?.watchStop()
      await loadVaultCached(entry.path)
      await window.vaultAPI?.watchStart(entry.path)
    }
  }, [activeVaultId, vaults, switchVault, loadVaultCached])

  const handleAdd = useCallback(async () => {
    if (!window.vaultAPI) return
    if (vaultEntries.length >= 8) return
    const selected = await window.vaultAPI.selectFolder()
    if (!selected) return
    const id = addVault(selected)
    if (!id) return
    switchVault(id)
    window.vaultAPI.watchStop()
    await loadVault(selected)
    await window.vaultAPI.watchStart(selected)
  }, [vaultEntries.length, addVault, switchVault, loadVault])

  const handleRemove = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    if (id === activeVaultId) {
      // 다른 볼트로 전환 후 로드
      const otherId = Object.keys(vaults).find(k => k !== id)
      if (otherId) {
        switchVault(otherId)
        const entry = vaults[otherId]
        if (entry?.path) {
          window.vaultAPI?.watchStop()
          loadVaultCached(entry.path)
          .then(() => window.vaultAPI?.watchStart(entry.path))
          .catch((err: unknown) => console.warn('[VaultTabs] 볼트 로드 실패:', err))
        }
      } else {
        window.vaultAPI?.watchStop()
        useVaultStore.getState().clearVault()
        useGraphStore.getState().resetToMock?.()
      }
    }
    removeVault(id)
  }, [activeVaultId, vaults, switchVault, removeVault, loadVaultCached])

  // 볼트가 1개 이하면 탭 UI 숨김 (TopBar 공간 절약)
  if (vaultEntries.length <= 1 && !isElectron) return null

  return (
    <div
      className="flex items-center gap-0.5 h-full px-2 overflow-x-auto"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {vaultEntries.map(([id, entry]) => {
        const isActive = id === activeVaultId
        const label = entry.label || entry.path.split(/[/\\]/).pop() || id
        return (
          <button
            key={id}
            onClick={() => handleSwitch(id)}
            className="group flex items-center gap-1 px-2.5 py-1 rounded text-xs transition-colors shrink-0"
            style={{
              background: isActive ? 'var(--color-bg-surface)' : 'transparent',
              color: isActive ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
              border: isActive ? '1px solid var(--color-border)' : '1px solid transparent',
              maxWidth: 120,
              fontWeight: isActive ? 600 : 400,
            }}
            title={entry.path}
          >
            <span
              style={{
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                maxWidth: vaultEntries.length > 2 ? 60 : 90,
              }}
            >
              {label}
            </span>
            {vaultEntries.length > 1 && (
              <span
                onClick={(e) => handleRemove(e, id)}
                className="opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity cursor-pointer"
                style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}
                title="볼트 제거"
              >
                <X size={9} />
              </span>
            )}
          </button>
        )
      })}

      {/* 새 볼트 추가 */}
      {isElectron && vaultEntries.length < 8 && (
        <button
          onClick={handleAdd}
          className="flex items-center justify-center w-6 h-6 rounded transition-colors hover:bg-[var(--color-bg-hover)] shrink-0"
          style={{ color: 'var(--color-text-muted)' }}
          title="볼트 추가"
        >
          <Plus size={11} />
        </button>
      )}
    </div>
  )
}
