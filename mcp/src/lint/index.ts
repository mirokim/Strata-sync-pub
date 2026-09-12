/**
 * Vault lint runner — `runLint(input, options) → LintReport`.
 *
 * Pure: no filesystem, no MCP state. See types.ts for the contract.
 */
import type { LintFinding, LintInput, LintOptions, LintReport, LintRuleId, LintSeverity, LintSnapshot } from './types.js'
import { ALL_RULES, SEVERITY_ORDER } from './types.js'
import { buildLintGraph, topFolder, type LintGraph } from './graph.js'
import { detectCommunities } from './community.js'
import { phantomHot, bridgeSpof, orphan, staleHub, nearDuplicate, clusterDrift, type RuleContext } from './rules.js'

export type { LintFinding, LintInput, LintOptions, LintReport, LintRuleId, LintSeverity, LintSnapshot, SimilarPair } from './types.js'
export { ALL_RULES } from './types.js'
export type { LintDocument } from './document.js'
export { buildLintGraph, normalizeWikiLink, articulationPoints } from './graph.js'
export { detectCommunities } from './community.js'

/** Folders that hold generated or transient documents and must not raise findings. */
export const DEFAULT_IGNORE_FOLDERS = ['_reports', '_reviews', '_agent', 'templates', '.trash', '.obsidian', '.strata-sync']

const RULE_FNS: Record<LintRuleId, (ctx: RuleContext) => LintFinding[]> = {
  'phantom-hot': phantomHot,
  'bridge-spof': bridgeSpof,
  'orphan': orphan,
  'stale-hub': staleHub,
  'near-duplicate': nearDuplicate,
  'cluster-drift': clusterDrift,
}

export function runLint(input: LintInput, options: LintOptions = {}): LintReport {
  const rules = options.rules ?? [...ALL_RULES]
  const minSeverity = options.minSeverity ?? 'info'
  const limitPerRule = options.limitPerRule ?? 50
  const ignoreFolders = new Set((options.ignoreFolders ?? DEFAULT_IGNORE_FOLDERS).map(f => f.toLowerCase()))

  // Generated folders (reports, reviews, agent proposals) are left out of the graph entirely, not
  // just out of the findings: yesterday's lint report links to every flagged document, and if it
  // counted, no orphan would ever be reported twice.
  const docs = input.docs.filter(d => !ignoreFolders.has(topFolder(d.folderPath).toLowerCase()))
  const graph = buildLintGraph(docs)
  const reportable = new Set<string>()
  for (const n of graph.nodes) {
    if (n.graphWeight === 'skip') continue
    reportable.add(n.id)
  }

  const communities = detectCommunities(graph.adjacency, (a, b) => linkWeight(graph, a, b))
  const pageRank = computePageRank(graph)

  const ctx: RuleContext = {
    graph, communities, pageRank, reportable,
    opts: {
      phantomMinRefs: options.phantomMinRefs ?? 3,
      hubTopFraction: options.hubTopFraction ?? 0.1,
      staleDays: options.staleDays ?? 90,
      duplicateMinSimilarity: options.duplicateMinSimilarity ?? 0.92,
      driftMaxJaccard: options.driftMaxJaccard ?? 0.6,
      driftMinSize: options.driftMinSize ?? 5,
      now: options.now ?? Date.now(),
    },
    similarPairs: input.similarPairs,
    previousSnapshot: input.previousSnapshot,
  }

  const skipped: LintReport['skipped'] = []
  const findings: LintFinding[] = []
  const rulesRun: LintRuleId[] = []
  for (const rule of rules) {
    if (rule === 'near-duplicate' && !input.similarPairs) { skipped.push({ rule, reason: 'no similarity pairs supplied' }); continue }
    if (rule === 'cluster-drift' && !input.previousSnapshot) { skipped.push({ rule, reason: 'no previous snapshot' }); continue }
    rulesRun.push(rule)
    const produced = RULE_FNS[rule](ctx)
      .filter(f => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[minSeverity])
      .sort(compareFindings)
      .slice(0, limitPerRule)
    findings.push(...produced)
  }
  findings.sort(compareFindings)

  const bySeverity: Record<LintSeverity, number> = { error: 0, warn: 0, info: 0 }
  const byRule: Partial<Record<LintRuleId, number>> = {}
  for (const f of findings) { bySeverity[f.severity]++; byRule[f.rule] = (byRule[f.rule] ?? 0) + 1 }

  const snapshot: LintSnapshot = {
    version: 1,
    generatedAt: new Date(ctx.opts.now).toISOString(),
    communities: communities.communities,
  }

  return {
    generatedAt: snapshot.generatedAt,
    docCount: docs.length,
    linkCount: graph.linkCount,
    phantomCount: graph.phantoms.size,
    communityCount: communities.communities.filter(c => c.length >= 2).length,
    rulesRun, skipped, findings,
    summary: { bySeverity, byRule },
    snapshot,
  }
}

