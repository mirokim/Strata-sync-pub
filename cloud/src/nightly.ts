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

export const SNAPSHOT_KEY = '_system/lint-snapshot.json'
export const EMBED_INDEX_KEY = '_system/embed-index.json'
export const REPORT_FOLDER = '_reports'
export const BOT_AUTHOR = 'strata-bot'
/** Reports older than this are tombstoned each night so the folder does not grow forever. */
export const REPORT_RETENTION_DAYS = 30

/** Section text cap — bge-m3 handles 8k tokens; this keeps one chunk well inside that. */
const CHUNK_MAX_CHARS = 4500
const CHUNK_MIN_CHARS = 30
const EMBED_BATCH = 20

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
}

export interface NightlyResult {
  docs: number
  lint: { reportPath: string; errors: number; warnings: number; skipped: string[]; prunedReports: number }
  embeddings: { skipped: boolean; docsEmbedded: number; chunksUpserted: number; docsRemoved: number; chunksDeleted: number; error?: string }
}

interface EmbedIndex { version: 1; docs: Record<string, { etag: string; chunks: number }> }

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

export async function runNightly(deps: NightlyDeps): Promise<NightlyResult> {
  const now = (deps.now ?? Date.now)()
  const log = deps.log ?? (() => {})
  const rows = await listLiveRows(deps.meta)
  const docs = await loadVaultDocs(deps, rows)
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
  const embeddings: NightlyResult['embeddings'] = { skipped: true, docsEmbedded: 0, chunksUpserted: 0, docsRemoved: 0, chunksDeleted: 0 }
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

      // Changed documents → re-embed
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
        if (prev && prev.chunks > chunks.length) await deps.vectors.deleteByIds(chunkIds(path, prev.chunks).slice(chunks.length))
        for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
          const batch = chunks.slice(i, i + EMBED_BATCH)
          const vectors = await deps.embed(batch.map(c => c.text))
          await deps.vectors.upsert(batch.map((c, j) => ({
            id: chunkId(path, i + j),
            values: vectors[j],
            metadata: { path, docId: doc.id, heading: c.heading.slice(0, 200) },
          })))
          embeddings.chunksUpserted += batch.length
        }
        index.docs[path] = { etag: row.etag, chunks: chunks.length }
        embeddings.docsEmbedded++
      }
    } catch (e) {
      // The lint report is already written; an embedding outage must not undo the night's work.
      // Documents processed so far are recorded, the rest are retried tomorrow.
      embeddings.error = e instanceof Error ? e.message : String(e)
      log(`[nightly] embeddings aborted: ${embeddings.error}`)
    }
    await writeJson(deps, EMBED_INDEX_KEY, index)
    log(`[nightly] embeddings: ${embeddings.docsEmbedded} docs / ${embeddings.chunksUpserted} chunks upserted, ${embeddings.docsRemoved} docs removed`)
  } else {
    log('[nightly] embeddings skipped (no AI / Vectorize binding)')
  }

  return {
    docs: docs.size,
    lint: { reportPath, errors: report.summary.bySeverity.error, warnings: report.summary.bySeverity.warn, skipped: report.skipped.map(s => s.rule), prunedReports },
    embeddings,
  }
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
