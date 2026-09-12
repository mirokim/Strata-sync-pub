import { describe, it, expect, beforeEach } from 'vitest'
import { putFile, type SyncDeps } from '../src/sync.js'
import { canSee, personalRoot, toPersonalPath, splitPersonal, setVisibility, PERSONAL_PREFIX } from '../src/personal.js'
import { callTool, type McpDeps } from '../src/mcp.js'
import { invalidateVaultView } from '../src/vaultIndex.js'
import { runNightly } from '../src/nightly.js'
import { route, type Env } from '../src/index.js'
import type { Identity } from '../src/auth.js'
import { MemoryMeta, MemoryBlobs, enc, dec } from './fakes.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs

const kim: Identity = { sub: '1001', email: 'kim@x.io', name: 'kim', service: false }
const lee: Identity = { sub: '2002', email: 'lee@x.io', name: 'lee', service: false }
const KIM = `${PERSONAL_PREFIX}1001/`

beforeEach(async () => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs()
  deps = { meta, blobs, maxFileBytes: 1024 * 1024 }
  invalidateVaultView()
  await putFile({ ...deps, now: () => 1_000 }, { path: 'design/Stamina.md', body: enc('# Stamina\n\nteam doc, regen 5/s'), mtime: 1, author: 'lee' })
  await putFile({ ...deps, now: () => 1_000 }, { path: `${KIM}design/Stamina rethink.md`, body: enc('# Stamina rethink\n\nWhat if regen scaled with [[Stamina]]? half-baked, regen idea'), mtime: 1, author: 'kim' })
  invalidateVaultView()
})

const parse = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse((r.content[0] as { text: string }).text)
const textOf = (r: Awaited<ReturnType<typeof callTool>>) => (r.content[0] as { text: string }).text
const mcp = (id: Identity): McpDeps => ({ ...deps, author: id.name, viewer: { sub: id.sub, service: id.service } })
const service = (): McpDeps => ({ ...deps, author: 'service', viewer: { sub: 'service', service: true } })

describe('personal paths', () => {
  it('owner-only visibility; the team token owns nothing', () => {
    expect(personalRoot({ sub: '1001' })).toBe(KIM)
    expect(personalRoot({ sub: 'service', service: true })).toBeNull()
    expect(toPersonalPath({ sub: '1001' }, 'design/A.md')).toBe(`${KIM}design/A.md`)
    expect(toPersonalPath({ sub: '1001' }, `${KIM}design/A.md`)).toBeNull()
    expect(splitPersonal(`${KIM}design/A.md`)).toEqual({ owner: '1001', path: 'design/A.md' })
    expect(canSee('design/A.md', undefined)).toBe(true)
    expect(canSee(`${KIM}design/A.md`, { sub: '1001' })).toBe(true)
    expect(canSee(`${KIM}design/A.md`, { sub: '2002' })).toBe(false)
    expect(canSee(`${KIM}design/A.md`, { sub: 'service', service: true })).toBe(false)
    expect(personalRoot({ sub: 'a b/c' })).toBe(`${PERSONAL_PREFIX}a-b-c/`)
  })
})

describe('MCP tools respect the viewer', () => {
  it('list, search, recall, changes, read and history show personal documents to their owner only', async () => {
    expect(parse(await callTool(mcp(kim), 'vault_list', {})).items.map((i: { path: string; personal?: boolean }) => [i.path, i.personal])).toEqual([[`${KIM}design/Stamina rethink.md`, true], ['design/Stamina.md', undefined]])
    expect(parse(await callTool(mcp(lee), 'vault_list', {})).items.map((i: { path: string }) => i.path)).toEqual(['design/Stamina.md'])
    expect(parse(await callTool(service(), 'vault_list', {})).total).toBe(1)

    expect(parse(await callTool(mcp(kim), 'vault_search', { query: 'regen idea' })).results.map((r: { path: string }) => r.path)).toContain(`${KIM}design/Stamina rethink.md`)
    expect(parse(await callTool(mcp(lee), 'vault_search', { query: 'regen idea' })).results.map((r: { path: string }) => r.path)).toEqual(['design/Stamina.md'])

    const kimRecall = textOf(await callTool(mcp(kim), 'vault_recall', { query: 'regen', neighbours: 3 }))
    expect(kimRecall).toContain('Stamina rethink')
    expect(kimRecall).toContain('_(personal — only you see this)_')
    expect(textOf(await callTool(mcp(lee), 'vault_recall', { query: 'regen', neighbours: 3 }))).not.toContain('rethink')

    expect(parse(await callTool(mcp(lee), 'vault_changes', { since: '0' })).changes.map((c: { path: string }) => c.path)).toEqual(['design/Stamina.md'])
    expect(parse(await callTool(mcp(kim), 'vault_changes', { since: '0' })).changes).toHaveLength(2)
    expect((await callTool(mcp(lee), 'vault_read', { path: `${KIM}design/Stamina rethink.md` })).isError).toBe(true)
    expect(textOf(await callTool(mcp(kim), 'vault_read', { path: `${KIM}design/Stamina rethink.md` }))).toContain('half-baked')
    expect((await callTool(mcp(lee), 'vault_history', { path: `${KIM}design/Stamina rethink.md` })).isError).toBe(true)
    expect(textOf(await callTool(mcp(lee), 'graph_lint', { format: 'markdown' }))).not.toContain('rethink')
  })

  it('vault_write personal=true lands in the caller\'s space; the team token cannot; others cannot write into it', async () => {
    const w = parse(await callTool(mcp(kim), 'vault_write', { path: 'ideas/Loot.md', content: '# Loot\n\nmaybe', personal: true }))
    expect(w).toEqual({ path: `${KIM}ideas/Loot.md`, status: 'created', personal: true })
    expect((await callTool(service(), 'vault_write', { path: 'ideas/Loot.md', content: 'x', personal: true })).isError).toBe(true)
    expect((await callTool(mcp(lee), 'vault_write', { path: `${KIM}ideas/Loot.md`, content: 'hijack' })).isError).toBe(true)
    expect(dec(blobs.objects.get(`${KIM}ideas/Loot.md`)!)).toContain('maybe')
  })

  it('vault_visibility publishes and withdraws, refusing withdrawal once others have saved', async () => {
    const pub = parse(await callTool(mcp(kim), 'vault_visibility', { path: `${KIM}design/Stamina rethink.md`, personal: false }))
    expect(pub).toEqual({ from: `${KIM}design/Stamina rethink.md`, path: 'design/Stamina rethink.md', personal: false })
    expect(meta.rows.get(`${KIM}design/Stamina rethink.md`)!.deleted).toBe(true)
    expect(meta.rows.get('design/Stamina rethink.md')!.author).toBe('kim')
    expect(parse(await callTool(mcp(lee), 'vault_list', {})).total).toBe(2)   // now everyone sees it
    // kim alone has saved it → may take it back
    const back = parse(await callTool(mcp(kim), 'vault_visibility', { path: 'design/Stamina rethink.md', personal: true }))
    expect(back.path).toBe(`${KIM}design/Stamina rethink.md`)
    // lee saved the team doc → kim cannot make it personal
    expect((await callTool(mcp(kim), 'vault_visibility', { path: 'design/Stamina.md', personal: true })).isError).toBe(true)
    expect(textOf(await callTool(mcp(kim), 'vault_visibility', { path: 'design/Stamina.md', personal: true }))).toContain('lee')
    // publishing onto an existing team path is refused
    await putFile(deps, { path: 'design/Stamina rethink.md', body: enc('# taken'), mtime: 2, author: 'lee' })
    expect(textOf(await callTool(mcp(kim), 'vault_visibility', { path: `${KIM}design/Stamina rethink.md`, personal: false }))).toContain('already exists')
    expect((await callTool(service(), 'vault_visibility', { path: 'design/Stamina.md', personal: true })).isError).toBe(true)
  })
})

