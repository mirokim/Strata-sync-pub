/**
 * Recall — "what do we know about X?" answered the way a brain answers, not the way a search box
 * does: the documents that match, the documents around them that the links say matter, what the
 * AI members remember about it, and what they said when those documents were saved. One call,
 * one bundle within a character budget, ready to be read or handed to a model.
 *
 * Ranking is deliberately simple and explainable: rank-fused BM25 + semantic seeds, neighbours
 * scored by how many seeds they touch plus their own query score, member memory sections by term
 * overlap. Nothing here needs the network beyond the vault view and (optionally) Vectorize.
 */
import { isProposalPath } from '../../mcp/src/proposals.js'
import type { ParsedVaultDoc } from '../../mcp/src/lint/vaultDoc.js'
import { loadVaultView, tokenize, type VaultView } from './vaultIndex.js'
import { readMembers, memberNotePath, MEMBERS_FOLDER } from './members.js'
import type { SyncDeps } from './sync.js'
import type { SearchHit } from './nightly.js'
import { canSee, isPersonalPath, type Viewer } from './personal.js'

/** bge-m3 cosine below this is noise (the app's own team tier uses ~0.43). */
export const SEMANTIC_MIN_SCORE = 0.45
export const RECALL_DEFAULT_BUDGET = 16_000
const RECALL_MIN_BUDGET = 2_000
const RECALL_MAX_BUDGET = 60_000

export interface RecallDeps extends SyncDeps {
  semanticSearch?: (query: string, topK: number) => Promise<SearchHit[]>
}

export interface RecallOptions {
  query: string
  /** Who is asking — decides which personal documents may appear. */
  viewer?: Viewer | null
  /** Total characters of document text in the bundle (default 16 000). */
  budget?: number
  /** Seed documents (default 5, max 12). */
  seeds?: number
  /** Neighbour documents (default 8, max 20). */
  neighbours?: number
}

export interface FusedHit { path: string; title: string; score: number; semantic: boolean; bm25: boolean }

export interface RecallDoc { path: string; title: string; author: string; modified: string; excerpt: string; proposal?: true; personal?: true; why?: string }
export interface RecallResult {
  query: string
  semantic: boolean
  core: RecallDoc[]
  around: RecallDoc[]
  memory: { member: string; heading: string; text: string }[]
  remarks: { member: string; about: string; path: string; excerpt: string }[]
  sources: string[]
  markdown: string
}

/** BM25 + semantic, fused by rank so the two score scales do not fight. Shared with vault_search. */
export async function fusedSearch(deps: RecallDeps, view: VaultView, query: string, topK: number, exclude: Set<string> = new Set()): Promise<{ hits: FusedHit[]; semantic: boolean }> {
  // The semantic round trip overlaps the BM25 build (seconds on a cold index) instead of following it
  const semanticCall = deps.semanticSearch ? deps.semanticSearch(query, topK * 3).catch(() => [] as SearchHit[]) : Promise.resolve([] as SearchHit[])
  const bm25 = view.bm25().search(query, topK * 2, exclude)
  const raw = await semanticCall
  const seen = new Set<string>()
  const semantic = raw.filter(h => h.score >= SEMANTIC_MIN_SCORE && !exclude.has(h.path) && view.docs.has(h.path) && !seen.has(h.path) && seen.add(h.path)).slice(0, topK)
  const rank = new Map<string, { score: number; semantic: boolean; bm25: boolean }>()
  const add = (path: string, i: number, kind: 'semantic' | 'bm25') => {
    const cur = rank.get(path) ?? { score: 0, semantic: false, bm25: false }
    cur.score += 1 / (60 + i + 1); cur[kind] = true; rank.set(path, cur)
  }
  bm25.forEach((h, i) => add(h.path, i, 'bm25'))
  semantic.forEach((h, i) => add(h.path, i, 'semantic'))
  const hits = [...rank.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, topK)
    .map(([path, r]) => ({ path, title: view.docs.get(path)?.title ?? path, score: Number(r.score.toFixed(4)), semantic: r.semantic, bm25: r.bm25 }))
  return { hits, semantic: semantic.length > 0 }
}

function isMemberPath(path: string): boolean { return path.startsWith(`${MEMBERS_FOLDER}/`) }
function pathOf(d: ParsedVaultDoc): string { return d.folderPath ? `${d.folderPath}/${d.filename}` : d.filename }
function isSystemPath(path: string): boolean { return path.split('/').some(s => s.startsWith('.')) }

