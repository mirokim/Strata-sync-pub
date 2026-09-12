/**
 * Dependency-free markdown → LintDocument parser for environments without gray-matter (the
 * Cloudflare Worker). Understands the frontmatter keys the graph core cares about (tags, links,
 * graph_weight, date) and extracts wikilinks and heading sections. Ids match the MCP parser's
 * `filePathToDocId` so server-side results line up with the app's.
 */
import type { LintDocument } from './document.js'

export interface ParsedVaultDoc extends LintDocument {
  title: string
  date: string
  /** Body without frontmatter. */
  body: string
  /** Heading-delimited chunks with text, for embedding. */
  sections: { id: string; heading: string; body: string; wikiLinks: string[] }[]
}

/** Same rule as mcp/src/parser.ts filePathToDocId — keep in sync. */
export function docIdFromPath(relativePath: string): string {
  return relativePath
    .replace(/\.md$/i, '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_가-힣]/gi, '')
    .toLowerCase()
    .replace(/^_+|_+$/g, '')
    || 'unnamed'
}

export function extractWikiLinks(text: string): string[] {
  const out: string[] = []
  const re = /(?<!!)\[\[(.*?)\]\]/gs
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) { const t = m[1].trim(); if (t) out.push(t) }
  return out
}

/** Minimal YAML-ish frontmatter: `key: value`, `key: [a, b]`, `key:\n  - a\n  - b`, quoted scalars. */
export function parseFrontmatter(text: string): { data: Record<string, string | string[]>; body: string } {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { data: {}, body: text }
  const block = text.slice(3, end).replace(/^\r?\n/, '')
  const body = text.slice(end + 4).replace(/^\r?\n/, '')
  const data: Record<string, string | string[]> = {}
  const lines = block.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!kv) continue
    const key = kv[1]
    let value = kv[2].trim()
    if (value === '') {
      // block list
      const items: string[] = []
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) { items.push(unquote(lines[++i].replace(/^\s*-\s+/, ''))); }
      data[key] = items
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value.slice(1, -1).split(',').map(s => unquote(s.trim())).filter(Boolean)
      continue
    }
    data[key] = unquote(value)
  }
  return { data, body }
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  if (Array.isArray(v)) return v.map(String).filter(Boolean)
  return v.split(',').map(s => s.trim()).filter(Boolean)
}

/** Split on H1–H3 headings; text before the first heading is the `(intro)` section. */
export function splitSections(body: string, docId: string): ParsedVaultDoc['sections'] {
  const parts = body.split(/^(?=#{1,3}\s)/m)
  const sections: ParsedVaultDoc['sections'] = []
  const used = new Map<string, number>()
  for (const part of parts) {
    const text = part.trim()
    if (!text) continue
    const m = /^(#{1,3})\s+(.+)$/m.exec(text.split('\n')[0])
    const heading = m ? m[2].trim() : '(intro)'
    const sectionBody = m ? text.slice(text.indexOf('\n') + 1).trim() : text
    if (!m && !sectionBody) continue
    const base = `${docId}_${m ? slug(heading) : 'intro'}` || `${docId}_section`
    const n = used.get(base) ?? 0
    used.set(base, n + 1)
    sections.push({ id: n === 0 ? base : `${base}_${n + 1}`, heading, body: sectionBody, wikiLinks: extractWikiLinks(text) })
  }
  return sections
}

function slug(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_가-힣]/g, '')
}

export function parseVaultDoc(relativePath: string, content: string, mtime?: number): ParsedVaultDoc {
  const rel = relativePath.replace(/\\/g, '/')
  const { data, body } = parseFrontmatter(content)
  const id = docIdFromPath(rel)
  const parts = rel.split('/')
  const filename = parts[parts.length - 1]
  const folderPath = parts.slice(0, -1).join('/')
  const gw = typeof data.graph_weight === 'string' ? data.graph_weight.toLowerCase() : ''
  return {
    id, filename, folderPath, mtime,
    title: typeof data.title === 'string' && data.title ? data.title : filename.replace(/\.md$/i, ''),
    date: typeof data.date === 'string' ? data.date : '',
    tags: asList(data.tags),
    links: asList(data.links),
    graphWeight: gw === 'low' || gw === 'skip' ? gw : undefined,
    body,
    sections: splitSections(body, id),
  }
}
