/**
 * Nightly batch — runs from the Worker's cron trigger, independent of Cloudflare bindings.
 *
 *   1. Load every live markdown document from the team vault (D1 rows → R2 bodies).
 *   2. Run the shared vault lint (mcp/src/lint) against the previous night's cluster snapshot and
 *      write the report into the vault as `_reports/lint-YYYY-MM-DD.md` — through the sync
 *      protocol, so every client pulls it like any other document.
 *   3. Re-embed only documents whose content hash changed since the last run and drop vectors
 *      of deleted documents (Workers AI bge-m3 → Vectorize). Skipped when no embedder is wired.
 *
 * Server-side bookkeeping lives under `_system/` in R2 with no D1 row, so clients never see it.
 */
import { runLint, reportToMarkdown, type LintReport, type LintSnapshot } from '../../mcp/src/lint/index.js'
import { parseVaultDoc, type ParsedVaultDoc } from '../../mcp/src/lint/vaultDoc.js'
import { putFile, deleteFile, type FileRow, type SyncDeps } from './sync.js'
import { loadVaultView, writeVaultSnapshot } from './vaultIndex.js'
import { isPersonalPath } from './personal.js'

export const SNAPSHOT_KEY = '_system/lint-snapshot.json'
export const EMBED_INDEX_KEY = '_system/embed-index.json'
/** Last runs of the batch (cron or manual), newest last; shown in the app's Server tab. */
export const BATCH_LOG_KEY = '_system/batch-log.json'
const BATCH_LOG_MAX = 30
export const REPORT_FOLDER = '_reports'
export const BOT_AUTHOR = 'strata-bot'
/** Reports older than this are tombstoned each night so the folder does not grow forever. */
export const REPORT_RETENTION_DAYS = 30

/** Section text cap — bge-m3 handles 8k tokens; this keeps one chunk well inside that. */
const CHUNK_MAX_CHARS = 4500
const CHUNK_MIN_CHARS = 30
/**
 * Chunks per Workers AI call. Chunks of several documents share a call: on the Free plan one
 * invocation gets ~50 subrequests, and every embed + upsert pair is two of them.
 */
const EMBED_BATCH = 50

export interface VectorItem { id: string; values: number[]; metadata: Record<string, string> }

export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>
  deleteByIds(ids: string[]): Promise<void>
}

export interface NightlyDeps extends SyncDeps {
  /** Batch embedder (Workers AI). Absent → embeddings step is skipped. */
  embed?: (texts: string[]) => Promise<number[][]>
  vectors?: VectorStore
  log?: (msg: string) => void
  /** IANA zone used to date the report file name (default Asia/Seoul — the cron fires at 04:00 there). */
  timeZone?: string
  /**
   * Documents to (re)embed per run (default 150). The index is checkpointed after every batch,
   * so a run that is cut off by the platform still leaves progress behind and the next run
   * continues where it stopped instead of starting over.
   */
  maxEmbedDocsPerRun?: number
  /**
   * Embed/upsert call pairs per run (default 22 — under the Free plan's 50-subrequest cap once
   * index checkpoints and deletes are counted). Runs stop cleanly at the budget with `pending`.
   */
  maxEmbedBatchesPerRun?: number
}

export interface NightlyResult {
  /** ms since epoch when the run started, and how long it took. */
  startedAt: number
  durationMs: number
  trigger: 'cron' | 'manual'
  docs: number
  lint: { reportPath: string; errors: number; warnings: number; skipped: string[]; prunedReports: number }
  embeddings: { skipped: boolean; docsEmbedded: number; chunksUpserted: number; docsRemoved: number; chunksDeleted: number; pending: number; error?: string }
}

interface EmbedIndex { version: 1; docs: Record<string, { etag: string; chunks: number }> }

