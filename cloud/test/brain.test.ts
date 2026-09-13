import { describe, it, expect, beforeEach, vi } from 'vitest'
import { putFile, deleteFile, type SyncDeps } from '../src/sync.js'
import { listVersions, readVersion, previousVersion, diffLines, historyKey, parseHistoryKey, HISTORY_KEEP, HISTORY_PREFIX } from '../src/history.js'
import { recall, splitNoteSections, fusedSearch } from '../src/recall.js'
import { loadVaultView, invalidateVaultView, Bm25 } from '../src/vaultIndex.js'
import type { ParsedVaultDoc } from '../../mcp/src/lint/vaultDoc.js'
import { callTool, type McpDeps } from '../src/mcp.js'
import { memberNotePath, DEFAULT_MEMBER } from '../src/members.js'
import { reactToSave, type LlmCall } from '../src/reactions.js'
import { route, type Env } from '../src/index.js'
import { MemoryMeta, MemoryBlobs, enc, dec } from './fakes.js'
import { renderImageDoc, isDescribed, undescribedImages, ensureImageDoc, isImagePath, imageDocPath, DESCRIBING_PLACEHOLDER } from '../src/images.js'

let deps: SyncDeps
let meta: MemoryMeta
let blobs: MemoryBlobs

beforeEach(() => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs()
  deps = { meta, blobs, maxFileBytes: 1024 * 1024 }
  invalidateVaultView()
})

const parse = (r: Awaited<ReturnType<typeof callTool>>) => JSON.parse((r.content[0] as { text: string }).text)
const textOf = (r: Awaited<ReturnType<typeof callTool>>) => (r.content[0] as { text: string }).text

describe('history', () => {
  it('archives the replaced version on every save and delete, keeps the newest HISTORY_KEEP', async () => {
    const t = { ...deps, now: () => 1_000 }
    await putFile(t, { path: 'design/Menu.md', body: enc('# Menu\n\nv1'), mtime: 1, author: 'ann' })
    expect(await listVersions(blobs, 'design/Menu.md')).toEqual([])           // first version: nothing replaced yet
    await putFile({ ...deps, now: () => 2_000 }, { path: 'design/Menu.md', body: enc('# Menu\n\nv2'), mtime: 2, author: 'bob' })
    const v = await listVersions(blobs, 'design/Menu.md')
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ path: 'design/Menu.md', at: 1_000, author: 'ann', size: 10 })
    expect(dec((await readVersion(blobs, 'design/Menu.md', v[0].etag))!.bytes)).toBe('# Menu\n\nv1')
    // Identical content (204) archives nothing
    await putFile({ ...deps, now: () => 3_000 }, { path: 'design/Menu.md', body: enc('# Menu\n\nv2'), mtime: 3, author: 'bob' })
    expect(await listVersions(blobs, 'design/Menu.md')).toHaveLength(1)
    // Delete archives the last live version too
    const live = await meta.get('design/Menu.md')
    await deleteFile({ ...deps, now: () => 4_000 }, 'design/Menu.md', live!.etag, 'cat')
    const afterDelete = await listVersions(blobs, 'design/Menu.md')
    expect(afterDelete.map(x => x.author)).toEqual(['bob', 'ann'])
    expect(afterDelete[0].at).toBe(2_000)
    // Binaries and system files keep no history
    await putFile(deps, { path: 'img/a.png', body: enc('png1'), mtime: 1, author: 'ann' })
    await putFile(deps, { path: 'img/a.png', body: enc('png2'), mtime: 2, author: 'ann' })
    expect(await blobs.list(HISTORY_PREFIX + 'img/')).toEqual([])
    // Retention
    for (let i = 0; i < HISTORY_KEEP + 5; i++) await putFile({ ...deps, now: () => 10_000 + i }, { path: 'n.md', body: enc(`v${i}`), mtime: i + 1, author: 'x' })
    const kept = await listVersions(blobs, 'n.md')
    expect(kept).toHaveLength(HISTORY_KEEP)
    expect(kept[0].at).toBeGreaterThan(kept[kept.length - 1].at)
  })

  it('history keys round-trip authors with odd characters', () => {
    const key = historyKey('a/b c.md', 5, 'e'.repeat(64), '김 미로/ok')
    expect(parseHistoryKey(key, 3)).toEqual({ path: 'a/b c.md', at: 5, etag: 'e'.repeat(64), author: '김 미로/ok', authorSub: '', size: 3, key })
    const withSub = historyKey('a.md', 5, 'e'.repeat(64), 'J. Kim', 'google|1.2')
    expect(parseHistoryKey(withSub)).toMatchObject({ author: 'J. Kim', authorSub: 'google|1.2' })   // dots in either segment survive
    expect(parseHistoryKey('_system/history/x.md/garbage')).toBeNull()
  })

  it('diffLines keeps changed lines with context and counts them', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n')
    const after = ['a', 'b', 'C', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n')
    const { text, stats } = diffLines(before, after, 1)
    expect(stats).toEqual({ added: 2, removed: 1, unchanged: 7 })
    expect(text).toBe(['  b', '- c', '+ C', '  d', '@@', '  h', '+ i'].join('\n'))
    expect(diffLines('same', 'same').text).toBe('(no difference)')
  })

  it('vault_history tool and GET /v1/history expose versions and the diff to now', async () => {
    await putFile({ ...deps, now: () => 1_000 }, { path: 'd.md', body: enc('# D\n\nfirst line\nsecond'), mtime: 1, author: 'ann' })
    await putFile({ ...deps, now: () => 2_000 }, { path: 'd.md', body: enc('# D\n\nfirst line changed\nsecond'), mtime: 2, author: 'bob' })
    const mdeps: McpDeps = { ...deps, author: 'kim' }
    const r = parse(await callTool(mdeps, 'vault_history', { path: 'd.md' }))
    expect(r.current.author).toBe('bob')
    expect(r.versions).toHaveLength(1)
    expect(r.diff.from.author).toBe('ann')
    expect(r.diff.text).toContain('- first line\n+ first line changed')
    expect(r.diff.stats).toEqual({ added: 1, removed: 1, unchanged: 3 })
    expect((await callTool(mdeps, 'vault_history', { path: 'd.md', etag: 'nope' })).isError).toBe(true)

    const env = { TEAM_TOKEN: 'secret' } as unknown as Env
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    const call = (q: string) => route(new Request(`https://w/v1/history?${q}`, { headers: { authorization: 'Bearer secret' } }), env, ctx, deps)
    const list = await (await call('path=d.md')).json() as { current: { author: string }; versions: { etag: string; author: string }[] }
    expect(list.current.author).toBe('bob')
    expect(list.versions[0].author).toBe('ann')
    const raw = await call(`path=d.md&etag=${list.versions[0].etag}`)
    expect(raw.headers.get('X-Author')).toBe('ann')
    expect(await raw.text()).toBe('# D\n\nfirst line\nsecond')
    const diff = await (await call(`path=d.md&etag=${list.versions[0].etag}&diff=1`)).json() as { text: string; stats: { added: number } }
    expect(diff.stats.added).toBe(1)
    expect((await call('path=d.md&etag=zzz')).status).toBe(404)
    expect((await call('path=')).status).toBe(400)
  })

  it('members react to the diff, not just the document', async () => {
    const seen: string[] = []
    const llm: LlmCall = async a => { seen.push(a.user); return '### One question\n- why?' }
    const long = 'A paragraph long enough to be worth a remark from a member. '.repeat(10)
    const rdeps = { ...deps, now: () => 5_000, llm }
    await putFile(rdeps, { path: 'design/Menu.md', body: enc(`# Menu\n\n${long}\nOld rule: regen 5/s`), mtime: 1, author: 'ann' })
    const first = await reactToSave(rdeps, { path: 'design/Menu.md' })
    expect(first.status).toBe('reacted')
    expect(seen[0]).toContain('(first version of this document)')
    await putFile({ ...rdeps, now: () => 6_000 }, { path: 'design/Menu.md', body: enc(`# Menu\n\n${long}\nNew rule: regen 8/s`), mtime: 2, author: 'bob' })
    // Past the cooldown: the remark is asked about the change
    const second = await reactToSave({ ...rdeps, now: () => 5_000 + 7 * 3_600_000 }, { path: 'design/Menu.md' })
    expect(second.status).toBe('reacted')
    expect(seen[1]).toContain('## What this save changed (since 1970-01-01 00:00 UTC by ann)')
    expect(seen[1]).toContain('- Old rule: regen 5/s\n+ New rule: regen 8/s')
  })
})

