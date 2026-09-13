/**
 * Contradiction radar — catches the team's brain splitting, at save time.
 *
 * Kim's agent writes "we go with BLDC"; four hours later Lee's agent writes "brushed motor stays".
 * Each session is consistent with itself; only the hub sees both. So on every eligible save the
 * server pulls the documents closest to the new one (BM25 + semantic, the vault_search fusion),
 * asks the model whether any claim, decision or number is incompatible, and — when one is — drops
 * a question in the saver's inbox: what collides, with whom, written where. The saver (or their
 * agent) answers it like any other inbox item; the other author sees the pair on their desk too.
 *
 * Runs in the reactions queue after the member reactions, with the same LLM; without
 * ANTHROPIC_API_KEY nothing runs. `_system/radar.json` remembers which version was checked and
 * which pairs were already raised, so a pair is reported once per week at most.
 */
import { type SyncDeps, type FileRow } from './sync.js'
import { loadVaultView } from './vaultIndex.js'
import { fusedSearch, type RecallDeps } from './recall.js'
import { isReactablePath, REACTION_AUTHOR, type LlmCall } from './reactions.js'
import { sendInbox } from './inbox.js'
import { isPersonalPath } from './personal.js'
import { parseVaultDoc } from '../../mcp/src/lint/vaultDoc.js'

export const RADAR_STATE_KEY = '_system/radar.json'
export const RADAR_AUTHOR = 'strata-radar'
export const RADAR_MIN_CHARS = 200
export const RADAR_CANDIDATES = 6
export const RADAR_DOC_MAX_CHARS = 9000
export const RADAR_CANDIDATE_MAX_CHARS = 3000
export const RADAR_PAIR_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000

export interface RadarState {
  version: 1
  /** path → etag last checked */
  checked: Record<string, string>
  /** "a|b" (sorted paths) → when the pair was last raised */
  raised: Record<string, number>
}

export interface Conflict {
  /** The colliding document (vault path, from the candidate list) */
  path: string
  /** What the new document says */
  here: string
  /** What the other document says */
  there: string
  severity: 'contradiction' | 'tension'
  /** One or two sentences on why they cannot both hold */
  note: string
}

export interface RadarDeps extends RecallDeps {
  llm: LlmCall
  log?: (msg: string) => void
}

export type RadarOutcome =
  | { status: 'checked'; candidates: number; conflicts: Conflict[]; sent: string[] }
  | { status: 'skipped'; reason: string }

const dec = new TextDecoder()
const enc = new TextEncoder()

export async function readRadarState(deps: SyncDeps): Promise<RadarState> {
  const bytes = await deps.blobs.get(RADAR_STATE_KEY)
  if (!bytes) return { version: 1, checked: {}, raised: {} }
  try { const s = JSON.parse(dec.decode(bytes)) as Partial<RadarState>; return s.version === 1 ? { version: 1, checked: s.checked ?? {}, raised: s.raised ?? {} } : { version: 1, checked: {}, raised: {} } }
  catch { return { version: 1, checked: {}, raised: {} } }
}
export async function writeRadarState(deps: SyncDeps, state: RadarState): Promise<void> {
  await deps.blobs.put(RADAR_STATE_KEY, enc.encode(JSON.stringify(state)))
}

export const RADAR_SYSTEM = `You are the contradiction radar of a team's shared knowledge vault. You receive one freshly saved document and a few related documents written by teammates (possibly by other people, possibly earlier). Find claims, decisions, numbers, dates or plans in the NEW document that CANNOT be true at the same time as something in a related document.

Rules:
- Report only genuine incompatibility: "we ship in March" vs "launch moved to June"; "motor is BLDC" vs "we keep the brushed motor"; "max 60 dB" vs "target 65 dB". Different topics, more detail, or a later document that explicitly supersedes an earlier one are NOT contradictions.
- "contradiction": both cannot hold. "tension": they pull apart but could be reconciled with a clarification.
- Quote or closely paraphrase both sides. Write here/there/note in the language the documents are written in.
- Answer with JSON only, no prose: {"conflicts":[{"path":"<related document path exactly as given>","here":"…","there":"…","severity":"contradiction|tension","note":"…"}]}. Empty list when nothing collides.`

export function parseConflicts(text: string, allowed: Set<string>): Conflict[] {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  let parsed: { conflicts?: unknown }
  try { parsed = JSON.parse(text.slice(start, end + 1)) } catch { return [] }
  if (!Array.isArray(parsed.conflicts)) return []
  const out: Conflict[] = []
  for (const c of parsed.conflicts as Record<string, unknown>[]) {
    const path = String(c.path ?? '').replace(/\\/g, '/')
    if (!allowed.has(path)) continue
    const severity = c.severity === 'tension' ? 'tension' : 'contradiction'
    const here = String(c.here ?? '').trim(), there = String(c.there ?? '').trim(), note = String(c.note ?? '').trim()
    if (!here || !there) continue
    out.push({ path, here, there, severity, note })
  }
  return out
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '\n…' : s)

