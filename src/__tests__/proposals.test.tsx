import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ProposalBanner from '@/components/editor/ProposalBanner'
import { promoteProposal, discardProposal, isProposal, vaultRelativePath, proposalSource } from '@/lib/proposals'
import type { LoadedDocument } from '@/types'

const VAULT = 'C:\\vault'
const proposalContent = '---\ntitle: "Combat notes"\nproposed_by: agent\nproposed_at: 2026-09-13T05:00:00.000Z\nproposed_source: "claude-code"\nstatus: proposed\ntags: ["proposal", "combat"]\n---\n\n# Combat notes\n\nbody\n'

const doc: LoadedDocument = {
  id: '_agent_2026-09-13-combat-notes', filename: '2026-09-13-combat-notes.md', folderPath: '_agent',
  absolutePath: 'C:\\vault\\_agent\\2026-09-13-combat-notes.md', speaker: 'unknown', date: '', tags: ['proposal', 'combat'], links: [],
  rawContent: proposalContent, sections: [], mtime: 1,
}
const normalDoc: LoadedDocument = { ...doc, id: 'combat', folderPath: 'active', absolutePath: 'C:\\vault\\active\\combat.md', rawContent: '# c' }

let files: Map<string, string>
let api: { readFile: ReturnType<typeof vi.fn>; saveFile: ReturnType<typeof vi.fn>; deleteFile: ReturnType<typeof vi.fn> }

beforeEach(() => {
  files = new Map([[doc.absolutePath, proposalContent]])
  api = {
    readFile: vi.fn(async (p: string) => files.get(p) ?? null),
    saveFile: vi.fn(async (p: string, c: string) => { files.set(p, c); return { success: true, path: p } }),
    deleteFile: vi.fn(async (p: string) => { files.delete(p); return { success: true } }),
  }
  ;(window as unknown as { vaultAPI: unknown }).vaultAPI = api
})
afterEach(() => { delete (window as unknown as { vaultAPI?: unknown }).vaultAPI })

describe('proposal helpers', () => {
  it('recognises proposals by folder and reads the source', () => {
    expect(isProposal(doc)).toBe(true)
    expect(isProposal(normalDoc)).toBe(false)
    expect(proposalSource(doc)).toBe('claude-code')
    expect(vaultRelativePath(doc, VAULT)).toBe('_agent/2026-09-13-combat-notes.md')
  })

  it('promote writes the stripped file to the destination and removes the proposal', async () => {
    const r = await promoteProposal(doc, VAULT, 'active')
    expect(r.newRelativePath).toBe('active/combat-notes.md')
    expect(r.newAbsolutePath).toBe('C:\\vault\\active\\combat-notes.md')
    const written = files.get(r.newAbsolutePath)!
    expect(written).not.toContain('proposed_by')
    expect(written).toContain('tags: ["combat"]')
    expect(written).toContain('# Combat notes')
    expect(files.has(doc.absolutePath)).toBe(false)
  })

  it('promote refuses to overwrite and discard deletes', async () => {
    files.set('C:\\vault\\combat-notes.md', 'existing')
    await expect(promoteProposal(doc, VAULT, '')).rejects.toThrow(/already exists/)
    expect(files.has(doc.absolutePath)).toBe(true)
    await discardProposal(doc)
    expect(files.has(doc.absolutePath)).toBe(false)
    await expect(discardProposal(normalDoc)).rejects.toThrow(/not a proposal/)
  })
})

describe('ProposalBanner', () => {
  it('renders nothing for ordinary documents', () => {
    const { container } = render(<ProposalBanner doc={normalDoc} vaultPath={VAULT} folders={[]} onDone={() => {}} onError={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('promotes into the selected folder and reports back', async () => {
    const onDone = vi.fn(), onError = vi.fn()
    render(<ProposalBanner doc={doc} vaultPath={VAULT} folders={['active', '_agent', '.obsidian', 'jira']} onDone={onDone} onError={onError} />)
    expect(screen.getByTestId('proposal-banner')).toHaveTextContent('Proposed by claude-code')
    const select = screen.getByTestId('proposal-dest') as HTMLSelectElement
    expect([...select.options].map(o => o.value)).toEqual(['', 'active', 'jira'])   // no _ or . folders
    fireEvent.change(select, { target: { value: 'active' } })
    fireEvent.click(screen.getByTestId('proposal-promote'))
    await waitFor(() => expect(onDone).toHaveBeenCalledWith({ kind: 'promoted', newAbsolutePath: 'C:\\vault\\active\\combat-notes.md' }))
    expect(onError).not.toHaveBeenCalled()
  })

  it('discard asks first and reports the error path', async () => {
    const onDone = vi.fn(), onError = vi.fn()
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<ProposalBanner doc={doc} vaultPath={VAULT} folders={[]} onDone={onDone} onError={onError} />)
    fireEvent.click(screen.getByTestId('proposal-discard'))
    expect(api.deleteFile).not.toHaveBeenCalled()

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    api.deleteFile.mockRejectedValueOnce(new Error('EPERM'))
    fireEvent.click(screen.getByTestId('proposal-discard'))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('EPERM'))
    expect(onDone).not.toHaveBeenCalled()
  })
})
