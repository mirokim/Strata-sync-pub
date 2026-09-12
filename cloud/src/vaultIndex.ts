/**
 * In-memory view of the team vault for the Worker: every live markdown document parsed *lite*
 * (title, tags, links, section headings and wikilinks — no body text), a BM25 index over the
 * bodies, and a lazily built link graph. Built per isolate and refreshed when the D1 sequence
 * head moves, so repeated MCP calls in the same isolate do not re-read anything.
 *
 * Memory is the constraint, not CPU: a Worker isolate has 128 MB and a team vault has thousands
 * of Korean documents. So document text is never retained — it streams through the parser and
 * the tokeniser once and is dropped; anything that needs a body later (`bodyOf`, `parsed`)
 * fetches it from R2. A gzip NDJSON snapshot of the whole vault (`_system/vault-snapshot`) lets a
 * cold isolate get every document with one request and stream-parse it line by line; only
 * documents whose hash moved since are read from R2 individually.
 */
import { parseVaultDoc, type ParsedVaultDoc } from '../../mcp/src/lint/vaultDoc.js'
import { buildLintGraph, type LintGraph } from '../../mcp/src/lint/graph.js'
import { listLiveRows } from './nightly.js'
import type { FileRow, SyncDeps } from './sync.js'

export interface VaultView {
  head: number
  /** Every document, parsed lite (`body` and `sections[].body` are ''). */
  docs: Map<string, ParsedVaultDoc>
  rows: Map<string, FileRow>
  /** Raw text of one document, fetched from the store ('' when unknown). */
  textOf(path: string): Promise<string>
  /** Body text of one document, frontmatter stripped ('' when unknown). */
  bodyOf(path: string): Promise<string>
  /** Full parse of one document (body and sections included), or null. */
  parsed(path: string): Promise<ParsedVaultDoc | null>
  /** BM25 over every document's body; built during the load. */
  bm25(): Bm25
  /** Resolved link graph over `docs`, built on first use. */
  graph(): LintGraph
  /** Documents by id, built on first use. */
  byId(): Map<string, ParsedVaultDoc>
  /** True when more documents changed than one load may fetch; the next load catches up. */
  partial: boolean
}

let _cache: VaultView | null = null
/** Concurrent callers (a client issuing tool calls in parallel) share one load. */
let _inflight: Promise<VaultView> | null = null
/** When this isolate last wrote the snapshot and at which head, to keep rewrites rare. */
let _snapshotWritten: { at: number; head: number } = { at: 0, head: -1 }

/** gzip NDJSON: a header line `{version, head}` then one `{path, etag, content}` per document. */
export const VAULT_SNAPSHOT_KEY = '_system/vault-snapshot'
const SNAPSHOT_VERSION = 2
/** A cold load that fetched at least this many documents rewrites the snapshot (subject to the interval). */
const SNAPSHOT_REWRITE_AFTER = 40
/** …but not more often than this while the vault churns; a big backlog rewrites regardless. */
const SNAPSHOT_MIN_INTERVAL_MS = 3 * 60 * 1000
const SNAPSHOT_REWRITE_FORCE = 150
/** Hard cap on per-load R2 reads (the invocation's subrequest budget); the rest wait for the next load. */
const MAX_READS_PER_LOAD = 800
const BATCH = 100

const dec = new TextDecoder()
const enc = new TextEncoder()

/** Current documents. Reuses the isolate cache while the sequence head is unchanged. */
export function loadVaultView(deps: SyncDeps, force = false): Promise<VaultView> {
  return _inflight ??= buildVaultView(deps, force).finally(() => { _inflight = null })
}

export function invalidateVaultView(): void { _cache = null }

/** Whether the snapshot on the server already reflects this view's head (written by this isolate). */
export function snapshotIsCurrent(view: VaultView): boolean { return _snapshotWritten.head === view.head }

/** Parsed lite: keep the shape, drop the text. */
function lite(d: ParsedVaultDoc): ParsedVaultDoc {
  return { ...d, body: '', sections: d.sections.map(s => ({ id: s.id, heading: s.heading, body: '', wikiLinks: s.wikiLinks })) }
}

/** Body without frontmatter — the cheap version of parseVaultDoc for tokenising. */
export function stripFrontmatter(raw: string): string {
  if (!raw.startsWith('---')) return raw
  const end = raw.indexOf('\n---', 3)
  return end < 0 ? raw : raw.slice(end + 4).replace(/^\r?\n/, '')
}

