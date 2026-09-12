/**
 * cronStore.ts — Cron job state management (renderer side)
 *
 * Synced with the main-process cronScheduler via IPC events.
 * Two events (state-update / log-append) give real-time updates without polling.
 */
import { create } from 'zustand'

export type CronJobId =
  | 'daily-run' | 'edit-agent' | 'vault-reload' | 'vector-rebuild'
  | 'health-check' | 'confluence-sync' | 'jira-sync'
export type CronJobStatus = 'idle' | 'running' | 'success' | 'error' | 'disabled'

export interface CronJobConfig {
  id: CronJobId
  enabled: boolean
  cronExpression: string
  intervalMinutes: number
  schedulable: boolean
}

export interface CronJobState {
  status: CronJobStatus
  lastRunAt: string | null
  lastResult: string | null
  nextRunAt: string | null
  runCount: number
  errorCount: number
}

export interface CronLogEntry {
  id: string
  jobId: string
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
  runId?: string | null
  event?: 'info' | 'start' | 'step-start' | 'step-end' | 'end'
  durationMs?: number
  tokens?: number
  fileCount?: number
  errorCount?: number
  data?: Record<string, unknown>
}

export interface CronRunSummary {
  runId: string
  jobId: string
  startedAt: string
  endedAt: string
  durationMs: number
  status: 'success' | 'error' | 'warn'
  parentRunId?: string | null
  trigger?: 'manual' | 'schedule' | 'chain'
  tokens?: number
  fileCount?: number
  errorCount?: number
}

export interface CronLogFileMeta {
  date: string
  path: string
  size: number
}

export type CronJob = CronJobConfig & CronJobState

interface CronStoreState {
  jobs: Record<string, CronJob>
  logs: CronLogEntry[]
  runs: CronRunSummary[]
  initialized: boolean

  logFiles: CronLogFileMeta[]
  /** History date selected by the user (when set, historyLogs is used instead of logs) */
  historyDate: string | null
  historyLogs: CronLogEntry[]
  historyLoading: boolean

  /** H9. rAF batch buffer to guard against log-append floods (internal) */
  _pendingAppends: CronLogEntry[]
  _flushTimer: number | null

  setJobs: (jobs: Record<string, CronJob>) => void
  updateJob: (jobId: string, patch: Partial<CronJob>) => void
  setLogs: (logs: CronLogEntry[]) => void
  appendLog: (entry: CronLogEntry) => void
  setRuns: (runs: CronRunSummary[]) => void
  setInitialized: (v: boolean) => void

  fetchState: () => Promise<void>
  refreshLogFiles: () => Promise<void>
  loadHistory: (date: string | null) => Promise<void>
  toggleJob: (jobId: string, enabled: boolean) => Promise<void>
  setInterval: (jobId: string, minutes: number) => Promise<void>
  runNow: (jobId: string) => Promise<void>
}

const MAX_LIVE_LOGS = 2000

// M. Runtime guard — checks that the minimum required fields exist (zod substitute)
function isValidLogEntry(e: unknown): e is CronLogEntry {
  if (!e || typeof e !== 'object') return false
  const o = e as Record<string, unknown>
  return typeof o.timestamp === 'string' && typeof o.jobId === 'string'
      && typeof o.level === 'string' && typeof o.message === 'string'
}

export const useCronStore = create<CronStoreState>()((set, get) => ({
  jobs: {},
  logs: [],
  runs: [],
  initialized: false,
  logFiles: [],
  historyDate: null,
  historyLogs: [],
  historyLoading: false,
  _pendingAppends: [],
  _flushTimer: null,

  setJobs: (jobs) => set({ jobs }),
  updateJob: (jobId, patch) => set(s => ({
    jobs: { ...s.jobs, [jobId]: { ...s.jobs[jobId], ...patch } },
  })),
  setLogs: (logs) => set({ logs }),
  // H9. rAF batch flush — collapses an append flood into a single re-render
  appendLog: (entry) => {
    if (!isValidLogEntry(entry)) return
    const s = get()
    s._pendingAppends.push(entry)
    if (s._flushTimer != null) return
    const flush = () => {
      const st = get()
      const pending = st._pendingAppends
      if (pending.length === 0) {
        set({ _flushTimer: null })
        return
      }
      const next = st.logs.concat(pending)
      if (next.length > MAX_LIVE_LOGS) next.splice(0, next.length - MAX_LIVE_LOGS)
      // Clear the buffer in place to keep the ref
      pending.length = 0
      set({ logs: next, _flushTimer: null })
    }
    const timer = (typeof requestAnimationFrame !== 'undefined')
      ? requestAnimationFrame(flush)
      : (setTimeout(flush, 50) as unknown as number)
    set({ _flushTimer: timer })
  },
  setRuns: (runs) => set({ runs }),
  setInitialized: (v) => set({ initialized: v }),

  fetchState: async () => {
    if (!window.cronAPI) return
    const raw = await window.cronAPI.getState()
    const state = raw as unknown as {
      jobs: Record<string, CronJob>
      logs: unknown[]
      runs?: CronRunSummary[]
    }
    // M. Only valid entries pass the runtime guard
    const validLogs = (state.logs || []).filter(isValidLogEntry)
    set({
      jobs: state.jobs,
      logs: validLogs,
      runs: state.runs || [],
      initialized: true,
    })
  },

  refreshLogFiles: async () => {
    if (!window.cronAPI?.listLogFiles) return
    try {
      const files = await window.cronAPI.listLogFiles()
      set({ logFiles: (files || []) as unknown as CronLogFileMeta[] })
    } catch { /* noop */ }
  },

  loadHistory: async (date) => {
    if (!date) {
      set({ historyDate: null, historyLogs: [], historyLoading: false })
      return
    }
    if (!window.cronAPI?.loadLogFile) return
    set({ historyDate: date, historyLoading: true })
    try {
      const entries = await window.cronAPI.loadLogFile(date)
      // M. Only valid entries pass the runtime guard
      const validLogs = ((entries || []) as unknown[]).filter(isValidLogEntry)
      set({ historyLogs: validLogs, historyLoading: false })
    } catch {
      set({ historyLogs: [], historyLoading: false })
    }
  },

  toggleJob: async (jobId, enabled) => {
    if (!window.cronAPI) return
    await window.cronAPI.updateConfig(jobId, { enabled })
    get().updateJob(jobId, { enabled } as Partial<CronJob>)
  },

  setInterval: async (jobId, minutes) => {
    if (!window.cronAPI) return
    await window.cronAPI.updateConfig(jobId, { intervalMinutes: minutes })
    get().updateJob(jobId, { intervalMinutes: minutes } as Partial<CronJob>)
  },

  runNow: async (jobId) => {
    if (!window.cronAPI) return
    await window.cronAPI.runNow(jobId)
  },
}))
