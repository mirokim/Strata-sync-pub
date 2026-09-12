/**
 * Sign-in for the browser build: OAuth 2.1 authorization-code flow with PKCE against the
 * Worker, which fronts Google. The browser registers itself once as a public client, sends the
 * user to `/authorize` (→ Google → back here with `?code=`), exchanges the code at `/token`, and
 * keeps the access/refresh tokens in localStorage. Everything is per server origin.
 */
import { normalizeServerUrl, type WebConfig } from './config'
import { t as i18nT } from '@/i18n'

export interface Session {
  server: string
  accessToken: string
  refreshToken: string | null
  /** ms since epoch when the access token stops working. */
  expiresAt: number
  clientId: string
}

const CLIENT_KEY = 'strata-sync-web-oauth-client'
const SESSION_KEY = 'strata-sync-web-session'
const PENDING_KEY = 'strata-sync-web-oauth-pending'
const SCOPE = 'vault'

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const store = {
  get<T>(key: string): T | null { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : null } catch { return null } },
  set(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ } },
  del(key: string) { try { localStorage.removeItem(key) } catch { /* ignore */ } },
}

// ── PKCE helpers ─────────────────────────────────────────────────────────────

function randomString(bytes = 32): string {
  const b = new Uint8Array(bytes)
  crypto.getRandomValues(b)
  return base64url(b)
}
function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
}

/** The page the Worker sends the user back to — the app root, with no query. */
function redirectUri(): string {
  return `${location.origin}${location.pathname.replace(/[^/]*$/, '')}`
}

// ── Client registration (once per server) ────────────────────────────────────

async function clientIdFor(server: string, fetchImpl: FetchLike): Promise<string> {
  const known = store.get<Record<string, string>>(CLIENT_KEY) ?? {}
  const key = `${server}|${redirectUri()}`
  if (known[key]) return known[key]
  const res = await fetchImpl(`${server}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Strata Sync Web',
      redirect_uris: [redirectUri()],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  })
  if (!res.ok) throw new Error(i18nT('client registration failed ({status})', { status: res.status }))
  const body = await res.json() as { client_id: string }
  store.set(CLIENT_KEY, { ...known, [key]: body.client_id })
  return body.client_id
}

// ── Flow ─────────────────────────────────────────────────────────────────────

/** Leave the page for the sign-in. Returns only when navigation could not start. */
export async function startSignIn(serverUrl: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)): Promise<void> {
  const server = normalizeServerUrl(serverUrl)
  if (!server) throw new Error(i18nT('invalid server URL'))
  const clientId = await clientIdFor(server, fetchImpl)
  const verifier = randomString(48)
  const state = randomString(16)
  store.set(PENDING_KEY, { server, clientId, verifier, state, startedAt: Date.now() })
  const u = new URL(`${server}/authorize`)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri())
  u.searchParams.set('scope', SCOPE)
  u.searchParams.set('state', state)
  u.searchParams.set('code_challenge', base64url(await sha256(verifier)))
  u.searchParams.set('code_challenge_method', 'S256')
  location.assign(u.toString())
}

/**
 * Finish a sign-in when the page loads with `?code=&state=`. Returns the session, or null when
 * the URL carries no callback. Throws when the state does not match or the exchange fails.
 */
export async function completeSignIn(fetchImpl: FetchLike = (i, init) => fetch(i, init)): Promise<Session | null> {
  const params = new URLSearchParams(location.search)
  const code = params.get('code'), state = params.get('state')
  if (!code || !state) return null
  const pending = store.get<{ server: string; clientId: string; verifier: string; state: string; startedAt: number }>(PENDING_KEY)
  // Strip the code from the URL whatever happens next — it is single-use and must not be re-sent
  history.replaceState(null, '', redirectUri())
  store.del(PENDING_KEY)
  if (!pending || pending.state !== state) throw new Error(i18nT('sign-in state mismatch — start again'))
  if (Date.now() - pending.startedAt > 10 * 60_000) throw new Error(i18nT('sign-in took too long — start again'))
  const session = await exchange(pending.server, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(), client_id: pending.clientId, code_verifier: pending.verifier,
  }, pending.clientId, fetchImpl)
  store.set(SESSION_KEY, session)
  return session
}

async function exchange(server: string, form: Record<string, string>, clientId: string, fetchImpl: FetchLike): Promise<Session> {
  const res = await fetchImpl(`${server}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string; error_description?: string }
    throw new Error(body.error_description || body.error || i18nT('token endpoint answered {status}', { status: res.status }))
  }
  const t = await res.json() as { access_token: string; refresh_token?: string; expires_in?: number }
  return {
    server, clientId,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? null,
    expiresAt: Date.now() + Math.max(60, (t.expires_in ?? 3600) - 60) * 1000,
  }
}

export function loadSession(server: string): Session | null {
  const s = store.get<Session>(SESSION_KEY)
  return s && s.server === server ? s : null
}

export function clearSession(): void { store.del(SESSION_KEY); store.del(PENDING_KEY) }

/**
 * Access token that is good for at least a minute, refreshing when necessary. Returns null when
 * there is no session or the refresh was refused (→ sign in again).
 */
export async function freshAccessToken(server: string, fetchImpl: FetchLike = (i, init) => fetch(i, init)): Promise<string | null> {
  const s = loadSession(server)
  if (!s) return null
  if (Date.now() < s.expiresAt) return s.accessToken
  if (!s.refreshToken) return null
  try {
    const next = await exchange(server, { grant_type: 'refresh_token', refresh_token: s.refreshToken, client_id: s.clientId }, s.clientId, fetchImpl)
    // Some servers rotate refresh tokens; keep the old one when none is returned
    const merged: Session = { ...next, refreshToken: next.refreshToken ?? s.refreshToken }
    store.set(SESSION_KEY, merged)
    return merged.accessToken
  } catch {
    return null
  }
}

/** Apply a fresh access token to the live config the adapter and client share. */
export async function refreshInto(config: WebConfig, fetchImpl?: FetchLike): Promise<boolean> {
  const token = await freshAccessToken(config.url, fetchImpl)
  if (!token) return false
  config.token = token
  return true
}
