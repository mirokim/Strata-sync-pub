/**
 * ServerTab — web build only: which Strata Sync server this browser is connected to, sync
 * status, conflicts, your author name, and disconnect. Mirrors the desktop Team Sync tab but
 * talks to the in-browser remote vault adapter (window.syncAPI shim).
 */
import { useEffect, useState } from 'react'
import { Cloud, RefreshCw, AlertTriangle, GitBranch, LogOut, Terminal } from 'lucide-react'
import { fieldInputStyle } from '../settingsShared'
import { clearWebConfig, loadWebConfig } from '@/web/config'
import { currentRemoteVault } from '@/web/remoteVault'

type SyncState = NonNullable<Window['syncAPI']> extends { getState(): Promise<infer S> } ? S : never

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
  color: 'var(--color-text-muted)', marginBottom: 10,
}
const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12, padding: 14, borderRadius: 2,
  background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)',
}
const label: React.CSSProperties = { fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4, lineHeight: 1.5 }
const button: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 2, fontSize: 12, fontWeight: 500,
  border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer',
}

function relative(ms: number | null): string {
  if (!ms) return 'never'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

export default function ServerTab() {
  const api = window.syncAPI
  const [state, setState] = useState<SyncState | null>(null)
  const [author, setAuthor] = useState('')
  const [busy, setBusy] = useState<'save' | 'sync' | null>(null)

  useEffect(() => {
    if (!api) return
    let cancelled = false
    api.getState().then(s => { if (!cancelled) { setState(s); setAuthor(s.config.author) } })
    const off = api.onStatus(s => setState(s))
    return () => { cancelled = true; off() }
  }, [api])

  if (!api) {
    return <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>Not connected to a server.</div>
  }

  const status = state?.status
  const url = state?.config.url ?? loadWebConfig()?.url ?? ''
  const mcpCommand = `claude mcp add --transport http strata ${url}/mcp --header "Authorization: Bearer <team token>"`

  const saveAuthor = async () => {
    setBusy('save')
    try { setState(await api.updateConfig({ author: author.trim() })) } finally { setBusy(null) }
  }
  const syncNow = async () => {
    setBusy('sync')
    try { setState(await api.syncNow()) } finally { setBusy(null) }
  }
  const disconnect = async () => {
    if (!window.confirm('Disconnect from this server? The local copy of the vault in this browser is removed; nothing on the server changes.')) return
    await currentRemoteVault()?.cache.reset()
    clearWebConfig()
    window.location.reload()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
        <Cloud size={16} color="var(--color-accent)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-accent)' }} data-testid="server-status-title">
            {status?.inFlight ? 'Syncing…' : status?.lastError ? 'Sync error' : `Connected · last ${relative(status?.lastSyncAt ?? null)}`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {url}{status ? ` · seq ${status.lastSeq}` : ''}
          </div>
          {status?.lastError && <div style={{ fontSize: 11, color: 'var(--color-error)', marginTop: 4 }}>{status.lastError}</div>}
        </div>
        <button onClick={syncNow} disabled={busy !== null} data-testid="server-sync-now" style={{ ...button, opacity: busy ? 0.5 : 1 }}>
          <RefreshCw size={11} className={busy === 'sync' || status?.inFlight ? 'animate-spin' : ''} /> Sync now
        </button>
      </div>

      <div>
        <div style={sectionLabel}>You</div>
        <div style={card}>
          <div>
            <label style={label}>Author name</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={author} onChange={e => setAuthor(e.target.value)} placeholder="shown on your edits and conflict copies" style={fieldInputStyle} data-testid="server-author" />
              <button onClick={saveAuthor} disabled={busy !== null || author.trim() === (state?.config.author ?? '')} style={{ ...button, whiteSpace: 'nowrap' }}>Save</button>
            </div>
            <div style={hint}>Recorded on every file you save so the team sees who changed what.</div>
          </div>
        </div>
      </div>

      <div>
        <div style={sectionLabel}>Talk to the vault from Claude Code</div>
        <div style={card}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Terminal size={13} style={{ flexShrink: 0, marginTop: 3, color: 'var(--color-text-muted)' }} />
            <code style={{ fontSize: 11, lineHeight: 1.6, wordBreak: 'break-all', color: 'var(--color-text-primary)' }} data-testid="server-mcp-command">{mcpCommand}</code>
          </div>
          <div style={hint}>Same server, same token. Gives Claude Code <code>vault_search</code>, <code>graph_lint</code>, <code>vault_propose</code> and friends.</div>
        </div>
      </div>

      {status && status.conflicts.length > 0 && (
        <div>
          <div style={sectionLabel}>Conflicts</div>
          <div style={card}>
            {status.conflicts.slice().reverse().map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11 }}>
                <GitBranch size={12} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-warning)' }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: 'var(--color-text-primary)' }}>{c.path}</div>
                  <div style={{ color: 'var(--color-text-muted)' }}>{c.remoteAuthor} won · yours kept as <code>{c.keptAs.split('/').pop()}</code> · {relative(c.at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {status && status.errors.length > 0 && (
        <div>
          <div style={sectionLabel}>Recent errors</div>
          <div style={card}>
            {status.errors.slice().reverse().slice(0, 5).map((e, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11 }}>
                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-error)' }} />
                <div style={{ color: 'var(--color-text-muted)' }}>{e.path ? `${e.path} — ` : ''}{e.message} · {relative(e.at)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div style={sectionLabel}>Session</div>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              Removes the server address, the token and the local copy of the vault from this browser.
            </div>
            <button onClick={disconnect} data-testid="server-disconnect" style={{ ...button, color: 'var(--color-error)' }}>
              <LogOut size={11} /> Disconnect
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
