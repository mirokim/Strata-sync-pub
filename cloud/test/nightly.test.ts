import { describe, it, expect, beforeEach } from 'vitest'
import { runNightly, chunkDocument, chunkId, semanticSearch, localDate, pruneOldReports, SNAPSHOT_KEY, EMBED_INDEX_KEY, type NightlyDeps, type VectorItem } from '../src/nightly.js'
import { applyR2Events } from '../src/r2events.js'
import { putFile, deleteFile, type SyncDeps } from '../src/sync.js'
import { parseVaultDoc, parseFrontmatter, docIdFromPath } from '../../mcp/src/lint/vaultDoc.js'
import { MemoryMeta, MemoryBlobs, enc, dec } from './fakes.js'

const NOW = Date.parse('2026-09-13T19:00:00Z')

class FakeVectors {
  items = new Map<string, VectorItem>()
  async upsert(items: VectorItem[]) { for (const i of items) this.items.set(i.id, i) }
  async deleteByIds(ids: string[]) { for (const id of ids) this.items.delete(id) }
  async query(values: number[], topK: number) {
    return [...this.items.values()]
      .map(i => ({ id: i.id, score: cosine(values, i.values), metadata: i.metadata }))
      .sort((a, b) => b.score - a.score).slice(0, topK)
  }
}
const cosine = (a: number[], b: number[]) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] } return d / Math.sqrt(na * nb || 1) }

/** Deterministic toy embedder: bag of character codes in 8 buckets. */
const fakeEmbed = async (texts: string[]) => texts.map(t => {
  const v = new Array(8).fill(0)
  for (const ch of t.toLowerCase()) v[ch.charCodeAt(0) % 8] += 1
  return v
})

let deps: NightlyDeps
let meta: MemoryMeta
let blobs: MemoryBlobs
let vectors: FakeVectors
let embedCalls: string[][]

beforeEach(() => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs(); vectors = new FakeVectors(); embedCalls = []
  deps = {
    meta, blobs, maxFileBytes: 1024 * 1024, now: () => NOW,
    embed: async texts => { embedCalls.push(texts); return fakeEmbed(texts) },
    vectors,
  }
})

const seed = async (path: string, text: string) => putFile(deps as SyncDeps, { path, body: enc(text), mtime: NOW - 86_400_000, author: 'ann' })

describe('vaultDoc parser', () => {
  it('parses frontmatter lists in both styles, wikilinks and sections; ids match the MCP parser rule', () => {
    const doc = parseVaultDoc('active/Combat System.md', `---
tags: [combat, core]
links:
  - "Design Pillars"
graph_weight: low
date: 2026-01-02
---

Intro text with [[Skill Design|skills]].

## Damage

Formula here [[Damage Formula]] and ![[img.png]].
`, 123)
    expect(doc.id).toBe(docIdFromPath('active/Combat System.md'))
    expect(doc.id).toBe('active_combat_system')
    expect(doc.tags).toEqual(['combat', 'core'])
    expect(doc.links).toEqual(['Design Pillars'])
    expect(doc.graphWeight).toBe('low')
    expect(doc.date).toBe('2026-01-02')
    expect(doc.sections.map(s => s.heading)).toEqual(['(intro)', 'Damage'])
    expect(doc.sections.flatMap(s => s.wikiLinks)).toEqual(['Skill Design|skills', 'Damage Formula'])
    expect(doc.folderPath).toBe('active')
  })
  it('treats a document without frontmatter as plain body', () => {
    expect(parseFrontmatter('# Title\nbody').data).toEqual({})
    expect(parseVaultDoc('a.md', '# Title\n\nbody text').sections[0].heading).toBe('Title')
  })
})

