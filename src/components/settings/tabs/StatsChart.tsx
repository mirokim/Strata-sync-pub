/**
 * StatsChart.tsx — SVG-based vault statistics trend charts
 *
 * Implemented in pure SVG without external libraries.
 * Imported and used by StatsTab.
 */
import { useState, useEffect, useMemo } from 'react'
import { useVaultStore } from '@/stores/vaultStore'
import { loadStatsLog, type VaultStatsSnapshot } from '@/lib/vaultStatsLog'
import { useT } from '@/i18n'

// ── Color palette ────────────────────────────────────────────────────────────

const ORIGIN_COLORS: Record<string, string> = {
  manual: '#60a5fa',
  confluence: '#f59e0b',
  jira: '#10b981',
}

const CATEGORY_COLORS = [
  '#60a5fa', '#f59e0b', '#10b981', '#f472b6', '#a78bfa',
  '#fb923c', '#34d399', '#818cf8', '#fbbf24', '#6ee7b7',
]

// ── Mini SVG line chart ─────────────────────────────────────────────────────

function MiniLineChart({ data, color, width = 280, height = 60 }: {
  data: number[]
  color: string
  width?: number
  height?: number
}) {
  if (data.length < 2) return null
  const max = Math.max(...data, 1)
  const min = Math.min(...data, 0)
  const range = max - min || 1
  const padY = 4
  const padX = 2

  const points = data.map((v, i) => {
    const x = padX + (i / (data.length - 1)) * (width - padX * 2)
    const y = padY + (1 - (v - min) / range) * (height - padY * 2)
    return `${x},${y}`
  }).join(' ')

  // Area fill
  const first = `${padX},${height - padY}`
  const last = `${padX + ((data.length - 1) / (data.length - 1)) * (width - padX * 2)},${height - padY}`
  const areaPoints = `${first} ${points} ${last}`

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polygon points={areaPoints} fill={color} opacity={0.1} />
      <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
      {/* Highlight the last point */}
      {data.length > 0 && (() => {
        const lastX = padX + ((data.length - 1) / (data.length - 1)) * (width - padX * 2)
        const lastY = padY + (1 - (data[data.length - 1] - min) / range) * (height - padY * 2)
        return <circle cx={lastX} cy={lastY} r={2.5} fill={color} />
      })()}
    </svg>
  )
}

// ── Stacked bar chart ───────────────────────────────────────────────────────

