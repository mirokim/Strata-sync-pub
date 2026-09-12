import { describe, it, expect, beforeEach } from 'vitest'
import { allowedOrigin, corsHeaders, preflight, withCors } from '../src/cors.js'
import { tokenize, Bm25, loadVaultView, invalidateVaultView } from '../src/vaultIndex.js'
import { callTool, handleMcpRequest, type McpDeps } from '../src/mcp.js'
import { route, type Env } from '../src/index.js'
import { putFile, type SyncDeps } from '../src/sync.js'
import { parseVaultDoc } from '../../mcp/src/lint/vaultDoc.js'
import { MemoryMeta, MemoryBlobs, enc } from './fakes.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs

beforeEach(() => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs()
  deps = { meta, blobs, maxFileBytes: 1024 * 1024 }
  invalidateVaultView() // the view cache is isolate-global and keyed on the seq head, which restarts at 0 here
})

const put = (path: string, text: string) => putFile(deps, { path, body: enc(text), mtime: 1_700_000_000_000, author: 'miro' })

async function seedVault() {
  await put('active/Combat System.md', '# Combat System\n\nMelee combat and [[Stamina]] costs. Links to [[Enemy AI]].\n')
  await put('active/Enemy AI.md', '# Enemy AI\n\nBehaviour trees for enemies; reacts to the [[Combat System]].\n')
  await put('active/Stamina.md', '---\ntags: [system]\n---\n# Stamina\n\nStamina regenerates out of combat. 전투 시스템과 연결.\n')
  await put('assets/logo.png', 'not-a-markdown-file')
}

// ── CORS ─────────────────────────────────────────────────────────────────────

describe('cors', () => {
  it('matches origins against the allowlist, or everything for *', () => {
    expect(allowedOrigin('https://app.vercel.app', 'https://app.vercel.app, https://strata.example')).toBe('https://app.vercel.app')
    expect(allowedOrigin('https://evil.example', 'https://app.vercel.app')).toBeNull()
    expect(allowedOrigin('https://anything.example', '*')).toBe('https://anything.example')
    expect(allowedOrigin('https://app.vercel.app', undefined)).toBeNull()
    expect(allowedOrigin(null, '*')).toBeNull()
  })
  it('emits no headers for non-browser requests', () => {
    expect(corsHeaders(null, '*')).toEqual({})
  })
  it('preflight: 204 with the headers the sync/MCP clients need, 403 for a foreign origin', async () => {
    const ok = preflight(new Request('https://w/v1/file', { method: 'OPTIONS', headers: { origin: 'https://app.vercel.app' } }), 'https://app.vercel.app')
    expect(ok.status).toBe(204)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.vercel.app')
    for (const h of ['If-Match', 'If-None-Match', 'X-Mtime', 'X-Author', 'Authorization', 'Mcp-Session-Id']) {
      expect(ok.headers.get('access-control-allow-headers')).toContain(h)
    }
    for (const h of ['ETag', 'X-Seq', 'X-Mtime']) expect(ok.headers.get('access-control-expose-headers')).toContain(h)
    expect(ok.headers.get('vary')).toBe('Origin')

    const denied = preflight(new Request('https://w/v1/file', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }), 'https://app.vercel.app')
    expect(denied.status).toBe(403)
  })
  it('withCors keeps status, body and existing headers, and adds CORS ones', async () => {
    const res = new Response('{"a":1}', { status: 201, headers: { etag: '"x"', 'content-type': 'application/json' } })
    const out = withCors(res, new Request('https://w/v1/file', { headers: { origin: 'https://o.example' } }), '*')
    expect(out.status).toBe(201)
    expect(out.headers.get('etag')).toBe('"x"')
    expect(out.headers.get('access-control-allow-origin')).toBe('https://o.example')
    expect(await out.text()).toBe('{"a":1}')
  })
  it('withCors returns the response untouched when no origin is present', () => {
    const res = new Response('x')
    expect(withCors(res, new Request('https://w/v1/file'), '*')).toBe(res)
  })
})

// ── Tokeniser + BM25 ─────────────────────────────────────────────────────────

