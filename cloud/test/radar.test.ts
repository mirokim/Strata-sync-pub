import { describe, it, expect, beforeEach } from 'vitest'
import { putFile, type SyncDeps } from '../src/sync.js'
import { invalidateVaultView } from '../src/vaultIndex.js'
import { radarCheck, parseConflicts, readRadarState, RADAR_AUTHOR } from '../src/radar.js'
import { readInbox, inboxFor } from '../src/inbox.js'
import { callTool } from '../src/mcp.js'
import type { LlmCall } from '../src/reactions.js'
import { MemoryMeta, MemoryBlobs, enc } from './fakes.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs
const KIM = 'google|kim', LEE = 'google|lee'
const long = (s: string) => s + '\n\n' + '설계 배경과 근거를 길게 적은 문단. '.repeat(12)

beforeEach(async () => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs(); deps = { meta, blobs, maxFileBytes: 1024 * 1024 }
  invalidateVaultView()
  let t = 1_000
  const put = (path: string, body: string, author: string, authorSub: string) => putFile({ ...deps, now: () => (t += 60_000) }, { path, body: enc(body), mtime: t, author, authorSub })
  await put('design/모터 결정.md', long('# 모터 결정\n\n흡입 모터는 BLDC 2세대로 간다. 소음 목표 60 dB.'), 'Lee', LEE)
  await put('design/소음 목표.md', long('# 소음 목표\n\n소음 목표는 65 dB로 완화한다. 모터 소음이 원인.'), 'Park', 'google|park')
  await put('design/포장.md', long('# 포장\n\n포장재는 재생 펄프. 모터와 무관한 내용.'), 'Park', 'google|park')
  await put('design/새 결정.md', long('# 새 결정\n\n브러시드 모터를 유지한다. 소음 목표 60 dB는 그대로. 흡입 모터 교체는 없다.'), 'Kim', KIM)
})

const llmSaying = (answer: string, calls: string[] = []): LlmCall => async ({ user }) => { calls.push(user); return answer }

describe('parseConflicts', () => {
  it('reads JSON out of prose, keeps only known paths and complete entries', () => {
    const allowed = new Set(['a.md', 'b.md'])
    const text = 'Sure:\n{"conflicts":[{"path":"a.md","here":"X","there":"Y","severity":"tension","note":"n"},{"path":"zzz.md","here":"1","there":"2"},{"path":"b.md","here":"","there":"Y"}]}\nthanks'
    expect(parseConflicts(text, allowed)).toEqual([{ path: 'a.md', here: 'X', there: 'Y', severity: 'tension', note: 'n' }])
    expect(parseConflicts('no json here', allowed)).toEqual([])
    expect(parseConflicts('{"conflicts":"nope"}', allowed)).toEqual([])
  })
})

describe('radarCheck', () => {
  it('sends the saver an inbox question per collision, names the other author, and remembers the pair', async () => {
    const calls: string[] = []
    const llm = llmSaying('{"conflicts":[{"path":"design/모터 결정.md","here":"브러시드 모터를 유지한다","there":"흡입 모터는 BLDC 2세대로 간다","severity":"contradiction","note":"모터 종류가 다르다."}]}', calls)
    const r = await radarCheck({ ...deps, llm, now: () => 5_000_000 }, { path: 'design/새 결정.md' })
    expect(r.status).toBe('checked')
    if (r.status !== 'checked') return
    expect(r.candidates).toBeGreaterThan(0)
    expect(r.conflicts).toHaveLength(1)
    expect(r.sent).toHaveLength(1)
    expect(calls[0]).toContain('# NEW DOCUMENT')
    expect(calls[0]).toContain('design/모터 결정.md')

    const items = await readInbox(deps, await meta.listSince(0, 1000))
    const kim = inboxFor(items, { sub: KIM }, 'Kim')
    expect(kim.forMe).toHaveLength(1)
    const q = kim.forMe[0]
    expect(q).toMatchObject({ kind: 'question', status: 'open', to: 'Kim', toSub: KIM, from: RADAR_AUTHOR, about: ['design/새 결정.md', 'design/모터 결정.md'] })
    expect(q.title).toBe('⚡ 새 결정 ↔ 모터 결정')
    expect(q.body).toContain('**모터 결정** (Lee')
    expect(q.body).toContain('> 흡입 모터는 BLDC 2세대로 간다')

    const state = await readRadarState(deps)
    expect(state.checked['design/새 결정.md']).toBe((await meta.get('design/새 결정.md'))!.etag)
    expect(Object.keys(state.raised)).toEqual(['design/모터 결정.md|design/새 결정.md'])

    // Same version again → skipped without a model call; same pair from the other side within a week → not raised twice
    expect(await radarCheck({ ...deps, llm: llmSaying('never', calls), now: () => 5_000_001 }, { path: 'design/새 결정.md' })).toEqual({ status: 'skipped', reason: 'already checked this version' })
    const again = await radarCheck({ ...deps, llm: llmSaying('{"conflicts":[{"path":"design/새 결정.md","here":"a","there":"b","severity":"contradiction","note":""}]}', calls), now: () => 5_000_002 }, { path: 'design/모터 결정.md' })
    expect(again).toMatchObject({ status: 'checked', sent: [] })
  })

  it('does nothing for short documents, bot documents, personal paths, or a clean answer', async () => {
    const calls: string[] = []
    const llm = llmSaying('{"conflicts":[]}', calls)
    await putFile(deps, { path: 'design/짧음.md', body: enc('# 짧음\n\n한 줄.'), mtime: 1, author: 'Kim', authorSub: KIM })
    expect((await radarCheck({ ...deps, llm }, { path: 'design/짧음.md' })).status).toBe('skipped')
    expect((await radarCheck({ ...deps, llm }, { path: '_personal/google-kim/x.md' })).status).toBe('skipped')
    expect((await radarCheck({ ...deps, llm }, { path: '_agent/p.md' })).status).toBe('skipped')
    const clean = await radarCheck({ ...deps, llm }, { path: 'design/새 결정.md' })
    expect(clean).toMatchObject({ status: 'checked', conflicts: [], sent: [] })
    expect(calls).toHaveLength(1)
    expect(inboxFor(await readInbox(deps, await meta.listSince(0, 1000)), { sub: KIM }, 'Kim').forMe).toEqual([])
  })

  it('radar_check MCP tool needs a server model and reports the outcome', async () => {
    const noKey = await callTool({ ...deps, author: 'Kim', viewer: { sub: KIM } }, 'radar_check', { path: 'design/새 결정.md' })
    expect(noKey.isError).toBe(true)
    const llm = llmSaying('{"conflicts":[{"path":"design/소음 목표.md","here":"60 dB","there":"65 dB","severity":"tension","note":"목표치 다름"}]}')
    const r = JSON.parse(((await callTool({ ...deps, author: 'Kim', viewer: { sub: KIM }, llm }, 'radar_check', { path: 'design/새 결정.md' })).content[0] as { text: string }).text)
    expect(r).toMatchObject({ status: 'checked', sent: [expect.stringContaining('_inbox/Kim/')] })
    expect(r.conflicts[0].severity).toBe('tension')
  })
})
