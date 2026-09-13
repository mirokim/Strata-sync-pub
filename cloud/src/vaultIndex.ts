/**
 * In-memory view of the team vault for the Worker: every live markdown document parsed *lite*
 * (title, tags, links, section headings and wikilinks — no body text), a BM25 index over the
 * bodies, and a lazily built link graph. Built per isolate and refreshed when the D1 sequence
 * head moves, so repeated MCP calls in the same isolate do not re-read anything.
 *
 * Memory is the constraint, not CPU: a Worker isolate has 128 MB and a team vault has thousands
 * of Korean documents. So document text is never retained — it streams through the parser and
 * the tokeniser once and is dropped; anything that needs a body later (`bodyOf`, `parsed`)
 * fetches it from R2.
 *
 * The snapshot (`_system/vault-snapshot`) is the view itself, not the text: the lite documents,
 * the vocabulary and the posting lists, gzip-compressed binary. A cold isolate streams it in
 * (no parsing, no tokenising) and only reads the documents whose hash moved since from R2; any
 * isolate, warm or cold, can write a fresh one from memory.
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

export const VAULT_SNAPSHOT_KEY = '_system/vault-snapshot'
const SNAPSHOT_VERSION = 3
/** A load that fetched at least this many documents rewrites the snapshot (subject to the interval). */
const SNAPSHOT_REWRITE_AFTER = 20
/** …but not more often than this while the vault churns; a big backlog rewrites regardless. */
const SNAPSHOT_MIN_INTERVAL_MS = 2 * 60 * 1000
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

  // The row list (D1) and the snapshot (R2) are independent: fetch them together
  const [rows, raw] = await Promise.all([listLiveRows(deps.meta), previous ? null : deps.blobs.get(VAULT_SNAPSHOT_KEY)])
  const rowMap = new Map<string, FileRow>()
  for (const row of rows) rowMap.set(row.path, row)

  // Base to start from: this isolate's previous view, else the stored snapshot, else nothing
  let base: { docs: Map<string, ParsedVaultDoc>; etags: Map<string, string>; index: Bm25 } | null = null
  let snapshotUsed = false
  let snapshotBytes = 0
  if (previous) {
    base = { docs: previous.docs, etags: new Map([...previous.rows].map(([p, r]) => [p, r.etag])), index: previous.bm25() }
  } else if (raw) {
    snapshotBytes = raw.byteLength
    try { base = await readSnapshot(raw); snapshotUsed = true }
    catch (e) { console.error('[vault-view] snapshot unreadable, reading the vault instead', e) }
  }

  const docs = new Map<string, ParsedVaultDoc>()
  const index = base ? Bm25.from(base.index) : new Bm25()
  const pending: FileRow[] = []
  for (const row of rows) {
    if (!row.path.toLowerCase().endsWith('.md')) continue
    const known = base?.docs.get(row.path)
    if (known && base!.etags.get(row.path) === row.etag) { docs.set(row.path, known); continue }
    pending.push(row)
  }
  // Documents that vanished or changed since the base leave the index
  if (base) for (const path of base.docs.keys()) if (!docs.has(path)) index.remove(path)

  // R2 reads in wide parallel batches for whatever the base did not cover
  const reads = pending.slice(0, MAX_READS_PER_LOAD)
  for (let i = 0; i < reads.length; i += BATCH) {
    const part = await Promise.all(reads.slice(i, i + BATCH).map(async row => [row, await deps.blobs.get(row.path)] as const))
    for (const [row, bytes] of part) {
      if (!bytes) continue
      const full = parseVaultDoc(row.path, dec.decode(bytes), row.mtime)
      docs.set(row.path, lite(full))
      index.add(row.path, full, full.body)
    }
  }
  const partial = pending.length > reads.length

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
  console.log(`[vault-view] ${previous ? 'warm' : 'cold'} load ${Date.now() - t0} ms: ${docs.size} docs, ${reads.length} read from R2${snapshotUsed ? `, snapshot ${(snapshotBytes / 1048576).toFixed(1)} MB` : ''}${partial ? ', partial' : ''}`)

  // A load that did real work leaves a fresher snapshot behind — from memory, so any isolate can.
  // Not on every call while a sync push is landing; a partial view is still written (it carries
  // everything read so far, so each load moves the snapshot closer to the vault).
  const overdue = now - _snapshotWritten.at >= SNAPSHOT_MIN_INTERVAL_MS
  if ((!snapshotUsed && !previous && reads.length > 0) || partial || reads.length >= SNAPSHOT_REWRITE_FORCE || (reads.length >= SNAPSHOT_REWRITE_AFTER && overdue)) {
    await writeVaultSnapshot(deps, view).catch(e => console.error('[vault-view] snapshot write failed', e))
  }
  return view
}

