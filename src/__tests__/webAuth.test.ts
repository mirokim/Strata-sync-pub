/**
 * Browser-side OAuth (PKCE) against a scripted Worker: registration, redirect, code exchange,
 * refresh, and the boot resolution in WebRoot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { startSignIn, completeSignIn, freshAccessToken, loadSession, clearSession, refreshInto } from '@/web/auth'
import { resolveBootConfig } from '@/web/WebRoot'
import { clearWebConfig, loadWebConfig, saveWebConfig } from '@/web/config'
import { RemoteClient } from '@/web/remoteClient'

const SERVER = 'https://strata.example'

/** Scripted /register, /token and /v1/me. */
function fakeServer() {
  const calls: { path: string; body: Record<string, string> | null; auth: string | null }[] = []
  let refreshOk = true
  const fetchImpl = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input)
    const headers = new Headers(init.headers as Record<string, string>)
    const raw = typeof init.body === 'string' ? init.body : null
    const body = raw ? (headers.get('content-type')?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw))) : null
    calls.push({ path: url.pathname, body, auth: headers.get('authorization') })
    if (url.pathname === '/register') return Response.json({ client_id: 'cid-1' }, { status: 201 })
    if (url.pathname === '/token') {
      if (body.grant_type === 'authorization_code') {
        if (body.code !== 'good' || !body.code_verifier) return Response.json({ error: 'invalid_grant' }, { status: 400 })
        return Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 })
      }
      if (body.grant_type === 'refresh_token') {
        if (!refreshOk) return Response.json({ error: 'invalid_grant', error_description: 'revoked' }, { status: 400 })
        return Response.json({ access_token: 'at-2', expires_in: 3600 })
      }
    }
    if (url.pathname === '/v1/me') {
      if (headers.get('authorization') === 'Bearer at-1' || headers.get('authorization') === 'Bearer at-2') return Response.json({ sub: '1', email: 'kim@gmail.com', name: 'Kim', picture: null, service: false, author: 'Kim' })
      return Response.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (url.pathname === '/v1/docs') {
      if (headers.get('authorization') !== 'Bearer at-2') return Response.json({ error: 'unauthorized' }, { status: 401 })
      return Response.json({ head: 0, next: null, docs: [] })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  }
  return { fetchImpl, calls, setRefreshOk(v: boolean) { refreshOk = v } }
}

beforeEach(() => {
  clearSession(); clearWebConfig()
  history.replaceState(null, '', '/')
})

describe('startSignIn', () => {
  it('registers a public client once and leaves for /authorize with PKCE', async () => {
    const s = fakeServer()
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', { value: { ...original, assign, origin: 'http://localhost:4188', pathname: '/', search: '' }, writable: true })
    try {
      await startSignIn(SERVER, s.fetchImpl)
      await startSignIn(SERVER, s.fetchImpl)
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true })
    }
    expect(s.calls.filter(c => c.path === '/register')).toHaveLength(1) // cached client id
    expect(s.calls[0].body).toMatchObject({ token_endpoint_auth_method: 'none', redirect_uris: ['http://localhost:4188/'] })
    expect(assign).toHaveBeenCalledTimes(2)
    const u = new URL(assign.mock.calls[0][0])
    expect(u.origin + u.pathname).toBe(`${SERVER}/authorize`)
    expect(u.searchParams.get('client_id')).toBe('cid-1')
    expect(u.searchParams.get('code_challenge_method')).toBe('S256')
    expect(u.searchParams.get('code_challenge')!.length).toBeGreaterThan(30)
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:4188/')
  })
})

