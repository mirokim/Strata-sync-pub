/**
 * Sign-in with Google for the web app and for MCP clients.
 *
 * The Worker is an OAuth 2.1 authorization server (`@cloudflare/workers-oauth-provider`): the
 * browser app and MCP clients (Claude Code, Cursor) register themselves, send the user to
 * `/authorize`, and get back access tokens for `/v1/*` and `/mcp`. This module is the part of
 * that flow that talks to Google: `/authorize` forwards the user to Google, `/callback` turns
 * Google's answer into a grant. Anyone with a Google account may sign in unless
 * `ALLOWED_EMAIL_DOMAINS` narrows it. The shared TEAM_TOKEN keeps working as a service
 * credential for the desktop sync engine, bots and scripts (see resolveExternalToken in index.ts).
 */
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'

/** Who is making the request — from a Google grant or from the team token. */
export interface Identity {
  /** Google `sub`, or 'service' for the team token. */
  sub: string
  email: string
  name: string
  picture?: string
  /** True for the shared team token (desktop engine, bots, scripts). */
  service?: boolean
}

export interface AuthEnv {
  OAUTH_KV: KVNamespace
  OAUTH_PROVIDER: OAuthHelpers
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Comma-separated domains allowed to sign in; empty = any Google account. */
  ALLOWED_EMAIL_DOMAINS?: string
}

export const SCOPE = 'vault'
const STATE_TTL_S = 600
const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO = 'https://openidconnect.googleapis.com/v1/userinfo'

export function googleConfigured(env: Pick<AuthEnv, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET'>): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

export function emailAllowed(email: string, allowlist: string | undefined): boolean {
  const domains = (allowlist ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
  if (domains.length === 0) return true
  const domain = email.toLowerCase().split('@')[1] ?? ''
  return domains.includes(domain)
}

function page(status: number, title: string, body: string): Response {
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222"><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body>`
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

function randomId(): string {
  const b = new Uint8Array(24)
  crypto.getRandomValues(b)
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Routes outside the protected API: the Google leg of the sign-in, plus /health. */
export async function handleAuth(req: Request, env: AuthEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url)

  if (url.pathname === '/authorize' && req.method === 'GET') {
    let authReq: AuthRequest
    try {
      authReq = await env.OAUTH_PROVIDER.parseAuthRequest(req)
    } catch (e) {
      return page(400, 'Invalid authorization request', e instanceof Error ? e.message : String(e))
    }
    if (!googleConfigured(env)) {
      return page(503, 'Sign-in not configured', 'This server has no Google OAuth client yet. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or connect with the team token.')
    }
    const state = randomId()
    await env.OAUTH_KV.put(`gstate:${state}`, JSON.stringify(authReq), { expirationTtl: STATE_TTL_S })
    const google = new URL(GOOGLE_AUTH)
    google.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!)
    google.searchParams.set('redirect_uri', `${url.origin}/callback`)
    google.searchParams.set('response_type', 'code')
    google.searchParams.set('scope', 'openid email profile')
    google.searchParams.set('state', state)
    google.searchParams.set('access_type', 'online')
    google.searchParams.set('prompt', 'select_account')
    return Response.redirect(google.toString(), 302)
  }

  if (url.pathname === '/callback' && req.method === 'GET') {
    const state = url.searchParams.get('state') ?? ''
    const code = url.searchParams.get('code') ?? ''
    if (url.searchParams.get('error')) return page(400, 'Sign-in cancelled', `Google reported: ${url.searchParams.get('error')}`)
    const stored = state ? await env.OAUTH_KV.get(`gstate:${state}`) : null
    if (!stored || !code) return page(400, 'Sign-in expired', 'Start again from the app or the MCP client.')
    await env.OAUTH_KV.delete(`gstate:${state}`)
    const authReq = JSON.parse(stored) as AuthRequest

    const tokenRes = await fetchImpl(GOOGLE_TOKEN, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
        redirect_uri: `${url.origin}/callback`, grant_type: 'authorization_code',
      }),
    })
    if (!tokenRes.ok) return page(502, 'Google rejected the sign-in', `token endpoint answered ${tokenRes.status}`)
    const tokens = await tokenRes.json() as { access_token?: string }
    if (!tokens.access_token) return page(502, 'Google rejected the sign-in', 'no access token in the response')

    const infoRes = await fetchImpl(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${tokens.access_token}` } })
    if (!infoRes.ok) return page(502, 'Could not read the Google profile', `userinfo answered ${infoRes.status}`)
    const info = await infoRes.json() as { sub?: string; email?: string; email_verified?: boolean; name?: string; picture?: string }
    if (!info.sub || !info.email || info.email_verified === false) return page(403, 'Unverified account', 'Google did not confirm the e-mail address of this account.')
    if (!emailAllowed(info.email, env.ALLOWED_EMAIL_DOMAINS)) return page(403, 'Not allowed', `${info.email} is not in an allowed domain for this vault.`)

    const identity: Identity = { sub: info.sub, email: info.email, name: info.name || info.email.split('@')[0], picture: info.picture }
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: authReq,
      userId: info.sub,
      metadata: { email: info.email, name: identity.name },
      scope: authReq.scope.length ? authReq.scope : [SCOPE],
      props: identity,
    })
    return Response.redirect(redirectTo, 302)
  }

  return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: { 'content-type': 'application/json; charset=utf-8' } })
}
