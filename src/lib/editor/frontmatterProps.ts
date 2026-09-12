/**
 * Frontmatter as properties — a line-level YAML reader for the editor's properties widget.
 *
 * gray-matter gives us parsed values but no line positions; the widget needs both, because editing
 * a property replaces exactly one line of the document. Only the YAML shapes people write by hand
 * are handled: `key: scalar`, `key: [a, b]`, `key:` followed by `  - item` lines, and quoted
 * strings. Anything else is shown as a read-only "edit in source" row.
 */

export interface FrontmatterBlock {
  /** Document offset of the opening `---` line start */
  from: number
  /** Document offset just after the closing `---` line (excluding the trailing newline) */
  to: number
  /** 1-based line numbers of the opening and closing fences */
  openLine: number
  closeLine: number
  props: FrontmatterProp[]
}

export type PropKind = 'text' | 'number' | 'boolean' | 'date' | 'list' | 'block'

export interface FrontmatterProp {
  key: string
  kind: PropKind
  /** Display value: string for scalars, string[] for lists, raw lines for blocks */
  value: string | string[]
  /** 1-based line number of the `key:` line */
  line: number
  /** Lines occupied by the property (block values span several) */
  lineCount: number
}

const FENCE = /^---\s*$/
const KEY_LINE = /^([A-Za-z0-9_][\w.\- ]*?)\s*:(?:\s+(.*))?$/

/** Locate the frontmatter block at the top of `text`; null when the document has none. */
export function findFrontmatter(text: string): FrontmatterBlock | null {
  const lines = text.split('\n')
  if (!FENCE.test(lines[0] ?? '')) return null
  let close = -1
  for (let i = 1; i < lines.length; i++) if (FENCE.test(lines[i])) { close = i; break }
  if (close < 0) return null
  const props = parseProps(lines.slice(1, close), 2)
  let to = 0
  for (let i = 0; i <= close; i++) to += lines[i].length + (i < close ? 1 : 0)
  return { from: 0, to, openLine: 1, closeLine: close + 1, props }
}

function parseProps(lines: string[], firstLineNo: number): FrontmatterProp[] {
  const props: FrontmatterProp[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = KEY_LINE.exec(lines[i])
    if (!m) continue
    const key = m[1].trim()
    const inline = (m[2] ?? '').trim()
    if (inline) {
      props.push({ key, line: firstLineNo + i, lineCount: 1, ...classify(inline) })
      continue
    }
    // Block value: indented or `- item` lines that follow
    let j = i + 1
    const block: string[] = []
    while (j < lines.length && (/^\s+\S/.test(lines[j]) || /^-\s/.test(lines[j]))) { block.push(lines[j]); j++ }
    if (block.length && block.every(l => /^\s*-\s+/.test(l))) {
      props.push({ key, kind: 'list', value: block.map(l => unquote(l.replace(/^\s*-\s+/, ''))), line: firstLineNo + i, lineCount: 1 + block.length })
    } else if (block.length) {
      props.push({ key, kind: 'block', value: block, line: firstLineNo + i, lineCount: 1 + block.length })
    } else {
      props.push({ key, kind: 'text', value: '', line: firstLineNo + i, lineCount: 1 })
    }
    i = j - 1
  }
  return props
}

function classify(raw: string): { kind: PropKind; value: string | string[] } {
  if (/^\[.*\]$/.test(raw)) return { kind: 'list', value: splitList(raw.slice(1, -1)) }
  if (/^(true|false)$/i.test(raw)) return { kind: 'boolean', value: raw.toLowerCase() }
  if (/^-?\d+(\.\d+)?$/.test(raw)) return { kind: 'number', value: raw }
  if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(raw)) return { kind: 'date', value: raw }
  return { kind: 'text', value: unquote(raw) }
}

function splitList(inner: string): string[] {
  const out: string[] = []
  let cur = '', quote: string | null = null
  for (const ch of inner) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === ',') { if (cur.trim()) out.push(cur.trim()); cur = ''; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

function unquote(s: string): string {
  const t = s.trim()
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1)
  return t
}

/** Quote a scalar only when YAML would otherwise misread it. */
export function yamlScalar(value: string): string {
  const v = value.trim()
  if (v === '') return '""'
  if (/^[\[\]{}#&*!|>'"%@`]/.test(v) || /[:#]\s|^\s|\s$|,/.test(v) || /^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(v)) return JSON.stringify(v)
  return v
}

/** The single YAML line that stores `value` under `key` (lists as `[a, b]`). */
export function propLine(key: string, kind: PropKind, value: string | string[]): string {
  if (Array.isArray(value)) return `${key}: [${value.map(yamlScalar).join(', ')}]`
  if (kind === 'boolean' || kind === 'number' || kind === 'date') return `${key}: ${value}`
  return `${key}: ${yamlScalar(value)}`
}
