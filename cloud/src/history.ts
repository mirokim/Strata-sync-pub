/**
 * Version history — how a belief changed, not just what it is now.
 *
 * Every time a markdown document is replaced or deleted through the sync protocol, the version
 * being replaced is copied to `_system/history/<path>/<updatedAt>.<etag>.<author>` before the
 * new bytes land. The prefix is outside the manifest (no D1 row, ignored by the R2 event bridge),
 * so clients never sync it; the app and the MCP tools read it through `listVersions`,
 * `readVersion` and `diffLines`. The newest HISTORY_KEEP versions per document survive.
 */
import type { BlobStore, FileRow } from './sync.js'

export const HISTORY_PREFIX = '_system/history/'
export const HISTORY_KEEP = 20
/** Diff output is for people and prompts, not machines: keep it readable. */
const DIFF_MAX_LINES = 2_000

export interface Version { path: string; at: number; etag: string; author: string; size: number; key: string }

export function historyKey(path: string, at: number, etag: string, author: string): string {
  return `${HISTORY_PREFIX}${path}/${String(Math.max(0, Math.floor(at))).padStart(13, '0')}.${etag}.${encodeURIComponent(author.slice(0, 80))}`
}

export function parseHistoryKey(key: string, size = 0): Version | null {
  if (!key.startsWith(HISTORY_PREFIX)) return null
  const rest = key.slice(HISTORY_PREFIX.length)
  const slash = rest.lastIndexOf('/')
  if (slash < 0) return null
  const m = /^(\d{13})\.([0-9a-f]{64})\.(.*)$/.exec(rest.slice(slash + 1))
  if (!m) return null
  let author = ''
  try { author = decodeURIComponent(m[3]) } catch { author = m[3] }
  return { path: rest.slice(0, slash), at: Number(m[1]), etag: m[2], author, size, key }
}

/** Only documents get history; images and other binaries would just fill the bucket. */
export function keepsHistory(path: string): boolean {
  return /\.md$/i.test(path) && !path.startsWith('_system/')
}

/**
 * Archive the version described by `row` (its current bytes) before it is overwritten or
 * deleted, then drop versions beyond HISTORY_KEEP. Failures here must never block the save.
 */
export async function archiveVersion(blobs: BlobStore, row: Pick<FileRow, 'path' | 'etag' | 'author' | 'updatedAt'>, bytes: Uint8Array): Promise<void> {
  if (!keepsHistory(row.path)) return
  await blobs.put(historyKey(row.path, row.updatedAt, row.etag, row.author), bytes)
  const versions = await listVersions(blobs, row.path)
  for (const v of versions.slice(HISTORY_KEEP)) await blobs.delete(v.key)
}

/** Archived versions of a document, newest first. The live version is not among them. */
export async function listVersions(blobs: BlobStore, path: string): Promise<Version[]> {
  const objects = await blobs.list(`${HISTORY_PREFIX}${path}/`)
  return objects.map(o => parseHistoryKey(o.key, o.size)).filter((v): v is Version => v !== null).sort((a, b) => b.at - a.at || (a.etag < b.etag ? 1 : -1))
}

export async function readVersion(blobs: BlobStore, path: string, etag: string): Promise<{ version: Version; bytes: Uint8Array } | null> {
  const version = (await listVersions(blobs, path)).find(v => v.etag === etag)
  if (!version) return null
  const bytes = await blobs.get(version.key)
  return bytes ? { version, bytes } : null
}

/** The archived version just before the live one, i.e. what the last save replaced. */
export async function previousVersion(blobs: BlobStore, path: string, liveEtag: string): Promise<{ version: Version; bytes: Uint8Array } | null> {
  const version = (await listVersions(blobs, path)).find(v => v.etag !== liveEtag)
  if (!version) return null
  const bytes = await blobs.get(version.key)
  return bytes ? { version, bytes } : null
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export interface DiffStats { added: number; removed: number; unchanged: number }

/**
 * Line diff in unified style with `context` lines around each change. LCS over lines, which is
 * fine for documents (a few hundred lines); inputs beyond DIFF_MAX_LINES are compared by their
 * first lines only and the result says so.
 */
export function diffLines(before: string, after: string, context = 2): { text: string; stats: DiffStats } {
  let a = before.split('\n'), b = after.split('\n')
  let truncated = false
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) { a = a.slice(0, DIFF_MAX_LINES); b = b.slice(0, DIFF_MAX_LINES); truncated = true }
  const n = a.length, m = b.length
  // lcs[i][j] = length of LCS of a[i:], b[j:]
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
  }
  type Op = { kind: ' ' | '-' | '+'; line: string }
  const ops: Op[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ kind: ' ', line: a[i] }); i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { ops.push({ kind: '-', line: a[i] }); i++ }
    else { ops.push({ kind: '+', line: b[j] }); j++ }
  }
  while (i < n) ops.push({ kind: '-', line: a[i++] })
  while (j < m) ops.push({ kind: '+', line: b[j++] })

  const stats: DiffStats = { added: 0, removed: 0, unchanged: 0 }
  for (const op of ops) { if (op.kind === '+') stats.added++; else if (op.kind === '-') stats.removed++; else stats.unchanged++ }
  if (stats.added === 0 && stats.removed === 0) return { text: truncated ? '(no difference in the first 2000 lines)' : '(no difference)', stats }

  // Keep only changed lines plus `context` unchanged lines around them, split into hunks
  const keep = new Array<boolean>(ops.length).fill(false)
  ops.forEach((op, k) => { if (op.kind !== ' ') for (let d = -context; d <= context; d++) if (k + d >= 0 && k + d < ops.length) keep[k + d] = true })
  const out: string[] = []
  let inHunk = false
  ops.forEach((op, k) => {
    if (!keep[k]) { if (inHunk) { out.push('@@'); inHunk = false }; return }
    inHunk = true
    out.push(`${op.kind} ${op.line}`)
  })
  if (truncated) out.push('@@ (compared the first 2000 lines only)')
  return { text: out.join('\n'), stats }
}
