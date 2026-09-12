/**
 * Who reviews a saved document. The set is data, not code: a JSON document in R2 that the app
 * edits (Settings → Reviewers), with presets for common kinds of teams. Each reviewer has a lens
 * (the prompt they read with); one of them writes the synthesis.
 */
import type { SyncDeps } from './sync.js'

export const REVIEWERS_KEY = '_system/reviewers.json'
export const MAX_REVIEWERS = 8

export interface Reviewer {
  id: string
  name: string
  /** What this reviewer looks for — becomes the system prompt lens. */
  focus: string
  enabled: boolean
}

export interface ReviewerConfig {
  version: 1
  /** What the vault is, in a phrase ("a game studio's design wiki", "a legal team's contract library"). */
  context: string
  reviewers: Reviewer[]
  /** id of the reviewer who writes the synthesis (must be enabled). */
  synthesizer: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export const PRESETS: Record<string, ReviewerConfig> = {
  generic: {
    version: 1,
    context: "a team's shared knowledge base",
    synthesizer: 'editor',
    reviewers: [
      { id: 'editor', name: 'Editor', enabled: true, focus: 'Structure and consistency: is the document clear about what it claims, what it decides and who owns it? Where does it contradict or duplicate other documents in the vault?' },
      { id: 'fact', name: 'Fact checker', enabled: true, focus: 'Evidence: which statements are asserted without support, which numbers or dates look wrong, and what would have to be true for the document to hold?' },
      { id: 'reader', name: 'Reader advocate', enabled: true, focus: 'The person who has to act on this later: what will they misunderstand, what is missing for them to use it, and what jargon needs a definition or a link?' },
      { id: 'risk', name: 'Risk reviewer', enabled: true, focus: 'What can go wrong if this is followed as written — dependencies, irreversible steps, cost, security, legal or reputational exposure — and what is the mitigation?' },
      { id: 'exec', name: 'Executor', enabled: true, focus: 'Feasibility: what has to happen first, who does it, how long it takes, and what is the smallest version that proves the idea?' },
    ],
  },
  product: {
    version: 1,
    context: "a product team's decision log",
    synthesizer: 'pm',
    reviewers: [
      { id: 'pm', name: 'Product lead', enabled: true, focus: 'Does this serve the user and the roadmap? What decision is the document really asking for, and is the trade-off stated honestly?' },
      { id: 'eng', name: 'Engineering lead', enabled: true, focus: 'Feasibility and cost: what has to be built or changed, what is technically vague, what are the migration, performance and operational implications, and what is the smallest shippable slice?' },
      { id: 'design', name: 'Design lead', enabled: true, focus: 'User experience: flows, edge cases, states, accessibility, copy. What will users get wrong and what has not been designed yet?' },
      { id: 'data', name: 'Data and metrics', enabled: true, focus: 'How will we know it worked? Which metric moves, what is the baseline, what could confound it, and what instrumentation is missing?' },
      { id: 'ops', name: 'Support and operations', enabled: true, focus: 'What happens after launch: support load, documentation, rollout and rollback, customer communication, compliance.' },
    ],
  },
  legal: {
    version: 1,
    context: "a legal team's document library",
    synthesizer: 'counsel',
    reviewers: [
      { id: 'counsel', name: 'Lead counsel', enabled: true, focus: 'Does the document achieve its legal purpose? Which clauses are ambiguous, which conflict with other agreements or policies in the vault, and what exposure remains?' },
      { id: 'compliance', name: 'Compliance', enabled: true, focus: 'Regulatory and policy fit: data protection, sector rules, internal policy. What needs approval, notice or a record?' },
      { id: 'business', name: 'Business owner', enabled: true, focus: 'Commercial intent: does the text match what the business actually agreed, and where does it constrain future options?' },
      { id: 'ops', name: 'Operations', enabled: true, focus: 'Can the obligations be carried out as written — deadlines, deliverables, notices, who does what?' },
    ],
  },
  research: {
    version: 1,
    context: "a research group's lab notebook and literature notes",
    synthesizer: 'pi',
    reviewers: [
      { id: 'pi', name: 'Principal investigator', enabled: true, focus: 'Does the claim follow from the evidence? What is the hypothesis, what would falsify it, and how does it relate to the group’s prior results?' },
      { id: 'methods', name: 'Methods reviewer', enabled: true, focus: 'Design, sample, controls, statistics, confounders. What is under-specified for replication?' },
      { id: 'lit', name: 'Literature reviewer', enabled: true, focus: 'What prior work is missing or misread, which citations are stale or retracted, and which linked notes disagree with this one?' },
      { id: 'skeptic', name: 'Skeptic', enabled: true, focus: 'The strongest alternative explanation, the cheapest experiment that would distinguish it, and what the authors are assuming without saying.' },
    ],
  },
  worldbuilding: {
    version: 1,
    context: "a writers' room's story bible",
    synthesizer: 'showrunner',
    reviewers: [
      { id: 'showrunner', name: 'Showrunner', enabled: true, focus: 'Does this serve the story and its themes? What does it commit future episodes to, and where does it contradict established canon in the vault?' },
      { id: 'continuity', name: 'Continuity', enabled: true, focus: 'Timeline, geography, who knows what and when, who is alive, what has been established on screen or page. Name the exact conflicts.' },
      { id: 'character', name: 'Character', enabled: true, focus: 'Motivation and voice: is this consistent with how these characters have acted, and what does it change about them?' },
      { id: 'audience', name: 'Audience', enabled: true, focus: 'What will the audience feel, what will they not understand, and what promise does this make that must be paid off?' },
    ],
  },
  game: {
    version: 1,
    context: "a game studio's design wiki",
    synthesizer: 'chief',
    reviewers: [
      { id: 'chief', name: 'Chief Director', enabled: true, focus: 'Does this serve the product vision and the player? What decision is this document actually asking for, and is it clear who owns it? Where does it contradict other known decisions?' },
      { id: 'art', name: 'Art Director', enabled: true, focus: 'Visual identity, readability, tone and manner. What does this imply for concept, character, environment, UI and VFX work, and what asset or pipeline cost is hidden in it?' },
      { id: 'design', name: 'Design Director', enabled: true, focus: 'Systems and rules: are the mechanics fully specified, are edge cases covered, does it interact with existing systems (economy, progression, combat) in ways the author has not stated? What would you prototype first?' },
      { id: 'level', name: 'Level Director', enabled: true, focus: 'Spatial and pacing consequences: how does this play out in an actual level, encounter or session? What does it demand from layout, navigation, difficulty curve and content volume?' },
      { id: 'prog', name: 'Programming Director', enabled: true, focus: 'Feasibility and risk: what has to be built or changed, what is technically vague, where are the performance, networking, save-data or tooling implications, and what is the smallest version that proves it works?' },
    ],
  },
}

export const DEFAULT_REVIEWERS = PRESETS.generic

/** Validate user-supplied config; returns the error message or null. */
export function validateReviewers(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'config must be an object'
  const c = input as Partial<ReviewerConfig>
  if (typeof c.context !== 'string' || !c.context.trim() || c.context.length > 200) return 'context must be a short phrase'
  if (!Array.isArray(c.reviewers) || c.reviewers.length === 0) return 'at least one reviewer'
  if (c.reviewers.length > MAX_REVIEWERS) return `at most ${MAX_REVIEWERS} reviewers`
  const ids = new Set<string>()
  for (const r of c.reviewers as Partial<Reviewer>[]) {
    if (!r || typeof r.id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(r.id)) return 'reviewer id must be a short slug'
    if (ids.has(r.id)) return `duplicate reviewer id ${r.id}`
    ids.add(r.id)
    if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60) return `reviewer ${r.id}: name required`
    if (typeof r.focus !== 'string' || !r.focus.trim() || r.focus.length > 1500) return `reviewer ${r.id}: focus required (≤1500 chars)`
    if (typeof r.enabled !== 'boolean') return `reviewer ${r.id}: enabled must be boolean`
  }
  const enabled = (c.reviewers as Reviewer[]).filter(r => r.enabled)
  if (enabled.length === 0) return 'enable at least one reviewer'
  if (typeof c.synthesizer !== 'string' || !enabled.some(r => r.id === c.synthesizer)) return 'synthesizer must be an enabled reviewer'
  return null
}

export function normalizeReviewers(input: ReviewerConfig): ReviewerConfig {
  return {
    version: 1,
    context: input.context.trim(),
    synthesizer: input.synthesizer,
    reviewers: input.reviewers.map(r => ({ id: r.id, name: r.name.trim(), focus: r.focus.trim(), enabled: r.enabled })),
  }
}

export async function readReviewers(deps: Pick<SyncDeps, 'blobs'>): Promise<ReviewerConfig> {
  const bytes = await deps.blobs.get(REVIEWERS_KEY)
  if (!bytes) return DEFAULT_REVIEWERS
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as ReviewerConfig
    return validateReviewers(parsed) ? DEFAULT_REVIEWERS : normalizeReviewers(parsed)
  } catch {
    return DEFAULT_REVIEWERS
  }
}

export async function writeReviewers(deps: Pick<SyncDeps, 'blobs'>, config: ReviewerConfig): Promise<void> {
  await deps.blobs.put(REVIEWERS_KEY, enc.encode(JSON.stringify(normalizeReviewers(config))))
}
