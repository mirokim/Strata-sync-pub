import type { CSSProperties } from 'react'

/** Recovered from the September 13 brand deployment. The wordmark follows the theme. */
export default function BrandLogo({ width = 180, style }: { width?: number; style?: CSSProperties }) {
  const base = import.meta.env.BASE_URL
  const mask = `url("${base}strata-sync-wordmark.svg") center / contain no-repeat`
  return (
    <span role="img" aria-label="Strata Sync" style={{ display: 'inline-flex', alignItems: 'center', gap: width * 0.047, width, flexShrink: 0, color: 'var(--color-text-primary)', ...style }}>
      <img src={`${base}strata-sync-icon.svg`} alt="" aria-hidden="true" draggable={false} style={{ width: '14.8%', height: 'auto', display: 'block' }} />
      <span aria-hidden="true" style={{ display: 'block', flex: 1, aspectRatio: '392 / 40', background: 'currentColor', mask, WebkitMask: mask }} />
    </span>
  )
}