describe('recall', () => {
  const seedVault = async () => {
    const put = (path: string, body: string, author = 'ann') => putFile({ ...deps, now: () => 1_000 }, { path, body: enc(body), mtime: 1, author })
    await put('design/Stamina.md', '---\ntags: [combat]\n---\n# Stamina\n\nStamina regenerates at 5 per second outside combat. See [[Combat Loop]] and [[Dodge]].')
    await put('design/Combat Loop.md', '# Combat Loop\n\nAttack, dodge, recover. Dodging costs [[Stamina]].')
    await put('design/Dodge.md', '# Dodge\n\nA dodge costs 20 stamina and grants invulnerability frames.')
    await put('design/Menu.md', '# Menu\n\nThe main menu lists Continue, New game and Options.')
    await put('lore/World.md', '# World\n\nThe world is old. Stamina is not mentioned here except this once.')
    await put('_agent/2026-09-13-stamina-idea.md', '---\nproposed_by: agent\n---\n# Stamina idea\n\nHalve stamina regen in boss fights. [[Stamina]]')
    await put(memberNotePath(DEFAULT_MEMBER), '# Librarian — memory\n\n## Positions\n- Stamina regen 5/s is contested; Dodge doc says 20 per dodge which makes fights long.\n\n## Unrelated\n- Menu copy is fine.')
    await put('_members/Librarian/design/Stamina.md', '---\nmember: librarian\n---\n# Librarian on [[Stamina]]\n\n### One question\n- Does regen pause during dodge frames?', 'strata-bot')
    invalidateVaultView()
  }

  it('bundles seeds, linked neighbours, member memory and remarks within the budget', async () => {
    await seedVault()
    const r = await recall(deps, { query: 'stamina regen', budget: 4000, seeds: 2 })
    expect(r.core.map(d => d.title)).toContain('Stamina')
    expect(r.core.some(d => d.path.startsWith('_members/'))).toBe(false)         // remarks never seed
    expect([...r.core, ...r.around].find(d => d.path.startsWith('_agent/'))?.proposal).toBe(true)
    const aroundTitles = r.around.map(d => d.title)
    expect(aroundTitles).toContain('Combat Loop')
    expect(r.around.find(d => d.title === 'Combat Loop')?.why).toMatch(/links with Stamina/)
    expect(r.memory).toHaveLength(1)
    expect(r.memory[0]).toMatchObject({ member: 'Librarian', heading: 'Positions' })
    expect(r.remarks).toHaveLength(1)
    expect(r.remarks[0]).toMatchObject({ member: 'Librarian', about: 'design/Stamina.md' })
    expect(r.sources[0]).toBe(r.core[0].path)
    const totalText = [...r.core, ...r.around].reduce((n, d) => n + d.excerpt.length, 0)
    expect(totalText).toBeLessThanOrEqual(4000 + 200 * r.around.length)  // per-doc floors may exceed a tiny budget slightly
    expect(r.markdown).toContain('# Recall: stamina regen')
    expect(r.markdown).toContain('## Members remember')
    expect(r.markdown).toContain('## Sources')
    expect(r.semantic).toBe(false)
  })

  it('uses semantic hits when available and says so; empty vault is a clear message', async () => {
    await seedVault()
    const withSem = { ...deps, semanticSearch: async () => [{ path: 'design/Menu.md', score: 0.9, title: 'Menu', section: '', snippet: '' } as never, { path: 'lore/World.md', score: 0.2, title: 'World', section: '', snippet: '' } as never] }
    const r = await recall(withSem, { query: 'stamina', seeds: 3 })
    expect(r.semantic).toBe(true)
    expect(r.core.map(d => d.title)).toContain('Menu')           // strong semantic hit is fused in
    expect(r.core.map(d => d.title)).toContain('Stamina')        // BM25 title hit still wins a slot
    invalidateVaultView()
    const empty = await recall({ meta: new MemoryMeta(), blobs: new MemoryBlobs(), maxFileBytes: 1 }, { query: 'anything' })
    expect(empty.core).toEqual([])
    expect(empty.markdown).toContain('Nothing in the vault matches')
  })

  it('vault_recall tool returns markdown by default and JSON on request; vault_search still fuses', async () => {
    await seedVault()
    const mdeps: McpDeps = { ...deps, author: 'kim' }
    const md = textOf(await callTool(mdeps, 'vault_recall', { query: 'dodge' }))
    expect(md).toContain('### Dodge')
    const js = parse(await callTool(mdeps, 'vault_recall', { query: 'dodge', format: 'json', neighbours: 0 }))
    expect(js.around).toEqual([])
    expect(js.markdown).toBeUndefined()
    expect((await callTool(mdeps, 'vault_recall', {})).isError).toBe(true)
    const view = await loadVaultView(deps)
    const { hits } = await fusedSearch(deps, view, 'menu', 3)
    expect(hits[0].title).toBe('Menu')
    expect(hits[0].bm25).toBe(true)
  })

  it('splitNoteSections drops frontmatter and keeps section order', () => {
    expect(splitNoteSections('---\nx: 1\n---\nintro\n\n## A\na1\n## B\n\nb1\nb2')).toEqual([
      { heading: '', text: 'intro' }, { heading: 'A', text: 'a1' }, { heading: 'B', text: 'b1\nb2' },
    ])
  })
})

