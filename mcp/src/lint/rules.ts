/**
 * Lint rules. Each rule is a pure function of the prepared context and returns findings.
 * Keep evidence keys stable — reports are diffed day-to-day.
 */
import type { LintFinding, LintOptions, LintSnapshot, SimilarPair } from './types.js'
import type { LintGraph } from './graph.js'
import { articulationPoints } from './graph.js'
import type { CommunityResult } from './community.js'

export interface RuleContext {
  graph: LintGraph
  communities: CommunityResult
  pageRank: Map<string, number>
  /** Documents that rules may report (ignored folders / graph_weight: skip already removed). */
  reportable: Set<string>
  opts: Required<Pick<LintOptions,
    'phantomMinRefs' | 'hubTopFraction' | 'staleDays' | 'duplicateMinSimilarity' | 'driftMaxJaccard' | 'driftMinSize' | 'now'>>
  similarPairs?: SimilarPair[]
  previousSnapshot?: LintSnapshot
}

const DAY_MS = 24 * 60 * 60 * 1000

function titleOf(ctx: RuleContext, docId: string): string {
  return ctx.graph.nodeById.get(docId)?.title ?? docId
}

/**
 * phantom-hot — a wikilink target that does not exist, referenced from several documents.
 * Sorted by referrer count: the top of this list is the document the vault most wants written.
 */
export function phantomHot(ctx: RuleContext): LintFinding[] {
  const out: LintFinding[] = []
  for (const [target, referrers] of ctx.graph.phantoms) {
    const refs = [...referrers].filter(id => ctx.reportable.has(id))
    if (refs.length < ctx.opts.phantomMinRefs) continue
    const referrerTitles = refs.map(id => titleOf(ctx, id)).sort()
    const label = ctx.graph.phantomLabels.get(target) ?? target
    out.push({
      rule: 'phantom-hot',
      severity: 'error',
      title: label,
      message: `"${label}" is linked from ${refs.length} documents but no such document exists.`,
      evidence: { target: label, referrerCount: refs.length, referrers: referrerTitles.slice(0, 10) },
      suggestion: `Create "${label}.md" (or rename the links if it exists under another name).`,
      score: refs.length,
    })
  }
  return out
}

/**
 * bridge-spof — removing this document would disconnect other documents from each other.
 * Severity by how much it would cut off: a document whose removal strands ≥3 others is an
 * error; smaller cuts are warnings. Also reports low-degree documents that join two Louvain
 * communities (the "bridge with two threads" case) as warnings.
 */
export function bridgeSpof(ctx: RuleContext): LintFinding[] {
  const out: LintFinding[] = []
  const seen = new Set<string>()
  const cuts = articulationPoints(ctx.graph.adjacency)

  for (const [docId, { pieces }] of cuts) {
    if (!ctx.reportable.has(docId)) continue
    // pieces: sizes of components left when docId is removed; the largest is "the rest of the vault"
    const stranded = pieces.slice(1).reduce((a, b) => a + b, 0)
    if (stranded === 0) continue
    seen.add(docId)
    out.push({
      rule: 'bridge-spof',
      severity: stranded >= 3 ? 'error' : 'warn',
      docId,
      title: titleOf(ctx, docId),
      message: `Removing "${titleOf(ctx, docId)}" would cut ${stranded} document${stranded === 1 ? '' : 's'} off from the rest of the vault.`,
      evidence: { strandedDocs: stranded, pieces, degree: ctx.graph.adjacency.get(docId)!.size },
      suggestion: 'Add a second link path into the stranded documents (a hub, an index, or a direct cross-link).',
      score: stranded,
    })
  }

  // Community bridges with only a couple of links: not an articulation point yet, but one
  // deleted link away from becoming one.
  const { membership } = ctx.communities
  for (const [docId, neighbours] of ctx.graph.adjacency) {
    if (seen.has(docId) || !ctx.reportable.has(docId)) continue
    if (neighbours.size === 0 || neighbours.size > 2) continue
    const own = membership.get(docId)
    const others = new Set<number>()
    for (const nb of neighbours) { const c = membership.get(nb); if (c !== undefined && c !== own) others.add(c) }
    if (others.size === 0) continue
    out.push({
      rule: 'bridge-spof',
      severity: 'warn',
      docId,
      title: titleOf(ctx, docId),
      message: `"${titleOf(ctx, docId)}" connects ${others.size + 1} topic clusters through only ${neighbours.size} link${neighbours.size === 1 ? '' : 's'}.`,
      evidence: { degree: neighbours.size, clustersJoined: others.size + 1, strandedDocs: 0 },
      suggestion: 'Link it to more documents on each side so the clusters stay connected if one link is removed.',
      score: others.size,
    })
  }
  return out
}

