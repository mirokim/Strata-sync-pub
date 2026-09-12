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
import { listVersions, moveHistory } from './history.js'

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
  if (slash <= 0 || slash === rest.length - 1) return null
  return { owner: rest.slice(0, slash), path: rest.slice(slash + 1) }
}

/**
 * Whether a viewer may see a path: team paths always, personal ones only for their owner. The
 * personal root itself and an owner folder without a document are nobody's (listing them would
 * enumerate other people's history).
 */
export function canSee(path: string, viewer?: Viewer | null): boolean {
  const p = path.replace(/\\/g, '/').replace(/^\/+/, '')
  if (p === PERSONAL_PREFIX.slice(0, -1) || p.startsWith(PERSONAL_PREFIX)) {
    const split = splitPersonal(p)
    if (!split || !viewer || viewer.service) return false
    return split.owner === ownerSegment(viewer.sub)
  }
  return true
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

/**
 * Whether `text` repeats a stretch of one of the viewer's personal documents. Used before
 * anything team-visible is written on the viewer's behalf (proposals, member memory notes) so a
 * routine instruction cannot make an agent carry private thinking into the shared space.
 * Returns the offending document's path, or null. Windows of LEAK_WINDOW characters.
 */
export const LEAK_WINDOW = 80
export async function leaksPersonal(deps: Pick<SyncDeps, 'meta' | 'blobs'>, viewer: Viewer | undefined, text: string): Promise<string | null> {
  const root = viewer ? personalRoot(viewer) : null
  if (!root) return null
  const probe = text.replace(/\s+/g, ' ').trim()
  if (probe.length < LEAK_WINDOW) return null
  const rows = (await deps.meta.listSince(0, 100_000)).filter(r => !r.deleted && r.path.startsWith(root) && /\.md$/i.test(r.path))
  const dec = new TextDecoder()
  for (const r of rows) {
    const bytes = await deps.blobs.get(r.path)
    if (!bytes) continue
    const body = dec.decode(bytes).replace(/\s+/g, ' ')
    if (body.length < LEAK_WINDOW) continue
    for (let i = 0; i + LEAK_WINDOW <= probe.length; i += Math.floor(LEAK_WINDOW / 2)) {
      if (body.includes(probe.slice(i, i + LEAK_WINDOW))) return r.path
    }
  }
  return null
}

export interface VisibilityInput { path: string; personal: boolean; viewer: Viewer; author: string }

/** A version counts as the viewer's own only by stable identity, never by the editable display name. */
function savedByViewer(authorSub: string, viewer: Viewer): boolean {
  return authorSub !== '' && authorSub === viewer.sub
}

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
    // Withdrawing from the team: only while every version so far was saved by this very identity
    const others = new Set<string>()
    if (!savedByViewer(row.authorSub, input.viewer)) others.add(row.author || 'unknown')
    for (const v of await listVersions(deps.blobs, src)) if (!savedByViewer(v.authorSub, input.viewer)) others.add(v.author || 'unknown')
    if (others.size > 0) return { status: 403, body: { error: `others have saved this document (${[...others].join(', ')}); it stays with the team` } }
  }
  const existing = await deps.meta.get(dest)
  if (existing && !existing.deleted) return { status: 409, body: { error: `a document already exists at ${dest}`, current: existing } }
  const bytes = await deps.blobs.get(src)
  if (!bytes) return { status: 404, body: { error: 'content missing' } }
  const put = await putFile(deps, { path: dest, body: bytes, mtime: row.mtime, author: input.author, authorSub: input.viewer.sub, createOnly: true })
  if (put.status !== 201) return put
  const del = await deleteFile(deps, src, row.etag, input.author, input.viewer.sub)
  if (del.status !== 200) return del
  // Taking a document back: its team-era versions go with it, so nothing stays readable at the team path
  if (input.personal) await moveHistory(deps.blobs, src, dest).catch(e => console.error('[personal] history move failed', src, e))
  return { status: 200, body: { from: src, path: dest, row: put.body as FileRow, personal: input.personal } }
}