function compareFindings(a: LintFinding, b: LintFinding): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || b.score - a.score
    || a.title.localeCompare(b.title)
}

/** Reference count both ways, so a pair that cites each other often binds tighter in Louvain. */
function linkWeight(graph: LintGraph, a: string, b: string): number {
  return (graph.outRefs.get(a)?.get(b) ?? 0) + (graph.outRefs.get(b)?.get(a) ?? 0) || 1
}

/**
 * PageRank over directed resolved links (damping 0.85). Dangling documents distribute their
 * rank uniformly. Iterates to 1e-6 or 100 rounds — the vault is small enough that this is
 * milliseconds.
 */
export function computePageRank(graph: LintGraph, damping = 0.85): Map<string, number> {
  const ids = graph.nodes.map(n => n.id)
  const n = ids.length
  if (n === 0) return new Map()
  const index = new Map(ids.map((id, i) => [id, i]))
  let rank = new Array<number>(n).fill(1 / n)
  const outTargets = ids.map(id => [...(graph.outRefs.get(id)?.keys() ?? [])].map(t => index.get(t)!))

  for (let iter = 0; iter < 100; iter++) {
    const next = new Array<number>(n).fill((1 - damping) / n)
    let dangling = 0
    for (let i = 0; i < n; i++) {
      const targets = outTargets[i]
      if (targets.length === 0) { dangling += rank[i]; continue }
      const share = damping * rank[i] / targets.length
      for (const t of targets) next[t] += share
    }
    const danglingShare = damping * dangling / n
    let delta = 0
    for (let i = 0; i < n; i++) { next[i] += danglingShare; delta += Math.abs(next[i] - rank[i]) }
    rank = next
    if (delta < 1e-6) break
  }
  return new Map(ids.map((id, i) => [id, rank[i]]))
}

// ── Formatting ───────────────────────────────────────────────────────────────

/** Markdown suitable for dropping into the vault (`_reports/lint-YYYY-MM-DD.md`). Titles become wikilinks. */
export function reportToMarkdown(report: LintReport, opts: { title?: string } = {}): string {
  const lines: string[] = []
  lines.push(`# ${opts.title ?? 'Vault lint'} — ${report.generatedAt.slice(0, 10)}`)
  lines.push('')
  lines.push(`${report.docCount} documents · ${report.linkCount} links · ${report.phantomCount} unresolved link targets · ${report.communityCount} clusters`)
  lines.push('')
  const { error, warn, info } = report.summary.bySeverity
  lines.push(`**${error} errors · ${warn} warnings · ${info} notes**`)
  if (report.skipped.length) lines.push('', `Skipped: ${report.skipped.map(s => `${s.rule} (${s.reason})`).join(', ')}`)
  lines.push('')

  const byRule = new Map<LintRuleId, LintFinding[]>()
  for (const f of report.findings) { if (!byRule.has(f.rule)) byRule.set(f.rule, []); byRule.get(f.rule)!.push(f) }
  for (const rule of report.rulesRun) {
    const items = byRule.get(rule) ?? []
    lines.push(`## ${RULE_TITLES[rule]} (${items.length})`)
    lines.push('')
    if (items.length === 0) { lines.push('_nothing found_', ''); continue }
    for (const f of items) {
      const mark = f.severity === 'error' ? '🔴' : f.severity === 'warn' ? '🟡' : '⚪'
      const link = f.docId ? `[[${f.title}]]` : f.rule === 'phantom-hot' ? `[[${f.title}]]` : f.title
      lines.push(`- ${mark} ${link} — ${f.message}`)
      lines.push(`  - ${f.suggestion}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

const RULE_TITLES: Record<LintRuleId, string> = {
  'phantom-hot': 'Missing documents that are already linked',
  'bridge-spof': 'Single points of failure',
  'orphan': 'Orphans',
  'stale-hub': 'Stale hubs',
  'near-duplicate': 'Near-duplicates',
  'cluster-drift': 'Cluster drift',
}
