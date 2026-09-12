/**
 * CronJobTab — Cron job settings + run history/log view
 *
 * Log view: per-run grouped cards + filters (job/level/search) + history (daily JSONL) + export
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, ChevronDown, ChevronRight, Clock, Download, Filter } from 'lucide-react'
import { useCronStore } from '@/stores/cronStore'
import type { CronLogEntry } from '@/stores/cronStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { t, useT } from '@/i18n'

// ── Helpers ──────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  success: '#22c55e', running: '#eab308', error: '#ef4444', idle: '#9ca3af', disabled: '#9ca3af',
}

const JOB_LABELS: Record<string, string> = {
  'daily-run': 'Daily Run',
  'edit-agent': 'Edit Agent',
  'vault-reload': 'Vault Reload',
  'vector-rebuild': 'Vector Rebuild',
  'health-check': 'Health Check',
  'system': 'System',
}

function relativeTime(iso: string | null): string {
  if (!iso) return '-'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 0) return t('just now')
  const s = Math.floor(diff / 1000)
  if (s < 60) return t('{s}s ago', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('{m}m ago', { m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('{h}h ago', { h })
  return t('{d}d ago', { d: Math.floor(h / 24) })
}

function formatTime(iso: string | null): string {
  if (!iso) return '--:--:--'
  try { return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false }) } catch { return '--:--:--' }
}

function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '-'
  if (ms < 1000) return `${ms}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function parseCronTime(expr: string): { hour: number; minute: number } {
  const parts = (expr || '0 4 * * *').split(' ')
  return { minute: parseInt(parts[0]) || 0, hour: parseInt(parts[1]) || 4 }
}

// Group by run: entries without a runId are collected into the __floating__ group
interface RunGroup {
  runId: string
  jobId: string
  entries: CronLogEntry[]
  startEntry?: CronLogEntry
  endEntry?: CronLogEntry
  status: 'running' | 'success' | 'error' | 'warn' | 'unknown'
  errorCount: number
  firstTs: string
  lastTs: string
}

function groupByRun(entries: CronLogEntry[]): RunGroup[] {
  const map = new Map<string, RunGroup>()
  for (const e of entries) {
    const key = e.runId || `__floating__:${e.jobId}`
    let g = map.get(key)
    if (!g) {
      g = {
        runId: key,
        jobId: e.jobId,
        entries: [],
        status: 'running',
        errorCount: 0,
        firstTs: e.timestamp,
        lastTs: e.timestamp,
      }
      map.set(key, g)
    }
    g.entries.push(e)
    if (e.level === 'error') g.errorCount++
    if (e.event === 'start') g.startEntry = e
    if (e.event === 'end') {
      g.endEntry = e
      const s = (e.data as { status?: string } | undefined)?.status
      g.status = s === 'success' ? 'success' : s === 'error' ? 'error' : 'warn'
    }
    if (e.timestamp < g.firstTs) g.firstTs = e.timestamp
    if (e.timestamp > g.lastTs) g.lastTs = e.timestamp
  }
  // Running detection: no end and within the last 60s → running, otherwise unknown
  const now = Date.now()
  for (const g of map.values()) {
    if (!g.endEntry) {
      const last = new Date(g.lastTs).getTime()
      g.status = (now - last < 60_000) ? 'running' : (g.errorCount > 0 ? 'error' : 'unknown')
    }
  }
  return Array.from(map.values()).sort((a, b) => b.lastTs.localeCompare(a.lastTs))
}

const STATUS_DOT: Record<string, string> = {
  running: '#eab308', success: '#22c55e', error: '#ef4444', warn: '#f59e0b', unknown: '#9ca3af',
}

// ── Component ────────────────────────────────────────────────────────────────

export default function CronJobTab() {
  const {
    jobs, logs, runNow,
    historyDate, historyLogs, historyLoading,
    logFiles, refreshLogFiles, loadHistory,
  } = useCronStore()
  const { cronConfigs, setCronConfig } = useSettingsStore()
  const t = useT()

  const [logsOpen, setLogsOpen] = useState(false)
  const [filterJob, setFilterJob] = useState<string>('__all__')
  const [filterLevel, setFilterLevel] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [search, setSearch] = useState('')
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())

  // ── daily-run settings ──
  const dailyConfig = cronConfigs['daily-run'] ?? { enabled: true, cronExpression: '0 4 * * *' }
  const dailyJob = jobs['daily-run']
  const dailyTime = parseCronTime(dailyConfig.cronExpression || '0 4 * * *')
  const dailyStatus = dailyJob?.status ?? (dailyConfig.enabled ? 'idle' : 'disabled')
  const statusColor = STATUS_COLORS[dailyStatus] ?? '#9ca3af'

  const handleToggle = (enabled: boolean) => {
    setCronConfig('daily-run', { enabled })
    window.cronAPI?.updateConfig('daily-run', { enabled })
  }

  const handleTime = (hour: number, minute: number) => {
    const expr = `${minute} ${hour} * * *`
    setCronConfig('daily-run', { cronExpression: expr })
    window.cronAPI?.updateConfig('daily-run', { cronExpression: expr })
  }

  // ── health-check settings ──
  const hcConfig = cronConfigs['health-check'] ?? { enabled: true, intervalMinutes: 5 }
  const hcJob = jobs['health-check']
  const hcEnabled = hcJob?.enabled ?? hcConfig.enabled ?? true

  const handleHcToggle = (enabled: boolean) => {
    setCronConfig('health-check', { enabled })
    window.cronAPI?.updateConfig('health-check', { enabled })
  }

  // ── Active log source (historyLogs when a history date is selected, otherwise live logs) ──
  const activeLogs = historyDate ? historyLogs : logs

  // ── Apply filters ──
  const filtered = useMemo(() => {
    let arr = activeLogs
    if (filterJob !== '__all__') arr = arr.filter(e => e.jobId === filterJob)
    if (filterLevel !== 'all')   arr = arr.filter(e => e.level === filterLevel)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      arr = arr.filter(e =>
        e.message.toLowerCase().includes(q) ||
        e.jobId.toLowerCase().includes(q) ||
        (e.runId ?? '').toLowerCase().includes(q),
      )
    }
    return arr
  }, [activeLogs, filterJob, filterLevel, search])

  const runGroups = useMemo(() => groupByRun(filtered), [filtered])

  // Refresh the history file list when the log viewer is first opened
  useEffect(() => {
    if (logsOpen) refreshLogFiles()
  }, [logsOpen, refreshLogFiles])

  // H8. Auto-refresh the file list when the history date changes
  useEffect(() => {
    refreshLogFiles()
  }, [historyDate, refreshLogFiles])

  // H8. File sizes may change when a new run is recorded — 30s cooldown rate limit
  const lastLogFilesRefreshRef = useRef(0)
  useEffect(() => {
    const now = Date.now()
    if (now - lastLogFilesRefreshRef.current > 30_000) {
      lastLogFilesRefreshRef.current = now
      refreshLogFiles()
    }
  }, [logs.length, refreshLogFiles])

  // H7. Reset expandedRuns when switching history (prevents memory leaks)
  useEffect(() => {
    setExpandedRuns(new Set())
  }, [historyDate])

  // H7. Prune runIds not present in runGroups once over 200
  useEffect(() => {
    setExpandedRuns(prev => {
      if (prev.size <= 200) return prev
      const validIds = new Set(runGroups.map(g => g.runId))
      const next = new Set<string>()
      for (const id of prev) if (validIds.has(id)) next.add(id)
      return next.size === prev.size ? prev : next
    })
  }, [runGroups])

  // ── export ──
  const handleExport = (fmt: 'json' | 'csv') => {
    // JSON export size guard
    if (fmt === 'json' && filtered.length > 50000) {
      alert(t('Over 50000 lines — CSV recommended'))
      return
    }
    const csvEscape = (v: unknown) => {
      const s = v == null ? '' : String(v)
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    let text: string
    let mime: string
    let name: string
    if (fmt === 'json') {
      text = JSON.stringify(filtered, null, 2)
      mime = 'application/json'
      name = `cron-logs-${historyDate ?? 'live'}.json`
    } else {
      const header = 'timestamp,jobId,level,runId,event,message,durationMs,fileCount,errorCount'
      const rows = filtered.map(e => [
        csvEscape(e.timestamp), csvEscape(e.jobId), csvEscape(e.level),
        csvEscape(e.runId ?? ''), csvEscape(e.event ?? ''),
        csvEscape(e.message || ''),
        csvEscape(e.durationMs ?? ''), csvEscape(e.fileCount ?? ''), csvEscape(e.errorCount ?? ''),
      ].join(','))
      // BOM + \r\n line endings (Excel compatibility for Korean text)
      text = '\uFEFF' + header + '\r\n' + rows.join('\r\n')
      mime = 'text/csv'
      name = `cron-logs-${historyDate ?? 'live'}.csv`
    }
    const blob = new Blob([text], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = name; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const toggleRun = (runId: string) => {
    setExpandedRuns(prev => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId); else next.add(runId)
      return next
    })
  }

  const inputStyle: React.CSSProperties = {
    padding: '4px 0', background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
    borderRadius: 2, color: 'var(--color-text-primary)', fontSize: 12, fontWeight: 600,
    outline: 'none', textAlign: 'center', fontVariantNumeric: 'tabular-nums',
    MozAppearance: 'textfield',
  }
  const hideSpinnerCSS = `input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}`

  const selectStyle: React.CSSProperties = {
    padding: '3px 6px', background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
    borderRadius: 2, color: 'var(--color-text-primary)', fontSize: 11, outline: 'none',
  }

  const uniqueJobs = useMemo(() => {
    const s = new Set<string>()
    for (const e of activeLogs) s.add(e.jobId)
    return Array.from(s).sort()
  }, [activeLogs])

  // H10. Reset filterJob to all when it is no longer in the current list
  useEffect(() => {
    if (filterJob !== '__all__' && !uniqueJobs.includes(filterJob)) setFilterJob('__all__')
  }, [filterJob, uniqueJobs])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '2px 0' }}>
      <style>{hideSpinnerCSS}</style>

      {/* ── Daily run card ── */}
      <div style={{
        padding: '16px 18px', borderRadius: 3,
        background: 'var(--color-bg-surface)',
        border: `1px solid ${dailyStatus === 'running' ? 'color-mix(in srgb, var(--color-accent) 40%, transparent)' : 'var(--color-border)'}`,
        display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Clock size={15} style={{ color: 'var(--color-accent)', flexShrink: 0 }} />
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-primary)' }}>
              {t('Daily Auto Run')}
            </span>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 36, height: 20, flexShrink: 0 }}>
            <input type="checkbox" checked={dailyConfig.enabled} onChange={e => handleToggle(e.target.checked)}
              style={{ opacity: 0, width: 0, height: 0 }} />
            <span style={{
              position: 'absolute', cursor: 'pointer', inset: 0,
              background: dailyConfig.enabled ? 'var(--color-info)' : 'var(--color-bg-disabled)',
              borderRadius: 10, transition: 'background 0.2s',
            }} />
            <span style={{
              position: 'absolute', height: 14, width: 14,
              left: dailyConfig.enabled ? 19 : 3, bottom: 3,
              background: 'white', borderRadius: '50%', transition: 'left 0.2s',
            }} />
          </label>
        </div>

        <div style={{ fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
          {t('Edit Agent cycle (Confluence/Jira sync → document refinement → quality check) · then vault reload + automatic vector embedding rebuild')}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-muted)' }}>
            <span>{t('Every day at')}</span>
            <input type="number" min={0} max={23} value={dailyTime.hour}
              onChange={e => handleTime(Math.min(23, Math.max(0, Number(e.target.value) || 0)), dailyTime.minute)}
              style={{ ...inputStyle, width: 34 }} />
            <span style={{ fontWeight: 600 }}>:</span>
            <input type="number" min={0} max={59} step={5}
              value={String(dailyTime.minute).padStart(2, '0')}
              onChange={e => handleTime(dailyTime.hour, Math.min(59, Math.max(0, Number(e.target.value) || 0)))}
              style={{ ...inputStyle, width: 34 }} />
            <span style={{ fontSize: 10 }}>KST</span>
          </div>
          <button onClick={() => runNow('daily-run')} disabled={dailyStatus === 'running'}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '5px 12px', borderRadius: 2,
              fontSize: 11, fontWeight: 500, border: 'none',
              cursor: dailyStatus === 'running' ? 'not-allowed' : 'pointer',
              background: dailyStatus === 'running' ? 'var(--color-bg-subtle)' : 'var(--color-accent)',
              color: dailyStatus === 'running' ? 'var(--color-text-muted)' : '#fff',
              opacity: dailyStatus === 'running' ? 0.5 : 1, whiteSpace: 'nowrap',
            }}>
            <Play size={10} /> {t('Run Now')}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--color-text-muted)', borderTop: '1px solid var(--color-border)', paddingTop: 10 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
          <span>{dailyStatus === 'running' ? t('Running...') : dailyStatus === 'success' ? t('OK') : dailyStatus === 'error' ? t('Error') : t('Idle')}</span>
          <span style={{ opacity: 0.6 }}>·</span>
          <span>{t('Last run {time}', { time: relativeTime(dailyJob?.lastRunAt ?? null) })}</span>
          {dailyJob?.lastResult && (
            <span style={{ color: dailyStatus === 'error' ? 'var(--color-error)' : undefined, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={dailyJob.lastResult}>
              — {dailyJob.lastResult}
            </span>
          )}
        </div>
      </div>

      {/* ── Health check card ── */}
      <div style={{
        padding: '12px 18px', borderRadius: 3, background: 'var(--color-bg-surface)',
        border: '1px solid var(--color-border)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: STATUS_COLORS[hcJob?.status ?? 'idle'],
        }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
            {t('System Health Check')}
          </span>
          <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 8 }}>
            {t('Every 5 min · checks bot process + memory')}
          </span>
        </div>
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)', flexShrink: 0 }}>
          {relativeTime(hcJob?.lastRunAt ?? null)}
        </span>
        <label style={{ position: 'relative', display: 'inline-block', width: 36, height: 20, flexShrink: 0 }}>
          <input type="checkbox" checked={hcEnabled} onChange={e => handleHcToggle(e.target.checked)}
            style={{ opacity: 0, width: 0, height: 0 }} />
          <span style={{
            position: 'absolute', cursor: 'pointer', inset: 0,
            background: hcEnabled ? 'var(--color-info)' : 'var(--color-bg-disabled)',
            borderRadius: 10, transition: 'background 0.2s',
          }} />
          <span style={{
            position: 'absolute', height: 14, width: 14,
            left: hcEnabled ? 19 : 3, bottom: 3,
            background: 'white', borderRadius: '50%', transition: 'left 0.2s',
          }} />
        </label>
      </div>

      {/* ── Log toggle ── */}
      <button onClick={() => setLogsOpen(v => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
          color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 0',
        }}>
        {logsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t('Run Logs')} {runGroups.length > 0 && t('· {runs} runs / {lines} lines', { runs: runGroups.length, lines: filtered.length })}
      </button>

      {logsOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* ── Filter bar ── */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
            padding: '8px 10px', background: 'var(--color-bg-surface)',
            border: '1px solid var(--color-border)', borderRadius: 2,
          }}>
            <Filter size={12} style={{ color: 'var(--color-text-muted)' }} />
            <select value={filterJob} onChange={e => setFilterJob(e.target.value)} style={selectStyle}>
              <option value="__all__">{t('All jobs')}</option>
              {uniqueJobs.map(j => <option key={j} value={j}>{t(JOB_LABELS[j] ?? j)}</option>)}
            </select>
            <select value={filterLevel} onChange={e => setFilterLevel(e.target.value as 'all' | 'info' | 'warn' | 'error')} style={selectStyle}>
              <option value="all">{t('All levels')}</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </select>
            <input type="text" placeholder={t('Search (message / runId)')} value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...selectStyle, flex: 1, minWidth: 120, textAlign: 'left' }} />

            {/* History date picker */}
            <select value={historyDate ?? ''} onChange={e => loadHistory(e.target.value || null)} style={selectStyle}>
              <option value="">{t('Live')}</option>
              {logFiles.map(f => <option key={f.date} value={f.date}>{f.date}</option>)}
            </select>
            {historyLoading && <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{t('Loading...')}</span>}

            {/* export */}
            <button onClick={() => handleExport('json')} title={t('Export {format}', { format: 'JSON' })}
              style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '3px 8px', fontSize: 10,
                background: 'var(--color-bg-base)', border: '1px solid var(--color-border)', borderRadius: 2,
                color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
              <Download size={10} /> JSON
            </button>
            <button onClick={() => handleExport('csv')} title={t('Export {format}', { format: 'CSV' })}
              style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '3px 8px', fontSize: 10,
                background: 'var(--color-bg-base)', border: '1px solid var(--color-border)', borderRadius: 2,
                color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
              <Download size={10} /> CSV
            </button>
          </div>

          {/* ── Run group list ── */}
          <div style={{
            maxHeight: 420, overflowY: 'auto', background: 'var(--color-bg-base)',
            border: '1px solid var(--color-border)', borderRadius: 2, padding: '4px',
          }}>
            {runGroups.length === 0
              ? <div style={{ padding: 12, textAlign: 'center', fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {t('No logs.')}
                </div>
              : runGroups.map(g => {
                const expanded = expandedRuns.has(g.runId)
                const duration = g.endEntry?.durationMs
                const tokens = g.endEntry?.tokens ?? (g.entries.reduce((a, e) => a + (e.tokens ?? 0), 0) || null)
                const fileCount = g.endEntry?.fileCount
                const isFloating = g.runId.startsWith('__floating__:')
                return (
                  <div key={g.runId} style={{
                    marginBottom: 4, borderRadius: 2,
                    border: '1px solid var(--color-border)', background: 'var(--color-bg-surface)',
                  }}>
                    <div onClick={() => toggleRun(g.runId)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 10px', cursor: 'pointer',
                        fontSize: 11,
                      }}>
                      {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      <div style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: STATUS_DOT[g.status], flexShrink: 0,
                      }} />
                      <span style={{ fontWeight: 600, minWidth: 90 }}>{t(JOB_LABELS[g.jobId] ?? g.jobId)}</span>
                      <span style={{ color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                        {formatTime(g.firstTs)}
                      </span>
                      {!isFloating && (
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          → {formatTime(g.lastTs)}
                        </span>
                      )}
                      {duration != null && (
                        <span style={{ color: 'var(--color-text-muted)' }}>· {formatDuration(duration)}</span>
                      )}
                      {typeof fileCount === 'number' && fileCount > 0 && (
                        <span style={{ color: 'var(--color-text-muted)' }}>· {t('{count} files', { count: fileCount })}</span>
                      )}
                      {tokens != null && tokens > 0 && (
                        <span style={{ color: 'var(--color-text-muted)' }}>· {tokens.toLocaleString()} tok</span>
                      )}
                      {g.errorCount > 0 && (
                        <span style={{ color: 'var(--color-error)' }}>· {t('{count} errors', { count: g.errorCount })}</span>
                      )}
                      <span style={{ flex: 1 }} />
                      <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}>
                        {t('{count} lines', { count: g.entries.length })}
                      </span>
                    </div>
                    {expanded && (
                      <div style={{
                        borderTop: '1px solid var(--color-border)',
                        padding: '6px 10px',
                        fontFamily: 'monospace', fontSize: 11, lineHeight: 1.6,
                        color: 'var(--color-text-secondary)',
                      }}>
                        {g.entries.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp)).map((e, i) => (
                          <div key={e.id ?? i} style={{
                            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                            color: e.level === 'error' ? 'var(--color-error)' : e.level === 'warn' ? 'var(--color-warning)' : undefined,
                          }}>
                            <span style={{ opacity: 0.5 }}>{formatTime(e.timestamp)}</span>{' '}
                            {e.event && e.event !== 'info' && (
                              <span style={{ opacity: 0.7, marginRight: 4 }}>[{e.event}]</span>
                            )}
                            {e.message}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            }
          </div>
        </div>
      )}
    </div>
  )
}
