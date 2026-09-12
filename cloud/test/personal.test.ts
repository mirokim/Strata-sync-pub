import { describe, it, expect, beforeEach } from 'vitest'
import { putFile, deleteFile, type SyncDeps } from '../src/sync.js'
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

describe('setVisibility edge cases', () => {
  const asKim = { sub: '1001' }

  it('refuses non-documents, no-op directions, other people\'s paths and the team token', async () => {
    await putFile(deps, { path: 'assets/logo.png', body: enc('PNG'), mtime: 1, author: 'kim' })
    const png = await setVisibility(deps, { path: 'assets/logo.png', personal: true, viewer: asKim, author: 'kim' })
    expect(png.status).toBe(400)
    expect((png.body as { error: string }).error).toMatch(/only documents/)
    // Already where it is asked to go
    const alreadyPersonal = await setVisibility(deps, { path: `${KIM}design/Stamina rethink.md`, personal: true, viewer: asKim, author: 'kim' })
    expect(alreadyPersonal).toMatchObject({ status: 400, body: { error: 'already personal' } })
    const alreadyTeam = await setVisibility(deps, { path: 'design/Stamina.md', personal: false, viewer: asKim, author: 'kim' })
    expect(alreadyTeam).toMatchObject({ status: 400, body: { error: 'already a team document' } })
    // Someone else's personal document does not exist from kim's point of view
    await putFile(deps, { path: `${PERSONAL_PREFIX}2002/design/Lee.md`, body: enc('# Lee'), mtime: 1, author: 'lee' })
    expect((await setVisibility(deps, { path: `${PERSONAL_PREFIX}2002/design/Lee.md`, personal: false, viewer: asKim, author: 'kim' })).status).toBe(404)
    // The team token has no personal space; an invalid path is rejected before any lookup
    expect((await setVisibility(deps, { path: 'design/Stamina.md', personal: true, viewer: { sub: 'service', service: true }, author: 'svc' })).status).toBe(400)
    expect((await setVisibility(deps, { path: '../x.md', personal: true, viewer: asKim, author: 'kim' })).status).toBe(400)
    // Nothing moved
    expect(meta.rows.get('assets/logo.png')!.deleted).toBe(false)
    expect(meta.rows.has(`${KIM}assets/logo.png`)).toBe(false)
  })

  it('404s on tombstones and on rows whose bytes are gone', async () => {
    await putFile(deps, { path: 'design/Gone.md', body: enc('# Gone'), mtime: 1, author: 'kim' })
    const row = await meta.get('design/Gone.md')
    await deleteFile(deps, 'design/Gone.md', row!.etag, 'kim')
    expect((await setVisibility(deps, { path: 'design/Gone.md', personal: true, viewer: asKim, author: 'kim' })).status).toBe(404)
    expect((await setVisibility(deps, { path: 'design/Missing.md', personal: true, viewer: asKim, author: 'kim' })).status).toBe(404)
    await putFile(deps, { path: 'design/Hollow.md', body: enc('# Hollow'), mtime: 1, author: 'kim' })
    blobs.objects.delete('design/Hollow.md')
    const hollow = await setVisibility(deps, { path: 'design/Hollow.md', personal: true, viewer: asKim, author: 'kim' })
    expect(hollow).toMatchObject({ status: 404, body: { error: 'content missing' } })
    expect(meta.rows.get('design/Hollow.md')!.deleted).toBe(false)     // the row is left alone
  })

  it('a colleague\'s save in the history blocks withdrawal even when the last save is the owner\'s', async () => {
    await putFile({ ...deps, now: () => 1_000 }, { path: 'design/Shared.md', body: enc('v1'), mtime: 1, author: 'kim' })
    await putFile({ ...deps, now: () => 2_000 }, { path: 'design/Shared.md', body: enc('v2 by lee'), mtime: 2, author: 'lee' })
    await putFile({ ...deps, now: () => 3_000 }, { path: 'design/Shared.md', body: enc('v3 by kim'), mtime: 3, author: 'kim' })
    expect(meta.rows.get('design/Shared.md')!.author).toBe('kim')
    const r = await setVisibility(deps, { path: 'design/Shared.md', personal: true, viewer: asKim, author: 'kim' })
    expect(r.status).toBe(403)
    expect((r.body as { error: string }).error).toContain('lee')
    expect((r.body as { error: string }).error).not.toContain('kim')
    expect(meta.rows.get('design/Shared.md')!.deleted).toBe(false)
  })

  it('a tombstone at the destination does not block the move; a live document does and is reported', async () => {
    // Tombstone: kim once had a personal copy at this path and deleted it
    await putFile(deps, { path: `${KIM}design/Stamina.md`, body: enc('# old shadow'), mtime: 1, author: 'kim' })
    await deleteFile(deps, `${KIM}design/Stamina.md`, (await meta.get(`${KIM}design/Stamina.md`))!.etag, 'kim')
    await putFile({ ...deps, now: () => 1_000 }, { path: 'design/Mine.md', body: enc('# Mine'), mtime: 7, author: 'kim' })
    const moved = await setVisibility(deps, { path: 'design/Mine.md', personal: true, viewer: asKim, author: 'kim' })
    expect(moved.status).toBe(200)
    const body = moved.body as { from: string; path: string; row: { mtime: number; author: string }; personal: boolean }
    expect(body).toMatchObject({ from: 'design/Mine.md', path: `${KIM}design/Mine.md`, personal: true })
    expect(body.row.mtime).toBe(7)                                            // the client's mtime travels with the document
    expect(meta.rows.get('design/Mine.md')!.deleted).toBe(true)
    expect(dec(blobs.objects.get(`${KIM}design/Mine.md`)!)).toBe('# Mine')
    // Live destination: kim's personal Stamina cannot be published over lee's team Stamina
    await putFile(deps, { path: `${KIM}design/Stamina.md`, body: enc('# new shadow'), mtime: 2, author: 'kim' })
    const blocked = await setVisibility(deps, { path: `${KIM}design/Stamina.md`, personal: false, viewer: asKim, author: 'kim' })
    expect(blocked.status).toBe(409)
    expect((blocked.body as { current?: { path: string } }).current?.path).toBe('design/Stamina.md')
    expect(meta.rows.get(`${KIM}design/Stamina.md`)!.deleted).toBe(false)
  })

  it('an OAuth sub with unsafe characters is sanitised consistently on both sides of the move', async () => {
    const odd = { sub: 'google|a b/c@d' }
    await putFile(deps, { path: 'design/Odd.md', body: enc('# Odd'), mtime: 1, author: 'odd' })
    const r = await setVisibility(deps, { path: 'design/Odd.md', personal: true, viewer: odd, author: 'odd' })
    expect(r.status).toBe(200)
    const dest = (r.body as { path: string }).path
    expect(dest).toBe(`${PERSONAL_PREFIX}google-a-b-c-d/design/Odd.md`)
    expect(canSee(dest, odd)).toBe(true)
    expect(canSee(dest, { sub: 'google-a-b-c-d' })).toBe(true)              // the sanitised segment is the identity the path carries
    expect(canSee(dest, { sub: 'google|a-b/c@d' })).toBe(true)              // …so two subs that sanitise alike share one space (see report)
    const back = await setVisibility(deps, { path: dest, personal: false, viewer: odd, author: 'odd' })
    expect(back.status).toBe(200)
    expect((back.body as { path: string }).path).toBe('design/Odd.md')
  })

  it('MCP vault_visibility fires the write hook only when a document is published', async () => {
    const written: string[] = []
    const hooked = (id: Identity): McpDeps => ({ ...mcp(id), onWrite: row => { written.push(row.path) } })
    await callTool(hooked(kim), 'vault_visibility', { path: `${KIM}design/Stamina rethink.md`, personal: false })
    expect(written).toEqual(['design/Stamina rethink.md'])
    await callTool(hooked(kim), 'vault_visibility', { path: 'design/Stamina rethink.md', personal: true })
    expect(written).toEqual(['design/Stamina rethink.md'])                    // withdrawing is nobody else's business
    expect((await callTool({ ...deps, author: 'x' }, 'vault_visibility', { path: 'design/Stamina.md', personal: true })).isError).toBe(true)  // no viewer at all
  })

  it('MCP vault_read hides other people\'s personal images too', async () => {
    await putFile(deps, { path: `${KIM}attachments/secret.png`, body: enc('PNG'), mtime: 1, author: 'kim' })
    expect((await callTool(mcp(lee), 'vault_read', { path: `${KIM}attachments/secret.png` })).isError).toBe(true)
    expect((await callTool(service(), 'vault_read', { path: `${KIM}attachments/secret.png` })).isError).toBe(true)
    const mine = await callTool(mcp(kim), 'vault_read', { path: `${KIM}attachments/secret.png` })
    expect(mine.isError).toBeUndefined()
    expect(mine.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect((mine.content[1] as { text: string }).text).toContain(`${KIM}attachments/secret.md`)
  })
})
