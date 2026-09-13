/**
 * Inbox — one person's agent asks or assigns something to another person, through the vault.
 *
 * Kim's Claude Code leaves a question addressed to Lee; the next time Lee's agent (or Lee, in the
 * app) shows up, it is there, gets answered with Lee's own context — Lee's repo, Lee's personal
 * documents — and the answer lands back in Kim's desk. A task is the same envelope with a result
 * instead of an answer: that is how work is relayed from one person's machine to another's.
 *
 * Storage: `_inbox/<recipient>/<yyyy-mm-dd> <slug>.md`, a normal vault document (team-visible,
 * linked to the documents it is about) with frontmatter:
 *
 *   type: inbox · kind: question|task · to / from (display names) · to_sub / from_sub (identity
 *   when known) · status: open|answered|done|declined · created · about: [paths]
 *
 * Replies are appended as `## Reply — <author>, <date>` sections; the status moves with them.
 *
 * Relay: a task may carry `chain: [next, next…]`. When the addressee marks it done, the server
 * creates the same task for the next name in the chain, with this result linked and quoted, so a
 * piece of work walks from one person's machine to the next — each hop explicitly assigned.
 * Addressing is by display name (that is what people know), so the recipient matches when the
 * name equals their author name, or `to_sub` equals their sub.
 */
import { putFile, type FileRow, type SyncDeps } from './sync.js'
import type { Viewer } from './personal.js'
import { slugForTitle } from '../../mcp/src/proposals.js'

export const INBOX_PREFIX = '_inbox/'
export type InboxKind = 'question' | 'task'
export type InboxStatus = 'open' | 'answered' | 'done' | 'declined'
export const INBOX_STATUSES: InboxStatus[] = ['open', 'answered', 'done', 'declined']

export interface InboxItem {
  path: string
  kind: InboxKind
  status: InboxStatus
  title: string
  to: string
  toSub: string
  from: string
  fromSub: string
  created: string
  about: string[]
  body: string
  replies: { author: string; at: string; text: string }[]
  /** Task relay: who gets it after the addressee is done, in order */
  chain: string[]
  /** The item this one continues (relay hop), when any */
  previous: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function isInboxPath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(INBOX_PREFIX)
}

/** Recipient folder: the display name, made safe for a path. */
export function personSegment(name: string): string {
  return name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 60) || 'unknown'
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Is this item addressed to the caller? Names are what people write; subs win when both sides have one. */
export function isAddressedTo(item: Pick<InboxItem, 'to' | 'toSub'>, viewer: Viewer, author: string): boolean {
  if (item.toSub && viewer.sub && !viewer.service && item.toSub === viewer.sub) return true
  return !!author && sameName(item.to, author)
}
export function isSentBy(item: Pick<InboxItem, 'from' | 'fromSub'>, viewer: Viewer, author: string): boolean {
  if (item.fromSub && viewer.sub && !viewer.service && item.fromSub === viewer.sub) return true
  return !!author && sameName(item.from, author)
}

export interface InboxInput {
  to: string
  toSub?: string
  kind: InboxKind
  title: string
  body: string
  about?: string[]
  from: string
  fromSub: string
  now?: number
  chain?: string[]
  previous?: string
}

