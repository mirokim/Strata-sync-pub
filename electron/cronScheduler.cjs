/**
 * cronScheduler.cjs — cron scheduler (per-run grouping + JSONL persistence)
 *
 * Core: triggers the Edit Agent cycle daily at the configured time (KST)
 * The Edit Agent internally performs confluence/jira sync + refinement + quality checks.
 * After completion, auto-chains vault-reload → vector-rebuild.
 *
 * Logs: in-memory ring buffer (max 2000) + daily JSONL file (..../bot/cron-logs/YYYY-MM-DD.jsonl)
 * Every entry carries a runId, so the UI can group entries per run.
 */

const { ipcMain, BrowserWindow } = require('electron')
const cron = require('node-cron')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// ─── Constants ───────────────────────────────────────────

const MAX_LOG_ENTRIES = 2000

const JOB_TIMEOUT = {
  'edit-agent':      3_600_000, // 60 min
  'vault-reload':    600_000,   // 10 min
  'vector-rebuild':  1_200_000, // 20 min
}
const DEFAULT_TIMEOUT = 300_000

const JOB_IDS = ['daily-run', 'edit-agent', 'vault-reload', 'vector-rebuild', 'health-check']

const LOG_DIR = path.join(__dirname, '..', 'bot', 'cron-logs')

// ─── Default config ──────────────────────────────────────

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

// ─── Module state ────────────────────────────────────────

let _configs = {}
let _states = {}
const _tasks = {}
const _mutex = {}
const _logs = []
/** Metadata of currently running runs (jobId → { runId, startedAt, parentRunId? }) */
const _activeRuns = {}
/** In-memory cache of completed run summaries (for initial UI display, last 100) */
const _runIndex = []
const MAX_RUN_INDEX = 100
let _getSlackBotProcess = null
let _logStream = null
let _logStreamDate = null
// H2+H3: log stream hardening — prevent duplicate rotation, error flag, shutdown guard
let _logStreamRotating = null   // Promise | null — await while a rotation is in progress
let _logStreamError = null      // string | null — most recent stream error message
let _shuttingDown = false       // addLog is a no-op while shutting down

// H4: references to ipc handlers for renderer → main result replies (requestId → fn)
const _ipcResultHandlers = new Map()

// ─── Logging / persistence ───────────────────────────────

