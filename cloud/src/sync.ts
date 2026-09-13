/**
 * Team vault sync — the protocol, independent of Cloudflare bindings.
 *
 * The vault lives in an object store (R2) as plain files; a small table (D1) records one row per
 * path with a content hash, the client's mtime, an author and a change sequence number. Clients
 * push with `If-Match` on the hash they last saw and pull by asking for everything after the
 * last sequence number they processed. Deletions are tombstones so late clients hear about them.
 *
 * Everything here talks to the two small interfaces below, so the whole protocol is unit-tested
 * against in-memory fakes and the Cloudflare adapter (index.ts) stays thin.
 */

import { archiveVersion, keepsHistory } from './history.js'

export interface FileRow {
  path: string
  etag: string
  size: number
  mtime: number
  author: string
  /** Stable identity of the saver: OAuth sub, 'service' for the team token, '' when unknown (legacy rows). */
  authorSub: string
  deleted: boolean
  seq: number
  updatedAt: number
}

/** Internal bookkeeping prefix (snapshot, history, member config): never a vault path. */
export const SYSTEM_PREFIX = '_system'

export interface MetaStore {
  get(path: string): Promise<FileRow | null>
  /** Rows with seq > since, ascending by seq, at most `limit`. */
  listSince(since: number, limit: number): Promise<FileRow[]>
  /** Atomically allocate the next seq and upsert the row with it. Returns the stored row. */
  upsert(row: Omit<FileRow, 'seq'>): Promise<FileRow>
  /** Current highest seq (0 when empty). */
  head(): Promise<number>
  /** Identity of this database instance; changes when the vault is wiped and re-created. */
  generation(): Promise<number>
}

export interface BlobStore {
  get(path: string): Promise<Uint8Array | null>
  put(path: string, body: Uint8Array): Promise<void>
  delete(path: string): Promise<void>
  /** Keys under a prefix (all of them — callers keep prefixes narrow). */
  list(prefix: string): Promise<{ key: string; size: number }[]>
}

export interface SyncDeps {
  meta: MetaStore
  blobs: BlobStore
  maxFileBytes: number
  now?: () => number
}

export type SyncResult =
  | { status: 200 | 201 | 204; body?: unknown; headers?: Record<string, string>; bytes?: Uint8Array }
  | { status: 400 | 403 | 404 | 409 | 413; body: { error: string; current?: FileRow | null } }

export const MANIFEST_PAGE = 500

// ── Path rules ───────────────────────────────────────────────────────────────

/**
 * A vault path is relative, forward-slashed, has no empty / dot / dot-dot segments and stays
 * out of dot-folders/files (`.strata-sync/`, `.obsidian/`, caches) — those never leave a client,
 * the same rule the desktop sync engine applies. Returns the normalised path or null.
 */
export function normalizeVaultPath(raw: string | null | undefined): string | null {
  if (!raw) return null
  const p = raw.replace(/\\/g, '/').replace(/^\/+/, '')
  if (p.length === 0 || p.length > 1024) return null
  // Control characters never belong in a file name; spaces and unicode are normal in a vault.
  // U+FFFD means a client decoded its own bytes wrongly — the name is already garbage.
  if (/[\u0000-\u001f\u007f\ufffd]/.test(p)) return null
  const segments = p.split('/')
  for (const s of segments) {
    if (s === '' || s.startsWith('.')) return null
  }
  // The server's own bookkeeping lives under _system/ and is written through the blob store
  // directly; a client that could address it would read the vault snapshot (every document,
  // personal ones included) or forge version history.
  if (segments[0] === SYSTEM_PREFIX) return null
  return p
}

// ── Hashing ──────────────────────────────────────────────────────────────────

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Operations ───────────────────────────────────────────────────────────────

export async function getManifest(deps: SyncDeps, since: number): Promise<SyncResult> {
  if (!Number.isFinite(since) || since < 0) return { status: 400, body: { error: 'since must be a non-negative integer' } }
  const rows = await deps.meta.listSince(Math.floor(since), MANIFEST_PAGE)
  const head = await deps.meta.head()
  const generation = await deps.meta.generation()
  // `next` lets the client page when a burst produced more than one page of changes.
  const next = rows.length === MANIFEST_PAGE ? rows[rows.length - 1].seq : null
  return { status: 200, body: { head, generation, next, files: rows } }
}