describe('completeSignIn', () => {
  async function pending(state = 'st') {
    localStorage.setItem('strata-sync-web-oauth-pending', JSON.stringify({ server: SERVER, clientId: 'cid-1', verifier: 'v'.repeat(48), state, startedAt: Date.now() }))
  }

  it('returns null without a callback in the URL', async () => {
    expect(await completeSignIn(fakeServer().fetchImpl)).toBeNull()
  })

  it('exchanges the code with the verifier, stores the session and cleans the URL', async () => {
    const s = fakeServer()
    await pending()
    history.replaceState(null, '', '/?code=good&state=st')
    const session = await completeSignIn(s.fetchImpl)
    expect(session).toMatchObject({ server: SERVER, accessToken: 'at-1', refreshToken: 'rt-1', clientId: 'cid-1' })
    expect(session!.expiresAt).toBeGreaterThan(Date.now() + 3000_000)
    expect(location.search).toBe('')
    expect(loadSession(SERVER)).toMatchObject({ accessToken: 'at-1' })
    const tokenCall = s.calls.find(c => c.path === '/token')!
    expect(tokenCall.body).toMatchObject({ grant_type: 'authorization_code', code: 'good', client_id: 'cid-1', code_verifier: 'v'.repeat(48) })
  })

  it('refuses a state mismatch and a bad code, and never re-sends the code', async () => {
    const s = fakeServer()
    await pending('other')
    history.replaceState(null, '', '/?code=good&state=st')
    await expect(completeSignIn(s.fetchImpl)).rejects.toThrow(/state/)
    expect(location.search).toBe('')
    await pending()
    history.replaceState(null, '', '/?code=bad&state=st')
    await expect(completeSignIn(s.fetchImpl)).rejects.toThrow()
    expect(loadSession(SERVER)).toBeNull()
  })
})

describe('freshAccessToken / refreshInto', () => {
  it('returns the token while valid, refreshes when expired, keeps the old refresh token', async () => {
    const s = fakeServer()
    localStorage.setItem('strata-sync-web-session', JSON.stringify({ server: SERVER, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 60_000, clientId: 'cid-1' }))
    expect(await freshAccessToken(SERVER, s.fetchImpl)).toBe('at-1')
    localStorage.setItem('strata-sync-web-session', JSON.stringify({ server: SERVER, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() - 1, clientId: 'cid-1' }))
    expect(await freshAccessToken(SERVER, s.fetchImpl)).toBe('at-2')
    expect(loadSession(SERVER)).toMatchObject({ accessToken: 'at-2', refreshToken: 'rt-1' })
    s.setRefreshOk(false)
    localStorage.setItem('strata-sync-web-session', JSON.stringify({ server: SERVER, accessToken: 'x', refreshToken: 'rt-1', expiresAt: Date.now() - 1, clientId: 'cid-1' }))
    expect(await freshAccessToken(SERVER, s.fetchImpl)).toBeNull()
    expect(await freshAccessToken('https://other.example', s.fetchImpl)).toBeNull()
  })

  it('RemoteClient retries once with a refreshed token after a 401', async () => {
    const s = fakeServer()
    const config = { url: SERVER, token: 'stale', author: 'Kim', auth: 'oauth' as const }
    localStorage.setItem('strata-sync-web-session', JSON.stringify({ server: SERVER, accessToken: 'stale', refreshToken: 'rt-1', expiresAt: Date.now() - 1, clientId: 'cid-1' }))
    const client = new RemoteClient(config, s.fetchImpl, () => refreshInto(config, s.fetchImpl))
    const page = await client.docs(0)
    expect(page.docs).toEqual([])
    expect(config.token).toBe('at-2')
    expect(s.calls.filter(c => c.path === '/v1/docs').map(c => c.auth)).toEqual(['Bearer stale', 'Bearer at-2'])
  })
})

describe('resolveBootConfig', () => {
  it('prefers a saved token config, refreshes an OAuth session, and reports an expired one', async () => {
    saveWebConfig({ url: SERVER, token: 'team', author: 'Me', auth: 'token' })
    expect((await resolveBootConfig()).config).toMatchObject({ token: 'team', auth: 'token' })

    saveWebConfig({ url: SERVER, token: '', author: 'Kim', auth: 'oauth', email: 'kim@gmail.com' })
    expect(loadWebConfig()!.token).toBe('') // access tokens are never persisted as the config token
    localStorage.setItem('strata-sync-web-session', JSON.stringify({ server: SERVER, accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: Date.now() + 60_000, clientId: 'cid-1' }))
    expect((await resolveBootConfig()).config).toMatchObject({ token: 'at-1', auth: 'oauth', author: 'Kim' })

    clearSession()
    const r = await resolveBootConfig()
    expect(r.config).toBeNull()
    expect(r.error).toContain('sign in')
  })
})