export function renderInboxDoc(input: InboxInput): { path: string; content: string } {
  const now = input.now ?? Date.now()
  const title = input.title.trim() || (input.kind === 'task' ? 'Untitled task' : 'Untitled question')
  const date = new Date(now).toISOString().slice(0, 10)
  const about = [...new Set((input.about ?? []).map(a => a.trim()).filter(Boolean))]
  const chain = input.kind === 'task' ? (input.chain ?? []).map(c => c.trim()).filter(Boolean) : []
  const fm = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'type: inbox',
    `kind: ${input.kind}`,
    `to: ${JSON.stringify(input.to.trim())}`,
    `to_sub: ${JSON.stringify(input.toSub ?? '')}`,
    `from: ${JSON.stringify(input.from)}`,
    `from_sub: ${JSON.stringify(input.fromSub)}`,
    'status: open',
    `created: ${new Date(now).toISOString()}`,
    `about: [${about.map(a => JSON.stringify(a)).join(', ')}]`,
    `chain: [${chain.map(c => JSON.stringify(c)).join(', ')}]`,
    `previous: ${JSON.stringify(input.previous ?? '')}`,
    `tags: ["inbox", ${JSON.stringify(input.kind)}]`,
    'graph_weight: low',
    '---',
  ].join('\n')
  const related = about.length ? `\n\n## About\n\n${about.map(a => `- [[${a.replace(/^.*\//, '').replace(/\.md$/i, '')}]]`).join('\n')}` : ''
  return { path: `${INBOX_PREFIX}${personSegment(input.to)}/${date} ${slugForTitle(title)}.md`, content: `${fm}\n\n# ${title}\n\n${input.body.trim()}${related}\n` }
}

const FM_LINE = /^([a-z_]+):\s*(.*)$/
function readScalar(raw: string): string {
  const t = raw.trim()
  if (t.startsWith('"')) { try { return JSON.parse(t) } catch { return t.slice(1, -1) } }
  return t
}
function readList(raw: string): string[] {
  const t = raw.trim()
  if (!t.startsWith('[')) return []
  try { return JSON.parse(t.replace(/'/g, '"')) } catch { return t.slice(1, -1).split(',').map(s => readScalar(s)).filter(Boolean) }
}

export function parseInboxDoc(path: string, text: string): InboxItem | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) return null
  const fm: Record<string, string> = {}
  for (const line of m[1].split('\n')) { const l = FM_LINE.exec(line); if (l) fm[l[1]] = l[2] }
  if (fm.type?.trim() !== 'inbox') return null
  const kind = (readScalar(fm.kind ?? '') === 'task' ? 'task' : 'question') as InboxKind
  const statusRaw = readScalar(fm.status ?? 'open') as InboxStatus
  const status = INBOX_STATUSES.includes(statusRaw) ? statusRaw : 'open'
  const rest = m[2]
  const replies: InboxItem['replies'] = []
  const REPLY = /^## Reply — (.+?), (\S+)\s*$/gm
  const parts: { author: string; at: string; index: number; end: number }[] = []
  let r: RegExpExecArray | null
  while ((r = REPLY.exec(rest)) !== null) parts.push({ author: r[1], at: r[2], index: r.index, end: r.index + r[0].length })
  for (let i = 0; i < parts.length; i++) {
    const text = rest.slice(parts[i].end, i + 1 < parts.length ? parts[i + 1].index : undefined).trim()
    replies.push({ author: parts[i].author, at: parts[i].at, text })
  }
  const bodyEnd = parts.length ? parts[0].index : rest.length
  const body = rest.slice(0, bodyEnd).replace(/^\s*#\s[^\n]*\n/, '').replace(/\n## About[\s\S]*$/, '').trim()
  return {
    path, kind, status,
    title: readScalar(fm.title ?? '') || path.replace(/^.*\//, '').replace(/\.md$/i, ''),
    to: readScalar(fm.to ?? ''), toSub: readScalar(fm.to_sub ?? ''),
    from: readScalar(fm.from ?? ''), fromSub: readScalar(fm.from_sub ?? ''),
    created: readScalar(fm.created ?? ''), about: readList(fm.about ?? ''), body, replies,
    chain: readList(fm.chain ?? ''), previous: readScalar(fm.previous ?? ''),
  }
}

export interface InboxDeps extends SyncDeps { viewer: Viewer; author: string }

/** Every live inbox document, parsed. */
export async function readInbox(deps: SyncDeps, rows: FileRow[]): Promise<InboxItem[]> {
  const live = rows.filter(r => !r.deleted && isInboxPath(r.path) && /\.md$/i.test(r.path))
  const items = await Promise.all(live.map(async r => { const bytes = await deps.blobs.get(r.path); return bytes ? parseInboxDoc(r.path, dec.decode(bytes)) : null }))
  return items.filter((i): i is InboxItem => !!i).sort((a, b) => b.created.localeCompare(a.created))
}

export interface InboxView { forMe: InboxItem[]; sent: InboxItem[] }

/** The caller's side of the inbox: addressed to them, and sent by them. */
export function inboxFor(items: InboxItem[], viewer: Viewer, author: string, status?: InboxStatus): InboxView {
  const keep = (i: InboxItem) => !status || i.status === status
  return {
    forMe: items.filter(i => keep(i) && isAddressedTo(i, viewer, author)),
    sent: items.filter(i => keep(i) && isSentBy(i, viewer, author)),
  }
}

export async function sendInbox(deps: InboxDeps, input: Omit<InboxInput, 'from' | 'fromSub'>): Promise<{ path: string } | { error: string }> {
  if (!input.to.trim()) return { error: 'to (a teammate\'s name) is required' }
  if (input.kind === 'task' && (input.chain ?? []).some(c => c.trim().toLowerCase() === input.to.trim().toLowerCase())) return { error: 'chain must not repeat the addressee' }
  if (!input.title.trim() || !input.body.trim()) return { error: 'title and body are required' }
  const doc = renderInboxDoc({ ...input, from: deps.author, fromSub: deps.viewer.service ? '' : deps.viewer.sub, now: deps.now?.() })
  let path = doc.path
  for (let n = 2; (await deps.meta.get(path))?.deleted === false; n++) path = doc.path.replace(/\.md$/, `-${n}.md`)
  const r = await putFile(deps, { path, body: enc.encode(doc.content), mtime: deps.now?.() ?? Date.now(), author: deps.author, authorSub: deps.viewer.sub, createOnly: true })
  if (r.status >= 400) return { error: (r as { body: { error: string } }).body.error }
  return { path }
}

/**
 * Append a reply and move the status. The addressee answers/finishes/declines; the sender may
 * decline (withdraw) their own item. Anyone else is refused.
 */
export async function replyInbox(deps: InboxDeps, path: string, reply: string, status: Exclude<InboxStatus, 'open'>): Promise<{ path: string; status: InboxStatus; handedTo?: string; next?: string } | { error: string }> {
  if (!isInboxPath(path)) return { error: 'not an inbox document' }
  if (!INBOX_STATUSES.includes(status) || (status as string) === 'open') return { error: 'status must be answered, done or declined' }
  const row = await deps.meta.get(path)
  if (!row || row.deleted) return { error: 'not found' }
  const bytes = await deps.blobs.get(path)
  const text = bytes ? dec.decode(bytes) : ''
  const item = parseInboxDoc(path, text)
  if (!item) return { error: 'not an inbox document' }
  const addressee = isAddressedTo(item, deps.viewer, deps.author)
  const sender = isSentBy(item, deps.viewer, deps.author)
  if (!addressee && !(sender && status === 'declined')) return { error: `this item is addressed to ${item.to}; only they can answer it (the sender may decline it)` }
  if (item.kind === 'question' && status === 'done') status = 'answered'
  if (item.kind === 'task' && status === 'answered') status = 'done'
  const now = deps.now?.() ?? Date.now()
  const stamp = new Date(now).toISOString()
  const updated = text.replace(/^status: .*$/m, `status: ${status}`).trimEnd() + `\n\n## Reply — ${deps.author}, ${stamp}\n\n${reply.trim()}\n`
  const r = await putFile(deps, { path, body: enc.encode(updated), mtime: now, author: deps.author, authorSub: deps.viewer.sub, ifMatch: row.etag })
  if (r.status >= 400) return { error: (r as { body: { error: string } }).body.error }

  // Relay: a finished task with names left in its chain moves on to the next person, carrying the result
  if (item.kind === 'task' && status === 'done' && item.chain.length) {
    const [handedTo, ...rest] = item.chain
    // The hop is sent on behalf of the original requester, so the whole relay shows in their "sent" list
    const requester = { ...deps, author: item.from || deps.author, viewer: item.fromSub ? { sub: item.fromSub } : deps.viewer }
    const hop = await sendInbox(requester, {
      to: handedTo, kind: 'task', title: item.title,
      body: `${item.body}\n\n## Previous step — ${deps.author}, ${stamp}\n\n${reply.trim()}`,
      about: [...item.about, path], chain: rest, previous: path,
    })
    if ('error' in hop) return { path, status, handedTo, next: undefined }
    return { path, status, handedTo, next: hop.path }
  }
  return { path, status }
}

/** Markdown for an agent: what is waiting for the caller, and what they are waiting on. */
export function renderInbox(view: InboxView): string {
  const lines: string[] = []
  const open = view.forMe.filter(i => i.status === 'open')
  if (open.length) {
    lines.push(`## Waiting for you (${open.length})`)
    for (const i of open) lines.push(`- [${i.kind}] **${i.title}** — from ${i.from}, ${i.created.slice(0, 10)} · ${i.path}${i.about.length ? ` · about: ${i.about.join(', ')}` : ''}${i.chain.length ? ` · then → ${i.chain.join(' → ')}` : ''}${i.previous ? ` · continues ${i.previous}` : ''}`)
    lines.push('')
  }
  const pending = view.sent.filter(i => i.status === 'open')
  const answered = view.sent.filter(i => i.status !== 'open')
  if (pending.length) { lines.push(`## You are waiting on (${pending.length})`); for (const i of pending) lines.push(`- [${i.kind}] ${i.title} → ${i.to}, ${i.created.slice(0, 10)}`); lines.push('') }
  if (answered.length) {
    lines.push(`## Answered for you (${answered.length})`)
    for (const i of answered.slice(0, 10)) { const last = i.replies[i.replies.length - 1]; lines.push(`- [${i.status}] ${i.title} — ${last ? `${last.author}: ${last.text.split('\n')[0].slice(0, 160)}` : ''} · ${i.path}`) }
    lines.push('')
  }
  return lines.join('\n')
}
