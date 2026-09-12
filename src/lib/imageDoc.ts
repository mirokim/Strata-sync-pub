/**
 * imageDoc.ts — the client half of image documents. When an image is pasted into the editor it is
 * uploaded to ATTACHMENTS_FOLDER and a placeholder document is written next to it, linking back to
 * the document it was pasted into; whoever is connected over MCP (Claude Code, Codex, an AI
 * member) then writes the description (cloud/src/images.ts). Keep the document shape in step
 * with the server's renderImageDoc.
 */
export const ATTACHMENTS_FOLDER = 'attachments'
export const DESCRIBING_PLACEHOLDER = '_(not described yet — open the image with vault_read and write what it shows here)_'
const IMAGE_MIME: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/** Extension for a pasted image's MIME type; null for anything we do not accept. */
export function imageExtension(mime: string): string | null {
  return IMAGE_MIME[mime.toLowerCase()] ?? null
}

/** `attachments/2026-09/pasted-20260913-1432-07.png` — dated, unique enough per person per second. */
export function pastedImagePath(ext: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const hms = `${pad(now.getHours())}${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `${ATTACHMENTS_FOLDER}/${now.getFullYear()}-${pad(now.getMonth() + 1)}/pasted-${ymd}-${hms}.${ext}`
}

export function imageDocPath(imagePath: string): string {
  return imagePath.replace(/\.(png|jpe?g|webp|gif)$/i, '.md')
}

export function renderImageDoc(input: { imagePath: string; pastedInto?: string }): string {
  const file = input.imagePath.replace(/\\/g, '/').split('/').pop()!
  const name = file.replace(/\.(png|jpe?g|webp|gif)$/i, '')
  const lines = [
    '---',
    `title: ${JSON.stringify(name)}`,
    'type: image',
    `image: ${JSON.stringify(file)}`,
    ...(input.pastedInto ? [`pasted_into: ${JSON.stringify(input.pastedInto)}`] : []),
    'tags: [image]',
    '---',
    '',
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
  return lines.join('\n')
}

/** The first image file on a paste/drop event, if any. */
export function imageFileFrom(data: DataTransfer | null): File | null {
  if (!data) return null
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file' && imageExtension(item.type)) { const f = item.getAsFile(); if (f) return f }
  }
  for (const f of Array.from(data.files ?? [])) if (imageExtension(f.type)) return f
  return null
}