function excerpt(text: string, max: number): string {
  const body = text.replace(/\r/g, '').trim()
  if (body.length <= max) return body
  // Cut at a paragraph boundary when one is near the limit
  const cut = body.lastIndexOf('\n\n', max)
  return (cut > max * 0.6 ? body.slice(0, cut) : body.slice(0, max)).trimEnd() + '\n[…]'
}

function scoreText(queryTerms: Set<string>, text: string): number {
  if (queryTerms.size === 0) return 0
  const terms = new Set(tokenize(text))
  let hit = 0
  for (const t of queryTerms) if (terms.has(t)) hit++
  return hit / queryTerms.size
}

/** `## heading` sections of a memory note, in order. Text before the first heading is its own section. */
export function splitNoteSections(note: string): { heading: string; text: string }[] {
  const body = note.replace(/^---[\s\S]*?\n---\n?/, '')
  const out: { heading: string; text: string }[] = []
  let heading = '', buf: string[] = []
  for (const line of body.split('\n')) {
    const m = /^##\s+(.*)$/.exec(line)
    if (m) { if (buf.join('\n').trim()) out.push({ heading, text: buf.join('\n').trim() }); heading = m[1].trim(); buf = [] }
    else buf.push(line)
  }
  if (buf.join('\n').trim()) out.push({ heading, text: buf.join('\n').trim() })
  return out
}

export async function recall(deps: RecallDeps, options: RecallOptions): Promise<RecallResult> {
  const query = options.query.trim()
  const budget = Math.min(Math.max(Number(options.budget) || RECALL_DEFAULT_BUDGET, RECALL_MIN_BUDGET), RECALL_MAX_BUDGET)
  const seedCount = Math.min(Math.max(Number(options.seeds) || 5, 1), 12)
  const neighbourCount = Math.min(Math.max(options.neighbours === undefined || Number.isNaN(Number(options.neighbours)) ? 8 : Number(options.neighbours), 0), 20)
  const view = await loadVaultView(deps)
  const queryTerms = new Set(tokenize(query))

  // Remarks and memory notes are read separately; they must not compete with documents as seeds.
  // Other people's personal documents are not this viewer's to recall.
  const exclude = new Set([...view.docs.keys()].filter(p => isMemberPath(p) || isSystemPath(p) || !canSee(p, options.viewer)))
  const { hits, semantic } = await fusedSearch(deps, view, query, seedCount, exclude)
  const seeds = hits.map(h => view.docs.get(h.path)!).filter(Boolean)
  const seedIds = new Set(seeds.map(d => d.id))

  // Neighbours: documents linked from or to a seed, ranked by seeds touched, query score, link count
  const graph = view.graph()
  const byId = view.byId()
  const cand = new Map<string, { seeds: Set<string>; links: number }>()
  const touch = (id: string, seed: ParsedVaultDoc, count: number) => {
    if (seedIds.has(id)) return
    const d = byId.get(id)
    if (!d || isMemberPath(pathOf(d)) || d.graphWeight === 'skip' || !canSee(pathOf(d), options.viewer)) return
    const c = cand.get(id) ?? { seeds: new Set(), links: 0 }
    c.seeds.add(seed.title); c.links += count; cand.set(id, c)
  }
  for (const seed of seeds) {
    // adjacency is undirected: each neighbour once, with whichever direction's reference count applies
    for (const n of graph.adjacency.get(seed.id) ?? []) touch(n, seed, graph.outRefs.get(seed.id)?.get(n) ?? graph.outRefs.get(n)?.get(seed.id) ?? 1)
  }
  // Candidates are ranked on what is in memory (title, tags, headings); the few that make the cut get their text
  const neighbours = [...cand.entries()].map(([id, c]) => {
    const d = byId.get(id)!
    const q = scoreText(queryTerms, `${d.title} ${d.tags.join(' ')} ${d.sections.map(s => s.heading).join(' ')}`)
    return { d, why: `links with ${[...c.seeds].slice(0, 3).join(', ')}`, score: c.seeds.size * 2 + q * 3 + Math.min(c.links, 5) * 0.2 }
  }).sort((a, b) => b.score - a.score).slice(0, neighbourCount)

  // Members: memory sections that mention the query, and remarks about the seed documents
  const config = await readMembers(deps)
  const scored: { member: string; heading: string; text: string; score: number }[] = []
  for (const m of config.members.filter(x => x.enabled)) {
    const note = await view.textOf(memberNotePath(m))
    if (!note) continue
    for (const s of splitNoteSections(note)) {
      const score = scoreText(queryTerms, `${s.heading} ${s.text}`)
      if (score > 0) scored.push({ member: m.name, heading: s.heading, text: s.text.slice(0, 800), score })
    }
  }
  const memoryTop = scored.sort((a, b) => b.score - a.score).slice(0, 5).map(({ member, heading, text }) => ({ member, heading, text }))

  const remarks: RecallResult['remarks'] = []
  const seedPaths = new Set(seeds.map(pathOf))
  for (const path of view.docs.keys()) {
    if (!isMemberPath(path)) continue
    const rest = path.slice(MEMBERS_FOLDER.length + 1)
    const slash = rest.indexOf('/')
    if (slash < 0) continue                      // the memory notes themselves
    const about = rest.slice(slash + 1)
    if (!seedPaths.has(about)) continue
    remarks.push({ member: rest.slice(0, slash), about, path, excerpt: excerpt(await view.bodyOf(path), 600) })
  }

  // Budget: seeds get the larger share, neighbours the rest; memory/remarks are capped above
  const seedShare = Math.floor(budget * (neighbours.length ? 0.65 : 1))
  const perSeed = seeds.length ? Math.floor(seedShare / seeds.length) : 0
  const perNeighbour = neighbours.length ? Math.floor((budget - seedShare) / neighbours.length) : 0
  const rowOf = (d: ParsedVaultDoc) => view.rows.get(pathOf(d))
  const toDoc = async (d: ParsedVaultDoc, max: number, why?: string): Promise<RecallDoc> => ({
    path: pathOf(d), title: d.title, author: rowOf(d)?.author ?? '', modified: new Date(rowOf(d)?.updatedAt ?? d.mtime ?? 0).toISOString().slice(0, 10),
    excerpt: excerpt(await view.bodyOf(pathOf(d)), max), proposal: isProposalPath(d.folderPath) ? true : undefined, personal: isPersonalPath(pathOf(d)) ? true : undefined, why,
  })
  const core = await Promise.all(seeds.map(d => toDoc(d, Math.max(perSeed, 400))))
  const around = await Promise.all(neighbours.map(n => toDoc(n.d, Math.max(perNeighbour, 200), n.why)))
  const sources = [...core, ...around].map(d => d.path)

  return { query, semantic, core, around, memory: memoryTop, remarks, sources, markdown: renderRecall(query, core, around, memoryTop, remarks) }
}