/** What the app shows: how much of the vault the vector index covers, and the recent runs. */
export interface BatchStatus {
  /** Live markdown documents that are candidates for the index. */
  totalDocs: number
  /** Documents whose current version is in the vector index. */
  embeddedDocs: number
  /** Documents the next run still has to (re)embed. */
  pendingDocs: number
  runs: NightlyResult[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()

async function readJson<T>(deps: SyncDeps, key: string): Promise<T | undefined> {
  const bytes = await deps.blobs.get(key)
  if (!bytes) return undefined
  try { return JSON.parse(dec.decode(bytes)) as T } catch { return undefined }
}

async function writeJson(deps: SyncDeps, key: string, value: unknown): Promise<void> {
  await deps.blobs.put(key, enc.encode(JSON.stringify(value)))
}

/** Every live row, paging through the manifest API's underlying store. */
export async function listLiveRows(meta: SyncDeps['meta']): Promise<FileRow[]> {
  const out: FileRow[] = []
  let since = 0
  for (;;) {
    const page = await meta.listSince(since, 1000)
    if (page.length === 0) break
    for (const r of page) if (!r.deleted) out.push(r)
    since = page[page.length - 1].seq
    if (page.length < 1000) break
  }
  return out
}

export async function loadVaultDocs(deps: SyncDeps, rows: FileRow[]): Promise<Map<string, ParsedVaultDoc>> {
  const docs = new Map<string, ParsedVaultDoc>()
  for (const row of rows) {
    if (!row.path.toLowerCase().endsWith('.md')) continue
    const bytes = await deps.blobs.get(row.path)
    if (!bytes) continue
    docs.set(row.path, parseVaultDoc(row.path, dec.decode(bytes), row.mtime))
  }
  return docs
}

/** YYYY-MM-DD in the given zone. The cron runs at 19:00 UTC, which is already the next day in Seoul. */
export function localDate(now: number, timeZone = 'Asia/Seoul'): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now))
    const get = (t: string) => parts.find(p => p.type === t)?.value ?? ''
    return `${get('year')}-${get('month')}-${get('day')}`
  } catch {
    return new Date(now).toISOString().slice(0, 10)
  }
}

export function reportPathFor(now: number, timeZone?: string): string {
  return `${REPORT_FOLDER}/lint-${localDate(now, timeZone)}.md`
}

const REPORT_NAME_RE = /^_reports\/lint-(\d{4}-\d{2}-\d{2})\.md$/

/** Tombstone lint reports older than the retention window. Returns how many were removed. */
export async function pruneOldReports(deps: SyncDeps, rows: FileRow[], now: number, retentionDays = REPORT_RETENTION_DAYS): Promise<number> {
  const cutoff = now - retentionDays * 86_400_000
  let pruned = 0
  for (const row of rows) {
    const m = REPORT_NAME_RE.exec(row.path)
    if (!m) continue
    const dated = Date.parse(`${m[1]}T00:00:00Z`)
    if (Number.isNaN(dated) || dated >= cutoff) continue
    const r = await deleteFile(deps, row.path, row.etag, BOT_AUTHOR)
    if (r.status === 200) pruned++
  }
  return pruned
}