describe('vault view snapshot', () => {
  it('a cold isolate reads the snapshot once and then only the documents whose hash moved', async () => {
    const { VAULT_SNAPSHOT_KEY, writeVaultSnapshot } = await import('../src/vaultIndex.js')
    for (let i = 0; i < 60; i++) await putFile(deps, { path: `d/${i}.md`, body: enc(`# ${i}\n\nbody ${i}`), mtime: 1, author: 'a' })
    invalidateVaultView()
    const reads: string[] = []
    const spied = { ...deps, blobs: Object.assign(Object.create(blobs), { get: async (p: string) => { reads.push(p); return blobs.get(p) } }) as MemoryBlobs }
    const v1 = await loadVaultView(spied, true)
    expect(v1.docs.size).toBe(60)
    expect(reads.filter(p => p.startsWith('d/'))).toHaveLength(60)          // no snapshot yet: read everything…
    expect(blobs.objects.has(VAULT_SNAPSHOT_KEY)).toBe(true)                  // …and leave one behind
    await writeVaultSnapshot(spied, v1)
    // New isolate: one change since the snapshot
    await putFile(deps, { path: 'd/3.md', body: enc('# 3\n\nchanged'), mtime: 2, author: 'b' })
    invalidateVaultView(); reads.length = 0
    const v2 = await loadVaultView(spied, true)
    expect(await v2.bodyOf('d/3.md')).toContain('changed')
    expect(reads.slice(0, 2)).toEqual([VAULT_SNAPSHOT_KEY, 'd/3.md'])       // the body read above is the third
    expect(v2.bm25().search('changed').map(h => h.path)).toEqual(['d/3.md'])
  })
})

