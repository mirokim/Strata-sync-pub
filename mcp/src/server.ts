/**
 * MCP Server — registers all tools and resources for Strata Sync.
 * 37 tools: vault CRUD, graph analysis, chat, search, edit agent, debate,
 * python tools, confluence/jira sync, slack bot, usage tracking, settings.
 */
import https from 'node:https'
import http from 'node:http'
import crypto from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { getConfig, updateConfig, loadConfig } from './config.js'
import { listFiles, readFile, saveFile, deleteFile, renameFile, createFolder, moveFile } from './vault.js'
import {
  reloadVault, bm25Search, hybridSearch, buildVectorIndex, getVectorIndexStats,
  getDocuments, getNodes, getLinks,
  computePageRank, detectClusters, findBridgeNodes, findImplicitLinks,
} from './state.js'
import { chat, chatDetailed, chatWithPersona, getUsageSummary, getUsageLog } from './llm/client.js'
import { runLint, reportToMarkdown, ALL_RULES, type LintRuleId, type LintSeverity } from './lint/index.js'
import { readSnapshot, writeSnapshot } from './lint/snapshot.js'
import { buildProposal, isProposalPath, stripProposalFrontmatter, promotedPath, PROPOSAL_FOLDER } from './proposals.js'
import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join, resolve, normalize } from 'path'

/** External API call timeout (30 s) — prevents fetch from hanging on slow/down servers */
const EXT_TIMEOUT_MS = 30_000

/** Use 'python' on Windows, 'python3' elsewhere */
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3'

// ── Helpers ─────────────────────────────────────────────────────────────────

function ok(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] } }
function err(msg: string) { return { content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true as const } }

/**
 * Safe YAML frontmatter serialization.
 * JSON.stringify output is compatible with YAML double-quoted scalars (\" \\ \n \t \uXXXX).
 * Building `title: "${title}"` without escaping makes gray-matter throw on a single `"` in the title,
 * and then that one document fails the whole vault load.
 */
function yamlStr(v: unknown): string {
  return JSON.stringify(v == null ? '' : String(v))
}

/** Strip characters not allowed in filenames + limit length */
function sanitizeFilenameBase(title: string): string {
  const base = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[.\s]+$/, '').trim().slice(0, 150)
  return base || 'untitled'
}

