/**
 * NodeTooltip — the card a graph shows for a clicked node. With onOpen it is a button that opens
 * the document in the editor; phantom nodes (a linked name with no document) stay inert.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import NodeTooltip from '@/components/graph/NodeTooltip'
import { useGraphStore } from '@/stores/graphStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useUIStore } from '@/stores/uiStore'
import { parseVaultFiles } from '@/lib/markdownParser'

const docs = parseVaultFiles([{ relativePath: 'notes/Team.md', absolutePath: 'C:/vault/notes/Team.md', content: '# Team\n\nshared', mtime: 1 }])
const doc = docs[0]

beforeEach(() => {
  useVaultStore.setState({ vaultPath: 'C:/vault', loadedDocuments: docs })
  useGraphStore.setState({
    nodes: [
      { id: doc.id, docId: doc.id, speaker: doc.speaker, label: 'Team' },
      { id: '_phantom_Ghost', docId: '_phantom_Ghost', speaker: 'unknown', label: 'Ghost' },
    ],
  })
  useUIStore.setState({ editingDocId: null })
})

describe('NodeTooltip', () => {
  it('opens the document when the popup is clicked, then tells the graph to close it', () => {
    const onOpen = vi.fn()
    render(<NodeTooltip nodeId={doc.id} x={10} y={10} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('node-popup'))
    expect(useUIStore.getState().editingDocId).toBe(doc.id)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('is a plain, click-through tooltip without onOpen', () => {
    render(<NodeTooltip nodeId={doc.id} x={10} y={10} />)
    const card = screen.getByTestId('node-popup')
    expect(card.getAttribute('role')).toBe('tooltip')
    expect(card.style.pointerEvents).toBe('none')
  })

  it('does nothing for a phantom node, which has no document to open', () => {
    const onOpen = vi.fn()
    render(<NodeTooltip nodeId="_phantom_Ghost" x={10} y={10} onOpen={onOpen} />)
    fireEvent.click(screen.getByTestId('node-popup'))
    expect(onOpen).not.toHaveBeenCalled()
    expect(useUIStore.getState().editingDocId).toBeNull()
  })
})