describe('tokenize', () => {
  it('lowercases latin words, drops single characters, and bigrams hangul runs', () => {
    expect(tokenize('Combat System v2')).toEqual(['combat', 'system', 'v2'])
    expect(tokenize('a I')).toEqual([])
    expect(tokenize('전투시스템')).toEqual(['전투시스템', '전투', '투시', '시스', '스템'])
    expect(tokenize('전투')).toEqual(['전투'])
  })
})

describe('Bm25', () => {
  const docs = new Map([
    ['a.md', parseVaultDoc('a.md', '# Combat System\n\nMelee combat, stamina, hit reactions.', 1)],
    ['b.md', parseVaultDoc('b.md', '# Enemy AI\n\nBehaviour trees for enemies.', 1)],
    ['c.md', parseVaultDoc('c.md', '# 전투 밸런스\n\n전투시스템 수치 조정.', 1)],
  ])
  it('ranks the document mentioning the query terms first and returns ids/titles', () => {
    const hits = new Bm25(docs).search('combat stamina')
    expect(hits[0].path).toBe('a.md')
    expect(hits[0].title).toBe('a') // title falls back to the file name when there is no frontmatter title
    expect(hits[0].docId).toBe('a')
    expect(hits.find(h => h.path === 'b.md')).toBeUndefined()
  })
  it('matches compound hangul through bigrams', () => {
    const hits = new Bm25(docs).search('전투')
    expect(hits[0].path).toBe('c.md')
  })
  it('honours exclude and topK, and returns nothing for an empty query', () => {
    const idx = new Bm25(docs)
    expect(idx.search('combat enemies', 5, new Set(['a.md'])).map(h => h.path)).toEqual(['b.md'])
    expect(idx.search('combat enemies', 1)).toHaveLength(1)
    expect(idx.search('   ')).toEqual([])
  })
})

// ── Vault view cache ─────────────────────────────────────────────────────────

describe('loadVaultView', () => {
  it('parses live markdown only, and refreshes when the sequence head moves', async () => {
    await seedVault()
    const v1 = await loadVaultView(deps)
    expect([...v1.docs.keys()].sort()).toEqual(['active/Combat System.md', 'active/Enemy AI.md', 'active/Stamina.md'])
    expect(v1.rows.has('assets/logo.png')).toBe(true)
    expect(v1.docs.get('active/Stamina.md')!.tags).toEqual(['system'])

    expect(await loadVaultView(deps)).toBe(v1) // same head → cached object

    await put('active/New.md', '# New\n')
    const v2 = await loadVaultView(deps)
    expect(v2).not.toBe(v1)
    expect(v2.docs.has('active/New.md')).toBe(true)
    // unchanged documents are reused, not re-parsed
    expect(v2.docs.get('active/Combat System.md')).toBe(v1.docs.get('active/Combat System.md'))
  })
})

// ── MCP tools ────────────────────────────────────────────────────────────────

const parse = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse((r.content[0] as { text: string }).text)
const textOf = (r: Awaited<ReturnType<typeof callTool>>) => (r.content[0] as { text: string }).text

