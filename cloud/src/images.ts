/**
 * Image documents — an image is only part of the shared brain once it has words. When an image
 * lands in the vault (pasted in the app, uploaded by Obsidian) a markdown "image document" is
 * created next to it (`foo.png` → `foo.md`): the embed, where it was pasted, and an empty
 * `## Description`. Whoever is connected over MCP — a person's Claude Code or Codex, or an AI
 * member on its routine — looks at the image (`vault_read` returns it) and writes what it shows,
 * the text visible in it and a few tags into that section (`vault_write`). From then on search,
 * the graph, recall and the members see the image like any other document. The prompt that
 * would have generated the image, recovered from the image — the same idea in reverse.
 *
 * No vision model runs on the server: the describing is done by whichever model the team member
 * already uses, in their language, with their judgement.
 */
import { putFile, type SyncDeps } from './sync.js'
import { parseFrontmatter } from '../../mcp/src/lint/vaultDoc.js'
import type { VaultView } from './vaultIndex.js'

export const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i
export const IMAGE_DOC_AUTHOR = 'strata-bot'
export const DESCRIBING_PLACEHOLDER = '_(not described yet — open the image with vault_read and write what it shows here)_'

/** What a client is asked to put into `## Description`; surfaced by `images_undescribed`. */
export const DESCRIBE_GUIDE = [
  'Say what the image shows and how it is composed, in two to five sentences, in the vault\'s language.',
  'If there is visible text, transcribe it exactly under a line "Text:".',
  'End with a line "Tags:" followed by three to six lowercase tags separated by commas.',
  'Write it into the image document\'s "## Description" section with vault_write, keeping the rest of the document; put the tags into the frontmatter tags too.',
].join(' ')

const enc = new TextEncoder()

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

/** The placeholder document written when the image lands (by the app at paste time, or by the server). */
export function renderImageDoc(input: { imagePath: string; pastedInto?: string }): string {
  const file = input.imagePath.replace(/\\/g, '/').split('/').pop()!
  const name = file.replace(IMAGE_EXT, '')
  const fm = [
    '---',
    `title: ${JSON.stringify(name)}`,
    'type: image',
    `image: ${JSON.stringify(file)}`,
    ...(input.pastedInto ? [`pasted_into: ${JSON.stringify(input.pastedInto)}`] : []),
    'tags: [image]',
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
    DESCRIBING_PLACEHOLDER,
    '',
  ]
  return [...fm, '', ...body].join('\n')
}

/** An image document counts as described once its Description section holds more than the placeholder. */
export function isDescribed(markdown: string): boolean {
  const { body } = parseFrontmatter(markdown)
  const lines = body.replace(/\r/g, '').split('\n')
  const start = lines.findIndex(l => /^##\s+Description\s*$/i.test(l))
  if (start < 0) return false
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) if (/^##\s+/.test(lines[i])) { end = i; break }
  const text = lines.slice(start + 1, end).join('\n').replace(DESCRIBING_PLACEHOLDER, '').trim()
  return text.length >= 20
}

/** Image documents still waiting for a description, oldest first. */
export async function undescribedImages(view: VaultView): Promise<{ doc: string; image: string; pastedInto?: string; since: number }[]> {
  const out: { doc: string; image: string; pastedInto?: string; since: number }[] = []
  for (const [path, d] of view.docs) {
    if (!d.tags.includes('image')) continue                     // every image document carries the tag; only those are fetched
    const raw = await view.textOf(path)
    if (!raw) continue
    const { data } = parseFrontmatter(raw)
    if (data.type !== 'image' || isDescribed(raw)) continue
    const file = typeof data.image === 'string' ? data.image : ''
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    out.push({ doc: path, image: folder + file, pastedInto: typeof data.pasted_into === 'string' ? data.pasted_into : undefined, since: view.rows.get(path)?.updatedAt ?? 0 })
  }
  return out.sort((a, b) => a.since - b.since)
}

/** Create the placeholder document for an image that has none (server side, for uploads that skipped the app). */
export async function ensureImageDoc(deps: SyncDeps, imagePath: string): Promise<'created' | 'exists' | 'skipped'> {
  const path = imagePath.replace(/\\/g, '/')
  if (!isImagePath(path)) return 'skipped'
  const docPath = imageDocPath(path)
  const existing = await deps.meta.get(docPath)
  if (existing && !existing.deleted) return 'exists'
  const put = await putFile(deps, { path: docPath, body: enc.encode(renderImageDoc({ imagePath: path })), mtime: (deps.now ?? Date.now)(), author: IMAGE_DOC_AUTHOR, createOnly: true })
  return put.status === 201 ? 'created' : 'exists'
}