describe('image documents', () => {
  const png = () => enc('PNG fake bytes')

  it('paths and the placeholder document', () => {
    expect(isImagePath('attachments/2026-09/pasted.PNG')).toBe(true)
    expect(isImagePath('_system/x.png')).toBe(false)
    expect(isImagePath('notes/a.md')).toBe(false)
    expect(imageDocPath('attachments/a b.jpeg')).toBe('attachments/a b.md')
    const doc = renderImageDoc({ imagePath: 'attachments/pasted-1.png', pastedInto: 'design/Menu.md' })
    expect(doc).toContain('type: image')
    expect(doc).toContain('image: "pasted-1.png"')
    expect(doc).toContain('![[pasted-1.png]]')
    expect(doc).toContain('Pasted into [[Menu]]')
    expect(doc).toContain(`## Description\n\n${DESCRIBING_PLACEHOLDER}`)
    expect(isDescribed(doc)).toBe(false)
    expect(isDescribed(doc.replace(DESCRIBING_PLACEHOLDER, 'A login screen with two buttons.\nTags: ui, login'))).toBe(true)
    expect(isDescribed(doc.replace(DESCRIBING_PLACEHOLDER, 'short'))).toBe(false)
  })

  it('an uploaded image gets its placeholder document (once); undescribed ones are listed for MCP clients', async () => {
    await putFile({ ...deps, now: () => 1_000 }, { path: 'attachments/shot.png', body: png(), mtime: 1, author: 'kim' })
    expect(await ensureImageDoc({ ...deps, now: () => 1_000 }, 'attachments/shot.png')).toBe('created')
    expect(await ensureImageDoc(deps, 'attachments/shot.png')).toBe('exists')
    expect(await ensureImageDoc(deps, 'notes/x.md')).toBe('skipped')
    expect(meta.rows.get('attachments/shot.md')!.author).toBe('strata-bot')
    // The app writes its own placeholder at paste time; the server leaves it alone
    await putFile({ ...deps, now: () => 2_000 }, { path: 'attachments/paste.jpg', body: png(), mtime: 1, author: 'kim' })
    await putFile({ ...deps, now: () => 2_000 }, { path: 'attachments/paste.md', body: enc(renderImageDoc({ imagePath: 'attachments/paste.jpg', pastedInto: 'design/Menu.md' })), mtime: 1, author: 'kim' })
    expect(await ensureImageDoc(deps, 'attachments/paste.jpg')).toBe('exists')
    invalidateVaultView()
    const pending = await undescribedImages(await loadVaultView(deps, true))
    expect(pending.map(p => [p.doc, p.image, p.pastedInto])).toEqual([['attachments/shot.md', 'attachments/shot.png', undefined], ['attachments/paste.md', 'attachments/paste.jpg', 'design/Menu.md']])
    // Once described (by a client over vault_write) it drops off the list
    const described = renderImageDoc({ imagePath: 'attachments/shot.png' }).replace(DESCRIBING_PLACEHOLDER, '검은 배경 위의 파란 아이콘. 텍스트 없음.\nTags: icon, blue')
    await putFile(deps, { path: 'attachments/shot.md', body: enc(described), mtime: 3, author: 'kim' })
    invalidateVaultView()
    expect((await undescribedImages(await loadVaultView(deps, true))).map(p => p.doc)).toEqual(['attachments/paste.md'])
    const r = parse(await callTool({ ...deps, author: 'kim' }, 'images_undescribed', {}))
    expect(r.count).toBe(1)
    expect(r.guide).toContain('vault_write')
  })

  it('vault_read returns the image and its document; PUT of an image creates the document without a queue', async () => {
    await putFile(deps, { path: 'attachments/shot.png', body: png(), mtime: 1, author: 'kim' })
    const r = await callTool({ ...deps, author: 'kim' }, 'vault_read', { path: 'attachments/shot.png' })
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect((r.content[1] as { text: string }).text).toContain('no image document yet')
    const env = { TEAM_TOKEN: 'secret' } as unknown as Env
    const waited: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p) }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    const res = await route(new Request('https://w/v1/file?path=attachments%2Fnew.png', { method: 'PUT', headers: { authorization: 'Bearer secret', 'x-mtime': '5', 'x-author': 'kim' }, body: png() }), env, ctx, deps)
    expect(res.status).toBe(201)
    await Promise.all(waited)
    expect(dec(blobs.objects.get('attachments/new.md')!)).toContain('![[new.png]]')
  })
})

/** What the view does between two heads: drop documents that vanished or changed, add the new versions. */
function applyDelta(index: Bm25, before: Map<string, ParsedVaultDoc>, after: Map<string, ParsedVaultDoc>): Bm25 {
  for (const [path, d] of before) if (after.get(path) !== d) index.remove(path)
  for (const [path, d] of after) if (before.get(path) !== d) index.add(path, d, d.body)
  return index
}

describe('incremental BM25', () => {
  it('re-tokenises only changed documents and keeps scores identical to a fresh index', async () => {
    const { Bm25 } = await import('../src/vaultIndex.js')
    const { parseVaultDoc } = await import('../../mcp/src/lint/vaultDoc.js')
    const mk = (path: string, text: string) => [path, parseVaultDoc(path, text, 1)] as const
    const v1 = new Map([mk('a.md', '# A\n\n배터리 수명 결정'), mk('b.md', '# B\n\n모터 소음 이슈'), mk('c.md', '# C\n\n배터리 교체 주기')])
    const base = new Bm25(v1)
    const v2 = new Map(v1)
    v2.set('b.md', parseVaultDoc('b.md', '# B\n\n배터리 팩 공급사', 2))   // changed
    v2.delete('c.md')                                                       // removed
    v2.set('d.md', parseVaultDoc('d.md', '# D\n\n소음 측정 리포트', 2))     // added
    const incremental = applyDelta(Bm25.from(base), v1, v2)
    const fresh = new Bm25(v2)
    for (const q of ['배터리', '소음', '수명 결정', '공급사']) {
      expect(incremental.search(q, 5).map(h => [h.path, Number(h.score.toFixed(6))])).toEqual(fresh.search(q, 5).map(h => [h.path, Number(h.score.toFixed(6))]))
    }
    expect(incremental.search('교체', 5)).toEqual([])   // the removed document is gone from df too
  })

  it('loadVaultView reuses the view while the head is unchanged and the index across heads', async () => {
    await putFile(deps, { path: 'x.md', body: enc('# X\n\nalpha beta'), mtime: 1, author: 'a' })
    const v1 = await loadVaultView(deps, true)
    expect(v1.bm25().search('alpha', 3)).toHaveLength(1)
    expect(await loadVaultView(deps)).toBe(v1)                       // same head → same view object
    await putFile(deps, { path: 'y.md', body: enc('# Y\n\ngamma'), mtime: 1, author: 'a' })
    const v2 = await loadVaultView(deps)
    expect(v2).not.toBe(v1)
    expect(v2.bm25().search('gamma', 3).map(h => h.path)).toEqual(['y.md'])
    expect(v2.bm25().search('alpha', 3).map(h => h.path)).toEqual(['x.md'])
  })
})

