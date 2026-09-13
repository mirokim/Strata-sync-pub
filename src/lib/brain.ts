/**
 * brain.ts — what the vault knows *around* a document, computed from the loaded documents:
 * resolved links in both directions, AI-member remarks about it, proposals that cite it,
 * documents that share its neighbourhood, and a recency-weighted activity score per document
 * ("where is the team's attention this week") for the graph's heat colouring.
 *
 * Pure functions over LoadedDocument[]; the link index is memoised on the array identity so the
 * panel and the graph do not re-resolve links on every render.
 */
import type { LoadedDocument } from '@/types'
/** Folder holding AI members' memory notes and remarks (_members/<Name>/...). Mirrors cloud/src/members.ts. */
export const MEMBERS_FOLDER = '_members'

export interface LinkIndex {
  out: Map<string, Set<string>>
  in: Map<string, Set<string>>
  byId: Map<string, LoadedDocument>
  /** Ids of documents in system folders (`_agent`, `_members`, dot-folders). */
  system: Set<string>
  /** Per document: its team neighbours (both directions) plus `#tags` — the neighbourhood signature `around()` compares. */
  sig: Map<string, Set<string>>
}

/** `Folder/Doc Name|alias#Heading^block` → `doc name` (Obsidian resolves by basename). */
export function normalizeLinkTarget(raw: string): string {
  let s = raw.normalize('NFC').trim().replace(/\\$/, '')
  const pipe = s.indexOf('|'); if (pipe >= 0) s = s.slice(0, pipe)
  const hash = s.indexOf('#'); if (hash >= 0) s = s.slice(0, hash)
  const caret = s.indexOf('^'); if (caret >= 0) s = s.slice(0, caret)
  const slash = s.lastIndexOf('/'); if (slash >= 0) s = s.slice(slash + 1)
  return s.replace(/\.md$/i, '').trim().toLowerCase()
}

export function docPath(doc: Pick<LoadedDocument, 'folderPath' | 'filename'>): string {
  const folder = (doc.folderPath ?? '').replace(/\\/g, '/')
  return folder ? `${folder}/${doc.filename}` : doc.filename
}

export function docTitle(doc: LoadedDocument): string {
  return doc.title?.trim() || doc.filename.replace(/\.md$/i, '')
}

const isSystemDoc = (doc: LoadedDocument) => (doc.folderPath ?? '').split(/[/\\]/).some(s => s.startsWith('_') || s.startsWith('.'))
const isProposalDoc = (doc: LoadedDocument) => /^_agent(\/|$)/.test((doc.folderPath ?? '').replace(/\\/g, '/'))

let indexCache: { docs: LoadedDocument[]; index: LinkIndex } | null = null