/** Check one saved document against its neighbourhood; raise inbox questions for real collisions. */
export async function radarCheck(deps: RadarDeps, job: { path: string; etag?: string }): Promise<RadarOutcome> {
  const log = deps.log ?? (() => {})
  const now = (deps.now ?? Date.now)()
  const path = job.path.replace(/\\/g, '/')
  if (!isReactablePath(path) || isPersonalPath(path)) return { status: 'skipped', reason: 'path not eligible' }
  const row = await deps.meta.get(path)
  if (!row || row.deleted) return { status: 'skipped', reason: 'document gone' }
  if (job.etag && job.etag !== row.etag) return { status: 'skipped', reason: 'superseded by a newer save' }
  if (row.author === RADAR_AUTHOR || row.author === REACTION_AUTHOR) return { status: 'skipped', reason: 'bot document' }

  const state = await readRadarState(deps)
  if (state.checked[path] === row.etag) return { status: 'skipped', reason: 'already checked this version' }

  const bytes = await deps.blobs.get(path)
  if (!bytes) return { status: 'skipped', reason: 'content missing' }
  const doc = parseVaultDoc(path, dec.decode(bytes), row.mtime)
  if (doc.graphWeight === 'skip' || doc.body.trim().length < RADAR_MIN_CHARS) {
    state.checked[path] = row.etag; await writeRadarState(deps, state)
    return { status: 'skipped', reason: 'too short or graph_weight: skip' }
  }

  // Neighbourhood: what the vault already says about the same things, other people's personal docs excluded
  const view = await loadVaultView(deps)
  const { hits } = await fusedSearch(deps, view, `${doc.title}\n${doc.body.slice(0, 800)}`, RADAR_CANDIDATES * 2, new Set([path]))
  const candidates: { path: string; row: FileRow; body: string; title: string }[] = []
  for (const h of hits) {
    if (candidates.length >= RADAR_CANDIDATES) break
    const p = h.path
    if (p === path || !isReactablePath(p) || isPersonalPath(p)) continue
    const r = view.rows.get(p)
    if (!r || r.deleted) continue
    const body = await view.bodyOf(p)
    if (body.trim().length < RADAR_MIN_CHARS) continue
    candidates.push({ path: p, row: r, body, title: view.docs.get(p)?.title ?? p })
  }
  if (candidates.length === 0) {
    state.checked[path] = row.etag; await writeRadarState(deps, state)
    return { status: 'checked', candidates: 0, conflicts: [], sent: [] }
  }

  const user = [
    `# NEW DOCUMENT`, `Path: ${path}`, `Title: ${doc.title}`, `Saved by: ${row.author || 'unknown'} at ${new Date(row.updatedAt).toISOString()}`, '', clip(doc.body, RADAR_DOC_MAX_CHARS), '',
    `# RELATED DOCUMENTS`,
    ...candidates.map(c => [`## ${c.path}`, `Title: ${c.title}`, `Written by: ${c.row.author || 'unknown'} at ${new Date(c.row.updatedAt).toISOString()}`, '', clip(c.body, RADAR_CANDIDATE_MAX_CHARS), ''].join('\n')),
  ].join('\n')
  const text = await deps.llm({ system: RADAR_SYSTEM, user, maxTokens: 1200, effort: 'medium' })
  const conflicts = parseConflicts(text, new Set(candidates.map(c => c.path)))

  // One inbox question per collision, to the saver, once per pair per week
  const sent: string[] = []
  for (const c of conflicts) {
    const key = pairKey(path, c.path)
    if (state.raised[key] && now - state.raised[key] < RADAR_PAIR_COOLDOWN_MS) continue
    const other = candidates.find(x => x.path === c.path)!
    const to = row.author || 'unknown'
    const title = `${c.severity === 'contradiction' ? '⚡' : '〰'} ${doc.title} ↔ ${other.title}`
    const body = [
      `**${doc.title}** (${row.author}, ${new Date(row.updatedAt).toISOString().slice(0, 10)}) says:`, `> ${c.here}`, '',
      `**${other.title}** (${other.row.author || 'unknown'}, ${new Date(other.row.updatedAt).toISOString().slice(0, 10)}) says:`, `> ${c.there}`, '',
      c.note, '',
      `Which one holds? Update the other document, or answer here with why both are right.`,
    ].join('\n')
    const r = await sendInbox({ ...deps, viewer: { sub: 'service', service: true }, author: RADAR_AUTHOR }, {
      to, toSub: row.authorSub && row.authorSub !== 'service' ? row.authorSub : undefined,
      kind: 'question', title, body, about: [path, c.path],
    })
    if ('error' in r) { log(`[radar] inbox failed for ${path}: ${r.error}`); continue }
    state.raised[key] = now
    sent.push(r.path)
  }
  state.checked[path] = row.etag
  await writeRadarState(deps, state)
  log(`[radar] ${path}: ${candidates.length} candidates, ${conflicts.length} conflict(s), ${sent.length} question(s)`)
  return { status: 'checked', candidates: candidates.length, conflicts, sent }
}