describe('HTTP routes respect the viewer', () => {
  const env = { TEAM_TOKEN: 'secret' } as unknown as Env
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  const as = (id: Identity | undefined, path: string, init: RequestInit = {}) => route(new Request(`https://w${path}`, { ...init, headers: { authorization: 'Bearer secret', ...(init.headers as Record<string, string> | undefined) } }), env, ctx, deps, id)

  it('docs, manifest, file and history hide other people\'s personal documents', async () => {
    const kimDocs = await (await as(kim, '/v1/docs?after=0&limit=100')).json() as { docs: { path: string }[] }
    expect(kimDocs.docs.map(d => d.path).sort()).toEqual([`${KIM}design/Stamina rethink.md`, 'design/Stamina.md'])
    const leeDocs = await (await as(lee, '/v1/docs?after=0&limit=100')).json() as { docs: { path: string }[] }
    expect(leeDocs.docs.map(d => d.path)).toEqual(['design/Stamina.md'])
    const tokenManifest = await (await as(undefined, '/v1/manifest?since=0')).json() as { files: { path: string }[] }
    expect(tokenManifest.files.map(f => f.path)).toEqual(['design/Stamina.md'])
    expect((await as(lee, `/v1/file?path=${encodeURIComponent(KIM + 'design/Stamina rethink.md')}`)).status).toBe(404)
    expect((await as(kim, `/v1/file?path=${encodeURIComponent(KIM + 'design/Stamina rethink.md')}`)).status).toBe(200)
    expect((await as(lee, `/v1/file?path=${encodeURIComponent(KIM + 'x.md')}`, { method: 'PUT', headers: { 'x-mtime': '1' }, body: 'x' })).status).toBe(403)
    expect((await as(undefined, `/v1/file?path=${encodeURIComponent(KIM + 'x.md')}`, { method: 'PUT', headers: { 'x-mtime': '1' }, body: 'x' })).status).toBe(403)
    expect((await as(kim, `/v1/file?path=${encodeURIComponent(KIM + 'x.md')}`, { method: 'PUT', headers: { 'x-mtime': '1' }, body: 'x' })).status).toBe(201)
    expect((await as(lee, `/v1/history?path=${encodeURIComponent(KIM + 'design/Stamina rethink.md')}`)).status).toBe(404)
  })

  it('POST /v1/visibility moves the document', async () => {
    const res = await as(kim, '/v1/visibility', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: `${KIM}design/Stamina rethink.md`, personal: false }) })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { path: string }).path).toBe('design/Stamina rethink.md')
    expect((await as(kim, '/v1/visibility', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"path":1}' })).status).toBe(400)
    expect((await as(undefined, '/v1/visibility', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'design/Stamina.md', personal: true }) })).status).toBe(400)
  })
})

describe('nightly batch', () => {
  it('lints and embeds team documents only', async () => {
    const embedded: string[] = []
    const r = await runNightly({ ...deps, embed: async (texts: string[]) => texts.map(() => [0.1]), vectors: { upsert: async (items: { id: string }[]) => { embedded.push(...items.map(i => i.id)) }, deleteByIds: async () => {} } as never, log: () => {} } as never, 'manual')
    expect(r).toBeTruthy()
    expect(embedded.some(id => id.includes('rethink'))).toBe(false)
    const report = [...blobs.objects.entries()].find(([k]) => k.startsWith('_reports/'))
    expect(report && dec(report[1])).not.toContain('rethink')
  })
})
