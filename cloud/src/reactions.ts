/**
 * Save reactions — when a document lands on the server, each AI member whose scope covers it
 * leaves a short remark: what this changes, where it collides with what the member already
 * knows (its memory note, the linked documents), and one question. The remark is written to
 * `_members/<Name>/<document path>`, wikilinked back, so it is on everyone's machine before
 * the next conversation without anyone pressing a button.
 *
 * Cost controls: one reaction per document content hash, a cooldown per path, folders and file
 * names that never trigger, a cap on the text sent. The LLM is injected so this module is
 * tested without network; without ANTHROPIC_API_KEY on the server nothing runs.
 */
import { putFile, type FileRow, type SyncDeps } from './sync.js'
import { parseVaultDoc } from '../../mcp/src/lint/vaultDoc.js'
import { readMembers, inScope, memberNotePath, memberNoteName, remarkPathFor, type Member, type MembersConfig } from './members.js'
import { previousVersion, diffLines } from './history.js'

export const REACTION_STATE_KEY = '_system/reactions.json'
export const REACTION_AUTHOR = 'strata-bot'
/** A path is not reacted to again within this window even if it keeps changing. */
export const REACTION_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** Shorter saves are notes, not something to react to. */
export const REACTION_MIN_CHARS = 400
/** Longest document body handed to a member. */
export const REACTION_MAX_CHARS = 12_000
const MEMORY_MAX_CHARS = 4_000
const DIFF_MAX_CHARS = 6_000

export interface ReactionJob { path: string; etag?: string }

export interface ReactionState {
  version: 1
  /** path → what was last reacted to */
  reacted: Record<string, { etag: string; at: number; remarks: string[] }>
}

export interface LlmCall {
  (args: { system: string; user: string; maxTokens: number; effort: 'low' | 'medium' | 'high' }): Promise<string>
}

export interface ReactionDeps extends SyncDeps {
  llm: LlmCall
  log?: (msg: string) => void
  /** Vault-relative folder prefixes eligible; empty = every folder not starting with `_` or `.`. */
  reactFolders?: string[]
  /** Member set; read from _system/members.json when absent. */
  members?: MembersConfig
}

export type ReactionOutcome =
  | { status: 'reacted'; remarks: string[]; members: number }
  | { status: 'skipped'; reason: string }
  | { status: 'deferred'; retryAfterMs: number }

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Eligibility ──────────────────────────────────────────────────────────────

/** Whether a vault path is the kind of document members react to. */
export function isReactablePath(path: string, reactFolders: string[] = []): boolean {
  const p = path.replace(/\\/g, '/')
  if (!p.toLowerCase().endsWith('.md')) return false
  const segments = p.split('/')
  if (segments.some(s => s.startsWith('_') || s.startsWith('.'))) return false      // _reports, _members, _agent, .obsidian
  if (/\(conflict [^)]*\)\.md$/i.test(p)) return false                              // sync conflict copies
  if (reactFolders.length === 0) return true
  return reactFolders.some(f => p === f || p.startsWith(f.replace(/\/+$/, '') + '/'))
}

/** For the producer side: decide whether a saved row deserves a job at all (cheap pre-filter). */
export function shouldEnqueueReaction(row: Pick<FileRow, 'path' | 'deleted' | 'size' | 'author'>, reactFolders: string[] = []): boolean {
  if (row.deleted) return false
  if (row.author === REACTION_AUTHOR) return false
  if (row.size < REACTION_MIN_CHARS) return false
  return isReactablePath(row.path, reactFolders)
}

// ── State ────────────────────────────────────────────────────────────────────

export async function readReactionState(deps: SyncDeps): Promise<ReactionState> {
  const bytes = await deps.blobs.get(REACTION_STATE_KEY)
  if (!bytes) return { version: 1, reacted: {} }
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as ReactionState
    return parsed.version === 1 && parsed.reacted ? parsed : { version: 1, reacted: {} }
  } catch { return { version: 1, reacted: {} } }
}

async function writeReactionState(deps: SyncDeps, state: ReactionState): Promise<void> {
  await deps.blobs.put(REACTION_STATE_KEY, enc.encode(JSON.stringify(state)))
}

// ── Prompt ───────────────────────────────────────────────────────────────────

