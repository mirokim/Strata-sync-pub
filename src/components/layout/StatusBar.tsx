/**
 * Bottom status bar — where the vault lives and who you are to it: the team server, the sync
 * state and the author name (web), or the vault folder (desktop).
 */
import { useEffect, useState } from 'react'
import { Cloud, CloudOff, FolderOpen } from 'lucide-react'
import { useVaultStore } from '@/stores/vaultStore'
import { t, useT } from '@/i18n'

function relative(ms: number | null): string {
  if (!ms) return t('never')
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 5) return t('just now')
  if (s < 60) return t('{s}s ago', { s })
  const m = Math.floor(s / 60)
  return m < 60 ? t('{m}m ago', { m }) : t('{h}h ago', { h: Math.floor(m / 60) })
}

export default function StatusBar() {
  const t = useT()
  const vaultPath = useVaultStore(s => s.vaultPath)
  const [sync, setSync] = useState<TeamSyncState | null>(null)

  useEffect(() => {
    const api = window.syncAPI
    if (!api) return
    let cancelled = false
    api.getState().then(s => { if (!cancelled) setSync(s) }).catch(() => {})
    const off = api.onStatus(s => setSync(s))
    return () => { cancelled = true; off() }
  }, [])

  const remote = sync?.config.enabled ? sync : null
  const host = remote ? remote.config.url.replace(/^https?:\/\//, '') : null

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px',
      background: 'var(--color-bg-secondary)', borderTop: '1px solid var(--color-border)',
      fontSize: 11, color: 'var(--color-text-muted)', userSelect: 'none', height: 26, flexShrink: 0,
    }} data-testid="status-bar">
      {remote ? (
        <>
          {remote.status.lastError ? <CloudOff size={11} color="var(--color-error)" /> : <Cloud size={11} color="var(--color-accent)" />}
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={remote.config.url}>{host}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{remote.status.inFlight ? t('syncing…') : remote.status.lastError ? remote.status.lastError : t('synced {time}', { time: relative(remote.status.lastSyncAt) })}</span>
          {remote.config.author && (<><span style={{ opacity: 0.4 }}>·</span><span>{remote.config.author}</span></>)}
        </>
      ) : vaultPath ? (
        <>
          <FolderOpen size={11} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={vaultPath}>{vaultPath}</span>
        </>
      ) : null}
      <div style={{ flex: 1 }} />
    </div>
  )
}
