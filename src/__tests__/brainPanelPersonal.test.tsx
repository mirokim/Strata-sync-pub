/**
 * BrainPanel's History section asks the server about the *physical* path of a document: a
 * personal document lives under `_personal/<owner>/` on the server while the app shows it in
 * its ordinary folder. Without the translation the panel would query a path that 404s.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { LoadedDocument } from '@/types'

const now = Date.UTC(2026, 8, 13, 12)
const ROOT = '_personal/1001/'

function doc(over: Partial<LoadedDocument> & { filename: string; folderPath?: string; body?: string }): LoadedDocument {
  const { body = '', ...rest } = over
  return {
    id: `${(over.folderPath ?? '')}/${over.filename}`.toLowerCase(),
    folderPath: '', absolutePath: '', speaker: 'unknown', date: '', tags: [], links: [], mtime: now,
    sections: [{ id: 's', heading: '', body, wikiLinks: [] }], rawContent: body, ...rest,
  }
}

const draft = doc({ filename: 'Draft.md', folderPath: 'design', body: '# Draft', personal: true })
const team = doc({ filename: 'Stamina.md', folderPath: 'design', body: '# Stamina' })
const docs = [draft, team]

const client = {
  history: vi.fn(async (path: string) => ({ path, current: { etag: 'c', at: now, author: 'kim', size: 10 }, versions: [] })),
  historyDiff: vi.fn(async () => { throw new Error('not used') }),
}
// The signed-in user's mapper: the draft has a personal copy on the server, the team document has none
const personalCopies = new Set([`${ROOT}design/Draft.md`])
const physicalOf = vi.fn((virtual: string) => personalCopies.has(ROOT + virtual) ? ROOT + virtual : virtual)
vi.mock('@/web/remoteVault', () => ({ currentRemoteVault: () => ({ client, physicalOf }) }))
vi.mock('@/stores/uiStore', () => ({ useUIStore: (sel: (s: unknown) => unknown) => sel({ openInEditor: vi.fn() }) }))
vi.mock('@/stores/vaultStore', () => ({ useVaultStore: (sel: (s: unknown) => unknown) => sel({ loadedDocuments: docs }) }))

describe('BrainPanel history for personal documents', () => {
  it('queries the server with the owner-prefixed path for a personal document and the plain path for a team one', async () => {
    const { default: BrainPanel } = await import('@/components/editor/BrainPanel')
    const { rerender } = render(<BrainPanel doc={draft} />)
    await waitFor(() => expect(client.history).toHaveBeenCalledWith(`${ROOT}design/Draft.md`))
    expect(physicalOf).toHaveBeenCalledWith('design/Draft.md')
    fireEvent.click(screen.getByText('History'))
    expect(await screen.findByText(/Only one version so far/)).toBeInTheDocument()
    expect(client.history).not.toHaveBeenCalledWith('design/Draft.md')

    rerender(<BrainPanel doc={team} />)
    await waitFor(() => expect(client.history).toHaveBeenCalledWith('design/Stamina.md'))
    expect(client.history.mock.calls.map(c => c[0])).toEqual([`${ROOT}design/Draft.md`, 'design/Stamina.md'])
  })

  it('shows the server\'s error instead of an empty history when the request fails', async () => {
    client.history.mockRejectedValueOnce(new Error('history failed (404)'))
    const { default: BrainPanel } = await import('@/components/editor/BrainPanel')
    render(<BrainPanel doc={team} />)
    fireEvent.click(screen.getByText('History'))
    expect(await screen.findByText('history failed (404)')).toBeInTheDocument()
    expect(screen.queryByText(/Only one version so far/)).toBeNull()
  })
})
