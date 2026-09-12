/**
 * cronScheduler.cjs — 크론 스케줄러 (run 단위 그루핑 + JSONL 영속화)
 *
 * 핵심: 매일 지정 시각(KST)에 Edit Agent 사이클을 트리거
 * Edit Agent가 내부에서 confluence/jira sync + 정제 + 품질 체크를 수행.
 * 완료 후 vault-reload → vector-rebuild 자동 체인.
 *
 * 로그: 메모리 링버퍼(최대 2000) + 일별 JSONL 파일(..../bot/cron-logs/YYYY-MM-DD.jsonl)
 * 각 엔트리는 runId 를 가지므로 UI 에서 실행 단위로 그루핑 가능.
 */

const { ipcMain, BrowserWindow } = require('electron')
const cron = require('node-cron')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// ─── 상수 ────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 2000

const JOB_TIMEOUT = {
  'edit-agent':      3_600_000, // 60분
  'vault-reload':    600_000,   // 10분
  'vector-rebuild':  1_200_000, // 20분
}
const DEFAULT_TIMEOUT = 300_000

const JOB_IDS = ['daily-run', 'edit-agent', 'vault-reload', 'vector-rebuild', 'health-check']

const LOG_DIR = path.join(__dirname, '..', 'bot', 'cron-logs')

// ─── 기본 설정 ───────────────────────────────────────────

const DEFAULT_CONFIGS = {
  'daily-run': {
    id: 'daily-run', enabled: true, cronExpression: '0 4 * * *',
    timezone: 'Asia/Seoul', schedulable: true,
  },
  'health-check': {
    id: 'health-check', enabled: true, cronExpression: '*/5 * * * *',
    intervalMinutes: 5, schedulable: true,
  },
  'edit-agent':      { id: 'edit-agent',      schedulable: false },
  'vault-reload':    { id: 'vault-reload',    schedulable: false },
  'vector-rebuild':  { id: 'vector-rebuild',  schedulable: false },
}

// ─── 모듈 상태 ───────────────────────────────────────────

let _configs = {}
let _states = {}
const _tasks = {}
const _mutex = {}
const _logs = []
/** 현재 실행 중인 run 메타 (jobId → { runId, startedAt, parentRunId? }) */
const _activeRuns = {}
/** 완료된 run 요약 메모리 캐시 (UI 초기 표시용, 최근 100개) */
const _runIndex = []
const MAX_RUN_INDEX = 100
let _getSlackBotProcess = null
let _logStream = null
let _logStreamDate = null
// H2+H3: 로그 스트림 안정화 — 로테이션 중복 방지, 에러 플래그, 셧다운 가드
let _logStreamRotating = null   // Promise | null — 로테이션 진행 중이면 await
let _logStreamError = null      // string | null — 최근 스트림 에러 메시지
let _shuttingDown = false       // 종료 중이면 addLog no-op

// H4: 렌더러 → main 결과 응답용 ipc 핸들러 레퍼런스 (requestId → fn)
const _ipcResultHandlers = new Map()

// ─── 로그/영속화 ─────────────────────────────────────────

function _todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 일일 JSONL 로그 스트림 반환.
 * H2+H3: 원자적 로테이션 — 새 스트림 생성 후 참조 교체, 구 스트림은 백그라운드 end().
 * 동시 호출 시 로테이션 Promise 를 공유하여 중복 생성 방지.
 * C4: 스트림 error 이벤트를 구독하여 _logStreamError 플래그와 브로드캐스트 수행.
 */
function _getLogStream() {
  const today = _todayIso()
  if (_logStream && _logStreamDate === today) return _logStream

  // 이미 로테이션 중이면 동기 반환값은 구 스트림 (있으면) — 호출부의 try/catch 에서 흡수
  if (_logStreamRotating) return _logStream

  _logStreamRotating = (async () => {
    try {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
      const nextStream = fs.createWriteStream(
        path.join(LOG_DIR, `${today}.jsonl`),
        { flags: 'a', encoding: 'utf8' }
      )
      // C4: 스트림 에러 핸들러 등록 — 실패 시 플래그와 state 브로드캐스트
      nextStream.on('error', (err) => {
        _logStreamError = err?.message || String(err)
        try { broadcastState() } catch { /* noop */ }
      })
      const prev = _logStream
      _logStream = nextStream
      _logStreamDate = today
      _logStreamError = null
      // 구 스트림은 백그라운드에서 닫기
      if (prev) { try { prev.end() } catch { /* noop */ } }
    } catch (err) {
      _logStreamError = err?.message || String(err)
      _logStream = null
    } finally {
      _logStreamRotating = null
    }
  })()

  return _logStream
}

/**
 * 구조화 로그 1건 기록.
 *   extra: { runId?, event?, durationMs?, tokens?, fileCount?, errorCount?, detail?, data? }
 *   event: 'start' | 'step-start' | 'step-end' | 'end' | 'info' (생략 시 'info')
 */