describe('history edge cases', () => {
  it('a failing archive never blocks the save or the delete', async () => {
    const flaky = { ...deps, blobs: Object.assign(Object.create(blobs), { put: async (p: string, b: Uint8Array) => { if (p.startsWith(HISTORY_PREFIX)) throw new Error('R2 down'); return blobs.put(p, b) } }) as MemoryBlobs }
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await putFile(flaky, { path: 'design/A.md', body: enc('v1'), mtime: 1, author: 'ann' })
      const r = await putFile(flaky, { path: 'design/A.md', body: enc('v2'), mtime: 2, author: 'bob' })
      expect(r.status).toBe(200)
      expect(dec(blobs.objects.get('design/A.md')!)).toBe('v2')
      expect(await listVersions(blobs, 'design/A.md')).toEqual([])            // nothing archived…
      const live = await meta.get('design/A.md')
      expect((await deleteFile(flaky, 'design/A.md', live!.etag, 'cat')).status).toBe(200)
      expect(meta.rows.get('design/A.md')!.deleted).toBe(true)                 // …but both writes went through
      expect(quiet).toHaveBeenCalledTimes(2)
    } finally { quiet.mockRestore() }
  })

  it('orders versions saved in the same millisecond deterministically and finds the right previous one after a revert', async () => {
    const frozen = { ...deps, now: () => 5_000 }
    await putFile(frozen, { path: 'n.md', body: enc('one'), mtime: 1, author: 'a' })
    await putFile(frozen, { path: 'n.md', body: enc('two'), mtime: 2, author: 'b' })
    await putFile(frozen, { path: 'n.md', body: enc('three'), mtime: 3, author: 'c' })
    const same = await listVersions(blobs, 'n.md')
    expect(same.map(v => v.at)).toEqual([5_000, 5_000])
    expect(same[0].etag > same[1].etag).toBe(true)                             // equal timestamps: etag descending, stable across calls
    expect(await listVersions(blobs, 'n.md')).toEqual(same)
    expect(await readVersion(blobs, 'n.md', 'f'.repeat(64))).toBeNull()
    // Revert to the very first content: the live etag now equals an archived etag
    await putFile({ ...deps, now: () => 6_000 }, { path: 'n.md', body: enc('one'), mtime: 4, author: 'd' })
    const live = await meta.get('n.md')
    const archived = await listVersions(blobs, 'n.md')
    expect(dec(blobs.objects.get(archived[0].key)!)).toBe('three')
    expect(archived.slice(1).map(x => dec(blobs.objects.get(x.key)!)).sort()).toEqual(['one', 'two'])   // same millisecond: order by etag
    expect(archived.some(v => v.etag === live!.etag)).toBe(true)
    const prev = await previousVersion(blobs, 'n.md', live!.etag)
    expect(dec(prev!.bytes)).toBe('three')                                     // what the revert replaced, not the identical old copy
    expect(prev!.version.author).toBe('c')
  })

  it('history keys: clamps timestamps, rejects malformed etags, survives broken percent-encoding', () => {
    const E = 'e'.repeat(64)
    expect(historyKey('x.md', -5, E, 'a')).toBe(`${HISTORY_PREFIX}x.md/0000000000000.${E}.a.`)
    expect(historyKey('x.md', 1.9, E, 'a')).toBe(`${HISTORY_PREFIX}x.md/0000000000001.${E}.a.`)
    expect(parseHistoryKey(`${HISTORY_PREFIX}x.md/0000000000001.${'g'.repeat(64)}.a`)).toBeNull()   // not hex
    expect(parseHistoryKey(`${HISTORY_PREFIX}x.md/0000000000001.${'a'.repeat(63)}.a`)).toBeNull()   // too short
    expect(parseHistoryKey(`${HISTORY_PREFIX}x.md/000000001.${E}.a`)).toBeNull()                    // timestamp not 13 digits
    expect(parseHistoryKey(`${HISTORY_PREFIX}${E}`)).toBeNull()                                     // no path segment
    expect(parseHistoryKey('other/x.md/0000000000001.' + E + '.a')).toBeNull()
    expect(parseHistoryKey(`${HISTORY_PREFIX}x.md/0000000000001.${E}.%E0%A4%A`)?.author).toBe('%E0%A4%A')
    expect(parseHistoryKey(`${HISTORY_PREFIX}a/b/c.md/0000000000001.${E}.`)).toMatchObject({ path: 'a/b/c.md', author: '' })
  })

  it('diffLines: context 0, empty sides, and inputs beyond the 2000-line cap', () => {
    const zero = diffLines('a\nb\nc', 'a\nB\nc', 0)
    expect(zero.stats).toEqual({ added: 1, removed: 1, unchanged: 2 })
    expect(zero.text).toContain('- b\n+ B')
    expect(zero.text).not.toContain('  a')
    expect(zero.text).not.toContain('  c')
    expect(diffLines('', '')).toEqual({ text: '(no difference)', stats: { added: 0, removed: 0, unchanged: 1 } })
    expect(diffLines('', 'a').stats).toEqual({ added: 1, removed: 1, unchanged: 0 })   // the empty string is one empty line
    expect(diffLines('x\ny', 'x\ny\n', 0).text).toBe('+ ')                              // trailing newline shows as an added empty line
    const big = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join('\n')
    const tailOnly = diffLines(big, `${big}\nextra`)
    expect(tailOnly.text).toBe('(no difference in the first 2000 lines)')
    expect(tailOnly.stats).toEqual({ added: 0, removed: 0, unchanged: 2_000 })
    const headChange = diffLines(big.replace('line 1\n', 'LINE 1\n'), big)
    expect(headChange.stats).toEqual({ added: 1, removed: 1, unchanged: 1_999 })
    expect(headChange.text).toContain('- LINE 1\n+ line 1')
    expect(headChange.text.split('\n').at(-1)).toBe('@@ (compared the first 2000 lines only)')
    expect(diffLines(big, big).text).toBe('(no difference in the first 2000 lines)')
  })
})