async function buildVaultView(deps: SyncDeps, force: boolean): Promise<VaultView> {
  const head = await deps.meta.head()
  const now = Date.now()
  // The D1 head moves on every write (API, bridge, batch), so an unchanged head means an unchanged vault
  if (!force && _cache && _cache.head === head) return _cache
  const t0 = Date.now()
  const previous = _cache
  _cache = null                                   // nothing keeps the old view alive while the new one is built

  const rows = await listLiveRows(deps.meta)
  const rowMap = new Map<string, FileRow>()
  const docs = new Map<string, ParsedVaultDoc>()
  const index = Bm25.from(previous?.bm25() ?? null)
  const pending = new Map<string, FileRow>()      // markdown rows whose text this load still needs
  for (const row of rows) {
    rowMap.set(row.path, row)
    if (!row.path.toLowerCase().endsWith('.md')) continue
    const prev = previous?.rows.get(row.path)
    const prevDoc = previous?.docs.get(row.path)
    if (prev && prevDoc && prev.etag === row.etag) { docs.set(row.path, prevDoc); continue }
    pending.set(row.path, row)
  }
  // Documents that vanished or changed since the previous view leave the index
  if (previous) for (const path of previous.docs.keys()) if (!docs.has(path)) index.remove(path)

  // A cold isolate streams the snapshot; every document read this way may be re-streamed into
  // a new snapshot at the end, so the text passes through once and is never retained
  const writer = previous ? null : new SnapshotWriter(head)
  let snapshotUsed = false
  const take = (row: FileRow, text: string) => {
    const full = parseVaultDoc(row.path, text, row.mtime)
    docs.set(row.path, lite(full))
    index.add(row.path, full, full.body)
    writer?.add(row.path, row.etag, text)
    pending.delete(row.path)
  }
  if (!previous) {
    const raw = await deps.blobs.get(VAULT_SNAPSHOT_KEY)
    if (raw) {
      try {
        for await (const line of readSnapshot(raw)) {
          snapshotUsed = true
          const row = pending.get(line.path)
          if (row && row.etag === line.etag) take(row, line.content)
        }
      } catch (e) { console.error('[vault-view] snapshot unreadable, reading the vault instead', e) }
    }
  }
  // R2 reads in wide parallel batches for whatever the previous view or the snapshot did not cover
  const toRead = [...pending.values()]
  const reads = toRead.slice(0, MAX_READS_PER_LOAD)
  for (let i = 0; i < reads.length; i += BATCH) {
    const part = await Promise.all(reads.slice(i, i + BATCH).map(async row => [row, await deps.blobs.get(row.path)] as const))
    for (const [row, bytes] of part) if (bytes) take(row, dec.decode(bytes))
  }
  const partial = toRead.length > reads.length

  let graph: LintGraph | null = null
  let byId: Map<string, ParsedVaultDoc> | null = null
  const textOf = async (path: string) => { const b = docs.has(path) ? await deps.blobs.get(path) : null; return b ? dec.decode(b) : '' }
  const view: VaultView = {
    head, docs, rows: rowMap, partial,
    textOf,
    bodyOf: async path => stripFrontmatter(await textOf(path)),
    parsed: async path => { const t = await textOf(path); return t ? parseVaultDoc(path, t, rowMap.get(path)?.mtime) : null },
    bm25: () => index,
    graph: () => (graph ??= buildLintGraph([...docs.values()])),
    byId: () => (byId ??= new Map([...docs.values()].map(d => [d.id, d]))),
  }
  _cache = view
  console.log(`[vault-view] ${previous ? 'warm' : 'cold'} load ${Date.now() - t0} ms: ${docs.size} docs, ${reads.length} read from R2${snapshotUsed ? ', snapshot used' : ''}${partial ? ', partial' : ''}`)

  // A cold load that did real work leaves a fresher snapshot behind — but not on every call
  // while a sync push is landing. A partial view is still written: it carries everything read so
  // far, so each cold load moves the snapshot closer to the vault instead of re-reading the same backlog.
  if (writer) {
    const overdue = now - _snapshotWritten.at >= SNAPSHOT_MIN_INTERVAL_MS
    if (!snapshotUsed || partial || reads.length >= SNAPSHOT_REWRITE_FORCE || (reads.length >= SNAPSHOT_REWRITE_AFTER && overdue)) {
      await writer.finish(deps).then(() => { _snapshotWritten = { at: Date.now(), head } }).catch(e => console.error('[vault-view] snapshot write failed', e))
    }
  }
  return view
}

