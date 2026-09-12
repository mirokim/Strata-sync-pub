import { describe, it, expect, beforeEach } from 'vitest'
import {
  readMembers, saveMemberDefinitions, recordRoutineRun, dueRoutines, renderMemberPrompt, renderMemoryNote, validateMembers,
  inScope, memberNotePath, remarkPathFor, findMember, DEFAULT_MEMBER, TEMPLATES, MEMBERS_KEY, type Member,
} from '../src/members.js'
import { reactToSave, shouldEnqueueReaction, isReactablePath, readReactionState, REACTION_AUTHOR, REACTION_MIN_CHARS, type LlmCall } from '../src/reactions.js'
import { callTool, handleMcpRequest, type McpDeps } from '../src/mcp.js'
import { putFile, type SyncDeps } from '../src/sync.js'
import { invalidateVaultView } from '../src/vaultIndex.js'
import { MemoryMeta, MemoryBlobs, enc, dec } from './fakes.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs
const DAY = 86_400_000

beforeEach(() => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs()
  deps = { meta, blobs, maxFileBytes: 1024 * 1024 }
  invalidateVaultView()
})

const parse = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse((r.content[0] as { text: string }).text)
const member = (over: Partial<Member> = {}): Member => ({ ...DEFAULT_MEMBER, routines: DEFAULT_MEMBER.routines.map(r => ({ ...r, runs: [] })), ...over })

describe('members config', () => {
  it('ships the Librarian, validates edits, and keeps run history across edits', async () => {
    const c = await readMembers(deps)
    expect(c.members.map(m => m.id)).toEqual(['librarian'])
    expect(validateMembers({ members: [{ ...member(), id: 'Bad Id' }] })).toMatch(/slug/)
    expect(validateMembers({ members: [member(), { ...TEMPLATES.designer, id: 'x', name: 'librarian' }] })).toMatch(/share the note/)
    expect(validateMembers({ members: [{ ...member(), routines: [{ id: 'r', title: 't', instructions: 'i', cadence: 'hourly', enabled: true, runs: [] }] }] })).toMatch(/cadence/)
    expect(validateMembers({ version: 1, members: [] })).toBeNull()

    await recordRoutineRun(deps, 'librarian', 'contradictions', { at: 1_000, by: 'kim', summary: 'checked 3 pairs', proposals: ['_agent/a.md'] })
    const edited = await saveMemberDefinitions(deps, { version: 1, members: [{ ...c.members[0], name: 'Keeper', routines: c.members[0].routines.map(r => ({ ...r, runs: [] })) }] })
    expect(edited.members[0].name).toBe('Keeper')
    expect(edited.members[0].routines[0].runs).toHaveLength(1) // history survived the edit
    expect(blobs.objects.has(MEMBERS_KEY)).toBe(true)
    expect(await recordRoutineRun(deps, 'librarian', 'nope', { at: 1, by: 'x', summary: 's', proposals: [] })).toBeNull()
    expect(findMember(edited, 'keeper')?.id).toBe('librarian')
  })

  it('scope, note paths and due routines', () => {
    const m = member({ scope: { folders: ['design'], tags: ['ui'] } })
    expect(inScope(m, { path: 'design/Menu.md' })).toBe(true)
    expect(inScope(m, { path: 'lore/Menu.md', tags: ['UI'] })).toBe(true)
    expect(inScope(m, { path: 'lore/Menu.md', tags: ['story'] })).toBe(false)
    expect(inScope(member(), { path: 'anything/at/all.md' })).toBe(true)
    expect(memberNotePath({ name: 'Product lead' })).toBe('_members/Product lead (memory).md')
    expect(remarkPathFor({ name: 'A/B?' }, 'design\\Menu.md')).toBe('_members/A-B-/design/Menu.md')

    const now = 10 * DAY
    const run = (at: number) => [{ at, by: 'k', summary: 's', proposals: [] }]
    const mm = member({ routines: [
      { id: 'never', title: 'n', instructions: 'x', cadence: 'daily', enabled: true, runs: [] },
      { id: 'fresh', title: 'f', instructions: 'x', cadence: 'daily', enabled: true, runs: run(now - 2 * 3_600_000) },
      { id: 'old', title: 'o', instructions: 'x', cadence: 'daily', enabled: true, runs: run(now - DAY) },
      { id: 'week', title: 'w', instructions: 'x', cadence: 'weekly', enabled: true, runs: run(now - 3 * DAY) },
      { id: 'manual', title: 'm', instructions: 'x', cadence: 'manual', enabled: true, runs: [] },
      { id: 'off', title: 'x', instructions: 'x', cadence: 'daily', enabled: false, runs: [] },
    ] })
    expect(dueRoutines(mm, now).map(r => r.id)).toEqual(['never', 'old'])
    expect(dueRoutines(mm, now, true).map(r => r.id)).toEqual(['never', 'fresh', 'old', 'week', 'manual'])
  })

  it('renders the member prompt with role, memory, rules and due routines', () => {
    const m = member()
    const text = renderMemberPrompt(m, [m.routines[0]], '# Librarian — memory\n\n## Positions\n- X is Y', 2 * DAY, '미로')
    expect(text).toContain('You are Librarian')
    expect(text).toContain("from 미로's client")
    expect(text).toContain('[[Librarian (memory)]]')
    expect(text).toContain('- X is Y')
    expect(text).toContain('### Where do our recent decisions contradict each other?  (routine id: contradictions, daily)')
    expect(text).toContain('member_report')
    expect(renderMemberPrompt(m, [], null, 0, '')).toContain('No routines are due')
    expect(renderMemoryNote(m)).toContain('member: librarian')
  })
})

