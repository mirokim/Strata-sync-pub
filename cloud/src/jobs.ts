/**
 * Agent jobs — standing instructions for whatever AI client is connected over MCP.
 *
 * The server never runs a model for these. It stores the jobs (Settings → Jobs), hands them to
 * a client as an MCP prompt (`jobs`), gives the client the tools it needs (graph_lint,
 * vault_changes, vault_search, vault_propose…) and records what the client reports back
 * (`jobs_report`). Anyone can run them from Claude Code with `/mcp__strata__jobs`, or on a
 * schedule with a cron line — the intelligence is the client's own subscription, no API key
 * on the server. Output goes only to `_agent/` proposals, so a person still promotes.
 */
import type { SyncDeps } from './sync.js'

export const JOBS_KEY = '_system/jobs.json'
export const MAX_JOBS = 20
export const MAX_RUNS_KEPT = 5

export type Cadence = 'daily' | 'weekly' | 'manual'

export interface JobRun {
  at: number
  by: string
  summary: string
  /** Vault paths of proposals the run created. */
  proposals: string[]
}

export interface Job {
  id: string
  title: string
  /** Natural-language instructions the client follows. */
  instructions: string
  cadence: Cadence
  enabled: boolean
  runs: JobRun[]
}

export interface JobsConfig { version: 1; jobs: Job[] }

const enc = new TextEncoder()
const dec = new TextDecoder()

export const DEFAULT_JOBS: Job[] = [
  {
    id: 'draft-missing', title: 'Draft the documents everyone links to but nobody wrote', cadence: 'daily', enabled: true, runs: [],
    instructions: 'Run graph_lint with rules ["phantom-hot"]. For the three most-referenced missing documents: read the documents that link to them (vault_read), and write a first draft that says what those documents assume the missing one contains — headings, the facts they rely on, open questions. Propose each with vault_propose, title = the missing document\'s exact name, links = the documents you read. Skip a target if a proposal with that title already exists (vault_proposals).',
  },
  {
    id: 'connect-lookalikes', title: 'Connect or merge documents that say the same thing without linking', cadence: 'weekly', enabled: true, runs: [],
    instructions: 'Run graph_lint with rules ["near-duplicate"]. For up to five pairs, read both documents and decide: link them, merge them, or leave them. Propose one note per pair titled "Link or merge: A ↔ B" that quotes the overlapping passages, states your recommendation and, if merging, drafts the merged outline. Link both documents.',
  },
  {
    id: 'stale-hubs', title: 'Ask whether important documents are still true', cadence: 'weekly', enabled: true, runs: [],
    instructions: 'Run graph_lint with rules ["stale-hub"]. For up to three hubs, read the document and the documents that changed around it recently (vault_changes for the last 30 days, then vault_read the ones that link to the hub). Propose a note titled "Still true? — <hub name>" listing the specific claims in the hub that the newer documents contradict or make doubtful, each with the source. If nothing contradicts it, do not propose anything.',
  },
  {
    id: 'premise-watch', title: 'Warn when a decision\'s premises changed', cadence: 'daily', enabled: true, runs: [],
    instructions: 'Call vault_changes since your last run (the prompt tells you when that was). For each changed document, use vault_search and vault_read to find documents that link to it and read as decisions (type: decision, or a "Decision" / "결정" heading). If a decision relied on something that changed, propose a note titled "Premise changed: <decision name>" that quotes the old assumption, the new text, and says what should be re-decided. Link the decision and the changed document. One proposal per affected decision, at most five per run.',
  },
  {
    id: 'weekly-digest', title: 'Weekly digest of how the vault moved', cadence: 'weekly', enabled: true, runs: [],
    instructions: 'Call vault_changes for the last seven days and graph_lint (all rules, json). Propose one note titled "Vault digest — <ISO week>": what was added or rewritten and by whom (grouped by folder), which clusters grew, the lint counts versus the previous run if the report exists, and three things a maintainer should look at. Link the ten most-changed documents. Keep it under 400 words.',
  },
]

export function validateJobs(input: unknown): string | null {
  if (!input || typeof input !== 'object') return 'config must be an object'
  const c = input as Partial<JobsConfig>
  if (!Array.isArray(c.jobs)) return 'jobs must be an array'
  if (c.jobs.length > MAX_JOBS) return `at most ${MAX_JOBS} jobs`
  const ids = new Set<string>()
  for (const j of c.jobs as Partial<Job>[]) {
    if (!j || typeof j.id !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(j.id)) return 'job id must be a short slug'
    if (ids.has(j.id)) return `duplicate job id ${j.id}`
    ids.add(j.id)
    if (typeof j.title !== 'string' || !j.title.trim() || j.title.length > 120) return `job ${j.id}: title required`
    if (typeof j.instructions !== 'string' || !j.instructions.trim() || j.instructions.length > 4000) return `job ${j.id}: instructions required (≤4000 chars)`
    if (!['daily', 'weekly', 'manual'].includes(j.cadence as string)) return `job ${j.id}: cadence must be daily, weekly or manual`
    if (typeof j.enabled !== 'boolean') return `job ${j.id}: enabled must be boolean`
  }
  return null
}

