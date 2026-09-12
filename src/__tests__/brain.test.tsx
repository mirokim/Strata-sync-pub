import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { LoadedDocument } from '@/types'
import { around, activityHeat, heatColor, remarkBody, normalizeLinkTarget, buildLinkIndex } from '@/lib/brain'
import { buildNodeColorMap, getNodeColor, HEAT_COLD_COLOR } from '@/lib/nodeColors'

const DAY = 86_400_000
const now = Date.UTC(2026, 8, 13, 12)

function doc(over: Partial<LoadedDocument> & { filename: string; folderPath?: string; body?: string }): LoadedDocument {
  const { body = '', ...rest } = over
  const links = [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1])
  return {
    id: `${(over.folderPath ?? '').replace(/\//g, '_')}_${over.filename.replace(/\.md$/, '')}`.replace(/\s+/g, '_').replace(/^_/, '').toLowerCase(),
    folderPath: '', absolutePath: '', speaker: 'unknown', date: '', tags: [], links: [], mtime: now - 30 * DAY,
    sections: [{ id: 's', heading: '', body, wikiLinks: links }], rawContent: body, ...rest,
  }
}

const stamina = doc({ filename: 'Stamina.md', folderPath: 'design', body: '# Stamina\n\nregen 5/s. See [[Combat Loop]] and [[Dodge|the dodge]].', tags: ['combat'], mtime: now - 1 * DAY })
const combat = doc({ filename: 'Combat Loop.md', folderPath: 'design', body: '# Combat\n\ncosts [[Stamina]]', tags: ['combat'] })
const dodge = doc({ filename: 'Dodge.md', folderPath: 'design', body: '# Dodge\n\n[[Combat Loop]]', tags: ['combat'] })
const menu = doc({ filename: 'Menu.md', folderPath: 'ui', body: '# Menu', mtime: undefined })
const proposal = doc({ filename: '2026-09-13-idea.md', folderPath: '_agent', body: '# idea\n\nHalve [[Stamina]] regen', mtime: now - 2 * DAY })
const remark = doc({ filename: 'Stamina.md', folderPath: '_members/Librarian/design', mtime: now - 0.5 * DAY,
  body: '---\nmember: librarian\n---\n# Librarian on [[Stamina]]\n\nSaved by kim · 2026-09-13 10:00 UTC · memory: [[Librarian (memory)]]\n\n### Collides with\n- [[Dodge]] says 20 per dodge\n### One question\n- Does regen pause?' })
const memory = doc({ filename: 'Librarian (memory).md', folderPath: '_members', body: '# memory' })
const docs = [stamina, combat, dodge, menu, proposal, remark, memory]

