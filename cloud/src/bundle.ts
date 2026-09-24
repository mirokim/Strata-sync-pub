/**
 * Docs bundle — every live team document with its text, as one gzip object in R2, so a browser
 * with an empty mirror downloads the vault in one request instead of paging `/v1/docs`
 * (which reads each document from R2 separately: ~15 s per 500 documents).
 *
 * The bundle is a starting point, not the truth: it carries the sequence head it covers, and the
 * client continues with `/v1/docs?after=<head>` for anything newer. Personal documents are never
 * in it (it is shared by every viewer); the owner fetches those with `/v1/docs?personal=1`.
 *
 * Rebuilding is incremental: documents whose etag did not move are taken from the previous
 * bundle, the rest are read from R2 — at most `maxReads` per build (the invocation's subrequest
 * budget). When more changed than that, the bundle's head stops just before the first unread
 * row, so the client's delta picks the rest up and the next build moves further.
 */
import { listLiveRows } from './nightly.js'
import { isPersonalPath } from './personal.js'
import type { FileRow, SyncDeps } from './sync.js'

export const DOCS_BUNDLE_KEY = '_system/docs-bundle'
const BUNDLE_VERSION = 1
const BATCH = 100

export type BundleDoc = FileRow & { content: string | null }

export interface DocsBundle {
  version: number
  /** Every row with seq ≤ head is reflected (live ones present, deleted ones absent). */
  head: number
  generation: number
  docs: BundleDoc[]
}

export interface BundleOptions {
  /** R2 reads one build may spend (default 800). */
  maxReads?: number
  /** A stored bundle this many writes behind is still served as is, and refreshed in the background (default 300). */
  serveStaleWithin?: number
  /** Called with a refresh to run after the response (ctx.waitUntil); without it a stale bundle is rebuilt inline. */
  background?: (work: Promise<unknown>) => void
}

const dec = new TextDecoder()
const enc = new TextEncoder()

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Response(bytes as BodyInit).body!.pipeThrough(stream))
  return new Uint8Array(await out.arrayBuffer())
}

export const gzip = (bytes: Uint8Array) => pipe(bytes, new CompressionStream('gzip'))
export const gunzip = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream('gzip'))

export async function readBundle(raw: Uint8Array): Promise<DocsBundle | null> {
  try {
    const b = JSON.parse(dec.decode(await gunzip(raw))) as DocsBundle
    return b.version === BUNDLE_VERSION && Array.isArray(b.docs) ? b : null
  } catch { return null }
}

/**
 * The gzip bundle to hand a client: the stored one when it is recent enough, otherwise a fresh
 * build (stored for the next caller). Returns the bytes as stored — the client decompresses.
 */
export async function serveBundle(deps: SyncDeps, opts: BundleOptions = {}): Promise<Uint8Array> {
  const [head, generation, raw] = await Promise.all([deps.meta.head(), deps.meta.generation(), deps.blobs.get(DOCS_BUNDLE_KEY)])
  const stored = raw ? await readBundle(raw) : null
  if (raw && stored && stored.generation === generation) {
    const behind = head - stored.head
    if (behind === 0) return raw
    if (behind <= (opts.serveStaleWithin ?? 300) && opts.background) {
      opts.background(buildBundle(deps, stored, opts).catch(e => console.error('[bundle] refresh failed', e)))
      return raw
    }
  }
  const { bytes } = await buildBundle(deps, stored && stored.generation === generation ? stored : null, opts)
  return bytes
}

/** Build from the live rows and a previous bundle (reused where the etag matches), then store it. */
export async function buildBundle(deps: SyncDeps, previous: DocsBundle | null, opts: BundleOptions = {}): Promise<{ bundle: DocsBundle; bytes: Uint8Array; read: number; partial: boolean }> {
  const maxReads = opts.maxReads ?? 800
  // Head before the listing: a write landing in between is at most re-delivered by the delta
  const [head, generation] = await Promise.all([deps.meta.head(), deps.meta.generation()])
  const rows = (await listLiveRows(deps.meta)).filter(r => !isPersonalPath(r.path) && r.seq <= head)
  const known = new Map((previous?.docs ?? []).map(d => [d.path, d]))

  const docs: BundleDoc[] = []
  const pending: FileRow[] = []
  for (const row of rows) {
    const isMd = row.path.toLowerCase().endsWith('.md')
    const prev = known.get(row.path)
    if (!isMd) docs.push({ ...row, content: null })
    else if (prev && prev.etag === row.etag && prev.content != null) docs.push({ ...row, content: prev.content })
    else pending.push(row)
  }
  pending.sort((a, b) => a.seq - b.seq)
  const reads = pending.slice(0, maxReads)
  for (let i = 0; i < reads.length; i += BATCH) {
    const part = await Promise.all(reads.slice(i, i + BATCH).map(async row => ({ row, bytes: await deps.blobs.get(row.path) })))
    for (const { row, bytes } of part) if (bytes) docs.push({ ...row, content: dec.decode(bytes) })
  }
  const partial = pending.length > reads.length
  // Unread rows are left out, and the head stops before the first of them so the delta brings them
  const bundleHead = partial ? pending[reads.length].seq - 1 : head
  docs.sort((a, b) => a.seq - b.seq)

  const bundle: DocsBundle = { version: BUNDLE_VERSION, head: bundleHead, generation, docs }
  const bytes = await gzip(enc.encode(JSON.stringify(bundle)))
  await deps.blobs.put(DOCS_BUNDLE_KEY, bytes)
  console.log(`[bundle] built head ${bundleHead}/${head}: ${docs.length} docs, ${reads.length} read, ${(bytes.byteLength / 1048576).toFixed(2)} MB${partial ? ', partial' : ''}`)
  return { bundle, bytes, read: reads.length, partial }
}