describe('reactions', () => {
  const long = 'A paragraph of design text that is long enough to be worth a remark. '.repeat(10)

  it('eligibility: markdown outside system folders, above the size floor, not from the bot', () => {
    expect(isReactablePath('design/Menu.md')).toBe(true)
    expect(isReactablePath('_agent/x.md')).toBe(false)
    expect(isReactablePath('_members/Librarian/design/Menu.md')).toBe(false)
    expect(isReactablePath('design/Menu (conflict kim 2026-09-13 1010).md')).toBe(false)
    expect(isReactablePath('design/Menu.md', ['lore'])).toBe(false)
    expect(shouldEnqueueReaction({ path: 'design/Menu.md', deleted: false, size: REACTION_MIN_CHARS, author: 'kim' })).toBe(true)
    expect(shouldEnqueueReaction({ path: 'design/Menu.md', deleted: false, size: 5000, author: REACTION_AUTHOR })).toBe(false)
    expect(shouldEnqueueReaction({ path: 'design/Menu.md', deleted: false, size: 10, author: 'kim' })).toBe(false)
  })

  it('writes one remark per in-scope member, linked to the document and the memory note, once per version', async () => {
    const calls: { system: string; user: string }[] = []
    const llm: LlmCall = async a => { calls.push(a); return '### What this changes\n- something' }
    await saveMemberDefinitions(deps, { version: 1, members: [
      member(),
      { ...TEMPLATES.designer, id: 'designer', scope: { folders: ['ui'], tags: [] } },
      { ...TEMPLATES.editor, id: 'editor', reactsOnSave: false },
    ] })
    await blobs.put(memberNotePath({ name: 'Librarian' }), enc('# Librarian — memory\n\n- remembered thing'))
    const now = 5 * DAY
    const rdeps = { ...deps, now: () => now, llm, log: () => {} }
    const put = await putFile(rdeps, { path: 'design/Menu.md', body: enc(`---\ntitle: Main Menu\n---\n# Main Menu\n\n${long}`), mtime: now, author: 'kim' })
    const row = (put as { body: { etag: string } }).body

    const first = await reactToSave(rdeps, { path: 'design/Menu.md', etag: row.etag })
    expect(first).toMatchObject({ status: 'reacted', members: 1, remarks: ['_members/Librarian/design/Menu.md'] })
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toContain('You are Librarian')
    expect(calls[0].user).toContain('- remembered thing')
    expect(calls[0].user).toContain('Saved by: kim')
    const remark = dec(blobs.objects.get('_members/Librarian/design/Menu.md')!)
    expect(remark).toContain('# Librarian on [[Menu]]')
    expect(remark).toContain('[[Librarian (memory)]]')
    expect(remark).toContain('reacted_etag: ' + row.etag)
    expect(meta.rows.get('_members/Librarian/design/Menu.md')!.author).toBe(REACTION_AUTHOR)

    expect(await reactToSave(rdeps, { path: 'design/Menu.md' })).toEqual({ status: 'skipped', reason: 'already reacted to this version' })
    expect(await reactToSave(rdeps, { path: 'design/Menu.md', etag: 'stale' })).toEqual({ status: 'skipped', reason: 'superseded by a newer save' })
    expect((await readReactionState(deps)).reacted['design/Menu.md'].etag).toBe(row.etag)

    // A new version inside the cooldown is deferred, not reacted to
    await putFile(rdeps, { path: 'design/Menu.md', body: enc(`# Main Menu\n\n${long} changed`), mtime: now + 1000, author: 'kim' })
    const again = await reactToSave({ ...rdeps, now: () => now + 3_600_000 }, { path: 'design/Menu.md' })
    expect(again.status).toBe('deferred')
    expect(calls).toHaveLength(1)
  })

  it('skips documents nobody has in scope, short ones, and graph_weight: skip', async () => {
    const llm: LlmCall = async () => { throw new Error('must not be called') }
    await saveMemberDefinitions(deps, { version: 1, members: [{ ...TEMPLATES.designer, id: 'designer', scope: { folders: ['ui'], tags: [] } }] })
    const rdeps = { ...deps, llm }
    await putFile(deps, { path: 'lore/World.md', body: enc(`# World\n\n${long}`), mtime: 1, author: 'kim' })
    expect(await reactToSave(rdeps, { path: 'lore/World.md' })).toEqual({ status: 'skipped', reason: 'no member has this document in scope' })
    await putFile(deps, { path: 'ui/Short.md', body: enc('# Short\n\ntiny'), mtime: 1, author: 'kim' })
    expect(await reactToSave(rdeps, { path: 'ui/Short.md' })).toEqual({ status: 'skipped', reason: 'too short' })
    await putFile(deps, { path: 'ui/Skip.md', body: enc(`---\ngraph_weight: skip\n---\n# Skip\n\n${long}`), mtime: 1, author: 'kim' })
    expect(await reactToSave(rdeps, { path: 'ui/Skip.md' })).toEqual({ status: 'skipped', reason: 'graph_weight: skip' })
    expect(await reactToSave(rdeps, { path: 'ui/Gone.md' })).toEqual({ status: 'skipped', reason: 'document gone' })
  })
})

