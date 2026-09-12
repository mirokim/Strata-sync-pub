/**
 * SlackLogViewer.tsx — Slack bot log viewer
 *
 * Parses bot/slackbot_logs/YYYY-MM-DD.log files and renders them in a readable form.
 * Opened via the ScrollText button in the TopBar.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ChevronLeft, ChevronRight, X, RefreshCw } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'

// ── Log line parsing ─────────────────────────────────────────────────────────

interface LogEntry {
  time: string
  elapsed?: string       // e.g. [52.8s]
  tag: string            // READY, ERR, Slack, RAG, Image, 완료 (done), 쿼리정제 (query refine), etc.
  message: string
  level: 'info' | 'warn' | 'error' | 'success' | 'query' | 'system'
}

const TAG_STYLES: Record<string, { bg: string; fg: string; level: LogEntry['level'] }> = {
  'ERR':        { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', level: 'error' },
  'error':      { bg: 'rgba(239,68,68,0.15)', fg: '#ef4444', level: 'error' },
  'Image':      { bg: 'rgba(239,68,68,0.1)',  fg: '#f87171', level: 'error' },
  'chat_update':{ bg: 'rgba(239,68,68,0.1)',  fg: '#f87171', level: 'error' },
  'READY':      { bg: 'rgba(34,197,94,0.15)', fg: '#22c55e', level: 'success' },
  '완료':       { bg: 'rgba(34,197,94,0.12)', fg: '#22c55e', level: 'success' },
  'RAG':        { bg: 'rgba(96,165,250,0.12)', fg: '#60a5fa', level: 'info' },
  'Slack':      { bg: 'rgba(245,158,11,0.12)', fg: '#f59e0b', level: 'query' },
  '쿼리정제':   { bg: 'rgba(167,139,250,0.12)', fg: '#a78bfa', level: 'query' },
}

function parseLine(raw: string): LogEntry | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Extract [HH:MM:SS]
  const timeMatch = trimmed.match(/^\[(\d{2}:\d{2}:\d{2})\]\s*/)
  if (!timeMatch) return null
  const time = timeMatch[1]
  let rest = trimmed.slice(timeMatch[0].length)

  // Extract elapsed, e.g. [52.8s]
  let elapsed: string | undefined
  const elapsedMatch = rest.match(/^\[(\d+\.?\d*s)\]\s*/)
  if (elapsedMatch) {
    elapsed = elapsedMatch[1]
    rest = rest.slice(elapsedMatch[0].length)
  }

  // Extract [TAG]
  const tagMatch = rest.match(/^\[([^\]]+)\]\s*/)
  let tag = ''
  let message = rest

  if (tagMatch) {
    tag = tagMatch[1]
    message = rest.slice(tagMatch[0].length)
  } else if (rest.startsWith('🟢')) {
    tag = 'system'
    message = rest
  } else if (rest.startsWith('⚠️')) {
    tag = 'warn'
    message = rest
  } else if (rest.startsWith('🔄')) {
    tag = 'reconnect'
    message = rest
  }

  // Determine level
  const style = TAG_STYLES[tag]
  let level: LogEntry['level'] = style?.level ?? 'info'
  if (message.includes('실패') || message.includes('error') || message.includes('Error')) level = 'error'
  if (tag === 'warn' || rest.startsWith('⚠️')) level = 'warn'

  return { time, elapsed, tag, message, level }
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

// ── Main component ───────────────────────────────────────────────────────────

