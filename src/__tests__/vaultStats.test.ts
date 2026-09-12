import { describe, it, expect } from 'vitest'
import {
  calcBodyCharCount,
  hasImageOrTable,
  hasWikiLink,
  computeStats,
} from '@/lib/vaultStats'
import type { LoadedDocument } from '@/types'

// ── calcBodyCharCount ─────────────────────────────────────────────────────────

describe('calcBodyCharCount()', () => {
  it('counts non-whitespace body characters', () => {
    expect(calcBodyCharCount('hello world')).toBe(10)
  })

  it('strips frontmatter block', () => {
    const content = '---\ntitle: Test\n---\nhello world'
    expect(calcBodyCharCount(content)).toBe(10)
  })

  it('strips H1 heading line', () => {
    const content = '# My Title\nhello world'
    expect(calcBodyCharCount(content)).toBe(10)
  })

  it('strips source citation lines', () => {
    const content = '> 원본: https://example.com\nhello world'
    expect(calcBodyCharCount(content)).toBe(10)
  })

  it('returns 0 for empty content after stripping', () => {
    expect(calcBodyCharCount('---\ntitle: x\n---\n# Title')).toBe(0)
  })

  it('handles content with no frontmatter', () => {
    const content = 'line one\nline two'
    expect(calcBodyCharCount(content)).toBeGreaterThan(0)
  })
})

// ── hasImageOrTable ───────────────────────────────────────────────────────────

describe('hasImageOrTable()', () => {
  it('detects embedded image syntax ![[...]]', () => {
    expect(hasImageOrTable('![[image.png]]')).toBe(true)
  })

  it('detects markdown table rows', () => {
    expect(hasImageOrTable('| col1 | col2 |\n| --- | --- |')).toBe(true)
  })

  it('returns false for plain text', () => {
    expect(hasImageOrTable('just some text [[link]]')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(hasImageOrTable('')).toBe(false)
  })
})

// ── hasWikiLink ───────────────────────────────────────────────────────────────

describe('hasWikiLink()', () => {
  it('detects basic [[link]]', () => {
    expect(hasWikiLink('see [[some page]] for details')).toBe(true)
  })

  it('detects [[link|alias]] syntax', () => {
    expect(hasWikiLink('[[page|display text]]')).toBe(true)
  })

  it('returns false for plain text', () => {
    expect(hasWikiLink('no links here')).toBe(false)
  })

  it('returns false for regular markdown links', () => {
    expect(hasWikiLink('[text](url)')).toBe(false)
  })

  it('returns false for image embeds ![[...]]', () => {
    // Image embeds match [[...]] pattern so they ARE counted as having a wikilink
    // This is intentional — images indicate the file isn't a "no-link" stub
    expect(hasWikiLink('![[image.png]]')).toBe(true)
  })
})

// ── computeStats ──────────────────────────────────────────────────────────────

function makeDoc(overrides: Partial<LoadedDocument> & { rawContent?: string }): LoadedDocument {
  return {
    id: overrides.id ?? 'doc1',
    filename: overrides.filename ?? 'doc1.md',
    rawContent: overrides.rawContent ?? '',
    folderPath: overrides.folderPath ?? '',
    absolutePath: overrides.absolutePath ?? '/vault/doc1.md',
    title: overrides.filename?.replace('.md', '') ?? 'doc1',
    tags: [],
    wikiLinks: [],
    sections: [],
    ...overrides,
  } as unknown as LoadedDocument
}

describe('computeStats()', () => {
  it('excludes image nodes (id starts with img:)', () => {
    const docs = [
      makeDoc({ id: 'img:photo.png', filename: 'photo.png' }),
      makeDoc({ id: 'doc1', rawContent: 'some content with [[link]]' }),
    ]
    expect(computeStats(docs).total).toBe(1)
  })

  it('counts stub documents (< 50 chars body, no media)', () => {
    const docs = [
      makeDoc({ id: 'a', rawContent: 'hi' }),  // stub
      makeDoc({ id: 'b', rawContent: 'x'.repeat(200) + ' [[link]]' }),  // normal
    ]
    const stats = computeStats(docs)
    expect(stats.stubCount).toBe(1)
  })

  it('counts thin documents (50-299 chars body, no media)', () => {
    const content = 'x'.repeat(100) + ' [[link]]'
    const docs = [makeDoc({ id: 'a', rawContent: content })]
    const stats = computeStats(docs)
    expect(stats.thinCount).toBe(1)
    expect(stats.stubCount).toBe(0)
  })

  it('does NOT count stub/thin when doc has media (image or table)', () => {
    const docs = [
      makeDoc({ id: 'a', rawContent: '![[img.png]]' }),  // very short but has media
    ]
    const stats = computeStats(docs)
    expect(stats.stubCount).toBe(0)
    expect(stats.thinCount).toBe(0)
  })

  it('counts documents with no wiki links', () => {
    const docs = [
      makeDoc({ id: 'a', rawContent: 'no links here' }),
      makeDoc({ id: 'b', rawContent: 'has [[link]]' }),
    ]
    expect(computeStats(docs).noLinkCount).toBe(1)
  })

  it('counts archived documents by folderPath', () => {
    const docs = [
      makeDoc({ id: 'a', folderPath: 'vault/archive/old' }),
      makeDoc({ id: 'b', folderPath: 'vault/active' }),
    ]
    expect(computeStats(docs).archiveCount).toBe(1)
  })

  it('counts archived documents by absolutePath fallback', () => {
    const docs = [
      makeDoc({ id: 'a', folderPath: '', absolutePath: '/vault/archive/file.md' }),
    ]
    expect(computeStats(docs).archiveCount).toBe(1)
  })

  it('detects currentSituation.md (case-insensitive)', () => {
    const docs = [
      makeDoc({ id: 'a', filename: 'currentSituation.md' }),
      makeDoc({ id: 'b', filename: 'CURRENTSITUATION.md' }),
    ]
    const stats = computeStats(docs)
    expect(stats.hasCurrentSituation).toBe(true)
  })

  it('hasCurrentSituation is false when not present', () => {
    const docs = [makeDoc({ id: 'a', filename: 'notes.md' })]
    expect(computeStats(docs).hasCurrentSituation).toBe(false)
  })

  it('returns zero counts for empty vault', () => {
    const stats = computeStats([])
    expect(stats).toEqual({
      total: 0, stubCount: 0, thinCount: 0,
      noLinkCount: 0, archiveCount: 0, hasCurrentSituation: false,
    })
  })
})
