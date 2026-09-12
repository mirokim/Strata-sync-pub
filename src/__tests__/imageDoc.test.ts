/**
 * imageDoc.ts — the client half of image documents (paste path, placeholder document, file
 * picking from a paste/drop event). The document shape must match cloud/src/images.ts.
 */
import { describe, it, expect } from 'vitest'
import { imageExtension, pastedImagePath, imageDocPath, renderImageDoc, imageFileFrom, DESCRIBING_PLACEHOLDER, ATTACHMENTS_FOLDER } from '@/lib/imageDoc'

describe('imageExtension', () => {
  it('maps accepted MIME types case-insensitively and rejects everything else', () => {
    expect(imageExtension('image/png')).toBe('png')
    expect(imageExtension('IMAGE/JPEG')).toBe('jpg')
    expect(imageExtension('image/webp')).toBe('webp')
    expect(imageExtension('image/gif')).toBe('gif')
    expect(imageExtension('image/svg+xml')).toBeNull()
    expect(imageExtension('text/plain')).toBeNull()
    expect(imageExtension('')).toBeNull()
  })
})

describe('pastedImagePath', () => {
  it('formats a dated, zero-padded path in local time', () => {
    expect(pastedImagePath('png', new Date(2026, 0, 5, 9, 3, 7))).toBe(`${ATTACHMENTS_FOLDER}/2026-01/pasted-20260105-0903-07.png`)
    expect(pastedImagePath('jpg', new Date(2026, 11, 31, 23, 59, 59))).toBe(`${ATTACHMENTS_FOLDER}/2026-12/pasted-20261231-2359-59.jpg`)
    // Two pastes a second apart never share a name
    expect(pastedImagePath('png', new Date(2026, 8, 13, 10, 30, 0))).not.toBe(pastedImagePath('png', new Date(2026, 8, 13, 10, 30, 1)))
  })
})

describe('imageDocPath / renderImageDoc', () => {
  it('swaps the extension whatever its case and leaves non-images alone', () => {
    expect(imageDocPath('attachments/a.PNG')).toBe('attachments/a.md')
    expect(imageDocPath('attachments/a.jpeg')).toBe('attachments/a.md')
    expect(imageDocPath('attachments/a.b.webp')).toBe('attachments/a.b.md')
    expect(imageDocPath('notes/a.md')).toBe('notes/a.md')
  })

  it('renders the same placeholder document as the server, with the pasted-into link by basename', () => {
    // Byte-for-byte what cloud/src/images.ts renderImageDoc produces for the same input (asserted there too)
    expect(renderImageDoc({ imagePath: 'attachments/2026-09/pasted-1.png', pastedInto: 'design/Menu.md' })).toBe([
      '---',
      'title: "pasted-1"',
      'type: image',
      'image: "pasted-1.png"',
      'pasted_into: "design/Menu.md"',
      'tags: [image]',
      '---',
      '',
      '# pasted-1',
      '',
      '![[pasted-1.png]]',
      '',
      'Pasted into [[Menu]]',
      '',
      '## Description',
      '',
      DESCRIBING_PLACEHOLDER,
      '',
    ].join('\n'))
    const bare = renderImageDoc({ imagePath: 'attachments\\shot.jpg' })
    expect(bare).not.toContain('pasted_into')
    expect(bare).not.toContain('Pasted into')
    expect(bare).toContain('image: "shot.jpg"')
    expect(bare).toContain('# shot\n')
    // Quotes in a file name are escaped, so the frontmatter stays valid YAML
    expect(renderImageDoc({ imagePath: 'a/say "hi".png' })).toContain('title: "say \\"hi\\""')
  })
})

describe('imageFileFrom', () => {
  const file = (name: string, type: string) => new File(['x'], name, { type })
  const transfer = (items: { kind: string; type: string; file?: File | null }[], files: File[] = []) => ({
    items: items.map(i => ({ kind: i.kind, type: i.type, getAsFile: () => i.file ?? null })),
    files,
  }) as unknown as DataTransfer

  it('prefers the first image item, skipping strings and non-image files', () => {
    const png = file('a.png', 'image/png'), gif = file('b.gif', 'image/gif')
    const picked = imageFileFrom(transfer([{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'application/pdf', file: file('c.pdf', 'application/pdf') }, { kind: 'file', type: 'image/png', file: png }, { kind: 'file', type: 'image/gif', file: gif }]))
    expect(picked).toBe(png)
  })

  it('falls back to the files list when items yield nothing, and returns null for text-only or empty events', () => {
    const webp = file('w.webp', 'image/webp')
    expect(imageFileFrom(transfer([{ kind: 'file', type: 'image/png', file: null }], [file('t.txt', 'text/plain'), webp]))).toBe(webp)
    expect(imageFileFrom(transfer([], [webp]))).toBe(webp)
    expect(imageFileFrom(transfer([{ kind: 'string', type: 'text/html' }]))).toBeNull()
    expect(imageFileFrom(transfer([], [file('t.txt', 'text/plain')]))).toBeNull()
    expect(imageFileFrom(null)).toBeNull()
    expect(imageFileFrom({} as DataTransfer)).toBeNull()                       // neither items nor files (older browsers)
  })
})
