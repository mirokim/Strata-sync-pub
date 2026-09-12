import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProposal as buildShared, slugForTitle as slugShared } from '../../mcp/src/proposals.js'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cjs = require('../proposals.cjs') as typeof import('../proposals.cjs')

const NOW = Date.parse('2026-09-13T05:00:00Z')

describe('electron/proposals.cjs mirrors mcp/src/proposals.ts', () => {
  const cases = [
    { title: 'Combat notes', body: 'Enemies telegraph.', tags: ['combat'], links: ['Combat System', 'Combat System', 'Enemy AI Spec'], source: 'slack', now: NOW },
    { title: '  전투 시스템: 스킬/콤보?  ', body: 'x', now: NOW },
    { title: '', body: 'no title', tags: [], links: [], now: NOW },
    { title: 'x'.repeat(100), body: 'long', now: NOW },
  ]
  it('produces byte-identical proposals for the same input', () => {
    for (const c of cases) {
      expect(cjs.buildProposal(c)).toEqual(buildShared(c))
      expect(cjs.slugForTitle(c.title)).toBe(slugShared(c.title))
    }
  })

  it('writeProposal never overwrites and stays inside the vault', () => {
    const vault = mkdtempSync(join(tmpdir(), 'prop-'))
    try {
      const a = cjs.writeProposal(vault, { title: 'Same', body: 'one', now: NOW })
      const b = cjs.writeProposal(vault, { title: 'Same', body: 'two', now: NOW })
      expect(a.relPath).toBe('_agent/2026-09-13-same.md')
      expect(b.relPath).toBe('_agent/2026-09-13-same-2.md')
      expect(readFileSync(join(vault, a.relPath), 'utf-8')).toContain('one')
      expect(existsSync(join(vault, '_agent'))).toBe(true)
      expect(() => cjs.writeProposal(vault, { title: '../../escape', body: 'x', now: NOW })).not.toThrow()  // slug strips separators
    } finally { rmSync(vault, { recursive: true, force: true }) }
  })
})
