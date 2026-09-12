import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import TeamSyncTab from '@/components/settings/tabs/TeamSyncTab'

type State = TeamSyncState

const idle: State = {
  config: { enabled: false, url: '', token: '', author: '', pullIntervalMs: 30000, hasToken: false },
  status: { enabled: false, inFlight: false, lastSyncAt: null, lastSeq: 0, pending: 0, conflicts: [], errors: [], lastError: null },
  vaultPath: 'C:/vault',
}

function mockApi(initial: State) {
  let state = initial
  const listeners: ((s: State) => void)[] = []
  const api = {
    getState: vi.fn(async () => state),
    updateConfig: vi.fn(async (patch: Record<string, unknown>) => {
      state = {
        ...state,
        config: { ...state.config, ...patch, token: patch.token ? '••••' + String(patch.token).slice(-4) : state.config.token, hasToken: Boolean(patch.token) || state.config.hasToken },
        status: { ...state.status, enabled: Boolean(patch.enabled ?? state.config.enabled) },
      }
      return state
    }),
    syncNow: vi.fn(async () => state),
    testConnection: vi.fn(async () => ({ ok: true, head: 7, files: 3 })),
    onStatus: vi.fn((cb: (s: State) => void) => { listeners.push(cb); return () => {} }),
    push: (s: State) => { state = s; listeners.forEach(l => l(s)) },
  }
  return api
}

let api: ReturnType<typeof mockApi>

beforeEach(() => { api = mockApi(idle); (window as unknown as { syncAPI: unknown }).syncAPI = api })
afterEach(() => { delete (window as unknown as { syncAPI?: unknown }).syncAPI })

describe('TeamSyncTab', () => {
  it('explains itself outside Electron', () => {
    delete (window as unknown as { syncAPI?: unknown }).syncAPI
    render(<TeamSyncTab />)
    expect(screen.getByText(/desktop app only/)).toBeInTheDocument()
  })

  it('cannot be turned on without a URL and token; test connection reports the server', async () => {
    render(<TeamSyncTab />)
    await waitFor(() => expect(api.getState).toHaveBeenCalled())
    expect(screen.getByTestId('sync-status-title')).toHaveTextContent('Team sync off')
    expect(screen.getByTestId('sync-toggle')).toBeDisabled()

    fireEvent.change(screen.getByTestId('sync-url'), { target: { value: 'https://sync.example' } })
    fireEvent.change(screen.getByTestId('sync-token'), { target: { value: 'abcdef' } })
    expect(screen.getByTestId('sync-toggle')).not.toBeDisabled()

    fireEvent.click(screen.getByTestId('sync-test'))
    await waitFor(() => expect(screen.getByTestId('sync-test-result')).toHaveTextContent('3 files on the server (seq 7)'))
    expect(api.testConnection).toHaveBeenCalledWith('https://sync.example', 'abcdef')
  })

  it('turning on sends url/token/author and shows the live status pushed from main', async () => {
    render(<TeamSyncTab />)
    await waitFor(() => expect(api.getState).toHaveBeenCalled())
    fireEvent.change(screen.getByTestId('sync-url'), { target: { value: 'https://sync.example' } })
    fireEvent.change(screen.getByTestId('sync-token'), { target: { value: 'abcdef' } })
    fireEvent.change(screen.getByTestId('sync-author'), { target: { value: 'miro' } })
    fireEvent.click(screen.getByTestId('sync-toggle'))
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://sync.example', token: 'abcdef', author: 'miro', enabled: true })))
    await waitFor(() => expect(screen.getByTestId('sync-status-title')).toHaveTextContent('In sync'))

    api.push({
      ...idle,
      config: { ...idle.config, enabled: true, hasToken: true, token: '••••cdef' },
      status: { ...idle.status, enabled: true, lastError: 'manifest 503', pending: 2, conflicts: [{ path: 'Doc.md', keptAs: 'Doc (conflict miro 2026-09-12 1200).md', at: 1, remoteAuthor: 'dana' }], errors: [] },
    })
    await waitFor(() => expect(screen.getByTestId('sync-status-title')).toHaveTextContent('Sync error'))
    expect(screen.getByText('manifest 503')).toBeInTheDocument()
    expect(screen.getByText('Doc.md')).toBeInTheDocument()
    expect(screen.getByText(/dana's version kept the name/)).toBeInTheDocument()
  })

  it('does not send a masked token back as if it were new', async () => {
    api = mockApi({ ...idle, config: { ...idle.config, enabled: true, url: 'https://s', token: '••••cdef', hasToken: true } })
    ;(window as unknown as { syncAPI: unknown }).syncAPI = api
    render(<TeamSyncTab />)
    await waitFor(() => expect(screen.getByTestId('sync-status-title')).not.toHaveTextContent('Team sync off'))
    fireEvent.click(screen.getByText('Save changes'))
    await waitFor(() => expect(api.updateConfig).toHaveBeenCalled())
    expect(api.updateConfig.mock.calls[0][0]).not.toHaveProperty('token')
  })
})
