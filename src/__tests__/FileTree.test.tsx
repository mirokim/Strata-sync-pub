import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import FileTree from '@/components/fileTree/FileTree'
import { useUIStore } from '@/stores/uiStore'
import { useVaultStore } from '@/stores/vaultStore'
import { MOCK_DOCUMENTS } from '@/data/mockDocuments'

beforeEach(() => {
  useUIStore.setState({
    appState: 'main',
    centerTab: 'graph',
    selectedDocId: null,
    theme: 'dark',
    graphMode: '3d',
  })
  // Reset vault store so tests always use Mock data fallback
  useVaultStore.setState({
    vaultPath: null,
    loadedDocuments: null,
    isLoading: false,
    error: null,
  })
})

describe('FileTree — rendering', () => {
  it('renders the file tree container', () => {
    render(<FileTree />)
    expect(screen.getByTestId('file-tree')).toBeInTheDocument()
  })

  it('renders speaker group headers for documents that exist', () => {
    render(<FileTree />)
    // With SPEAKER_IDS=['chief_director'], mock mode shows PM group + 미분류 (unknown) group
    const pmGroup = screen.getByRole('button', { name: /PM/i })
    expect(pmGroup).toBeInTheDocument()
    // Non-PM docs (art/plan/level/tech) fall into unknown group
    const unknownGroup = screen.getByRole('button', { name: /미분류/i })
    expect(unknownGroup).toBeInTheDocument()
  })

  it('shows total document count in footer', () => {
    render(<FileTree />)
    expect(screen.getByText(`${MOCK_DOCUMENTS.length} / ${MOCK_DOCUMENTS.length} 문서`)).toBeInTheDocument()
  })
})

describe('FileTree — search filtering', () => {
  it('renders the search input', () => {
    render(<FileTree />)
    expect(screen.getByRole('textbox', { name: /search/i })).toBeInTheDocument()
  })

  it('filters documents by filename', async () => {
    render(<FileTree />)
    const searchInput = screen.getByRole('textbox', { name: /search/i })
    await userEvent.type(searchInput, 'character')
    // Only art docs with "character" should remain visible
    expect(screen.getByText(/0 문서|1 문서|2 문서/)).toBeInTheDocument()
  })

  it('shows "검색 결과 없음" when no match', async () => {
    render(<FileTree />)
    const searchInput = screen.getByRole('textbox', { name: /search/i })
    await userEvent.type(searchInput, 'xyznonexistent')
    expect(screen.getByText('검색 결과 없음')).toBeInTheDocument()
  })

  it('clear button resets search', async () => {
    render(<FileTree />)
    const searchInput = screen.getByRole('textbox', { name: /search/i })
    await userEvent.type(searchInput, 'character')
    const clearBtn = screen.getByRole('button', { name: /clear search/i })
    await userEvent.click(clearBtn)
    expect(searchInput).toHaveValue('')
    expect(screen.getByText(`${MOCK_DOCUMENTS.length} / ${MOCK_DOCUMENTS.length} 문서`)).toBeInTheDocument()
  })
})

describe('FileTree — document selection', () => {
  it('clicking a document opens it in editor via uiStore', async () => {
    render(<FileTree />)
    // Find the first document item (any file item button with data-doc-id)
    const docButtons = screen.getAllByRole('button').filter(
      btn => btn.getAttribute('data-doc-id')
    )
    expect(docButtons.length).toBeGreaterThan(0)
    await userEvent.click(docButtons[0])
    const { editingDocId, centerTab } = useUIStore.getState()
    expect(editingDocId).not.toBeNull()
    expect(centerTab).toBe('editor')
  })
})

describe('FileTree — speaker group toggle', () => {
  it('clicking a speaker group header collapses it', async () => {
    render(<FileTree />)
    // Use 미분류 (unknown) group which always has docs in mock mode
    const unknownGroupBtn = screen.getByRole('button', { name: /미분류/i })
    expect(unknownGroupBtn).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(unknownGroupBtn)
    expect(unknownGroupBtn).toHaveAttribute('aria-expanded', 'false')
  })

  it('clicking a collapsed group expands it again', async () => {
    render(<FileTree />)
    const unknownGroupBtn = screen.getByRole('button', { name: /미분류/i })
    await userEvent.click(unknownGroupBtn) // collapse
    await userEvent.click(unknownGroupBtn) // expand
    expect(unknownGroupBtn).toHaveAttribute('aria-expanded', 'true')
  })
})
