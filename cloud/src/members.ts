/**
 * AI members — the roles a team hands to an AI, each with a lens, a patch of the vault it looks
 * after, standing routines and a memory note of its own.
 *
 * A member is not a reviewer that reacts once and forgets. It keeps `_members/<Name> (memory).md` in the
 * vault (positions it has taken, questions it is waiting on, a log), it reacts when a document in
 * its scope is saved, and it runs its routines when someone's MCP client takes on its identity
 * (`/mcp__strata__member name=…`). Everything it wants the team to adopt goes through
 * proposals; only its own note is written directly.
 *
 * The server stores the configuration (`_system/members.json`) and hands members out over MCP;
 * save reactions run on the server when ANTHROPIC_API_KEY is set (see reactions.ts).
 */
import type { SyncDeps } from './sync.js'

export const MEMBERS_KEY = '_system/members.json'
export const MEMBERS_FOLDER = '_members'
export const MAX_MEMBERS = 12
export const MAX_ROUTINES = 12
export const MAX_RUNS_KEPT = 5

export type Cadence = 'daily' | 'weekly' | 'manual'

export interface RoutineRun { at: number; by: string; summary: string; proposals: string[] }

export interface Routine {
  id: string
  title: string
  instructions: string
  cadence: Cadence
  enabled: boolean
  runs: RoutineRun[]
}

export interface Member {
  id: string
  name: string
  /** The role in one or two sentences: what this member cares about and how it thinks. */
  role: string
  /** Vault folders (prefixes) and tags this member looks after. Both empty = the whole vault. */
  scope: { folders: string[]; tags: string[] }
  /** Leave a remark when a document in scope is saved (needs ANTHROPIC_API_KEY on the server). */
  reactsOnSave: boolean
  enabled: boolean
  routines: Routine[]
}

export interface MembersConfig { version: 1; members: Member[] }

const enc = new TextEncoder()
const dec = new TextDecoder()

/** `_members/<Name> (memory).md` — the suffix keeps it from colliding with a vault document named after the member. */
export function memberNotePath(member: Pick<Member, 'name'>): string {
  return `${MEMBERS_FOLDER}/${memberNoteName(member)}.md`
}
export function memberNoteName(member: Pick<Member, 'name'>): string {
  return `${safeName(member.name)} (memory)`
}

/** Where a member's remark about a saved document lives: `_members/<Name>/<doc path>`. */
export function remarkPathFor(member: Pick<Member, 'name'>, docPath: string): string {
  return `${MEMBERS_FOLDER}/${safeName(member.name)}/${docPath.replace(/\\/g, '/')}`
}

export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '-').trim().replace(/\s+/g, ' ').slice(0, 80) || 'member'
}

/** Whether a document falls inside a member's scope. */
export function inScope(member: Member, doc: { path: string; tags?: string[] }): boolean {
  const { folders, tags } = member.scope
  if (folders.length === 0 && tags.length === 0) return true
  const p = doc.path.replace(/\\/g, '/')
  if (folders.some(f => { const x = f.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''); return x === '' || p === x || p.startsWith(x + '/') })) return true
  const docTags = new Set((doc.tags ?? []).map(t => t.toLowerCase()))
  return tags.some(t => docTags.has(t.toLowerCase()))
}

// ── Defaults and templates ────────────────────────────────────────────────────

const R = (id: string, title: string, cadence: Cadence, instructions: string): Routine => ({ id, title, cadence, instructions, enabled: true, runs: [] })

/** The one member every vault starts with: the keeper of the shared memory. */
export const DEFAULT_MEMBER: Member = {
  id: 'librarian', name: 'Librarian', enabled: true, reactsOnSave: true,
  role: 'You keep the team\'s shared memory coherent. You care about whether what we believe fits together, what we keep deferring, and which ideas are the same idea under different names. You never decide for the team; you make the tensions visible.',
  scope: { folders: [], tags: [] },
  routines: [
    R('contradictions', 'Where do our recent decisions contradict each other?', 'daily',
      'Call vault_changes for the last 3 days. For the documents that changed, read them and the documents they link to. Where a new statement contradicts an older one still in the vault (a number, a rule, an owner, a deadline), propose a note titled "Contradiction: A vs B" that quotes both passages and asks which one is true now. Link both. Record the pairs you checked in your memory note so you do not raise them twice.'),
    R('same-idea', 'Which ideas are the same idea under different names?', 'weekly',
      'Run graph_lint with rules ["near-duplicate"] and read the top pairs. Where two documents are really one idea, propose a note titled "Same idea: A ↔ B" saying what they share, where they differ, and which name the team should keep. Link both. Skip pairs already in your memory note.'),
    R('deferred', 'What does the team keep deferring?', 'weekly',
      'Search the vault (vault_search) for open questions: "TBD", "TODO", "미정", "나중에", "?" headings, "open question", "decision needed". Read your memory note for what you flagged before. Propose one note titled "Still open — <ISO week>" listing the questions that have been open for more than two weeks, each with the document it lives in and who last touched it. Update your memory note with the list.'),
    R('images', 'Which images have no words yet?', 'daily',
      'Call images_undescribed. For each image, vault_read it, then vault_write its image document with a description in the vault\'s language (what it shows, how it is composed, any visible text transcribed under "Text:", and a "Tags:" line), keeping the rest of the document. Skip nothing; report how many you described.'),
    R('learned', 'What did we learn this week?', 'weekly',
      'Call vault_changes for the last 7 days and read the substantive changes (not renames). Propose one note titled "What we learned — <ISO week>": the three to seven things the team now believes that it did not believe last week, each linked to its source document, and one question that the week left open. Under 300 words. Log the week in your memory note.'),
  ],
}