function safeVaultPath(relativePath: string): string | null {
  const vaultPath = getConfig().vaultPath
  if (!vaultPath) return null
  const abs = resolve(vaultPath, relativePath)
  const norm = normalize(abs).replace(/\\/g, '/')
  const vaultNorm = normalize(vaultPath).replace(/\\/g, '/').replace(/\/$/, '')
  // Require a path separator after the vault root to prevent sibling-dir traversal
  // e.g. vaultNorm="/foo/vault" must not match "/foo/vault-other/file"
  if (norm !== vaultNorm && !norm.startsWith(vaultNorm + '/')) return null
  return abs
}

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  // ─── Vault CRUD ───
  { name: 'vault_reload', description: 'Reload vault documents, rebuild graph and BM25 index', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'vault_list', description: 'List all files and folders in the vault', inputSchema: { type: 'object' as const, properties: { folder: { type: 'string', description: 'Optional subfolder to list' } } } },
  { name: 'vault_read', description: 'Read a file from the vault', inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Relative path within vault' } }, required: ['path'] } },
  { name: 'vault_write', description: 'Write/create a file in the vault', inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Relative path within vault' }, content: { type: 'string', description: 'File content' } }, required: ['path', 'content'] } },
  { name: 'vault_delete', description: 'Delete a file from the vault', inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Relative path within vault' } }, required: ['path'] } },
  { name: 'vault_rename', description: 'Rename a file in the vault', inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Current relative path' }, newName: { type: 'string', description: 'New filename (not full path)' } }, required: ['path', 'newName'] } },
  { name: 'vault_move', description: 'Move a file to a different folder in the vault', inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Current relative path' }, destFolder: { type: 'string', description: 'Destination folder relative path' } }, required: ['path', 'destFolder'] } },
  { name: 'vault_mkdir', description: 'Create a folder in the vault', inputSchema: { type: 'object' as const, properties: { folder: { type: 'string', description: 'Folder relative path to create' } }, required: ['folder'] } },

  // ─── Search ───
  { name: 'search_bm25', description: 'BM25 full-text search across vault documents', inputSchema: { type: 'object' as const, properties: { query: { type: 'string' }, topK: { type: 'number', description: 'Max results (default 10)' } }, required: ['query'] } },
  { name: 'vector_build', description: 'Build or update the vector embedding index. Uses the local BGE-M3 server (http://127.0.0.1:8077, 1024 dims) if it is running, otherwise falls back to Gemini gemini-embedding-001 (3072 dims). Run once after vault_reload to enable hybrid search (BM25 + vector RRF fusion).', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'vector_stats', description: 'Get vector index status — provider, dimensions, coverage, and whether it is usable for search', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'search_tags', description: 'Find documents by tag', inputSchema: { type: 'object' as const, properties: { tag: { type: 'string' } }, required: ['tag'] } },
  { name: 'search_speaker', description: 'Find documents by speaker/persona', inputSchema: { type: 'object' as const, properties: { speaker: { type: 'string' } }, required: ['speaker'] } },

  // ─── Graph Analysis ───
  { name: 'graph_stats', description: 'Get graph statistics (node count, link count, clusters)', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'graph_pagerank', description: 'Compute PageRank — find most important documents', inputSchema: { type: 'object' as const, properties: { topK: { type: 'number', description: 'Top N results (default 20)' } } } },
  { name: 'graph_clusters', description: 'Detect topic clusters (Louvain communities over the wikilink graph)', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'graph_bridges', description: 'Find bridge documents whose links span two or more topic clusters', inputSchema: { type: 'object' as const, properties: { topK: { type: 'number', description: 'Top N (default 10)' } } } },
  { name: 'graph_implicit_links', description: 'Find implicit links via BM25 cosine similarity', inputSchema: { type: 'object' as const, properties: { minScore: { type: 'number' }, topK: { type: 'number' } } } },
  { name: 'graph_neighbors', description: 'Get direct neighbors of a document', inputSchema: { type: 'object' as const, properties: { docId: { type: 'string' } }, required: ['docId'] } },
  { name: 'vault_propose', description: 'Record an idea, decision or note as an agent PROPOSAL in _agent/ (never directly into the vault). Proposals carry proposed_by: agent frontmatter, rank lower in search, are ignored by the lint, and a person promotes or discards them in the app. Use this whenever the user says to remember/record/write something down. Pass `links` (existing document titles) to wikilink it into the graph; call graph_suggest_links first if unsure.', inputSchema: { type: 'object' as const, properties: {
    title: { type: 'string', description: 'Short title - becomes the file name' },
    body: { type: 'string', description: 'Markdown body' },
    tags: { type: 'array', items: { type: 'string' } },
    links: { type: 'array', items: { type: 'string' }, description: 'Titles of existing documents to link under "## Related"' },
    source: { type: 'string', description: 'Who is proposing (agent/session name), default "agent"' },
  }, required: ['title', 'body'] } },
  { name: 'graph_suggest_links', description: 'Suggest existing documents a text (or an existing document) should link to, ranked by relevance. Use before vault_propose or when adding wikilinks.', inputSchema: { type: 'object' as const, properties: {
    text: { type: 'string', description: 'Free text to find related documents for' },
    docId: { type: 'string', description: 'Or: an existing document id - suggests documents similar to it that it does not link yet' },
    topK: { type: 'number', description: 'Max suggestions (default 5)' },
  } } },
  { name: 'vault_proposals', description: 'List pending agent proposals in _agent/ (path, title, proposedAt, tags).', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'vault_promote', description: 'Promote an agent proposal into the real vault: strips the proposal frontmatter and moves the file out of _agent/ into destFolder (vault root by default). Only a person should decide this - call it when the user explicitly approves a proposal.', inputSchema: { type: 'object' as const, properties: {
    path: { type: 'string', description: 'Vault-relative path of the proposal (e.g. _agent/2026-09-13-combat-notes.md)' },
    destFolder: { type: 'string', description: 'Vault-relative destination folder (default: vault root)' },
  }, required: ['path'] } },
  { name: 'graph_lint', description: 'Lint the vault link graph and return structural findings with severity: phantom-hot (missing documents linked from many places, ranked), bridge-spof (documents whose removal disconnects others), orphan, stale-hub (important but untouched), near-duplicate (similar unlinked pairs), cluster-drift (topic clusters that changed since the last run). Run this before editing or creating documents to see what the vault needs.', inputSchema: { type: 'object' as const, properties: {
    rules: { type: 'array', items: { type: 'string', enum: [...ALL_RULES] }, description: 'Rules to run (default: all)' },
    minSeverity: { type: 'string', enum: ['error', 'warn', 'info'], description: 'Drop findings below this severity (default: info = keep all)' },
    limitPerRule: { type: 'number', description: 'Max findings per rule (default 50)' },
    phantomMinRefs: { type: 'number', description: 'phantom-hot: minimum referring documents (default 3)' },
    staleDays: { type: 'number', description: 'stale-hub: days without change (default 90)' },
    format: { type: 'string', enum: ['json', 'markdown'], description: 'json (default) or a markdown report with wikilinks' },
    saveSnapshot: { type: 'boolean', description: 'Persist the clusters of this run to <vault>/.strata-sync/lint-snapshot.json so the next run can report cluster-drift (default true)' },
  } } },

  // ─── Chat / LLM ───
  { name: 'chat', description: 'Chat with any LLM model (raw)', inputSchema: { type: 'object' as const, properties: { model: { type: 'string', description: 'Model ID (e.g. claude-sonnet-4-6)' }, system: { type: 'string', description: 'System prompt' }, messages: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } }, description: 'Message history' } }, required: ['model', 'messages'] } },
  { name: 'chat_persona', description: 'Chat with a director persona (with project context + RAG)', inputSchema: { type: 'object' as const, properties: { persona: { type: 'string', description: 'Persona ID (chief_director, art_director, etc.)' }, message: { type: 'string' }, history: { type: 'array', items: { type: 'object', properties: { role: { type: 'string' }, content: { type: 'string' } } } }, useRag: { type: 'boolean', description: 'Auto-search vault for context (default true)' } }, required: ['persona', 'message'] } },

  // ─── Edit Agent ───
  { name: 'edit_agent_refine', description: 'Run Edit Agent to refine a document based on instructions', inputSchema: { type: 'object' as const, properties: { path: { type: 'string', description: 'Relative path to the document' }, instructions: { type: 'string', description: 'Refinement instructions' }, model: { type: 'string', description: 'Override model (optional)' } }, required: ['path', 'instructions'] } },

  // ─── Debate (MiroFish) ───
  { name: 'debate_start', description: 'Start a multi-persona debate on a topic', inputSchema: { type: 'object' as const, properties: { topic: { type: 'string' }, personas: { type: 'array', items: { type: 'string' }, description: 'List of persona IDs to participate' }, rounds: { type: 'number', description: 'Number of debate rounds (default 3)' } }, required: ['topic'] } },

  // ─── Python Tools ───
  { name: 'python_run', description: 'Run a Python tool script from the tools/ directory', inputSchema: { type: 'object' as const, properties: { script: { type: 'string', description: 'Script name (e.g. check_quality.py)' }, args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments' } }, required: ['script'] } },
  { name: 'jira_crosslink', description: 'Automatically injects cross-wikilinks between Jira and Active vault. Semantically connects Jira issues with Confluence documents.', inputSchema: { type: 'object' as const, properties: { dry_run: { type: 'boolean', description: 'Preview only (default true). If false, modifies actual files.' } } } },

  // ─── Confluence / Jira Sync ───
  { name: 'confluence_sync', description: 'Sync pages from Confluence to vault', inputSchema: { type: 'object' as const, properties: { spaceKey: { type: 'string', description: 'Override space key (optional)' }, dateFrom: { type: 'string', description: 'Override date filter (optional)' } } } },
  { name: 'jira_sync', description: 'Sync issues from Jira to vault', inputSchema: { type: 'object' as const, properties: { projectKey: { type: 'string', description: 'Override project key (optional)' }, jql: { type: 'string', description: 'Override JQL (optional)' } } } },
  { name: 'jira_create_issue', description: 'Create a new Jira issue and optionally assign to a team member', inputSchema: { type: 'object' as const, properties: { summary: { type: 'string', description: 'Issue title' }, description: { type: 'string', description: 'Issue description' }, issuetype: { type: 'string', description: 'Task | Story | Bug | Sub-task (default: Task)' }, assigneeAccountId: { type: 'string', description: 'Assignee Jira accountId' }, components: { type: 'array', items: { type: 'string' }, description: 'Component name list (e.g. ["[V1_Art] Concept Art", "[V1_Design]"]). See component field in jira-members.md.' }, priority: { type: 'string', description: 'Highest | High | Medium | Low | Lowest (default: Medium)' }, labels: { type: 'array', items: { type: 'string' }, description: 'Label list' }, parentKey: { type: 'string', description: 'Parent Epic/Story key (optional)' } }, required: ['summary'] } },
  { name: 'jira_transition', description: 'Transition a Jira issue status (e.g. To Do → In Progress → Done)', inputSchema: { type: 'object' as const, properties: { issue_key: { type: 'string', description: 'Issue key (e.g. PROJ-123)' }, transition_name: { type: 'string', description: 'Target status name (e.g. "In Progress", "Done"). Not needed if list_only=true.' }, list_only: { type: 'boolean', description: 'If true, only returns the list of available transitions' } }, required: ['issue_key'] } },
  { name: 'jira_get_members', description: 'Get assignable members for the Jira project (with accountId)', inputSchema: { type: 'object' as const, properties: { projectKey: { type: 'string', description: 'Override project key (optional)' } } } },
  { name: 'jira_sprint_move', description: 'Move an existing Jira issue to the active sprint (or a specified sprint)', inputSchema: { type: 'object' as const, properties: { issue_key: { type: 'string', description: 'Issue key (e.g. SGEATF-11862)' }, sprint_id: { type: 'number', description: 'Sprint ID (auto-detects active sprint if not specified)' } }, required: ['issue_key'] } },

  // ─── Confluence Write ───
  { name: 'confluence_write_page', description: 'Create or update a Confluence page with Markdown content', inputSchema: { type: 'object' as const, properties: { mode: { type: 'string', description: '"create" (new page) or "update" (existing page)' }, pageId: { type: 'string', description: 'Required for update mode — target page ID' }, title: { type: 'string', description: 'Page title' }, markdownContent: { type: 'string', description: 'Markdown content to publish' }, spaceKey: { type: 'string', description: 'Space key (create mode, optional — uses config default)' }, parentId: { type: 'string', description: 'Parent page ID (create mode, optional)' } }, required: ['mode', 'title', 'markdownContent'] } },

  // ─── Slack Bot ───
  { name: 'slack_send', description: 'Send a message to a Slack channel', inputSchema: { type: 'object' as const, properties: { channel: { type: 'string' }, text: { type: 'string' } }, required: ['channel', 'text'] } },

  // ─── Usage Tracking ───
  { name: 'usage_summary', description: 'Get LLM usage summary (total tokens, cost)', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'usage_log', description: 'Get detailed usage log entries', inputSchema: { type: 'object' as const, properties: { limit: { type: 'number', description: 'Max entries (default 100)' } } } },

  // ─── Settings ───
  { name: 'settings_get', description: 'Get current MCP server settings', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'settings_update', description: 'Update MCP server settings', inputSchema: { type: 'object' as const, properties: { updates: { type: 'object', description: 'Partial config object to merge' } }, required: ['updates'] } },
]

// ── Tool handlers ───────────────────────────────────────────────────────────

type Args = Record<string, unknown>
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true }

async function handleTool(name: string, args: Args): Promise<ToolResult> {
  const config = getConfig()
  const vaultPath = config.vaultPath

  switch (name) {
    // ─── Vault CRUD ───
    case 'vault_reload': {
      if (!vaultPath) return err('vaultPath not configured')
      const stats = await reloadVault(vaultPath)
      return ok({ message: 'Vault reloaded', ...stats })
    }
    case 'vault_list': {
      if (!vaultPath) return err('vaultPath not configured')
      const result = listFiles(vaultPath, args.folder as string | undefined)
      return ok({ fileCount: result.files.length, folderCount: result.folders.length, files: result.files.map(f => f.relativePath), folders: result.folders })
    }
    case 'vault_read': {
      const abs = safeVaultPath(args.path as string)
      if (!abs) return err('Invalid path or vault not configured')
      const content = readFile(abs)
      if (content === null) return err(`File not found: ${args.path}`)
      return ok({ path: args.path, content })
    }
    case 'vault_write': {
      const abs = safeVaultPath(args.path as string)
      if (!abs) return err('Invalid path or vault not configured')
      const result = saveFile(abs, args.content as string)
      return ok(result)
    }
    case 'vault_delete': {
      const abs = safeVaultPath(args.path as string)
      if (!abs) return err('Invalid path or vault not configured')
      return ok(deleteFile(abs))
    }
    case 'vault_rename': {
      const abs = safeVaultPath(args.path as string)
      if (!abs) return err('Invalid path or vault not configured')
      return ok(renameFile(abs, args.newName as string))
    }
    case 'vault_move': {
      const abs = safeVaultPath(args.path as string)
      const destAbs = safeVaultPath(args.destFolder as string)
      if (!abs || !destAbs) return err('Invalid path or vault not configured')
      return ok(moveFile(abs, destAbs))
    }
    case 'vault_mkdir': {
      const abs = safeVaultPath(args.folder as string)
      if (!abs) return err('Invalid path or vault not configured')
      return ok(createFolder(abs))
    }

    // ─── Search ───
    case 'search_bm25': {
      const query = String(args.query ?? '').trim().slice(0, 500)
      if (!query) return err('query is required')
      const results = bm25Search(query, Math.min((args.topK as number) ?? 10, 100))
      return ok(results)
    }
    case 'vector_build': {
      const result = await buildVectorIndex()
      // Error only when there is no provider at all — partial failures return success with stats
      if (result.error && result.embedded === 0 && result.indexed === 0) return err(result.error)
      return ok(result)
    }
    case 'vector_stats': {
      return ok(getVectorIndexStats())
    }
    case 'search_tags': {
      const tag = String(args.tag ?? '').trim().slice(0, 200).toLowerCase()
      const docs = getDocuments().filter(d => d.tags.some(t => t.toLowerCase() === tag))
      return ok(docs.map(d => ({ id: d.id, filename: d.filename, tags: d.tags, speaker: d.speaker })))
    }
    case 'search_speaker': {
      const speaker = String(args.speaker ?? '').trim().slice(0, 200).toLowerCase()
      const docs = getDocuments().filter(d => d.speaker === speaker)
      return ok(docs.map(d => ({ id: d.id, filename: d.filename, tags: d.tags })))
    }

    // ─── Graph Analysis ───
    case 'graph_stats': {
      const nodes = getNodes()
      const links = getLinks()
      const clusters = detectClusters()
      return ok({ nodeCount: nodes.length, linkCount: links.length, clusterCount: clusters.length, isolatedNodes: nodes.length - clusters.reduce((s, c) => s + c.docIds.length, 0) })
    }
    case 'graph_pagerank': {
      return ok(computePageRank((args.topK as number) ?? 20))
    }
    case 'graph_clusters': {
      return ok(detectClusters())
    }
    case 'graph_bridges': {
      return ok(findBridgeNodes((args.topK as number) ?? 10))
    }
    case 'graph_implicit_links': {
      return ok(findImplicitLinks((args.minScore as number) ?? 0.15, (args.topK as number) ?? 30))
    }
    case 'graph_neighbors': {
      const docId = args.docId as string
      const links = getLinks()
      const neighbors = new Set<string>()
      for (const l of links) {
        if (l.source === docId) neighbors.add(l.target)
        if (l.target === docId) neighbors.add(l.source)
      }
      const docs = getDocuments()
      const idToFilename = new Map(docs.map(d => [d.id, d.filename]))
      return ok([...neighbors].map(id => ({ docId: id, filename: idToFilename.get(id) ?? id })))
    }
    case 'vault_propose': {
      if (!vaultPath) return err('vaultPath not configured')
      const title = String(args.title ?? '').trim()
      const body = String(args.body ?? '').trim()
      if (!title || !body) return err('title and body are required')
      const links = Array.isArray(args.links) ? (args.links as unknown[]).map(String) : []
      const proposal = buildProposal({
        title, body,
        tags: Array.isArray(args.tags) ? (args.tags as unknown[]).map(String) : [],
        links,
        source: typeof args.source === 'string' ? args.source : 'agent',
      })
      // Never overwrite: if the slug already exists today, number it
      let rel = proposal.relPath
      for (let n = 2; existsSync(join(vaultPath, rel)); n++) rel = proposal.relPath.replace(/\.md$/, `-${n}.md`)
      const abs = safeVaultPath(rel)
      if (!abs) return err('invalid proposal path')
      mkdirSync(join(vaultPath, PROPOSAL_FOLDER), { recursive: true })
      const result = saveFile(abs, proposal.content)
      await reloadVault(vaultPath)
      return ok({ ...result, path: rel, title: proposal.title, links, note: 'Proposal saved to _agent/. A person promotes it with vault_promote or from the app.' })
    }
    case 'graph_suggest_links': {
      const topK = Math.min(Math.max(Number(args.topK) || 5, 1), 20)
      const docs = getDocuments()
      const idToTitle = new Map(docs.map(d => [d.id, d.filename.replace(/\.md$/i, '')]))
      const isProposalDoc = (id: string) => isProposalPath(docs.find(d => d.id === id)?.folderPath ?? '')
      if (typeof args.docId === 'string' && args.docId) {
        const doc = docs.find(d => d.id === args.docId)
        if (!doc) return err(`unknown docId ${args.docId}`)
        const linked = new Set(getLinks().flatMap(l => l.source === doc.id ? [l.target] : l.target === doc.id ? [l.source] : []))
        let suggestions = findImplicitLinks(0.1, 500)
          .filter(p => p.docA === doc.id || p.docB === doc.id)
          .map(p => ({ docId: p.docA === doc.id ? p.docB : p.docA, similarity: p.similarity }))
          .filter(s => !linked.has(s.docId) && !isProposalDoc(s.docId))
          .slice(0, topK)
          .map(s => ({ docId: s.docId, title: idToTitle.get(s.docId) ?? s.docId, score: Number(s.similarity.toFixed(3)) }))
        if (suggestions.length === 0) {
          // The implicit-link memo only keeps the global top pairs; fall back to BM25 over the document's own text
          const probe = `${doc.filename.replace(/\.md$/i, '')} ${doc.sections.map(s => s.body).join(' ').slice(0, 1500)}`
          suggestions = bm25Search(probe, topK * 3)
            .filter(h => h.docId !== doc.id && !linked.has(h.docId) && !isProposalDoc(h.docId))
            .slice(0, topK)
            .map(h => ({ docId: h.docId, title: idToTitle.get(h.docId) ?? h.filename.replace(/\.md$/i, ''), score: Number(h.score.toFixed(3)) }))
        }
        return ok({ for: doc.id, suggestions })
      }
      const text = String(args.text ?? '').trim()
      if (!text) return err('text or docId required')
      const hits = bm25Search(text, topK * 2).filter(h => !isProposalDoc(h.docId)).slice(0, topK)
      return ok({ suggestions: hits.map(h => ({ docId: h.docId, title: idToTitle.get(h.docId) ?? h.filename.replace(/\.md$/i, ''), score: Number(h.score.toFixed(3)) })) })
    }
    case 'vault_proposals': {
      if (!vaultPath) return err('vaultPath not configured')
      const dir = join(vaultPath, PROPOSAL_FOLDER)
      if (!existsSync(dir)) return ok({ proposals: [] })
      const docs = getDocuments()
      const proposals = readdirSync(dir).filter(f => f.toLowerCase().endsWith('.md')).sort().reverse().map(f => {
        const rel = `${PROPOSAL_FOLDER}/${f}`
        const doc = docs.find(d => d.folderPath === PROPOSAL_FOLDER && d.filename === f)
        const st = statSync(join(dir, f))
        return { path: rel, title: doc?.title ?? f.replace(/\.md$/i, ''), proposedAt: new Date(st.mtimeMs).toISOString(), tags: doc?.tags ?? [], size: st.size }
      })
      return ok({ proposals })
    }
    case 'vault_promote': {
      if (!vaultPath) return err('vaultPath not configured')
      const rel = String(args.path ?? '').replace(/\\/g, '/')
      if (!isProposalPath(rel) || rel === PROPOSAL_FOLDER) return err('path must be a proposal under _agent/')
      const abs = safeVaultPath(rel)
      if (!abs || !existsSync(abs)) return err(`proposal not found: ${rel}`)
      const destRel = promotedPath(rel, typeof args.destFolder === 'string' ? args.destFolder : '')
      const destAbs = safeVaultPath(destRel)
      if (!destAbs) return err('invalid destination')
      if (existsSync(destAbs)) return err(`destination already exists: ${destRel}`)
      const content = readFile(abs)
      if (content === null) return err(`cannot read ${rel}`)
      mkdirSync(join(destAbs, '..'), { recursive: true })
      saveFile(destAbs, stripProposalFrontmatter(content))
      deleteFile(abs)
      await reloadVault(vaultPath)
      return ok({ promoted: rel, to: destRel })
    }
    case 'graph_lint': {
      if (!vaultPath) return err('vaultPath not configured')
      const docs = getDocuments()
      if (docs.length === 0) return err('vault not loaded — call vault_reload first')
      const rules = Array.isArray(args.rules) ? (args.rules as string[]).filter((r): r is LintRuleId => (ALL_RULES as readonly string[]).includes(r)) : undefined
      const wantsDuplicates = !rules || rules.includes('near-duplicate')
      // Implicit-link memo is global top pairs; anything ≥0.5 comfortably covers the 0.92 default
      const similarPairs = wantsDuplicates ? findImplicitLinks(0.5, 2000) : undefined
      const report = runLint(
        { docs, similarPairs, previousSnapshot: readSnapshot(vaultPath) },
        {
          rules,
          minSeverity: args.minSeverity as LintSeverity | undefined,
          limitPerRule: args.limitPerRule as number | undefined,
          phantomMinRefs: args.phantomMinRefs as number | undefined,
          staleDays: args.staleDays as number | undefined,
        },
      )
      if (args.saveSnapshot !== false) {
        try { writeSnapshot(vaultPath, report.snapshot) } catch (e) { console.error('[graph_lint] snapshot write failed:', e) }
      }
      if (args.format === 'markdown') return { content: [{ type: 'text' as const, text: reportToMarkdown(report) }] }
      const { snapshot: _snapshot, ...withoutSnapshot } = report
      return ok(withoutSnapshot)
    }

    // ─── Chat / LLM ───
    case 'chat': {
      const modelId = args.model as string
      const system = (args.system as string) ?? 'You are a helpful assistant.'
      const messages = args.messages as { role: string; content: string }[]
      const result = await chat(modelId, system, messages, 'mcp_chat')
      return ok({ response: result })
    }
    case 'chat_persona': {
      const persona = args.persona as string
      const message = args.message as string
      const history = (args.history as { role: string; content: string }[]) ?? []
      const useRag = (args.useRag as boolean) ?? true

      let ragContext: string | undefined
      if (useRag) {
        const results = await hybridSearch(message, 10)
        if (results.length > 0) {
          const docs = getDocuments()
          const docMap = new Map(docs.map(d => [d.id, d]))
          const contextParts: string[] = []
          for (const r of results) {
            const doc = docMap.get(r.docId)
            if (doc) contextParts.push(`### ${doc.filename}\n${doc.rawContent.slice(0, 2000)}`)
          }
          ragContext = contextParts.join('\n\n---\n\n')
        }
      }

      const result = await chatWithPersona(persona, message, history, ragContext)
      return ok({ response: result })
    }

    // ─── Edit Agent ───
    case 'edit_agent_refine': {
      const abs = safeVaultPath(args.path as string)
      if (!abs) return err('Invalid path or vault not configured')
      const content = readFile(abs)
      if (content === null) return err(`File not found: ${args.path}`)

      const modelId = (args.model as string) ?? config.editAgent.modelId
      const instructions = args.instructions as string
      const systemPrompt = `You are a document editing agent. You modify documents according to user instructions.
Follow the instructions exactly and return the full modified document. Maintain markdown formatting.
${config.editAgent.refinementManual ? `\nEditing manual:\n${config.editAgent.refinementManual}` : ''}`

      const { text: result, stopReason } = await chatDetailed(modelId, systemPrompt, [
        { role: 'user', content: `## Original Document\n\n${content}\n\n## Editing Instructions\n\n${instructions}\n\nReturn the full modified document.` },
      ], 'mcp_editAgent')

      // Overwriting the original with truncated output would permanently lose the tail of the document — refuse to save
      if (stopReason === 'max_tokens') {
        return err(`LLM output was truncated at the max_tokens limit (stop_reason=max_tokens). The original was not overwritten. Split the document or narrow the scope and try again. (generated length ${result.length} chars)`)
      }
      if (!result.trim()) {
        return err('LLM returned an empty response — the original was not overwritten')
      }

      const saved = saveFile(abs, result)
      if (!saved.success) return err(`Failed to save file: ${args.path}`)
      return ok({ path: args.path, message: 'Document refined and saved', stopReason, preview: result.slice(0, 500) })
    }

    // ─── Debate ───
    case 'debate_start': {
      const topic = args.topic as string
      const personas = (args.personas as string[]) ?? ['chief_director', 'plan_director', 'prog_director']
      const rounds = (args.rounds as number) ?? 3

      const transcript: { round: number; persona: string; message: string }[] = []
      let history: { role: string; content: string }[] = []

      for (let round = 1; round <= rounds; round++) {
        for (const persona of personas) {
          const prompt = round === 1 && history.length === 0
            ? `Topic: "${topic}"\n\nPresent your opinion on this topic from your perspective. Answer in 2-3 paragraphs.`
            : `Topic: "${topic}"\n\nReferring to the previous discussion, present additional opinions or counterarguments from your perspective. Answer in 2-3 paragraphs.`

          const response = await chatWithPersona(persona, prompt, history)
          transcript.push({ round, persona, message: response })
          history.push({ role: 'assistant', content: `[${persona}] ${response}` })
          history.push({ role: 'user', content: 'Let us hear the next participant\'s opinion.' })
        }
      }

      return ok({ topic, rounds, participants: personas, transcript })
    }

    // ─── Jira Crosslink ───
    case 'jira_crosslink': {
      const dryRun = args.dry_run !== false  // default true
      const scriptPath = join(resolve(process.cwd(), '..', 'tools'), 'crosslink_jira.py')
      const scriptArgs = [scriptPath, vaultPath || '.', dryRun ? '--dry-run' : '--apply']
      const { execFile } = await import('child_process')
      return new Promise((res) => {
        execFile(PYTHON_CMD, scriptArgs, { timeout: 120000 },
          (error, stdout, stderr) => {
            if (error) res(err(`Crosslink error: ${error.message}\n${stderr}`))
            else res(ok({ stdout: stdout.trim(), stderr: stderr.trim(), applied: !dryRun }))
          })
      })
    }

    // ─── Python Tools ───
    case 'python_run': {
      const script = args.script as string
      // Prevent path traversal
      if (script.includes('..') || script.includes('/') || script.includes('\\')) {
        return err('Invalid script name — must be a filename only')
      }
      const scriptPath = join(resolve(process.cwd(), '..', 'tools'), script)
      const scriptArgs = (args.args as string[]) ?? []

      const { execFile } = await import('child_process')
      return new Promise((res) => {
        execFile(PYTHON_CMD, [scriptPath, ...scriptArgs], { timeout: 120000, cwd: vaultPath || undefined },
          (error, stdout, stderr) => {
            if (error) res(err(`Python error: ${error.message}\n${stderr}`))
            else res(ok({ stdout: stdout.trim(), stderr: stderr.trim() }))
          })
      })
    }

    // ─── Confluence Sync ───
    case 'confluence_sync': {
      const cfg = config.confluence
      if (!cfg.baseUrl || !cfg.apiToken) return err('Confluence not configured')
      const spaceKey = (args.spaceKey as string) ?? cfg.spaceKey
      const dateFrom = (args.dateFrom as string) ?? cfg.dateFrom

      const authHeader = cfg.authType === 'cloud'
        ? 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')
        : `Bearer ${cfg.apiToken}`

      const fetchOpts: RequestInit & { dispatcher?: unknown } = {
        headers: { 'Authorization': authHeader, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(EXT_TIMEOUT_MS),
      }

      // Fetch all pages with pagination
      const targetDir = join(vaultPath, cfg.targetFolder || 'active')
      if (!(await import('fs')).existsSync(targetDir)) createFolder(targetDir)

      type ConfPage = { title: string; body: { storage: { value: string } }; version: { when: string } }
      const PAGE_LIMIT = 100
      let start = 0, synced = 0, hasMore = true
      // Add a suffix so different pages that normalize to the same filename do not overwrite each other
      const usedFilenames = new Set<string>()
      const renamed: { title: string; filename: string }[] = []
      const failed: string[] = []

      while (hasMore) {
        const url = `${cfg.baseUrl}/rest/api/content?spaceKey=${spaceKey}&expand=body.storage,version&limit=${PAGE_LIMIT}&start=${start}&orderby=lastModified desc`
        const res = await fetch(url, fetchOpts)
        if (!res.ok) return err(`Confluence ${res.status}: ${await res.text()}`)
        const data = await res.json() as { results: ConfPage[]; size: number }
        const pages = data.results ?? []

        for (const page of pages) {
          if (dateFrom && page.version.when < dateFrom) { hasMore = false; break }
          const base = sanitizeFilenameBase(page.title)
          let filename = `${base}.md`
          let n = 2
          while (usedFilenames.has(filename.toLowerCase())) { filename = `${base}_${n++}.md` }
          usedFilenames.add(filename.toLowerCase())
          if (filename !== `${base}.md`) renamed.push({ title: page.title, filename })

          const content = `---\nsource: confluence\ntitle: ${yamlStr(page.title)}\ndate: ${yamlStr(page.version.when.slice(0, 10))}\n---\n\n# ${page.title}\n\n${page.body.storage.value.replace(/<[^>]+>/g, '')}`
          const saved = saveFile(join(targetDir, filename), content)
          if (saved.success) synced++
          else failed.push(filename)
        }

        if (pages.length < PAGE_LIMIT) hasMore = false
        else start += PAGE_LIMIT
      }

      return ok({
        synced, failed: failed.length, targetFolder: cfg.targetFolder,
        ...(failed.length > 0 ? { failedFiles: failed.slice(0, 20) } : {}),
        ...(renamed.length > 0 ? { renamedForCollision: renamed.slice(0, 20), renamedCount: renamed.length } : {}),
      })
    }

    // ─── Jira Sync ───
    case 'jira_sync': {
      const cfg = config.jira
      if (!cfg.baseUrl || !cfg.apiToken) return err('Jira not configured')
      const projectKey = (args.projectKey as string) ?? cfg.projectKey
      const jql = (args.jql as string) ?? cfg.jql ?? `project = ${projectKey} ORDER BY updated DESC`

      const authHeader = cfg.authType === 'cloud'
        ? 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')
        : `Bearer ${cfg.apiToken}`

      const jiraHeaders = { 'Authorization': authHeader, 'Accept': 'application/json' }
      const targetDir = join(vaultPath, cfg.targetFolder || 'jira')
      if (!(await import('fs')).existsSync(targetDir)) createFolder(targetDir)

      type JiraIssue = { key: string; fields: { summary: string; description: string | null; status: { name: string }; assignee: { displayName: string } | null; updated: string } }
      const MAX_RESULTS = 100
      let startAt = 0, synced = 0, total = Infinity
      const failed: string[] = []

      while (startAt < total) {
        const url = `${cfg.baseUrl}/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=${MAX_RESULTS}&startAt=${startAt}&fields=summary,description,status,assignee,updated`
        const res = await fetch(url, { headers: jiraHeaders, signal: AbortSignal.timeout(EXT_TIMEOUT_MS) })
        if (!res.ok) return err(`Jira ${res.status}: ${await res.text()}`)
        const data = await res.json() as { issues: JiraIssue[]; total: number }
        total = data.total ?? 0

        for (const issue of data.issues ?? []) {
          const f = issue.fields
          // Issue keys are unique so they do not collide, but frontmatter must always be escaped
          const filename = `${sanitizeFilenameBase(issue.key)}.md`
          const content = `---\nsource: jira\ntitle: ${yamlStr(f.summary)}\ndate: ${yamlStr(f.updated.slice(0, 10))}\nstatus: ${yamlStr(f.status.name)}\n---\n\n# ${issue.key}: ${f.summary}\n\n**Status:** ${f.status.name}\n**Assignee:** ${f.assignee?.displayName ?? 'Unassigned'}\n\n${f.description ?? ''}`
          const saved = saveFile(join(targetDir, filename), content)
          if (saved.success) synced++
          else failed.push(filename)
        }

        startAt += data.issues?.length ?? MAX_RESULTS
        if (!data.issues?.length) break
      }

      return ok({
        synced, failed: failed.length, total, targetFolder: cfg.targetFolder,
        ...(failed.length > 0 ? { failedFiles: failed.slice(0, 20) } : {}),
      })
    }

    // ─── Jira Create Issue ───
    case 'jira_create_issue': {
      const cfg = config.jira
      if (!cfg.baseUrl || !cfg.apiToken) return err('Jira not configured')
      const projectKey = cfg.projectKey
      if (!projectKey) return err('Jira projectKey not configured')

      const jiraBase = cfg.baseUrl.replace(/\/$/, '')
      const isCloud = cfg.authType === 'cloud'
      const restBase = isCloud ? `${jiraBase}/rest/api/3` : `${jiraBase}/rest/api/2`
      const authHeader = cfg.authType === 'server_pat'
        ? `Bearer ${cfg.apiToken}`
        : 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')

      const summary = args.summary as string
      const description = (args.description as string) ?? ''
      const issuetype = args.issuetype as string | undefined
      const priority = args.priority as string | undefined
      const labels = (args.labels as string[]) ?? []
      const assigneeAccountId = args.assigneeAccountId as string | undefined
      const components = (args.components as string[] | undefined) ?? []
      const parentKey = args.parentKey as string | undefined

      const fields: Record<string, unknown> = {
        project: { key: projectKey },
        summary,
        labels,
      }
      // issuetype: prefer id (numeric string) over name for Server/DC compatibility
      if (issuetype) fields.issuetype = /^\d+$/.test(issuetype) ? { id: issuetype } : { name: issuetype }
      if (priority) fields.priority = { name: priority }
      if (components.length > 0) fields.components = components.map(c => ({ name: c }))
      // Cloud(v3): ADF description + accountId assignee / Server(v2): plain text + name assignee
      if (isCloud) {
        fields.description = { version: 1, type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: description }] }] }
        if (assigneeAccountId) fields.assignee = { accountId: assigneeAccountId }
      } else {
        fields.description = description
        if (assigneeAccountId) fields.assignee = { name: assigneeAccountId }
      }
      if (parentKey) fields.parent = { key: parentKey }

      const authHeaders = { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Accept': 'application/json' }
      const res = await fetch(`${restBase}/issue`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ fields }),
        signal: AbortSignal.timeout(EXT_TIMEOUT_MS),
      })
      if (!res.ok) return err(`Jira ${res.status}: ${await res.text()}`)
      const data = await res.json() as { id: string; key: string }
      const issueKey = data.key

      // ── Auto-assign to active sprint ──────────────────────────────────────
      let sprintId: number | null = null
      try {
        const agileBase = `${jiraBase}/rest/agile/1.0`
        // Use boardId from config if available, otherwise auto-detect scrum board
        let boardId: number | undefined = (cfg as Record<string, unknown>).boardId as number | undefined
        if (!boardId) {
          const boardRes = await fetch(`${agileBase}/board?projectKeyOrId=${encodeURIComponent(projectKey)}&type=scrum&maxResults=10`, { headers: authHeaders, signal: AbortSignal.timeout(EXT_TIMEOUT_MS) })
          if (boardRes.ok) {
            const boardData = await boardRes.json() as { values?: { id: number }[] }
            boardId = boardData?.values?.[0]?.id
          }
        }
        if (boardId) {
          const sprintRes = await fetch(`${agileBase}/board/${boardId}/sprint?state=active&maxResults=1`, { headers: authHeaders, signal: AbortSignal.timeout(EXT_TIMEOUT_MS) })
          if (sprintRes.ok) {
            const sprintData = await sprintRes.json() as { values?: { id: number }[] }
            sprintId = sprintData?.values?.[0]?.id ?? null
          }
        }
      } catch { /* Keep in backlog if sprint lookup fails */ }

      if (sprintId) {
        try {
          await fetch(`${jiraBase}/rest/agile/1.0/sprint/${sprintId}/issue`, {
            method: 'POST', headers: authHeaders, body: JSON.stringify({ issues: [issueKey] }),
            signal: AbortSignal.timeout(EXT_TIMEOUT_MS),
          })
        } catch { /* Ignore if sprint assignment fails */ }
      }

      return ok({ created: true, key: issueKey, id: data.id, url: `${jiraBase}/browse/${issueKey}`, sprintId })
    }

    // ─── Jira Sprint Move ───
    case 'jira_sprint_move': {
      const cfg = config.jira
      if (!cfg.baseUrl || !cfg.apiToken) return err('Jira not configured')
      const issueKey = args.issue_key as string
      if (!issueKey) return err('issue_key is required')

      const jiraBase = cfg.baseUrl.replace(/\/$/, '')
      const authHeader = cfg.authType === 'server_pat'
        ? `Bearer ${cfg.apiToken}`
        : 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')
      const authHeaders = { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Accept': 'application/json' }
      const agileBase = `${jiraBase}/rest/agile/1.0`

      let sprintId = args.sprint_id as number | undefined
      if (!sprintId) {
        // Auto-detect active sprint
        const boardId = (cfg as Record<string, unknown>).boardId as number | undefined
        let resolvedBoardId = boardId
        if (!resolvedBoardId) {
          const boardRes = await fetch(`${agileBase}/board?projectKeyOrId=${encodeURIComponent(cfg.projectKey)}&type=scrum&maxResults=10`, { headers: authHeaders, signal: AbortSignal.timeout(EXT_TIMEOUT_MS) })
          if (boardRes.ok) {
            const bd = await boardRes.json() as { values?: { id: number }[] }
            resolvedBoardId = bd?.values?.[0]?.id
          }
        }
        if (resolvedBoardId) {
          const sprintRes = await fetch(`${agileBase}/board/${resolvedBoardId}/sprint?state=active&maxResults=1`, { headers: authHeaders, signal: AbortSignal.timeout(EXT_TIMEOUT_MS) })
          if (sprintRes.ok) {
            const sd = await sprintRes.json() as { values?: { id: number; name: string }[] }
            sprintId = sd?.values?.[0]?.id
          }
        }
      }
      if (!sprintId) return err('Could not find an active sprint')

      const res = await fetch(`${agileBase}/sprint/${sprintId}/issue`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify({ issues: [issueKey] }),
      })
      if (!res.ok && res.status !== 204) return err(`Sprint move failed: ${res.status} ${await res.text()}`)
      return ok({ moved: true, issueKey, sprintId })
    }

    // ─── Jira Get Members ───
    case 'jira_get_members': {
      const cfg = config.jira
      if (!cfg.baseUrl || !cfg.apiToken) return err('Jira not configured')
      const projectKey = (args.projectKey as string) ?? cfg.projectKey
      if (!projectKey) return err('Jira projectKey not configured')

      const jiraBase = cfg.baseUrl.replace(/\/$/, '')
      const isCloud = cfg.authType === 'cloud'
      const restBase = isCloud ? `${jiraBase}/rest/api/3` : `${jiraBase}/rest/api/2`
      const authHeader = cfg.authType === 'server_pat'
        ? `Bearer ${cfg.apiToken}`
        : 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')

      const url = `${restBase}/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=50`
      const res = await fetch(url, { headers: { 'Authorization': authHeader, 'Accept': 'application/json' } })
      if (!res.ok) return err(`Jira ${res.status}: ${await res.text()}`)
      // Cloud: accountId field / Server: name field (login username)
      const data = await res.json() as { accountId?: string; name?: string; displayName: string; emailAddress?: string }[]
      const members = data.map(u => ({ accountId: u.accountId ?? u.name ?? '', displayName: u.displayName, email: u.emailAddress ?? '' }))

      const configured = config.teamMembers ?? []
      return ok({ members, configuredTeamMembers: configured })
    }

    // ─── Jira Transition ───
    case 'jira_transition': {
      const cfg = config.jira
      if (!cfg.baseUrl || !cfg.apiToken) return err('Jira not configured')
      const issueKey = args.issue_key as string
      if (!issueKey) return err('issue_key is required')
      const transitionName = args.transition_name as string | undefined
      const listOnly = Boolean(args.list_only)

      const jiraBase = cfg.baseUrl.replace(/\/$/, '')
      const restBase = cfg.authType === 'cloud' ? `${jiraBase}/rest/api/3` : `${jiraBase}/rest/api/2`
      const authHeader = cfg.authType === 'server_pat'
        ? `Bearer ${cfg.apiToken}`
        : 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')
      const authHeaders = { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Accept': 'application/json' }

      // Fetch available transitions
      const listRes = await fetch(`${restBase}/issue/${issueKey}/transitions`, { headers: authHeaders, signal: AbortSignal.timeout(EXT_TIMEOUT_MS) })
      if (!listRes.ok) return err(`Jira ${listRes.status}: ${await listRes.text()}`)
      const listData = await listRes.json() as { transitions: { id: string; name: string; to: { name: string } }[] }
      const transitions = listData.transitions ?? []

      if (listOnly || !transitionName) {
        return ok({ transitions: transitions.map(t => ({ id: t.id, name: t.name, to: t.to.name })) })
      }

      // Name matching (case-insensitive)
      const target = transitions.find(t => t.name.toLowerCase() === transitionName.toLowerCase())
      if (!target) {
        return err(`Transition "${transitionName}" not found. Available transitions: ${transitions.map(t => t.name).join(', ')}`)
      }

      const transRes = await fetch(`${restBase}/issue/${issueKey}/transitions`, {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({ transition: { id: target.id } }),
        signal: AbortSignal.timeout(EXT_TIMEOUT_MS),
      })
      if (!transRes.ok && transRes.status !== 204) return err(`Transition failed: ${transRes.status} ${await transRes.text()}`)
      return ok({ transitioned: true, issueKey, from: transitionName, to: target.to.name })
    }

    // ─── Confluence Write Page ───
    case 'confluence_write_page': {
      const cfg = config.confluence
      if (!cfg.baseUrl || !cfg.apiToken) return err('Confluence not configured')
      const mode = (args.mode as string) ?? 'create'
      const title = args.title as string
      const markdownContent = args.markdownContent as string

      const authHeader = cfg.authType === 'server_pat'
        ? `Bearer ${cfg.apiToken}`
        : 'Basic ' + Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')
      const headers = { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' }

      // SSL bypass fetch helper
      const cfFetch = (url: string, opts: { method?: string; headers: Record<string, string>; body?: string }): Promise<{ ok: boolean; status: number; text: () => Promise<string>; json: () => Promise<unknown> }> => {
        if (!cfg.bypassSSL) return fetch(url, { ...opts, signal: AbortSignal.timeout(EXT_TIMEOUT_MS) }) as ReturnType<typeof cfFetch>
        return new Promise((resolve, reject) => {
          const parsed = new URL(url)
          const lib = parsed.protocol === 'https:' ? https : http
          const req = lib.request(url, {
            method: opts.method ?? 'GET',
            headers: opts.headers,
            rejectUnauthorized: false,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            secureOptions: (crypto.constants as any).SSL_OP_LEGACY_SERVER_CONNECT,
          }, (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf-8')
              resolve({
                ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
                status: res.statusCode ?? 0,
                text: async () => raw,
                json: async () => JSON.parse(raw),
              })
            })
          })
          req.on('error', reject)
          req.setTimeout(EXT_TIMEOUT_MS, () => { req.destroy(new Error('timeout')) })
          if (opts.body) req.write(opts.body)
          req.end()
        })
      }
      const fetchOpts = (body?: string) => ({
        headers,
        ...(body !== undefined ? { body } : {}),
      })

      // Simple Markdown → Confluence storage converter
      function mdToStorage(md: string): string {
        const codeBlocks: string[] = []
        let s = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
          const idx = codeBlocks.length
          codeBlocks.push(`<ac:structured-macro ac:name="code">${lang ? `<ac:parameter ac:name="language">${lang}</ac:parameter>` : ''}<ac:plain-text-body><![CDATA[${code.trim()}]]></ac:plain-text-body></ac:structured-macro>`)
          return `\x00CODE${idx}\x00`
        })
        s = s.replace(/^#### (.+)$/gm, '<h4>$1</h4>').replace(/^### (.+)$/gm, '<h3>$1</h3>').replace(/^## (.+)$/gm, '<h2>$1</h2>').replace(/^# (.+)$/gm, '<h1>$1</h1>')
        s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>').replace(/`([^`]+)`/g, '<code>$1</code>')
        s = s.replace(/((?:^[ \t]*[-*] .+\n?)+)/gm, (b: string) => `<ul>${b.trim().split('\n').map((l: string) => `<li>${l.replace(/^[ \t]*[-*] /, '')}</li>`).join('')}</ul>\n`)
        const parts = s.split(/\n{2,}/).map((b: string) => {
          const t = b.trim(); if (!t) return ''
          if (t.startsWith('<') || t.startsWith('\x00CODE')) return t
          return `<p>${t.replace(/\n/g, '<br />')}</p>`
        }).filter(Boolean)
        let result = parts.join('\n')
        // A replacement **function** is required — passing a plain string would let
        // `$&` / `$1` / `$$` inside code blocks be interpreted as replacement patterns and corrupt the code.
        codeBlocks.forEach((code: string, i: number) => { result = result.replace(`\x00CODE${i}\x00`, () => code) })
        return result
      }

      const storageBody = mdToStorage(markdownContent)

      if (mode === 'update') {
        const pageId = args.pageId as string
        if (!pageId) return err('pageId required for update mode')
        // Fetch current version
        const infoRes = await cfFetch(`${cfg.baseUrl}/rest/api/content/${pageId}?expand=version`, fetchOpts())
        if (!infoRes.ok) return err(`Confluence ${infoRes.status}: ${await infoRes.text()}`)
        const info = await infoRes.json() as { version: { number: number }; space: { key: string } }
        const newVersion = (info.version?.number ?? 1) + 1
        const putBody = JSON.stringify({ version: { number: newVersion }, title, type: 'page', body: { storage: { value: storageBody, representation: 'storage' } } })
        const res = await cfFetch(`${cfg.baseUrl}/rest/api/content/${pageId}`, { method: 'PUT', ...fetchOpts(putBody) })
        if (!res.ok) return err(`Confluence ${res.status}: ${await res.text()}`)
        const data = await res.json() as { id: string; _links?: { webui?: string } }
        return ok({ id: data.id, url: `${cfg.baseUrl}${data._links?.webui ?? ''}`, mode: 'updated' })
      } else {
        const spaceKey = (args.spaceKey as string) || cfg.spaceKey
        if (!spaceKey) return err('spaceKey required for create mode')
        const ancestors = args.parentId ? [{ id: args.parentId as string }] : []
        const postBody = JSON.stringify({ type: 'page', title, space: { key: spaceKey }, ancestors, body: { storage: { value: storageBody, representation: 'storage' } } })
        const res = await cfFetch(`${cfg.baseUrl}/rest/api/content`, { method: 'POST', ...fetchOpts(postBody) })
        if (!res.ok) return err(`Confluence ${res.status}: ${await res.text()}`)
        const data = await res.json() as { id: string; _links?: { webui?: string } }
        return ok({ id: data.id, url: `${cfg.baseUrl}${data._links?.webui ?? ''}`, mode: 'created' })
      }
    }

    // ─── Slack ───
    case 'slack_send': {
      const cfg = config.slackBot
      if (!cfg.botToken) return err('Slack bot not configured')
      const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.botToken}` },
        body: JSON.stringify({ channel: args.channel, text: args.text }),
      })
      const data = await res.json() as { ok: boolean; error?: string; ts?: string }
      if (!data.ok) return err(`Slack error: ${data.error}`)
      return ok({ sent: true, ts: data.ts })
    }

    // ─── Usage Tracking ───
    case 'usage_summary': {
      return ok(getUsageSummary())
    }
    case 'usage_log': {
      return ok(getUsageLog((args.limit as number) ?? 100))
    }

    // ─── Settings ───
    case 'settings_get': {
      const cfg = { ...getConfig() }
      // Mask API keys for security
      const masked: Record<string, string> = {}
      for (const [k, v] of Object.entries(cfg.apiKeys)) {
        masked[k] = v ? `${v.slice(0, 8)}...${v.slice(-4)}` : '(not set)'
      }
      return ok({ ...cfg, apiKeys: masked })
    }
    case 'settings_update': {
      const updates = args.updates as Record<string, unknown>
      updateConfig(updates)
      return ok({ message: 'Settings updated', updatedKeys: Object.keys(updates) })
    }

    default:
      return err(`Unknown tool: ${name}`)
  }
}

// ── MCP Gate Prompt ─────────────────────────────────────────────────────────
// Injected when Claude Code connects — tells the model it's in MCP control mode.

const GATE_PROMPT = `You are now connected to the **Strata Sync MCP Server**.