export function renderRecall(query: string, core: RecallDoc[], around: RecallDoc[], memory: RecallResult['memory'], remarks: RecallResult['remarks']): string {
  const lines = [`# Recall: ${query}`, '']
  if (core.length === 0) { lines.push('Nothing in the vault matches this. Try other words, or vault_list to browse.'); return lines.join('\n') }
  lines.push(`## Core (${core.length})`)
  const mark = (d: RecallDoc) => `${d.proposal ? ' _(proposal, not yet promoted)_' : ''}${d.personal ? ' _(personal — only you see this)_' : ''}`
  for (const d of core) lines.push('', `### ${d.title}${mark(d)}`, `Path: ${d.path} · ${d.author || 'unknown'} · ${d.modified}`, '', d.excerpt)
  if (around.length) {
    lines.push('', `## Around them (${around.length})`)
    for (const d of around) lines.push('', `### ${d.title}${mark(d)}`, `Path: ${d.path} · ${d.why} · ${d.modified}`, '', d.excerpt)
  }
  if (memory.length) {
    lines.push('', '## Members remember')
    for (const m of memory) lines.push('', `**${m.member}**${m.heading ? ` — ${m.heading}` : ''}`, m.text)
  }
  if (remarks.length) {
    lines.push('', '## Members said about these')
    for (const r of remarks) lines.push('', `**${r.member}** on ${r.about} (${r.path})`, r.excerpt)
  }
  lines.push('', '## Sources', ...[...core, ...around].map(d => `- ${d.path}`))
  return lines.join('\n')
}
