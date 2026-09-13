/**
 * ServerTab — web build only: which Strata Sync server this browser is connected to, sync
 * status, conflicts, your author name, and disconnect. Mirrors the desktop Team Sync tab but
 * talks to the in-browser remote vault adapter (window.syncAPI shim).
 */
import { useEffect, useState } from 'react'
import { Cloud, RefreshCw, AlertTriangle, GitBranch, LogOut, Terminal, Database, Play, Loader2 } from 'lucide-react'
import type { BatchStatus } from '@/web/remoteClient'
import { fieldInputStyle } from '../settingsShared'
import { clearWebConfig, loadWebConfig } from '@/web/config'
import { currentRemoteVault } from '@/web/remoteVault'
import { clearSession } from '@/web/auth'
import { t, useT } from '@/i18n'

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

function when(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function relative(ms: number | null): string {
  if (!ms) return t('never')
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 5) return t('just now')
  if (s < 60) return t('{s}s ago', { s })
  const m = Math.floor(s / 60)
  return m < 60 ? t('{m}m ago', { m }) : t('{h}h ago', { h: Math.floor(m / 60) })
}

export default function ServerTab() {
  const t = useT()
  const api = window.syncAPI
  const [state, setState] = useState<SyncState | null>(null)
  const [author, setAuthor] = useState('')
  const [busy, setBusy] = useState<'save' | 'sync' | 'batch' | null>(null)
  const [batch, setBatch] = useState<BatchStatus | null>(null)
  const [batchError, setBatchError] = useState<string | null>(null)

  const loadBatch = async () => {
    const client = currentRemoteVault()?.client
    if (!client) return
    try { setBatch(await client.batchStatus()); setBatchError(null) }
    catch (e) { setBatchError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void loadBatch() }, [])

  const runBatch = async () => {
    const client = currentRemoteVault()?.client
    if (!client) return
    setBusy('batch'); setBatchError(null)
    try { await client.runBatch() }
    catch (e) { setBatchError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null); void loadBatch() }
  }

  useEffect(() => {
    if (!api) return
    let cancelled = false
    api.getState().then(s => { if (!cancelled) { setState(s); setAuthor(s.config.author) } })
    const off = api.onStatus(s => setState(s))
    return () => { cancelled = true; off() }
  }, [api])

  if (!api) {
    return <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t('Not connected to a server.')}</div>
  }

  const status = state?.status
  const saved = loadWebConfig()
  const url = state?.config.url ?? saved?.url ?? ''
  const signedIn = saved?.auth === 'oauth'
  // Signed-in servers issue MCP clients their own tokens through the same Google sign-in; the shared token is only for servers without it
  const mcpCommand = signedIn ? `claude mcp add --transport http strata ${url}/mcp` : `claude mcp add --transport http strata ${url}/mcp --header "Authorization: Bearer <team token>" --header "X-Author: ${saved?.author?.trim() || '<your name>'}"`

  const saveAuthor = async () => {
    setBusy('save')
    try { setState(await api.updateConfig({ author: author.trim() })) } finally { setBusy(null) }
  }
  const syncNow = async () => {
    setBusy('sync')
    try { setState(await api.syncNow()) } finally { setBusy(null) }
  }
  const disconnect = async () => {
    if (!window.confirm(t('Disconnect from this server? The local copy of the vault in this browser is removed; nothing on the server changes.'))) return
    await currentRemoteVault()?.cache.reset()
    clearSession()
    clearWebConfig()
    window.location.reload()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
        <Cloud size={16} color="var(--color-accent)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-accent)' }} data-testid="server-status-title">
            {status?.inFlight ? t('Syncing…') : status?.lastError ? t('Sync error') : t('Connected · last {time}', { time: relative(status?.lastSyncAt ?? null) })}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {url}{status ? ` · seq ${status.lastSeq}` : ''}{signedIn && saved?.email ? ` · ${saved.email}` : ''}
          </div>
          {status?.lastError && <div style={{ fontSize: 11, color: 'var(--color-error)', marginTop: 4 }}>{status.lastError}</div>}
        </div>
        <button onClick={syncNow} disabled={busy !== null} data-testid="server-sync-now" style={{ ...button, opacity: busy ? 0.5 : 1 }}>
          <RefreshCw size={11} className={busy === 'sync' || status?.inFlight ? 'animate-spin' : ''} /> {t('Sync now')}
        </button>
      </div>

      <div>
        <div style={sectionLabel}>{t('You')}</div>
        <div style={card}>
          <div>
            <label style={label}>{t('Author name')}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={author} onChange={e => setAuthor(e.target.value)} placeholder={t('shown on your edits and conflict copies')} style={fieldInputStyle} data-testid="server-author" />
              <button onClick={saveAuthor} disabled={busy !== null || author.trim() === (state?.config.author ?? '')} style={{ ...button, whiteSpace: 'nowrap' }}>{t('Save')}</button>
            </div>
            <div style={hint}>{signedIn ? t('Comes from your Google account; change it here if the team knows you by another name.') : t('Recorded on every file you save so the team sees who changed what.')}</div>
          </div>
        </div>
      </div>

      <div>
        <div style={sectionLabel}>{t('Talk to the vault from Claude Code')}</div>
        <div style={card}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Terminal size={13} style={{ flexShrink: 0, marginTop: 3, color: 'var(--color-text-muted)' }} />
            <code style={{ fontSize: 11, lineHeight: 1.6, wordBreak: 'break-all', color: 'var(--color-text-primary)' }} data-testid="server-mcp-command">{mcpCommand}</code>
          </div>
          <div style={hint}>{signedIn ? t('Claude Code opens the Google sign-in the first time you use it.') : t('Same server, same token.')} {t('Gives Claude Code')} <code>vault_search</code>, <code>graph_lint</code>, <code>vault_propose</code> {t('and friends.')}</div>
        </div>
      </div>

      <div>
        <div style={sectionLabel}>{t('Nightly batch — lint report + vector index')}</div>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Database size={14} style={{ flexShrink: 0, color: 'var(--color-accent)' }} />
            <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-primary)' }} data-testid="batch-coverage">
              {batch
                ? <>{t('Vector index covers')} <b>{batch.embeddedDocs}</b> {t('/ {total} documents', { total: batch.totalDocs })}{batch.pendingDocs > 0 ? <span style={{ color: 'var(--color-warning)' }}> · {t('{count} waiting for the next run', { count: batch.pendingDocs })}</span> : ''}</>
                : batchError ? <span style={{ color: 'var(--color-error)' }}>{batchError}</span> : t('Loading…')}
            </div>
            <button onClick={runBatch} disabled={busy !== null} data-testid="batch-run" style={{ ...button, opacity: busy ? 0.5 : 1 }}>
              {busy === 'batch' ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} {busy === 'batch' ? t('Running…') : t('Run now')}
            </button>
          </div>
          <div style={hint}>{t('Runs every night at 04:00 (Asia/Seoul): writes')} <code>_reports/lint-&lt;date&gt;.md</code> {t('and embeds changed documents for')} <code>vault_search</code>{t('. Large backlogs finish over several runs.')}</div>
          {batch && batch.runs.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="batch-log">
              {batch.runs.slice().reverse().slice(0, 10).map((r, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '84px 52px 1fr', gap: 8, fontSize: 11, alignItems: 'baseline' }}>
                  <span style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{when(r.startedAt)}</span>
                  <span style={{ color: 'var(--color-text-muted)' }}>{r.trigger}</span>
                  <span style={{ color: r.embeddings.error ? 'var(--color-error)' : 'var(--color-text-muted)' }}>
                    {t('{docs} docs · lint {errors}E/{warnings}W · embedded {embedded}', { docs: r.docs, errors: r.lint.errors, warnings: r.lint.warnings, embedded: r.embeddings.docsEmbedded })}
                    {r.embeddings.pending > 0 ? t(' (+{pending} left)', { pending: r.embeddings.pending }) : ''}
                    {t(' · {seconds}s', { seconds: Math.round(r.durationMs / 1000) })}
                    {r.embeddings.error ? ` · ${r.embeddings.error}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {status && status.conflicts.length > 0 && (
        <div>
          <div style={sectionLabel}>{t('Conflicts')}</div>
          <div style={card}>
            {status.conflicts.slice().reverse().map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 11 }}>
                <GitBranch size={12} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-warning)' }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: 'var(--color-text-primary)' }}>{c.path}</div>
                  <div style={{ color: 'var(--color-text-muted)' }}>{c.remoteAuthor} {t('won · yours kept as')} <code>{c.keptAs.split('/').pop()}</code> · {relative(c.at)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {status && status.errors.length > 0 && (
        <div>
          <div style={sectionLabel}>{t('Recent errors')}</div>
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
        <div style={sectionLabel}>{t('Session')}</div>
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ flex: 1, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
              {signedIn ? t('Signs you out and removes the local copy of the vault from this browser.') : t('Removes the server address, the token and the local copy of the vault from this browser.')}
            </div>
            <button onClick={disconnect} data-testid="server-disconnect" style={{ ...button, color: 'var(--color-error)' }}>
              <LogOut size={11} /> {signedIn ? t('Sign out') : t('Disconnect')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
