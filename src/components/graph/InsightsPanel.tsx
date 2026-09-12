/**
 * InsightsPanel — 볼트 그래프 인사이트 패널
 *
 * computeInsights()로 분석한 결과를 표시:
 * - 브리지 노드: 많이 참조되는 허브 문서
 * - 고립 문서: 링크가 전혀 없는 문서
 * - 빈틈 주제: 여러 곳에서 참조되지만 파일이 없는 주제
 * - 클러스터: 연결 그룹 요약
 */

import { useMemo, useState } from 'react'
import { useVaultStore } from '@/stores/vaultStore'
import { computeInsights, type InsightResult } from '@/lib/graphAnalysis'
import { useGraphStore } from '@/stores/graphStore'
import { X, RefreshCw } from 'lucide-react'

interface Props {
  onClose: () => void
}

export default function InsightsPanel({ onClose }: Props) {
  const loadedDocuments = useVaultStore(s => s.loadedDocuments)
  const setAiHighlightNodes = useGraphStore(s => s.setAiHighlightNodes)
  const [tab, setTab] = useState<'bridge' | 'orphan' | 'gap' | 'cluster'>('bridge')
  const [rev, setRev] = useState(0)

  const insights: InsightResult = useMemo(() => {
    if (!loadedDocuments || loadedDocuments.length === 0) {
      return { bridgeNodes: [], orphanDocs: [], gapTopics: [], clusters: [] }
    }
    return computeInsights(loadedDocuments)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedDocuments, rev])

  const TABS = [
    { id: 'bridge',  label: '허브 노드',  count: insights.bridgeNodes.length,  color: '#60a5fa' },
    { id: 'orphan',  label: '고립 문서',  count: insights.orphanDocs.length,   color: 'var(--color-error)' },
    { id: 'gap',     label: '빈틈 주제',  count: insights.gapTopics.length,    color: '#fbbf24' },
    { id: 'cluster', label: '클러스터',   count: insights.clusters.length,     color: '#a78bfa' },
  ] as const

  const highlightNode = (docId: string) => {
    setAiHighlightNodes([docId])
    setTimeout(() => setAiHighlightNodes([]), 3000)
  }

  return (
    <div
      style={{
        position: 'absolute', top: 8, right: 8, width: 320, maxHeight: 480,
        background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)',
        borderRadius: 8, display: 'flex', flexDirection: 'column', zIndex: 50,
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '8px 12px',
        borderBottom: '1px solid var(--color-border)',
      }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text-primary)', flex: 1 }}>
          볼트 인사이트
        </span>
        <button
          onClick={() => setRev(r => r + 1)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4 }}
          title="재분석"
        >
          <RefreshCw size={11} />
        </button>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 4 }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Tabs */}
      <div style={{
        display: 'flex', borderBottom: '1px solid var(--color-border)',
        padding: '0 8px',
      }}>
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            style={{
              flex: 1, padding: '6px 4px', fontSize: 10, fontWeight: 600,
              background: 'none', border: 'none', cursor: 'pointer',
              color: tab === t.id ? t.color : 'var(--color-text-muted)',
              borderBottom: tab === t.id ? `2px solid ${t.color}` : '2px solid transparent',
              transition: 'color 0.15s',
            }}
          >
            {t.label}
            <span style={{
              marginLeft: 4,
              background: tab === t.id ? `${t.color}22` : 'var(--color-bg-surface)',
              color: tab === t.id ? t.color : 'var(--color-text-muted)',
              borderRadius: 8, padding: '1px 5px', fontSize: 9,
            }}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {tab === 'bridge' && (
          <>
            {insights.bridgeNodes.length === 0 ? (
              <EmptyState msg="인바운드 링크 3개 이상인 허브 없음" />
            ) : insights.bridgeNodes.map(n => (
              <InsightRow
                key={n.docId}
                label={n.filename.replace(/\.md$/i, '')}
                badge={`↙${n.inboundCount} ↗${n.outboundCount}`}
                color="#60a5fa"
                onClick={() => highlightNode(n.docId)}
                tooltip="그래프에서 강조 표시"
              />
            ))}
          </>
        )}

        {tab === 'orphan' && (
          <>
            {insights.orphanDocs.length === 0 ? (
              <EmptyState msg="고립 문서 없음 — 모든 문서에 링크 있음" isGood />
            ) : (
              <>
                <div style={{ padding: '0 12px 6px', fontSize: 11, color: 'var(--color-text-muted)' }}>
                  인바운드/아웃바운드 링크가 모두 없는 문서
                </div>
                {insights.orphanDocs.map(n => (
                  <InsightRow
                    key={n.docId}
                    label={n.filename.replace(/\.md$/i, '')}
                    color="var(--color-error)"
                    onClick={() => highlightNode(n.docId)}
                    tooltip="그래프에서 강조 표시"
                  />
                ))}
              </>
            )}
          </>
        )}

        {tab === 'gap' && (
          <>
            {insights.gapTopics.length === 0 ? (
              <EmptyState msg="작성 필요 주제 없음" isGood />
            ) : (
              <>
                <div style={{ padding: '0 12px 6px', fontSize: 11, color: 'var(--color-text-muted)' }}>
                  여러 문서에서 참조되지만 파일이 없는 주제 (작성 권장)
                </div>
                {insights.gapTopics.map(g => (
                  <InsightRow
                    key={g.topic}
                    label={g.topic}
                    badge={`${g.referenceCount}회 참조`}
                    color="#fbbf24"
                  />
                ))}
              </>
            )}
          </>
        )}

        {tab === 'cluster' && (
          <>
            {insights.clusters.length === 0 ? (
              <EmptyState msg="분리된 클러스터 없음 — 볼트가 단일 연결" isGood />
            ) : insights.clusters.map((c, i) => (
              <InsightRow
                key={c.clusterIdx}
                label={`클러스터 ${i + 1}: ${c.representative.replace(/\.md$/i, '')}`}
                badge={`${c.size}개 문서`}
                color="#a78bfa"
              />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

function InsightRow({
  label, badge, color, onClick, tooltip,
}: {
  label: string
  badge?: string
  color: string
  onClick?: () => void
  tooltip?: string
}) {
  return (
    <div
      onClick={onClick}
      title={tooltip}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '5px 12px',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => { if (onClick) (e.currentTarget as HTMLElement).style.background = 'var(--color-bg-hover)' }}
      onMouseLeave={e => { if (onClick) (e.currentTarget as HTMLElement).style.background = 'transparent' }}
    >
      <div style={{ width: 4, height: 4, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{
        flex: 1, fontSize: 11, color: 'var(--color-text-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {label}
      </span>
      {badge && (
        <span style={{
          fontSize: 10, color: color, background: `${color}18`,
          borderRadius: 4, padding: '1px 6px', flexShrink: 0,
          border: `1px solid ${color}33`,
        }}>
          {badge}
        </span>
      )}
    </div>
  )
}

function EmptyState({ msg, isGood }: { msg: string; isGood?: boolean }) {
  return (
    <div style={{
      padding: '20px 16px', textAlign: 'center', fontSize: 11,
      color: isGood ? 'var(--color-success)' : 'var(--color-text-muted)',
    }}>
      {isGood ? '✅ ' : ''}{msg}
    </div>
  )
}
