/**
 * In-memory view of the team vault for the Worker: every live markdown document, parsed, plus a
 * small BM25 index. Built lazily per isolate and refreshed when the D1 sequence head moves, so
 * repeated MCP calls in the same isolate do not re-read R2.
 *
 * The web app and the MCP tools both need "give me the documents" and "what is related to this
 * text"; this is that, without any of the Electron-side caches.
 */
import { parseVaultDoc, type ParsedVaultDoc } from '../../mcp/src/lint/vaultDoc.js'
import { buildLintGraph, type LintGraph } from '../../mcp/src/lint/graph.js'
import { listLiveRows } from './nightly.js'
import type { FileRow, SyncDeps } from './sync.js'

export interface VaultView {
  head: number
  docs: Map<string, ParsedVaultDoc>
  rows: Map<string, FileRow>
  /** Raw text per document path (what the snapshot stores). */
  contents: Map<string, string>
  /** BM25 over `docs`, built on first use and shared by every search on this view. */
  bm25(): Bm25
  /** Resolved link graph over `docs`, built on first use. */
  graph(): LintGraph
  /** The BM25 index if this view has built one (the next view starts from it). */
  builtIndex(): Bm25 | null
}

let _cache: { view: VaultView; builtAt: number } | null = null

/**
 * One R2 object holding every document's text, keyed by content hash. A cold isolate reads it
 * with a single request and then fetches only the documents whose hash moved since — reading
 * the vault file by file would exceed the per-invocation subrequest limit past ~1000 documents.
 * Rewritten whenever a load had to fetch more than SNAPSHOT_REWRITE_AFTER documents, and by the
 * nightly batch.
 */
export const VAULT_SNAPSHOT_KEY = '_system/vault-snapshot.json'
const SNAPSHOT_REWRITE_AFTER = 40
/** Hard cap on per-load R2 reads; documents beyond it wait for the next load (the snapshot catches up). */
const MAX_READS_PER_LOAD = 800

interface VaultSnapshot { version: 1; head: number; docs: { path: string; etag: string; content: string }[] }

const dec = new TextDecoder()
const enc = new TextEncoder()

/** Current documents. Reuses the isolate cache while the sequence head is unchanged and fresh. */
export async function loadVaultView(deps: SyncDeps, force = false): Promise<VaultView> {
  const head = await deps.meta.head()
  const now = Date.now()
  // The D1 head moves on every write (API, bridge, batch), so an unchanged head means an unchanged vault
  if (!force && _cache && _cache.view.head === head) return _cache.view

  const rows = await listLiveRows(deps.meta)
  const docs = new Map<string, ParsedVaultDoc>()
  const rowMap = new Map<string, FileRow>()
  const contents = new Map<string, string>()          // path → text, for the snapshot
  const toRead: FileRow[] = []

  // Base to reuse from: this isolate's previous view, else the stored snapshot
  let snapshot: Map<string, { etag: string; content: string }> | null = null
  if (!_cache) {
    const raw = await deps.blobs.get(VAULT_SNAPSHOT_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(dec.decode(raw)) as VaultSnapshot
        if (parsed.version === 1 && Array.isArray(parsed.docs)) snapshot = new Map(parsed.docs.map(d => [d.path, { etag: d.etag, content: d.content }]))
      } catch { snapshot = null }
    }
  }
  for (const row of rows) {
    rowMap.set(row.path, row)
    if (!row.path.toLowerCase().endsWith('.md')) continue
    // Reuse the previously parsed document when the content hash is unchanged
    const prev = _cache?.view.rows.get(row.path)
    const prevDoc = _cache?.view.docs.get(row.path)
    if (prev && prevDoc && prev.etag === row.etag) { docs.set(row.path, prevDoc); contents.set(row.path, _cache!.view.contents.get(row.path) ?? ''); continue }
    const snap = snapshot?.get(row.path)
    if (snap && snap.etag === row.etag) { docs.set(row.path, parseVaultDoc(row.path, snap.content, row.mtime)); contents.set(row.path, snap.content); continue }
    toRead.push(row)
  }
  // R2 reads in parallel batches — a cold isolate on a large vault would otherwise take seconds
  const BATCH = 25
  const reads = toRead.slice(0, MAX_READS_PER_LOAD)
  for (let i = 0; i < reads.length; i += BATCH) {
    const part = await Promise.all(reads.slice(i, i + BATCH).map(async row => {
      const bytes = await deps.blobs.get(row.path)
      return bytes ? [row, dec.decode(bytes)] as const : null
    }))
    for (const entry of part) if (entry) { docs.set(entry[0].path, parseVaultDoc(entry[0].path, entry[1], entry[0].mtime)); contents.set(entry[0].path, entry[1]) }
  }
  let index: Bm25 | null = null
  let graph: LintGraph | null = null
  const previous = _cache?.view
  const view: VaultView = {
    head, docs, rows: rowMap, contents,
    // Built on top of the previous isolate view's index when there is one: unchanged documents keep their tokens
    bm25: () => (index ??= new Bm25(docs, previous?.builtIndex() ?? undefined)),
    graph: () => (graph ??= buildLintGraph([...docs.values()])),
    builtIndex: () => index,
  }
  // Persist when this load did real work, so the next cold isolate does not repeat it
  if (reads.length >= SNAPSHOT_REWRITE_AFTER || (reads.length > 0 && !snapshot && !_cache)) {
    await writeVaultSnapshot(deps, view).catch(e => console.error('[vault-view] snapshot write failed', e))
  }
  _cache = { view, builtAt: now }
  return view
}