describe('recall edge cases', () => {
  const put = (path: string, body: string, author = 'ann', now = 1_000) => putFile({ ...deps, now: () => now }, { path, body: enc(body), mtime: 1, author })

  it('clamps budget, seeds and neighbours to their floors and ceilings', async () => {
    const para = 'Stamina regenerates slowly while a hero rests between fights, and every dodge costs a fixed slice of it. '
    for (let i = 0; i < 15; i++) await put(`design/Stamina ${i}.md`, `# Stamina ${i}\n\n${para.repeat(12)}`)
    await put('design/Hub.md', `# Hub\n\nThe stamina hub.\n\n${Array.from({ length: 25 }, (_, i) => `[[Node ${i}]]`).join(' ')}`)
    for (let i = 0; i < 25; i++) await put(`design/Node ${i}.md`, `# Node ${i}\n\nleaf ${i}`)
    invalidateVaultView()
    // seeds: ceiling 12, floor 1 (negative), default when 0/undefined
    expect((await recall(deps, { query: 'stamina', seeds: 100, neighbours: 0 })).core).toHaveLength(12)
    expect((await recall(deps, { query: 'stamina', seeds: -3, neighbours: 0 })).core).toHaveLength(1)
    expect((await recall(deps, { query: 'stamina', seeds: 0, neighbours: 0 })).core).toHaveLength(5)
    // budget: 100 is raised to the 2 000 floor — excerpts are far longer than 100 chars but bounded by the per-seed share
    const tiny = await recall(deps, { query: 'stamina', budget: 100, seeds: 3, neighbours: 0 })
    expect(tiny.core.every(d => d.excerpt.length > 100)).toBe(true)
    expect(tiny.core.every(d => d.excerpt.length <= Math.floor(2_000 / 3) + '\n[…]'.length)).toBe(true)
    expect(tiny.core.every(d => d.excerpt.endsWith('[…]'))).toBe(true)
    // budget: 1e9 is capped at 60 000 — three ~1 300-char documents fit whole either way, so the cap shows in the excerpt being intact
    const huge = await recall(deps, { query: 'stamina', budget: 1e9, seeds: 3, neighbours: 0 })
    expect(huge.core.every(d => !d.excerpt.endsWith('[…]'))).toBe(true)
    // neighbours: ceiling 20, 0 means none, NaN falls back to the default 8
    const hub = (o: Partial<Parameters<typeof recall>[1]>) => recall(deps, { query: 'stamina hub', seeds: 1, ...o })
    expect((await hub({ neighbours: 99 })).around).toHaveLength(20)
    expect((await hub({ neighbours: 0 })).around).toHaveLength(0)
    expect((await hub({ neighbours: Number('abc') })).around).toHaveLength(8)
    expect((await hub({})).around).toHaveLength(8)
    expect((await hub({ neighbours: 3 })).around.every(d => d.why === 'links with Hub')).toBe(true)
  })

  it('memory sections keep note order on equal scores and are capped at five; remarks only about seeds', async () => {
    await put('design/Stamina.md', '# Stamina\n\nregen 5/s. See [[Combat Loop]].')
    await put('design/Combat Loop.md', '# Combat Loop\n\nDodging costs [[Stamina]].')
    await put('design/Menu.md', '# Menu\n\nContinue, options. Nothing about stamina here.')
    const sections = Array.from({ length: 7 }, (_, i) => `## S${i}\n- stamina note ${i}`).join('\n\n')
    await put(memberNotePath(DEFAULT_MEMBER), `# Librarian — memory\n\n${sections}\n\n## Other\n- menu copy is fine`)
    await put('_members/Librarian/design/Stamina.md', '# Librarian on [[Stamina]]\n\n### One question\n- about the seed', 'strata-bot')
    await put('_members/Librarian/design/Combat Loop.md', '# Librarian on [[Combat Loop]]\n\n### One question\n- about a neighbour only', 'strata-bot')
    await put('_members/Librarian/design/Menu.md', '# Librarian on [[Menu]]\n\n### One question\n- unrelated', 'strata-bot')
    invalidateVaultView()
    const r = await recall(deps, { query: 'stamina regen', seeds: 1, neighbours: 5 })
    expect(r.core.map(d => d.path)).toEqual(['design/Stamina.md'])
    expect(r.around.map(d => d.path)).toEqual(['design/Combat Loop.md'])
    // Every S-section scores 1/2 (one of the two query terms): the sort is stable, so the first five win in note order
    expect(r.memory.map(m => m.heading)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4'])
    expect(r.memory.every(m => m.member === 'Librarian')).toBe(true)
    // Remarks: the seed's, not the neighbour's, not the unrelated one
    expect(r.remarks.map(x => x.about)).toEqual(['design/Stamina.md'])
    expect(r.remarks[0].excerpt).toContain('about the seed')
    expect(r.markdown).toContain('**Librarian** on design/Stamina.md')
    expect(r.markdown).not.toContain('about a neighbour only')
    // A disabled member's memory is not consulted
    const disabled = { ...DEFAULT_MEMBER, id: 'ghost', name: 'Ghost', enabled: false }
    await put('_system/members.json', JSON.stringify({ version: 1, members: [DEFAULT_MEMBER, disabled] }))
    await put(memberNotePath(disabled), '# Ghost — memory\n\n## G\n- stamina stamina regen')
    invalidateVaultView()
    const r2 = await recall(deps, { query: 'stamina regen', seeds: 1, neighbours: 0 })
    expect(r2.memory.some(m => m.member === 'Ghost')).toBe(false)
  })

  it('a neighbour that is somebody else\'s personal document is dropped for other viewers, kept for its owner', async () => {
    await put('design/Stamina.md', '# Stamina\n\nregen 5/s. Also see [[Secret]] and [[Combat Loop]].')
    await put('design/Combat Loop.md', '# Combat Loop\n\n[[Stamina]] is spent here.')
    await put('_personal/2002/design/Secret.md', '# Secret\n\nlee\'s private take on [[Stamina]]', 'lee')
    invalidateVaultView()
    const kim = await recall(deps, { query: 'stamina', viewer: { sub: '1001' }, seeds: 1 })
    expect(kim.around.map(d => d.path)).toEqual(['design/Combat Loop.md'])
    expect(kim.sources).not.toContain('_personal/2002/design/Secret.md')
    const lee = await recall(deps, { query: 'stamina', viewer: { sub: '2002' }, seeds: 1 })
    expect(lee.around.map(d => d.path).sort()).toEqual(['_personal/2002/design/Secret.md', 'design/Combat Loop.md'])
    expect(lee.around.find(d => d.path.startsWith('_personal/'))?.personal).toBe(true)
    expect(lee.markdown).toContain('_(personal — only you see this)_')
    const token = await recall(deps, { query: 'stamina', viewer: { sub: 'service', service: true }, seeds: 1 })
    expect(token.around.map(d => d.path)).toEqual(['design/Combat Loop.md'])
    const nobody = await recall(deps, { query: 'stamina', seeds: 1 })
    expect(nobody.around.map(d => d.path)).toEqual(['design/Combat Loop.md'])
  })
})

describe('image document edge cases', () => {
  it('renders exactly the placeholder the app writes at paste time (src/lib/imageDoc.ts asserts the same bytes)', () => {
    expect(renderImageDoc({ imagePath: 'attachments/2026-09/pasted-1.png', pastedInto: 'design/Menu.md' })).toBe([
      '---', 'title: "pasted-1"', 'type: image', 'image: "pasted-1.png"', 'pasted_into: "design/Menu.md"', 'tags: [image]', '---', '',
      '# pasted-1', '', '![[pasted-1.png]]', '', 'Pasted into [[Menu]]', '', '## Description', '', DESCRIBING_PLACEHOLDER, '',
    ].join('\n'))
    expect(renderImageDoc({ imagePath: 'a/say "hi".png' })).toContain('title: "say \\"hi\\""')
  })

  it('isDescribed: CRLF, a missing section, text outside the section, and a following section', () => {
    const base = renderImageDoc({ imagePath: 'a/b.png' })
    const described = base.replace(DESCRIBING_PLACEHOLDER, 'A login screen with two buttons and a logo.')
    expect(isDescribed(described.replace(/\n/g, '\r\n'))).toBe(true)
    expect(isDescribed(base.replace(/\n/g, '\r\n'))).toBe(false)
    expect(isDescribed(base.replace('## Description', '## Notes'))).toBe(false)
    expect(isDescribed(`${base}\n## Appendix\n\nA long paragraph that is not the description at all, really.`)).toBe(false)
    expect(isDescribed(base.replace(DESCRIBING_PLACEHOLDER, `Text: SETTINGS\nTags: ui, dark\n\n## Appendix\n\n${'x'.repeat(100)}`))).toBe(true)
    expect(isDescribed(base.replace('## Description', '## description'))).toBe(false)                       // case-insensitive heading, still empty
    expect(isDescribed(base.replace('## Description', '## description').replace(DESCRIBING_PLACEHOLDER, 'Twenty characters!!!'))).toBe(true)
    expect(isDescribed(base.replace(DESCRIBING_PLACEHOLDER, '   \n\t\n'))).toBe(false)
  })

  it('undescribedImages orders by the document\'s server time, not insertion, and ignores non-image documents', async () => {
    const png = enc('PNG')
    for (const [name, at] of [['late', 3_000], ['early', 1_000], ['mid', 2_000]] as const) {
      await putFile({ ...deps, now: () => at }, { path: `attachments/${name}.png`, body: png, mtime: 1, author: 'kim' })
      await putFile({ ...deps, now: () => at }, { path: `attachments/${name}.md`, body: enc(renderImageDoc({ imagePath: `attachments/${name}.png` })), mtime: 1, author: 'kim' })
    }
    await putFile({ ...deps, now: () => 500 }, { path: 'notes/plain.md', body: enc('# plain\n\n## Description\n\n'), mtime: 1, author: 'kim' })
    invalidateVaultView()
    const pending = await undescribedImages(await loadVaultView(deps, true))
    expect(pending.map(p => p.doc)).toEqual(['attachments/early.md', 'attachments/mid.md', 'attachments/late.md'])
    expect(pending.map(p => p.since)).toEqual([1_000, 2_000, 3_000])
  })

  it('ensureImageDoc recreates the document when the previous one was deleted, and skips dot-folders', async () => {
    await putFile(deps, { path: 'attachments/shot.png', body: enc('PNG'), mtime: 1, author: 'kim' })
    expect(await ensureImageDoc(deps, 'attachments/shot.png')).toBe('created')
    const doc = await meta.get('attachments/shot.md')
    await deleteFile(deps, 'attachments/shot.md', doc!.etag, 'kim')
    expect(await ensureImageDoc({ ...deps, now: () => 9_000 }, 'attachments/shot.png')).toBe('created')
    expect(meta.rows.get('attachments/shot.md')).toMatchObject({ deleted: false, updatedAt: 9_000, author: 'strata-bot' })
    expect(await ensureImageDoc(deps, 'attachments\\shot.png')).toBe('exists')                  // backslashes are normalised
    expect(await ensureImageDoc(deps, '.trash/old.png')).toBe('skipped')
    expect(await ensureImageDoc(deps, '_system/x.png')).toBe('skipped')
    expect(isImagePath('attachments/.hidden/x.png')).toBe(false)
    expect(isImagePath('a/b.svg')).toBe(false)
  })
})

describe('vault view edge cases', () => {
  it('a corrupt or foreign snapshot is ignored and replaced; a stale entry is re-read, the rest comes from the index', async () => {
    const { VAULT_SNAPSHOT_KEY, decodeSnapshot } = await import('../src/vaultIndex.js')
    for (let i = 0; i < 3; i++) await putFile(deps, { path: `d/${i}.md`, body: enc(`# ${i}\n\nbody ${i} snapshot`), mtime: 1, author: 'a' })
    blobs.objects.set(VAULT_SNAPSHOT_KEY, enc('{not json'))
    invalidateVaultView()
    const v1 = await loadVaultView(deps, true)
    expect(v1.docs.size).toBe(3)
    const rewritten = await decodeSnapshot(blobs.objects.get(VAULT_SNAPSHOT_KEY)!)
    expect(rewritten.map(d => d.path).sort()).toEqual(['d/0.md', 'd/1.md', 'd/2.md'])
    // A cold isolate with the snapshot reads nothing from R2 and searches straight from the stored index
    invalidateVaultView()
    const reads: string[] = []
    const spied = { ...deps, blobs: Object.assign(Object.create(blobs), { get: async (p: string) => { reads.push(p); return blobs.get(p) } }) as MemoryBlobs }
    const v2 = await loadVaultView(spied, true)
    expect(reads).toEqual([VAULT_SNAPSHOT_KEY])
    expect(v2.bm25().search('snapshot').map(h => h.path).sort()).toEqual(['d/0.md', 'd/1.md', 'd/2.md'])
    expect(v2.docs.get('d/1.md')?.title).toBe('1')
    // One document changed since: only that one is read, and the index reflects the new text
    await putFile(deps, { path: 'd/0.md', body: enc('# 0\n\nchanged text'), mtime: 2, author: 'b' })
    invalidateVaultView(); reads.length = 0
    const v3 = await loadVaultView(spied, true)
    expect(reads.filter(p => p.startsWith('d/'))).toEqual(['d/0.md'])
    expect(v3.bm25().search('changed').map(h => h.path)).toEqual(['d/0.md'])
    expect(v3.bm25().search('snapshot').map(h => h.path).sort()).toEqual(['d/1.md', 'd/2.md'])   // the old text of d/0 is gone
    expect(await v3.bodyOf('d/0.md')).toContain('changed text')
    // A snapshot written from that warm-ish view (no text in memory) round-trips the same index
    const { writeVaultSnapshot } = await import('../src/vaultIndex.js')
    await writeVaultSnapshot(deps, v3)
    invalidateVaultView(); reads.length = 0
    const v4 = await loadVaultView(spied, true)
    expect(reads).toEqual([VAULT_SNAPSHOT_KEY])
    expect(v4.bm25().search('changed').map(h => h.path)).toEqual(['d/0.md'])
    expect(v4.bm25().search('snapshot').map(h => h.path).sort()).toEqual(['d/1.md', 'd/2.md'])
  })

  it('caps R2 reads per load at 800 and catches up on the next forced load', async () => {
    const n = 810
    const rows: Promise<unknown>[] = []
    for (let i = 0; i < n; i++) rows.push(meta.upsert({ path: `big/${i}.md`, etag: `e${i}`, size: 1, mtime: 1, author: 'a', authorSub: '', deleted: false, updatedAt: 1 }).then(() => blobs.put(`big/${i}.md`, enc(`# ${i}`))))
    await Promise.all(rows)
    invalidateVaultView()
    const reads: string[] = []
    const spied = { ...deps, blobs: Object.assign(Object.create(blobs), { get: async (p: string) => { reads.push(p); return blobs.get(p) } }) as MemoryBlobs }
    const v1 = await loadVaultView(spied, true)
    expect(reads.filter(p => p.startsWith('big/'))).toHaveLength(800)
    expect(v1.docs.size).toBe(800)
    expect(v1.rows.size).toBe(n)                                                // rows are complete even when contents lag
    // Same head, no force: the isolate cache is served as is (the missing ten wait for the next real load)
    expect(await loadVaultView(spied)).toBe(v1)
    reads.length = 0
    const v2 = await loadVaultView(spied, true)
    expect(reads.filter(p => p.startsWith('big/'))).toHaveLength(10)
    expect(v2.docs.size).toBe(n)
  })

  it('Bm25 stays exact when a document is removed and later re-added through a chain of incremental indexes', async () => {
    const { Bm25 } = await import('../src/vaultIndex.js')
    const { parseVaultDoc } = await import('../../mcp/src/lint/vaultDoc.js')
    const mk = (p: string, t: string, m = 1) => [p, parseVaultDoc(p, t, m)] as const
    const v1 = new Map([mk('a.md', '# A\n\nalpha beta'), mk('b.md', '# B\n\nbeta gamma'), mk('c.md', '# C\n\ngamma delta')])
    const i1 = new Bm25(v1)
    const v2 = new Map(v1); v2.delete('c.md')
    const i2 = applyDelta(Bm25.from(i1), v1, v2)
    expect(i2.search('delta')).toEqual([])
    const v3 = new Map(v2); v3.set('c.md', parseVaultDoc('c.md', '# C\n\ngamma delta', 2))
    const i3 = applyDelta(Bm25.from(i2), v2, v3)
    const fresh = new Bm25(v3)
    const scores = (idx: InstanceType<typeof Bm25>, q: string) => idx.search(q).map(h => [h.path, Number(h.score.toFixed(6))])
    for (const q of ['gamma', 'delta', 'beta', 'alpha']) expect(scores(i3, q)).toEqual(scores(fresh, q))
    expect(scores(applyDelta(Bm25.from(i1), v1, v3), 'gamma')).toEqual(scores(fresh, 'gamma'))   // skipping a generation is fine too
    expect(i3.search('')).toEqual([])
    expect(i3.search('beta', 10, new Set(['a.md'])).map(h => h.path)).toEqual(['b.md'])
  })
})

describe('Korean text from macOS (NFD)', () => {
  it('tokenises, links and stores decomposed Hangul as if it were composed', async () => {
    const { tokenize } = await import('../src/vaultIndex.js')
    const { normalizeVaultPath } = await import('../src/sync.js')
    const { normalizeWikiLink } = await import('../../mcp/src/lint/graph.js')
    const nfc = '배터리 수명'
    const nfd = nfc.normalize('NFD')
    expect(nfd).not.toBe(nfc)
    expect(tokenize(nfd)).toEqual(tokenize(nfc))
    expect(normalizeVaultPath(`온다/이슈/${nfd}.md`)).toBe(`온다/이슈/${nfc}.md`)
    expect(normalizeWikiLink(nfd)).toBe(normalizeWikiLink(nfc))
    // An NFD document body is found by an NFC query through the index
    const { parseVaultDoc } = await import('../../mcp/src/lint/vaultDoc.js')
    const idx = new Bm25(new Map([['a.md', parseVaultDoc('a.md', `# ${nfd}\n\n${nfd} 저하 이슈`.normalize('NFD'), 1)]]))
    expect(idx.search('배터리').map(h => h.path)).toEqual(['a.md'])
  })
})
