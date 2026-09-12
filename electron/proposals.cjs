/**
 * Agent proposals for the Electron main process — the `/propose` RAG API endpoint used by the
 * Slack/Telegram bots.
 *
 * This mirrors mcp/src/proposals.ts (the MCP server and the renderer use that TypeScript module).
 * The main process cannot import it, so the rules are duplicated here and pinned by
 * electron/__tests__/proposals.test.ts, which runs both implementations on the same inputs.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const PROPOSAL_FOLDER = '_agent'

function slugForTitle(title) {
  const s = String(title).trim().toLowerCase()
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s.slice(0, 60) || 'note'
}

function yamlList(items) {
  return `[${items.map(i => JSON.stringify(i)).join(', ')}]`
}

/**
 * @param {{ title: string, body: string, tags?: string[], links?: string[], source?: string, now?: number }} input
 * @returns {{ relPath: string, content: string, title: string }}
 */
function buildProposal(input) {
  const now = input.now ?? Date.now()
  const title = String(input.title || '').trim() || 'Untitled proposal'
  const date = new Date(now).toISOString().slice(0, 10)
  const relPath = `${PROPOSAL_FOLDER}/${date}-${slugForTitle(title)}.md`
  const tags = (input.tags || []).map(t => String(t).trim()).filter(Boolean)
  const links = [...new Set((input.links || []).map(l => String(l).trim()).filter(Boolean))]
  const fm = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'proposed_by: agent',
    `proposed_at: ${new Date(now).toISOString()}`,
    `proposed_source: ${JSON.stringify(input.source || 'agent')}`,
    'status: proposed',
    `tags: ${yamlList(['proposal', ...tags])}`,
    '---',
  ].join('\n')
  const body = String(input.body || '').trim()
  const related = links.length ? `\n\n## Related\n\n${links.map(l => `- [[${l}]]`).join('\n')}\n` : '\n'
  return { relPath, title, content: `${fm}\n\n# ${title}\n\n${body}${related}` }
}

/**
 * Write a proposal into the vault without overwriting an existing one (numbers duplicates).
 * @returns {{ relPath: string, absolutePath: string, title: string }}
 */
function writeProposal(vaultPath, input) {
  const proposal = buildProposal(input)
  let rel = proposal.relPath
  for (let n = 2; fs.existsSync(path.join(vaultPath, rel)); n++) rel = proposal.relPath.replace(/\.md$/, `-${n}.md`)
  const abs = path.join(vaultPath, rel)
  // Stay inside the vault even if a title smuggled in separators
  const root = path.resolve(vaultPath)
  if (!path.resolve(abs).startsWith(root + path.sep)) throw new Error('proposal path escapes the vault')
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, proposal.content, 'utf-8')
  return { relPath: rel, absolutePath: abs, title: proposal.title }
}

module.exports = { PROPOSAL_FOLDER, slugForTitle, buildProposal, writeProposal }