describe('callTool', () => {
  let mdeps: McpDeps
  beforeEach(async () => { await seedVault(); mdeps = { ...deps, author: 'tester' } })

  it('vault_list lists markdown only, filtered by folder and capped by limit', async () => {
    const all = parse(await callTool(mdeps, 'vault_list', {}))
    expect(all.total).toBe(3)
    expect(all.items.map((i: { path: string }) => i.path)).toEqual(['active/Combat System.md', 'active/Enemy AI.md', 'active/Stamina.md'])
    expect(all.items[2].tags).toEqual(['system'])
    const limited = parse(await callTool(mdeps, 'vault_list', { folder: '/active/', limit: 1 }))
    expect(limited.count).toBe(1)
    expect(parse(await callTool(mdeps, 'vault_list', { folder: 'nope' })).count).toBe(0)
  })

  it('vault_read returns the content, and an error result for unknown or bad paths', async () => {
    expect(textOf(await callTool(mdeps, 'vault_read', { path: 'active/Stamina.md' }))).toContain('# Stamina')
    const missing = await callTool(mdeps, 'vault_read', { path: 'active/Missing.md' })
    expect(missing.isError).toBe(true)
    expect(textOf(missing)).toContain('not found')
    expect((await callTool(mdeps, 'vault_read', { path: '../etc/passwd' })).isError).toBe(true)
  })

  it('vault_search fuses BM25 with semantic hits by rank and flags proposals', async () => {
    await callTool(mdeps, 'vault_propose', { title: 'Combat idea', body: 'A combat proposal about parry' })
    const bm = parse(await callTool(mdeps, 'vault_search', { query: 'combat stamina' }))
    expect(bm.semantic).toBe(false)
    // both documents carry the terms; the file-name-boosted one may win, but both must lead
    expect(bm.results.slice(0, 2).map((r: { path: string }) => r.path).sort()).toEqual(['active/Combat System.md', 'active/Stamina.md'])
    expect(bm.results.find((r: { path: string }) => r.path.startsWith('_agent/'))?.proposal).toBe(true)
    expect(bm.results[0].snippet.length).toBeLessThanOrEqual(240)

    const withSemantic: McpDeps = { ...mdeps, semanticSearch: async () => [{ path: 'active/Enemy AI.md', score: 0.9, chunk: 'x', title: 'Enemy AI' } as never] }
    const fused = parse(await callTool(withSemantic, 'vault_search', { query: 'combat', topK: 2 }))
    expect(fused.semantic).toBe(true)
    expect(fused.results).toHaveLength(2)
    expect(fused.results.map((r: { path: string }) => r.path)).toContain('active/Enemy AI.md')

    expect((await callTool(mdeps, 'vault_search', { query: '  ' })).isError).toBe(true)
  })

  it('vault_search survives a failing semantic backend', async () => {
    const broken: McpDeps = { ...mdeps, semanticSearch: async () => { throw new Error('vectorize down') } }
    const r = parse(await callTool(broken, 'vault_search', { query: 'combat' }))
    expect(r.semantic).toBe(false)
    expect(r.results.length).toBeGreaterThan(0)
  })

  it('graph_lint reports the phantom link and honours rule/format options', async () => {
    const r = parse(await callTool(mdeps, 'graph_lint', {}))
    expect(r.snapshot).toBeUndefined()
    expect(r.docCount).toBe(3)
    expect(r.phantomCount).toBe(0)
    const md = textOf(await callTool(mdeps, 'graph_lint', { format: 'markdown', rules: ['orphan'] }))
    expect(md).toContain('#')
    const only = parse(await callTool(mdeps, 'graph_lint', { rules: ['orphan', 'bogus-rule'] }))
    for (const f of only.findings) expect(f.rule).toBe('orphan')
  })

  it('graph_suggest_links ranks vault documents and never suggests proposals', async () => {
    await callTool(mdeps, 'vault_propose', { title: 'Enemy proposal', body: 'enemies enemies enemies behaviour trees' })
    const r = parse(await callTool(mdeps, 'graph_suggest_links', { text: 'behaviour trees for enemies', topK: 3 }))
    expect(r.suggestions[0].path).toBe('active/Enemy AI.md')
    expect(r.suggestions[0].docId).toBe('active_enemy_ai')
    expect(r.suggestions.some((s: { path: string }) => s.path.startsWith('_agent/'))).toBe(false)
    expect((await callTool(mdeps, 'graph_suggest_links', { text: '' })).isError).toBe(true)
  })

  it('vault_propose writes to _agent/ with frontmatter, numbers duplicates, and lists them', async () => {
    const a = parse(await callTool(mdeps, 'vault_propose', { title: 'Parry window', body: 'Add a parry window.', tags: ['combat'], links: ['Combat System'] }))
    expect(a.path).toMatch(/^_agent\/\d{4}-\d{2}-\d{2}-parry-window\.md$/)
    const content = new TextDecoder().decode((await blobs.get(a.path))!)
    expect(content).toContain('proposed_by: agent')
    expect(content).toContain('proposed_source: "tester"')
    expect(content).toContain('[[Combat System]]')
    expect(meta.rows.get(a.path)!.author).toBe('tester')

    const b = parse(await callTool(mdeps, 'vault_propose', { title: 'Parry window', body: 'Second take.' }))
    expect(b.path).toBe(a.path.replace(/\.md$/, '-2.md'))

    const list = parse(await callTool(mdeps, 'vault_proposals', {}))
    expect(list.proposals.map((p: { path: string }) => p.path).sort()).toEqual([a.path, b.path].sort())
    expect((await callTool(mdeps, 'vault_propose', { title: 'x', body: '' })).isError).toBe(true)
  })

  it('vault_promote moves a proposal out of _agent/, strips frontmatter and refuses collisions', async () => {
    const a = parse(await callTool(mdeps, 'vault_propose', { title: 'Dodge roll', body: 'Add a dodge roll.' }))
    const r = parse(await callTool(mdeps, 'vault_promote', { path: a.path, destFolder: 'active' }))
    expect(r.to).toBe('active/dodge-roll.md') // date prefix dropped, slug kept
    const promoted = new TextDecoder().decode((await blobs.get('active/dodge-roll.md'))!)
    expect(promoted).not.toContain('proposed_by')
    expect(promoted).toContain('Add a dodge roll.')
    expect(meta.rows.get(a.path)!.deleted).toBe(true)
    expect(parse(await callTool(mdeps, 'vault_proposals', {})).proposals).toEqual([])

    // collision with an existing vault doc
    await callTool(mdeps, 'vault_write', { path: 'active/taken.md', content: 'x' })
    const b = parse(await callTool(mdeps, 'vault_propose', { title: 'Taken', body: 'dup' }))
    const denied = await callTool(mdeps, 'vault_promote', { path: b.path, destFolder: 'active' })
    expect(denied.isError).toBe(true)
    expect(meta.rows.get(b.path)!.deleted).toBe(false) // the proposal is kept

    expect((await callTool(mdeps, 'vault_promote', { path: 'active/Stamina.md' })).isError).toBe(true)
    expect((await callTool(mdeps, 'vault_promote', { path: '_agent' })).isError).toBe(true)
  })

  it('vault_write creates, replaces and reports unchanged; rejects non-markdown', async () => {
    expect(parse(await callTool(mdeps, 'vault_write', { path: 'active/Notes.md', content: 'v1' })).status).toBe('created')
    expect(parse(await callTool(mdeps, 'vault_write', { path: 'active/Notes.md', content: 'v1' })).status).toBe('unchanged')
    expect(parse(await callTool(mdeps, 'vault_write', { path: 'active/Notes.md', content: 'v2' })).status).toBe('replaced')
    expect(meta.rows.get('active/Notes.md')!.author).toBe('tester')
    expect((await callTool(mdeps, 'vault_write', { path: 'active/x.png', content: 'v' })).isError).toBe(true)
    expect((await callTool(mdeps, 'vault_write', { path: '.strata-sync/x.md', content: 'v' })).isError).toBe(true)
  })

  it('unknown tools return an error result instead of throwing', async () => {
    const r = await callTool(mdeps, 'nope', {})
    expect(r.isError).toBe(true)
  })
})

