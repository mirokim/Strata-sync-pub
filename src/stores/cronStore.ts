/**
 * cronStore.ts — Cron Job 상태 관리 (렌더러 측)
 *
 * main process 의 cronScheduler 와 IPC 이벤트로 동기화.
 * state-update / log-append 두 이벤트로 폴링 없이 실시간 갱신.
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
  /** 사용자가 선택한 이력 날짜(있으면 logs 대신 historyLogs 사용) */
  historyDate: string | null
  historyLogs: CronLogEntry[]
  historyLoading: boolean

  /** H9. 로그 append 폭주 방지용 rAF 배치 버퍼 (internal) */
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

// M. 런타임 가드 — 최소 필수 필드 존재 여부 확인 (zod 대체)
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
  // H9. rAF 배치 flush — append 폭주 시 re-render 1회로 모음
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
      // buffer 는 in-place 로 비워 ref 유지
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
    // M. 런타임 가드로 유효 엔트리만 통과
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
      // M. 런타임 가드로 유효 엔트리만 통과
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