function addLog(jobId, level, message, extra = {}) {
  // H3: 셧다운 후에는 더 이상 기록/브로드캐스트 하지 않음 (열린 스트림/창에 대한 레이스 방지)
  if (_shuttingDown) return null
  const runId = extra.runId ?? _activeRuns[jobId]?.runId ?? null
  const entry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    jobId,
    level,
    message,
    runId,
    event: extra.event || 'info',
    durationMs: extra.durationMs,
    tokens: extra.tokens,
    fileCount: extra.fileCount,
    errorCount: extra.errorCount,
    data: extra.data,
  }
  _logs.push(entry)
  while (_logs.length > MAX_LOG_ENTRIES) _logs.shift()

  // JSONL 영속화 (실패해도 조용히 무시)
  try {
    const s = _getLogStream()
    if (s) s.write(JSON.stringify(entry) + '\n')
  } catch { /* ignore */ }

  broadcast('cron:log-append', entry)
  return entry
}

/** 새 run 시작. jobId 의 activeRun 을 설정하고 로그 헤더를 기록. */
function startRun(jobId, meta = {}) {
  const runId = `${jobId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  _activeRuns[jobId] = {
    runId,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    parentRunId: meta.parentRunId ?? null,
    trigger: meta.trigger ?? 'manual', // 'schedule' | 'manual' | 'chain'
  }
  addLog(jobId, 'info', meta.headerMessage || `=== ${jobId} 실행 시작 ===`, {
    runId,
    event: 'start',
    data: { parentRunId: meta.parentRunId ?? null, trigger: meta.trigger ?? 'manual' },
  })
  return runId
}

/** run 종료. 상태/집계 필드를 총괄 로그로 남긴다. */
function endRun(jobId, status, summary = {}) {
  const run = _activeRuns[jobId]
  if (!run) return
  const durationMs = Date.now() - run.startedMs
  const level = status === 'success' ? 'info' : status === 'error' ? 'error' : 'warn'
  addLog(jobId, level, summary.message || `=== ${jobId} ${status} (${Math.round(durationMs / 1000)}초) ===`, {
    runId: run.runId,
    event: 'end',
    durationMs,
    tokens: summary.tokens,
    fileCount: summary.fileCount,
    errorCount: summary.errorCount,
    data: { status, ...(summary.data || {}) },
  })
  _runIndex.unshift({
    runId: run.runId,
    jobId,
    startedAt: run.startedAt,
    endedAt: new Date().toISOString(),
    durationMs,
    status,
    parentRunId: run.parentRunId,
    trigger: run.trigger,
    tokens: summary.tokens,
    fileCount: summary.fileCount,
    errorCount: summary.errorCount,
  })
  while (_runIndex.length > MAX_RUN_INDEX) _runIndex.pop()
  delete _activeRuns[jobId]
}

// ─── 유틸 ────────────────────────────────────────────────

function broadcast(channel, data) {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && win.webContents) win.webContents.send(channel, data)
    }
  } catch { /* noop */ }
}

function broadcastState() {
  broadcast('cron:state-update', getFullState())
}

function createInitialState() {
  return { status: 'idle', lastRunAt: null, lastResult: null, runCount: 0, errorCount: 0 }
}

// ─── 렌더러 호출 ─────────────────────────────────────────

function invokeRenderer(jobId, runId) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const channel = `cron:execute-${jobId}`
    const resultChannel = `cron:result:${requestId}`
    const timeoutMs = JOB_TIMEOUT[jobId] || DEFAULT_TIMEOUT

    addLog(jobId, 'info', `렌더러 호출 (timeout: ${Math.round(timeoutMs / 60000)}분)`, { runId, event: 'step-start' })

    // H4: removeAllListeners 대신 등록한 핸들러 레퍼런스를 removeListener 로 제거.
    // ipcMain.once 는 내부 래퍼를 만들어 직접 제거가 어려우므로, 명시적 .on + removeListener 로 전환.
    const handler = (_event, result) => {
      clearTimeout(timer)
      ipcMain.removeListener(resultChannel, handler)
      _ipcResultHandlers.delete(requestId)
      if (result && result.error) reject(new Error(result.error))
      else resolve(result)
    }
    _ipcResultHandlers.set(requestId, handler)
    ipcMain.on(resultChannel, handler)

    const timer = setTimeout(() => {
      ipcMain.removeListener(resultChannel, handler)
      _ipcResultHandlers.delete(requestId)
      reject(new Error(`타임아웃 ${Math.round(timeoutMs / 60000)}분 초과`))
    }, timeoutMs)

    // runId 를 렌더러에 전달 → editAgentRunner 등에서 자기 로그에 연결 가능
    broadcast(channel, { requestId, runId })
  })
}

// ─── 헬스체크 ────────────────────────────────────────────

function executeHealthCheck() {
  const runId = startRun('health-check', { trigger: 'schedule', headerMessage: '헬스체크' })
  try {
    const proc = _getSlackBotProcess ? _getSlackBotProcess() : null
    const botAlive = proc !== null
    const mem = process.memoryUsage()
    const rssMb = Math.round(mem.rss / 1024 / 1024)
    addLog('health-check', 'info', `RSS: ${rssMb}MB | Bot: ${botAlive ? '정상' : '중지'}`, {
      runId, data: { rssMb, botAlive },
    })
    if (!botAlive) addLog('health-check', 'warn', 'Slack 봇 중지됨', { runId })
    endRun('health-check', 'success', { data: { rssMb, botAlive } })
  } catch (err) {
    addLog('health-check', 'error', `헬스체크 예외: ${err.message}`, { runId })
    endRun('health-check', 'error', { errorCount: 1 })
  }
}

// ─── 일일 실행 (Edit Agent → vault-reload → vector-rebuild) ─

async function runDaily(trigger = 'manual') {
  if (_mutex['daily-run']) {
    addLog('daily-run', 'warn', '이미 실행 중')
    return
  }
  _mutex['daily-run'] = true
  const state = _states['daily-run']
  state.status = 'running'
  state.lastRunAt = new Date().toISOString()
  broadcastState()

  const parentRunId = startRun('daily-run', { trigger, headerMessage: '=== 일일 실행 시작 ===' })

  const results = []
  let totalErrors = 0

  const runStep = async (stepId) => {
    // H1: child step 도 mutex 를 획득. 이미 독립 실행 중(수동 run-now 등) 이면 skip.
    if (_mutex[stepId]) {
      addLog(stepId, 'warn', 'busy-skip: 이미 실행 중이라 daily-run 체인에서 스킵', { runId: parentRunId })
      results.push(`${stepId}: ⏭ busy-skip`)
      return
    }
    _mutex[stepId] = true
    addLog('daily-run', 'info', `▶ ${stepId} 시작`, { runId: parentRunId, event: 'step-start' })
    const childRunId = startRun(stepId, { trigger: 'chain', parentRunId, headerMessage: `=== ${stepId} 시작 ===` })
    const stepStart = Date.now()
    try {
      await invokeRenderer(stepId, childRunId)
      const sec = Math.round((Date.now() - stepStart) / 1000)
      results.push(`${stepId}: ✓ (${sec}s)`)
      addLog('daily-run', 'info', `✓ ${stepId} 완료 (${sec}초)`, {
        runId: parentRunId, event: 'step-end', durationMs: Date.now() - stepStart,
      })
      endRun(stepId, 'success')
    } catch (err) {
      totalErrors++
      results.push(`${stepId}: ✗ ${err.message}`)
      addLog('daily-run', 'error', `✗ ${stepId} 실패: ${err.message}`, { runId: parentRunId, event: 'step-end' })
      endRun(stepId, 'error', { errorCount: 1, data: { error: err.message } })
    } finally {
      _mutex[stepId] = false
    }
  }

  await runStep('edit-agent')
  await runStep('vault-reload')
  await runStep('vector-rebuild')

  const allOk = totalErrors === 0
  state.status = allOk ? 'success' : 'error'
  state.runCount += 1
  if (!allOk) state.errorCount += 1
  state.lastResult = results.join(' | ')
  _mutex['daily-run'] = false

  endRun('daily-run', allOk ? 'success' : 'error', {
    message: `=== 일일 실행 ${allOk ? '완료' : '일부 실패'}: ${results.join(', ')} ===`,
    errorCount: totalErrors,
  })
  broadcastState()
}

// ─── 단일 잡 실행 ────────────────────────────────────────

async function executeJob(jobId, trigger = 'manual') {
  if (jobId === 'daily-run') return runDaily(trigger)
  if (jobId === 'health-check') {
    executeHealthCheck()
    const s = _states['health-check']
    if (s) { s.status = 'success'; s.lastRunAt = new Date().toISOString(); s.runCount += 1 }
    broadcastState()
    return
  }

  if (_mutex[jobId]) return
  _mutex[jobId] = true
  const s = _states[jobId]
  if (s) { s.status = 'running'; s.lastRunAt = new Date().toISOString() }
  broadcastState()

  const runId = startRun(jobId, { trigger, headerMessage: `=== ${jobId} 시작 ===` })
  try {
    await invokeRenderer(jobId, runId)
    if (s) { s.status = 'success'; s.runCount += 1; s.lastResult = 'OK' }
    endRun(jobId, 'success')
  } catch (err) {
    if (s) { s.status = 'error'; s.errorCount += 1; s.lastResult = err.message }
    addLog(jobId, 'error', `실패: ${err.message}`, { runId })
    endRun(jobId, 'error', { errorCount: 1, data: { error: err.message } })
  } finally {
    _mutex[jobId] = false
    broadcastState()
  }
}

// ─── 스케줄 등록 ─────────────────────────────────────────

function scheduleJob(jobId) {
  if (_tasks[jobId]) { _tasks[jobId].stop(); _tasks[jobId] = null }

  const config = _configs[jobId]
  if (!config?.schedulable || !config?.enabled || !config?.cronExpression) return

  const expr = config.cronExpression
  if (!cron.validate(expr)) {
    addLog(jobId, 'error', `잘못된 cron: "${expr}"`)
    return
  }

  const options = config.timezone ? { timezone: config.timezone } : {}
  const handler = jobId === 'daily-run'
    ? () => runDaily('schedule').catch(e => addLog(jobId, 'error', e.message))
    : () => executeJob(jobId, 'schedule').catch(e => addLog(jobId, 'error', e.message))

  _tasks[jobId] = cron.schedule(expr, handler, options)
  addLog(jobId, 'info', `cron 등록: "${expr}"${config.timezone ? ` (${config.timezone})` : ''}`)
}

// ─── 이력 파일 조회 ──────────────────────────────────────

function listLogFiles() {
  try {
    if (!fs.existsSync(LOG_DIR)) return []
    return fs.readdirSync(LOG_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => ({
        date: f.replace(/\.jsonl$/, ''),
        path: path.join(LOG_DIR, f),
        size: (() => { try { return fs.statSync(path.join(LOG_DIR, f)).size } catch { return 0 } })(),
      }))
      .sort((a, b) => b.date.localeCompare(a.date))
  } catch { return [] }
}

function loadLogFile(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  const file = path.join(LOG_DIR, `${date}.jsonl`)
  try {
    // C3: 심볼릭링크를 통한 LOG_DIR 이탈 방지 — realpath 가 LOG_DIR 하위인지 확인
    const realDir = fs.realpathSync(LOG_DIR)
    const realFile = fs.realpathSync(file)
    const rel = path.relative(realDir, realFile)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return []

    const text = fs.readFileSync(realFile, 'utf-8')
    const entries = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { entries.push(JSON.parse(line)) } catch { /* 손상 라인 스킵 */ }
    }
    return entries
  } catch { return [] }
}

// ─── 공개 API ────────────────────────────────────────────

function initCronScheduler(configs, getSlackBotProcess) {
  _getSlackBotProcess = getSlackBotProcess || null

  for (const jobId of JOB_IDS) {
    _configs[jobId] = { ...DEFAULT_CONFIGS[jobId], ...(configs?.[jobId] ?? {}), id: jobId }
    _states[jobId] = createInitialState()
    _mutex[jobId] = false
    _tasks[jobId] = null
  }

  for (const jobId of JOB_IDS) scheduleJob(jobId)
  addLog('system', 'info', '크론 스케줄러 초기화 완료')
  broadcastState()
}

function updateJobConfig(jobId, patch) {
  if (!_configs[jobId]) return
  Object.assign(_configs[jobId], patch)
  _configs[jobId].id = jobId
  addLog(jobId, 'info', `설정 변경: ${JSON.stringify(patch)}`)
  scheduleJob(jobId)
  broadcastState()
}

function getFullState() {
  const jobs = {}
  for (const jobId of JOB_IDS) {
    jobs[jobId] = { ...(_configs[jobId] || {}), ...(_states[jobId] || {}) }
  }
  // C4: 로그 스트림 에러 플래그를 UI 쪽으로 노출
  return {
    jobs,
    logs: _logs.slice(-200),
    runs: _runIndex.slice(0, 30),
    logStreamError: _logStreamError,
  }
}

function getLogs() { return [..._logs] }
function getRuns() { return [..._runIndex] }

function shutdown() {
  for (const jobId of JOB_IDS) { if (_tasks[jobId]) { _tasks[jobId].stop(); _tasks[jobId] = null } }
  addLog('system', 'info', '크론 스케줄러 종료')
  // H3: 셧다운 플래그를 올린 후에는 addLog no-op
  _shuttingDown = true
  // H4: 대기 중인 ipc 결과 핸들러 모두 제거
  for (const [requestId, handler] of _ipcResultHandlers) {
    try { ipcMain.removeListener(`cron:result:${requestId}`, handler) } catch { /* noop */ }
  }
  _ipcResultHandlers.clear()
  try { if (_logStream) _logStream.end() } catch { /* noop */ }
}

module.exports = {
  initCronScheduler, executeJob, updateJobConfig,
  getFullState, getLogs, getRuns,
  listLogFiles, loadLogFile,
  shutdown,
  // 렌더러가 run 요약/세부 로그를 main 에 주입할 수 있도록 (editAgentRunner 용)
  addLog,
}