// ── MCP over Streamable HTTP ─────────────────────────────────────────────────

function rpc(body: unknown, extra: Record<string, string> = {}): Request {
  return new Request('https://w/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extra },
    body: JSON.stringify(body),
  })
}

describe('handleMcpRequest', () => {
  beforeEach(seedVault)

  it('answers initialize, tools/list and tools/call as plain JSON without a session', async () => {
    const init = await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } }), deps)
    expect(init.status).toBe(200)
    expect(init.headers.get('content-type')).toContain('application/json')
    expect(init.headers.get('mcp-session-id')).toBeNull()
    const initBody = await init.json() as { result: { serverInfo: { name: string }; capabilities: { tools: unknown } } }
    expect(initBody.result.serverInfo.name).toBe('strata-sync-cloud')
    expect(initBody.result.capabilities.tools).toBeDefined()

    const list = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), deps)).json() as { result: { tools: { name: string }[] } }
    expect(list.result.tools.map(t => t.name).sort()).toEqual([
      'graph_lint', 'graph_suggest_links', 'vault_list', 'vault_promote', 'vault_proposals', 'vault_propose', 'vault_read', 'vault_search', 'vault_write',
    ])

    const call = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'vault_read', arguments: { path: 'active/Stamina.md' } } }), deps)).json() as { result: { content: { text: string }[] } }
    expect(call.result.content[0].text).toContain('# Stamina')
  })

  it('reports tool failures as isError results, not JSON-RPC errors', async () => {
    const res = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'vault_read', arguments: { path: 'nope.md' } } }), deps)).json() as { result: { isError: boolean } }
    expect(res.result.isError).toBe(true)
  })

  it('rejects GET (no SSE streams in stateless mode) and malformed bodies', async () => {
    const get = await handleMcpRequest(new Request('https://w/mcp', { headers: { accept: 'text/event-stream' } }), deps)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    expect((await handleMcpRequest(new Request('https://w/mcp', { method: 'DELETE' }), deps)).status).toBe(405)
    const bad = await handleMcpRequest(new Request('https://w/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{not json' }), deps)
    expect(bad.status).toBe(400)
  })
})