// ── Snapshot: the view as gzip binary ─────────────────────────────────────────
//
//   [u32 header length][header JSON]  {version, head, docs: [{path, etag, doc}], vocab: string[],
//                                      slots: [{path, len, docId, title}], postings: number[] (per term length)}
//   [u32 × Σ postings]                 packed (slot * 256 + tf), term by term
//
// Everything after the header is a plain little-endian Uint32 run, so a reader can stream the
// header, allocate one buffer and fill it — no whole-file string, no JSON of millions of numbers.

interface SnapshotHeader {
  version: number
  head: number
  docs: { path: string; etag: string; doc: ParsedVaultDoc }[]
  vocab: string[]
  slots: { path: string; len: number; docId: string; title: string }[]
  postings: number[]
}

export async function writeVaultSnapshot(deps: SyncDeps, view: VaultView): Promise<void> {
  const { header, postings } = view.bm25().serialize()
  const full: SnapshotHeader = {
    ...header, version: SNAPSHOT_VERSION, head: view.head,
    docs: [...view.docs].map(([path, doc]) => ({ path, etag: view.rows.get(path)?.etag ?? '', doc })),
  }
  const headerBytes = enc.encode(JSON.stringify(full))
  const lenBytes = new Uint8Array(4)
  new DataView(lenBytes.buffer).setUint32(0, headerBytes.byteLength, true)
  const stream = new CompressionStream('gzip')
  const writer = stream.writable.getWriter()
  const chunks: Uint8Array[] = []
  const drained = (async () => { const r = stream.readable.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; chunks.push(value) } })()
  await writer.write(lenBytes)
  await writer.write(headerBytes)
  await writer.write(new Uint8Array(postings.buffer, postings.byteOffset, postings.byteLength))
  await writer.close()
  await drained
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength }
  await deps.blobs.put(VAULT_SNAPSHOT_KEY, bytes)
  _snapshotWritten = { at: Date.now(), head: view.head }
}

/** Sequential reads over a decompressing stream, so only the piece being read is in memory. */
class ByteReader {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(0)
  constructor(stream: ReadableStream<Uint8Array>) { this.reader = stream.getReader() }

  /** Fill `target` completely; throws when the stream ends first. */
  async readInto(target: Uint8Array): Promise<void> {
    let filled = 0
    while (filled < target.byteLength) {
      if (this.buf.byteLength === 0) {
        const { done, value } = await this.reader.read()
        if (done) throw new Error('snapshot truncated')
        this.buf = value as Uint8Array<ArrayBuffer>
      }
      const take = Math.min(this.buf.byteLength, target.byteLength - filled)
      target.set(this.buf.subarray(0, take), filled)
      this.buf = this.buf.subarray(take)
      filled += take
    }
  }
}