export async function runNightly(deps: NightlyDeps, trigger: 'cron' | 'manual' = 'cron'): Promise<NightlyResult> {
  const now = (deps.now ?? Date.now)()
  const wallStart = Date.now()
  const log = deps.log ?? (() => {})
  const allRows = await listLiveRows(deps.meta)
  const view = await loadVaultView(deps, true)
  await writeVaultSnapshot(deps, view).catch(e => log(`[nightly] snapshot write failed: ${e}`))
  // Personal documents stay out of the shared lint report and the shared embedding index
  const rows = allRows.filter(r => !isPersonalPath(r.path))
  const docs = new Map([...view.docs].filter(([p]) => !isPersonalPath(p)))
  log(`[nightly] ${docs.size} documents`)

  // ── Lint ─────────────────────────────────────────────────────────────────
  const previous = await readJson<LintSnapshot>(deps, SNAPSHOT_KEY)
  const report: LintReport = runLint({ docs: [...docs.values()], previousSnapshot: previous }, { now })
  await writeJson(deps, SNAPSHOT_KEY, report.snapshot)

  const reportPath = reportPathFor(now, deps.timeZone)
  const markdown = reportToMarkdown(report, { title: 'Nightly vault lint', date: localDate(now, deps.timeZone) })
  const put = await putFile(deps, { path: reportPath, body: enc.encode(markdown), mtime: now, author: BOT_AUTHOR })
  if (put.status >= 400) log(`[nightly] report write failed: ${JSON.stringify(put.body)}`)
  const prunedReports = await pruneOldReports(deps, rows, now)
  log(`[nightly] lint: ${report.summary.bySeverity.error} errors, ${report.summary.bySeverity.warn} warnings → ${reportPath} (${prunedReports} old reports pruned)`)

  // ── Embeddings ───────────────────────────────────────────────────────────
  const embeddings: NightlyResult['embeddings'] = { skipped: true, docsEmbedded: 0, chunksUpserted: 0, docsRemoved: 0, chunksDeleted: 0, pending: 0 }
  const maxDocs = Math.max(1, deps.maxEmbedDocsPerRun ?? 150)
  if (deps.embed && deps.vectors) {
    embeddings.skipped = false
    const index: EmbedIndex = (await readJson<EmbedIndex>(deps, EMBED_INDEX_KEY)) ?? { version: 1, docs: {} }
    try {
      const liveByPath = new Map(rows.filter(r => r.path.toLowerCase().endsWith('.md')).map(r => [r.path, r]))

      // Removed or renamed documents → drop their vectors
      for (const [path, entry] of Object.entries(index.docs)) {
        if (liveByPath.has(path)) continue
        await deps.vectors.deleteByIds(chunkIds(path, entry.chunks))
        embeddings.docsRemoved++
        embeddings.chunksDeleted += entry.chunks
        delete index.docs[path]
      }

      // Changed documents → re-embed. Chunks of consecutive documents are packed into shared
      // AI calls; a document is recorded in the index only once its last chunk is upserted, and
      // the index is checkpointed after every batch so an interrupted run resumes cleanly.
      type Pending = { path: string; etag: string; doc: ParsedVaultDoc; chunks: { heading: string; text: string }[] }
      const queue: Pending[] = []
      for (const [path, row] of liveByPath) {
        const prev = index.docs[path]
        if (prev && prev.etag === row.etag) continue
        const doc = docs.get(path)
        if (!doc) continue
        if (doc.graphWeight === 'skip' || path.startsWith(`${REPORT_FOLDER}/`)) {
          // Excluded now — drop whatever an earlier night embedded for it
          if (prev) { await deps.vectors.deleteByIds(chunkIds(path, prev.chunks)); embeddings.chunksDeleted += prev.chunks; delete index.docs[path] }
          continue
        }
        const chunks = chunkDocument(doc)
        if (chunks.length === 0) { index.docs[path] = { etag: row.etag, chunks: 0 }; embeddings.docsEmbedded++; continue }
        queue.push({ path, etag: row.etag, doc, chunks })
      }

      const maxBatches = Math.max(1, deps.maxEmbedBatchesPerRun ?? 22)
      let batches = 0
      let cursor = 0 // documents fully handled so far
      while (cursor < queue.length && embeddings.docsEmbedded < maxDocs && batches < maxBatches) {
        // Take whole documents until the batch is full (a document never spans two batches)
        const items: { d: Pending; i: number }[] = []
        let end = cursor
        while (end < queue.length && end - cursor < maxDocs - embeddings.docsEmbedded && items.length + queue[end].chunks.length <= EMBED_BATCH) {
          queue[end].chunks.forEach((_, i) => items.push({ d: queue[end], i }))
          end++
        }
        if (end === cursor) { // a single document larger than one batch: send it alone, in slices
          const d = queue[cursor]
          for (let i = 0; i < d.chunks.length; i += EMBED_BATCH) {
            const slice = d.chunks.slice(i, i + EMBED_BATCH)
            const vectors = await deps.embed(slice.map(c => c.text))
            await deps.vectors.upsert(slice.map((c, j) => ({ id: chunkId(d.path, i + j), values: vectors[j], metadata: { path: d.path, docId: d.doc.id, heading: c.heading.slice(0, 200) } })))
            embeddings.chunksUpserted += slice.length
            batches++
          }
          end = cursor + 1
        } else {
          const vectors = await deps.embed(items.map(it => it.d.chunks[it.i].text))
          await deps.vectors.upsert(items.map((it, j) => ({ id: chunkId(it.d.path, it.i), values: vectors[j], metadata: { path: it.d.path, docId: it.d.doc.id, heading: it.d.chunks[it.i].heading.slice(0, 200) } })))
          embeddings.chunksUpserted += items.length
          batches++
        }
        for (let k = cursor; k < end; k++) {
          const d = queue[k]
          const prev = index.docs[d.path]
          if (prev && prev.chunks > d.chunks.length) await deps.vectors.deleteByIds(chunkIds(d.path, prev.chunks).slice(d.chunks.length))
          index.docs[d.path] = { etag: d.etag, chunks: d.chunks.length }
          embeddings.docsEmbedded++
        }
        cursor = end
        await writeJson(deps, EMBED_INDEX_KEY, index)
      }
      embeddings.pending = queue.length - cursor
    } catch (e) {
      // The lint report is already written; an embedding outage must not undo the night's work.
      // Documents processed so far are recorded, the rest are retried tomorrow.
      embeddings.error = e instanceof Error ? e.message : String(e)
      log(`[nightly] embeddings aborted: ${embeddings.error}`)
    }
    await writeJson(deps, EMBED_INDEX_KEY, index)
    log(`[nightly] embeddings: ${embeddings.docsEmbedded} docs / ${embeddings.chunksUpserted} chunks upserted, ${embeddings.docsRemoved} docs removed, ${embeddings.pending} left for the next run`)
  } else {
    log('[nightly] embeddings skipped (no AI / Vectorize binding)')
  }

  const result: NightlyResult = {
    startedAt: now,
    durationMs: Date.now() - wallStart,
    trigger,
    docs: docs.size,
    lint: { reportPath, errors: report.summary.bySeverity.error, warnings: report.summary.bySeverity.warn, skipped: report.skipped.map(s => s.rule), prunedReports },
    embeddings,
  }
  // Append to the run log (bounded); a failure here must not fail the run
  try {
    const runs = (await readJson<NightlyResult[]>(deps, BATCH_LOG_KEY)) ?? []
    runs.push(result)
    await writeJson(deps, BATCH_LOG_KEY, runs.slice(-BATCH_LOG_MAX))
  } catch (e) {
    log(`[nightly] could not write the run log: ${e instanceof Error ? e.message : String(e)}`)
  }
  return result
}