export async function readJobs(deps: Pick<SyncDeps, 'blobs'>): Promise<JobsConfig> {
  const bytes = await deps.blobs.get(JOBS_KEY)
  if (!bytes) return { version: 1, jobs: DEFAULT_JOBS.map(j => ({ ...j, runs: [] })) }
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as JobsConfig
    if (validateJobs(parsed)) return { version: 1, jobs: DEFAULT_JOBS.map(j => ({ ...j, runs: [] })) }
    return { version: 1, jobs: parsed.jobs.map(j => ({ ...j, runs: Array.isArray(j.runs) ? j.runs : [] })) }
  } catch {
    return { version: 1, jobs: DEFAULT_JOBS.map(j => ({ ...j, runs: [] })) }
  }
}

export async function writeJobs(deps: Pick<SyncDeps, 'blobs'>, config: JobsConfig): Promise<void> {
  const jobs = config.jobs.map(j => ({
    id: j.id, title: j.title.trim(), instructions: j.instructions.trim(), cadence: j.cadence, enabled: j.enabled,
    runs: (j.runs ?? []).slice(-MAX_RUNS_KEPT),
  }))
  await deps.blobs.put(JOBS_KEY, enc.encode(JSON.stringify({ version: 1, jobs })))
}

/** Edits from the app replace definitions but never the run history the clients reported. */
export async function saveJobDefinitions(deps: Pick<SyncDeps, 'blobs'>, incoming: JobsConfig): Promise<JobsConfig> {
  const current = await readJobs(deps)
  const runsById = new Map(current.jobs.map(j => [j.id, j.runs]))
  const merged: JobsConfig = { version: 1, jobs: incoming.jobs.map(j => ({ ...j, runs: runsById.get(j.id) ?? [] })) }
  await writeJobs(deps, merged)
  return readJobs(deps)
}

export async function recordJobRun(deps: Pick<SyncDeps, 'blobs'>, jobId: string, run: JobRun): Promise<Job | null> {
  const config = await readJobs(deps)
  const job = config.jobs.find(j => j.id === jobId)
  if (!job) return null
  job.runs = [...job.runs, run].slice(-MAX_RUNS_KEPT)
  await writeJobs(deps, config)
  return job
}

/** Which jobs are due now, by cadence and last run. Manual jobs are due only when asked for by id. */
export function dueJobs(config: JobsConfig, now: number, force = false): Job[] {
  const DAY = 24 * 60 * 60 * 1000
  return config.jobs.filter(j => {
    if (!j.enabled) return false
    if (force) return true
    if (j.cadence === 'manual') return false
    const last = j.runs.length ? j.runs[j.runs.length - 1].at : 0
    const every = j.cadence === 'daily' ? DAY : 7 * DAY
    // A little slack so a job scheduled "daily at 04:00" is due at 04:00 the next day too
    return now - last >= every * 0.9
  })
}

/** The MCP prompt text a client follows. */
export function renderJobsPrompt(jobs: Job[], now: number, author: string): string {
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  if (jobs.length === 0) return 'No Strata Sync jobs are due right now. Nothing to do.'
  const lines = [
    `You are running the team's standing Strata Sync jobs on behalf of ${author || 'a teammate'}. Now: ${fmt(now)}.`,
    '',
    'Rules:',
    '- Read with vault_search, vault_read, vault_list, vault_changes and graph_lint. Never edit existing documents.',
    '- Write only through vault_propose (they land in _agent/ for a person to promote). Set `source` to the job id. Keep each proposal specific and short; link the documents you used.',
    '- Do not propose something that already exists in vault_proposals with the same title.',
    '- Write in the language the vault is written in.',
    '- When a job is done (even with nothing to propose), call jobs_report with the job id, a two-sentence summary and the proposal paths you created.',
    '',
    `Jobs due (${jobs.length}):`,
  ]
  for (const j of jobs) {
    const last = j.runs.length ? j.runs[j.runs.length - 1] : null
    lines.push('', `## ${j.title}  (id: ${j.id}, ${j.cadence})`)
    lines.push(last ? `Last run: ${fmt(last.at)} by ${last.by} — ${last.summary}` : 'Last run: never')
    lines.push('', j.instructions)
  }
  return lines.join('\n')
}