/** Snapshot bytes → lite documents, their hashes and a ready BM25 index. Throws on any other format. */
export async function readSnapshot(raw: Uint8Array): Promise<{ docs: Map<string, ParsedVaultDoc>; etags: Map<string, string>; index: Bm25 }> {
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) throw new Error('not a gzip snapshot')
  const stream = new Blob([raw as unknown as ArrayBuffer]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = new ByteReader(stream)
  const lenBytes = new Uint8Array(4)
  await reader.readInto(lenBytes)
  const headerLen = new DataView(lenBytes.buffer).getUint32(0, true)
  const headerBytes = new Uint8Array(headerLen)
  await reader.readInto(headerBytes)
  const header = JSON.parse(dec.decode(headerBytes)) as SnapshotHeader
  if (header.version !== SNAPSHOT_VERSION) throw new Error(`snapshot version ${header.version}`)
  const total = header.postings.reduce((n, c) => n + c, 0)
  const postings = new Uint32Array(total)
  await reader.readInto(new Uint8Array(postings.buffer))
  const docs = new Map<string, ParsedVaultDoc>()
  const etags = new Map<string, string>()
  for (const d of header.docs) { docs.set(d.path, d.doc); etags.set(d.path, d.etag) }
  return { docs, etags, index: Bm25.fromSnapshot(header, postings) }
}

/** The documents a snapshot holds (for tests and tooling). */
export async function decodeSnapshot(raw: Uint8Array): Promise<{ path: string; etag: string }[]> {
  const { docs, etags } = await readSnapshot(raw)
  return [...docs.keys()].map(path => ({ path, etag: etags.get(path) ?? '' }))
}

// ── Tokeniser + BM25 ─────────────────────────────────────────────────────────