describe('brain', () => {
  it('normalises link targets like Obsidian', () => {
    expect(normalizeLinkTarget('design/Combat Loop|alias#Heading^blk')).toBe('combat loop')
    expect(normalizeLinkTarget('Dodge.md')).toBe('dodge')
  })

  it('resolves links both ways, preferring the same folder for duplicate basenames', () => {
    const idx = buildLinkIndex(docs)
    expect(idx.out.get(stamina.id)).toEqual(new Set([combat.id, dodge.id]))
    expect(idx.in.get(stamina.id)).toEqual(new Set([combat.id, proposal.id, remark.id]))
    // `Stamina` exists twice (design/, _members/…/design/): the remark's own link resolves to the design one
    expect(idx.out.get(remark.id)!.has(stamina.id)).toBe(true)
    expect(buildLinkIndex(docs)).toBe(idx)   // memoised on the array identity
  })

  it('around(): remarks, links, proposals and neighbourhood, system folders kept out of the link lists', () => {
    const a = around(docs, stamina)
    expect(a.remarks.map(r => r.member)).toEqual(['Librarian'])
    expect(a.remarks[0].body).toBe('### Collides with\n- [[Dodge]] says 20 per dodge\n### One question\n- Does regen pause?')
    expect(a.linkedFrom.map(d => d.filename)).toEqual(['Combat Loop.md'])      // not the proposal, not the remark
    expect(a.linksTo.map(d => d.filename)).toEqual(['Combat Loop.md', 'Dodge.md'])
    expect(a.proposals.map(d => d.filename)).toEqual(['2026-09-13-idea.md'])
    expect(a.similar.map(s => s.doc.filename).sort()).toEqual(['Combat Loop.md', 'Dodge.md'])   // share links + #combat
    expect(a.similar.some(s => s.doc.filename === 'Menu.md')).toBe(false)
    expect(remarkBody('---\na: 1\n---\n# Title\n\nSaved by x · memory: [[m]]\n\nbody')).toBe('body')
  })

  it('activityHeat decays by age and warms documents through remarks and proposals', () => {
    const heat = activityHeat(docs, now)
    expect(heat.get(stamina.id)).toBe(1)                          // own edit + remark + proposal → hottest
    expect(heat.get(combat.id)!).toBeLessThan(0.1)                // a month old
    expect(heat.get(remark.id)).toBeUndefined()                   // remarks warm their target, not themselves
    expect(heat.get(proposal.id)!).toBeGreaterThan(0.3)
    expect(heatColor(0)).toBe('#3a3f4a')
    expect(heatColor(1)).toBe('#ef4444')
    expect(heatColor(0.25)).toBe('#f59e0b')                        // sqrt(0.25) = 0.5 → the amber stop
    const nodes = [{ id: stamina.id, docId: stamina.id, speaker: 'unknown' as const, label: 'S' }, { id: menu.id, docId: menu.id, speaker: 'unknown' as const, label: 'M' }]
    const map = buildNodeColorMap(nodes, 'heat', undefined, undefined, heat)
    expect(getNodeColor(nodes[0], 'heat', map)).toBe('#ef4444')
    expect(getNodeColor(nodes[1], 'heat', map)).toBe(HEAT_COLD_COLOR)
  })
})

const client = {
  history: vi.fn(async () => ({ path: 'design/Stamina.md', current: { etag: 'c', at: now, author: 'kim', size: 10 }, versions: [{ etag: 'a'.repeat(64), at: now - DAY, author: 'ann', size: 9 }] })),
  historyDiff: vi.fn(async () => ({ path: 'design/Stamina.md', from: { etag: 'a'.repeat(64), at: now - DAY, author: 'ann' }, text: '- regen 4/s\n+ regen 5/s', stats: { added: 1, removed: 1, unchanged: 2 } })),
}
vi.mock('@/web/remoteVault', () => ({ currentRemoteVault: () => ({ client }) }))
const openInEditor = vi.fn()
vi.mock('@/stores/uiStore', () => ({ useUIStore: (sel: (s: unknown) => unknown) => sel({ openInEditor }) }))
vi.mock('@/stores/vaultStore', () => ({ useVaultStore: (sel: (s: unknown) => unknown) => sel({ loadedDocuments: docs }) }))

describe('BrainPanel', () => {
  it('shows remarks, links, proposals, neighbourhood, and loads history diffs on demand', async () => {
    const { default: BrainPanel } = await import('@/components/editor/BrainPanel')
    render(<BrainPanel doc={stamina} />)
    expect(screen.getByTestId('brain-remark-' + remark.id).textContent).toContain('Does regen pause?')
    expect(screen.getByTestId('brain-remark-' + remark.id).textContent).toContain('Dodge says 20 per dodge')   // wikilink brackets dropped
    expect(screen.getByTestId('brain-linked-from').textContent).toContain('Combat Loop')
    expect(screen.getByTestId('brain-proposals').textContent).toContain('2026-09-13-idea')
    expect(screen.getByTestId('brain-similar').textContent).toContain('Dodge')
    fireEvent.click(screen.getAllByText('Combat Loop')[0])
    expect(openInEditor).toHaveBeenCalledWith(combat.id)

    await waitFor(() => expect(client.history).toHaveBeenCalledWith('design/Stamina.md'))
    fireEvent.click(screen.getByText('History'))
    const version = await screen.findByTestId('brain-version-aaaaaaaa')
    expect(version.textContent).toContain('ann')
    fireEvent.click(version)
    await waitFor(() => expect(client.historyDiff).toHaveBeenCalledWith('design/Stamina.md', 'a'.repeat(64)))
    expect(await screen.findByText('+ regen 5/s')).toBeInTheDocument()
    expect(screen.getByText(/vs now: \+1 −1/)).toBeInTheDocument()
  })
})
