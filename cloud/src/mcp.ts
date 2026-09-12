/**
 * Remote MCP server — the team vault as a tool set for Claude Code / Cursor, hosted in the Worker.
 *
 *   claude mcp add --transport http strata https://<worker>/mcp --header "Authorization: Bearer <team token>"
 *
 * Stateless Streamable HTTP (one JSON response per request, no sessions), so any isolate can
 * answer any call. Tools mirror the local MCP server where it makes sense for a hosted vault:
 * reading, searching, lint, proposals and promotion. Anything that needs a local machine
 * (Python tools, Slack process control) stays in the desktop MCP.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { runLint, reportToMarkdown, ALL_RULES, type LintRuleId, type LintSeverity, type LintSnapshot } from '../../mcp/src/lint/index.js'
import { buildProposal, isProposalPath, stripProposalFrontmatter, promotedPath, PROPOSAL_FOLDER } from '../../mcp/src/proposals.js'
import { deleteFile, getFile, putFile, normalizeVaultPath, type FileRow, type SyncDeps } from './sync.js'
import { loadVaultView, invalidateVaultView } from './vaultIndex.js'
import { SNAPSHOT_KEY } from './nightly.js'
import { readMembers, recordRoutineRun, dueRoutines, findMember, renderMemberPrompt, renderMemoryNote, memberNotePath, memberNoteName, type Member } from './members.js'
import type { SearchHit } from './nightly.js'
import { recall, fusedSearch } from './recall.js'
import { listVersions, readVersion, previousVersion, diffLines } from './history.js'
import { isImagePath, imageDocPath, mimeOf, undescribedImages, DESCRIBE_GUIDE } from './images.js'

export interface McpDeps extends SyncDeps {
  /** Semantic search when Vectorize is configured; otherwise BM25 only. */
  semanticSearch?: (query: string, topK: number) => Promise<SearchHit[]>
  author?: string
  /** Called after a document is created/replaced (vault_write, vault_promote) — the router queues member reactions here. */
  onWrite?: (row: FileRow) => void
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const TOOLS = [
  { name: 'vault_list', description: 'List documents in the team vault (path, title, tags, modified). Optional folder prefix filter.', inputSchema: { type: 'object' as const, properties: { folder: { type: 'string', description: 'Only paths under this folder' }, limit: { type: 'number', description: 'Max entries (default 200)' } } } },
  { name: 'vault_read', description: 'Read a document by vault path (e.g. "active/Combat System.md"). For an image path (png/jpg/webp/gif) returns the image itself plus its image document (the description written for it) — refine that document with vault_write when the description is wrong or thin.', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'vault_search', description: 'Search the vault. Uses the semantic index when available and BM25 keyword search always; returns paths with scores and a snippet. For "what do we know about X" prefer vault_recall.', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' }, topK: { type: 'number', description: 'default 8' } }, required: ['query'] } },
  { name: 'vault_recall', description: 'What the team knows about a topic, as one bundle: the matching documents (excerpts), the documents linked around them, what the AI members remember about it, and what members said when those documents were saved. Use this before answering any question about the team\'s work; cite the paths it lists.', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' }, budget: { type: 'number', description: 'Characters of document text to include (default 16000, max 60000)' }, seeds: { type: 'number', description: 'Matching documents (default 5)' }, neighbours: { type: 'number', description: 'Linked documents around them (default 8)' }, format: { type: 'string', enum: ['markdown', 'json'], description: 'default markdown' } }, required: ['query'] } },
  { name: 'vault_history', description: 'How a document changed: its archived versions (who saved, when) and a line diff — by default between the previous version and the current one, or from a given version etag to now. Use it to answer "when did we change our mind about X" or to see what a save actually altered.', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' }, etag: { type: 'string', description: 'Compare this archived version with the current one (default: the previous version)' }, limit: { type: 'number', description: 'Versions to list (default 10)' }, diff: { type: 'boolean', description: 'Include the diff (default true)' } }, required: ['path'] } },
  { name: 'graph_lint', description: 'Structural lint of the whole team vault: phantom-hot (missing documents linked from many places), bridge-spof (single points of failure), orphan, stale-hub, near-duplicate, cluster-drift. Run before creating or editing documents.', inputSchema: { type: 'object' as const, properties: { rules: { type: 'array', items: { type: 'string', enum: [...ALL_RULES] } }, minSeverity: { type: 'string', enum: ['error', 'warn', 'info'] }, limitPerRule: { type: 'number' }, format: { type: 'string', enum: ['json', 'markdown'] } } } },
  { name: 'graph_suggest_links', description: 'Documents a text should link to, ranked by relevance (BM25 over the vault; proposals excluded).', inputSchema: { type: 'object' as const, properties: { text: { type: 'string' }, topK: { type: 'number', description: 'default 5' } }, required: ['text'] } },
  { name: 'vault_propose', description: 'Record an idea, decision or note as an agent PROPOSAL in _agent/ — never directly into the vault. A person promotes it in the app or with vault_promote. Use whenever the user asks to remember/record/write something down.', inputSchema: { type: 'object' as const, properties: { title: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, links: { type: 'array', items: { type: 'string' }, description: 'Titles of existing documents to wikilink under "## Related"' }, source: { type: 'string', description: 'Who is proposing (default "agent")' } }, required: ['title', 'body'] } },
  { name: 'vault_proposals', description: 'List pending agent proposals in _agent/.', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'vault_promote', description: 'Promote a proposal into the vault (strip proposal frontmatter, move out of _agent/). Only when the user explicitly approves it.', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' }, destFolder: { type: 'string', description: 'Destination folder (default vault root)' } }, required: ['path'] } },
  { name: 'vault_write', description: 'Write a document directly (create or replace). Prefer vault_propose for anything the team has not approved; use this only when the user explicitly asks to edit an existing document.', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'vault_changes', description: 'Documents created, changed or deleted since a point in time (ISO date or ms since epoch), newest first, with author and title. Use it to see what moved before reviewing premises or writing a digest.', inputSchema: { type: 'object' as const, properties: { since: { type: 'string', description: 'ISO 8601 date/time, or ms since epoch' }, limit: { type: 'number', description: 'default 100, max 500' } }, required: ['since'] } },
  { name: 'images_undescribed', description: 'Image documents whose Description is still empty (images pasted in the app or uploaded). For each: vault_read the image, then vault_write the image document with what it shows, the visible text and tags — that is how images become searchable.', inputSchema: { type: 'object' as const, properties: { limit: { type: 'number', description: 'default 20' } } } },
  { name: 'members_list', description: 'The team\'s AI members (Settings → AI Members): id, name, role, scope, routines with cadence and last run, memory note path. Use the `member` prompt to act as one.', inputSchema: { type: 'object' as const, properties: { due: { type: 'boolean', description: 'Only members with a routine due now' } } } },
  { name: 'member_remember', description: 'Append to an AI member\'s own memory note (_members/<Name> (memory).md) — a position taken, a question asked, what a routine found. The only document a member writes directly. Creates the note on first use.', inputSchema: { type: 'object' as const, properties: { member: { type: 'string', description: 'Member id or name' }, text: { type: 'string', description: 'Markdown to append (dated automatically)' } }, required: ['member', 'text'] } },
  { name: 'member_report', description: 'Record that a member routine was run: a short summary and the proposal paths created. Call once per routine after finishing it, even when nothing was proposed.', inputSchema: { type: 'object' as const, properties: { member: { type: 'string', description: 'Member id or name' }, routine: { type: 'string', description: 'Routine id' }, summary: { type: 'string' }, proposals: { type: 'array', items: { type: 'string' } } }, required: ['member', 'routine', 'summary'] } },
]

type Args = Record<string, unknown>

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

function text(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }] }
}
function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
}

