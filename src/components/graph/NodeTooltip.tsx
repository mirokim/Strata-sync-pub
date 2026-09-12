import { useMemo } from 'react'
import { useGraphStore } from '@/stores/graphStore'
import { useVaultStore } from '@/stores/vaultStore'
import { MOCK_DOCUMENTS } from '@/data/mockDocuments'

interface NodeTooltipProps {
  nodeId: string
  /** Viewport X coordinate (from click event) */
  x: number
  /** Viewport Y coordinate */
  y: number
}

export default function NodeTooltip({ nodeId, x, y }: NodeTooltipProps) {
  const { nodes } = useGraphStore()
  const { vaultPath, loadedDocuments } = useVaultStore()

  const allDocuments = (vaultPath && loadedDocuments) ? loadedDocuments : MOCK_DOCUMENTS

  const info = useMemo(() => {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return null
    const doc = allDocuments.find(d => d.id === node.docId)
    return { node, doc }
  }, [nodeId, nodes, allDocuments])

  if (!info) return null
  const { node, doc } = info

  // 문서 제목: frontmatter title > 파일명 stem > node label
  const title = doc?.title || node.label
  const stem = doc?.filename.replace(/\.md$/i, '') ?? ''
  const showStem = stem && stem !== title

  // 태그 최대 3개
  const tags = doc?.tags?.slice(0, 3) ?? []

  // 노드 중심 기준 — 툴팁을 노드 바로 아래에 배치, 화면 경계 초과 방지
  const TOOLTIP_WIDTH = 200
  const offsetX = Math.min(Math.max(x - TOOLTIP_WIDTH / 2, 8), window.innerWidth - TOOLTIP_WIDTH - 8)
  const offsetY = Math.min(y + 14, window.innerHeight - 120)

  return (
    <div
      role="tooltip"
      style={{
        position: 'fixed',
        left: offsetX,
        top: offsetY,
        zIndex: 9999,
        background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 4,
        padding: '7px 10px',
        minWidth: 140,
        maxWidth: 260,
        pointerEvents: 'none',
        boxShadow: '0 4px 16px rgba(0,0,0,0.45)',
      }}
    >
      {/* 문서 제목 */}
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)', lineHeight: 1.4, wordBreak: 'break-word' }}>
        {title}
      </div>

      {/* 파일명 (제목과 다를 때만) */}
      {showStem && (
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3 }}>
          {stem}
        </div>
      )}

      {/* 태그 */}
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 5 }}>
          {tags.map(tag => (
            <span
              key={tag}
              style={{
                fontSize: 9,
                padding: '1px 5px',
                borderRadius: 3,
                background: 'var(--color-bg-secondary)',
                color: 'var(--color-text-muted)',
                border: '1px solid var(--color-border)',
              }}
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