// ── HTTP routes (web client + bots) ──────────────────────────────────────────

const env = { TEAM_TOKEN: 'secret', ALLOWED_ORIGINS: '*' } as unknown as Env
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
const auth = { authorization: 'Bearer secret' }
const call = (path: string, init: RequestInit = {}) => route(new Request(`https://w${path}`, { ...init, headers: { ...auth, ...(init.headers as Record<string, string> | undefined) } }), env, ctx, deps)

describe('routes', () => {
  beforeEach(seedVault)

  it('guards /mcp and /v1/* with the team token', async () => {
    expect((await route(new Request('https://w/v1/docs'), env, ctx, deps)).status).toBe(401)
    expect((await route(new Request('https://w/mcp', { method: 'POST' }), env, ctx, deps)).status).toBe(401)
    expect((await route(new Request('https://w/health'), env, ctx, deps)).status).toBe(200)
    expect((await route(new Request('https://w/other'), env, ctx, deps)).status).toBe(404)
  })

  it('GET /v1/docs pages by sequence, includes markdown content and omits binary content', async () => {
    const p1 = await (await call('/v1/docs?limit=2')).json() as { head: number; next: number | null; docs: { path: string; seq: number; content: string | null }[] }
    expect(p1.head).toBe(4)
    expect(p1.docs.map(d => d.path)).toEqual(['active/Combat System.md', 'active/Enemy AI.md'])
    expect(p1.docs[0].content).toContain('# Combat System')
    expect(p1.next).toBe(2)

    const p2 = await (await call(`/v1/docs?after=${p1.next}&limit=2`)).json() as typeof p1
    expect(p2.docs.map(d => d.path)).toEqual(['active/Stamina.md', 'assets/logo.png'])
    expect(p2.docs[1].content).toBeNull()
    expect(p2.next).toBe(4) // a full page → the client asks once more and gets an empty page

    const p3 = await (await call(`/v1/docs?after=${p2.next}`)).json() as typeof p1
    expect(p3.docs).toEqual([])
    expect(p3.next).toBeNull()
  })

  it('GET /v1/docs reports tombstones with null content and validates `after`', async () => {
    await call('/v1/file?path=active/Enemy%20AI.md', { method: 'DELETE' })
    const res = await (await call('/v1/docs?after=4')).json() as { docs: { path: string; deleted: boolean; content: null }[] }
    expect(res.docs).toHaveLength(1)
    expect(res.docs[0].deleted).toBe(true)
    expect(res.docs[0].content).toBeNull()
    expect((await call('/v1/docs?after=-1')).status).toBe(400)
    expect((await call('/v1/docs?after=abc')).status).toBe(400)
  })

  it('POST /v1/propose stores a proposal attributed to X-Author and validates input', async () => {
    const res = await call('/v1/propose', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-author': encodeURIComponent('슬랙봇') },
      body: JSON.stringify({ title: 'From Slack', body: 'An idea from chat', tags: ['slack'], source: 'slack:#design' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { path: string; title: string }
    expect(body.path).toMatch(/^_agent\/.*from-slack\.md$/)
    expect(meta.rows.get(body.path)!.author).toBe('슬랙봇')
    const content = new TextDecoder().decode((await blobs.get(body.path))!)
    expect(content).toContain('proposed_source: "slack:#design"')

    expect((await call('/v1/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }) })).status).toBe(400)
    expect((await call('/v1/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'garbage' })).status).toBe(400)
  })

  it('/mcp is reachable through the router with the same token', async () => {
    const res = await call('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'vault_list', arguments: {} } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { result: { content: { text: string }[] } }
    expect(JSON.parse(body.result.content[0].text).total).toBe(3)
  })
})
