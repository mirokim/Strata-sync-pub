/**
 * People — the humans on the team: everyone who signed in with Google. Shown next to the AI
 * members (Settings → Members) and listed to MCP clients so an agent knows whom it can ask
 * (inbox_send). The team token is a service, not a person, and never appears.
 *
 * Recorded on use: a signed-in request upserts its identity at most once per RECORD_EVERY_MS per
 * isolate. People who signed in before this existed are backfilled from the OAuth grants in KV
 * (`grant:<sub>:<grantId>` → { metadata: { email, name }, createdAt }).
 */
import type { Identity } from './auth.js'

export interface Person {
  sub: string
  email: string
  name: string
  picture: string
  firstSeen: number
  lastSeen: number
  /** Live team documents whose last save is theirs. */
  docs: number
}

export interface PeopleStore {
  upsert(p: Omit<Person, 'docs'>): Promise<void>
  /** Insert only when unknown (backfill must never move a real last_seen back). */
  insertIfMissing(p: Omit<Person, 'docs'>): Promise<void>
  list(): Promise<Person[]>
  count(): Promise<number>
}

interface UserRecord { sub: string; email: string; name: string; picture: string; first_seen: number; last_seen: number; docs: number }

export class D1PeopleStore implements PeopleStore {
  constructor(private db: D1Database) {}

  async upsert(p: Omit<Person, 'docs'>): Promise<void> {
    await this.db.prepare(`
      INSERT INTO users (sub, email, name, picture, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      ON CONFLICT(sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture,
        first_seen = MIN(users.first_seen, excluded.first_seen), last_seen = MAX(users.last_seen, excluded.last_seen)`)
      .bind(p.sub, p.email, p.name, p.picture, p.firstSeen, p.lastSeen).run()
  }

  async insertIfMissing(p: Omit<Person, 'docs'>): Promise<void> {
    await this.db.prepare('INSERT OR IGNORE INTO users (sub, email, name, picture, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(p.sub, p.email, p.name, p.picture, p.firstSeen, p.lastSeen).run()
  }

  async list(): Promise<Person[]> {
    const { results } = await this.db.prepare(`
      SELECT u.*, (SELECT COUNT(*) FROM files f WHERE f.author_sub = u.sub AND f.deleted = 0 AND f.path NOT LIKE '\\_%' ESCAPE '\\') AS docs
      FROM users u ORDER BY u.last_seen DESC`).all<UserRecord>()
    return results.map(r => ({ sub: r.sub, email: r.email, name: r.name, picture: r.picture, firstSeen: r.first_seen, lastSeen: r.last_seen, docs: r.docs }))
  }

  async count(): Promise<number> {
    const r = await this.db.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
    return r?.n ?? 0
  }
}

const RECORD_EVERY_MS = 10 * 60 * 1000
const recorded = new Map<string, number>()

/** Note that a signed-in person used the API. Cheap: at most one write per person per 10 minutes per isolate. */
export async function recordPerson(store: PeopleStore, identity: Identity, now = Date.now()): Promise<void> {
  if (identity.service || !identity.sub || identity.sub === 'service') return
  const last = recorded.get(identity.sub)
  if (last !== undefined && now - last < RECORD_EVERY_MS) return
  recorded.set(identity.sub, now)
  await store.upsert({ sub: identity.sub, email: identity.email, name: identity.name || identity.email.split('@')[0], picture: identity.picture ?? '', firstSeen: now, lastSeen: now })
}

/** Test hook: forget the per-isolate throttle. */
export function resetPersonThrottle(): void { recorded.clear() }

/** `grant:<sub>:<grantId>` → sub; null for anything else. */
export function subOfGrantKey(key: string): string | null {
  if (!key.startsWith('grant:')) return null
  const rest = key.slice('grant:'.length)
  const colon = rest.lastIndexOf(':')
  return colon > 0 ? rest.slice(0, colon) : null
}

/**
 * Add everyone holding an OAuth grant who is not in the table yet. Their last sign-in stands in
 * for both first and last seen until they use the app again.
 */
export async function backfillFromGrants(store: PeopleStore, kv: KVNamespace): Promise<number> {
  const seen = new Map<string, Omit<Person, 'docs'>>()
  let cursor: string | undefined
  do {
    const page = await kv.list({ prefix: 'grant:', cursor })
    for (const k of page.keys) {
      const sub = subOfGrantKey(k.name)
      if (!sub) continue
      const grant = await kv.get<{ metadata?: { email?: string; name?: string }; createdAt?: number }>(k.name, { type: 'json' })
      if (!grant) continue
      const at = (grant.createdAt ?? 0) < 1e12 ? (grant.createdAt ?? 0) * 1000 : grant.createdAt!  // seconds or ms
      const email = grant.metadata?.email ?? ''
      const prev = seen.get(sub)
      if (!prev || at > prev.lastSeen) seen.set(sub, { sub, email, name: grant.metadata?.name || email.split('@')[0] || sub, picture: '', firstSeen: at, lastSeen: at })
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  for (const p of seen.values()) await store.insertIfMissing(p)
  return seen.size
}