export async function getFile(deps: SyncDeps, rawPath: string | null): Promise<SyncResult> {
  const path = normalizeVaultPath(rawPath)
  if (!path) return { status: 400, body: { error: 'invalid path' } }
  const row = await deps.meta.get(path)
  if (!row || row.deleted) return { status: 404, body: { error: 'not found' } }
  const bytes = await deps.blobs.get(path)
  if (!bytes) return { status: 404, body: { error: 'content missing' } }
  return {
    status: 200,
    bytes,
    headers: {
      'ETag': `"${row.etag}"`,
      'X-Mtime': String(row.mtime),
      'X-Author': encodeURIComponent(row.author),
      'X-Seq': String(row.seq),
    },
  }
}

export interface PutInput {
  path: string | null
  body: Uint8Array
  /** Hash the client believes the server has (`If-Match`). Undefined = no precondition. */
  ifMatch?: string
  /** The file must not exist yet (`If-None-Match: *`). */
  createOnly?: boolean
  mtime: number
  author: string
  /** Stable identity of the saver (see FileRow.authorSub); '' when the caller has none. */
  authorSub?: string
}

/**
 * Create or replace a file.
 *   201 created, 200 replaced, 204 identical content already stored (no new seq),
 *   409 the server copy is not what the client last saw (body carries the current row).
 */
export async function putFile(deps: SyncDeps, input: PutInput): Promise<SyncResult> {
  const path = normalizeVaultPath(input.path)
  if (!path) return { status: 400, body: { error: 'invalid path' } }
  if (input.body.byteLength > deps.maxFileBytes) return { status: 413, body: { error: `file larger than ${deps.maxFileBytes} bytes` } }
  if (!Number.isFinite(input.mtime) || input.mtime <= 0) return { status: 400, body: { error: 'X-Mtime header required (ms since epoch)' } }

  const current = await deps.meta.get(path)
  const live = current && !current.deleted ? current : null

  if (input.createOnly && live) return { status: 409, body: { error: 'already exists', current } }
  if (input.ifMatch !== undefined && (!live || live.etag !== input.ifMatch)) return { status: 409, body: { error: 'etag mismatch', current } }

  const etag = await sha256Hex(input.body)
  if (live && live.etag === etag) {
    return { status: 204, headers: { 'ETag': `"${etag}"`, 'X-Seq': String(live.seq) } }
  }

  // The replaced version goes to history first so "what did we believe before" stays answerable
  if (live && keepsHistory(path)) {
    const old = await deps.blobs.get(path)
    if (old) await archiveVersion(deps.blobs, live, old).catch(e => console.error('[history] archive failed', path, e))
  }
  await deps.blobs.put(path, input.body)
  const row = await deps.meta.upsert({
    path, etag, size: input.body.byteLength, mtime: Math.floor(input.mtime),
    author: input.author.slice(0, 80), authorSub: (input.authorSub ?? '').slice(0, 120), deleted: false, updatedAt: (deps.now ?? Date.now)(),
  })
  return { status: live ? 200 : 201, body: row, headers: { 'ETag': `"${etag}"`, 'X-Seq': String(row.seq) } }
}

export async function deleteFile(deps: SyncDeps, rawPath: string | null, ifMatch: string | undefined, author: string, authorSub = ''): Promise<SyncResult> {
  const path = normalizeVaultPath(rawPath)
  if (!path) return { status: 400, body: { error: 'invalid path' } }
  const current = await deps.meta.get(path)
  if (!current || current.deleted) return { status: 404, body: { error: 'not found' } }
  if (ifMatch !== undefined && current.etag !== ifMatch) return { status: 409, body: { error: 'etag mismatch', current } }

  if (keepsHistory(path)) {
    const old = await deps.blobs.get(path)
    if (old) await archiveVersion(deps.blobs, current, old).catch(e => console.error('[history] archive failed', path, e))
  }
  await deps.blobs.delete(path)
  const row = await deps.meta.upsert({
    path, etag: current.etag, size: 0, mtime: current.mtime, author: author.slice(0, 80), authorSub: authorSub.slice(0, 120),
    deleted: true, updatedAt: (deps.now ?? Date.now)(),
  })
  return { status: 200, body: row }
}

/** `If-Match` value without weak prefix or quotes; undefined when absent or `*`. */
export function parseIfMatch(header: string | null): string | undefined {
  if (header === null) return undefined
  const v = header.trim()
  if (v === '*' || v === '') return undefined
  return v.replace(/^W\//, '').replace(/^"|"$/g, '')
}
