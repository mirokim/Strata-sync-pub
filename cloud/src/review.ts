/**
 * Save-triggered director review.
 *
 * When a design document lands on the server (API PUT or an external write picked up by the R2
 * bridge), a review job is queued. The consumer asks five director personas — chief, art, design,
 * level, programming — to read the document independently, then has the chief synthesise the
 * disagreements and open questions. The result is written into the vault as
 * `_reviews/<document name>.md`, wikilinked back to the document, so it is on everyone's machine
 * before the next stand-up without anyone pressing a button.
 *
 * Cost controls: one review per document content hash, a cooldown per path, folders and file
 * names that are never reviewed, and a hard cap on the text sent per persona. The LLM is injected
 * so this module is tested without network.
 */
import { putFile, type FileRow, type SyncDeps } from './sync.js'
import { parseVaultDoc } from '../../mcp/src/lint/vaultDoc.js'

export const REVIEW_FOLDER = '_reviews'
export const REVIEW_STATE_KEY = '_system/reviews.json'
export const REVIEW_AUTHOR = 'strata-bot'
/** A path is not reviewed again within this window even if it keeps changing. */
export const REVIEW_COOLDOWN_MS = 6 * 60 * 60 * 1000
/** Documents shorter than this are notes, not specs — not worth five reviewers. */
export const REVIEW_MIN_CHARS = 400
/** Longest document body handed to a persona. */
export const REVIEW_MAX_CHARS = 12_000

export interface ReviewJob { path: string; etag?: string }

export interface Persona { id: string; name: string; focus: string }

export const PERSONAS: Persona[] = [
  { id: 'chief', name: 'Chief Director', focus: 'Does this serve the product vision and the player? What decision is this document actually asking for, and is it clear who owns it? Where does it contradict other known decisions?' },
  { id: 'art', name: 'Art Director', focus: 'Visual identity, readability, tone and manner. What does this imply for concept, character, environment, UI and VFX work, and what asset or pipeline cost is hidden in it?' },
  { id: 'design', name: 'Design Director', focus: 'Systems and rules: are the mechanics fully specified, are edge cases covered, does it interact with existing systems (economy, progression, combat) in ways the author has not stated? What would you prototype first?' },
  { id: 'level', name: 'Level Director', focus: 'Spatial and pacing consequences: how does this play out in an actual level, encounter or session? What does it demand from layout, navigation, difficulty curve and content volume?' },
  { id: 'prog', name: 'Programming Director', focus: 'Feasibility and risk: what has to be built or changed, what is technically vague, where are the performance, networking, save-data or tooling implications, and what is the smallest version that proves it works?' },
]

export interface ReviewState {
  version: 1
  /** path → what was last reviewed */
  reviewed: Record<string, { etag: string; at: number; reviewPath: string }>
}

export interface LlmCall {
  (args: { system: string; user: string; maxTokens: number; effort: 'low' | 'medium' | 'high' }): Promise<string>
}

export interface ReviewDeps extends SyncDeps {
  llm: LlmCall
  log?: (msg: string) => void
  /** Vault-relative folder prefixes eligible for review; empty = every folder not starting with `_` or `.`. */
  reviewFolders?: string[]
}

export type ReviewOutcome =
  | { status: 'reviewed'; reviewPath: string; personas: number }
  | { status: 'skipped'; reason: string }
  /** Inside the cooldown: the consumer should retry after `retryAfterMs` so the latest version still gets its review. */
  | { status: 'deferred'; retryAfterMs: number }

const enc = new TextEncoder()
const dec = new TextDecoder()

// ── Eligibility ──────────────────────────────────────────────────────────────