export async function callTool(deps: McpDeps, name: string, args: Args): Promise<CallToolResult> {
  const author = deps.author ?? 'mcp'
  switch (name) {
    case 'vault_list': {
      const view = await loadVaultView(deps)
      const folder = typeof args.folder === 'string' ? args.folder.replace(/^\/+|\/+$/g, '') : ''
      const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 2000)
      const items = [...view.docs.entries()]
        .filter(([p]) => !folder || p === folder || p.startsWith(folder + '/'))
        .sort((a, b) => a[0].localeCompare(b[0]))
        .slice(0, limit)
        .map(([path, d]) => ({ path, title: d.title, tags: d.tags, modified: d.mtime ? new Date(d.mtime).toISOString() : null, proposal: isProposalPath(d.folderPath) || undefined }))
      return text({ count: items.length, total: view.docs.size, items })
    }
    case 'vault_read': {
      const path = String(args.path ?? '')
      const r = await getFile(deps, path)
      if (r.status !== 200 || !('bytes' in r) || !r.bytes) return fail(`${path}: ${r.status === 404 ? 'not found' : 'cannot read'}`)
      if (isImagePath(path)) {
        const docPath = imageDocPath(normalizeVaultPath(path) ?? path)
        const doc = await getFile(deps, docPath)
        const docText = doc.status === 200 && 'bytes' in doc && doc.bytes ? dec.decode(doc.bytes) : `(no image document yet — write one at ${docPath} with vault_write)`
        return { content: [{ type: 'image', data: toBase64(r.bytes), mimeType: mimeOf(path) }, { type: 'text', text: `Image document: ${docPath}\n\n${docText}` }] }
      }
      return text(dec.decode(r.bytes))
    }
    case 'vault_search': {
      const query = String(args.query ?? '').trim()
      if (!query) return fail('query required')
      const topK = Math.min(Math.max(Number(args.topK) || 8, 1), 30)
      const view = await loadVaultView(deps)
      const { hits, semantic } = await fusedSearch(deps, view, query, topK)
      const results = hits.map(h => {
        const d = view.docs.get(h.path)
        return { path: h.path, title: h.title, score: h.score, snippet: d ? d.body.replace(/\s+/g, ' ').slice(0, 240) : '', proposal: d && isProposalPath(d.folderPath) ? true : undefined }
      })
      return text({ query, semantic, results })
    }
    case 'vault_recall': {
      const query = String(args.query ?? '').trim()
      if (!query) return fail('query required')
      const result = await recall(deps, { query, budget: Number(args.budget) || undefined, seeds: Number(args.seeds) || undefined, neighbours: args.neighbours === undefined ? undefined : Number(args.neighbours) })
      if (args.format === 'json') { const { markdown: _m, ...rest } = result; return text(rest) }
      return text(result.markdown)
    }
    case 'vault_history': {
      const path = normalizeVaultPath(String(args.path ?? ''))
      if (!path) return fail('path required')
      const row = await deps.meta.get(path)
      const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50)
      const versions = await listVersions(deps.blobs, path)
      const listed = versions.slice(0, limit).map(v => ({ etag: v.etag, at: new Date(v.at).toISOString(), author: v.author, size: v.size }))
      const current = row && !row.deleted ? { etag: row.etag, at: new Date(row.updatedAt).toISOString(), author: row.author, size: row.size } : null
      if (args.diff === false) return text({ path, current, versions: listed })
      const wanted = String(args.etag ?? '').trim()
      const older = wanted ? await readVersion(deps.blobs, path, wanted) : (current ? await previousVersion(deps.blobs, path, current.etag) : null)
      if (wanted && !older) return fail(`no archived version ${wanted} for ${path}`)
      const nowBytes = current ? await deps.blobs.get(path) : null
      const diff = older && nowBytes
        ? { from: { etag: older.version.etag, at: new Date(older.version.at).toISOString(), author: older.version.author }, to: current, ...diffLines(dec.decode(older.bytes), dec.decode(nowBytes)) }
        : null
      return text({ path, current, versions: listed, diff: diff ?? (current ? 'no earlier version archived' : 'document is deleted') })
    }
    case 'graph_lint': {
      const view = await loadVaultView(deps)
      const previousRaw = await deps.blobs.get(SNAPSHOT_KEY)
      let previous: LintSnapshot | undefined
      if (previousRaw) { try { previous = JSON.parse(dec.decode(previousRaw)) } catch { previous = undefined } }
      const rules = Array.isArray(args.rules) ? (args.rules as string[]).filter((r): r is LintRuleId => (ALL_RULES as readonly string[]).includes(r)) : undefined
      const report = runLint({ docs: [...view.docs.values()], previousSnapshot: previous }, {
        rules, minSeverity: args.minSeverity as LintSeverity | undefined, limitPerRule: Number(args.limitPerRule) || undefined,
      })
      if (args.format === 'markdown') return text(reportToMarkdown(report))
      const { snapshot: _s, ...rest } = report
      return text(rest)
    }
    case 'graph_suggest_links': {
      const q = String(args.text ?? '').trim()
      if (!q) return fail('text required')
      const view = await loadVaultView(deps)
      const exclude = new Set([...view.docs.entries()].filter(([, d]) => isProposalPath(d.folderPath)).map(([p]) => p))
      const hits = view.bm25().search(q, Math.min(Math.max(Number(args.topK) || 5, 1), 20), exclude)
      return text({ suggestions: hits.map(h => ({ path: h.path, title: h.title, docId: h.docId, score: Number(h.score.toFixed(3)) })) })
    }
    case 'vault_propose': {
      const title = String(args.title ?? '').trim(), body = String(args.body ?? '').trim()
      if (!title || !body) return fail('title and body are required')
      const proposal = buildProposal({
        title, body,
        tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : [],
        links: Array.isArray(args.links) ? (args.links as unknown[]).map(String) : [],
        source: typeof args.source === 'string' ? args.source : author,
      })
      let rel = proposal.relPath
      for (let n = 2; (await deps.meta.get(rel))?.deleted === false; n++) rel = proposal.relPath.replace(/\.md$/, `-${n}.md`)
      const r = await putFile(deps, { path: rel, body: enc.encode(proposal.content), mtime: Date.now(), author, createOnly: true })
      if (r.status >= 400) return fail(`could not write proposal (${r.status})`)
      invalidateVaultView()
      return text({ path: rel, title: proposal.title, note: 'Saved to _agent/. A person promotes it in the app or with vault_promote.' })
    }
    case 'vault_proposals': {
      const view = await loadVaultView(deps)
      const proposals = [...view.docs.entries()].filter(([, d]) => isProposalPath(d.folderPath)).sort((a, b) => b[0].localeCompare(a[0]))
        .map(([path, d]) => ({ path, title: d.title, tags: d.tags, proposedAt: d.mtime ? new Date(d.mtime).toISOString() : null }))
      return text({ proposals })
    }
    case 'vault_promote': {
      const rel = normalizeVaultPath(String(args.path ?? ''))
      if (!rel || !isProposalPath(rel) || rel === PROPOSAL_FOLDER) return fail('path must be a proposal under _agent/')
      const current = await getFile(deps, rel)
      if (current.status !== 200 || !('bytes' in current) || !current.bytes) return fail(`proposal not found: ${rel}`)
      const dest = promotedPath(rel, typeof args.destFolder === 'string' ? args.destFolder : '')
      const existing = await deps.meta.get(dest)
      if (existing && !existing.deleted) return fail(`destination already exists: ${dest}`)
      const written = await putFile(deps, { path: dest, body: enc.encode(stripProposalFrontmatter(dec.decode(current.bytes))), mtime: Date.now(), author, createOnly: true })
      if (written.status >= 400) return fail(`could not write ${dest} (${written.status})`)
      if (written.body) deps.onWrite?.(written.body as FileRow)
      const etag = (current.headers?.ETag ?? '').replace(/^"|"$/g, '')
      await deleteFile(deps, rel, etag || undefined, author)
      invalidateVaultView()
      return text({ promoted: rel, to: dest })
    }
    case 'vault_write': {
      const rel = normalizeVaultPath(String(args.path ?? ''))
      if (!rel || !rel.toLowerCase().endsWith('.md')) return fail('path must be a .md vault path')
      const content = String(args.content ?? '')
      const r = await putFile(deps, { path: rel, body: enc.encode(content), mtime: Date.now(), author })
      if (r.status >= 400) return fail(`write failed (${r.status})`)
      if (r.body) deps.onWrite?.(r.body as FileRow)
      invalidateVaultView()
      return text({ path: rel, status: r.status === 201 ? 'created' : r.status === 204 ? 'unchanged' : 'replaced' })
    }
    case 'vault_changes': {
      const raw = String(args.since ?? '').trim()
      const since = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw)
      if (!Number.isFinite(since)) return fail('since must be an ISO date or ms since epoch')
      const limit = Math.min(Math.max(Number(args.limit) || 100, 1), 500)
      const view = await loadVaultView(deps)
      // Every row (live or tombstone) newer than `since`; the vault view is keyed by path, so scan the store
      const rows = await deps.meta.listSince(0, 100_000)
      const changed = rows.filter(r => r.updatedAt >= since && !r.path.split('/').some(s => s.startsWith('.')))
        .sort((a, b) => b.updatedAt - a.updatedAt || b.seq - a.seq).slice(0, limit)
        .map(r => ({ path: r.path, title: view.docs.get(r.path)?.title ?? r.path.replace(/^.*\//, '').replace(/\.md$/i, ''), author: r.author, at: new Date(r.updatedAt).toISOString(), deleted: r.deleted, proposal: isProposalPath(r.path) || undefined }))
      return text({ since: new Date(since).toISOString(), count: changed.length, changes: changed })
    }
    case 'images_undescribed': {
      const view = await loadVaultView(deps)
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
      const pending = undescribedImages(view)
      return text({ count: pending.length, guide: DESCRIBE_GUIDE, images: pending.slice(0, limit).map(p => ({ ...p, since: new Date(p.since).toISOString() })) })
    }
    case 'members_list': {
      const config = await readMembers(deps)
      const now = Date.now()
      const members = config.members.filter(m => m.enabled && (args.due !== true || dueRoutines(m, now).length > 0))
      return text({ members: members.map(m => ({ id: m.id, name: m.name, role: m.role, scope: m.scope, reactsOnSave: m.reactsOnSave, memory: memberNotePath(m), routines: m.routines.filter(r => r.enabled).map(r => ({ id: r.id, title: r.title, cadence: r.cadence, due: dueRoutines(m, now).some(d => d.id === r.id), lastRun: r.runs.length ? r.runs[r.runs.length - 1] : null })) })) })
    }
    case 'member_remember': {
      const config = await readMembers(deps)
      const member = findMember(config, String(args.member ?? ''))
      if (!member) return fail(`unknown member: ${String(args.member ?? '')}`)
      const body = String(args.text ?? '').trim().slice(0, 8_000)
      if (!body) return fail('text is required')
      const entry = await appendToMemory(deps, member, body, author)
      return text({ path: memberNotePath(member), appended: entry.length, link: `[[${memberNoteName(member)}]]` })
    }
    case 'member_report': {
      const config = await readMembers(deps)
      const member = findMember(config, String(args.member ?? ''))
      if (!member) return fail(`unknown member: ${String(args.member ?? '')}`)
      const routineId = String(args.routine ?? '').trim()
      const summary = String(args.summary ?? '').trim().slice(0, 1000)
      if (!routineId || !summary) return fail('routine and summary are required')
      const proposals = Array.isArray(args.proposals) ? (args.proposals as unknown[]).map(String).slice(0, 50) : []
      const routine = await recordRoutineRun(deps, member.id, routineId, { at: Date.now(), by: author, summary, proposals })
      if (!routine) return fail(`unknown routine for ${member.name}: ${routineId}`)
      return text({ recorded: `${member.id}/${routineId}`, runs: routine.runs.length, at: new Date(routine.runs[routine.runs.length - 1].at).toISOString() })
    }
    default:
      return fail(`unknown tool: ${name}`)
  }
}

/**
 * Append a dated entry to a member's memory note. The note is the one vault document a member
 * owns; an If-Match on the current ETag keeps two clients from clobbering each other's entries.
 */
async function appendToMemory(deps: McpDeps, member: Member, body: string, by: string): Promise<string> {
  const path = memberNotePath(member)
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const entry = `\n## ${stamp} UTC · via ${by}\n\n${body}\n`
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await deps.meta.get(path)
    const live = row && !row.deleted ? row : null
    const bytes = live ? await deps.blobs.get(path) : null
    const base = bytes ? dec.decode(bytes) : renderMemoryNote(member)
    const put = await putFile(deps, {
      path, body: enc.encode(base.replace(/\s+$/, '') + '\n' + entry), mtime: Date.now(), author: `${member.id} (${by})`,
      ...(live ? { ifMatch: live.etag } : { createOnly: true }),
    })
    if (put.status === 200 || put.status === 201) { invalidateVaultView(); return entry }
    if (put.status !== 409) throw new Error(`memory note write failed (${put.status})`)
  }
  throw new Error('memory note changed under us three times; try again')
}

