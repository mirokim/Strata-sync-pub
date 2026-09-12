import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SettingsPanel from '@/components/settings/SettingsPanel'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUIStore } from '@/stores/uiStore'
import { useVaultStore } from '@/stores/vaultStore'
import { DEFAULT_PERSONA_MODELS } from '@/lib/modelConfig'

// ── Framer Motion mock ─────────────────────────────────────────────────────────

vi.mock('framer-motion', () => {
  const React = require('react')
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        React.forwardRef(
          (
            { children, ...props }: React.PropsWithChildren<Record<string, unknown>>,
            ref: React.Ref<unknown>
          ) => React.createElement(tag, { ...props, ref }, children)
        ),
    }
  )
  const AnimatePresence = ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children)
  return { motion, AnimatePresence }
})

// ── Helpers ────────────────────────────────────────────────────────────────────

function resetStore(panelOpen = false) {
  useSettingsStore.setState({
    personaModels: { ...DEFAULT_PERSONA_MODELS },
  })
  useUIStore.setState({
    centerTab: panelOpen ? 'settings' : 'graph',
  })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SettingsPanel', () => {
  beforeEach(() => {
    resetStore(false)
    // Reset vault store so VaultSelector renders in clean state
    useVaultStore.setState({
      vaultPath: null,
      loadedDocuments: null,
      isLoading: false,
      error: null,
    })
  })

  // ── Visibility ─────────────────────────────────────────────────────────────

  it('renders when centerTab is settings', () => {
    resetStore(true)
    render(<SettingsPanel />)
    expect(screen.getByTestId('settings-panel')).toBeInTheDocument()
  })

  // ── Persona rows ───────────────────────────────────────────────────────────

  it('renders 5 persona rows', () => {
    resetStore(true)
    render(<SettingsPanel />)
    const rows = screen.getAllByTestId(/^persona-row-/)
    expect(rows).toHaveLength(5)
  })

  it('renders a model select for each persona', () => {
    resetStore(true)
    render(<SettingsPanel />)
    const selects = screen.getAllByTestId(/^model-select-/)
    expect(selects).toHaveLength(5)
  })

  it('shows default model for chief_director', () => {
    resetStore(true)
    render(<SettingsPanel />)
    const select = screen.getByTestId('model-select-chief_director') as HTMLSelectElement
    expect(select.value).toBe(DEFAULT_PERSONA_MODELS.chief_director)
  })

  it('shows default model for art_director', () => {
    resetStore(true)
    render(<SettingsPanel />)
    const select = screen.getByTestId('model-select-art_director') as HTMLSelectElement
    expect(select.value).toBe(DEFAULT_PERSONA_MODELS.art_director)
  })

  // ── Interactions ───────────────────────────────────────────────────────────

  it('changing a model select updates settingsStore', () => {
    resetStore(true)
    render(<SettingsPanel />)
    const select = screen.getByTestId('model-select-chief_director') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'gpt-4o' } })

    const { personaModels } = useSettingsStore.getState()
    expect(personaModels.chief_director).toBe('gpt-4o')
  })

  it('clicking reset button restores defaults', () => {
    useSettingsStore.setState({
      personaModels: { ...DEFAULT_PERSONA_MODELS, chief_director: 'gpt-4o' },
    })
    useUIStore.setState({ centerTab: 'settings' })
    render(<SettingsPanel />)

    fireEvent.click(screen.getByTestId('settings-reset'))

    const { personaModels } = useSettingsStore.getState()
    expect(personaModels.chief_director).toBe(DEFAULT_PERSONA_MODELS.chief_director)
  })

  it('clicking close button sets centerTab away from settings', () => {
    resetStore(true)
    render(<SettingsPanel />)
    fireEvent.click(screen.getByTestId('settings-close'))
    expect(useUIStore.getState().centerTab).not.toBe('settings')
  })

  it('clicking save button closes the panel', () => {
    resetStore(true)
    render(<SettingsPanel />)
    fireEvent.click(screen.getByTestId('settings-save'))
    expect(useUIStore.getState().centerTab).not.toBe('settings')
  })

  // ── Content ────────────────────────────────────────────────────────────────

  it('shows all 5 speaker labels', () => {
    resetStore(true)
    render(<SettingsPanel />)
    // Labels from SPEAKER_CONFIG: STRATA BOT, Art, Design, Level, Tech
    expect(screen.getByText('STRATA BOT')).toBeInTheDocument()
    expect(screen.getByText('Art')).toBeInTheDocument()
    expect(screen.getByText('Design')).toBeInTheDocument()
    expect(screen.getByText('Level')).toBeInTheDocument()
    expect(screen.getByText('Tech')).toBeInTheDocument()
  })

  // ── VaultSelector section (in 'General' tab) ─────────────────────────────

  it('renders the vault section after switching to General tab', () => {
    resetStore(true)
    render(<SettingsPanel />)
    fireEvent.click(screen.getByText('General'))
    expect(screen.getByTestId('vault-section')).toBeInTheDocument()
  })

  it('renders the vault-selector within the General tab', () => {
    resetStore(true)
    render(<SettingsPanel />)
    fireEvent.click(screen.getByText('General'))
    expect(screen.getByTestId('vault-selector')).toBeInTheDocument()
  })

  it('renders vault-select-btn in General tab when running in Electron with no vault', () => {
    // The "add vault" button is only offered inside Electron (window.vaultAPI present) and only
    // while no vault has been registered yet.
    const prev = (window as any).vaultAPI
    const prevElectron = (window as any).electronAPI
    ;(window as any).vaultAPI = {}
    ;(window as any).electronAPI = { isElectron: true, platform: 'test' } // the web build has vaultAPI too, but no folder picker
    try {
      resetStore(true)
      render(<SettingsPanel />)
      fireEvent.click(screen.getByText('General'))
      expect(screen.getByTestId('vault-select-btn')).toBeInTheDocument()
    } finally {
      ;(window as any).vaultAPI = prev
      ;(window as any).electronAPI = prevElectron
    }
  })

  it('web build: hides Electron-only tabs and shows the Server tab', () => {
    // No electronAPI → web mode
    const prevElectron = (window as any).electronAPI
    delete (window as any).electronAPI
    try {
      resetStore(true)
      render(<SettingsPanel />)
      expect(screen.getByText('Server')).toBeInTheDocument()
      for (const hidden of ['Cron Jobs', 'Slack Bot', 'Team Sync', 'Vault Manager', 'MiroFish', 'Edit Agent', 'Jira Import', 'Trash']) {
        expect(screen.queryByText(hidden)).toBeNull()
      }
      expect(screen.getAllByText('AI Settings').length).toBeGreaterThan(0)
    } finally {
      ;(window as any).electronAPI = prevElectron
    }
  })

  it('desktop build: shows Electron tabs and no Server tab', () => {
    const prevElectron = (window as any).electronAPI
    ;(window as any).electronAPI = { isElectron: true, platform: 'test' }
    try {
      resetStore(true)
      render(<SettingsPanel />)
      expect(screen.queryByText('Server')).toBeNull()
      expect(screen.getByText('Team Sync')).toBeInTheDocument()
      expect(screen.getByText('Cron Jobs')).toBeInTheDocument()
    } finally {
      ;(window as any).electronAPI = prevElectron
    }
  })
})
