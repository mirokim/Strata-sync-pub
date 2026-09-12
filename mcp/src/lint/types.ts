/**
 * Vault lint — shared types.
 *
 * A lint run reads the vault's documents, builds a link graph and applies a fixed set of
 * structural rules. The same code is reached three ways: the `graph_lint` MCP tool, the
 * `lint:vault` CLI and (later) the server-side nightly batch, so nothing in here may depend on
 * MCP state, the filesystem or the network — callers pass documents in and get a report out.
 */
import type { LintDocument } from './document.js'

export type LintSeverity = 'error' | 'warn' | 'info'

export type LintRuleId =
  | 'phantom-hot'
  | 'bridge-spof'
  | 'orphan'
  | 'stale-hub'
  | 'near-duplicate'
  | 'cluster-drift'

export const ALL_RULES: readonly LintRuleId[] = [
  'phantom-hot', 'bridge-spof', 'orphan', 'stale-hub', 'near-duplicate', 'cluster-drift',
]

export interface LintFinding {
  rule: LintRuleId
  severity: LintSeverity
  /** Document the finding is about. Absent for phantom targets (no document exists yet). */
  docId?: string
  /** Display name — filename without extension, or the phantom link text. */
  title: string
  /** One sentence a person can act on. */
  message: string
  /** Rule-specific numbers backing the finding. Keys are stable per rule. */
  evidence: Record<string, unknown>
  /** What to do about it. */
  suggestion: string
  /** Higher sorts first within a severity. Rule-specific scale. */
  score: number
}

/** Pre-computed similarity between two documents, from BM25/embedding cosine. */
export interface SimilarPair { docA: string; docB: string; similarity: number }

/** Cluster membership persisted between runs so `cluster-drift` can compare. */
export interface LintSnapshot {
  version: 1
  generatedAt: string
  /** Each inner array is one community's docIds, sorted. */
  communities: string[][]
}

export interface LintOptions {
  /** Rules to run. Default: all. */
  rules?: LintRuleId[]
  /** Findings below this severity are dropped from the report. Default: 'info' (keep all). */
  minSeverity?: LintSeverity
  /** Cap on findings per rule. Default: 50. */
  limitPerRule?: number
  /** Folders (top-level, relative to vault) whose documents are never reported. */
  ignoreFolders?: string[]
  /** phantom-hot: a missing document must be referenced by at least this many documents. Default 3. */
  phantomMinRefs?: number
  /** stale-hub: PageRank top fraction considered a hub. Default 0.1. */
  hubTopFraction?: number
  /** stale-hub: hubs untouched for at least this many days are stale. Default 90. */
  staleDays?: number
  /** near-duplicate: cosine similarity at or above which two unlinked docs are flagged. Default 0.92. */
  duplicateMinSimilarity?: number
  /** cluster-drift: a previous community whose best Jaccard match is below this has drifted. Default 0.6. */
  driftMaxJaccard?: number
  /** cluster-drift: communities smaller than this are not tracked. Default 5. */
  driftMinSize?: number
  /** Reference time for staleness — injectable for tests. Default Date.now(). */
  now?: number
}

export interface LintInput {
  docs: LintDocument[]
  /** Optional similarity pairs for `near-duplicate` (the rule is skipped without them). */
  similarPairs?: SimilarPair[]
  /** Optional previous snapshot for `cluster-drift` (the rule is skipped without it). */
  previousSnapshot?: LintSnapshot
}

export interface LintReport {
  generatedAt: string
  docCount: number
  linkCount: number
  phantomCount: number
  communityCount: number
  rulesRun: LintRuleId[]
  /** Rules requested but skipped, with the reason. */
  skipped: { rule: LintRuleId; reason: string }[]
  findings: LintFinding[]
  summary: {
    bySeverity: Record<LintSeverity, number>
    byRule: Partial<Record<LintRuleId, number>>
  }
  /** Snapshot of this run's communities — persist it to enable `cluster-drift` next time. */
  snapshot: LintSnapshot
}

export const SEVERITY_ORDER: Record<LintSeverity, number> = { error: 0, warn: 1, info: 2 }
