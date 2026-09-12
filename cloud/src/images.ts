/**
 * Image documents — an image is only part of the shared brain once it has words. When an image
 * lands in the vault (pasted in the app, uploaded by Obsidian), a vision model describes it and
 * the description is written into a markdown "image document" next to it (`foo.png` → `foo.md`):
 * the embed, where it was pasted, what it shows, the text visible in it, a few tags. From then on
 * search, the graph, recall and the members see the image like any other document. The prompt
 * that would have generated the image, recovered from the image — the same idea in reverse.
 *
 * The description is a first draft: a person or a member can edit the document freely; only the
 * `## Description` section is replaced when the image itself changes.
 */
import { putFile, type SyncDeps } from './sync.js'
import { parseFrontmatter } from '../../mcp/src/lint/vaultDoc.js'

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
/** Vision models choke on very large inputs; skip rather than fail the queue. */
export const IMAGE_MAX_BYTES = 6 * 1024 * 1024
export const DESCRIBE_AUTHOR = 'strata-bot'
export const DESCRIBING_PLACEHOLDER = '_(describing…)_'

export const DESCRIBE_PROMPT = [
  'Describe this image for a knowledge-base search index.',
  'Say what it shows and how it is composed, in two to five sentences.',
  'If there is visible text, transcribe it exactly under a line "Text:".',
  'End with a line "Tags:" followed by three to six lowercase tags separated by commas.',
  'Be concrete. No preamble.',
].join(' ')

export interface DescribeJob { kind: 'describe'; path: string; etag?: string }

export interface DescribeDeps extends SyncDeps {
  /** Vision model call: image bytes + prompt → description text. */
  describe: (bytes: Uint8Array, mime: string, prompt: string) => Promise<string>
  /** Recorded in the document as `described_by`. */
  model?: string
  log?: (msg: string) => void
}

export type DescribeOutcome =
  | { status: 'described'; doc: string; chars: number }
  | { status: 'skipped'; reason: string }

const enc = new TextEncoder()
const dec = new TextDecoder()

export function isImagePath(path: string): boolean {
  const p = path.replace(/\\/g, '/')
  return IMAGE_EXT.test(p) && !p.split('/').some(s => s.startsWith('.') || s === '_system')
}

/** `attachments/2026-09/pasted-x.png` → `attachments/2026-09/pasted-x.md` */
export function imageDocPath(imagePath: string): string {
  return imagePath.replace(/\\/g, '/').replace(IMAGE_EXT, '.md')
}

export function mimeOf(path: string): string {
  const ext = (path.match(/\.(\w+)$/)?.[1] ?? '').toLowerCase()
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' } as Record<string, string>)[ext] ?? 'application/octet-stream'
}

/** The document a client writes at paste time, before any model has looked at the image. */
export interface Described { by: string; at: number; imageEtag: string }

function describedLines(d: Described): string[] {
  return [`described_by: ${JSON.stringify(d.by)}`, `described_at: ${new Date(d.at).toISOString()}`, `described_image_etag: ${JSON.stringify(d.imageEtag)}`]
}

export function renderImageDoc(input: { imagePath: string; pastedInto?: string; description?: string; described?: Described }): string {
  const file = input.imagePath.replace(/\\/g, '/').split('/').pop()!
  const name = file.replace(IMAGE_EXT, '')
  const tags = ['image', ...tagsFrom(input.description ?? '')]
  const fm = [
    '---',
    `title: ${JSON.stringify(name)}`,
    'type: image',
    `image: ${JSON.stringify(file)}`,
    ...(input.pastedInto ? [`pasted_into: ${JSON.stringify(input.pastedInto)}`] : []),
    ...(input.described ? describedLines(input.described) : []),
    `tags: [${tags.join(', ')}]`,
    '---',
  ]
  const body = [
    `# ${name}`,
    '',
    `![[${file}]]`,
    '',
    ...(input.pastedInto ? [`Pasted into [[${input.pastedInto.replace(/\.md$/i, '').split('/').pop()}]]`, ''] : []),
    '## Description',
    '',
    input.description?.trim() || DESCRIBING_PLACEHOLDER,
    '',
  ]
  return [...fm, '', ...body].join('\n')
}