/** Write the snapshot for a view whose text is no longer in memory (the nightly batch): re-reads every document. */
export async function writeVaultSnapshot(deps: SyncDeps, view: VaultView): Promise<void> {
  const writer = new SnapshotWriter(view.head)
  const paths = [...view.docs.keys()]
  for (let i = 0; i < paths.length; i += BATCH) {
    const part = await Promise.all(paths.slice(i, i + BATCH).map(async p => [p, await deps.blobs.get(p)] as const))
    for (const [p, bytes] of part) if (bytes) writer.add(p, view.rows.get(p)?.etag ?? '', dec.decode(bytes))
  }
  await writer.finish(deps)
  _snapshotWritten = { at: Date.now(), head: view.head }
}

// ── Snapshot streaming ───────────────────────────────────────────────────────

interface SnapshotLine { path: string; etag: string; content: string }

const hasStreams = typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'
const GZIP_MAGIC = [0x1f, 0x8b]

/** Accumulates NDJSON lines through gzip; only the compressed bytes stay in memory. */
class SnapshotWriter {
  private chunks: Uint8Array[] = []
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private drained: Promise<void> | null = null
  private plain: string[] = []

  constructor(head: number) {
    if (hasStreams) {
      const stream = new CompressionStream('gzip')
      this.writer = stream.writable.getWriter()
      const reader = stream.readable.getReader()
      this.drained = (async () => { for (;;) { const { done, value } = await reader.read(); if (done) break; this.chunks.push(value) } })()
    }
    this.line({ version: SNAPSHOT_VERSION, head })
  }

  add(path: string, etag: string, content: string): void { this.line({ path, etag, content }) }

  private line(obj: unknown): void {
    const text = JSON.stringify(obj) + '\n'
    if (this.writer) void this.writer.write(enc.encode(text))
    else this.plain.push(text)
  }

  async finish(deps: SyncDeps): Promise<void> {
    let bytes: Uint8Array
    if (this.writer) {
      await this.writer.close()
      await this.drained
      const total = this.chunks.reduce((n, c) => n + c.byteLength, 0)
      bytes = new Uint8Array(total)
      let offset = 0
      for (const c of this.chunks) { bytes.set(c, offset); offset += c.byteLength }
    } else {
      bytes = enc.encode(this.plain.join(''))
    }
    await deps.blobs.put(VAULT_SNAPSHOT_KEY, bytes)
  }
}

/** Snapshot bytes (gzip or plain NDJSON) → one document per line, streamed so the whole text is never held at once. */
export async function* readSnapshot(raw: Uint8Array): AsyncGenerator<SnapshotLine> {
  const gz = raw[0] === GZIP_MAGIC[0] && raw[1] === GZIP_MAGIC[1]
  let source: ReadableStream<Uint8Array> = new Blob([raw as unknown as ArrayBuffer]).stream()
  if (gz) {
    if (!hasStreams) throw new Error('gzip snapshot but no DecompressionStream')
    source = source.pipeThrough(new DecompressionStream('gzip'))
  }
  const reader = source.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  let header = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
      if (!line) continue
      const obj = JSON.parse(line) as { version?: number } & SnapshotLine
      if (!header) { header = true; if (obj.version !== SNAPSHOT_VERSION) throw new Error(`snapshot version ${obj.version}`); continue }
      yield obj
    }
  }
  if (buf.trim()) {
    const obj = JSON.parse(buf) as { version?: number } & SnapshotLine
    if (header) yield obj
  }
}

/** Snapshot bytes → the documents it holds (for tests and tooling). */
export async function decodeSnapshot(raw: Uint8Array): Promise<SnapshotLine[]> {
  const out: SnapshotLine[] = []
  for await (const line of readSnapshot(raw)) out.push(line)
  return out
}

// ── Tokeniser + BM25 ─────────────────────────────────────────────────────────