function _todayIso() {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Return the daily JSONL log stream.
 * H2+H3: atomic rotation — create the new stream, swap the reference, end() the old stream in the background.
 * Concurrent callers share the rotation Promise to avoid creating duplicates.
 * C4: subscribe to the stream error event to set the _logStreamError flag and broadcast.
 */
function _getLogStream() {
  const today = _todayIso()
  if (_logStream && _logStreamDate === today) return _logStream

  // If a rotation is already in progress, synchronously return the old stream (if any) — absorbed by the caller's try/catch
  if (_logStreamRotating) return _logStream

  _logStreamRotating = (async () => {
    try {
      if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true })
      const nextStream = fs.createWriteStream(
        path.join(LOG_DIR, `${today}.jsonl`),
        { flags: 'a', encoding: 'utf8' }
      )
      // C4: register stream error handler — on failure set the flag and broadcast state
      nextStream.on('error', (err) => {
        _logStreamError = err?.message || String(err)
        try { broadcastState() } catch { /* noop */ }
      })
      const prev = _logStream
      _logStream = nextStream
      _logStreamDate = today
      _logStreamError = null
      // Close the old stream in the background
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
 * Record one structured log entry.
 *   extra: { runId?, event?, durationMs?, tokens?, fileCount?, errorCount?, detail?, data? }
 *   event: 'start' | 'step-start' | 'step-end' | 'end' | 'info' (defaults to 'info')
 */
function addLog(jobId, level, message, extra = {}) {
  // H3: no more logging/broadcasting after shutdown (avoids races on open streams/windows)
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

  // JSONL persistence (silently ignore failures)
  try {
    const s = _getLogStream()
    if (s) s.write(JSON.stringify(entry) + '\n')
  } catch { /* ignore */ }

  broadcast('cron:log-append', entry)
  return entry
}

/** Start a new run. Sets the activeRun for jobId and writes the log header. */
function startRun(jobId, meta = {}) {
  const runId = `${jobId}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
  _activeRuns[jobId] = {
    runId,
    startedAt: new Date().toISOString(),
    startedMs: Date.now(),
    parentRunId: meta.parentRunId ?? null,
    trigger: meta.trigger ?? 'manual', // 'schedule' | 'manual' | 'chain'
  }
  addLog(jobId, 'info', meta.headerMessage || `=== ${jobId} run started ===`, {
    runId,
    event: 'start',
    data: { parentRunId: meta.parentRunId ?? null, trigger: meta.trigger ?? 'manual' },
  })
  return runId
}

/** End a run. Writes status/aggregate fields as a summary log. */
function endRun(jobId, status, summary = {}) {
  const run = _activeRuns[jobId]
  if (!run) return
  const durationMs = Date.now() - run.startedMs
  const level = status === 'success' ? 'info' : status === 'error' ? 'error' : 'warn'
  addLog(jobId, level, summary.message || `=== ${jobId} ${status} (${Math.round(durationMs / 1000)}s) ===`, {
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

// ─── Utils ───────────────────────────────────────────────

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

// ─── Renderer invocation ─────────────────────────────────

function invokeRenderer(jobId, runId) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const channel = `cron:execute-${jobId}`
    const resultChannel = `cron:result:${requestId}`
    const timeoutMs = JOB_TIMEOUT[jobId] || DEFAULT_TIMEOUT

    addLog(jobId, 'info', `Invoking renderer (timeout: ${Math.round(timeoutMs / 60000)} min)`, { runId, event: 'step-start' })

    // H4: remove the registered handler reference via removeListener instead of removeAllListeners.
    // ipcMain.once creates an internal wrapper that is hard to remove directly, so switch to explicit .on + removeListener.
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
      reject(new Error(`Timed out after ${Math.round(timeoutMs / 60000)} min`))
    }, timeoutMs)

    // Pass runId to the renderer → editAgentRunner etc. can attach it to their own logs
    broadcast(channel, { requestId, runId })
  })
}

// ─── Health check ────────────────────────────────────────

function executeHealthCheck() {
  const runId = startRun('health-check', { trigger: 'schedule', headerMessage: 'Health check' })
  try {
    const proc = _getSlackBotProcess ? _getSlackBotProcess() : null
    const botAlive = proc !== null
    const mem = process.memoryUsage()
    const rssMb = Math.round(mem.rss / 1024 / 1024)
    addLog('health-check', 'info', `RSS: ${rssMb}MB | Bot: ${botAlive ? 'OK' : 'stopped'}`, {
      runId, data: { rssMb, botAlive },
    })
    if (!botAlive) addLog('health-check', 'warn', 'Slack bot stopped', { runId })
    endRun('health-check', 'success', { data: { rssMb, botAlive } })
  } catch (err) {
    addLog('health-check', 'error', `Health check exception: ${err.message}`, { runId })
    endRun('health-check', 'error', { errorCount: 1 })
  }
}

// ─── Daily run (Edit Agent → vault-reload → vector-rebuild) ─

async function runDaily(trigger = 'manual') {
  if (_mutex['daily-run']) {
    addLog('daily-run', 'warn', 'Already running')
    return
  }
  _mutex['daily-run'] = true
  const state = _states['daily-run']
  state.status = 'running'
  state.lastRunAt = new Date().toISOString()
  broadcastState()

  const parentRunId = startRun('daily-run', { trigger, headerMessage: '=== Daily run started ===' })

  const results = []
  let totalErrors = 0

  const runStep = async (stepId) => {
    // H1: child steps also acquire the mutex. Skip if already running independently (manual run-now etc.).
    if (_mutex[stepId]) {
      addLog(stepId, 'warn', 'busy-skip: already running, skipped in daily-run chain', { runId: parentRunId })
      results.push(`${stepId}: ⏭ busy-skip`)
      return
    }
    _mutex[stepId] = true
    addLog('daily-run', 'info', `▶ ${stepId} started`, { runId: parentRunId, event: 'step-start' })
    const childRunId = startRun(stepId, { trigger: 'chain', parentRunId, headerMessage: `=== ${stepId} started ===` })
    const stepStart = Date.now()
    try {
      await invokeRenderer(stepId, childRunId)
      const sec = Math.round((Date.now() - stepStart) / 1000)
      results.push(`${stepId}: ✓ (${sec}s)`)
      addLog('daily-run', 'info', `✓ ${stepId} done (${sec}s)`, {
        runId: parentRunId, event: 'step-end', durationMs: Date.now() - stepStart,
      })
      endRun(stepId, 'success')
    } catch (err) {
      totalErrors++
      results.push(`${stepId}: ✗ ${err.message}`)
      addLog('daily-run', 'error', `✗ ${stepId} failed: ${err.message}`, { runId: parentRunId, event: 'step-end' })
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
    message: `=== Daily run ${allOk ? 'complete' : 'partially failed'}: ${results.join(', ')} ===`,
    errorCount: totalErrors,
  })
  broadcastState()
}

// ─── Single job run ──────────────────────────────────────

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

  const runId = startRun(jobId, { trigger, headerMessage: `=== ${jobId} started ===` })
  try {
    await invokeRenderer(jobId, runId)
    if (s) { s.status = 'success'; s.runCount += 1; s.lastResult = 'OK' }
    endRun(jobId, 'success')
  } catch (err) {
    if (s) { s.status = 'error'; s.errorCount += 1; s.lastResult = err.message }
    addLog(jobId, 'error', `Failed: ${err.message}`, { runId })
    endRun(jobId, 'error', { errorCount: 1, data: { error: err.message } })
  } finally {
    _mutex[jobId] = false
    broadcastState()
  }
}

// ─── Schedule registration ───────────────────────────────

function scheduleJob(jobId) {
  if (_tasks[jobId]) { _tasks[jobId].stop(); _tasks[jobId] = null }

  const config = _configs[jobId]
  if (!config?.schedulable || !config?.enabled || !config?.cronExpression) return

  const expr = config.cronExpression
  if (!cron.validate(expr)) {
    addLog(jobId, 'error', `Invalid cron: "${expr}"`)
    return
  }

  const options = config.timezone ? { timezone: config.timezone } : {}
  const handler = jobId === 'daily-run'
    ? () => runDaily('schedule').catch(e => addLog(jobId, 'error', e.message))
    : () => executeJob(jobId, 'schedule').catch(e => addLog(jobId, 'error', e.message))

  _tasks[jobId] = cron.schedule(expr, handler, options)
  addLog(jobId, 'info', `cron registered: "${expr}"${config.timezone ? ` (${config.timezone})` : ''}`)
}

// ─── History file lookup ─────────────────────────────────

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
    // C3: prevent escaping LOG_DIR via symlinks — verify realpath is under LOG_DIR
    const realDir = fs.realpathSync(LOG_DIR)
    const realFile = fs.realpathSync(file)
    const rel = path.relative(realDir, realFile)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return []

    const text = fs.readFileSync(realFile, 'utf-8')
    const entries = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try { entries.push(JSON.parse(line)) } catch { /* skip corrupted line */ }
    }
    return entries
  } catch { return [] }
}

// ─── Public API ──────────────────────────────────────────

function initCronScheduler(configs, getSlackBotProcess) {
  _getSlackBotProcess = getSlackBotProcess || null

  for (const jobId of JOB_IDS) {
    _configs[jobId] = { ...DEFAULT_CONFIGS[jobId], ...(configs?.[jobId] ?? {}), id: jobId }
    _states[jobId] = createInitialState()
    _mutex[jobId] = false
    _tasks[jobId] = null
  }

  for (const jobId of JOB_IDS) scheduleJob(jobId)
  addLog('system', 'info', 'Cron scheduler initialized')
  broadcastState()
}

function updateJobConfig(jobId, patch) {
  if (!_configs[jobId]) return
  Object.assign(_configs[jobId], patch)
  _configs[jobId].id = jobId
  addLog(jobId, 'info', `Config changed: ${JSON.stringify(patch)}`)
  scheduleJob(jobId)
  broadcastState()
}

function getFullState() {
  const jobs = {}
  for (const jobId of JOB_IDS) {
    jobs[jobId] = { ...(_configs[jobId] || {}), ...(_states[jobId] || {}) }
  }
  // C4: expose the log stream error flag to the UI
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
  addLog('system', 'info', 'Cron scheduler shut down')
  // H3: addLog is a no-op once the shutdown flag is raised
  _shuttingDown = true
  // H4: remove all pending ipc result handlers
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
  // Lets the renderer inject run summaries/detailed logs into main (for editAgentRunner)
  addLog,
}
