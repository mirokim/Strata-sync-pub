import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import GeneralTab from '@/components/settings/tabs/GeneralTab'
import { useUIStore } from '@/stores/uiStore'

describe('Settings → General → Graph view', () => {
  beforeEach(() => { useUIStore.setState({ graphMode: '3d' }) })

  it('offers 3D and 2D, reflects the current mode and switches it', () => {
    render(<GeneralTab />)
    expect(screen.getByTestId('graph-view-3d')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('graph-view-2d')).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(screen.getByTestId('graph-view-2d'))
    expect(useUIStore.getState().graphMode).toBe('2d')
    expect(screen.getByTestId('graph-view-2d')).toHaveAttribute('aria-checked', 'true')
  })

  it('is part of what the UI store persists', () => {
    useUIStore.setState({ graphMode: '2d' })
    const persisted = JSON.parse(localStorage.getItem('strata-sync-ui') ?? '{}') as { state?: { graphMode?: string } }
    expect(persisted.state?.graphMode).toBe('2d')
  })
})
