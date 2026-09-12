/**
 * ConnectScreen — first screen of the web build: which Strata Sync server, which team token,
 * who is typing. Shown until a working configuration is saved; App takes over afterwards.
 */
import { useState } from 'react'
import { Cloud, Loader2, AlertTriangle, ArrowRight } from 'lucide-react'
import { defaultServerUrl, normalizeServerUrl, saveWebConfig, type WebConfig } from './config'
import { testConnection } from './remoteVault'

interface Props {
  initial?: Partial<WebConfig>
  onConnected: (config: WebConfig) => void
}

const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-bg-surface)', color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)', borderRadius: 2, padding: '8px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit',
}
const label: React.CSSProperties = { fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-muted)', marginTop: 5, lineHeight: 1.5 }

export default function ConnectScreen({ initial, onConnected }: Props) {
  const preset = defaultServerUrl()
  const [url, setUrl] = useState(initial?.url ?? preset ?? '')
  const [token, setToken] = useState(initial?.token ?? '')
  const [author, setAuthor] = useState(initial?.author ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const normalized = normalizeServerUrl(url)
  const ready = Boolean(normalized && token.trim() && author.trim()) && !busy

  const connect = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!normalized) { setError('Enter the server address, e.g. https://strata-sync.<account>.workers.dev'); return }
    setBusy(true); setError(null)
    const result = await testConnection(normalized, token.trim())
    setBusy(false)
    if (!result.ok) { setError(result.error ?? 'Could not reach the server'); return }
    const config: WebConfig = { url: normalized, token: token.trim(), author: author.trim() }
    saveWebConfig(config)
    onConnected(config)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)', padding: 24 }}>
      <form onSubmit={connect} style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="connect-screen">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Cloud size={20} color="var(--color-accent)" />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>Strata Sync</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>Connect to your team vault</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16, borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
          {preset ? (
            <div>
              <label style={label}>Server</label>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }} data-testid="connect-url-preset">{preset}</div>
            </div>
          ) : (
            <div>
              <label style={label} htmlFor="connect-url">Server</label>
              <input id="connect-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://strata-sync.<account>.workers.dev" style={field} spellCheck={false} autoFocus autoComplete="url" data-testid="connect-url" />
              <div style={hint}>The team's Cloudflare Worker. Ask whoever deployed it.</div>
            </div>
          )}
          <div>
            <label style={label} htmlFor="connect-token">Team token</label>
            <input id="connect-token" type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="shared team secret" style={field} autoComplete="off" autoFocus={Boolean(preset)} data-testid="connect-token" />
            <div style={hint}>Stored in this browser only. The same token the desktop app and MCP clients use.</div>
          </div>
          <div>
            <label style={label} htmlFor="connect-author">Your name</label>
            <input id="connect-author" value={author} onChange={e => setAuthor(e.target.value)} placeholder="shown on your edits and conflict copies" style={field} autoComplete="name" data-testid="connect-author" />
          </div>
        </div>

        {error && (
          <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--color-error)' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={!ready}
          data-testid="connect-submit"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 14px', borderRadius: 2, fontSize: 13, fontWeight: 600, border: 'none', background: 'var(--color-accent)', color: 'var(--color-bg-primary)', cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : 0.5 }}
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </form>
    </div>
  )
}