/**
 * Lowercase words for Latin/digits; for Hangul runs, the run itself (while short enough to be a
 * word someone would type) plus character bigrams, so "전투시스템" matches "전투" and "시스템"
 * without a morphological analyser. Text is folded to NFC first: macOS hands out decomposed
 * Hangul, which the syllable range would not match at all.
 */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const m of text.normalize('NFC').toLowerCase().matchAll(/[a-z0-9_]+|[가-힣]+/g)) {
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

type Posting = Uint32Array | number[]

/**
 * BM25 over the vault as posting lists: one shared vocabulary (token → id) and, per term, the
 * documents it occurs in with their frequencies, packed as `slot * 256 + tf`. Posting lists cost
 * ~4 B per (document, term) — a per-document token map would cost ~50 KB per Korean document.
 *
 * Incremental: `Bm25.from(base)` takes over an earlier index; documents that changed or vanished
 * are tombstoned (their slots stay in the lists but are skipped, and the term frequency used for
 * idf counts live documents only, computed while the list is scanned) and the changed ones are
 * added under fresh slots. Postings loaded from a snapshot are immutable typed arrays; documents
 * added since go to a per-term overflow list.
 */
export class Bm25 {
  private vocab = new Map<string, number>()
  private postings: Posting[] = []
  private overflow = new Map<number, number[]>()   // term id → postings added after the base was frozen
  private slotPath: string[] = []                  // document slot → path ('' once tombstoned)
  private slotLen: number[] = []
  private slotMeta: ({ docId: string; title: string } | null)[] = []
  private slotOf = new Map<string, number>()       // live path → slot
  private live = 0
  private totalLen = 0
  private readonly k1 = 1.5
  private readonly b = 0.75

  /** Build over a document map (tests and small callers); the view feeds documents one by one instead. */
  constructor(docs?: Map<string, ParsedVaultDoc>) {
    if (docs) for (const [path, d] of docs) this.add(path, d, d.body)
  }

  /** A new index that owns the base's tables (the base belongs to a superseded view). */
  static from(base: Bm25): Bm25 {
    const b = new Bm25()
    b.vocab = base.vocab; b.postings = base.postings; b.overflow = base.overflow
    b.slotPath = base.slotPath; b.slotLen = base.slotLen; b.slotMeta = base.slotMeta
    b.slotOf = base.slotOf; b.live = base.live; b.totalLen = base.totalLen
    return b
  }

  /** Rebuild from a snapshot header and its packed posting run. */
  static fromSnapshot(header: Pick<SnapshotHeader, 'vocab' | 'slots' | 'postings'>, run: Uint32Array): Bm25 {
    const b = new Bm25()
    header.vocab.forEach((t, id) => b.vocab.set(t, id))
    let offset = 0
    for (const count of header.postings) { b.postings.push(run.subarray(offset, offset + count)); offset += count }
    header.slots.forEach((s, slot) => {
      b.slotPath.push(s.path); b.slotLen.push(s.len); b.slotMeta.push(s.path ? { docId: s.docId, title: s.title } : null)
      if (s.path) { b.slotOf.set(s.path, slot); b.live++; b.totalLen += s.len }
    })
    return b
  }

  /** Compact tables for a snapshot: tombstoned slots dropped, overflow merged, everything renumbered. */
  serialize(): { header: Pick<SnapshotHeader, 'vocab' | 'slots' | 'postings'>; postings: Uint32Array } {
    const slotMap = new Map<number, number>()
    const slots: SnapshotHeader['slots'] = []
    this.slotPath.forEach((path, slot) => {
      if (!path) return
      slotMap.set(slot, slots.length)
      slots.push({ path, len: this.slotLen[slot], docId: this.slotMeta[slot]!.docId, title: this.slotMeta[slot]!.title })
    })
    const vocab: string[] = []
    const counts: number[] = []
    const runs: number[][] = []
    let total = 0
    for (const [term, id] of this.vocab) {
      const kept: number[] = []
      for (const packed of this.eachPosting(id)) {
        const to = slotMap.get(Math.floor(packed / 256))
        if (to !== undefined) kept.push(to * 256 + (packed % 256))
      }
      if (kept.length === 0) continue                // a term only dead documents used
      vocab.push(term); counts.push(kept.length); runs.push(kept); total += kept.length
    }
    const flat = new Uint32Array(total)
    let offset = 0
    for (const r of runs) { flat.set(r, offset); offset += r.length }
    return { header: { vocab, slots, postings: counts }, postings: flat }
  }

  private *eachPosting(id: number): Generator<number> {
    const base = this.postings[id]
    if (base) for (let i = 0; i < base.length; i++) yield base[i]
    const extra = this.overflow.get(id)
    if (extra) yield* extra
  }

  get size(): number { return this.live }

  add(path: string, d: ParsedVaultDoc, body: string): void {
    if (this.slotOf.has(path)) this.remove(path)
    const counts = new Map<number, number>()
    let len = 0
    for (const t of tokenize(`${d.title} ${d.title} ${d.tags.join(' ')} ${body}`)) {
      let id = this.vocab.get(t)
      if (id === undefined) { id = this.vocab.size; this.vocab.set(t, id); this.postings.push([]) }
      counts.set(id, (counts.get(id) ?? 0) + 1)
      len++
    }
    const slot = this.slotPath.length
    this.slotPath.push(path); this.slotLen.push(len); this.slotMeta.push({ docId: d.id, title: d.title })
    for (const [id, tf] of counts) {
      const packed = slot * 256 + Math.min(tf, 255)
      const base = this.postings[id]
      if (Array.isArray(base)) base.push(packed)
      else { let o = this.overflow.get(id); if (!o) { o = []; this.overflow.set(id, o) } o.push(packed) }
    }
    this.slotOf.set(path, slot)
    this.live++; this.totalLen += len
  }

  remove(path: string): void {
    const slot = this.slotOf.get(path)
    if (slot === undefined) return
    this.slotOf.delete(path)
    this.slotPath[slot] = ''; this.slotMeta[slot] = null
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
      // One pass to collect the live hits (that count is the term's df), one to score them
      const hits: number[] = []
      for (const packed of this.eachPosting(id)) if (this.slotPath[Math.floor(packed / 256)]) hits.push(packed)
      const df = hits.length
      if (df === 0) continue
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
      for (const packed of hits) {
        const slot = Math.floor(packed / 256)
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
