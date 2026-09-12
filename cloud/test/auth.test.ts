import { describe, it, expect, beforeEach } from 'vitest'
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { handleAuth, emailAllowed, googleConfigured, type AuthEnv, type Identity } from '../src/auth.js'
import { route, type Env } from '../src/index.js'
import { MemoryMeta, MemoryBlobs } from './fakes.js'
import type { SyncDeps } from '../src/sync.js'

// ── Fakes ────────────────────────────────────────────────────────────────────

class FakeKV {
  store = new Map<string, string>()
  async get(k: string) { return this.store.get(k) ?? null }
  async put(k: string, v: string) { this.store.set(k, v) }
  async delete(k: string) { this.store.delete(k) }
}

const AUTH_REQ: AuthRequest = { responseType: 'code', clientId: 'client-1', redirectUri: 'http://localhost:1234/cb', scope: [], state: 'xyz' } as unknown as AuthRequest

function fakeProvider(completed: unknown[]): OAuthHelpers {
  return {
    parseAuthRequest: async (req: Request) => {
      if (!new URL(req.url).searchParams.get('client_id')) throw new Error('missing client_id')
      return AUTH_REQ
    },
    completeAuthorization: async (opts: unknown) => { completed.push(opts); return { redirectTo: 'http://localhost:1234/cb?code=grant-code&state=xyz' } },
  } as unknown as OAuthHelpers
}

/** Google's two endpoints, scripted. */
function googleFetch(profile: Record<string, unknown>, tokenStatus = 200): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      const body = new URLSearchParams(String(init?.body))
      if (body.get('code') !== 'good-code') return new Response('{"error":"invalid_grant"}', { status: 400 })
      return new Response(JSON.stringify({ access_token: 'g-access' }), { status: tokenStatus })
    }
    if (url.startsWith('https://openidconnect.googleapis.com/v1/userinfo')) return new Response(JSON.stringify(profile), { status: 200 })
    return new Response('nope', { status: 404 })
  }) as typeof fetch
}

let kv: FakeKV
let completed: unknown[]
let env: AuthEnv