/** Resolved link index; same basename in several folders resolves to the same-folder one first. */
export function buildLinkIndex(docs: LoadedDocument[]): LinkIndex {
  if (indexCache && indexCache.docs === docs) return indexCache.index
  const byName = new Map<string, LoadedDocument[]>()
  const byId = new Map<string, LoadedDocument>()
  for (const d of docs) {
    byId.set(d.id, d)
    const key = d.filename.normalize('NFC').replace(/\.md$/i, '').toLowerCase()
    const bucket = byName.get(key)
    if (bucket) bucket.push(d); else byName.set(key, [d])
  }
  const resolve = (name: string, from: LoadedDocument): LoadedDocument | undefined => {
    const c = (byName.get(name) ?? []).filter(x => x.id !== from.id)
    if (c.length === 0) return undefined
    if (c.length === 1) return c[0]
    // Same folder first; then a team document over a system copy (a remark under _members/
    // mirrors the document's path, so its own [[link]] must not resolve to itself); then the
    // longer shared folder prefix; then the shallower path, for a deterministic pick.
    const fromSegs = (from.folderPath ?? '').toLowerCase().split(/[/\\]+/).filter(Boolean)
    const score = (x: LoadedDocument) => {
      const segs = (x.folderPath ?? '').toLowerCase().split(/[/\\]+/).filter(Boolean)
      let common = 0
      while (common < segs.length && common < fromSegs.length && segs[common] === fromSegs[common]) common++
      const same = segs.length === fromSegs.length && common === segs.length
      return (same ? 1000 : 0) + (isSystemDoc(x) ? 0 : 100) + common * 10 - segs.length
    }
    return [...c].sort((a, b) => score(b) - score(a) || docPath(a).localeCompare(docPath(b)))[0]
  }
  const out = new Map<string, Set<string>>()
  const inn = new Map<string, Set<string>>()
  for (const d of docs) { out.set(d.id, new Set()); inn.set(d.id, new Set()) }
  for (const d of docs) {
    const raw = [...(d.links ?? []), ...d.sections.flatMap(s => s.wikiLinks ?? [])]
    for (const r of raw) {
      if (r.includes('://')) continue
      const target = resolve(normalizeLinkTarget(r), d)
      if (!target || target.id === d.id) continue
      out.get(d.id)!.add(target.id)
      inn.get(target.id)!.add(d.id)
    }
  }
  const system = new Set(docs.filter(isSystemDoc).map(d => d.id))
  const sig = new Map<string, Set<string>>()
  for (const d of docs) {
    if (system.has(d.id)) continue
    const s = new Set<string>()
    for (const id of out.get(d.id)!) if (!system.has(id)) s.add(id)
    for (const id of inn.get(d.id)!) if (!system.has(id)) s.add(id)
    for (const t of d.tags) s.add(`#${t.toLowerCase()}`)
    sig.set(d.id, s)
  }
  const index = { out, in: inn, byId, system, sig }
  indexCache = { docs, index }
  return index
}

export interface Remark { member: string; doc: LoadedDocument; body: string }

/** Frontmatter and the title line stripped — the remark text itself. */
export function remarkBody(raw: string): string {
  const body = raw.replace(/^---[\s\S]*?\n---\r?\n?/, '').replace(/^\s*\n/, '')
  // The title line and the "Saved by … · memory: …" byline are chrome, wherever blank lines put them
  let title = false, byline = false
  const kept = body.split('\n').filter(line => {
    if (!title && /^#\s/.test(line)) { title = true; return false }
    if (!byline && /^Saved by .* · memory: /.test(line)) { byline = true; return false }
    return true
  })
  return kept.join('\n').trim()
}

/** `_members/<Name>/<this document's path>` documents. */
export function remarksFor(docs: LoadedDocument[], doc: LoadedDocument): Remark[] {
  const target = docPath(doc)
  const out: Remark[] = []
  for (const d of docs) {
    const folder = (d.folderPath ?? '').replace(/\\/g, '/')
    if (!folder.startsWith(`${MEMBERS_FOLDER}/`)) continue
    const rest = docPath(d).slice(MEMBERS_FOLDER.length + 1)
    const slash = rest.indexOf('/')
    if (slash < 0) continue
    if (rest.slice(slash + 1) !== target) continue
    out.push({ member: rest.slice(0, slash), doc: d, body: remarkBody(d.rawContent) })
  }
  return out.sort((a, b) => (b.doc.mtime ?? 0) - (a.doc.mtime ?? 0))
}

export interface Around {
  linkedFrom: LoadedDocument[]
  linksTo: LoadedDocument[]
  proposals: LoadedDocument[]
  similar: { doc: LoadedDocument; score: number; shared: number }[]
  remarks: Remark[]
}

/** Everything the vault knows around one document. */
export function around(docs: LoadedDocument[], doc: LoadedDocument, similarLimit = 6): Around {
  const index = buildLinkIndex(docs)
  const byTitle = (a: LoadedDocument, b: LoadedDocument) => docTitle(a).localeCompare(docTitle(b))
  const ids = (s: Set<string> | undefined) => [...(s ?? [])].map(id => index.byId.get(id)!).filter(Boolean)
  const linkedFromAll = ids(index.in.get(doc.id))
  const linkedFrom = linkedFromAll.filter(d => !index.system.has(d.id)).sort(byTitle)
  const linksTo = ids(index.out.get(doc.id)).filter(d => !index.system.has(d.id)).sort(byTitle)
  const proposals = linkedFromAll.filter(isProposalDoc).sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0))

  // Similar: share of neighbours (both directions) and tags — Jaccard over the precomputed signatures
  const mine = index.sig.get(doc.id) ?? new Set<string>()
  const similar: Around['similar'] = []
  if (mine.size > 0) {
    for (const [id, theirs] of index.sig) {
      if (id === doc.id) continue
      let shared = 0
      for (const x of mine) if (theirs.has(x)) shared++
      if (shared === 0) continue
      const union = mine.size + theirs.size - shared
      similar.push({ doc: index.byId.get(id)!, score: shared / union, shared })
    }
    similar.sort((a, b) => b.score - a.score || b.shared - a.shared || byTitle(a.doc, b.doc))
  }
  return { linkedFrom, linksTo, proposals, similar: similar.slice(0, similarLimit), remarks: remarksFor(docs, doc) }
}

