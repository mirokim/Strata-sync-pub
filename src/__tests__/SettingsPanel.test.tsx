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

function resetStore() {
  useSettingsStore.setState({
    personaModels: { ...DEFAULT_PERSONA_MODELS },
  })
  useUIStore.setState({ centerTab: 'settings' })
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('SettingsPanel', () => {
  beforeEach(() => {
    resetStore()
    // Reset vault store so VaultSelector renders in clean state
    useVaultStore.setState({
      vaultPath: null,
      loadedDocuments: null,
      isLoading: false,
      error: null,
    })
  })

  // ── Visibility ─────────────────────────────────────────────────────────────

  it('always renders settings-panel when mounted', () => {
    render(<SettingsPanel />)
    expect(screen.getByTestId('settings-panel')).toBeInTheDocument()
  })

  // ── Persona rows ───────────────────────────────────────────────────────────

  it('renders 1 persona row (PM only)', () => {
    resetStore()
    render(<SettingsPanel />)
    const rows = screen.getAllByTestId(/^persona-row-/)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toHaveAttribute('data-testid', 'persona-row-chief_director')
  })

  it('renders a model select for PM only', () => {
    resetStore()
    render(<SettingsPanel />)
    const selects = screen.getAllByTestId(/^model-select-/)
    expect(selects).toHaveLength(1)
  })

  it('shows default model for chief_director', () => {
    resetStore()
    render(<SettingsPanel />)
    const select = screen.getByTestId('model-select-chief_director') as HTMLSelectElement
    expect(select.value).toBe(DEFAULT_PERSONA_MODELS.chief_director)
  })

  // ── Interactions ───────────────────────────────────────────────────────────

  it('changing a model select updates settingsStore', () => {
    resetStore()
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
    render(<SettingsPanel />)

    fireEvent.click(screen.getByTestId('settings-reset'))

    const { personaModels } = useSettingsStore.getState()
    expect(personaModels.chief_director).toBe(DEFAULT_PERSONA_MODELS.chief_director)
  })

  it('clicking close button navigates away from settings', () => {
    resetStore()
    render(<SettingsPanel />)
    fireEvent.click(screen.getByTestId('settings-close'))
    expect(useUIStore.getState().centerTab).toBe('graph')
  })

  it('clicking save button navigates away from settings', () => {
    resetStore()
    render(<SettingsPanel />)
    fireEvent.click(screen.getByTestId('settings-save'))
    expect(useUIStore.getState().centerTab).toBe('graph')
  })

  // ── Content ────────────────────────────────────────────────────────────────

  it('shows PM speaker label', () => {
    resetStore()
    render(<SettingsPanel />)
    expect(screen.getByText('PM')).toBeInTheDocument()
  })

  // ── VaultSelector section (in '일반' tab) ────────────────────────────────────

  it('renders the vault-selector in 볼트 관리자 tab', () => {
    resetStore()
    render(<SettingsPanel />)
    fireEvent.click(screen.getByText('볼트 관리자'))
    expect(screen.getByTestId('vault-selector')).toBeInTheDocument()
  })

  it('renders vault-select-btn in 볼트 관리자 tab (Electron)', () => {
    // vault-select-btn is shown only in Electron (window.vaultAPI set)
    ;(window as any).vaultAPI = {}
    resetStore()
    render(<SettingsPanel />)
    fireEvent.click(screen.getByText('볼트 관리자'))
    expect(screen.getByTestId('vault-select-btn')).toBeInTheDocument()
    delete (window as any).vaultAPI
  })
})
