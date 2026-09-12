import { describe, it, expect, beforeEach } from 'vitest'
import { readJobs, saveJobDefinitions, recordJobRun, dueJobs, renderJobsPrompt, validateJobs, DEFAULT_JOBS, JOBS_KEY } from '../src/jobs.js'
import { callTool, handleMcpRequest, type McpDeps } from '../src/mcp.js'
import { putFile, deleteFile, type SyncDeps } from '../src/sync.js'
import { invalidateVaultView } from '../src/vaultIndex.js'
import { route, type Env } from '../src/index.js'
import { MemoryMeta, MemoryBlobs, enc } from './fakes.js'

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

describe('jobs config', () => {
  it('ships defaults, validates edits, and keeps run history across edits', async () => {
    const c = await readJobs(deps)
    expect(c.jobs.map(j => j.id)).toEqual(DEFAULT_JOBS.map(j => j.id))
    expect(validateJobs({ jobs: [{ id: 'X Y', title: 't', instructions: 'i', cadence: 'daily', enabled: true }] })).toMatch(/slug/)
    expect(validateJobs({ jobs: [{ id: 'ok', title: 't', instructions: 'i', cadence: 'hourly', enabled: true }] })).toMatch(/cadence/)
    expect(validateJobs({ jobs: [] })).toBeNull()

    await recordJobRun(deps, 'draft-missing', { at: 1_000, by: 'kim', summary: 'drafted two', proposals: ['_agent/a.md'] })
    const edited = await saveJobDefinitions(deps, { version: 1, jobs: [{ ...c.jobs[0], title: 'Renamed', runs: [] }] })
    expect(edited.jobs).toHaveLength(1)
    expect(edited.jobs[0].title).toBe('Renamed')
    expect(edited.jobs[0].runs).toHaveLength(1) // history survived the edit
    expect(blobs.objects.has(JOBS_KEY)).toBe(true)
    expect(await recordJobRun(deps, 'nope', { at: 1, by: 'x', summary: 's', proposals: [] })).toBeNull()
  })

  it('dueJobs follows cadence and last run; manual jobs only when forced', () => {
    const now = 10 * DAY
    const mk = (id: string, cadence: 'daily' | 'weekly' | 'manual', lastAt?: number, enabled = true) => ({ id, title: id, instructions: 'x', cadence, enabled, runs: lastAt === undefined ? [] : [{ at: lastAt, by: 'k', summary: 's', proposals: [] }] })
    const config = { version: 1 as const, jobs: [mk('never', 'daily'), mk('fresh', 'daily', now - 2 * 3_600_000), mk('old', 'daily', now - DAY), mk('week', 'weekly', now - 3 * DAY), mk('manual', 'manual'), mk('off', 'daily', undefined, false)] }
    expect(dueJobs(config, now).map(j => j.id)).toEqual(['never', 'old'])
    expect(dueJobs(config, now, true).map(j => j.id)).toEqual(['never', 'fresh', 'old', 'week', 'manual'])
  })

  it('renders a prompt with the rules, each due job and its last run', () => {
    const jobs = [{ id: 'a', title: 'Job A', instructions: 'Do A.', cadence: 'daily' as const, enabled: true, runs: [{ at: DAY, by: 'kim', summary: 'did it', proposals: [] }] }]
    const text = renderJobsPrompt(jobs, 2 * DAY, '미로')
    expect(text).toContain('on behalf of 미로')
    expect(text).toContain('## Job A  (id: a, daily)')
    expect(text).toContain('Last run: 1970-01-02 00:00 UTC by kim — did it')
    expect(text).toContain('Do A.')
    expect(text).toContain('vault_propose')
    expect(renderJobsPrompt([], 0, '')).toContain('No Strata Sync jobs are due')
  })
})