// ── Activity heat ────────────────────────────────────────────────────────────

/** Half-life of attention: an edit a week old counts half as much as one today. */
export const HEAT_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 0..1 per document id: the document's own recent edits, remarks members left on it, and
 * proposals that cite it, each decayed by age. Documents nobody touched score 0.
 */
export function activityHeat(docs: LoadedDocument[], now = Date.now()): Map<string, number> {
  const decay = (mtime: number | undefined) => {
    if (!mtime || mtime > now + 60_000) return 0
    return Math.pow(0.5, (now - mtime) / HEAT_HALF_LIFE_MS)
  }
  const raw = new Map<string, number>()
  const bump = (id: string, v: number) => { if (v > 0) raw.set(id, (raw.get(id) ?? 0) + v) }
  const byPath = new Map<string, LoadedDocument>()
  for (const d of docs) byPath.set(docPath(d), d)
  const index = buildLinkIndex(docs)
  for (const d of docs) {
    const folder = (d.folderPath ?? '').replace(/\\/g, '/')
    if (folder.startsWith(`${MEMBERS_FOLDER}/`)) {
      // A remark warms the document it is about, not itself
      const rest = docPath(d).slice(MEMBERS_FOLDER.length + 1)
      const slash = rest.indexOf('/')
      if (slash < 0) continue
      const target = byPath.get(rest.slice(slash + 1))
      if (target) bump(target.id, 0.6 * decay(d.mtime))
      continue
    }
    if (isProposalDoc(d)) {
      for (const id of index.out.get(d.id) ?? []) bump(id, 0.5 * decay(d.mtime))
      bump(d.id, decay(d.mtime))
      continue
    }
    if (isSystemDoc(d)) continue
    bump(d.id, decay(d.mtime))
  }
  let max = 0
  for (const v of raw.values()) if (v > max) max = v
  const out = new Map<string, number>()
  if (max > 0) for (const [id, v] of raw) out.set(id, Math.min(1, v / max))
  return out
}

/** Cold slate → amber → hot red-orange; sqrt so a little activity is already visible. */
export function heatColor(heat: number): string {
  const h = Math.sqrt(Math.max(0, Math.min(1, heat)))
  const stops: [number, [number, number, number]][] = [[0, [58, 63, 74]], [0.5, [245, 158, 11]], [1, [239, 68, 68]]]
  let a = stops[0], b = stops[stops.length - 1]
  for (let i = 0; i < stops.length - 1; i++) if (h >= stops[i][0] && h <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break }
  const t = b[0] === a[0] ? 0 : (h - a[0]) / (b[0] - a[0])
  const c = a[1].map((x, i) => Math.round(x + (b[1][i] - x) * t))
  return '#' + c.map(x => x.toString(16).padStart(2, '0')).join('')
}
