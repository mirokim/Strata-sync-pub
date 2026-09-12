import { describe, it, expect, beforeEach } from 'vitest'
import { reviewDocument, isReviewablePath, shouldEnqueueReview, reviewPathFor, PERSONAS, REVIEW_STATE_KEY, REVIEW_COOLDOWN_MS, type ReviewDeps } from '../src/review.js'
import { putFile, type SyncDeps } from '../src/sync.js'
import { MemoryMeta, MemoryBlobs, enc, dec } from './fakes.js'

const NOW = Date.parse('2026-09-14T01:00:00Z')
const LONG_BODY = '## Goal\n\n' + 'The enemy telegraphs every heavy attack with a two-frame flash and a low tone. '.repeat(8) + '\n\n## Rules\n\n' + 'Parry windows scale with difficulty tier; see [[Combat System]]. '.repeat(6)

let meta: MemoryMeta, blobs: MemoryBlobs
let calls: { system: string; user: string; effort: string }[]
let deps: ReviewDeps
let clock = NOW

beforeEach(() => {
  meta = new MemoryMeta(); blobs = new MemoryBlobs(); calls = []; clock = NOW
  deps = {
    meta, blobs, maxFileBytes: 1024 * 1024, now: () => clock,
    llm: async ({ system, user, effort }) => {
      calls.push({ system, user, effort })
      const who = /You are the (.+?) of a game studio/.exec(system)?.[1] ?? '?'
      return who === 'Chief Director' && system.includes('Combine the reviews')
        ? '## Shared concerns\n- everyone worries about parry timing\n## Decision needed\n- lock the tier table (design director)'
        : `### Risks\n- ${who} risk\n### Questions for the author\n- ${who} question\n### One thing to do next\n- ${who} next`
    },
  }
})

const save = (path: string, text: string, author = 'ann', ifMatch?: string) =>
  putFile(deps as SyncDeps, { path, body: enc(text), mtime: clock, author, ifMatch })

describe('eligibility', () => {
  it('reviews ordinary markdown, never generated folders, dot paths, conflict copies or non-md', () => {
    expect(isReviewablePath('active/Enemy AI Spec.md')).toBe(true)
    expect(isReviewablePath('_agent/2026-09-13-idea.md')).toBe(false)
    expect(isReviewablePath('_reviews/x.md')).toBe(false)
    expect(isReviewablePath('.obsidian/x.md')).toBe(false)
    expect(isReviewablePath('active/Doc (conflict bob 2026-09-12 1953).md')).toBe(false)
    expect(isReviewablePath('img/x.png')).toBe(false)
    expect(isReviewablePath('notes/Doc.md', ['active'])).toBe(false)
    expect(isReviewablePath('active/sub/Doc.md', ['active/'])).toBe(true)
  })
  it('producer pre-filter skips bot writes, deletes and tiny files', () => {
    expect(shouldEnqueueReview({ path: 'a.md', deleted: false, size: 5000, author: 'ann' })).toBe(true)
    expect(shouldEnqueueReview({ path: 'a.md', deleted: false, size: 5000, author: 'strata-bot' })).toBe(false)
    expect(shouldEnqueueReview({ path: 'a.md', deleted: true, size: 5000, author: 'ann' })).toBe(false)
    expect(shouldEnqueueReview({ path: 'a.md', deleted: false, size: 50, author: 'ann' })).toBe(false)
    expect(reviewPathFor('active/Enemy AI Spec.md')).toBe('_reviews/Enemy AI Spec.md')
  })
})

describe('reviewDocument', () => {
  it('asks each persona independently, synthesises, and writes the review into the vault', async () => {
    const saved = await save('active/Enemy AI Spec.md', LONG_BODY)
    const etag = (saved.body as { etag: string }).etag
    const out = await reviewDocument(deps, { path: 'active/Enemy AI Spec.md', etag })
    expect(out).toEqual({ status: 'reviewed', reviewPath: '_reviews/Enemy AI Spec.md', personas: 5 })

    expect(calls.length).toBe(PERSONAS.length + 1)
    const personaCalls = calls.slice(0, PERSONAS.length)
    for (const c of personaCalls) {
      expect(c.user).toContain('Document: Enemy AI Spec')
      expect(c.user).toContain('telegraphs every heavy attack')
      expect(c.user).not.toContain('Art Director risk')          // independent: no other review visible
      expect(c.effort).toBe('medium')
    }
    expect(calls[PERSONAS.length].effort).toBe('high')
    expect(calls[PERSONAS.length].user).toContain('# Programming Director')

    const row = await meta.get('_reviews/Enemy AI Spec.md')
    expect(row?.author).toBe('strata-bot')
    const md = dec(blobs.objects.get('_reviews/Enemy AI Spec.md')!)
    expect(md).toContain('# Director review — [[Enemy AI Spec]]')
    expect(md).toContain('## Shared concerns')
    expect(md).toContain('## Art Director')
    expect(md).toContain(`reviewed_etag: ${etag}`)
    expect(md).toContain('graph_weight: low')
    expect(blobs.objects.has(REVIEW_STATE_KEY)).toBe(true)
  })

  it('reviews a version once; re-reviews after the cooldown when the content changed', async () => {
    const saved = await save('Doc.md', LONG_BODY)
    const etag = (saved.body as { etag: string }).etag
    expect((await reviewDocument(deps, { path: 'Doc.md' })).status).toBe('reviewed')
    expect(await reviewDocument(deps, { path: 'Doc.md' })).toEqual({ status: 'skipped', reason: 'already reviewed this version' })

    // edited right away → cooldown
    clock += 60_000
    await save('Doc.md', LONG_BODY + '\n\nmore', 'ann', etag)
    expect((await reviewDocument(deps, { path: 'Doc.md' })).reason).toBe('cooldown')

    // edited again after the cooldown → reviewed again, still one review file (replaced)
    clock += REVIEW_COOLDOWN_MS + 1
    calls = []
    expect((await reviewDocument(deps, { path: 'Doc.md' })).status).toBe('reviewed')
    expect(calls.length).toBe(PERSONAS.length + 1)
    expect((await meta.get('_reviews/Doc.md'))?.deleted).toBe(false)
  })

  it('skips stale jobs, short notes, skipped docs and missing documents', async () => {
    await save('Short.md', '# short\n\ntiny')
    expect((await reviewDocument(deps, { path: 'Short.md' })).reason).toBe('too short to review')

    await save('Skip.md', '---\ngraph_weight: skip\n---\n' + LONG_BODY)
    expect((await reviewDocument(deps, { path: 'Skip.md' })).reason).toBe('graph_weight: skip')

    const saved = await save('Doc.md', LONG_BODY)
    expect((await reviewDocument(deps, { path: 'Doc.md', etag: 'old-etag' })).reason).toBe('superseded by a newer save')
    void saved
    expect((await reviewDocument(deps, { path: 'Missing.md' })).reason).toBe('document gone')
    expect((await reviewDocument(deps, { path: '_agent/x.md' })).reason).toBe('path not reviewable')
    expect(calls.length).toBe(0)
  })

  it('truncates very long documents before sending them', async () => {
    await save('Huge.md', '# Huge\n\n' + 'x'.repeat(30_000))
    await reviewDocument(deps, { path: 'Huge.md' })
    expect(calls[0].user.length).toBeLessThan(13_500)
    expect(calls[0].user).toContain('truncated for review')
  })
})