/** `Tags: a, b, c` line of a description → clean tag slugs. */
export function tagsFrom(description: string): string[] {
  const m = /^\s*tags?\s*:\s*(.+)$/im.exec(description)
  if (!m) return []
  return [...new Set(m[1].split(/[,、]/).map(t => t.trim().toLowerCase().replace(/^#/, '').replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')).filter(t => t && t.length <= 40))].slice(0, 6)
}

/** Replace the `## Description` section (and the description frontmatter) of an existing image document. */
export function setDescription(markdown: string, description: string, described: Described): string {
  const { data, body } = parseFrontmatter(markdown)
  const text = description.trim()
  const tags = new Set<string>(['image', ...(Array.isArray(data.tags) ? data.tags : typeof data.tags === 'string' ? [data.tags] : []).map(String), ...tagsFrom(text)])
  // Rebuild the frontmatter from what we know; unknown keys survive as plain strings
  const keep = Object.entries(data).filter(([k]) => !['tags', 'described_by', 'described_at', 'described_image_etag'].includes(k))
  const fm = ['---', ...keep.map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : JSON.stringify(String(v))}`), ...describedLines(described), `tags: [${[...tags].join(', ')}]`, '---']
  const lines = body.replace(/\r/g, '').split('\n')
  const start = lines.findIndex(l => /^##\s+Description\s*$/i.test(l))
  let next: string[]
  if (start < 0) {
    next = [...lines, '', '## Description', '', text, '']
  } else {
    let end = lines.length
    for (let i = start + 1; i < lines.length; i++) if (/^##\s+/.test(lines[i])) { end = i; break }
    next = [...lines.slice(0, start + 1), '', text, '', ...lines.slice(end)]
  }
  return [...fm, '', ...next].join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n'
}

/** Which image version the document's description was written for. */
export function describedImageEtag(markdown: string): string | undefined {
  const { data } = parseFrontmatter(markdown)
  return typeof data.described_image_etag === 'string' ? data.described_image_etag : undefined
}

/**
 * Describe one image and write (or update) its document. Idempotent per image version: the
 * document's `described_at` is only touched when the model actually ran.
 */
export async function describeImage(deps: DescribeDeps, job: DescribeJob): Promise<DescribeOutcome> {
  const log = deps.log ?? (() => {})
  const path = job.path.replace(/\\/g, '/')
  if (!isImagePath(path)) return { status: 'skipped', reason: 'not an image' }
  const row = await deps.meta.get(path)
  if (!row || row.deleted) return { status: 'skipped', reason: 'image gone' }
  if (job.etag && job.etag !== row.etag) return { status: 'skipped', reason: 'superseded by a newer upload' }
  if (row.size > IMAGE_MAX_BYTES) return { status: 'skipped', reason: 'image too large to describe' }
  const bytes = await deps.blobs.get(path)
  if (!bytes) return { status: 'skipped', reason: 'content missing' }

  const docPath = imageDocPath(path)
  const existingRow = await deps.meta.get(docPath)
  const existing = existingRow && !existingRow.deleted ? await deps.blobs.get(docPath) : null
  const existingText = existing ? dec.decode(existing) : null
  // Already described for this very image version → nothing to do
  if (existingText && describedImageEtag(existingText) === row.etag) return { status: 'skipped', reason: 'already described' }

  const text = (await deps.describe(bytes, mimeOf(path), DESCRIBE_PROMPT)).trim()
  if (!text) return { status: 'skipped', reason: 'model returned nothing' }
  const now = (deps.now ?? Date.now)()
  const described: Described = { by: deps.model ?? 'vision-model', at: now, imageEtag: row.etag }
  const markdown = existingText ? setDescription(existingText, text, described) : renderImageDoc({ imagePath: path, description: text, described })
  const put = await putFile(deps, { path: docPath, body: enc.encode(markdown), mtime: now, author: DESCRIBE_AUTHOR, ...(existingRow && !existingRow.deleted ? { ifMatch: existingRow.etag } : { createOnly: true }) })
  if (put.status >= 400) { log(`[images] write failed for ${docPath}: ${JSON.stringify(put.body)}`); return { status: 'skipped', reason: `write failed (${put.status})` } }
  log(`[images] ${path} → ${docPath} (${text.length} chars)`)
  return { status: 'described', doc: docPath, chars: text.length }
}
