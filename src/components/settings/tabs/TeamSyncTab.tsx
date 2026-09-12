/**
 * TeamSyncTab — connect this vault to the team's Cloudflare sync server.
 *
 * Settings live in the Electron main process (the token is encrypted with the OS keychain), so
 * everything here goes through window.syncAPI; the tab only mirrors state pushed from main.
 */
import { useEffect, useState } from 'react'
import { Cloud, CloudOff, RefreshCw, Plug, AlertTriangle, GitBranch } from 'lucide-react'
import { fieldInputStyle } from '../settingsShared'
import { useT } from '@/i18n'

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
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }

function relative(ms: number | null, t: ReturnType<typeof useT>): string {
  if (!ms) return t('never')
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 5) return t('just now')
  if (s < 60) return t('{n}s ago', { n: s })
  const m = Math.floor(s / 60)
  return m < 60 ? t('{n}m ago', { n: m }) : t('{n}h ago', { n: Math.floor(m / 60) })
}

export default function TeamSyncTab() {
  const t = useT()
  const api = window.syncAPI
  const [state, setState] = useState<SyncState | null>(null)
  const [url, setUrl] = useState('')
  const [author, setAuthor] = useState('')
  const [token, setToken] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState<'save' | 'test' | 'sync' | null>(null)

  useEffect(() => {
    if (!api) return
    let cancelled = false
    api.getState().then(s => {
      if (cancelled) return
      setState(s); setUrl(s.config.url); setAuthor(s.config.author); setToken(s.config.token)
    })
    const off = api.onStatus(s => setState(s))
    return () => { cancelled = true; off() }
  }, [api])

  if (!api) {
    return <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t('Team sync is available in the desktop app only.')}</div>
  }

  const status = state?.status
  const enabled = state?.config.enabled ?? false
  const tokenIsMasked = token.startsWith('••••')
  const canEnable = Boolean(url.trim()) && (Boolean(token.trim()) || Boolean(state?.config.hasToken))

  const save = async (patch: Record<string, unknown>) => {
    setBusy('save')
    try {
      const next = await api.updateConfig({ url, author, ...(tokenIsMasked ? {} : { token }), ...patch })
      setState(next); setToken(next.config.token)
    } finally { setBusy(null) }
  }

  const test = async () => {
    setBusy('test'); setTestResult(null)
    try {
      const r = await api.testConnection(url, tokenIsMasked ? undefined : token)
      setTestResult(r.ok
        ? { ok: true, text: r.files === 1
            ? t('Connected — {files} file on the server (seq {head})', { files: r.files ?? 0, head: r.head ?? 0 })
            : t('Connected — {files} files on the server (seq {head})', { files: r.files ?? 0, head: r.head ?? 0 }) }
        : { ok: false, text: r.error ?? t('connection failed') })
    } finally { setBusy(null) }
  }

  const syncNow = async () => {
    setBusy('sync')
    try { setState(await api.syncNow()) } finally { setBusy(null) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 0' }}>
      {/* Status strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
        {enabled ? <Cloud size={16} color="var(--color-accent)" /> : <CloudOff size={16} color="var(--color-text-muted)" />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: enabled ? 'var(--color-accent)' : 'var(--color-text-primary)' }} data-testid="sync-status-title">
            {!enabled ? t('Team sync off')
              : status?.inFlight ? t('Syncing…')
              : status?.lastError ? t('Sync error')
              : t('In sync · last {rel}', { rel: relative(status?.lastSyncAt ?? null, t) })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
            {state?.vaultPath ? state.vaultPath : t('No vault open')}
            {enabled && status ? ' · ' + t('{pending} pending · seq {seq}', { pending: status.pending, seq: status.lastSeq }) : ''}
          </div>
          {status?.lastError && <div style={{ fontSize: 11, color: 'var(--color-error)', marginTop: 4 }}>{status.lastError}</div>}
        </div>
        <button
          onClick={syncNow}
          disabled={!enabled || busy !== null}
          data-testid="sync-now"
          style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 2, fontSize: 12, fontWeight: 500, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-primary)', cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.4 }}
        >
          <RefreshCw size={11} className={busy === 'sync' || status?.inFlight ? 'animate-spin' : ''} /> {t('Sync now')}
        </button>
      </div>

      {/* Connection */}
      <div>
        <div style={sectionLabel}>{t('Server')}</div>
        <div style={card}>
          <div>
            <label style={label}>{t('Server URL')}</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://strata-sync-cloud.<account>.workers.dev" style={fieldInputStyle} spellCheck={false} data-testid="sync-url" />
            <div style={hint}>{(() => {
              const [before, after] = t('The Cloudflare Worker in {folder}. One deployment per team.').split('{folder}')
              return <>{before}<code>cloud/</code>{after}</>
            })()}</div>
          </div>
          <div>
            <label style={label}>{t('Team token')}</label>
            <input value={token} onChange={e => setToken(e.target.value)} type="password" placeholder={t('shared team token')} style={fieldInputStyle} spellCheck={false} data-testid="sync-token" />
            <div style={hint}>{t('Stored encrypted on this machine. Everyone on the team uses the same token.')}</div>
          </div>
          <div>
            <label style={label}>{t('Your name')}</label>
            <input value={author} onChange={e => setAuthor(e.target.value)} placeholder={t('shown on conflict copies and in file history')} style={fieldInputStyle} data-testid="sync-author" />
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={test} disabled={busy !== null || !url.trim()} data-testid="sync-test"
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 2, fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer' }}>
              <Plug size={11} /> {t('Test connection')}
            </button>
            <button onClick={() => save({ enabled: !enabled })} disabled={busy !== null || (!enabled && !canEnable)} data-testid="sync-toggle"
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '6px 14px', borderRadius: 2, fontSize: 12, fontWeight: 500, border: 'none', background: enabled ? 'var(--color-error-bg)' : 'var(--color-accent)', color: enabled ? 'var(--color-error)' : '#fff', cursor: 'pointer', opacity: (!enabled && !canEnable) ? 0.4 : 1 }}>
              {enabled ? t('Turn off') : t('Turn on')}
            </button>
            {enabled && (
              <button onClick={() => save({})} disabled={busy !== null} style={{ padding: '6px 12px', borderRadius: 2, fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer' }}>
                {t('Save changes')}
              </button>
            )}
            {testResult && (
              <span style={{ fontSize: 11, color: testResult.ok ? 'var(--color-accent)' : 'var(--color-error)' }} data-testid="sync-test-result">{testResult.text}</span>
            )}
          </div>
        </div>
      </div>

      {/* Conflicts */}
      {status && status.conflicts.length > 0 && (
        <div>
          <div style={sectionLabel}>{t('Conflicts kept as copies')}</div>
          <div style={{ ...card, gap: 8 }}>
            {status.conflicts.slice().reverse().map((c, i) => {
              const template = c.remoteAuthor
                ? t('{author}\'s version kept the name; your version saved as {kept}', { author: c.remoteAuthor })
                : t('your version saved as {kept}')
              const [beforeKept, afterKept] = template.split('{kept}')
              return (
                <div key={`${c.path}-${c.at}-${i}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
                  <GitBranch size={12} style={{ marginTop: 2, flexShrink: 0 }} color="var(--color-text-muted)" />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: 'var(--color-text-primary)', wordBreak: 'break-all' }}>{c.path}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>
                      {beforeKept}<code>{c.keptAs}</code>{afterKept}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Skipped files */}
      {status && status.errors.length > 0 && (
        <div>
          <div style={sectionLabel}>{t('Not synced')}</div>
          <div style={{ ...card, gap: 6 }}>
            {status.errors.slice().reverse().map((e, i) => (
              <div key={`${e.path}-${e.at}-${i}`} style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'flex-start' }}>
                <AlertTriangle size={12} style={{ marginTop: 2, flexShrink: 0 }} color="var(--color-error)" />
                <div style={{ minWidth: 0, wordBreak: 'break-all' }}>
                  <span style={{ color: 'var(--color-text-primary)' }}>{e.path}</span>
                  <span style={{ color: 'var(--color-text-muted)' }}> — {e.message}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
        {(() => {
          const [before, after] = t('How it works: edits are uploaded a couple of seconds after you save; other people\'s changes are pulled every 30 seconds. If two people change the same file, the server version keeps the file name and yours is saved next to it as a{tag} copy — nothing is overwritten. Files and folders starting with a dot stay on this machine.').split('{tag}')
          return <>{before}<code> (conflict …)</code>{after}</>
        })()}
      </div>
    </div>
  )
}