function memberSystem(m: Member): string {
  return [
    `You are ${m.name}, an AI member of this team. Your role: ${m.role}`,
    'A teammate just saved a document in your scope. You will be given your own memory note (what you have said and asked before), what this save changed (a line diff against the previous version, when there is one) and the document.',
    'Write a short remark for the author, who will read it tomorrow morning. React to what changed, not to the whole document; use the rest of it as context. Be specific — quote or name the passages you mean. No praise, no summary of the document.',
    'Answer in the language the document is written in.',
    'Format exactly (omit a section when you have nothing for it):',
    '### What this changes',
    '- up to 3 bullets: what the team now believes or does differently',
    '### Collides with',
    '- up to 3 bullets: where it contradicts your memory or another document — name it',
    '### One question',
    '- a single question the author must answer',
  ].join('\n')
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd() + '\n\n[… truncated …]'
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function reactToSave(deps: ReactionDeps, job: ReactionJob): Promise<ReactionOutcome> {
  const log = deps.log ?? (() => {})
  const now = (deps.now ?? Date.now)()
  const path = job.path.replace(/\\/g, '/')

  if (!isReactablePath(path, deps.reactFolders ?? [])) return { status: 'skipped', reason: 'path not reactable' }
  const row = await deps.meta.get(path)
  if (!row || row.deleted) return { status: 'skipped', reason: 'document gone' }
  if (job.etag && job.etag !== row.etag) return { status: 'skipped', reason: 'superseded by a newer save' }

  const state = await readReactionState(deps)
  const prev = state.reacted[path]
  if (prev && prev.etag === row.etag) return { status: 'skipped', reason: 'already reacted to this version' }
  if (prev && now - prev.at < REACTION_COOLDOWN_MS) return { status: 'deferred', retryAfterMs: REACTION_COOLDOWN_MS - (now - prev.at) }

  const bytes = await deps.blobs.get(path)
  if (!bytes) return { status: 'skipped', reason: 'content missing' }
  const doc = parseVaultDoc(path, dec.decode(bytes), row.mtime)
  if (doc.graphWeight === 'skip') return { status: 'skipped', reason: 'graph_weight: skip' }
  if (doc.body.trim().length < REACTION_MIN_CHARS) return { status: 'skipped', reason: 'too short' }

  const config = deps.members ?? await readMembers(deps)
  const members = config.members.filter(m => m.enabled && m.reactsOnSave && inScope(m, { path, tags: doc.tags }))
  if (members.length === 0) return { status: 'skipped', reason: 'no member has this document in scope' }

  // What this save changed — the previous version was archived by putFile before the overwrite
  const before = await previousVersion(deps.blobs, path, row.etag).catch(() => null)
  const change = before
    ? `## What this save changed (since ${new Date(before.version.at).toISOString().slice(0, 16).replace('T', ' ')} UTC by ${before.version.author || 'unknown'})\n\`\`\`diff\n${clip(diffLines(dec.decode(before.bytes), dec.decode(bytes)).text, DIFF_MAX_CHARS)}\n\`\`\``
    : '## What this save changed\n(first version of this document)'

  const remarks: string[] = []
  for (const m of members) {
    const noteBytes = await deps.blobs.get(memberNotePath(m))
    const memory = noteBytes ? clip(dec.decode(noteBytes), MEMORY_MAX_CHARS) : '(empty)'
    const user = `## Your memory note\n${memory}\n\n${change}\n\n## Document: ${doc.title}\nPath: ${path}\nSaved by: ${row.author || 'unknown'}\n\n---\n\n${clip(doc.body, REACTION_MAX_CHARS)}`
    const text = (await deps.llm({ system: memberSystem(m), user, maxTokens: 900, effort: 'medium' })).trim()
    const remarkPath = remarkPathFor(m, path)
    const markdown = renderRemark({ member: m, doc: { title: doc.title, filename: doc.filename, path, author: row.author, etag: row.etag }, text, now })
    const put = await putFile(deps, { path: remarkPath, body: enc.encode(markdown), mtime: now, author: REACTION_AUTHOR })
    if (put.status >= 400) { log(`[reactions] write failed for ${remarkPath}: ${JSON.stringify(put.body)}`); continue }
    remarks.push(remarkPath)
  }

  state.reacted[path] = { etag: row.etag, at: now, remarks }
  await writeReactionState(deps, state)
  log(`[reactions] ${path} → ${remarks.length} remark(s)`)
  return { status: 'reacted', remarks, members: members.length }
}

export function renderRemark(input: {
  member: Member
  doc: { title: string; filename: string; path: string; author: string; etag: string }
  text: string
  now: number
}): string {
  const date = new Date(input.now).toISOString()
  const docLink = input.doc.filename.replace(/\.md$/i, '')
  return [
    '---',
    `title: ${JSON.stringify(`${input.member.name} on ${input.doc.title}`)}`,
    `member: ${input.member.id}`,
    `reacted_path: ${JSON.stringify(input.doc.path)}`,
    `reacted_etag: ${input.doc.etag}`,
    `date: ${date.slice(0, 10)}`,
    'tags: [member-remark]',
    'graph_weight: low',
    '---',
    '',
    // Wikilinks resolve by file name, not by the frontmatter title
    `# ${input.member.name} on [[${docLink}]]`,
    '',
    `Saved by ${input.doc.author || 'unknown'} · ${date.slice(0, 16).replace('T', ' ')} UTC · memory: [[${memberNoteName(input.member)}]]`,
    '',
    input.text,
    '',
  ].join('\n')
}
