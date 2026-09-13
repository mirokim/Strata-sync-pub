import { describe, it, expect, beforeEach } from 'vitest'
import type { SyncDeps } from '../src/sync.js'
import { invalidateVaultView } from '../src/vaultIndex.js'
import { renderInboxDoc, parseInboxDoc, sendInbox, replyInbox, readInbox, inboxFor, renderInbox, isAddressedTo } from '../src/inbox.js'
import { callTool } from '../src/mcp.js'
import { route, type Env } from '../src/index.js'
import { MemoryMeta, MemoryBlobs, dec } from './fakes.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs
const KIM = { sub: 'google|kim' }
const LEE = { sub: 'google|lee' }
const asKim = () => ({ ...deps, viewer: KIM, author: 'Kim', now: () => 1_700_000_000_000 })
const asLee = () => ({ ...deps, viewer: LEE, author: 'Lee', now: () => 1_700_000_100_000 })
const asToken = (name: string) => ({ ...deps, viewer: { sub: 'service', service: true }, author: name, now: () => 1_700_000_200_000 })

beforeEach(() => { meta = new MemoryMeta(); blobs = new MemoryBlobs(); deps = { meta, blobs, maxFileBytes: 1024 * 1024 }; invalidateVaultView() })

describe('inbox documents', () => {
  it('renders a vault document addressed by name and parses it back, replies included', () => {
    const doc = renderInboxDoc({ to: 'Lee', kind: 'question', title: 'App impact of motor_gain?', body: 'Does raising motor_gain touch the app?', about: ['design/Firmware.md'], from: 'Kim', fromSub: KIM.sub, now: 1_700_000_000_000 })
    expect(doc.path).toBe('_inbox/Lee/2023-11-14 app-impact-of-motor_gain.md')
    expect(doc.content).toContain('type: inbox')
    expect(doc.content).toContain('- [[Firmware]]')
    const item = parseInboxDoc(doc.path, doc.content + '\n## Reply — Lee, 2023-11-14T22:00:00.000Z\n\nThree files.\n')!
    expect(item).toMatchObject({ kind: 'question', status: 'open', to: 'Lee', from: 'Kim', fromSub: KIM.sub, about: ['design/Firmware.md'], title: 'App impact of motor_gain?' })
    expect(item.body).toBe('Does raising motor_gain touch the app?')
    expect(item.replies).toEqual([{ author: 'Lee', at: '2023-11-14T22:00:00.000Z', text: 'Three files.' }])
    expect(parseInboxDoc('x.md', '---\ntype: decision\n---\n# no')).toBeNull()
  })

  it('addresses by display name, and by sub when both sides have one', () => {
    expect(isAddressedTo({ to: 'lee', toSub: '' }, LEE, 'Lee')).toBe(true)
    expect(isAddressedTo({ to: 'Lee', toSub: LEE.sub }, { sub: 'google|other' }, 'Lee')).toBe(true)  // name still matches
    expect(isAddressedTo({ to: 'Lee', toSub: '' }, KIM, 'Kim')).toBe(false)
    expect(isAddressedTo({ to: 'Lee', toSub: '' }, { sub: 'service', service: true }, 'Lee')).toBe(true)
  })
})

