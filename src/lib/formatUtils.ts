/**
 * Shared formatting utilities.
 * Single source of truth — used by StatusBar, UsageTab, editAgentRunner, syncRunner, etc.
 */

/** Format a token count as human-readable string (e.g. 1.2K, 3.5M) */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

/** Format a USD cost with appropriate precision */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd < 0) return '0'
  if (usd === 0)   return '$0.000'
  if (usd < 0.001) return '<$0.001'
  if (usd < 1)     return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Zero-pad a number to 2 digits: 3 → "03" */
export function padZero(n: number): string {
  return String(n).padStart(2, '0')
}

/** Local date as YYYY-MM-DD (로컬 시스템 시간 기준, KST 등 올바르게 반영) */
export function formatLocalDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${padZero(d.getMonth() + 1)}-${padZero(d.getDate())}`
}

/** Local datetime as YYYY-MM-DD HH:mm */
export function formatLocalDateTime(d: Date = new Date()): string {
  return `${formatLocalDate(d)} ${padZero(d.getHours())}:${padZero(d.getMinutes())}`
}

/**
 * ISO 타임스탬프 → CQL/JQL용 "YYYY-MM-DD HH:mm" (UTC)
 * Confluence CQL과 Jira JQL은 UTC datetime을 기준으로 필터링함
 */
export function toSyncDatetime(iso: string | null, fallback: string): string {
  if (!iso) return fallback
  const d = new Date(iso)
  if (isNaN(d.getTime())) return fallback
  return `${d.getUTCFullYear()}-${padZero(d.getUTCMonth() + 1)}-${padZero(d.getUTCDate())} ${padZero(d.getUTCHours())}:${padZero(d.getUTCMinutes())}`
}
