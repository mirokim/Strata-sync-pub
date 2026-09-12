/**
 * The web app carries copies of a few server definitions (it cannot import cloud/ at build time).
 * This pins them together so a change on one side fails here instead of in production.
 */
import { describe, it, expect } from 'vitest'
import * as clientPersonal from '@/web/personal'
import * as clientImage from '@/lib/imageDoc'
import { MEMBERS_FOLDER as CLIENT_MEMBERS_FOLDER } from '@/lib/brain'
import * as serverPersonal from '../../cloud/src/personal'
import * as serverImage from '../../cloud/src/images'
import { MEMBERS_FOLDER as SERVER_MEMBERS_FOLDER } from '../../cloud/src/members'

describe('client copies of server definitions', () => {
  it('personal space prefix and owner segment rule', () => {
    expect(clientPersonal.PERSONAL_PREFIX).toBe(serverPersonal.PERSONAL_PREFIX)
    for (const sub of ['1001', 'google|a b/c@d', '한글 sub', 'x'.repeat(100), '']) {
      expect(clientPersonal.ownerSegment(sub)).toBe(serverPersonal.ownerSegment(sub))
    }
  })

  it('image documents: placeholder, paths and the placeholder document byte for byte', () => {
    expect(clientImage.DESCRIBING_PLACEHOLDER).toBe(serverImage.DESCRIBING_PLACEHOLDER)
    for (const p of ['attachments/2026-09/pasted-1.png', 'a/b.JPEG', 'x.webp']) expect(clientImage.imageDocPath(p)).toBe(serverImage.imageDocPath(p))
    const input = { imagePath: 'attachments/2026-09/pasted-20260913-0315-42.png', pastedInto: 'design/Menu "v2".md' }
    expect(clientImage.renderImageDoc(input)).toBe(serverImage.renderImageDoc(input))
    expect(serverImage.isDescribed(clientImage.renderImageDoc(input))).toBe(false)
  })

  it('members folder', () => {
    expect(CLIENT_MEMBERS_FOLDER).toBe(SERVER_MEMBERS_FOLDER)
  })
})