const PROMPTS = [
  { name: 'member', description: 'Act as one of the team\'s AI members (Settings → AI Members): take on its role and memory, run its routines that are due, answer in that voice. Writes only its own memory note and proposals.', arguments: [{ name: 'name', description: 'Member name or id (default: the first enabled member)', required: false }, { name: 'all', description: 'Set to "true" to run every enabled routine regardless of cadence', required: false }] },
]

/** Build a fresh MCP server + stateless transport per request and hand the request to it. */
export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
  // Stateless: no server-initiated SSE stream (GET) and no session to terminate (DELETE).
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  const server = new Server({ name: 'strata-sync-cloud', version: '0.5.0' }, { capabilities: { tools: {}, prompts: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS }))
  server.setRequestHandler(GetPromptRequestSchema, async request => {
    if (request.params.name !== 'member') throw new Error(`unknown prompt: ${request.params.name}`)
    const config = await readMembers(deps)
    const wanted = String(request.params.arguments?.name ?? '').trim()
    const member = wanted ? findMember(config, wanted) : config.members.find(m => m.enabled)
    if (!member) throw new Error(wanted ? `unknown member: ${wanted}` : 'no AI members are configured (Settings → AI Members)')
    const force = String(request.params.arguments?.all ?? '') === 'true'
    const now = Date.now()
    const routines = dueRoutines(member, now, force)
    const note = await getFile(deps, memberNotePath(member))
    const memory = note.status === 200 && note.bytes ? dec.decode(note.bytes) : null
    return {
      description: `${member.name} — ${routines.length} routine${routines.length === 1 ? '' : 's'} due`,
      messages: [{ role: 'user', content: { type: 'text', text: renderMemberPrompt(member, routines, memory, now, deps.author ?? '') } }],
    }
  })
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      return await callTool(deps, request.params.name, (request.params.arguments ?? {}) as Args)
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  })
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    return await transport.handleRequest(req)
  } finally {
    await transport.close().catch(() => {})
  }
}