describe('send / reply', () => {
  it('a question waits in the recipient\'s inbox until they answer with their own identity', async () => {
    const sent = await sendInbox(asKim(), { to: 'Lee', kind: 'question', title: 'Q1', body: 'why?' })
    expect(sent).toEqual({ path: '_inbox/Lee/2023-11-14 q1.md' })
    const path = (sent as { path: string }).path

    // Kim sees it as sent, Lee as waiting; a stranger sees neither
    const items = await readInbox(deps, await meta.listSince(0, 1000))
    expect(inboxFor(items, KIM, 'Kim')).toMatchObject({ forMe: [], sent: [{ path }] })
    expect(inboxFor(items, LEE, 'Lee')).toMatchObject({ forMe: [{ path, status: 'open' }], sent: [] })
    expect(inboxFor(items, { sub: 'google|park' }, 'Park')).toEqual({ forMe: [], sent: [] })

    // Kim cannot answer their own question; Lee can; the status follows the kind
    expect(await replyInbox(asKim(), path, 'me', 'answered')).toMatchObject({ error: expect.stringContaining('addressed to Lee') })
    expect(await replyInbox(asLee(), path, 'Because.', 'done')).toEqual({ path, status: 'answered' })
    const after = parseInboxDoc(path, dec((await blobs.get(path))!))!
    expect(after.status).toBe('answered')
    expect(after.replies[0]).toMatchObject({ author: 'Lee', text: 'Because.' })
    expect((await meta.get(path))!.authorSub).toBe(LEE.sub)
  })

  it('the sender may withdraw (decline) their own item; tasks finish as done; second send gets a numbered path', async () => {
    const a = await sendInbox(asKim(), { to: 'Lee', kind: 'task', title: 'Do it', body: 'please' }) as { path: string }
    const b = await sendInbox(asKim(), { to: 'Lee', kind: 'task', title: 'Do it', body: 'again' }) as { path: string }
    expect(b.path).toBe(a.path.replace(/\.md$/, '-2.md'))
    expect(await replyInbox(asKim(), a.path, 'never mind', 'declined')).toEqual({ path: a.path, status: 'declined' })
    expect(await replyInbox(asKim(), b.path, 'I did it myself', 'done')).toMatchObject({ error: expect.any(String) })
    expect(await replyInbox(asLee(), b.path, 'Done: see [[Result]]', 'answered')).toEqual({ path: b.path, status: 'done' })
    expect(await replyInbox(asLee(), 'design/Menu.md', 'x', 'done')).toEqual({ error: 'not an inbox document' })
  })

  it('team-token callers work by name', async () => {
    const sent = await sendInbox(asToken('bot'), { to: 'Kim', kind: 'question', title: 'Hi', body: '?' }) as { path: string }
    expect(await replyInbox(asToken('Kim'), sent.path, 'yes', 'answered')).toEqual({ path: sent.path, status: 'answered' })
  })

  it('renders the agent-facing summary', async () => {
    await sendInbox(asKim(), { to: 'Lee', kind: 'question', title: 'Q1', body: 'why?' })
    const items = await readInbox(deps, await meta.listSince(0, 1000))
    expect(renderInbox(inboxFor(items, LEE, 'Lee'))).toContain('## Waiting for you (1)\n- [question] **Q1** — from Kim')
    expect(renderInbox(inboxFor(items, KIM, 'Kim'))).toContain('## You are waiting on (1)')
    expect(renderInbox(inboxFor(items, { sub: 'x' }, 'Park'))).toBe('')
  })
})

describe('MCP tools and routes', () => {
  it('inbox_send → inbox_list → inbox_reply, and vault_me shows the inbox', async () => {
    const kim = { ...deps, viewer: KIM, author: 'Kim' }
    const lee = { ...deps, viewer: LEE, author: 'Lee' }
    const parse = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse((r.content[0] as { text: string }).text)
    const textOf = (r: Awaited<ReturnType<typeof callTool>>) => (r.content[0] as { text: string }).text
    const sent = parse(await callTool(kim, 'inbox_send', { to: 'Lee', title: 'Impact?', body: 'Does X affect the app?', about: ['design/Firmware.md'] }))
    expect(sent).toMatchObject({ kind: 'question', to: 'Lee', status: 'open' })
    expect(textOf(await callTool(lee, 'inbox_list', {}))).toContain('Waiting for you (1)')
    expect(textOf(await callTool(lee, 'vault_me', {}))).toContain('- Waiting for me (questions/tasks from teammates\' agents): 1')
    expect((await callTool(kim, 'inbox_reply', { path: sent.path, reply: 'nope' })).isError).toBe(true)
    expect(parse(await callTool(lee, 'inbox_reply', { path: sent.path, reply: 'Three files, see [[App]]' }))).toEqual({ path: sent.path, status: 'answered' })
    const kimMe = textOf(await callTool(kim, 'vault_me', {}))
    expect(kimMe).toContain('## Answered for you (1)')
    expect(kimMe).toContain('Lee: Three files')
    expect(textOf(await callTool(lee, 'inbox_list', {}))).toContain('Inbox empty')
  })

  it('routes: POST /v1/inbox, GET /v1/inbox, POST /v1/inbox/reply', async () => {
    const env = { TEAM_TOKEN: 'tok', ALLOWED_ORIGINS: '*' } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const kim = { sub: KIM.sub, name: 'Kim', email: 'kim@x.y' } as never
    const lee = { sub: LEE.sub, name: 'Lee', email: 'lee@x.y' } as never
    const post = (path: string, body: unknown, who: never) => route(new Request(`https://w${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), env, ctx, deps, who)
    const created = await post('/v1/inbox', { to: 'Lee', kind: 'task', title: 'Check', body: 'please' }, kim)
    expect(created.status).toBe(201)
    const { path } = await created.json() as { path: string }
    const list = await (await route(new Request('https://w/v1/inbox'), env, ctx, deps, lee)).json() as { forMe: { path: string }[] }
    expect(list.forMe.map(i => i.path)).toEqual([path])
    expect((await post('/v1/inbox/reply', { path, reply: 'x' }, kim)).status).toBe(403)
    expect((await post('/v1/inbox/reply', { path: '_inbox/Lee/nope.md', reply: 'x' }, lee)).status).toBe(404)
    const done = await post('/v1/inbox/reply', { path, reply: 'done', status: 'done' }, lee)
    expect(await done.json()).toEqual({ path, status: 'done' })
  })
})