describe('runNightly', () => {
  it('lints the vault, writes the report through the sync protocol, and embeds changed docs only', async () => {
    await seed('Combat System.md', '# Combat\n\nCore loop with [[Skill Design]] and [[Enemy AI Spec]] and [[Hitbox]] plenty of text here.')
    await seed('Skill Design.md', '# Skills\n\nSkills link [[Combat System]] [[Enemy AI Spec]] [[Hitbox]] and more words to embed.')
    await seed('Hitbox.md', '# Hitbox\n\n[[Combat System]] [[Skill Design]] [[Enemy AI Spec]] shapes and sizes described here.')
    await seed('Lonely.md', '# Lonely\n\nNo links at all but enough text to be embedded as one chunk.')
    await seed('image.png', 'not markdown')

    const r1 = await runNightly(deps)
    expect(r1.docs).toBe(4)
    expect(r1.lint.reportPath).toBe('_reports/lint-2026-09-14.md')   // 19:00 UTC is already the 14th in Seoul
    expect(r1.lint.errors).toBeGreaterThanOrEqual(1)          // Enemy AI Spec phantom
    expect(r1.lint.skipped).toEqual(['near-duplicate', 'cluster-drift'])

    // report is a real vault file with a D1 row, authored by the bot
    const row = await meta.get('_reports/lint-2026-09-14.md')
    expect(row?.author).toBe('strata-bot')
    expect(dec(blobs.objects.get('_reports/lint-2026-09-14.md')!)).toContain('[[Enemy AI Spec]]')
    expect(dec(blobs.objects.get('_reports/lint-2026-09-14.md')!)).toContain('— 2026-09-14')
    // server bookkeeping is in R2 only
    expect(blobs.objects.has(SNAPSHOT_KEY)).toBe(true)
    expect(await meta.get(SNAPSHOT_KEY)).toBeNull()

    expect(r1.embeddings.skipped).toBe(false)
    expect(r1.embeddings.docsEmbedded).toBe(4)
    expect(vectors.items.size).toBe(4)
    expect([...vectors.items.values()][0].metadata.path).toBeTruthy()

    // second night: nothing changed → no embedding calls; cluster-drift now runs
    embedCalls = []
    const r2 = await runNightly(deps)
    expect(embedCalls).toEqual([])
    expect(r2.embeddings.docsEmbedded).toBe(0)
    expect(r2.lint.skipped).toEqual(['near-duplicate'])
    // the report itself was not embedded and did not become a lint subject
    expect([...vectors.items.values()].some(v => v.metadata.path.startsWith('_reports/'))).toBe(false)
  })

  it('re-embeds an edited document and removes vectors of a deleted one', async () => {
    const a = await seed('A.md', '# A\n\nfirst version with enough characters to make a chunk.')
    await seed('B.md', '# B\n\nsecond document with enough characters to make a chunk.')
    await runNightly(deps)
    expect(vectors.items.size).toBe(2)

    await putFile(deps as SyncDeps, { path: 'A.md', body: enc('# A\n\nSECOND version, still long enough to be embedded.'), mtime: NOW, author: 'ann', ifMatch: (a.body as { etag: string }).etag })
    const b = await meta.get('B.md')
    await deleteFile(deps as SyncDeps, 'B.md', b!.etag, 'ann')

    embedCalls = []
    const r = await runNightly(deps)
    expect(r.embeddings.docsEmbedded).toBe(1)
    expect(r.embeddings.docsRemoved).toBe(1)
    expect(embedCalls.flat().some(t => t.includes('SECOND version'))).toBe(true)
    expect(vectors.items.size).toBe(1)
    expect(vectors.items.has(chunkId('A.md', 0))).toBe(true)
    const index = JSON.parse(dec(blobs.objects.get(EMBED_INDEX_KEY)!))
    expect(Object.keys(index.docs)).toEqual(['A.md'])
  })

  it('skips embeddings cleanly when no embedder is configured', async () => {
    await seed('A.md', '# A\n\ntext')
    const r = await runNightly({ meta, blobs, maxFileBytes: 1024, now: () => NOW })
    expect(r.embeddings.skipped).toBe(true)
    expect(blobs.objects.has(EMBED_INDEX_KEY)).toBe(false)
    expect(await meta.get('_reports/lint-2026-09-14.md')).not.toBeNull()
  })
})

describe('chunkDocument', () => {
  it('one chunk per substantial section, prefixed with the title path; tiny docs fall back to one chunk', () => {
    const doc = parseVaultDoc('Combat.md', '# Combat\n\n' + 'x'.repeat(40) + '\n\n## Small\n\nshort\n\n## Big\n\n' + 'y'.repeat(60))
    const chunks = chunkDocument(doc)
    expect(chunks.map(c => c.heading)).toEqual(['Combat', 'Big'])
    expect(chunks[1].text.startsWith('Combat › Big')).toBe(true)
    expect(chunkDocument(parseVaultDoc('t.md', 'tiny')).length).toBe(0)
  })
})

