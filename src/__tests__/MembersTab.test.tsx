import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import MembersTab from '@/components/settings/tabs/MembersTab'
import type { MembersConfig, MembersResponse } from '@/web/remoteClient'

const librarian = {
  id: 'librarian', name: 'Librarian', enabled: true, reactsOnSave: true, role: 'Keeps the shared memory coherent.',
  scope: { folders: [] as string[], tags: [] as string[] },
  routines: [{ id: 'learned', title: 'What did we learn this week?', instructions: 'Read vault_changes.', cadence: 'weekly' as const, enabled: true, runs: [{ at: Date.UTC(2026, 8, 12, 4, 0), by: 'kim', summary: 'Wrote the digest.', proposals: ['_agent/x.md'] }] }],
}
const response: MembersResponse = {
  config: { version: 1, members: [librarian] },
  templates: { designer: { name: 'Designer', enabled: true, reactsOnSave: true, role: 'Holds the user\'s eye.', scope: { folders: [], tags: ['ui'] }, routines: [{ id: 'missing-screens', title: 'Which documents have no screen?', instructions: 'Search.', cadence: 'weekly', enabled: true, runs: [] }] } },
  reactionsEnabled: false,
}

const people = [
  { sub: 'g-kim', email: 'kim@onda.kr', name: '김철수', picture: '', firstSeen: 1, lastSeen: Date.UTC(2026, 8, 24, 3), docs: 12 },
  { sub: 'g-lee', email: 'lee@onda.kr', name: '이소영', picture: '', firstSeen: 1, lastSeen: Date.UTC(2026, 8, 20, 3), docs: 1 },
]
const client = {
  members: vi.fn(async () => response),
  saveMembers: vi.fn(async (c: MembersConfig) => ({ config: c })),
  people: vi.fn(async () => people),
  me: vi.fn(async () => ({ sub: 'g-kim', service: false })),
}
vi.mock('@/web/remoteVault', () => ({ currentRemoteVault: () => ({ client }) }))

beforeEach(() => { client.members.mockClear(); client.saveMembers.mockClear() })

describe('MembersTab', () => {
  it('lists members with their routines and last run, and explains how to take one on', async () => {
    render(<MembersTab />)
    await screen.findByTestId('member-librarian')
    expect(screen.getByText(/1 AI member, 1 scheduled routine/)).toBeInTheDocument()
    expect(screen.getByText('/mcp__strata__member name=Librarian')).toBeInTheDocument()
    expect(screen.getByTestId('reactions-status').textContent).toMatch(/off/)
    fireEvent.click(screen.getByTestId('member-toggle-librarian'))
    expect(screen.getByTestId('routine-last-librarian-learned').textContent).toMatch(/by kim — Wrote the digest\. · 1 proposal/)
    expect(screen.getByText(/_members\/Librarian \(memory\)\.md/)).toBeInTheDocument()
  })

  it('adds a member from a template, edits it and saves the whole configuration', async () => {
    render(<MembersTab />)
    await screen.findByTestId('member-librarian')
    fireEvent.change(screen.getByTestId('members-add'), { target: { value: 'designer' } })
    const card = await screen.findByTestId('member-designer')
    expect(card).toBeInTheDocument()
    expect(screen.getByTestId('routine-designer-missing-screens')).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('design, ui'), { target: { value: 'design, screens' } })
    fireEvent.click(screen.getByTestId('members-save'))
    await waitFor(() => expect(client.saveMembers).toHaveBeenCalledTimes(1))
    const saved = client.saveMembers.mock.calls[0][0] as MembersConfig
    expect(saved.members.map(m => m.id)).toEqual(['librarian', 'designer'])
    expect(saved.members[1].scope).toEqual({ folders: ['design', 'screens'], tags: ['ui'] })
    expect(saved.members[1].routines[0].runs).toEqual([])
    expect(await screen.findByText(/Saved/)).toBeInTheDocument()
  })

  it('refuses to save a member without a role', async () => {
    render(<MembersTab />)
    await screen.findByTestId('member-librarian')
    fireEvent.change(screen.getByTestId('members-add'), { target: { value: 'blank' } })
    await screen.findByTestId('member-new-member')
    fireEvent.click(screen.getByTestId('members-save'))
    expect(await screen.findByText(/describe the role/)).toBeInTheDocument()
    expect(client.saveMembers).not.toHaveBeenCalled()
  })

  it('shows the people who signed in above the AI members, marking the viewer', async () => {
    render(<MembersTab />)
    const kim = await screen.findByTestId('person-g-kim')
    expect(kim.textContent).toMatch(/김철수/)
    expect(kim.textContent).toMatch(/You/)
    expect(kim.textContent).toMatch(/12 documents/)
    expect(screen.getByTestId('person-g-lee').textContent).toMatch(/1 document(?!s)/)
    expect(screen.getByTestId('person-g-lee').textContent).not.toMatch(/You/)
    expect(screen.getByText('People · 2')).toBeInTheDocument()
  })
})
