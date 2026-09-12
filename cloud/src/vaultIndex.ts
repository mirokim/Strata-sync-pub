/**
 * In-memory view of the team vault for the Worker: every live markdown document, parsed, plus a
 * small BM25 index. Built lazily per isolate and refreshed when the D1 sequence head moves, so
 * repeated MCP calls in the same isolate do not re-read R2.
 *
 * The web app and the MCP tools both need "give me the documents" and "what is related to this
 * text"; this is that, without any of the Electron-side caches.
 */
import { parseVaultDoc, type ParsedVaultDoc } from '../../mcp/src/lint/vaultDoc.js'
import { listLiveRows } from './nightly.js'
import type { FileRow, SyncDeps } from './sync.js'

export interface VaultView {
  head: number
  docs: Map<string, ParsedVaultDoc>
  rows: Map<string, FileRow>
  /** BM25 over `docs`, built on first use and shared by every search on this view. */
  bm25(): Bm25
}

let _cache: { view: VaultView; builtAt: number } | null = null
const CACHE_TTL_MS = 30_000

const dec = new TextDecoder()

/** Current documents. Reuses the isolate cache while the sequence head is unchanged and fresh. */
export async function loadVaultView(deps: SyncDeps, force = false): Promise<VaultView> {
  const head = await deps.meta.head()
  const now = Date.now()
  if (!force && _cache && _cache.view.head === head && now - _cache.builtAt < CACHE_TTL_MS) return _cache.view

  const rows = await listLiveRows(deps.meta)
  const docs = new Map<string, ParsedVaultDoc>()
  const rowMap = new Map<string, FileRow>()
  for (const row of rows) {
    rowMap.set(row.path, row)
    if (!row.path.toLowerCase().endsWith('.md')) continue
    // Reuse the previously parsed document when the content hash is unchanged
    const prev = _cache?.view.rows.get(row.path)
    const prevDoc = _cache?.view.docs.get(row.path)
    if (prev && prevDoc && prev.etag === row.etag) { docs.set(row.path, prevDoc); continue }
    const bytes = await deps.blobs.get(row.path)
    if (!bytes) continue
    docs.set(row.path, parseVaultDoc(row.path, dec.decode(bytes), row.mtime))
  }
  let index: Bm25 | null = null
  const view: VaultView = { head, docs, rows: rowMap, bm25: () => (index ??= new Bm25(docs)) }
  _cache = { view, builtAt: now }
  return view
}

export function invalidateVaultView(): void { _cache = null }

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

  /** @param docs vault path → parsed document */
  constructor(docs: Map<string, ParsedVaultDoc>, private readonly k1 = 1.5, private readonly b = 0.75) {
    let total = 0
    for (const [path, d] of docs) {
      const text = `${d.title} ${d.title} ${d.tags.join(' ')} ${d.body}`
      const tokens = tokenize(text)
      const counts = new Map<string, number>()
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
      this.tf.set(path, counts)
      this.len.set(path, tokens.length)
      this.titles.set(path, { docId: d.id, title: d.title })
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1)
      total += tokens.length
    }
    this.avgLen = this.tf.size ? total / this.tf.size : 1
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