export function invalidateVaultView(): void { _cache = null }

export async function writeVaultSnapshot(deps: SyncDeps, view: VaultView): Promise<void> {
  const body: VaultSnapshot = { version: 1, head: view.head, docs: [...view.contents.entries()].map(([path, content]) => ({ path, etag: view.rows.get(path)?.etag ?? '', content })) }
  await deps.blobs.put(VAULT_SNAPSHOT_KEY, enc.encode(JSON.stringify(body)))
}

// ── Tokeniser + BM25 ─────────────────────────────────────────────────────────

/**
 * Lowercase words for Latin/digits; for Hangul runs, the run itself plus character bigrams, so
 * "전투시스템" matches "전투" and "시스템" without a morphological analyser.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+|[가-힣]+/g)) {
    const t = m[0]
    if (/^[가-힣]+$/.test(t)) {
      if (t.length <= 2) { out.push(t); continue }
      out.push(t)
      for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2))
    } else if (t.length > 1) {
      out.push(t)
    }
  }
  return out
}

export interface Bm25Hit { path: string; docId: string; title: string; score: number }

export class Bm25 {
  private tf = new Map<string, Map<string, number>>()
  private len = new Map<string, number>()
  private df = new Map<string, number>()
  private avgLen = 1
  private titles = new Map<string, { docId: string; title: string }>()

  /**
   * @param docs vault path → parsed document
   * @param base an index over an earlier version of the vault; only documents whose parsed
   *   object differs from the base's are re-tokenised (tokenising a large Korean vault is the
   *   expensive part, and between two calls only a handful of documents move)
   */
  constructor(docs: Map<string, ParsedVaultDoc>, base?: Bm25, private readonly k1 = 1.5, private readonly b = 0.75) {
    let total = 0
    if (base) {
      this.df = new Map(base.df)
      for (const [path, d] of docs) {
        const prev = base.docs.get(path)
        if (prev === d) {
          this.tf.set(path, base.tf.get(path)!); this.len.set(path, base.len.get(path)!); this.titles.set(path, base.titles.get(path)!)
          total += base.len.get(path)!
          continue
        }
        if (prev) for (const t of base.tf.get(path)!.keys()) this.df.set(t, (this.df.get(t) ?? 1) - 1)
        total += this.add(path, d)
      }
      for (const [path, counts] of base.tf) if (!docs.has(path)) for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 1) - 1)
      for (const [t, n] of this.df) if (n <= 0) this.df.delete(t)
    } else {
      for (const [path, d] of docs) total += this.add(path, d)
    }
    this.docs = docs
    this.avgLen = this.tf.size ? total / this.tf.size : 1
  }

  private docs: Map<string, ParsedVaultDoc>

  private add(path: string, d: ParsedVaultDoc): number {
    const tokens = tokenize(`${d.title} ${d.title} ${d.tags.join(' ')} ${d.body}`)
    const counts = new Map<string, number>()
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
    this.tf.set(path, counts)
    this.len.set(path, tokens.length)
    this.titles.set(path, { docId: d.id, title: d.title })
    for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
    return tokens.length
  }

  search(query: string, topK = 10, exclude: Set<string> = new Set()): Bm25Hit[] {
    const q = [...new Set(tokenize(query))]
    if (q.length === 0) return []
    const n = this.tf.size
    const hits: Bm25Hit[] = []
    for (const [path, counts] of this.tf) {
      if (exclude.has(path)) continue
      let score = 0
      const dl = this.len.get(path) ?? 0
      for (const t of q) {
        const f = counts.get(t)
        if (!f) continue
        const df = this.df.get(t) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * dl / this.avgLen))
      }
      if (score > 0) hits.push({ path, ...this.titles.get(path)!, score })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK)
  }
}

/** Vault-relative path of a parsed document. */
export function docPath(d: ParsedVaultDoc): string {
  return d.folderPath ? `${d.folderPath}/${d.filename}` : d.filename
}