/** Whether a vault path is the kind of document the directors should look at. */
export function isReviewablePath(path: string, reviewFolders: string[] = []): boolean {
  const p = path.replace(/\\/g, '/')
  if (!p.toLowerCase().endsWith('.md')) return false
  const segments = p.split('/')
  if (segments.some(s => s.startsWith('_') || s.startsWith('.'))) return false      // _reports, _reviews, _agent, .obsidian
  if (/\(conflict [^)]*\)\.md$/i.test(p)) return false                              // sync conflict copies
  if (reviewFolders.length === 0) return true
  return reviewFolders.some(f => p === f || p.startsWith(f.replace(/\/+$/, '') + '/'))
}

/** `active/Enemy AI Spec.md` → `_reviews/active/Enemy AI Spec.md` — mirrors the folder so same-named documents do not collide. */
export function reviewPathFor(docPath: string): string {
  return `${REVIEW_FOLDER}/${docPath.replace(/\\/g, '/')}`
}

// ── State ────────────────────────────────────────────────────────────────────

export async function readReviewState(deps: SyncDeps): Promise<ReviewState> {
  const bytes = await deps.blobs.get(REVIEW_STATE_KEY)
  if (!bytes) return { version: 1, reviewed: {} }
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as ReviewState
    return parsed.version === 1 && parsed.reviewed ? parsed : { version: 1, reviewed: {} }
  } catch { return { version: 1, reviewed: {} } }
}

