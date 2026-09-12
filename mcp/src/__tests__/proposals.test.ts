import { describe, it, expect } from 'vitest'
import { buildProposal, slugForTitle, isProposalPath, stripProposalFrontmatter, promotedPath } from '../proposals.js'

const NOW = Date.parse('2026-09-13T05:00:00Z')

describe('proposals', () => {
  it('slugs keep Korean and drop path-hostile characters', () => {
    expect(slugForTitle('전투 시스템: 스킬/콤보?')).toBe('전투-시스템-스킬-콤보')
    expect(slugForTitle('   ')).toBe('note')
    expect(slugForTitle('x'.repeat(100)).length).toBe(60)
  })

  it('builds a dated file in _agent/ with proposal frontmatter and a Related section', () => {
    const p = buildProposal({ title: 'Combat notes', body: 'Enemies should telegraph.', tags: ['combat'], links: ['Combat System', 'Combat System', 'Enemy AI Spec'], source: 'claude-code', now: NOW })
    expect(p.relPath).toBe('_agent/2026-09-13-combat-notes.md')
    expect(p.content).toContain('proposed_by: agent')
    expect(p.content).toContain('proposed_source: "claude-code"')
    expect(p.content).toContain('tags: ["proposal", "combat"]')
    expect(p.content).toContain('# Combat notes')
    expect(p.content.match(/\[\[Combat System\]\]/g)?.length).toBe(1)
    expect(p.content).toContain('- [[Enemy AI Spec]]')
    expect(isProposalPath(p.relPath)).toBe(true)
    expect(isProposalPath('active/x.md')).toBe(false)
  })

  it('promotion strips only the proposal bookkeeping and the proposal tag', () => {
    const p = buildProposal({ title: 'T', body: 'B', tags: ['a', 'b'], now: NOW })
    const promoted = stripProposalFrontmatter(p.content)
    expect(promoted).not.toContain('proposed_by')
    expect(promoted).not.toContain('proposed_at')
    expect(promoted).not.toContain('status: proposed')
    expect(promoted).toContain('title: "T"')
    expect(promoted).toContain('tags: ["a", "b"]')
    expect(promoted).toContain('# T')
    expect(stripProposalFrontmatter('no frontmatter')).toBe('no frontmatter')
    expect(stripProposalFrontmatter('---\ntags: proposal, x\n---\nbody')).toBe('---\ntags: x\n---\nbody')
  })

  it('promoted path drops the date prefix and lands in the chosen folder', () => {
    expect(promotedPath('_agent/2026-09-13-combat-notes.md', '')).toBe('combat-notes.md')
    expect(promotedPath('_agent/2026-09-13-combat-notes.md', '/active/')).toBe('active/combat-notes.md')
  })
})
