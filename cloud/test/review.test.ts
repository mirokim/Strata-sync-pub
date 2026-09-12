import { describe, it, expect, beforeEach } from 'vitest'
import { reviewDocument, isReviewablePath, shouldEnqueueReview, reviewPathFor, REVIEW_STATE_KEY, REVIEW_COOLDOWN_MS, type ReviewDeps } from '../src/review.js'
import { PRESETS, readReviewers, writeReviewers, validateReviewers, REVIEWERS_KEY, DEFAULT_REVIEWERS } from '../src/reviewers.js'

const PERSONAS = PRESETS.game.reviewers
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
    reviewers: PRESETS.game,
    llm: async ({ system, user, effort }) => {
      calls.push({ system, user, effort })
      const who = (/You are the (.+?) (?:reviewing|of a game)/.exec(system)?.[1] ?? '?')
      return who === 'Chief Director' && system.includes('Combine the reviews')
        ? '## Shared concerns\n- everyone worries about parry timing\n## Decision needed\n- lock the tier table (design director)'
        : `### Risks\n- ${who} risk\n### Questions for the author\n- ${who} question\n### One thing to do next\n- ${who} next`
    },
  }
})

const reason = (o: Awaited<ReturnType<typeof reviewDocument>>) => (o as { reason?: string }).reason

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
    expect(reviewPathFor('active/Enemy AI Spec.md')).toBe('_reviews/active/Enemy AI Spec.md')
    expect(reviewPathFor('Root Doc.md')).toBe('_reviews/Root Doc.md')
  })
})

describe('reviewDocument', () => {
  it('asks each persona independently, synthesises, and writes the review into the vault', async () => {
    const saved = await save('active/Enemy AI Spec.md', LONG_BODY)
    const etag = (saved.body as { etag: string }).etag
    const out = await reviewDocument(deps, { path: 'active/Enemy AI Spec.md', etag })
    expect(out).toEqual({ status: 'reviewed', reviewPath: '_reviews/active/Enemy AI Spec.md', personas: 5 })

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

    const row = await meta.get('_reviews/active/Enemy AI Spec.md')
    expect(row?.author).toBe('strata-bot')
    const md = dec(blobs.objects.get('_reviews/active/Enemy AI Spec.md')!)
    expect(md).toContain('# Review — [[Enemy AI Spec]]')
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
    const deferred = await reviewDocument(deps, { path: 'Doc.md' })
    expect(deferred.status).toBe('deferred')
    expect((deferred as { retryAfterMs: number }).retryAfterMs).toBe(REVIEW_COOLDOWN_MS - 60_000)

    // edited again after the cooldown → reviewed again, still one review file (replaced)
    clock += REVIEW_COOLDOWN_MS + 1
    calls = []
    expect((await reviewDocument(deps, { path: 'Doc.md' })).status).toBe('reviewed')
    expect(calls.length).toBe(PERSONAS.length + 1)
    expect((await meta.get('_reviews/Doc.md'))?.deleted).toBe(false)
  })

  it('skips stale jobs, short notes, skipped docs and missing documents', async () => {
    await save('Short.md', '# short\n\ntiny')
    expect(reason(await reviewDocument(deps, { path: 'Short.md' }))).toBe('too short to review')

    await save('Skip.md', '---\ngraph_weight: skip\n---\n' + LONG_BODY)
    expect(reason(await reviewDocument(deps, { path: 'Skip.md' }))).toBe('graph_weight: skip')

    const saved = await save('Doc.md', LONG_BODY)
    expect(reason(await reviewDocument(deps, { path: 'Doc.md', etag: 'old-etag' }))).toBe('superseded by a newer save')
    void saved
    expect(reason(await reviewDocument(deps, { path: 'Missing.md' }))).toBe('document gone')
    expect(reason(await reviewDocument(deps, { path: '_agent/x.md' }))).toBe('path not reviewable')
    expect(calls.length).toBe(0)
  })

  it('truncates very long documents before sending them', async () => {
    await save('Huge.md', '# Huge\n\n' + 'x'.repeat(30_000))
    await reviewDocument(deps, { path: 'Huge.md' })
    expect(calls[0].user.length).toBeLessThan(13_500)
    expect(calls[0].user).toContain('truncated for review')
  })
})

describe('reviewer configuration', () => {
  it('defaults to the generic set and validates edits', async () => {
    expect((await readReviewers({ blobs })).synthesizer).toBe(DEFAULT_REVIEWERS.synthesizer)
    expect(validateReviewers({ ...PRESETS.legal, synthesizer: 'nobody' })).toMatch(/synthesizer/)
    expect(validateReviewers({ ...PRESETS.legal, reviewers: [] })).toMatch(/at least one/)
    expect(validateReviewers({ ...PRESETS.legal, reviewers: PRESETS.legal.reviewers.map(r => ({ ...r, enabled: false })) })).toMatch(/enable/)
    expect(validateReviewers({ ...PRESETS.legal, reviewers: [...PRESETS.legal.reviewers, { ...PRESETS.legal.reviewers[0] }] })).toMatch(/duplicate/)
    expect(validateReviewers(PRESETS.research)).toBeNull()
    await writeReviewers({ blobs }, PRESETS.legal)
    expect(blobs.objects.has(REVIEWERS_KEY)).toBe(true)
    expect((await readReviewers({ blobs })).context).toBe(PRESETS.legal.context)
  })

  it('reviews with the stored set: only enabled reviewers, the configured synthesizer, the vault context', async () => {
    const custom = { ...PRESETS.generic, context: 'the studio lore bible', synthesizer: 'reader', reviewers: PRESETS.generic.reviewers.map(r => ({ ...r, enabled: r.id !== 'risk' })) }
    await writeReviewers({ blobs }, custom)
    const stored: ReviewDeps = { ...deps, reviewers: undefined, llm: async ({ system, user, effort }) => { calls.push({ system, user, effort }); return system.includes('Combine') ? '## Shared concerns\n- x' : '### Risks\n- y' } }
    await save('active/Lore.md', LONG_BODY)
    const out = await reviewDocument(stored, { path: 'active/Lore.md' })
    expect(out).toMatchObject({ status: 'reviewed', personas: 4 })
    expect(calls).toHaveLength(5)
    expect(calls.every(c => c.system.includes('the studio lore bible'))).toBe(true)
    expect(calls.some(c => c.system.includes('Risk reviewer'))).toBe(false)
    expect(calls[4].system).toContain('You are the Reader advocate')
    expect(calls[4].system).toContain('3 other reviewers')
    const md = dec(blobs.objects.get('_reviews/active/Lore.md')!)
    expect(md).toContain('4 independent reads')
    expect(md).toContain('## Editor')
    expect(md).not.toContain('## Risk reviewer')
  })
})