describe('MCP tools and prompt', () => {
  let mdeps: McpDeps
  beforeEach(async () => {
    mdeps = { ...deps, author: 'kim' }
    await putFile(deps, { path: 'notes/Old.md', body: enc('# Old\n\nold'), mtime: 1, author: 'ann', now: undefined } as never)
  })

  it('vault_changes lists rows newer than `since` with author and title, tombstones included', async () => {
    const t0 = Date.now()
    const withClock = { ...deps, now: () => t0 + 5_000 }
    await putFile(withClock, { path: 'notes/New.md', body: enc('---\ntitle: Shiny\n---\n# New\n\nnew'), mtime: 2, author: 'bob' })
    const old = await meta.get('notes/Old.md')
    await deleteFile(withClock, 'notes/Old.md', old!.etag, 'bob')
    const r = parse(await callTool({ ...mdeps, now: () => t0 + 5_000 } as McpDeps, 'vault_changes', { since: String(t0 + 1_000) }))
    expect(r.count).toBe(2)
    expect(r.changes.map((c: { path: string; deleted: boolean; author: string }) => [c.path, c.deleted, c.author])).toEqual([['notes/Old.md', true, 'bob'], ['notes/New.md', false, 'bob']])
    expect(r.changes[1].title).toBe('Shiny')
    expect((await callTool(mdeps, 'vault_changes', { since: 'yesterday-ish' })).isError).toBe(true)
  })

  it('jobs_list / jobs_report round-trip through the store and record the caller', async () => {
    const all = parse(await callTool(mdeps, 'jobs_list', {}))
    expect(all.jobs).toHaveLength(DEFAULT_JOBS.length)
    expect(all.jobs[0].lastRun).toBeNull()
    const rep = parse(await callTool(mdeps, 'jobs_report', { id: 'weekly-digest', summary: 'Wrote the digest.', proposals: ['_agent/2026-09-13-vault-digest.md'] }))
    expect(rep.recorded).toBe('weekly-digest')
    const after = parse(await callTool(mdeps, 'jobs_list', { due: true }))
    expect(after.jobs.map((j: { id: string }) => j.id)).not.toContain('weekly-digest')
    expect((await readJobs(deps)).jobs.find(j => j.id === 'weekly-digest')!.runs[0]).toMatchObject({ by: 'kim', summary: 'Wrote the digest.' })
    expect((await callTool(mdeps, 'jobs_report', { id: 'ghost', summary: 'x' })).isError).toBe(true)
  })

  it('the `jobs` prompt is discoverable and carries the due jobs', async () => {
    const rpc = (body: unknown) => new Request('https://w/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) })
    const list = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 1, method: 'prompts/list' }), mdeps)).json() as { result: { prompts: { name: string }[] } }
    expect(list.result.prompts.map(p => p.name)).toEqual(['jobs'])
    const got = await (await handleMcpRequest(rpc({ jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'jobs', arguments: {} } }), mdeps)).json() as { result: { description: string; messages: { content: { text: string } }[] } }
    expect(got.result.description).toBe(`${DEFAULT_JOBS.length} jobs due`)
    expect(got.result.messages[0].content.text).toContain('## Draft the documents everyone links to but nobody wrote')
    expect(got.result.messages[0].content.text).toContain('on behalf of kim')
  })
})

describe('routes', () => {
  const env = { TEAM_TOKEN: 'secret' } as unknown as Env
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
  const call = (path: string, init: RequestInit = {}) => route(new Request(`https://w${path}`, { ...init, headers: { authorization: 'Bearer secret', ...(init.headers as Record<string, string> | undefined) } }), env, ctx, deps)

  it('GET/PUT /v1/jobs', async () => {
    const c = await (await call('/v1/jobs')).json() as { jobs: { id: string }[] }
    expect(c.jobs.length).toBe(DEFAULT_JOBS.length)
    const ok = await call('/v1/jobs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: 1, jobs: [{ id: 'only', title: 'Only', instructions: 'Do it.', cadence: 'manual', enabled: true }] }) })
    expect(ok.status).toBe(200)
    expect(((await (await call('/v1/jobs')).json()) as { jobs: unknown[] }).jobs).toHaveLength(1)
    expect((await call('/v1/jobs', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"jobs":"x"}' })).status).toBe(400)
  })
})
