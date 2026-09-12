import { describe, it, expect, beforeEach } from 'vitest'
import { putFile, deleteFile, type SyncDeps } from '../src/sync.js'
import { listVersions, readVersion, previousVersion, diffLines, historyKey, parseHistoryKey, HISTORY_KEEP, HISTORY_PREFIX } from '../src/history.js'
import { recall, splitNoteSections, fusedSearch } from '../src/recall.js'
import { loadVaultView, invalidateVaultView } from '../src/vaultIndex.js'
import { callTool, type McpDeps } from '../src/mcp.js'
import { memberNotePath, DEFAULT_MEMBER } from '../src/members.js'
import { reactToSave, type LlmCall } from '../src/reactions.js'
import { route, type Env } from '../src/index.js'
import { MemoryMeta, MemoryBlobs, enc, dec } from './fakes.js'
import { renderImageDoc, setDescription, tagsFrom, describeImage, isImagePath, imageDocPath, describedImageEtag, DESCRIBING_PLACEHOLDER } from '../src/images.js'

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
    expect(parseHistoryKey(key, 3)).toEqual({ path: 'a/b c.md', at: 5, etag: 'e'.repeat(64), author: '김 미로/ok', size: 3, key })
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
    expect(v2.docs.get('d/3.md')?.body).toContain('changed')
    expect(reads).toEqual([VAULT_SNAPSHOT_KEY, 'd/3.md'])
    expect(v2.contents.get('d/3.md')).toContain('changed')
  })
})

describe('image documents', () => {
  const png = () => enc('\x89PNG fake bytes')

  it('paths, tags and the client-side placeholder document', () => {
    expect(isImagePath('attachments/2026-09/pasted.PNG')).toBe(true)
    expect(isImagePath('_system/x.png')).toBe(false)
    expect(isImagePath('notes/a.md')).toBe(false)
    expect(imageDocPath('attachments/a b.jpeg')).toBe('attachments/a b.md')
    expect(tagsFrom('blah\nTags: UI, Login Screen, #dark-mode, ui')).toEqual(['ui', 'login-screen', 'dark-mode'])
    const doc = renderImageDoc({ imagePath: 'attachments/pasted-1.png', pastedInto: 'design/Menu.md' })
    expect(doc).toContain('type: image')
    expect(doc).toContain('image: "pasted-1.png"')
    expect(doc).toContain('![[pasted-1.png]]')
    expect(doc).toContain('Pasted into [[Menu]]')
    expect(doc).toContain(`## Description\n\n${DESCRIBING_PLACEHOLDER}`)
  })

  it('setDescription replaces only the Description section and stamps the frontmatter', () => {
    const before = renderImageDoc({ imagePath: 'a.png', pastedInto: 'b.md' }) + '\n## Notes\n\nkeep me\n'
    const after = setDescription(before, 'A login screen.\nText: Sign in\nTags: ui, login', { by: 'test-model', at: 1_000, imageEtag: 'e1' })
    expect(after).toContain('described_by: "test-model"')
    expect(after).toContain('described_image_etag: "e1"')
    expect(after).toContain('tags: [image, ui, login]')
    expect(after).toContain('pasted_into: "b.md"')
    expect(after).toContain('## Description\n\nA login screen.\nText: Sign in\nTags: ui, login\n\n## Notes\n\nkeep me')
    expect(after).not.toContain(DESCRIBING_PLACEHOLDER)
    expect(describedImageEtag(after)).toBe('e1')
  })

  it('describeImage writes a new document, updates a client placeholder, and is idempotent per image version', async () => {
    const calls: string[] = []
    const ddeps = { ...deps, now: () => 7_000, model: 'm', describe: async (_b: Uint8Array, mime: string, prompt: string) => { calls.push(mime); return prompt.includes('search index') ? 'Two buttons on a dark screen.\nTags: ui, buttons' : '' } }
    await putFile(deps, { path: 'attachments/shot.png', body: png(), mtime: 1, author: 'kim' })
    expect(await describeImage(ddeps, { kind: 'describe', path: 'attachments/shot.png' })).toMatchObject({ status: 'described', doc: 'attachments/shot.md' })
    const created = dec(blobs.objects.get('attachments/shot.md')!)
    expect(created).toContain('Two buttons on a dark screen.')
    expect(created).toContain('tags: [image, ui, buttons]')
    expect(meta.rows.get('attachments/shot.md')!.author).toBe('strata-bot')
    expect(calls).toEqual(['image/png'])
    expect(await describeImage(ddeps, { kind: 'describe', path: 'attachments/shot.png' })).toEqual({ status: 'skipped', reason: 'already described' })
    // A placeholder written by the app at paste time is completed in place
    await putFile(deps, { path: 'attachments/paste.jpg', body: png(), mtime: 1, author: 'kim' })
    await putFile(deps, { path: 'attachments/paste.md', body: enc(renderImageDoc({ imagePath: 'attachments/paste.jpg', pastedInto: 'design/Menu.md' })), mtime: 1, author: 'kim' })
    expect((await describeImage(ddeps, { kind: 'describe', path: 'attachments/paste.jpg' })).status).toBe('described')
    const updated = dec(blobs.objects.get('attachments/paste.md')!)
    expect(updated).toContain('Pasted into [[Menu]]')
    expect(updated).not.toContain(DESCRIBING_PLACEHOLDER)
    expect(await describeImage(ddeps, { kind: 'describe', path: 'attachments/paste.jpg', etag: 'old' })).toEqual({ status: 'skipped', reason: 'superseded by a newer upload' })
    expect(await describeImage(ddeps, { kind: 'describe', path: 'notes/x.md' })).toEqual({ status: 'skipped', reason: 'not an image' })
  })

  it('vault_read returns the image and its document; PUT of an image queues a describe job', async () => {
    await putFile(deps, { path: 'attachments/shot.png', body: png(), mtime: 1, author: 'kim' })
    const r = await callTool({ ...deps, author: 'kim' }, 'vault_read', { path: 'attachments/shot.png' })
    expect(r.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' })
    expect((r.content[1] as { text: string }).text).toContain('no image document yet')
    const sent: unknown[] = []
    const env = { TEAM_TOKEN: 'secret', REACTION_QUEUE: { send: async (m: unknown) => { sent.push(m) } } } as unknown as Env
    const waited: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { waited.push(p) }, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
    const res = await route(new Request('https://w/v1/file?path=attachments%2Fnew.png', { method: 'PUT', headers: { authorization: 'Bearer secret', 'x-mtime': '5', 'x-author': 'kim' }, body: png() }), env, ctx, deps)
    expect(res.status).toBe(201)
    await Promise.all(waited)
    expect(sent).toEqual([{ kind: 'describe', path: 'attachments/new.png', etag: meta.rows.get('attachments/new.png')!.etag }])
  })
})

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
    const incremental = new Bm25(v2, base)
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
