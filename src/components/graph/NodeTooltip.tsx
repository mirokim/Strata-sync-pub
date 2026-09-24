import { useMemo } from 'react'
import { useGraphStore } from '@/stores/graphStore'
import { useUIStore } from '@/stores/uiStore'
import { useVaultStore } from '@/stores/vaultStore'
import { MOCK_DOCUMENTS } from '@/data/mockDocuments'
import { SPEAKER_CONFIG } from '@/lib/speakerConfig'
import { useT } from '@/i18n'

interface NodeTooltipProps {
  nodeId: string
  /** Viewport X coordinate (from mousemove/event) */
  x: number
  /** Viewport Y coordinate */
  y: number
  /**
   * Click popups (not hover tooltips): the card itself opens the document, then this runs so the
   * graph can drop the popup. Without it the card lets clicks through to the graph.
   */
  onOpen?: () => void
}

export default function NodeTooltip({ nodeId, x, y, onOpen }: NodeTooltipProps) {
  const t = useT()
  const openInEditor = useUIStore(s => s.openInEditor)
  const { nodes } = useGraphStore()
  const { vaultPath, loadedDocuments } = useVaultStore()

  // Use vault documents if loaded, otherwise fall back to mock
  const allDocuments = (vaultPath && loadedDocuments) ? loadedDocuments : MOCK_DOCUMENTS

  const info = useMemo(() => {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return null
    // node.id === doc.id (document-level nodes since Phase 7)
    const doc = allDocuments.find(d => d.id === node.docId)
    return { node, doc }
  }, [nodeId, nodes, allDocuments])

  if (!info) return null
  const { node, doc } = info
  const { color } = SPEAKER_CONFIG[node.speaker]

  const offsetX = x + 16
  const offsetY = y - 10
  // Phantom nodes (linked names without a document) have nothing to open
  const openable = Boolean(onOpen && doc)
  const phantom = node.docId.startsWith('_phantom_')
  const open = () => { if (!doc) return; openInEditor(doc.id); onOpen?.() }

  return (
    <div
      role={openable ? 'button' : 'tooltip'}
      tabIndex={openable ? 0 : undefined}
      title={openable ? t('Open document') : undefined}
      data-testid="node-popup"
      onClick={openable ? open : undefined}
      onKeyDown={openable ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } } : undefined}
      // The graph closes the popup on any click it sees; a click on the card is ours
      onMouseDown={openable ? e => e.stopPropagation() : undefined}
      style={{
        position: 'fixed',
        left: offsetX,
        top: offsetY,
        zIndex: 9999,
        background: 'var(--color-bg-surface)',
        border: `1px solid ${color}`,
        borderRadius: 6,
        padding: '8px 10px',
        minWidth: 180,
        maxWidth: 280,
        pointerEvents: openable ? 'auto' : 'none',
        cursor: openable ? 'pointer' : undefined,
        boxShadow: `0 4px 12px rgba(0,0,0,0.4), 0 0 0 1px ${color}22`,
      }}
    >
      {/* Speaker label */}
      <div className="text-[10px] font-semibold tracking-wider uppercase mb-1" style={{ color }}>
        {t(SPEAKER_CONFIG[node.speaker].label)}
      </div>
      {/* Document name */}
      <div className="text-xs font-medium mb-1" style={{ color: 'var(--color-text-primary)' }}>
        {node.label}
      </div>
      {/* Doc filename */}
      {doc && (
        <div className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
          {doc.filename}
        </div>
      )}
      {/* Tags */}
      {doc && doc.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {doc.tags.slice(0, 3).map(tag => (
            <span
              key={tag}
              className="text-[9px] px-1.5 py-0.5 rounded"
              style={{ background: `${color}22`, color }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
      {openable && (
        <div className="text-[9px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
          {t('Click to open')}
        </div>
      )}
      {phantom && (
        <div className="text-[9px] mt-1.5" style={{ color: 'var(--color-text-muted)' }} data-testid="node-popup-phantom">
          {t('Link without a document')} · {t('double-click the node to create it')}
        </div>
      )}
    </div>
  )
}
