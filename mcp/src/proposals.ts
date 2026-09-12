/**
 * Agent proposals — the discipline that lets agents write into the vault without polluting it.
 *
 * Anything an agent records goes to `_agent/YYYY-MM-DD-<slug>.md` with `proposed_by: agent`
 * frontmatter. Search weights those documents down, the lint ignores the folder, and a person
 * promotes a proposal into the real vault (frontmatter stripped, file moved) or discards it.
 *
 * Pure helpers here; the MCP tool handlers in server.ts do the filesystem work.
 */

export const PROPOSAL_FOLDER = '_agent'
export const PROPOSAL_MARKER = 'proposed_by'
/** BM25 / RAG multiplier applied to documents that are still proposals. */
export const PROPOSAL_SCORE_WEIGHT = 0.5

export interface ProposalInput {
  title: string
  body: string
  tags?: string[]
  /** Wikilink targets (document titles) to append under "## Related". */
  links?: string[]
  /** Who/what produced it — an agent name or session label. */
  source?: string
  now?: number
}

export interface Proposal {
  /** Vault-relative path, forward slashes. */
  relPath: string
  content: string
  title: string
}

/** File-name safe slug that keeps Korean; falls back to 'note'. */
export function slugForTitle(title: string): string {
  const s = title.trim().toLowerCase()
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return s.slice(0, 60) || 'note'
}

function yamlList(items: string[]): string {
  return `[${items.map(i => JSON.stringify(i)).join(', ')}]`
}

export function buildProposal(input: ProposalInput): Proposal {
  const now = input.now ?? Date.now()
  const title = input.title.trim() || 'Untitled proposal'
  const date = new Date(now).toISOString().slice(0, 10)
  const relPath = `${PROPOSAL_FOLDER}/${date}-${slugForTitle(title)}.md`
  const tags = (input.tags ?? []).map(t => t.trim()).filter(Boolean)
  const links = [...new Set((input.links ?? []).map(l => l.trim()).filter(Boolean))]

  const fm = [
    '---',
    `title: ${JSON.stringify(title)}`,
    `${PROPOSAL_MARKER}: agent`,
    `proposed_at: ${new Date(now).toISOString()}`,
    `proposed_source: ${JSON.stringify(input.source ?? 'agent')}`,
    'status: proposed',
    `tags: ${yamlList(['proposal', ...tags])}`,
    '---',
  ].join('\n')

  const body = input.body.trim()
  const related = links.length ? `\n\n## Related\n\n${links.map(l => `- [[${l}]]`).join('\n')}\n` : '\n'
  return { relPath, title, content: `${fm}\n\n# ${title}\n\n${body}${related}` }
}

export function isProposalPath(relPath: string): boolean {
  const p = relPath.replace(/\\/g, '/')
  return p === PROPOSAL_FOLDER || p.startsWith(`${PROPOSAL_FOLDER}/`)
}

/**
 * Promotion: drop the proposal bookkeeping from the frontmatter and the 'proposal' tag, keep
 * everything else. Returns the content unchanged when there is no frontmatter.
 */
export function stripProposalFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  const end = content.indexOf('\n---', 3)
  if (end < 0) return content
  const head = content.slice(3, end).replace(/^\r?\n/, '')
  const rest = content.slice(end + 4)
  const kept = head.split(/\r?\n/).filter(line => {
    const key = line.split(':')[0].trim()
    return !['proposed_by', 'proposed_at', 'proposed_source', 'status'].includes(key)
  }).map(line => {
    if (!line.startsWith('tags:')) return line
    // tags: ["proposal", "x"] → tags: ["x"]; tags: proposal, x → tags: x
    const value = line.slice(5).trim()
    if (value.startsWith('[')) {
      const items = value.slice(1, -1).split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(s => s && s !== 'proposal')
      return `tags: ${yamlList(items)}`
    }
    const items = value.split(',').map(s => s.trim()).filter(s => s && s !== 'proposal')
    return items.length ? `tags: ${items.join(', ')}` : 'tags: []'
  })
  return `---\n${kept.join('\n')}\n---${rest}`
}

/** Destination path for a promoted proposal: strips the date prefix, lands in `destFolder`. */
export function promotedPath(relPath: string, destFolder: string): string {
  const name = relPath.replace(/\\/g, '/').split('/').pop() ?? relPath
  const bare = name.replace(/^\d{4}-\d{2}-\d{2}-/, '')
  const folder = destFolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return folder ? `${folder}/${bare}` : bare
}