/** Roles a team can add when nobody on the team holds them. */
export const TEMPLATES: Record<string, Omit<Member, 'id'>> = {
  designer: {
    name: 'Designer', enabled: true, reactsOnSave: true,
    role: 'You hold the user\'s eye and hand. You care about flows, screens, states, naming and visual consistency, and you notice when a plan describes behaviour without saying what the person actually sees or does.',
    scope: { folders: [], tags: ['ui', 'ux', 'design'] },
    routines: [
      R('missing-screens', 'Which documents describe behaviour with no screen?', 'weekly', 'Search the vault for documents mentioning screens, flows, buttons, dialogs or "UI" (vault_search several phrasings, in the vault\'s language) that have no linked mockup, image or screen description. Propose one note titled "Undesigned: <ISO week>" listing them with the passage that needs a screen. Note them in your memory so you do not repeat yourself.'),
      R('consistency', 'Where do we contradict our own design language?', 'weekly', 'Read the vault\'s design principles or style documents (search for "design language", "style guide", "principles", "디자인"). Then read documents changed in the last 7 days (vault_changes) in your scope and propose a note per real conflict titled "Off-language: <document>" quoting the rule and the passage. Nothing if nothing conflicts.'),
    ],
  },
  editor: {
    name: 'Editor', enabled: true, reactsOnSave: true,
    role: 'You care about whether a document can be understood by someone who was not in the room: what it claims, what it decides, who owns it, and what it assumes without saying.',
    scope: { folders: [], tags: [] },
    routines: [
      R('unclear-owner', 'Which decisions have no owner or date?', 'weekly', 'Search for decision-like documents (type: decision, "결정", "decided", "we will"). Propose one note titled "Ownerless decisions — <ISO week>" listing those with no owner, date or status, each linked. Skip ones already in your memory note.'),
    ],
  },
  researcher: {
    name: 'Researcher', enabled: true, reactsOnSave: true,
    role: 'You care about evidence. You ask what would have to be true for a claim to hold, which sources it rests on, and whether newer documents have quietly undermined it.',
    scope: { folders: [], tags: [] },
    routines: [
      R('undermined', 'Which claims did newer documents undermine?', 'weekly', 'Call vault_changes for the last 7 days. For each changed document, find older documents that link to it or that it contradicts (vault_search on its key terms). Propose a note per case titled "Undermined: <older document>" quoting the old claim and the new text. Link both. Record checked pairs in your memory.'),
    ],
  },
  pm: {
    name: 'Product lead', enabled: true, reactsOnSave: true,
    role: 'You care about what the team is actually committing to: which decisions are open, which depend on each other, and what the next decision should be.',
    scope: { folders: [], tags: [] },
    routines: [
      R('decision-queue', 'What decision should we make next?', 'weekly', 'From vault_changes (14 days) and the open questions in your memory note, propose one note titled "Decide next — <ISO week>": the three decisions that unblock the most other documents, each with the documents waiting on it. Update your memory note.'),
    ],
  },
  continuity: {
    name: 'Continuity', enabled: true, reactsOnSave: true,
    role: 'You keep the world consistent: timelines, places, who knows what, what has already been established. You notice when new material contradicts canon.',
    scope: { folders: [], tags: [] },
    routines: [
      R('canon-check', 'What did this week\'s changes break in the canon?', 'weekly', 'Call vault_changes for the last 7 days and read the substantive changes. For each, search the vault for the entities it mentions (names, places, events) and read their documents. Propose a note per conflict titled "Continuity: <entity>" quoting the established fact and the new text. Record checked documents in your memory.'),
    ],
  },
}