beforeEach(() => {
  kv = new FakeKV(); completed = []
  env = { OAUTH_KV: kv as unknown as KVNamespace, OAUTH_PROVIDER: fakeProvider(completed), GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', ALLOWED_EMAIL_DOMAINS: '' }
})

describe('helpers', () => {
  it('googleConfigured needs both id and secret', () => {
    expect(googleConfigured({ GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' })).toBe(true)
    expect(googleConfigured({ GOOGLE_CLIENT_ID: 'a' })).toBe(false)
  })
  it('emailAllowed: empty allowlist = anyone; otherwise exact domain match', () => {
    expect(emailAllowed('x@gmail.com', '')).toBe(true)
    expect(emailAllowed('x@gmail.com', 'studio.example, other.example')).toBe(false)
    expect(emailAllowed('x@Studio.Example', 'studio.example')).toBe(true)
  })
})

describe('/authorize', () => {
  it('stores the parsed request under a random state and forwards to Google', async () => {
    const res = await handleAuth(new Request('https://w/authorize?client_id=client-1&response_type=code'), env)
    expect(res.status).toBe(302)
    const to = new URL(res.headers.get('location')!)
    expect(to.origin + to.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(to.searchParams.get('client_id')).toBe('gid')
    expect(to.searchParams.get('redirect_uri')).toBe('https://w/callback')
    expect(to.searchParams.get('scope')).toBe('openid email profile')
    const state = to.searchParams.get('state')!
    expect(state.length).toBeGreaterThan(20)
    expect(JSON.parse(kv.store.get(`gstate:${state}`)!)).toEqual(AUTH_REQ)
  })
  it('rejects an unparsable request and explains when Google is not configured', async () => {
    expect((await handleAuth(new Request('https://w/authorize'), env)).status).toBe(400)
    const bare = { ...env, GOOGLE_CLIENT_ID: undefined }
    const res = await handleAuth(new Request('https://w/authorize?client_id=client-1'), bare)
    expect(res.status).toBe(503)
    expect(await res.text()).toContain('team token')
  })
})

describe('/callback', () => {
  async function start(): Promise<string> {
    const res = await handleAuth(new Request('https://w/authorize?client_id=client-1'), env)
    return new URL(res.headers.get('location')!).searchParams.get('state')!
  }

  it('exchanges the code, reads the profile and completes the grant with the identity as props', async () => {
    const state = await start()
    const res = await handleAuth(new Request(`https://w/callback?state=${state}&code=good-code`), env, googleFetch({ sub: '123', email: 'kim@gmail.com', email_verified: true, name: 'Kim', picture: 'p.png' }))
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('http://localhost:1234/cb?code=grant-code&state=xyz')
    expect(completed).toHaveLength(1)
    const opts = completed[0] as { userId: string; scope: string[]; props: Identity; metadata: unknown }
    expect(opts.userId).toBe('123')
    expect(opts.scope).toEqual(['vault'])
    expect(opts.props).toEqual({ sub: '123', email: 'kim@gmail.com', name: 'Kim', picture: 'p.png' })
    expect(kv.store.has(`gstate:${state}`)).toBe(false) // single use
  })

  it('refuses unknown state, replayed state, cancelled sign-ins, bad codes, unverified or disallowed accounts', async () => {
    expect((await handleAuth(new Request('https://w/callback?state=nope&code=good-code'), env, googleFetch({}))).status).toBe(400)
    expect((await handleAuth(new Request('https://w/callback?error=access_denied'), env, googleFetch({}))).status).toBe(400)

    let state = await start()
    expect((await handleAuth(new Request(`https://w/callback?state=${state}&code=bad-code`), env, googleFetch({}))).status).toBe(502)

    state = await start()
    expect((await handleAuth(new Request(`https://w/callback?state=${state}&code=good-code`), env, googleFetch({ sub: '1', email: 'x@y.z', email_verified: false }))).status).toBe(403)

    state = await start()
    const strict = { ...env, ALLOWED_EMAIL_DOMAINS: 'studio.example' }
    expect((await handleAuth(new Request(`https://w/callback?state=${state}&code=good-code`), strict, googleFetch({ sub: '1', email: 'x@gmail.com', email_verified: true }))).status).toBe(403)
    expect(completed).toHaveLength(0)
  })

  it('falls back to the e-mail local part when Google sends no name', async () => {
    const state = await start()
    await handleAuth(new Request(`https://w/callback?state=${state}&code=good-code`), env, googleFetch({ sub: '9', email: 'nameless@gmail.com', email_verified: true }))
    expect((completed[0] as { props: Identity }).props.name).toBe('nameless')
  })
})

describe('route with a signed-in identity', () => {
  let deps: SyncDeps
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  const renv = { TEAM_TOKEN: 'secret' } as unknown as Env
  beforeEach(() => { deps = { meta: new MemoryMeta(), blobs: new MemoryBlobs(), maxFileBytes: 1024 * 1024 } })

  it('skips the team-token check and records the person as the author', async () => {
    const who: Identity = { sub: '123', email: 'kim@gmail.com', name: 'Kim' }
    const put = await route(new Request('https://w/v1/file?path=notes/Hi.md', { method: 'PUT', headers: { 'x-mtime': '1700000000000', 'x-author': 'spoofed' }, body: 'hello' }), renv, ctx, deps, who)
    expect(put.status).toBe(201)
    expect(((await put.json()) as { author: string }).author).toBe('Kim')
    const me = await (await route(new Request('https://w/v1/me'), renv, ctx, deps, who)).json() as { email: string; author: string; service: boolean }
    expect(me).toMatchObject({ email: 'kim@gmail.com', author: 'Kim', service: false })
  })

  it('a service identity (team token) names itself through X-Author', async () => {
    const svc: Identity = { sub: 'service', email: '', name: encodeURIComponent('슬랙봇') === 'x' ? '' : '슬랙봇', service: true }
    const put = await route(new Request('https://w/v1/file?path=notes/Bot.md', { method: 'PUT', headers: { 'x-mtime': '1700000000000' }, body: 'hi' }), renv, ctx, deps, svc)
    expect(((await put.json()) as { author: string }).author).toBe('슬랙봇')
    // and without an identity the team token still works, author from the header
    const legacy = await route(new Request('https://w/v1/me', { headers: { authorization: 'Bearer secret', 'x-author': encodeURIComponent('미로') } }), renv, ctx, deps)
    expect(await legacy.json()).toMatchObject({ service: true, author: '미로' })
    expect((await route(new Request('https://w/v1/me'), renv, ctx, deps)).status).toBe(401)
  })
})