/** orphan — no resolved links in or out. */
export function orphan(ctx: RuleContext): LintFinding[] {
  const out: LintFinding[] = []
  for (const node of ctx.graph.nodes) {
    if (!ctx.reportable.has(node.id)) continue
    if (ctx.graph.adjacency.get(node.id)!.size > 0) continue
    const phantomOut = [...ctx.graph.phantoms.entries()].filter(([, refs]) => refs.has(node.id)).length
    out.push({
      rule: 'orphan',
      severity: 'warn',
      docId: node.id,
      title: node.title,
      message: phantomOut > 0
        ? `"${node.title}" has no working links — its ${phantomOut} outgoing link${phantomOut === 1 ? ' points' : 's point'} to missing documents.`
        : `"${node.title}" is not linked from or to any other document.`,
      evidence: { inDegree: 0, outDegree: 0, unresolvedLinks: phantomOut, tags: node.tags.length },
      suggestion: phantomOut > 0
        ? 'Fix the broken links or create the missing documents.'
        : 'Link it from the document that should introduce it, or add it to an index page.',
      score: phantomOut,
    })
  }
  return out
}

/** stale-hub — high-PageRank documents nobody has touched for a long time. */
export function staleHub(ctx: RuleContext): LintFinding[] {
  const ranked = [...ctx.pageRank.entries()]
    .filter(([id]) => ctx.reportable.has(id))
    .sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return []
  const hubCount = Math.max(3, Math.ceil(ranked.length * ctx.opts.hubTopFraction))
  const hubs = ranked.slice(0, hubCount)
  const out: LintFinding[] = []
  for (const [docId, pr] of hubs) {
    const node = ctx.graph.nodeById.get(docId)!
    if (!node.mtime) continue
    const ageDays = Math.floor((ctx.opts.now - node.mtime) / DAY_MS)
    if (ageDays < ctx.opts.staleDays) continue
    out.push({
      rule: 'stale-hub',
      severity: 'warn',
      docId,
      title: node.title,
      message: `"${node.title}" is one of the ${hubCount} most-linked documents but has not changed in ${ageDays} days.`,
      evidence: { ageDays, pageRank: Number(pr.toFixed(5)), inDegree: ctx.graph.inDegree.get(docId) ?? 0 },
      suggestion: 'Confirm it is still current; if superseded, say so at the top and link the replacement.',
      score: ageDays,
    })
  }
  return out
}

/** near-duplicate — very similar documents that do not link to each other. */
export function nearDuplicate(ctx: RuleContext): LintFinding[] {
  if (!ctx.similarPairs) return []
  const out: LintFinding[] = []
  for (const pair of ctx.similarPairs) {
    if (pair.similarity < ctx.opts.duplicateMinSimilarity) continue
    if (!ctx.reportable.has(pair.docA) || !ctx.reportable.has(pair.docB)) continue
    if (ctx.graph.adjacency.get(pair.docA)?.has(pair.docB)) continue
    const a = titleOf(ctx, pair.docA), b = titleOf(ctx, pair.docB)
    out.push({
      rule: 'near-duplicate',
      severity: 'warn',
      docId: pair.docA,
      title: `${a} ↔ ${b}`,
      message: `"${a}" and "${b}" are ${Math.round(pair.similarity * 100)}% similar but do not link to each other.`,
      evidence: { docA: pair.docA, docB: pair.docB, similarity: Number(pair.similarity.toFixed(3)) },
      suggestion: 'Merge them, or link them and state how they differ.',
      score: pair.similarity,
    })
  }
  return out
}

/**
 * cluster-drift — a community from the previous snapshot that no current community resembles.
 * Uses Jaccard on membership; ignores tiny communities and ones that simply grew.
 */
export function clusterDrift(ctx: RuleContext): LintFinding[] {
  const prev = ctx.previousSnapshot
  if (!prev) return []
  const current = ctx.communities.communities.map(c => new Set(c))
  const out: LintFinding[] = []
  for (const oldMembers of prev.communities) {
    const old = new Set(oldMembers.filter(id => ctx.graph.nodeById.has(id)))
    if (old.size < ctx.opts.driftMinSize) continue
    let best = 0, bestIdx = -1
    current.forEach((cur, i) => {
      let inter = 0
      for (const id of old) if (cur.has(id)) inter++
      const j = inter / (old.size + cur.size - inter)
      if (j > best) { best = j; bestIdx = i }
    })
    if (best >= ctx.opts.driftMaxJaccard) continue
    const sample = [...old].slice(0, 5).map(id => titleOf(ctx, id))
    out.push({
      rule: 'cluster-drift',
      severity: 'warn',
      title: `cluster of ${old.size} (e.g. ${sample[0] ?? '?'})`,
      message: `A group of ${old.size} documents that clustered together last time no longer does (best overlap ${Math.round(best * 100)}%).`,
      evidence: { previousSize: old.size, bestJaccard: Number(best.toFixed(3)), bestMatchSize: bestIdx >= 0 ? current[bestIdx].size : 0, sample },
      suggestion: 'Expected after a reorganisation; otherwise check whether links between these documents were removed.',
      score: 1 - best,
    })
  }
  return out
}