// ── Validation and storage ────────────────────────────────────────────────────

const SLUG = /^[a-z0-9_-]{1,40}$/

export function validateMembers(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'config must be an object'
  const c = input as Partial<MembersConfig>
  if (!Array.isArray(c.members)) return 'members must be an array'
  if (c.members.length > MAX_MEMBERS) return `at most ${MAX_MEMBERS} members`
  const ids = new Set<string>(), names = new Set<string>()
  for (const m of c.members as Partial<Member>[]) {
    if (!m || typeof m.id !== 'string' || !SLUG.test(m.id)) return 'member id must be a short slug'
    if (ids.has(m.id)) return `duplicate member id ${m.id}`
    ids.add(m.id)
    if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) return `member ${m.id}: name required`
    const key = safeName(m.name).toLowerCase()
    if (names.has(key)) return `two members would share the note ${memberNotePath({ name: m.name })}`
    names.add(key)
    if (typeof m.role !== 'string' || !m.role.trim() || m.role.length > 2000) return `member ${m.id}: role required (≤2000 chars)`
    if (!m.scope || !Array.isArray(m.scope.folders) || !Array.isArray(m.scope.tags)) return `member ${m.id}: scope needs folders and tags arrays`
    if ([...m.scope.folders, ...m.scope.tags].some(x => typeof x !== 'string' || x.length > 200)) return `member ${m.id}: scope entries must be strings`
    if (typeof m.reactsOnSave !== 'boolean' || typeof m.enabled !== 'boolean') return `member ${m.id}: reactsOnSave and enabled must be booleans`
    if (!Array.isArray(m.routines)) return `member ${m.id}: routines must be an array`
    if (m.routines.length > MAX_ROUTINES) return `member ${m.id}: at most ${MAX_ROUTINES} routines`
    const rids = new Set<string>()
    for (const r of m.routines as Partial<Routine>[]) {
      if (!r || typeof r.id !== 'string' || !SLUG.test(r.id)) return `member ${m.id}: routine id must be a short slug`
      if (rids.has(r.id)) return `member ${m.id}: duplicate routine ${r.id}`
      rids.add(r.id)
      if (typeof r.title !== 'string' || !r.title.trim() || r.title.length > 160) return `routine ${r.id}: title required`
      if (typeof r.instructions !== 'string' || !r.instructions.trim() || r.instructions.length > 4000) return `routine ${r.id}: instructions required (≤4000 chars)`
      if (!['daily', 'weekly', 'manual'].includes(r.cadence as string)) return `routine ${r.id}: cadence must be daily, weekly or manual`
      if (typeof r.enabled !== 'boolean') return `routine ${r.id}: enabled must be boolean`
    }
  }
  return null
}

function fresh(): MembersConfig {
  return { version: 1, members: [{ ...DEFAULT_MEMBER, routines: DEFAULT_MEMBER.routines.map(r => ({ ...r, runs: [] })) }] }
}

