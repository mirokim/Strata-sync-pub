import { describe, it, expect, beforeEach } from 'vitest'
import { recordPerson, resetPersonThrottle, backfillFromGrants, subOfGrantKey, type PeopleStore, type Person } from '../src/people.js'
import { route, type Env } from '../src/index.js'
import { callTool } from '../src/mcp.js'
import { MemoryMeta, MemoryBlobs } from './fakes.js'

class MemoryPeople implements PeopleStore {
  rows = new Map<string, Omit<Person, 'docs'>>()
  async upsert(p: Omit<Person, 'docs'>) {
    const prev = this.rows.get(p.sub)
    this.rows.set(p.sub, prev ? { ...p, firstSeen: Math.min(prev.firstSeen, p.firstSeen), lastSeen: Math.max(prev.lastSeen, p.lastSeen) } : p)
  }
  async insertIfMissing(p: Omit<Person, 'docs'>) { if (!this.rows.has(p.sub)) this.rows.set(p.sub, p) }
  async list() { return [...this.rows.values()].sort((a, b) => b.lastSeen - a.lastSeen).map(p => ({ ...p, docs: 0 })) }
  async count() { return this.rows.size }
}

function fakeKv(entries: Record<string, unknown>): KVNamespace {
  return {
    list: async ({ prefix }: { prefix: string }) => ({ keys: Object.keys(entries).filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }),
    get: async (key: string) => entries[key] ?? null,
  } as unknown as KVNamespace
}

let people: MemoryPeople
beforeEach(() => { people = new MemoryPeople(); resetPersonThrottle() })

describe('people', () => {
  it('records a signed-in person once per window, never the team token', async () => {
    await recordPerson(people, { sub: 'g1', email: 'kim@x.com', name: '김', service: false }, 1000)
    await recordPerson(people, { sub: 'g1', email: 'kim@x.com', name: '김', service: false }, 2000)       // throttled
    await recordPerson(people, { sub: 'service', email: '', name: 'bot', service: true }, 3000)
    expect([...people.rows.values()]).toEqual([{ sub: 'g1', email: 'kim@x.com', name: '김', picture: '', firstSeen: 1000, lastSeen: 1000 }])
    await recordPerson(people, { sub: 'g1', email: 'kim@x.com', name: '김철수', service: false }, 1000 + 11 * 60_000)
    expect(people.rows.get('g1')).toMatchObject({ name: '김철수', firstSeen: 1000, lastSeen: 1000 + 11 * 60_000 })
  })

  it('reads the sub out of a grant key, including subs that contain colons', () => {
    expect(subOfGrantKey('grant:1149:abc')).toBe('1149')
    expect(subOfGrantKey('grant:a:b:c')).toBe('a:b')
    expect(subOfGrantKey('token:1:2')).toBeNull()
  })

  it('backfills people from OAuth grants without moving a known person back in time', async () => {
    await people.upsert({ sub: 'known', email: 'k@x', name: 'Known', picture: 'p', firstSeen: 5_000_000_000_000, lastSeen: 5_000_000_000_000 })
    const kv = fakeKv({
      'grant:g2:a': { metadata: { email: 'lee@x.com', name: '이소영' }, createdAt: 1_789_000_000 },        // seconds
      'grant:g2:b': { metadata: { email: 'lee@x.com', name: '이소영' }, createdAt: 1_789_100_000 },
      'grant:known:c': { metadata: { email: 'k@x', name: 'Old' }, createdAt: 1 },
    })
    expect(await backfillFromGrants(people, kv)).toBe(2)
    expect(people.rows.get('g2')).toMatchObject({ name: '이소영', email: 'lee@x.com', lastSeen: 1_789_100_000_000 })
    expect(people.rows.get('known')?.name).toBe('Known')
  })

  it('GET /v1/people lists them, backfilling once when the table is empty', async () => {
    const env = { TEAM_TOKEN: 'secret', OAUTH_KV: fakeKv({ 'grant:g3:z': { metadata: { email: 'park@x.com', name: '박' }, createdAt: 1_789_000_000 } }) } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const deps = { meta: new MemoryMeta(), blobs: new MemoryBlobs(), maxFileBytes: 1024, people }
    const res = await route(new Request('https://w/v1/people', { headers: { authorization: 'Bearer secret' } }), env, ctx, deps)
    const body = await res.json() as { people: Person[] }
    expect(body.people.map(p => p.name)).toEqual(['박'])
  })

  it('members_list shows the people next to the AI members', async () => {
    await people.upsert({ sub: 'g1', email: 'kim@x.com', name: '김', picture: '', firstSeen: 1, lastSeen: 2 })
    const r = await callTool({ meta: new MemoryMeta(), blobs: new MemoryBlobs(), maxFileBytes: 1024, people: () => people.list() }, 'members_list', {})
    const out = JSON.parse((r.content[0] as { text: string }).text) as { people: { name: string }[]; members: unknown[] }
    expect(out.people.map(p => p.name)).toEqual(['김'])
    expect(out.members.length).toBeGreaterThan(0)
  })
})