/**
 * Lowercase words for Latin/digits; for Hangul runs, the run itself (while short enough to be a
 * word someone would type) plus character bigrams, so "전투시스템" matches "전투" and "시스템"
 * without a morphological analyser.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+|[가-힣]+/g)) {
    const t = m[0]
    if (t.charCodeAt(0) >= 0xac00) {
      if (t.length <= 2) { out.push(t); continue }
      if (t.length <= HANGUL_RUN_MAX) out.push(t)
      for (let i = 0; i + 2 <= t.length; i++) out.push(t.slice(i, i + 2))
    } else if (t.length > 1) {
      out.push(t)
    }
  }
  return out
}
const HANGUL_RUN_MAX = 6

export interface Bm25Hit { path: string; docId: string; title: string; score: number }

/**
 * BM25 over the vault as posting lists: one shared vocabulary (token → id) and, per term, the
 * documents it occurs in with their frequencies, packed as `slot * 256 + tf`. A per-document
 * token map would cost ~50 KB per Korean document; posting lists cost ~8 B per (document, term).
 *
 * Incremental: `Bm25.from(base)` takes over an earlier index; documents that changed or vanished
 * are tombstoned (their slots stay in the lists but are skipped and no longer counted) and the
 * changed ones are added under fresh slots.
 */
export class Bm25 {
  private vocab = new Map<string, number>()
  private postings: number[][] = []          // term id → packed (slot, tf)
  private df: number[] = []                  // term id → live documents containing it
  private slotPath: string[] = []            // document slot → path ('' once tombstoned)
  private slotLen: number[] = []
  private slotMeta: ({ docId: string; title: string } | null)[] = []
  private slotTerms: number[][] = []         // document slot → term ids (to decrement df on removal)
  private slotOf = new Map<string, number>() // live path → slot
  private live = 0
  private totalLen = 0
  private readonly k1 = 1.5
  private readonly b = 0.75

  /** Build over a document map (tests and small callers); the view feeds documents one by one instead. */
  constructor(docs?: Map<string, ParsedVaultDoc>) {
    if (docs) for (const [path, d] of docs) this.add(path, d, d.body)
  }

  /** A new index that owns the base's tables (the base belongs to a superseded view). */
  static from(base: Bm25 | null): Bm25 {
    const b = new Bm25()
    if (!base) return b
    b.vocab = base.vocab; b.postings = base.postings; b.df = base.df
    b.slotPath = base.slotPath; b.slotLen = base.slotLen; b.slotMeta = base.slotMeta; b.slotTerms = base.slotTerms
    b.slotOf = base.slotOf; b.live = base.live; b.totalLen = base.totalLen
    return b
  }

  get size(): number { return this.live }

  add(path: string, d: ParsedVaultDoc, body: string): void {
    if (this.slotOf.has(path)) this.remove(path)
    const counts = new Map<number, number>()
    let len = 0
    for (const t of tokenize(`${d.title} ${d.title} ${d.tags.join(' ')} ${body}`)) {
      let id = this.vocab.get(t)
      if (id === undefined) { id = this.vocab.size; this.vocab.set(t, id); this.postings.push([]); this.df.push(0) }
      counts.set(id, (counts.get(id) ?? 0) + 1)
      len++
    }
    const slot = this.slotPath.length
    this.slotPath.push(path); this.slotLen.push(len); this.slotMeta.push({ docId: d.id, title: d.title })
    const terms: number[] = []
    for (const [id, tf] of counts) { this.postings[id].push(slot * 256 + Math.min(tf, 255)); this.df[id]++; terms.push(id) }
    this.slotTerms.push(terms)
    this.slotOf.set(path, slot)
    this.live++; this.totalLen += len
  }

  remove(path: string): void {
    const slot = this.slotOf.get(path)
    if (slot === undefined) return
    for (const id of this.slotTerms[slot]) this.df[id]--
    this.slotOf.delete(path)
    this.slotPath[slot] = ''; this.slotMeta[slot] = null; this.slotTerms[slot] = []
    this.live--; this.totalLen -= this.slotLen[slot]
  }

  search(query: string, topK = 10, exclude: Set<string> = new Set()): Bm25Hit[] {
    const q = [...new Set(tokenize(query))]
    if (q.length === 0 || this.live === 0) return []
    const n = this.live
    const avgLen = this.totalLen / n
    const scores = new Map<number, number>()
    for (const t of q) {
      const id = this.vocab.get(t)
      if (id === undefined) continue
      const df = this.df[id]
      if (df <= 0) continue
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      for (const packed of this.postings[id]) {
        const slot = Math.floor(packed / 256)
        if (!this.slotPath[slot]) continue
        const f = packed % 256, dl = this.slotLen[slot]
        scores.set(slot, (scores.get(slot) ?? 0) + idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * dl / avgLen)))
      }
    }
    const hits: Bm25Hit[] = []
    for (const [slot, score] of scores) {
      const path = this.slotPath[slot]
      if (score > 0 && !exclude.has(path)) hits.push({ path, ...this.slotMeta[slot]!, score })
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, topK)
  }
}