async function writeReviewState(deps: SyncDeps, state: ReviewState): Promise<void> {
  await deps.blobs.put(REVIEW_STATE_KEY, enc.encode(JSON.stringify(state)))
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function personaSystem(p: Persona): string {
  return [
    `You are the ${p.name} of a game studio reviewing a design document a colleague just saved to the team wiki.`,
    `Your lens: ${p.focus}`,
    '',
    'Write for the author, who will read this tomorrow morning. Be specific to this document — quote or name the parts you mean. No praise, no summary of the document.',
    'Answer in the language the document is written in.',
    'Format exactly:',
    '### Risks',
    '- up to 4 bullets, each one concrete risk or gap',
    '### Questions for the author',
    '- up to 3 questions that must be answered before this ships',
    '### One thing to do next',
    '- a single sentence',
  ].join('\n')
}

function synthesisSystem(): string {
  return [
    'You are the Chief Director of a game studio. Four directors and you have each reviewed the same design document.',
    'Combine the reviews into a short brief for the author and the team. Do not repeat every point — surface where reviewers disagree, what several of them worry about, and the decision the document is really asking for.',
    'Answer in the language the document is written in.',
    'Format exactly:',
    '## Where the directors disagree',
    '- bullets (omit the section if they agree)',
    '## Shared concerns',
    '- bullets',
    '## Decision needed',
    '- one or two sentences naming the decision and who should make it',
  ].join('\n')
}

function clip(text: string, max = REVIEW_MAX_CHARS): string {
  return text.length <= max ? text : text.slice(0, max).trimEnd() + '\n\n[… document truncated for review …]'
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function reviewDocument(deps: ReviewDeps, job: ReviewJob): Promise<ReviewOutcome> {
  const log = deps.log ?? (() => {})
  const now = (deps.now ?? Date.now)()
  const path = job.path.replace(/\\/g, '/')

  if (!isReviewablePath(path, deps.reviewFolders ?? [])) return { status: 'skipped', reason: 'path not reviewable' }
  const row = await deps.meta.get(path)
  if (!row || row.deleted) return { status: 'skipped', reason: 'document gone' }
  if (job.etag && job.etag !== row.etag) return { status: 'skipped', reason: 'superseded by a newer save' }

  const state = await readReviewState(deps)
  const prev = state.reviewed[path]
  if (prev && prev.etag === row.etag) return { status: 'skipped', reason: 'already reviewed this version' }
  if (prev && now - prev.at < REVIEW_COOLDOWN_MS) return { status: 'deferred', retryAfterMs: REVIEW_COOLDOWN_MS - (now - prev.at) }

  const bytes = await deps.blobs.get(path)
  if (!bytes) return { status: 'skipped', reason: 'content missing' }
  const doc = parseVaultDoc(path, dec.decode(bytes), row.mtime)
  if (doc.graphWeight === 'skip') return { status: 'skipped', reason: 'graph_weight: skip' }
  if (doc.body.trim().length < REVIEW_MIN_CHARS) return { status: 'skipped', reason: 'too short to review' }

  const userMessage = `Document: ${doc.title}\nPath: ${path}\nAuthor of this save: ${row.author || 'unknown'}\n\n---\n\n${clip(doc.body)}`

  // Five independent reads, in parallel — they must not see each other.
  const reviews = await Promise.all(PERSONAS.map(async p => ({
    persona: p,
    text: (await deps.llm({ system: personaSystem(p), user: userMessage, maxTokens: 1200, effort: 'medium' })).trim(),
  })))

  const synthesis = (await deps.llm({
    system: synthesisSystem(),
    user: `Document: ${doc.title}\n\n${reviews.map(r => `# ${r.persona.name}\n${r.text}`).join('\n\n')}`,
    maxTokens: 1500,
    effort: 'high',
  })).trim()

  const reviewPath = reviewPathFor(path)
  const markdown = renderReview({ doc: { title: doc.title, filename: doc.filename, path, author: row.author, etag: row.etag }, reviews, synthesis, now })
  const put = await putFile(deps, { path: reviewPath, body: enc.encode(markdown), mtime: now, author: REVIEW_AUTHOR })
  if (put.status >= 400) {
    log(`[review] write failed for ${reviewPath}: ${JSON.stringify(put.body)}`)
    return { status: 'skipped', reason: `write failed (${put.status})` }
  }

  state.reviewed[path] = { etag: row.etag, at: now, reviewPath }
  await writeReviewState(deps, state)
  log(`[review] ${path} → ${reviewPath}`)
  return { status: 'reviewed', reviewPath, personas: PERSONAS.length }
}

export function renderReview(input: {
  doc: { title: string; filename: string; path: string; author: string; etag: string }
  reviews: { persona: Persona; text: string }[]
  synthesis: string
  now: number
}): string {
  const date = new Date(input.now).toISOString()
  const lines: string[] = [
    '---',
    `title: ${JSON.stringify(`Review: ${input.doc.title}`)}`,
    `reviewed_path: ${JSON.stringify(input.doc.path)}`,
    `reviewed_etag: ${input.doc.etag}`,
    `reviewed_at: ${date}`,
    `reviewed_save_by: ${JSON.stringify(input.doc.author)}`,
    `reviewers: ${JSON.stringify(input.reviews.map(r => r.persona.id))}`,
    'tags: ["review"]',
    'graph_weight: low',
    '---',
    '',
    // Wikilinks resolve by file name, not by the frontmatter title
    `# Director review — [[${input.doc.filename.replace(/\.md$/i, '')}]]`,
    '',
    ...(input.doc.title !== input.doc.filename.replace(/\.md$/i, '') ? [`_${input.doc.title}_`, ''] : []),
    `Saved by ${input.doc.author || 'unknown'} · reviewed ${date.slice(0, 16).replace('T', ' ')} UTC · five independent reads, then a synthesis.`,
    '',
    input.synthesis,
    '',
    '---',
    '',
  ]
  for (const r of input.reviews) {
    lines.push(`## ${r.persona.name}`, '', r.text, '')
  }
  return lines.join('\n')
}

/** For the producer side: decide whether a saved row deserves a job at all (cheap pre-filter). */
export function shouldEnqueueReview(row: Pick<FileRow, 'path' | 'deleted' | 'size' | 'author'>, reviewFolders: string[] = []): boolean {
  if (row.deleted) return false
  if (row.author === REVIEW_AUTHOR) return false
  if (row.size < REVIEW_MIN_CHARS) return false
  return isReviewablePath(row.path, reviewFolders)
}
