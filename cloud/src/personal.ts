/**
 * Personal documents — thinking that is not ready to be shared. From its owner's point of view a
 * personal document is an ordinary document: it lives in its folder, links to and from team
 * documents, shows up in the owner's graph, search and recall. To everyone else it does not exist:
 * the server drops it from every listing, search, lint and index that is not the owner's.
 *
 * Storage: `_personal/<owner>/<path>` in the same bucket and table. Only the prefix differs, so
 * sync, history, image documents and conflicts all work unchanged; the app strips the prefix for
 * the owner (src/web/remoteVault.ts) and the MCP tools filter with `canSee`. Owners are identified
 * by the OAuth `sub` — the shared team token has no owner and therefore no personal documents.
 *
 * Making a document personal again (withdrawing it from the team) is only allowed while nobody
 * else has ever saved it: once a colleague has written into it, it is team knowledge.
 */
import { deleteFile, putFile, normalizeVaultPath, type FileRow, type SyncDeps, type SyncResult } from './sync.js'
import { listVersions } from './history.js'

export const PERSONAL_PREFIX = '_personal/'

export interface Viewer { sub: string; service?: boolean }

/** Owner segment of a path: the OAuth sub, made safe for a path. */
export function ownerSegment(sub: string): string {
  return sub.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'unknown'
}

export function personalRoot(viewer: Viewer): string | null {
  if (viewer.service || !viewer.sub) return null
  return `${PERSONAL_PREFIX}${ownerSegment(viewer.sub)}/`
}

export function isPersonalPath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(PERSONAL_PREFIX)
}

/** `_personal/<owner>/design/A.md` → { owner, path: 'design/A.md' }; null for team paths. */
export function splitPersonal(path: string): { owner: string; path: string } | null {
  const p = path.replace(/\\/g, '/')
  if (!p.startsWith(PERSONAL_PREFIX)) return null
  const rest = p.slice(PERSONAL_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  return { owner: rest.slice(0, slash), path: rest.slice(slash + 1) }
}

/** Whether a viewer may see a path: team paths always, personal ones only for their owner. */
export function canSee(path: string, viewer?: Viewer | null): boolean {
  const split = splitPersonal(path)
  if (!split) return true
  if (!viewer || viewer.service) return false
  return split.owner === ownerSegment(viewer.sub)
}

/** The personal path for a viewer's document; null when the viewer cannot own documents. */
export function toPersonalPath(viewer: Viewer, path: string): string | null {
  const root = personalRoot(viewer)
  const clean = normalizeVaultPath(path)
  if (!root || !clean || isPersonalPath(clean)) return null
  return root + clean
}

export function visibleRows<T extends { path: string }>(rows: T[], viewer?: Viewer | null): T[] {
  return rows.filter(r => canSee(r.path, viewer))
}

export interface VisibilityInput { path: string; personal: boolean; viewer: Viewer; author: string }

/**
 * Move a document between the team space and the viewer's personal space. Returns the new row.
 * 403 when the viewer has no personal space, does not own the document, or when others have
 * saved the document; 409 when the destination already exists.
 */
export async function setVisibility(deps: SyncDeps, input: VisibilityInput): Promise<SyncResult> {
  const root = personalRoot(input.viewer)
  if (!root) return { status: 400, body: { error: 'personal documents need a signed-in user (the team token has no owner)' } }
  const src = normalizeVaultPath(input.path)
  if (!src) return { status: 400, body: { error: 'invalid path' } }
  if (!canSee(src, input.viewer)) return { status: 404, body: { error: 'not found' } }
  const split = splitPersonal(src)
  let dest: string
  if (input.personal) {
    if (split) return { status: 400, body: { error: 'already personal' } }
    if (!/\.md$/i.test(src)) return { status: 400, body: { error: 'only documents can be made personal' } }
    dest = root + src
  } else {
    if (!split) return { status: 400, body: { error: 'already a team document' } }
    dest = split.path
  }
  const row = await deps.meta.get(src)
  if (!row || row.deleted) return { status: 404, body: { error: 'not found' } }
  if (input.personal) {
    // Withdrawing from the team: only while every version so far is the viewer's own
    const others = new Set<string>()
    if (row.author && row.author !== input.author) others.add(row.author)
    for (const v of await listVersions(deps.blobs, src)) if (v.author && v.author !== input.author) others.add(v.author)
    if (others.size > 0) return { status: 403, body: { error: `others have saved this document (${[...others].join(', ')}); it stays with the team` } }
  }
  const existing = await deps.meta.get(dest)
  if (existing && !existing.deleted) return { status: 409, body: { error: `a document already exists at ${dest}`, current: existing } }
  const bytes = await deps.blobs.get(src)
  if (!bytes) return { status: 404, body: { error: 'content missing' } }
  const put = await putFile(deps, { path: dest, body: bytes, mtime: row.mtime, author: input.author, createOnly: true })
  if (put.status !== 201) return put
  const del = await deleteFile(deps, src, row.etag, input.author)
  if (del.status !== 200) return del
  return { status: 200, body: { from: src, path: dest, row: put.body as FileRow, personal: input.personal } }
}
