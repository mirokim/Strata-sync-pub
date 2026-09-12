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
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { runLint, reportToMarkdown, ALL_RULES, type LintRuleId, type LintSeverity, type LintSnapshot } from '../../mcp/src/lint/index.js'
import { buildProposal, isProposalPath, stripProposalFrontmatter, promotedPath, PROPOSAL_FOLDER } from '../../mcp/src/proposals.js'
import { deleteFile, getFile, putFile, normalizeVaultPath, type SyncDeps } from './sync.js'
import { loadVaultView, invalidateVaultView, Bm25 } from './vaultIndex.js'
import { SNAPSHOT_KEY } from './nightly.js'
import type { SearchHit } from './nightly.js'

export interface McpDeps extends SyncDeps {
  /** Semantic search when Vectorize is configured; otherwise BM25 only. */
  semanticSearch?: (query: string, topK: number) => Promise<SearchHit[]>
  author?: string
}

const enc = new TextEncoder()
const dec = new TextDecoder()

const TOOLS = [
  { name: 'vault_list', description: 'List documents in the team vault (path, title, tags, modified). Optional folder prefix filter.', inputSchema: { type: 'object' as const, properties: { folder: { type: 'string', description: 'Only paths under this folder' }, limit: { type: 'number', description: 'Max entries (default 200)' } } } },
  { name: 'vault_read', description: 'Read a document by vault path (e.g. "active/Combat System.md").', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'vault_search', description: 'Search the vault. Uses the semantic index when available and BM25 keyword search always; returns paths with scores and a snippet.', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' }, topK: { type: 'number', description: 'default 8' } }, required: ['query'] } },
  { name: 'graph_lint', description: 'Structural lint of the whole team vault: phantom-hot (missing documents linked from many places), bridge-spof (single points of failure), orphan, stale-hub, near-duplicate, cluster-drift. Run before creating or editing documents.', inputSchema: { type: 'object' as const, properties: { rules: { type: 'array', items: { type: 'string', enum: [...ALL_RULES] } }, minSeverity: { type: 'string', enum: ['error', 'warn', 'info'] }, limitPerRule: { type: 'number' }, format: { type: 'string', enum: ['json', 'markdown'] } } } },
  { name: 'graph_suggest_links', description: 'Documents a text should link to, ranked by relevance (BM25 over the vault; proposals excluded).', inputSchema: { type: 'object' as const, properties: { text: { type: 'string' }, topK: { type: 'number', description: 'default 5' } }, required: ['text'] } },
  { name: 'vault_propose', description: 'Record an idea, decision or note as an agent PROPOSAL in _agent/ — never directly into the vault. A person promotes it in the app or with vault_promote. Use whenever the user asks to remember/record/write something down.', inputSchema: { type: 'object' as const, properties: { title: { type: 'string' }, body: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, links: { type: 'array', items: { type: 'string' }, description: 'Titles of existing documents to wikilink under "## Related"' }, source: { type: 'string', description: 'Who is proposing (default "agent")' } }, required: ['title', 'body'] } },
  { name: 'vault_proposals', description: 'List pending agent proposals in _agent/.', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'vault_promote', description: 'Promote a proposal into the vault (strip proposal frontmatter, move out of _agent/). Only when the user explicitly approves it.', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' }, destFolder: { type: 'string', description: 'Destination folder (default vault root)' } }, required: ['path'] } },
  { name: 'vault_write', description: 'Write a document directly (create or replace). Prefer vault_propose for anything the team has not approved; use this only when the user explicitly asks to edit an existing document.', inputSchema: { type: 'object' as const, properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
]

type Args = Record<string, unknown>

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
      const r = await getFile(deps, String(args.path ?? ''))
      if (r.status !== 200 || !('bytes' in r) || !r.bytes) return fail(`${args.path}: ${r.status === 404 ? 'not found' : 'cannot read'}`)
      return text(dec.decode(r.bytes))
    }
    case 'vault_search': {
      const query = String(args.query ?? '').trim()
      if (!query) return fail('query required')
      const topK = Math.min(Math.max(Number(args.topK) || 8, 1), 30)
      const view = await loadVaultView(deps)
      const bm25 = new Bm25(view.docs).search(query, topK)
      const semantic = deps.semanticSearch ? await deps.semanticSearch(query, topK).catch(() => []) : []
      // Rank fusion: rank-based so the two score scales do not fight
      const rank = new Map<string, number>()
      bm25.forEach((h, i) => rank.set(h.path, (rank.get(h.path) ?? 0) + 1 / (60 + i + 1)))
      semantic.forEach((h, i) => rank.set(h.path, (rank.get(h.path) ?? 0) + 1 / (60 + i + 1)))
      const results = [...rank.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK).map(([path, score]) => {
        const d = view.docs.get(path)
        return { path, title: d?.title ?? path, score: Number(score.toFixed(4)), snippet: d ? d.body.replace(/\s+/g, ' ').slice(0, 240) : '', proposal: d && isProposalPath(d.folderPath) ? true : undefined }
      })
      return text({ query, semantic: semantic.length > 0, results })
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
      const hits = new Bm25(view.docs).search(q, Math.min(Math.max(Number(args.topK) || 5, 1), 20), exclude)
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
      invalidateVaultView()
      return text({ path: rel, status: r.status === 201 ? 'created' : r.status === 204 ? 'unchanged' : 'replaced' })
    }
    default:
      return fail(`unknown tool: ${name}`)
  }
}

/** Build a fresh MCP server + stateless transport per request and hand the request to it. */
export async function handleMcpRequest(req: Request, deps: McpDeps): Promise<Response> {
  // Stateless: no server-initiated SSE stream (GET) and no session to terminate (DELETE).
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  const server = new Server({ name: 'strata-sync-cloud', version: '0.4.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
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
