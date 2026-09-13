/**
 * My desk panel — renders the /v1/me/overview payload and opens documents by their virtual path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { MeOverview } from '@/web/remoteClient'

const overview: MeOverview = {
  identity: { sub: 'google|kim', author: 'Kim', service: false },
  guiUrl: 'https://x.y/?view=me',
  counts: { authored: 1, personal: 1, remarks: 1, proposalsCitingMine: 1, proposalsOpen: 2 },
  authored: [{ path: 'design/Menu.md', title: 'Menu', author: 'Kim', at: new Date(Date.now() - 5 * 60_000).toISOString() }],
  personal: [{ path: '_personal/google-kim/ideas/Secret.md', title: 'Secret', author: 'Kim', at: new Date().toISOString(), personal: true }],
  remarks: [{ member: 'Librarian', path: 'design/Menu.md', title: 'Menu', at: new Date().toISOString() }],
  proposalsCitingMine: [{ path: '_agent/Rename menu.md', title: 'Rename menu', author: 'agent', at: new Date().toISOString(), cites: ['Menu'] }],
  recentByOthers: [{ path: 'design/Loot.md', title: 'Loot', author: 'Lee', at: new Date(Date.now() - 3 * 3600_000).toISOString() }],
}
const meOverview = vi.fn(async () => overview)
const virtualOf = (p: string) => ({ path: p.replace(/^_personal\/[^/]+\//, ''), personal: p.startsWith('_personal/') })
let client: { meOverview: typeof meOverview } | undefined = { meOverview }

vi.mock('@/web/remoteVault', () => ({ currentRemoteVault: () => (client ? { client, virtualOf } : null) }))

const uiState = { openInEditor: vi.fn(), brainPanelOpen: false }
vi.mock('@/stores/uiStore', () => ({ useUIStore: Object.assign((sel: (s: unknown) => unknown) => sel(uiState), { setState: (patch: Partial<typeof uiState>) => Object.assign(uiState, patch) }) }))
const docs = [
  { id: 'design_menu', filename: 'Menu.md', folderPath: 'design' },
  { id: 'ideas_secret', filename: 'Secret.md', folderPath: 'ideas' },
  { id: '_agent_rename_menu', filename: 'Rename menu.md', folderPath: '_agent' },
]
vi.mock('@/stores/vaultStore', () => ({ useVaultStore: (sel: (s: unknown) => unknown) => sel({ loadedDocuments: docs }) }))

beforeEach(() => { uiState.openInEditor.mockClear(); uiState.brainPanelOpen = false; client = { meOverview } })

describe('MyDeskPanel', () => {
  it('shows every section from the overview', async () => {
    const { default: MyDeskPanel } = await import('@/components/me/MyDeskPanel')
    render(<MyDeskPanel />)
    await waitFor(() => expect(screen.getByText('Kim')).toBeTruthy())
    expect(screen.getByText('Librarian')).toBeTruthy()
    expect(screen.getByText('Rename menu')).toBeTruthy()
    expect(screen.getByText('Loot')).toBeTruthy()
    expect(screen.getByText('Secret')).toBeTruthy()
    expect(screen.getByText('agent → Menu')).toBeTruthy()
    expect(screen.getByText('5 min ago')).toBeTruthy()
  })

  it('opens a personal document through its virtual path and a remark with the Brain panel', async () => {
    const { default: MyDeskPanel } = await import('@/components/me/MyDeskPanel')
    render(<MyDeskPanel />)
    await waitFor(() => expect(screen.getByText('Secret')).toBeTruthy())
    fireEvent.click(screen.getByText('Secret'))
    expect(uiState.openInEditor).toHaveBeenCalledWith('ideas_secret')
    expect(uiState.brainPanelOpen).toBe(false)
    fireEvent.click(screen.getByText('Librarian'))
    expect(uiState.openInEditor).toHaveBeenLastCalledWith('design_menu')
    expect(uiState.brainPanelOpen).toBe(true)
  })

  it('explains itself without a server connection', async () => {
    client = undefined
    const { default: MyDeskPanel } = await import('@/components/me/MyDeskPanel')
    render(<MyDeskPanel />)
    await waitFor(() => expect(screen.getByText('Connect to a team server to see your desk')).toBeTruthy())
  })
})
