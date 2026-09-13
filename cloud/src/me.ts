/**
 * "My desk" — what the vault looks like from one person's side.
 *
 * The same overview serves the web app (GET /v1/me/overview → the My desk panel) and MCP clients
 * (`vault_me`), so an agent can tell its user "3 remarks landed on your documents, 2 proposals cite
 * them — here is the page" with a link that opens the GUI on that view.
 *
 * "Mine" means the latest save is by this identity: the OAuth sub when signed in, otherwise (team
 * token) the display name the caller sent as X-Author. Everything is viewer-filtered, so personal
 * documents of other people never appear.
 */
import type { FileRow } from './sync.js'
import type { VaultView } from './vaultIndex.js'
import { canSee, isPersonalPath, type Viewer } from './personal.js'
import { MEMBERS_FOLDER } from './members.js'
import { isProposalPath } from '../../mcp/src/proposals.js'
import { renderInbox, type InboxView } from './inbox.js'

export interface MeItem { path: string; title: string; author: string; at: string; personal?: true }
export interface MeRemark { member: string; path: string; title: string; at: string }
export interface MeProposal { path: string; title: string; author: string; at: string; cites: string[] }

export interface MeOverview {
  identity: { sub: string; author: string; service: boolean }
  /** Web page for this view, when the deployment knows its web origin */
  guiUrl: string | null
  counts: { authored: number; personal: number; remarks: number; proposalsCitingMine: number; proposalsOpen: number; inboxOpen: number; inboxWaiting: number }
  /** Questions/tasks addressed to me and the ones I sent (see inbox.ts) */
  inbox: InboxView
  /** Team documents whose latest save is mine, newest first */
  authored: MeItem[]
  /** My personal ("only me") documents, newest first */
  personal: MeItem[]
  /** AI-member remarks left on my documents, newest first */
  remarks: MeRemark[]
  /** Open agent proposals that link to one of my documents */
  proposalsCitingMine: MeProposal[]
  /** Latest team changes saved by someone else (what moved while I was away) */
  recentByOthers: MeItem[]
}

export interface MeDeps {
  rows: FileRow[]
  view: VaultView
  viewer: Viewer
  author: string
  webOrigin?: string | null
  now?: number
  inbox?: InboxView
}

const LIMIT = { authored: 15, personal: 10, remarks: 15, proposals: 10, recent: 15 }

/** True when `row` was last saved by this identity. Signed-in users match by sub; the team token only has a name. */
export function isMine(row: Pick<FileRow, 'author' | 'authorSub'>, viewer: Viewer, author: string): boolean {
  if (!viewer.service && viewer.sub) return row.authorSub === viewer.sub || (row.authorSub === '' && !!author && row.author === author)
  return !!author && row.author === author
}