function StackedBarChart({ snapshots, field, colorMap, width = 280, height = 120 }: {
  snapshots: VaultStatsSnapshot[]
  field: 'byOrigin' | 'byType' | 'byFolder'
  colorMap?: Record<string, string>
  width?: number
  height?: number
}) {
  if (snapshots.length === 0) return null

  // Collect all categories
  const allKeys = new Set<string>()
  for (const s of snapshots) {
    for (const k of Object.keys(s[field])) allKeys.add(k)
  }
  const keys = [...allKeys]

  // Assign colors
  const colors: Record<string, string> = {}
  keys.forEach((k, i) => {
    colors[k] = colorMap?.[k] ?? CATEGORY_COLORS[i % CATEGORY_COLORS.length]
  })

  const maxTotal = Math.max(...snapshots.map(s => Object.values(s[field]).reduce((a, b) => a + b, 0)), 1)
  const barWidth = Math.max(4, Math.min(16, (width - 40) / snapshots.length - 2))
  const padX = 30
  const padY = 16
  const chartH = height - padY * 2

  return (
    <div>
      <svg width={width} height={height} style={{ display: 'block' }}>
        {/* Y-axis ticks */}
        {[0, 0.5, 1].map(ratio => {
          const y = padY + (1 - ratio) * chartH
          const val = Math.round(maxTotal * ratio)
          return (
            <g key={ratio}>
              <line x1={padX} x2={width} y1={y} y2={y} stroke="var(--color-border)" strokeWidth={0.5} />
              <text x={padX - 4} y={y + 3} textAnchor="end"
                style={{ fontSize: 9, fill: 'var(--color-text-muted)' }}>{val}</text>
            </g>
          )
        })}

        {/* Bars */}
        {snapshots.map((s, i) => {
          const x = padX + 8 + i * (barWidth + 2)
          let yOffset = 0
          return (
            <g key={s.date}>
              {keys.map(k => {
                const val = s[field][k] ?? 0
                const barH = (val / maxTotal) * chartH
                const y = padY + chartH - yOffset - barH
                yOffset += barH
                return (
                  <rect key={k} x={x} y={y} width={barWidth} height={Math.max(barH, 0)}
                    fill={colors[k]} rx={1} opacity={0.85}>
                    <title>{`${s.date}\n${k}: ${val}`}</title>
                  </rect>
                )
              })}
              {/* X-axis dates (spaced out) */}
              {(i === 0 || i === snapshots.length - 1 || snapshots.length <= 10 || i % Math.ceil(snapshots.length / 6) === 0) && (
                <text x={x + barWidth / 2} y={height - 2} textAnchor="middle"
                  style={{ fontSize: 8, fill: 'var(--color-text-muted)' }}>
                  {s.date.slice(5)}
                </text>
              )}
            </g>
          )
        })}
      </svg>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginTop: 4 }}>
        {keys.map(k => (
          <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--color-text-muted)' }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: colors[k], flexShrink: 0 }} />
            <span>{k}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Delta badge ─────────────────────────────────────────────────────────────

function DeltaBadge({ current, previous }: { current: number; previous: number }) {
  const delta = current - previous
  if (delta === 0) return null
  const color = delta > 0 ? 'var(--color-success)' : 'var(--color-error)'
  return (
    <span style={{ fontSize: 10, color, fontWeight: 600, marginLeft: 4 }}>
      {delta > 0 ? '+' : ''}{delta}
    </span>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

export default function StatsChart() {
  const t = useT()
  const vaultPath = useVaultStore(s => s.vaultPath)
  const [snapshots, setSnapshots] = useState<VaultStatsSnapshot[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!vaultPath) return
    setLoading(true)
    loadStatsLog(vaultPath).then(data => {
      setSnapshots(data)
      setLoading(false)
    })
  }, [vaultPath])

  const chartWidth = 320

  const { totalTrend, charsTrend, linksTrend, orphanTrend, latest, prev } = useMemo(() => {
    const totalTrend = snapshots.map(s => s.total)
    const charsTrend = snapshots.map(s => Math.round(s.totalChars / 1024))
    const linksTrend = snapshots.map(s => s.totalLinks)
    const orphanTrend = snapshots.map(s => s.orphanCount)
    const latest = snapshots[snapshots.length - 1] ?? null
    const prev = snapshots.length >= 2 ? snapshots[snapshots.length - 2] : null
    return { totalTrend, charsTrend, linksTrend, orphanTrend, latest, prev }
  }, [snapshots])

  if (!vaultPath || loading) return null
  if (snapshots.length < 2) {
    return (
      <div style={{ fontSize: 11, color: 'var(--color-text-muted)', padding: '8px 0' }}>
        {t('Trend charts need at least 2 days of data. A snapshot is recorded automatically each day the vault is loaded.')}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Total document count trend */}
      <div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
            {t('Total Documents')}
          </span>
          {latest && <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-text-primary)' }}>{latest.total}</span>}
          {latest && prev && <DeltaBadge current={latest.total} previous={prev.total} />}
        </div>
        <MiniLineChart data={totalTrend} color="#60a5fa" width={chartWidth} />
      </div>

      {/* Trend by source */}
      <div>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {t('By Source')}
        </span>
        <div style={{ marginTop: 6 }}>
          <StackedBarChart snapshots={snapshots} field="byOrigin" colorMap={ORIGIN_COLORS} width={chartWidth} />
        </div>
      </div>

      {/* Trend by type */}
      <div>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {t('By Type')}
        </span>
        <div style={{ marginTop: 6 }}>
          <StackedBarChart snapshots={snapshots} field="byType" width={chartWidth} />
        </div>
      </div>

      {/* Trend by folder */}
      <div>
        <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
          {t('By Folder')}
        </span>
        <div style={{ marginTop: 6 }}>
          <StackedBarChart snapshots={snapshots} field="byFolder" width={chartWidth} />
        </div>
      </div>

      {/* Total chars / links / orphan docs mini charts */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>
            {t('Total Chars (KB)')}
            {latest && prev && <DeltaBadge current={Math.round(latest.totalChars / 1024)} previous={Math.round(prev.totalChars / 1024)} />}
          </div>
          <MiniLineChart data={charsTrend} color="#f59e0b" width={90} height={40} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>
            {t('Total Links')}
            {latest && prev && <DeltaBadge current={latest.totalLinks} previous={prev.totalLinks} />}
          </div>
          <MiniLineChart data={linksTrend} color="#10b981" width={90} height={40} />
        </div>
        <div>
          <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 4 }}>
            {t('Orphan Docs')}
            {latest && prev && <DeltaBadge current={latest.orphanCount} previous={prev.orphanCount} />}
          </div>
          <MiniLineChart data={orphanTrend} color="#ef4444" width={90} height={40} />
        </div>
      </div>

      {/* Date range */}
      <div style={{ fontSize: 9, color: 'var(--color-text-muted)', opacity: 0.6 }}>
        {t('{start} ~ {end} ({count} days recorded)', {
          start: snapshots[0].date,
          end: snapshots[snapshots.length - 1].date,
          count: snapshots.length,
        })}
      </div>
    </div>
  )
}