## Mode: MCP Full Control
- GUI API keys are not used. All LLM calls go through this MCP server.
- You directly control all Strata Sync features through sub-agents.
- Vault CRUD, graph analysis, chat, search, Edit Agent, debate, Python tools,
  Confluence/Jira sync, Slack bot, usage tracking, settings — all controllable via MCP tools.

## Available Tools (37)
| Category | Tools |
|---------|------|
| Vault CRUD | vault_reload, vault_list, vault_read, vault_write, vault_delete, vault_rename, vault_move, vault_mkdir |
| Search | search_bm25, vector_build, vector_stats, search_tags, search_speaker |
| Graph Analysis | graph_stats, graph_pagerank, graph_clusters, graph_bridges, graph_implicit_links, graph_neighbors |
| Chat / LLM | chat, chat_persona |
| Edit Agent | edit_agent_refine |
| Debate | debate_start |
| Python Tools | python_run |
| External Integration | confluence_sync, confluence_write_page, jira_sync, jira_create_issue, jira_get_members, slack_send |
| Usage | usage_summary, usage_log |
| Settings | settings_get, settings_update |

## Key Principles
1. **Call vault_reload first** — Load the vault before using search/graph tools.
2. **Collect context with search_bm25** → persona chat with chat_persona — RAG pipeline.
3. **edit_agent_refine** for automatic document refinement — just provide instructions, LLM edits and saves.
4. **graph_stats → graph_pagerank → graph_clusters** — recommended order for understanding vault structure.
5. Cost tracking: check current session tokens/cost with usage_summary.