export default function SlackLogViewer() {
  const setCenterTab = useUIStore(s => s.setCenterTab)
  const [date, setDate] = useState(() => formatDate(new Date()))
  const [lines, setLines] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<LogEntry['level'] | 'all'>('all')
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadLog = useCallback(async (d: string) => {
    setLoading(true)
    try {
      const content = await (window as any).botAPI?.readLogFile?.(d)
      setLines(content ? content.split('\n') : [])
    } catch {
      setLines([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadLog(date) }, [date, loadLog])

  // Live log stream — only append lines when viewing today
  useEffect(() => {
    const unsub = (window as any).botAPI?.onLog?.((line: string) => {
      if (date === formatDate(new Date())) {
        setLines(prev => [...prev, line])
      }
    })
    return () => unsub?.()
  }, [date])

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [lines])

  const entries = useMemo(() => {
    const parsed = lines.map(parseLine).filter(Boolean) as LogEntry[]
    if (filter === 'all') return parsed
    return parsed.filter(e => e.level === filter)
  }, [lines, filter])

  const counts = useMemo(() => {
    const all = lines.map(parseLine).filter(Boolean) as LogEntry[]
    return {
      all: all.length,
      error: all.filter(e => e.level === 'error').length,
      query: all.filter(e => e.level === 'query').length,
      success: all.filter(e => e.level === 'success').length,
    }
  }, [lines])

  const prevDay = () => setDate(formatDate(addDays(new Date(date), -1)))
  const nextDay = () => {
    const next = addDays(new Date(date), 1)
    if (next <= new Date()) setDate(formatDate(next))
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--color-bg-primary)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 16px', borderBottom: '1px solid var(--color-border)',
        background: 'var(--color-bg-surface)',
      }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>
          Slack Bot Logs
        </span>

        <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginLeft: 8 }}>
          <button onClick={prevDay} style={navBtnStyle}><ChevronLeft size={14} /></button>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)', minWidth: 90, textAlign: 'center' }}>
            {date}
          </span>
          <button onClick={nextDay} style={navBtnStyle}><ChevronRight size={14} /></button>
        </div>

        <button onClick={() => loadLog(date)} style={{ ...navBtnStyle, marginLeft: 4 }} title="Refresh">
          <RefreshCw size={12} />
        </button>

        {/* Filter buttons */}
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
          {([['all', 'All', counts.all], ['query', 'Query', counts.query], ['error', 'Error', counts.error], ['success', 'Done', counts.success]] as const).map(([key, label, count]) => (
            <button
              key={key}
              onClick={() => setFilter(key as typeof filter)}
              style={{
                padding: '2px 8px', borderRadius: 3, fontSize: 10, fontWeight: 500,
                border: `1px solid ${filter === key ? 'var(--color-accent)' : 'var(--color-border)'}`,
                background: filter === key ? 'rgba(96,165,250,0.1)' : 'transparent',
                color: filter === key ? 'var(--color-accent)' : 'var(--color-text-muted)',
                cursor: 'pointer',
              }}
            >
              {label} {count > 0 && <span style={{ opacity: 0.6 }}>{count}</span>}
            </button>
          ))}
        </div>

        <button onClick={() => setCenterTab('graph')} style={navBtnStyle} title="Close">
          <X size={14} />
        </button>
      </div>

      {/* Log body */}
      <div
        ref={scrollRef}
        style={{
          flex: 1, overflowY: 'auto', padding: '8px 0',
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 11, lineHeight: 1.7,
        }}
      >
        {loading && (
          <div style={{ padding: 16, color: 'var(--color-text-muted)', textAlign: 'center' }}>Loading...</div>
        )}
        {!loading && entries.length === 0 && (
          <div style={{ padding: 16, color: 'var(--color-text-muted)', textAlign: 'center' }}>
            No logs for {date}
          </div>
        )}
        {entries.map((entry, i) => (
          <LogRow key={i} entry={entry} />
        ))}
      </div>
    </div>
  )
}

// ── Log row component ────────────────────────────────────────────────────────

function LogRow({ entry }: { entry: LogEntry }) {
  const style = TAG_STYLES[entry.tag]
  const tagBg = style?.bg ?? 'rgba(156,163,175,0.1)'
  const tagFg = style?.fg ?? '#9ca3af'

  const levelColor = {
    error: '#ef4444',
    warn: '#eab308',
    success: '#22c55e',
    query: '#f59e0b',
    info: 'var(--color-text-muted)',
    system: '#60a5fa',
  }[entry.level]

  // Truncate long URLs/stacks in error messages
  let displayMsg = entry.message
  if (entry.level === 'error' && displayMsg.length > 200) {
    const urlMatch = displayMsg.match(/https?:\/\/\S+/)
    if (urlMatch && urlMatch[0].length > 60) {
      displayMsg = displayMsg.replace(urlMatch[0], urlMatch[0].slice(0, 60) + '…')
    }
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '56px 70px 1fr',
      gap: 6,
      padding: '1px 16px',
      alignItems: 'baseline',
      borderLeft: `2px solid ${entry.level === 'error' ? '#ef4444' : entry.level === 'warn' ? '#eab308' : 'transparent'}`,
      background: entry.level === 'error' ? 'rgba(239,68,68,0.04)' : entry.level === 'query' ? 'rgba(245,158,11,0.03)' : 'transparent',
    }}>
      {/* Time */}
      <span style={{ color: 'var(--color-text-muted)', opacity: 0.6, fontSize: 10 }}>
        {entry.time}
      </span>

      {/* Tag badge */}
      <span style={{
        display: 'inline-block',
        padding: '0 5px', borderRadius: 3,
        fontSize: 9, fontWeight: 600,
        background: tagBg, color: tagFg,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        maxWidth: 66,
      }}>
        {entry.tag || '—'}
      </span>

      {/* Message */}
      <span style={{ color: levelColor, wordBreak: 'break-word' }}>
        {entry.elapsed && (
          <span style={{ color: 'var(--color-text-muted)', opacity: 0.5, marginRight: 4, fontSize: 10 }}>
            [{entry.elapsed}]
          </span>
        )}
        {displayMsg}
      </span>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────────────────

const navBtnStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  width: 24, height: 24, borderRadius: 4, border: 'none',
  background: 'transparent', color: 'var(--color-text-muted)',
  cursor: 'pointer',
}