function normalize(c: MembersConfig): MembersConfig {
  return {
    version: 1,
    members: c.members.map(m => ({
      id: m.id, name: m.name.trim(), role: m.role.trim(), enabled: m.enabled, reactsOnSave: m.reactsOnSave,
      scope: { folders: m.scope.folders.map(f => f.trim()).filter(Boolean), tags: m.scope.tags.map(t => t.trim().replace(/^#/, '')).filter(Boolean) },
      routines: m.routines.map(r => ({ id: r.id, title: r.title.trim(), instructions: r.instructions.trim(), cadence: r.cadence, enabled: r.enabled, runs: (r.runs ?? []).slice(-MAX_RUNS_KEPT) })),
    })),
  }
}

export async function readMembers(deps: Pick<SyncDeps, 'blobs'>): Promise<MembersConfig> {
  const bytes = await deps.blobs.get(MEMBERS_KEY)
  if (!bytes) return fresh()
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as MembersConfig
    return validateMembers(parsed) ? fresh() : normalize(parsed)
  } catch {
    return fresh()
  }
}

async function writeMembers(deps: Pick<SyncDeps, 'blobs'>, config: MembersConfig): Promise<void> {
  await deps.blobs.put(MEMBERS_KEY, enc.encode(JSON.stringify(normalize(config))))
}

/** Edits from the app replace definitions; run history reported by clients is kept per routine. */
export async function saveMemberDefinitions(deps: Pick<SyncDeps, 'blobs'>, incoming: MembersConfig): Promise<MembersConfig> {
  const current = await readMembers(deps)
  const runs = new Map<string, RoutineRun[]>()
  for (const m of current.members) for (const r of m.routines) runs.set(`${m.id}/${r.id}`, r.runs)
  const merged: MembersConfig = {
    version: 1,
    members: incoming.members.map(m => ({ ...m, routines: m.routines.map(r => ({ ...r, runs: runs.get(`${m.id}/${r.id}`) ?? [] })) })),
  }
  await writeMembers(deps, merged)
  return readMembers(deps)
}

export async function recordRoutineRun(deps: Pick<SyncDeps, 'blobs'>, memberId: string, routineId: string, run: RoutineRun): Promise<Routine | null> {
  const config = await readMembers(deps)
  const routine = config.members.find(m => m.id === memberId)?.routines.find(r => r.id === routineId)
  if (!routine) return null
  routine.runs = [...routine.runs, run].slice(-MAX_RUNS_KEPT)
  await writeMembers(deps, config)
  return routine
}

export function findMember(config: MembersConfig, idOrName: string): Member | undefined {
  const key = idOrName.trim().toLowerCase()
  return config.members.find(m => m.id === key || m.name.toLowerCase() === key)
}

/** Routines due now by cadence and last run; manual ones only when forced. */
export function dueRoutines(member: Member, now: number, force = false): Routine[] {
  const DAY = 24 * 60 * 60 * 1000
  return member.routines.filter(r => {
    if (!r.enabled) return false
    if (force) return true
    if (r.cadence === 'manual') return false
    const last = r.runs.length ? r.runs[r.runs.length - 1].at : 0
    return now - last >= (r.cadence === 'daily' ? DAY : 7 * DAY) * 0.9
  })
}

/** The MCP prompt a client follows when it takes on a member's identity. */
export function renderMemberPrompt(member: Member, routines: Routine[], memoryNote: string | null, now: number, runner: string): string {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  const scope = [
    ...member.scope.folders.map(f => `folder ${f}/`),
    ...member.scope.tags.map(t => `tag #${t}`),
  ]
  const lines = [
    `You are ${member.name}, an AI member of this team, working from ${runner || 'a teammate'}'s client. Now: ${fmt(now)}.`,
    '',
    `Your role: ${member.role}`,
    `Your scope: ${scope.length ? scope.join(', ') : 'the whole vault'}.`,
    '',
    'How you work:',
    `- Your memory is the vault note ${memberNotePath(member)} (link it as [[${memberNoteName(member)}]]). Read it first; it is what you said and asked before. Append to it with member_remember when you take a position, ask a question, or finish a routine — that is the only document you write directly.`,
    '- Read with vault_search, vault_recall, vault_read, vault_list, vault_changes, vault_history and graph_lint. Never edit other documents — with one exception: image documents whose description is still empty (images_undescribed) are yours to fill in with vault_write.',
    '- Anything you want the team to adopt goes through vault_propose (it lands in _agent/ for a person to promote). Set `source` to your member id. Be specific, quote what you rely on, link the documents you used, and do not repeat a proposal that already exists (vault_proposals) or that your memory says you already raised.',
    '- Some documents are marked personal: they belong to the person running you and nobody else can see them. Use them to think with that person, but never quote or mention them in your memory note, in proposals, or in anything another person could read, unless the person explicitly asks you to.',
    '- Write in the language the vault is written in.',
    `- After each routine, call member_report with your member id, the routine id, a two-sentence summary and the proposal paths you created — even when you proposed nothing.`,
    '',
    '## Your memory note',
    memoryNote ? memoryNote.trim() : '(empty — this is your first day; start it with member_remember)',
    '',
    routines.length ? `## Routines to run now (${routines.length})` : '## No routines are due right now',
  ]
  for (const r of routines) {
    const last = r.runs.length ? r.runs[r.runs.length - 1] : null
    lines.push('', `### ${r.title}  (routine id: ${r.id}, ${r.cadence})`, last ? `Last run: ${fmt(last.at)} by ${last.by} — ${last.summary}` : 'Last run: never', '', r.instructions)
  }
  if (routines.length === 0) lines.push('', 'You may still answer questions from your teammate in this role, using your memory and the vault.')
  return lines.join('\n')
}

/** Initial content of a member's memory note. */
export function renderMemoryNote(member: Member): string {
  return [
    '---',
    `title: ${JSON.stringify(`${member.name} — memory`)}`,
    `member: ${member.id}`,
    'tags: [member-memory]',
    'graph_weight: low',
    '---',
    '',
    `# ${member.name} — memory`,
    '',
    `_${member.role}_`,
    '',
    '## Positions',
    '',
    '## Open questions',
    '',
    '## Log',
    '',
  ].join('\n')
}