/** First allowed origin that looks like a web deployment (https, not localhost) → the My desk URL. */
export function guiUrlFor(allowedOrigins: string | undefined): string | null {
  if (!allowedOrigins || allowedOrigins.trim() === '*') return null
  const origin = allowedOrigins.split(',').map(s => s.trim()).find(o => /^https:\/\//.test(o) && !/localhost|127\.0\.0\.1/.test(o))
  return origin ? `${origin.replace(/\/+$/, '')}/?view=me` : null
}

const titleOf = (view: VaultView, path: string) => view.docs.get(path)?.title ?? path.replace(/^.*\//, '').replace(/\.md$/i, '')
const item = (view: VaultView, r: FileRow): MeItem => ({ path: r.path, title: titleOf(view, r.path), author: r.author, at: new Date(r.updatedAt).toISOString(), ...(isPersonalPath(r.path) ? { personal: true as const } : {}) })
const newest = (a: FileRow, b: FileRow) => b.updatedAt - a.updatedAt || b.seq - a.seq
const isDoc = (r: FileRow) => !r.deleted && /\.md$/i.test(r.path) && !r.path.split('/').some(s => s.startsWith('.'))
// Bookkeeping folders (`_system`, `_members`, `_reports`, `_agent` …) are not documents people wrote
const isSystemish = (path: string) => path.startsWith('_') || path.startsWith(`${MEMBERS_FOLDER}/`) || isProposalPath(path)

export function meOverview(deps: MeDeps): MeOverview {
  const { view, viewer, author } = deps
  const rows = deps.rows.filter(r => isDoc(r) && canSee(r.path, viewer)).sort(newest)
  const mine = new Set(rows.filter(r => isMine(r, viewer, author)).map(r => r.path))

  const authored = rows.filter(r => mine.has(r.path) && !isPersonalPath(r.path) && !isSystemish(r.path))
  const personal = rows.filter(r => isPersonalPath(r.path))

  // Remarks live at _members/<Name>/<document path>
  const remarks: MeRemark[] = []
  for (const r of rows) {
    if (!r.path.startsWith(`${MEMBERS_FOLDER}/`)) continue
    const [, member, ...rest] = r.path.split('/')
    if (!member || rest.length === 0) continue
    const target = rest.join('/')
    if (!mine.has(target)) continue
    remarks.push({ member, path: target, title: titleOf(view, target), at: new Date(r.updatedAt).toISOString() })
  }

  // Proposals that link to one of my documents (resolved through the vault graph)
  const proposalsOpen = rows.filter(r => isProposalPath(r.path))
  const proposalsCitingMine: MeProposal[] = []
  if (proposalsOpen.length) {
    const graph = view.graph()
    const pathById = new Map<string, string>()
    for (const [path, doc] of view.docs) pathById.set(doc.id, path)
    for (const r of proposalsOpen) {
      const id = view.docs.get(r.path)?.id
      if (!id) continue
      const cites: string[] = []
      for (const target of graph.outRefs.get(id)?.keys() ?? []) {
        const p = pathById.get(target)
        if (p && mine.has(p)) cites.push(titleOf(view, p))
      }
      if (cites.length) proposalsCitingMine.push({ path: r.path, title: titleOf(view, r.path), author: r.author, at: new Date(r.updatedAt).toISOString(), cites })
    }
  }

  const recentByOthers = rows.filter(r => !mine.has(r.path) && !isPersonalPath(r.path) && !isSystemish(r.path))
  const inbox = deps.inbox ?? { forMe: [], sent: [] }

  return {
    identity: { sub: viewer.sub, author, service: Boolean(viewer.service) },
    guiUrl: guiUrlFor(deps.webOrigin ?? undefined),
    counts: { authored: authored.length, personal: personal.length, remarks: remarks.length, proposalsCitingMine: proposalsCitingMine.length, proposalsOpen: proposalsOpen.length, inboxOpen: inbox.forMe.filter(i => i.status === 'open').length, inboxWaiting: inbox.sent.filter(i => i.status === 'open').length },
    inbox,
    authored: authored.slice(0, LIMIT.authored).map(r => item(view, r)),
    personal: personal.slice(0, LIMIT.personal).map(r => item(view, r)),
    remarks: remarks.slice(0, LIMIT.remarks),
    proposalsCitingMine: proposalsCitingMine.slice(0, LIMIT.proposals),
    recentByOthers: recentByOthers.slice(0, LIMIT.recent).map(r => item(view, r)),
  }
}

/** Compact markdown for an MCP client to relay to its user. */
export function renderMeOverview(o: MeOverview): string {
  const who = o.identity.author || o.identity.sub
  const lines = [`# My desk — ${who}`, '']
  if (o.guiUrl) lines.push(`Open in the app: ${o.guiUrl}`, '')
  lines.push(`- Waiting for me (questions/tasks from teammates' agents): ${o.counts.inboxOpen}`, `- I am waiting on: ${o.counts.inboxWaiting}`, `- Documents I saved last: ${o.counts.authored}`, `- Personal documents: ${o.counts.personal}`, `- Member remarks on my documents: ${o.counts.remarks}`, `- Open proposals: ${o.counts.proposalsOpen} (${o.counts.proposalsCitingMine} cite my documents)`, '')
  const section = (title: string, rows: string[]) => { if (rows.length) lines.push(`## ${title}`, ...rows, '') }
  const inbox = renderInbox(o.inbox)
  if (inbox) lines.push(inbox)
  section('Remarks on my documents', o.remarks.map(r => `- ${r.member} on **${r.title}** (${r.at.slice(0, 10)})`))
  section('Proposals citing my documents', o.proposalsCitingMine.map(p => `- ${p.title} by ${p.author} → ${p.cites.join(', ')}`))
  section('Recently changed by others', o.recentByOthers.map(i => `- ${i.title} — ${i.author}, ${i.at.slice(0, 10)}`))
  section('My recent documents', o.authored.map(i => `- ${i.title} (${i.at.slice(0, 10)})`))
  section('My personal documents', o.personal.map(i => `- ${i.title} (${i.at.slice(0, 10)})`))
  return lines.join('\n').trimEnd() + '\n'
}
