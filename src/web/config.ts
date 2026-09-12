/**
 * Web-mode configuration: which Strata Sync Worker the browser talks to.
 *
 * The web build (Vercel) has no Electron main process, so the vault lives entirely on the
 * Cloudflare Worker and the browser needs a server URL + team token. Kept in localStorage —
 * the token is a shared team secret, the same one the desktop client and the MCP CLI use.
 */

export interface WebConfig {
  /** Worker origin, e.g. https://strata-sync.example.workers.dev (no trailing slash). */
  url: string
  /** Team token sent as `Authorization: Bearer`. */
  token: string
  /** Display name recorded as the author of writes. */
  author: string
  /** 'oauth' = signed in with Google (token is a short-lived access token kept fresh by auth.ts); 'token' = shared team token. */
  auth?: 'oauth' | 'token'
  /** Signed-in account, for the Server tab. */
  email?: string
}

export const WEB_CONFIG_KEY = 'strata-sync-web-config'

/** True when the page runs as a plain web app (no Electron preload bridge). */
export function isWebMode(): boolean {
  return typeof window !== 'undefined' && !window.electronAPI?.isElectron
}

/** Normalise a user-typed server URL: adds https://, strips paths and trailing slashes. */
export function normalizeServerUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) return null
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    return u.origin
  } catch {
    return null
  }
}

/** Server baked into the build (Vercel env `VITE_STRATA_SERVER_URL`); users then never type a URL. */
export function defaultServerUrl(): string | null {
  const raw = (import.meta.env?.VITE_STRATA_SERVER_URL as string | undefined) ?? ''
  return normalizeServerUrl(raw)
}

/** Pseudo vault path used as `vaultPath` inside the app for a remote vault. */
export function remoteVaultPath(serverUrl: string): string {
  return `remote://${new URL(serverUrl).host}`
}

export function loadWebConfig(): WebConfig | null {
  try {
    const raw = localStorage.getItem(WEB_CONFIG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<WebConfig>
    const url = typeof parsed.url === 'string' ? normalizeServerUrl(parsed.url) : null
    if (!url) return null
    const auth = parsed.auth === 'oauth' ? 'oauth' : 'token'
    // OAuth sessions keep their tokens in auth.ts; the team token must be present here
    if (auth === 'token' && (typeof parsed.token !== 'string' || !parsed.token)) return null
    return { url, token: typeof parsed.token === 'string' ? parsed.token : '', author: typeof parsed.author === 'string' ? parsed.author : '', auth, email: typeof parsed.email === 'string' ? parsed.email : undefined }
  } catch {
    return null
  }
}

export function saveWebConfig(config: WebConfig): void {
  // Access tokens are short-lived and owned by auth.ts; never persist them as the "token"
  const persisted = config.auth === 'oauth' ? { ...config, token: '' } : config
  try { localStorage.setItem(WEB_CONFIG_KEY, JSON.stringify(persisted)) } catch { /* private mode etc. */ }
}

export function clearWebConfig(): void {
  try { localStorage.removeItem(WEB_CONFIG_KEY) } catch { /* ignore */ }
}
