import { useEffect, useRef, useState } from 'react'
import { useVaultStore } from '@/stores/vaultStore'
import { useGraphStore } from '@/stores/graphStore'
import { useSettingsStore } from '@/stores/settingsStore'

const SATELLITES = [0, 60, 120, 180, 240, 300].map((deg, i) => {
  const rad = (deg * Math.PI) / 180
  return { x: Math.round(Math.cos(rad) * 22), y: Math.round(Math.sin(rad) * 22), delay: i * 0.28 }
})

export default function LoadingOverlay() {
  const {
    isLoading, vaultPath, vaultReady, loadingProgress, loadingPhase,
    vaults, activeVaultId, vaultDocsCache, bgLoadingInfo,
  } = useVaultStore()
  const graphLayoutReady = useGraphStore(s => s.graphLayoutReady)
  const { setParagraphRenderQuality } = useSettingsStore()

  // 백그라운드 로딩(bgLoadingInfo)은 오버레이를 블로킹하지 않음 — UI 클릭 허용
  const shouldShow = isLoading
    || (vaultPath !== null && !vaultReady)
  const isBgOnly = !shouldShow && bgLoadingInfo !== null

  // Auto-select 'fast' quality on first vault load only — do not clobber user preference on subsequent loads
  const hasAutoSetQuality = useRef(false)
  useEffect(() => {
    if (!shouldShow && !hasAutoSetQuality.current) {
      hasAutoSetQuality.current = true
      setParagraphRenderQuality('fast')
    }
  }, [shouldShow, setParagraphRenderQuality])

  const [visible, setVisible] = useState(shouldShow)
  const [fading, setFading] = useState(false)
  const fadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (shouldShow) {
      if (fadeTimer.current) clearTimeout(fadeTimer.current)
      setFading(false)
      setVisible(true)
    } else if (visible) {
      setFading(true)
      fadeTimer.current = setTimeout(() => {
        setVisible(false)
        setFading(false)
      }, 700)
    }
    return () => { if (fadeTimer.current) clearTimeout(fadeTimer.current) }
  }, [shouldShow, visible])

  // Indeterminate bar pulse (for background loading)
  const [pulseOpacity, setPulseOpacity] = useState(0.4)
  const pulseRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const pulseDir = useRef(1)
  useEffect(() => {
    if (bgLoadingInfo && !isLoading) {
      pulseRef.current = setInterval(() => {
        setPulseOpacity(v => {
          const next = v + pulseDir.current * 0.05
          if (next >= 0.9) { pulseDir.current = -1; return 0.9 }
          if (next <= 0.2) { pulseDir.current = 1; return 0.2 }
          return next
        })
      }, 50)
    } else {
      if (pulseRef.current) clearInterval(pulseRef.current)
      setPulseOpacity(0.4)
    }
    return () => { if (pulseRef.current) clearInterval(pulseRef.current) }
  }, [bgLoadingInfo, isLoading])

  // 백그라운드 인덱싱만 진행 중 — 하단 미니 바만 표시 (UI 블로킹 없음)
  if (!visible && isBgOnly) {
    return (
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 50,
        padding: '4px 16px', display: 'flex', alignItems: 'center', gap: 8,
        background: 'var(--color-bg-surface)', borderTop: '1px solid var(--color-border)',
        pointerEvents: 'none',
      }}>
        <div style={{ height: 2, flex: 1, background: 'var(--color-border)', borderRadius: 1, overflow: 'hidden' }}>
          <div style={{
            height: '100%', background: 'var(--color-accent)', width: '50%', borderRadius: 1,
            opacity: pulseOpacity, transition: 'opacity 0.05s',
          }} />
        </div>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
          {bgLoadingInfo!.done + 1}/{bgLoadingInfo!.total} 인덱싱
        </span>
      </div>
    )
  }

  if (!visible) return null

  const vaultEntries = Object.entries(vaults)
  const showVaultList = vaultEntries.length > 1 || bgLoadingInfo !== null
  const isBgLoading = bgLoadingInfo !== null && !isLoading

  // Count how many vaults are ready (have cached docs)
  const readyCount = vaultEntries.filter(([id]) => (vaultDocsCache[id]?.length ?? 0) > 0).length

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--color-bg-primary)',
        opacity: fading ? 0 : 1,
        transition: 'opacity 0.7s ease',
        pointerEvents: fading ? 'none' : 'auto',
      }}
    >
      {/* Graph animation */}
      <div style={{ marginBottom: 28 }}>
        <svg width="72" height="72" viewBox="-32 -32 64 64" overflow="visible">
          {SATELLITES.map((s, i) => (
            <line key={`line-${i}`} x1="0" y1="0" x2={s.x} y2={s.y}
              stroke="var(--color-text-secondary)" strokeWidth="1">
              <animate attributeName="opacity" values="0;0.35;0.35;0"
                dur="1.7s" begin={`${s.delay}s`} repeatCount="indefinite" />
            </line>
          ))}
          {SATELLITES.map((s, i) => (
            <circle key={`sat-${i}`} cx={s.x} cy={s.y} r="0" fill="var(--color-text-muted)">
              <animate attributeName="r" values="0;3;3;0"
                dur="1.7s" begin={`${s.delay}s`} repeatCount="indefinite" />
              <animate attributeName="opacity" values="0;0.9;0.9;0"
                dur="1.7s" begin={`${s.delay}s`} repeatCount="indefinite" />
            </circle>
          ))}
          <circle cx="0" cy="0" fill="var(--color-accent, #60a5fa)" r="6">
            <animate attributeName="r" values="5;7.5;5" dur="1.5s" repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.9;0.45;0.9" dur="1.5s" repeatCount="indefinite" />
          </circle>
        </svg>
      </div>

      {/* Info block */}
      <div style={{ width: 360, display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Title */}
        <div style={{
          color: 'var(--color-text-primary)', fontSize: 15, fontWeight: 700,
          letterSpacing: '0.05em', opacity: 0.9, marginBottom: 2,
        }}>
          Sandbox Map
        </div>

        {/* Vault list (multi-vault only) */}
        {showVaultList && (
          <div style={{
            border: '1px solid var(--color-border)', borderRadius: 6, overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '7px 12px',
              background: 'var(--color-bg-surface)',
              borderBottom: '1px solid var(--color-border)',
            }}>
              <span style={{
                fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
                textTransform: 'uppercase', color: 'var(--color-text-muted)',
              }}>
                볼트 준비 현황
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                {readyCount} / {vaultEntries.length}
              </span>
            </div>

            {/* Vault rows */}
            {vaultEntries.map(([id, entry]) => {
              const isDone   = (vaultDocsCache[id]?.length ?? 0) > 0
              const isActive = id === activeVaultId
              const isCurrentlyLoading = isActive && isLoading
              const label = entry.label || entry.path.split(/[/\\]/).pop() || id
              const isBgLoadingThis = isBgLoading && bgLoadingInfo?.label === label
              const docCount = vaultDocsCache[id]?.length ?? 0

              const isSpinning = isCurrentlyLoading || isBgLoadingThis
              let statusColor = 'var(--color-text-muted)'
              let statusSymbol = '○'
              if (isDone && !isCurrentlyLoading) { statusColor = 'var(--color-success)'; statusSymbol = '✓' }

              return (
                <div key={id} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--color-border)',
                  background: isActive ? 'rgba(96,165,250,0.04)' : 'transparent',
                }}>
                  <span style={{
                    flexShrink: 0, width: 14, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: statusColor,
                  }}>
                    {isSpinning ? (
                      <svg width="12" height="12" viewBox="0 0 12 12"
                        style={{ animation: 'spin 0.9s linear infinite', display: 'block', color: 'var(--color-accent)' }}>
                        <circle cx="6" cy="6" r="4.5" fill="none"
                          stroke="currentColor" strokeWidth="1.5" strokeDasharray="14 7" strokeLinecap="round" />
                      </svg>
                    ) : (
                      <span style={{ fontSize: 13, lineHeight: 1 }}>{statusSymbol}</span>
                    )}
                  </span>
                  <span style={{
                    flex: 1, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap', fontWeight: isActive ? 600 : 400,
                    color: isDone ? 'var(--color-text-primary)' : 'var(--color-text-muted)',
                  }}>
                    {label}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0 }}>
                    {isCurrentlyLoading ? `${loadingProgress}%`
                      : isBgLoadingThis ? '인덱싱 중...'
                      : isDone ? `${docCount}개`
                      : '대기 중'}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* Progress bar */}
        <div style={{ height: 3, background: 'var(--color-border)', borderRadius: 2, overflow: 'hidden' }}>
          {isBgLoading ? (
            // Indeterminate pulse
            <div style={{
              height: '100%',
              background: 'var(--color-accent, #60a5fa)',
              width: '60%',
              borderRadius: 2,
              opacity: pulseOpacity,
              transition: 'opacity 0.05s',
            }} />
          ) : (
            <div style={{
              height: '100%',
              background: 'var(--color-accent, #60a5fa)',
              width: `${loadingProgress}%`,
              borderRadius: 2,
              transition: 'width 0.25s ease',
            }} />
          )}
        </div>

        {/* Phase label + percentage */}
        <div style={{
          display: 'flex', justifyContent: 'space-between',
          color: 'var(--color-text-secondary)', fontSize: 12, opacity: 0.65,
        }}>
          <span>
            {isBgLoading
              ? `백그라운드 인덱싱 중... (${bgLoadingInfo!.done + 1}/${bgLoadingInfo!.total})`
              : (loadingPhase || '볼트 로딩 중...')}
          </span>
          {!isBgLoading && loadingProgress > 0 && <span>{loadingProgress}%</span>}
        </div>

      </div>

      {/* CSS for spin animation */}
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  )
}
