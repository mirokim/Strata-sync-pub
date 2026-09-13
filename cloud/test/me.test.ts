import { describe, it, expect, beforeEach } from 'vitest'
import { putFile, type SyncDeps } from '../src/sync.js'
import { loadVaultView, invalidateVaultView } from '../src/vaultIndex.js'
import { meOverview, renderMeOverview, isMine, guiUrlFor } from '../src/me.js'
import { callTool } from '../src/mcp.js'
import { route, type Env } from '../src/index.js'
import { MemoryMeta, MemoryBlobs, enc } from './fakes.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs
const KIM = { sub: 'google|kim' }
const LEE = { sub: 'google|lee' }

beforeEach(async () => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs()
  deps = { meta, blobs, maxFileBytes: 1024 * 1024 }
  invalidateVaultView()
  let t = 1_000
  const put = (path: string, body: string, author: string, authorSub: string) => putFile({ ...deps, now: () => (t += 1_000) }, { path, body: enc(body), mtime: t, author, authorSub })
  await put('design/Menu.md', '# Menu\n\nfood', 'Kim', KIM.sub)
  await put('design/Loot.md', '# Loot\n\nsee [[Menu]]', 'Lee', LEE.sub)
  await put('_personal/google-kim/ideas/Secret.md', '# Secret\n\nmine', 'Kim', KIM.sub)
  await put('_personal/google-lee/ideas/Hidden.md', '# Hidden\n\nlee only', 'Lee', LEE.sub)
  await put('_members/Librarian/design/Menu.md', '# remark\n\ncollides', 'strata-bot', 'service')
  await put('_agent/Rename menu.md', '---\ntype: proposal\n---\n# Rename menu\n\nabout [[Menu]] and [[Loot]]', 'agent', 'service')
  await put('legacy/Old.md', '# Old\n\nno sub', 'Kim', '')
})

const overviewFor = async (viewer: { sub: string; service?: boolean }, author: string) =>
  meOverview({ rows: await meta.listSince(0, 100_000), view: await loadVaultView(deps), viewer, author, webOrigin: 'https://strata-sync-nine.vercel.app,http://localhost:4188' })

describe('isMine / guiUrlFor', () => {
  it('matches signed-in users by sub, legacy rows by name, and the team token by name only', () => {
    expect(isMine({ author: 'Kim', authorSub: KIM.sub }, KIM, 'Kim')).toBe(true)
    expect(isMine({ author: 'Kim', authorSub: '' }, KIM, 'Kim')).toBe(true)
    expect(isMine({ author: 'Kim', authorSub: LEE.sub }, KIM, 'Kim')).toBe(false)
    expect(isMine({ author: 'Kim', authorSub: 'service' }, { sub: 'service', service: true }, 'Kim')).toBe(true)
    expect(isMine({ author: 'Kim', authorSub: 'service' }, { sub: 'service', service: true }, '')).toBe(false)
  })
  it('picks the public https origin for the GUI link', () => {
    expect(guiUrlFor('https://strata-sync-nine.vercel.app,http://localhost:4188')).toBe('https://strata-sync-nine.vercel.app/?view=me')
    expect(guiUrlFor('http://localhost:4188')).toBeNull()
    expect(guiUrlFor('*')).toBeNull()
    expect(guiUrlFor(undefined)).toBeNull()
  })
})

describe('meOverview', () => {
  it('collects my documents, my personal docs, remarks on mine, proposals citing mine, and others\' changes', async () => {
    const o = await overviewFor(KIM, 'Kim')
    expect(o.identity).toEqual({ sub: KIM.sub, author: 'Kim', service: false })
    expect(o.guiUrl).toBe('https://strata-sync-nine.vercel.app/?view=me')
    expect(o.authored.map(i => i.path)).toEqual(['legacy/Old.md', 'design/Menu.md'])
    expect(o.personal.map(i => i.path)).toEqual(['_personal/google-kim/ideas/Secret.md'])
    expect(o.remarks).toMatchObject([{ member: 'Librarian', path: 'design/Menu.md', title: 'Menu' }])
    expect(o.proposalsCitingMine).toMatchObject([{ path: '_agent/Rename menu.md', cites: ['Menu'] }])
    expect(o.recentByOthers.map(i => i.path)).toEqual(['design/Loot.md'])
    expect(o.counts).toEqual({ authored: 2, personal: 1, remarks: 1, proposalsCitingMine: 1, proposalsOpen: 1, inboxOpen: 0, inboxWaiting: 0 })
  })

  it('never shows another person\'s personal documents and sees the world from the other side', async () => {
    const o = await overviewFor(LEE, 'Lee')
    expect(o.personal.map(i => i.path)).toEqual(['_personal/google-lee/ideas/Hidden.md'])
    expect(JSON.stringify(o)).not.toContain('google-kim')
    expect(o.authored.map(i => i.path)).toEqual(['design/Loot.md'])
    expect(o.remarks).toEqual([])
    expect(o.proposalsCitingMine).toMatchObject([{ cites: ['Loot'] }])
    expect(o.recentByOthers.map(i => i.path)).toEqual(['legacy/Old.md', 'design/Menu.md'])
  })

  it('team-token callers get a name-based view without personal documents', async () => {
    const o = await overviewFor({ sub: 'service', service: true }, 'Kim')
    expect(o.identity.service).toBe(true)
    expect(o.personal).toEqual([])
    expect(o.authored.map(i => i.path)).toEqual(['legacy/Old.md', 'design/Menu.md'])
    expect(JSON.stringify(o)).not.toContain('_personal/')
  })

  it('renders markdown with the link first', async () => {
    const md = renderMeOverview(await overviewFor(KIM, 'Kim'))
    expect(md.startsWith('# My desk — Kim\n\nOpen in the app: https://strata-sync-nine.vercel.app/?view=me')).toBe(true)
    expect(md).toContain('## Remarks on my documents\n- Librarian on **Menu**')
    expect(md).toContain('## Proposals citing my documents\n- Rename menu by agent → Menu')
  })
})

describe('vault_me tool and /v1/me/overview route', () => {
  it('the MCP tool answers in markdown by default and json on request', async () => {
    const mcp = { ...deps, author: 'Kim', viewer: KIM, webOrigin: 'https://strata-sync-nine.vercel.app' }
    const md = (await callTool(mcp, 'vault_me', {})).content[0] as { text: string }
    expect(md.text).toContain('# My desk — Kim')
    expect(md.text).toContain('https://strata-sync-nine.vercel.app/?view=me')
    const json = JSON.parse(((await callTool(mcp, 'vault_me', { format: 'json' })).content[0] as { text: string }).text)
    expect(json.counts.remarks).toBe(1)
  })

  it('the route is viewer-scoped', async () => {
    const env = { TEAM_TOKEN: 'tok', ALLOWED_ORIGINS: 'https://strata-sync-nine.vercel.app' } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const res = await route(new Request('https://w/v1/me/overview'), env, ctx, deps, { sub: KIM.sub, name: 'Kim', email: 'kim@x.y' } as never)
    expect(res.status).toBe(200)
    const body = await res.json() as { authored: { path: string }[]; personal: { path: string }[]; guiUrl: string }
    expect(body.authored.map(i => i.path)).toEqual(['legacy/Old.md', 'design/Menu.md'])
    expect(body.personal).toHaveLength(1)
    expect(body.guiUrl).toBe('https://strata-sync-nine.vercel.app/?view=me')
  })
})
