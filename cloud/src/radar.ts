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
 * Two ways to judge, same questions out:
 *   - server mode: with ANTHROPIC_API_KEY it runs in the reactions queue after the member
 *     reactions, on every eligible save (radarCheck);
 *   - agent mode: without a key, the MCP tool radar_check hands the calling agent the case
 *     (gatherRadar + radarPrompt), the agent judges with its own model and reports the collisions
 *     with radar_report, which raises the same inbox questions (raiseConflicts). `_system/radar.json` remembers which version was checked and
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

/** What the radar compares: the saved document and the teammates' documents closest to it. */
export interface RadarCase {
  path: string
  row: FileRow
  title: string
  body: string
  candidates: { path: string; row: FileRow; body: string; title: string }[]
  state: RadarState
}

/**
 * Pick the neighbourhood of one saved document. Returns why it was skipped, or the case to judge.
 * `recheck` ignores "already checked this version" (an agent asked explicitly).
 */
export async function gatherRadar(deps: RecallDeps, job: { path: string; etag?: string }, recheck = false): Promise<RadarCase | { status: 'skipped'; reason: string }> {
  const path = job.path.replace(/\\/g, '/')
  if (!isReactablePath(path) || isPersonalPath(path)) return { status: 'skipped', reason: 'path not eligible' }
  const row = await deps.meta.get(path)
  if (!row || row.deleted) return { status: 'skipped', reason: 'document gone' }
  if (job.etag && job.etag !== row.etag) return { status: 'skipped', reason: 'superseded by a newer save' }
  if (row.author === RADAR_AUTHOR || row.author === REACTION_AUTHOR) return { status: 'skipped', reason: 'bot document' }

  const state = await readRadarState(deps)
  if (!recheck && state.checked[path] === row.etag) return { status: 'skipped', reason: 'already checked this version' }

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
  const candidates: RadarCase['candidates'] = []
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
  return { path, row, title: doc.title, body: doc.body, candidates, state }
}

/** The prompt text: the new document, then each related one with its author and date. */
export function radarPrompt(c: RadarCase): string {
  return [
    `# NEW DOCUMENT`, `Path: ${c.path}`, `Title: ${c.title}`, `Saved by: ${c.row.author || 'unknown'} at ${new Date(c.row.updatedAt).toISOString()}`, '', clip(c.body, RADAR_DOC_MAX_CHARS), '',
    `# RELATED DOCUMENTS`,
    ...c.candidates.map(x => [`## ${x.path}`, `Title: ${x.title}`, `Written by: ${x.row.author || 'unknown'} at ${new Date(x.row.updatedAt).toISOString()}`, '', clip(x.body, RADAR_CANDIDATE_MAX_CHARS), ''].join('\n')),
  ].join('\n')
}

/**
 * Turn judged collisions into inbox questions to the saver (once per pair per week) and mark the
 * version checked. Shared by the server's model and by an agent reporting its own judgement.
 */
export async function raiseConflicts(deps: SyncDeps & { now?: () => number; log?: (m: string) => void }, c: RadarCase, conflicts: Conflict[]): Promise<string[]> {
  const log = deps.log ?? (() => {})
  const now = (deps.now ?? Date.now)()
  const sent: string[] = []
  for (const k of conflicts) {
    const key = pairKey(c.path, k.path)
    if (c.state.raised[key] && now - c.state.raised[key] < RADAR_PAIR_COOLDOWN_MS) continue
    const other = c.candidates.find(x => x.path === k.path)
    if (!other) continue
    const to = c.row.author || 'unknown'
    const title = `${k.severity === 'contradiction' ? '⚡' : '〰'} ${c.title} ↔ ${other.title}`
    const body = [
      `**${c.title}** (${c.row.author}, ${new Date(c.row.updatedAt).toISOString().slice(0, 10)}) says:`, `> ${k.here}`, '',
      `**${other.title}** (${other.row.author || 'unknown'}, ${new Date(other.row.updatedAt).toISOString().slice(0, 10)}) says:`, `> ${k.there}`, '',
      k.note, '',
      `Which one holds? Update the other document, or answer here with why both are right.`,
    ].join('\n')
    const r = await sendInbox({ ...deps, viewer: { sub: 'service', service: true }, author: RADAR_AUTHOR }, {
      to, toSub: c.row.authorSub && c.row.authorSub !== 'service' ? c.row.authorSub : undefined,
      kind: 'question', title, body, about: [c.path, k.path],
    })
    if ('error' in r) { log(`[radar] inbox failed for ${c.path}: ${r.error}`); continue }
    c.state.raised[key] = now
    sent.push(r.path)
  }
  c.state.checked[c.path] = c.row.etag
  await writeRadarState(deps, c.state)
  return sent
}

/** Server mode: check one saved document with the server's model; raise inbox questions for real collisions. */
export async function radarCheck(deps: RadarDeps, job: { path: string; etag?: string }): Promise<RadarOutcome> {
  const log = deps.log ?? (() => {})
  const c = await gatherRadar(deps, job)
  if ('status' in c) return c
  if (c.candidates.length === 0) {
    c.state.checked[c.path] = c.row.etag; await writeRadarState(deps, c.state)
    return { status: 'checked', candidates: 0, conflicts: [], sent: [] }
  }
  const text = await deps.llm({ system: RADAR_SYSTEM, user: radarPrompt(c), maxTokens: 1200, effort: 'medium' })
  const conflicts = parseConflicts(text, new Set(c.candidates.map(x => x.path)))
  const sent = await raiseConflicts(deps, c, conflicts)
  log(`[radar] ${c.path}: ${c.candidates.length} candidates, ${conflicts.length} conflict(s), ${sent.length} question(s)`)
  return { status: 'checked', candidates: c.candidates.length, conflicts, sent }
}
