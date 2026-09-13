/**
 * My desk panel — renders the /v1/me/overview payload and opens documents by their virtual path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import type { MeOverview } from '@/web/remoteClient'

const overview: MeOverview = {
  identity: { sub: 'google|kim', author: 'Kim', service: false },
  guiUrl: 'https://x.y/?view=me',
  counts: { authored: 1, personal: 1, remarks: 1, proposalsCitingMine: 1, proposalsOpen: 2, inboxOpen: 1, inboxWaiting: 1 },
  inbox: {
    forMe: [{ path: '_inbox/Kim/2026-09-13 app-impact.md', kind: 'question', status: 'open', title: 'App impact?', to: 'Kim', toSub: '', from: 'Lee', fromSub: 'google|lee', created: new Date().toISOString(), about: [], body: 'Does X touch the app?', replies: [] }],
    sent: [{ path: '_inbox/Lee/2026-09-13 check.md', kind: 'task', status: 'done', title: 'Check the dock', to: 'Lee', toSub: '', from: 'Kim', fromSub: 'google|kim', created: new Date().toISOString(), about: [], body: 'please', replies: [{ author: 'Lee', at: new Date().toISOString(), text: 'Checked, fine.' }] }],
  },
  authored: [{ path: 'design/Menu.md', title: 'Menu', author: 'Kim', at: new Date(Date.now() - 5 * 60_000).toISOString() }],
  personal: [{ path: '_personal/google-kim/ideas/Secret.md', title: 'Secret', author: 'Kim', at: new Date().toISOString(), personal: true }],
  remarks: [{ member: 'Librarian', path: 'design/Menu.md', title: 'Menu', at: new Date().toISOString() }],
  proposalsCitingMine: [{ path: '_agent/Rename menu.md', title: 'Rename menu', author: 'agent', at: new Date().toISOString(), cites: ['Menu'] }],
  recentByOthers: [{ path: 'design/Loot.md', title: 'Loot', author: 'Lee', at: new Date(Date.now() - 3 * 3600_000).toISOString() }],
}
const meOverview = vi.fn(async () => overview)
const inboxReply = vi.fn(async (path: string, _reply: string, status: string) => ({ path, status }))
const inboxSend = vi.fn(async () => ({ path: '_inbox/Lee/x.md' }))
const virtualOf = (p: string) => ({ path: p.replace(/^_personal\/[^/]+\//, ''), personal: p.startsWith('_personal/') })
let client: { meOverview: typeof meOverview; inboxReply: typeof inboxReply; inboxSend: typeof inboxSend } | undefined = { meOverview, inboxReply, inboxSend }

vi.mock('@/web/remoteVault', () => ({ currentRemoteVault: () => (client ? { client, virtualOf } : null) }))

const uiState = { openInEditor: vi.fn(), brainPanelOpen: false }
vi.mock('@/stores/uiStore', () => ({ useUIStore: Object.assign((sel: (s: unknown) => unknown) => sel(uiState), { setState: (patch: Partial<typeof uiState>) => Object.assign(uiState, patch) }) }))
const docs = [
  { id: 'design_menu', filename: 'Menu.md', folderPath: 'design' },
  { id: 'ideas_secret', filename: 'Secret.md', folderPath: 'ideas' },
  { id: '_agent_rename_menu', filename: 'Rename menu.md', folderPath: '_agent' },
]
vi.mock('@/stores/vaultStore', () => ({ useVaultStore: (sel: (s: unknown) => unknown) => sel({ loadedDocuments: docs }) }))

vi.mock('@/stores/toastStore', () => ({ showToast: vi.fn() }))
beforeEach(() => { uiState.openInEditor.mockClear(); meOverview.mockClear(); inboxReply.mockClear(); inboxSend.mockClear(); uiState.brainPanelOpen = false; client = { meOverview, inboxReply, inboxSend } })

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

  it('shows the inbox, answers a question, and sends a new one', async () => {
    const { default: MyDeskPanel } = await import('@/components/me/MyDeskPanel')
    render(<MyDeskPanel />)
    await waitFor(() => expect(screen.getByText('App impact?')).toBeTruthy())
    expect(screen.getByText('Check the dock')).toBeTruthy()
    expect(screen.getByText('Checked, fine.')).toBeTruthy()

    fireEvent.click(screen.getByTestId('inbox-reply-open'))
    fireEvent.change(screen.getByTestId('inbox-reply-text'), { target: { value: 'Three files.' } })
    fireEvent.click(screen.getByTestId('inbox-reply-send'))
    await waitFor(() => expect(inboxReply).toHaveBeenCalledWith('_inbox/Kim/2026-09-13 app-impact.md', 'Three files.', 'answered'))
    await waitFor(() => expect(meOverview).toHaveBeenCalledTimes(2))   // desk reloads after the reply

    fireEvent.click(screen.getByTestId('inbox-compose'))
    fireEvent.change(screen.getByTestId('inbox-to'), { target: { value: 'Lee' } })
    fireEvent.change(screen.getByTestId('inbox-title'), { target: { value: 'Dock height' } })
    fireEvent.change(screen.getByTestId('inbox-body'), { target: { value: 'Can the dock be 2 cm lower?' } })
    fireEvent.click(screen.getByTestId('inbox-send'))
    await waitFor(() => expect(inboxSend).toHaveBeenCalledWith({ to: 'Lee', kind: 'question', title: 'Dock height', body: 'Can the dock be 2 cm lower?' }))
  })
})