/** Coverage of the vector index plus the recent run log — no embedding work is done here. */
export async function batchStatus(deps: SyncDeps): Promise<BatchStatus> {
  const rows = await listLiveRows(deps.meta)
  const index = (await readJson<EmbedIndex>(deps, EMBED_INDEX_KEY)) ?? { version: 1, docs: {} }
  const runs = (await readJson<NightlyResult[]>(deps, BATCH_LOG_KEY)) ?? []
  let totalDocs = 0, embeddedDocs = 0
  for (const row of rows) {
    if (!row.path.toLowerCase().endsWith('.md') || row.path.startsWith(`${REPORT_FOLDER}/`)) continue
    totalDocs++
    if (index.docs[row.path]?.etag === row.etag) embeddedDocs++
  }
  return { totalDocs, embeddedDocs, pendingDocs: totalDocs - embeddedDocs, runs }
}

// ── Chunking / ids ───────────────────────────────────────────────────────────

export function chunkDocument(doc: ParsedVaultDoc): { heading: string; text: string }[] {
  const title = doc.title
  const chunks: { heading: string; text: string }[] = []
  for (const s of doc.sections) {
    const body = s.body.trim()
    if (body.length < CHUNK_MIN_CHARS) continue
    const head = s.heading === '(intro)' ? title : `${title} › ${s.heading}`
    chunks.push({ heading: s.heading, text: `${head}\n\n${body}`.slice(0, CHUNK_MAX_CHARS) })
  }
  if (chunks.length === 0 && doc.body.trim().length >= CHUNK_MIN_CHARS) {
    chunks.push({ heading: '(intro)', text: `${title}\n\n${doc.body.trim()}`.slice(0, CHUNK_MAX_CHARS) })
  }
  return chunks
}

/** Vectorize ids are capped at 64 bytes; paths are not, so ids hash the path. */
export function chunkId(path: string, index: number): string {
  return `${fnv1a(path)}:${index}`
}

export function chunkIds(path: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => chunkId(path, i))
}

function fnv1a(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ (c * 31), 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

// ── Search ───────────────────────────────────────────────────────────────────

export interface SearchHit { path: string; docId: string; heading: string; score: number }

export interface VectorQuery {
  query(values: number[], topK: number): Promise<{ id: string; score: number; metadata?: Record<string, unknown> }[]>
}

export async function semanticSearch(
  embed: (texts: string[]) => Promise<number[][]>,
  vectors: VectorQuery,
  query: string,
  topK: number,
): Promise<SearchHit[]> {
  const q = query.trim()
  if (!q) return []
  const [vector] = await embed([q])
  const matches = await vectors.query(vector, Math.min(Math.max(topK, 1), 50))
  return matches.map(m => ({
    path: String(m.metadata?.path ?? ''),
    docId: String(m.metadata?.docId ?? ''),
    heading: String(m.metadata?.heading ?? ''),
    score: m.score,
  })).filter(h => h.path)
}