describe('MCP member tools and prompt', () => {
  let mdeps: McpDeps
  const rpc = (body: unknown) => new Request('https://w/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) })
  beforeEach(() => { mdeps = { ...deps, author: 'kim' } })

  it('members_list, member_remember and member_report round-trip through the store', async () => {
    const all = parse(await callTool(mdeps, 'members_list', {}))
    expect(all.members).toHaveLength(1)
    expect(all.members[0]).toMatchObject({ id: 'librarian', memory: '_members/Librarian (memory).md' })
    expect(all.members[0].routines.every((r: { due: boolean }) => r.due)).toBe(true)

    const rem = parse(await callTool(mdeps, 'member_remember', { member: 'Librarian', text: '- Position: stamina regen is 5/s' }))
    expect(rem.path).toBe('_members/Librarian (memory).md')
    const note = dec(blobs.objects.get('_members/Librarian (memory).md')!)
    expect(note).toContain('member: librarian')          // created from the template on first use
    expect(note).toContain('- Position: stamina regen is 5/s')
    expect(note).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · via kim/)
    await callTool(mdeps, 'member_remember', { member: 'librarian', text: 'second entry' })
    expect(dec(blobs.objects.get('_members/Librarian (memory).md')!)).toContain('- Position: stamina regen is 5/s') // appended, not replaced
    expect(meta.rows.get('_members/Librarian (memory).md')!.author).toBe('librarian (kim)')
    expect((await callTool(mdeps, 'member_remember', { member: 'ghost', text: 'x' })).isError).toBe(true)

    const rep = parse(await callTool(mdeps, 'member_report', { member: 'librarian', routine: 'learned', summary: 'Wrote the digest.', proposals: ['_agent/2026-09-13-what-we-learned.md'] }))
    expect(rep.recorded).toBe('librarian/learned')
    const after = parse(await callTool(mdeps, 'members_list', {}))
    expect(after.members[0].routines.find((r: { id: string }) => r.id === 'learned')).toMatchObject({ due: false, lastRun: { by: 'kim', summary: 'Wrote the digest.' } })
    expect((await callTool(mdeps, 'member_report', { member: 'librarian', routine: 'ghost', summary: 'x' })).isError).toBe(true)
  })

  it('the `member` prompt is discoverable, picks a member by name and carries memory and due routines', async () => {
    const list = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }), mdeps)).json() as { result: { prompts: { name: string }[] } }
    expect(list.result.prompts.map(p => p.name)).toEqual(['member'])
    await callTool(mdeps, 'member_remember', { member: 'librarian', text: 'I asked about stamina.' })
    const got = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'member', arguments: { name: 'Librarian' } } }), mdeps)).json() as { result: { description: string; messages: { content: { text: string } }[] } }
    expect(got.result.description).toBe(`Librarian — ${DEFAULT_MEMBER.routines.length} routines due`)
    const text = got.result.messages[0].content.text
    expect(text).toContain('You are Librarian')
    expect(text).toContain('I asked about stamina.')
    expect(text).toContain("from kim's client")
    const dflt = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 3, method: 'prompts/get', params: { name: 'member', arguments: {} } }), mdeps)).json() as { result: { description: string } }
    expect(dflt.result.description).toContain('Librarian')
    const bad = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 4, method: 'prompts/get', params: { name: 'member', arguments: { name: 'ghost' } } }), mdeps)).json() as { error: { message: string } }
    expect(bad.error.message).toContain('unknown member')
  })
})
