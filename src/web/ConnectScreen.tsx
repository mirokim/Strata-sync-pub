/**
 * ConnectScreen — first screen of the web build. With a server baked into the build it offers
 * "Sign in with Google" (the Worker fronts Google and issues our access tokens); a team token
 * stays available as the fallback for self-hosted servers without Google, or for the dev loop.
 */
import { useEffect, useState } from 'react'
import { Cloud, Loader2, AlertTriangle, ArrowRight, KeyRound } from 'lucide-react'
import { defaultServerUrl, normalizeServerUrl, saveWebConfig, type WebConfig } from './config'
import { testConnection } from './remoteVault'
import { startSignIn } from './auth'
import { useT } from '@/i18n'

interface Props {
  initial?: Partial<WebConfig>
  /** Error carried over from a failed sign-in callback. */
  initialError?: string | null
  onConnected: (config: WebConfig) => void
}

const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', background: 'var(--color-bg-surface)', color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border)', borderRadius: 2, padding: '8px 10px', fontSize: 13, outline: 'none', fontFamily: 'inherit',
}
const label: React.CSSProperties = { fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-muted)', marginTop: 5, lineHeight: 1.5 }
const primary = (enabled: boolean): React.CSSProperties => ({
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 14px', borderRadius: 2, fontSize: 13, fontWeight: 600,
  border: 'none', background: 'var(--color-accent)', color: 'var(--color-bg-primary)', cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.5,
})
const linkButton: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--color-text-muted)', fontSize: 11, cursor: 'pointer', padding: 0, textDecoration: 'underline' }

export default function ConnectScreen({ initial, initialError, onConnected }: Props) {
  const t = useT()
  const preset = defaultServerUrl()
  const [url, setUrl] = useState(initial?.url ?? preset ?? '')
  const [token, setToken] = useState(initial?.token ?? '')
  const [author, setAuthor] = useState(initial?.author ?? '')
  const [busy, setBusy] = useState<'google' | 'token' | null>(null)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [signIn, setSignIn] = useState<'google' | 'token' | null>(null)
  const [useToken, setUseToken] = useState(false)

  const normalized = normalizeServerUrl(url)

  // Ask the server which sign-in it offers; "google" needs a configured OAuth client there
  useEffect(() => {
    if (!normalized) { setSignIn(null); return }
    let cancelled = false
    fetch(`${normalized}/health`).then(r => r.json()).then((h: { signIn?: string }) => {
      if (!cancelled) setSignIn(h.signIn === 'google' ? 'google' : 'token')
    }).catch(() => { if (!cancelled) setSignIn(null) })
    return () => { cancelled = true }
  }, [normalized])

  const googleAvailable = signIn === 'google' && !useToken
  const tokenReady = Boolean(normalized && token.trim() && author.trim()) && !busy

  const google = async () => {
    if (!normalized) return
    setBusy('google'); setError(null)
    try { await startSignIn(normalized) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(null) }
  }

  const connectWithToken = async (e?: React.FormEvent) => {
    e?.preventDefault()
    if (!normalized) { setError(t('Enter the server address, e.g. https://strata-sync.<account>.workers.dev')); return }
    setBusy('token'); setError(null)
    const result = await testConnection(normalized, token.trim())
    setBusy(null)
    if (!result.ok) { setError(result.error ?? t('Could not reach the server')); return }
    const config: WebConfig = { url: normalized, token: token.trim(), author: author.trim(), auth: 'token' }
    saveWebConfig(config)
    onConnected(config)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)', padding: 24 }}>
      <form onSubmit={connectWithToken} style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 18 }} data-testid="connect-screen">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Cloud size={20} color="var(--color-accent)" />
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-0.01em' }}>Strata Sync</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t("Your team's vault, in the browser")}</div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16, borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
          {preset ? (
            <div>
              <label style={label}>{t('Server')}</label>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', wordBreak: 'break-all' }} data-testid="connect-url-preset">{preset}</div>
            </div>
          ) : (
            <div>
              <label style={label} htmlFor="connect-url">{t('Server')}</label>
              <input id="connect-url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://strata-sync.<account>.workers.dev" style={field} spellCheck={false} autoFocus autoComplete="url" data-testid="connect-url" />
              <div style={hint}>{t("The team's Cloudflare Worker. Ask whoever deployed it.")}</div>
            </div>
          )}

          {googleAvailable ? (
            <>
              <button type="button" onClick={google} disabled={busy !== null} style={primary(busy === null)} data-testid="connect-google">
                {busy === 'google' ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                {busy === 'google' ? t('Opening Google…') : t('Sign in with Google')}
              </button>
              <div style={hint}>{t('Any Google account works. Your name and e-mail are recorded on the documents you edit.')}</div>
              <button type="button" onClick={() => setUseToken(true)} style={linkButton}>{t('Use a team token instead')}</button>
            </>
          ) : (
            <>
              <div>
                <label style={label} htmlFor="connect-token">{t('Team token')}</label>
                <input id="connect-token" type="password" value={token} onChange={e => setToken(e.target.value)} placeholder={t('shared team secret')} style={field} autoComplete="off" autoFocus={Boolean(preset)} data-testid="connect-token" />
                <div style={hint}>{t('Stored in this browser only. The same token the desktop app and bots use.')}</div>
              </div>
              <div>
                <label style={label} htmlFor="connect-author">{t('Your name')}</label>
                <input id="connect-author" value={author} onChange={e => setAuthor(e.target.value)} placeholder={t('shown on your edits and conflict copies')} style={field} autoComplete="name" data-testid="connect-author" />
              </div>
              {signIn === 'google' && (
                <button type="button" onClick={() => setUseToken(false)} style={linkButton}>{t('Sign in with Google instead')}</button>
              )}
            </>
          )}
        </div>

        {error && (
          <div role="alert" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12, color: 'var(--color-error)' }}>
            <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{t(error)}</span>
          </div>
        )}

        {!googleAvailable && (
          <button type="submit" disabled={!tokenReady} data-testid="connect-submit" style={primary(tokenReady)}>
            {busy === 'token' ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {busy === 'token' ? t('Checking…') : t('Connect with token')}
          </button>
        )}
      </form>
    </div>
  )
}