describe('semanticSearch', () => {
  it('embeds the query and returns metadata-backed hits', async () => {
    await vectors.upsert([{ id: 'x:0', values: (await fakeEmbed(['combat damage']))[0], metadata: { path: 'Combat.md', docId: 'combat', heading: 'Damage' } }])
    const hits = await semanticSearch(fakeEmbed, vectors, 'combat damage', 5)
    expect(hits[0]).toMatchObject({ path: 'Combat.md', docId: 'combat', heading: 'Damage' })
    expect(await semanticSearch(fakeEmbed, vectors, '   ', 5)).toEqual([])
  })
})

describe('applyR2Events', () => {
  it('indexes externally written files, ignores our own writes, tombstones external deletes', async () => {
    // A file written via the API — the event for it must be a no-op
    await seed('ViaApi.md', '# api')
    // A file dropped straight into the bucket by Remotely Save
    await blobs.put('active/FromObsidian.md', enc('# hello from obsidian'))
    await blobs.put('_system/lint-snapshot.json', enc('{}'))
    await blobs.put('.obsidian/workspace.json', enc('{}'))

    const r = await applyR2Events(deps as SyncDeps, [
      { action: 'PutObject', object: { key: 'ViaApi.md' } },
      { action: 'PutObject', object: { key: 'active/FromObsidian.md' }, eventTime: '2026-09-13T10:00:00Z' },
      { action: 'PutObject', object: { key: '_system/lint-snapshot.json' } },
      { action: 'PutObject', object: { key: '.obsidian/workspace.json' } },
      { action: 'PutObject', object: { key: 'notes/missing.md' } },
    ])
    expect(r).toEqual({ indexed: 1, tombstoned: 0, skipped: 4 })
    const row = await meta.get('active/FromObsidian.md')
    expect(row?.author).toBe('external')
    expect(row?.mtime).toBe(Date.parse('2026-09-13T10:00:00Z'))
    expect(row?.deleted).toBe(false)

    // external delete of the file → tombstone; delete of an unknown key → skipped
    blobs.objects.delete('active/FromObsidian.md')
    const d = await applyR2Events(deps as SyncDeps, [
      { action: 'DeleteObject', object: { key: 'active/FromObsidian.md' } },
      { action: 'DeleteObject', object: { key: 'never-there.md' } },
    ])
    expect(d).toEqual({ indexed: 0, tombstoned: 1, skipped: 1 })
    expect((await meta.get('active/FromObsidian.md'))?.deleted).toBe(true)
  })
})

describe('report housekeeping', () => {
  it('dates reports in the configured zone', () => {
    expect(localDate(NOW, 'Asia/Seoul')).toBe('2026-09-14')
    expect(localDate(NOW, 'UTC')).toBe('2026-09-13')
    expect(localDate(NOW, 'Not/AZone')).toBe('2026-09-13')   // falls back to UTC
  })

  it('prunes reports older than the retention window and leaves everything else', async () => {
    await seed('_reports/lint-2026-06-01.md', 'old')
    await seed('_reports/lint-2026-09-10.md', 'recent')
    await seed('_reports/not-a-lint-file.md', 'other')
    await seed('Doc.md', 'doc')
    const rows = (await meta.listSince(0, 100)).filter(r => !r.deleted)
    expect(await pruneOldReports(deps as SyncDeps, rows, NOW)).toBe(1)
    expect((await meta.get('_reports/lint-2026-06-01.md'))?.deleted).toBe(true)
    expect((await meta.get('_reports/lint-2026-09-10.md'))?.deleted).toBe(false)
    expect((await meta.get('_reports/not-a-lint-file.md'))?.deleted).toBe(false)
  })

  it('drops vectors of a document that became graph_weight: skip', async () => {
    const body = 'long enough body to be embedded as a chunk for sure.'
    const a = await seed('A.md', ['# A', '', body].join('\n'))
    await runNightly(deps)
    expect(vectors.items.size).toBe(1)
    await putFile(deps as SyncDeps, { path: 'A.md', body: enc(['---', 'graph_weight: skip', '---', '# A', '', body].join('\n')), mtime: NOW, author: 'ann', ifMatch: (a.body as { etag: string }).etag })
    const r = await runNightly(deps)
    expect(vectors.items.size).toBe(0)
    expect(r.embeddings.chunksDeleted).toBe(1)
  })
})