This prompt is automatically injected when passing through the MCP gate.`

// ── Create server ───────────────────────────────────────────────────────────

export function createServer(): Server {
  const server = new Server(
    { name: 'strata-sync', version: '0.4.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  )

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      return await handleTool(name, (args ?? {}) as Args)
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e))
    }
  })

  // List resources (vault docs as MCP resources)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const docs = getDocuments()
    return {
      resources: docs.slice(0, 200).map(d => ({
        uri: `vault://${d.id}`,
        name: d.filename,
        mimeType: 'text/markdown',
        description: `Speaker: ${d.speaker}, Tags: ${d.tags.join(', ')}`,
      })),
    }
  })

  // Read resource
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri
    const docId = uri.replace('vault://', '')
    const doc = getDocuments().find(d => d.id === docId)
    return {
      contents: [{
        uri,
        mimeType: 'text/markdown',
        text: doc?.rawContent ?? `Document not found: ${docId}`,
      }],
    }
  })

  // List prompts — exposes the gate prompt
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [{
      name: 'strata-sync-gate',
      description: 'Strata Sync MCP full control mode — system prompt auto-injected on connection',
    }],
  }))

  // Get prompt — returns the gate prompt content
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== 'strata-sync-gate') {
      throw new Error(`Unknown prompt: ${req.params.name}`)
    }
    return {
      description: 'Strata Sync MCP full control mode',
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: GATE_PROMPT } }],
    }
  })

  return server
}
