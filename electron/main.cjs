const { app, BrowserWindow, shell, session, ipcMain, dialog, protocol, net } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const cronScheduler = require('./cronScheduler.cjs')

// ── C1: RAG HTTP 서버 인증 토큰 (프로세스당 1회 생성) ─────────────────────
// 127.0.0.1 바인딩이지만 로컬의 다른 프로세스도 접근 가능하므로 랜덤 토큰 요구.
// bot.py 는 config.json 의 rag_auth_token 필드로 전달받아 x-rag-auth 헤더에 실어 보내야 함.
const _ragAuthToken = crypto.randomBytes(24).toString('hex')

let mainWindow

// ── Crash protection: prevent silent exits ──────────────────────────────────

const CRASH_LOG = path.join(__dirname, '..', 'crash.log')

function logCrash(type, err) {
  const ts = new Date().toISOString()
  const msg = `[${ts}] [${type}] ${err?.stack || err?.message || err}\n`
  try { fs.appendFileSync(CRASH_LOG, msg) } catch {}
  console.error(`[crash] ${type}:`, err)
}

process.on('uncaughtException', (err) => {
  logCrash('uncaughtException', err)
})

process.on('unhandledRejection', (reason) => {
  logCrash('unhandledRejection', reason)
})

// 렌더러 메모리 한도 확장 (기본 ~512MB → 2GB) — OOM 크래시 방지
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048')

// ── Security: Allowed API domains for CORS bypass ──────────────────────────────
const ALLOWED_API_DOMAINS = [
  'api.anthropic.com',
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
]

// ── Python backend subprocess (Phase 1-3) ──────────────────────────────────────
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '8765', 10)
let pythonProcess = null
let backendReady = false

// ── Slack bot subprocess ────────────────────────────────────────────────────────
let slackBotProcess = null
const slackBotLogBuffer = []  // ring buffer — last 2000 lines
let _botLogStream = null
let _sslBypassRefCount = 0

function _getBotLogStream() {
  const today = new Date().toISOString().slice(0, 10)
  const logsDir = path.join(__dirname, '..', 'bot', 'slackbot_logs')
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true })
  const logFile = path.join(logsDir, `${today}.log`)
  if (!_botLogStream || _botLogStream._date !== today) {
    if (_botLogStream) _botLogStream.end()
    _botLogStream = fs.createWriteStream(logFile, { flags: 'a', encoding: 'utf8' })
    _botLogStream._date = today
  }
  return _botLogStream
}

const _PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3'

function startSlackBot(config) {
  if (slackBotProcess) return { ok: false, error: '이미 실행 중' }
  const botDir = path.join(__dirname, '..', 'bot')
  const configPath = path.join(botDir, 'config.json')

  // Merge caller-supplied config with existing file (if any)
  // Whitelist allowed keys to prevent arbitrary config injection
  const ALLOWED_BOT_KEYS = new Set(['botToken', 'appToken', 'signingSecret', 'channels', 'debug', 'sendImages', 'slack_model'])
  let existing = {}
  try { existing = JSON.parse(fs.readFileSync(configPath, 'utf8')) } catch {}
  const safeConfig = Object.fromEntries(Object.entries(config).filter(([k]) => ALLOWED_BOT_KEYS.has(k)))
  // Rename camelCase keys to snake_case expected by bot.py
  const KEY_MAP = { botToken: 'slack_bot_token', appToken: 'slack_app_token' }
  const renamedConfig = Object.fromEntries(
    Object.entries(safeConfig).map(([k, v]) => [KEY_MAP[k] ?? k, v])
  )
  // C1: bot.py 가 RAG HTTP 서버 호출 시 사용할 인증 토큰 주입
  const merged = { ...existing, ...renamedConfig, rag_auth_token: _ragAuthToken }
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf8')

  const proc = spawn(_PYTHON_CMD, ['bot.py', '--headless'], {
    cwd: botDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const sendToWindow = (channel, ...args) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
  }

  const pushLog = (rawLine) => {
    // H6: Slack 토큰 (xoxb-/xoxa-/xoxp-/xoxs- 등) 을 저장 전 마스킹
    const line = String(rawLine).replace(/xox[abpsr]-[A-Za-z0-9-]+/g, '[REDACTED]')
    const ts = new Date().toISOString().slice(11, 19)
    const stamped = `[${ts}] ${line}`
    slackBotLogBuffer.push(stamped)
    if (slackBotLogBuffer.length > 2000) slackBotLogBuffer.splice(0, slackBotLogBuffer.length - 2000)
    sendToWindow('bot:log', stamped)
    try { _getBotLogStream().write(`${stamped}\n`) } catch {}
  }

  proc.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach(line => pushLog(line))
  })
  proc.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean)
    lines.forEach(line => pushLog(`[ERR] ${line}`))
  })
  proc.on('exit', (code) => {
    slackBotProcess = null
    sendToWindow('bot:stopped', { code })
  })
  proc.on('error', (err) => {
    slackBotProcess = null
    sendToWindow('bot:log', `[ERROR] 프로세스 오류: ${err.message}`)
  })

  slackBotProcess = proc
  return { ok: true }
}

function stopSlackBot() {
  if (!slackBotProcess) return
  slackBotProcess.kill('SIGTERM')
  slackBotProcess = null
}

function startPythonBackend() {
  const cmd = _PYTHON_CMD
  const args = [
    '-m', 'uvicorn', 'backend.main:app',
    '--host', '127.0.0.1',
    '--port', String(BACKEND_PORT),
    '--no-access-log',
  ]

  try {
    pythonProcess = spawn(cmd, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    console.warn('[backend] Failed to start Python subprocess:', err)
    return
  }

  const onData = (data) => {
    const text = data.toString()
    if (text.trim()) console.log('[backend]', text.trim())
    if (text.includes('Application startup complete')) {
      backendReady = true
      BrowserWindow.getAllWindows().forEach((w) =>
        w.webContents.send('backend:ready', { port: BACKEND_PORT })
      )
    }
  }

  pythonProcess.stdout.on('data', onData)
  pythonProcess.stderr.on('data', onData) // uvicorn writes startup info to stderr
  pythonProcess.on('error', (err) => {
    console.warn('[backend] spawn error (Python not installed?):', err.message)
    pythonProcess = null
  })
  pythonProcess.on('exit', (code) => {
    console.log(`[backend] exited with code ${code}`)
    backendReady = false
    pythonProcess = null
  })
}

function stopPythonBackend() {
  if (pythonProcess) {
    pythonProcess.kill('SIGTERM')
    pythonProcess = null
  }
}

// ── Vault path tracking (for IPC security validation) ─────────────────────────
/** 로드된 모든 볼트의 절대 경로 집합 — vault:load-files 및 vault:set-active-path 시 추가 */
const loadedVaultPaths = new Set()
/** 현재 활성 볼트 경로 (단독 참조용) */
let currentVaultPath = null

// ── Vault IPC helpers (Phase 6) ────────────────────────────────────────────────

/**
 * Verify that filePath is strictly inside vaultPath (no path traversal).
 *
 * Primary check: normalized string-prefix (covers new/not-yet-created files).
 * Secondary check: realpathSync to detect symlink escapes (when files exist).
 */
function isInsideVault(vaultPath, filePath) {
  // Primary: normalize both paths lexically (no I/O, works for new files)
  const normVault = path.normalize(path.resolve(vaultPath)).replace(/\\/g, '/').replace(/\/$/, '')
  const normFile  = path.normalize(path.resolve(filePath)).replace(/\\/g, '/')
  const passedPrimary = normFile.startsWith(normVault + '/')

  if (!passedPrimary) return false  // clearly outside vault

  // Secondary: if both paths exist, resolve symlinks to prevent escapes
  try {
    const realVault = fs.realpathSync(vaultPath)
    const realFile  = fs.realpathSync(path.resolve(filePath))
    const rel = path.relative(realVault, realFile)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
  } catch {
    // File doesn't exist yet (new file being created) — primary check passed, allow it
    try {
      const realVault  = fs.realpathSync(vaultPath)
      const realParent = fs.realpathSync(path.dirname(path.resolve(filePath)))
      const realFile   = path.join(realParent, path.basename(filePath))
      const rel = path.relative(realVault, realFile)
      return !rel.startsWith('..') && !path.isAbsolute(rel)
    } catch {
      // Parent also doesn't exist or vault isn't real — deny for safety
      return false
    }
  }
}

/** 볼트 내 이미지 파일로 인정하는 확장자 */
const IMAGE_EXTENSIONS = /\.(png|jpg|jpeg|gif|webp|svg|bmp|avif|tiff?|heic)$/i

// ── Jira / Confluence validation constants ─────────────────────────────────
/** Hard lower-bound for date range queries — prevents runaway full-history scans */
const JIRA_DATE_HARD_MIN = '2025-01-01'
/** Project key format: 1–10 upper/lower alphanum + _ - */
const PROJECT_KEY_RE = /^[A-Z0-9_-]{1,10}$/i

/**
 * Detect image MIME type from file magic bytes.
 * Falls back to extension if magic bytes are not recognized.
 * Returns null for unknown/non-image files.
 */
function detectMime(buffer, absPath) {
  if (!buffer || buffer.length === 0) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  if (buffer[0] === 0x42 && buffer[1] === 0x4D) return 'image/bmp'
  // TIFF: little-endian II 0x2A00 or big-endian MM 0x002A
  if ((buffer[0] === 0x49 && buffer[1] === 0x49 && buffer[2] === 0x2A && buffer[3] === 0x00) ||
      (buffer[0] === 0x4D && buffer[1] === 0x4D && buffer[2] === 0x00 && buffer[3] === 0x2A)) return 'image/tiff'
  // HEIC/AVIF: ISO Base Media File Format — ftyp box at offset 4
  if (buffer.length >= 12 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    const brand = buffer.slice(8, 12).toString('ascii')
    if (/^(heic|heix|hevc|hevx)/.test(brand)) return 'image/heic'
    if (/^(avif|avis)/.test(brand)) return 'image/avif'
  }
  const head = buffer.slice(0, 64).toString('utf8')
  if (head.includes('<svg') || head.includes('<?xml')) return 'image/svg+xml'
  const ext = path.extname(absPath).slice(1).toLowerCase()
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
           gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
           avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic' }[ext] ?? null
}

/**
 * Read an image file and return a base64 data URL (used by legacy IPC handlers).
 * Async to avoid blocking Electron's main process thread on large images.
 */
async function readImageAsDataUrl(absPath) {
  let buffer
  try { buffer = await fs.promises.readFile(absPath) } catch (err) {
    console.warn('[vault] readImageAsDataUrl: readFile failed:', absPath, err.message)
    return null
  }
  if (!buffer || buffer.length === 0) return null
  const mime = detectMime(buffer, absPath)
  if (!mime) { console.warn('[vault] readImageAsDataUrl: unrecognized format:', absPath); return null }
  return `data:${mime};base64,${buffer.toString('base64')}`
}

// ── Image registry cache (for rembrandt-img:// protocol handler) ───────────────
// Kept in main process memory so the protocol handler can resolve filenames
// without an IPC round-trip.

/** Original basename → { relativePath, absolutePath } */
let currentImageRegistry = {}
/**
 * Normalized basename (lowercase, spaces→underscores) → absolutePath
 * Built whenever the vault loads; allows O(1) lookup by normalized key.
 */
let currentNormalizedImageMap = {}

function buildNormalizedImageMap(registry) {
  const map = {}
  for (const [key, entry] of Object.entries(registry)) {
    const norm = key.toLowerCase().replace(/\s+/g, '_')
    if (!map[norm]) map[norm] = entry.absolutePath
  }
  return map
}

/**
 * Find an absolute path for a given normalized image name.
 * 1. O(1) lookup in normalizedMap (built from vault:load-files registry)
 * 2. Fast existsSync check in common Obsidian attachment folders
 * 3. Slow recursive directory search (fallback of last resort)
 */
function resolveImagePath(normalizedName) {
  function normStr(s) { return s.toLowerCase().replace(/\s+/g, '_') }
  // Obsidian stores images with a numeric sender-id prefix (e.g. "411542267_image.png")
  // but wikilinks often omit the prefix. Match if the registry key ends with '_' + normalizedName.
  function isMatch(candidate) {
    return candidate === normalizedName || candidate.endsWith('_' + normalizedName)
  }

  // 1. Registry lookup — exact then suffix match
  const fromRegistry = currentNormalizedImageMap[normalizedName]
  if (fromRegistry && fs.existsSync(fromRegistry)) return fromRegistry
  // Suffix scan (O(n) over registry, only when exact lookup fails)
  for (const [key, absPath] of Object.entries(currentNormalizedImageMap)) {
    if (isMatch(key) && fs.existsSync(absPath)) return absPath
  }

  if (!currentVaultPath) return null

  // 2. Fast path: scan common Obsidian attachment folders with normalized + suffix comparison.
  const COMMON = ['attachments', 'Attachments', 'assets', 'images', 'img', 'media', 'files']
  for (const folder of COMMON) {
    const folderPath = path.join(currentVaultPath, folder)
    let names
    try { names = fs.readdirSync(folderPath) } catch { continue }
    for (const name of names) {
      if (isMatch(normStr(name))) return path.join(folderPath, name)
    }
  }

  // 3. Slow path: recursive search with normalized + suffix comparison
  function searchDir(dir, depth) {
    if (depth > 8) return null
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const full = path.join(dir, e.name)
      if (isMatch(normStr(e.name))) return full
      // Prefer e.isDirectory(), fall back to statSync to follow symlinks/junctions
      let isDir = false
      try { isDir = e.isDirectory() } catch { /* ignore */ }
      if (!isDir) { try { isDir = fs.statSync(full).isDirectory() } catch { /* ignore */ } }
      if (isDir) { const r = searchDir(full, depth + 1); if (r) return r }
    }
    return null
  }
  return searchDir(currentVaultPath, 0)
}

// ── Register rembrandt-img:// custom protocol ─────────────────────────────────
// Must be called before app.ready — registers the scheme as "secure" so Chromium
// treats it like https:// (no mixed-content errors when served from http:// dev server).
protocol.registerSchemesAsPrivileged([
  { scheme: 'rembrandt-img', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

/**
 * Recursively collect all .md files, image files, AND subdirectory paths in dirPath.
 * - Skips hidden dirs/files (starting with '.')
 * - Stops at depth > 10
 * Returns { files: string[], folders: string[], images: string[] }
 *   files:   absolute paths to .md files
 *   folders: vault-relative paths to subdirectories (e.g. "미니언 시스템")
 *   images:  absolute paths to image files (경로만, 내용 읽지 않음)
 */
async function collectVaultContents(vaultPath, dirPath, depth = 0) {
  if (depth > 10) return { files: [], folders: [], images: [] }
  let entries
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  } catch (err) {
    console.warn('[vault] readdir failed for', dirPath, err.message)
    return { files: [], folders: [], images: [] }
  }

  const files = [], folders = [], images = []
  const subPromises = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue  // skip hidden (.obsidian, etc.)
    const fullPath = path.join(dirPath, entry.name)

    // 1) .md 파일
    if (entry.name.toLowerCase().endsWith('.md')) {
      if (isInsideVault(vaultPath, fullPath)) files.push(fullPath)
      continue
    }

    // 2) 이미지 파일 — 경로만 수집
    if (IMAGE_EXTENSIONS.test(entry.name) && isInsideVault(vaultPath, fullPath)) {
      images.push(fullPath)
      continue
    }

    // 3) 디렉토리 확인 (확장자 있는 폴더명 "3D.v2" 등 포함)
    let entryIsDir = false
    try { entryIsDir = entry.isDirectory() } catch {}
    if (!entryIsDir && /\.\w{1,10}$/.test(entry.name)) continue

    // 4) 하위 디렉토리 비동기 병렬 탐색
    const relPath = path.relative(vaultPath, fullPath).replace(/\\/g, '/')
    folders.push(relPath)
    subPromises.push(
      collectVaultContents(vaultPath, fullPath, depth + 1).then(sub => {
        files.push(...sub.files)
        folders.push(...sub.folders)
        images.push(...sub.images)
      }).catch((e) => { console.warn('[vault] 서브디렉토리 읽기 실패:', e.message) })
    )
  }

  await Promise.all(subPromises)
  return { files, folders, images }
}

// ── Register IPC handlers ─────────────────────────────────────────────────────

function registerVaultIpcHandlers() {
  // ── vault:select-folder ──────────────────────────────────────────────────────
  ipcMain.handle('vault:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '볼트 폴더 선택',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // ── vault:load-files ─────────────────────────────────────────────────────────
  ipcMain.handle('vault:load-files', async (_event, vaultPath) => {
    if (!vaultPath || typeof vaultPath !== 'string') {
      throw new Error('Invalid vault path')
    }
    const resolvedVault = path.resolve(vaultPath)

    try { await fs.promises.access(resolvedVault) } catch {
      throw new Error(`볼트 경로가 존재하지 않습니다: ${resolvedVault}`)
    }

    currentVaultPath = resolvedVault
    loadedVaultPaths.add(resolvedVault)
    const { files: filePaths, folders: folderRelPaths, images: imagePaths } =
      await collectVaultContents(resolvedVault, resolvedVault)
    console.log(`[vault] ${filePaths.length}개 .md 파일, ${folderRelPaths.length}개 폴더, ${imagePaths.length}개 이미지 발견 (${resolvedVault})`)

    // 파일 읽기: 최대 BATCH_SIZE개씩 병렬 처리 (무제한 동시 I/O → Windows 파일 핸들 폭증 방지)
    const BATCH_SIZE = 100
    const fileResults = []
    for (let i = 0; i < filePaths.length; i += BATCH_SIZE) {
      const batch = filePaths.slice(i, i + BATCH_SIZE)
      const batchResults = await Promise.all(
        batch.map(async (absPath) => {
          try {
            const [content, stat] = await Promise.all([
              fs.promises.readFile(absPath, 'utf-8'),
              fs.promises.stat(absPath).catch(() => null),
            ])
            const relativePath = path.relative(resolvedVault, absPath).replace(/\\/g, '/')
            return { relativePath, absolutePath: absPath, content, mtime: stat?.mtimeMs }
          } catch (err) {
            console.warn('[vault] Failed to read', absPath, err.message)
            return null
          }
        })
      )
      fileResults.push(...batchResults)
    }
    const files = fileResults.filter(Boolean)

    // 이미지 파일: 경로만 레지스트리로 반환 (filename → {relativePath, absolutePath})
    const imageRegistry = {}
    for (const absPath of imagePaths) {
      const filename = path.basename(absPath)
      const relativePath = path.relative(resolvedVault, absPath).replace(/\\/g, '/')
      if (!imageRegistry[filename]) {
        imageRegistry[filename] = { relativePath, absolutePath: absPath }
      }
    }

    // Keep in-memory copy for the rembrandt-img:// protocol handler
    currentImageRegistry = imageRegistry
    currentNormalizedImageMap = buildNormalizedImageMap(imageRegistry)

    console.log(`[vault] ${files.length}/${filePaths.length}개 파일 읽기 성공, ${Object.keys(imageRegistry).length}개 이미지 등록`)
    return { files, folders: folderRelPaths, imageRegistry }
  })

  // ── vault:scan-metadata ───────────────────────────────────────────────────────
  // 파일 내용 없이 경로 + mtime만 반환 (캐시 지문용 경량 스캔)
  ipcMain.handle('vault:scan-metadata', async (_event, vaultPath) => {
    if (!vaultPath || typeof vaultPath !== 'string') return []
    const resolvedVault = path.resolve(vaultPath)
    try { await fs.promises.access(resolvedVault) } catch { return [] }
    const { files: filePaths } = await collectVaultContents(resolvedVault, resolvedVault)
    const meta = await Promise.all(
      filePaths.map(async (absPath) => {
        try {
          const stat = await fs.promises.stat(absPath)
          const relativePath = path.relative(resolvedVault, absPath).replace(/\\/g, '/')
          return { relativePath, absolutePath: absPath, mtime: stat.mtimeMs }
        } catch { return null }
      })
    )
    return meta.filter(Boolean)
  })

  // ── vault:watch-start ────────────────────────────────────────────────────────
  let watcher = null
  let watchDebounce = null

  ipcMain.handle('vault:watch-start', (_event, vaultPath) => {
    if (!vaultPath) return false
    if (watcher) { watcher.close(); watcher = null }
    clearTimeout(watchDebounce); watchDebounce = null

    try {
      let lastChangedFile = null
      watcher = fs.watch(vaultPath, { recursive: true }, (_eventType, filename) => {
        if (!filename || !filename.endsWith('.md')) return
        // Skip internal app config directory (.strata-sync/) — written by the app itself
        // (e.g. personas.md saved by usePersonaVaultSaver). These are not user vault edits.
        if (filename.replace(/\\/g, '/').startsWith('.strata-sync/')) return
        lastChangedFile = filename
        clearTimeout(watchDebounce)
        watchDebounce = setTimeout(() => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('vault:changed', { vaultPath, changedFile: lastChangedFile })
          }
        }, 500)
      })
      return true
    } catch (err) {
      console.warn('[vault] watch failed:', err)
      return false
    }
  })

  // ── vault:watch-stop ─────────────────────────────────────────────────────────
  ipcMain.handle('vault:watch-stop', () => {
    if (watcher) { watcher.close(); watcher = null }
    clearTimeout(watchDebounce)
    return true
  })

  // ── vault:set-active-path ────────────────────────────────────────────────────
  // loadVaultCached가 vault:load-files를 호출하지 않을 때 currentVaultPath를 선제 갱신
  // H5: 활성 경로가 바뀌면 이전 볼트 권한을 누적하지 않도록 집합을 새 경로만 남기고 교체
  ipcMain.handle('vault:set-active-path', (_event, vaultPath) => {
    if (!vaultPath || typeof vaultPath !== 'string') return false
    const resolved = path.resolve(vaultPath)
    try { fs.accessSync(resolved) } catch { return false }
    currentVaultPath = resolved
    loadedVaultPaths.clear()
    loadedVaultPaths.add(resolved)
    return true
  })

  // ── vault:save-file ──────────────────────────────────────────────────────────
  ipcMain.handle('vault:save-file', async (_event, filePath, content) => {
    if (!filePath || typeof filePath !== 'string') throw new Error('Invalid file path')
    if (typeof content !== 'string') throw new Error('Invalid content')
    const resolved = path.resolve(filePath)
    // 로드된 볼트 경로 중 하나라도 포함하면 허용 (다중 볼트 지원)
    const vaultPaths = loadedVaultPaths.size > 0 ? loadedVaultPaths : (currentVaultPath ? new Set([currentVaultPath]) : null)
    if (vaultPaths && ![...vaultPaths].some(vp => isInsideVault(vp, resolved))) {
      throw new Error(`보안 오류: 볼트 외부 파일은 저장할 수 없습니다 (${resolved})`)
    }
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true })
    const tmp = resolved + '.~tmp'
    try {
      await fs.promises.writeFile(tmp, content, 'utf-8')
      await fs.promises.rename(tmp, resolved)
    } catch (e) {
      try { await fs.promises.unlink(tmp) } catch {}
      throw e
    }
    return { success: true, path: resolved }
  })

  // ── vault:rename-file ─────────────────────────────────────────────────────────
  ipcMain.handle('vault:rename-file', (_event, absolutePath, newFilename) => {
    if (!absolutePath || typeof absolutePath !== 'string') throw new Error('Invalid path')
    if (!newFilename || typeof newFilename !== 'string') throw new Error('Invalid filename')
    const resolved = path.resolve(absolutePath)
    if (currentVaultPath && !isInsideVault(currentVaultPath, resolved)) {
      throw new Error(`보안 오류: 볼트 외부 파일은 이름 변경할 수 없습니다 (${resolved})`)
    }
    if (!fs.existsSync(resolved)) throw new Error(`파일이 존재하지 않습니다: ${resolved}`)
    const dir = path.dirname(resolved)
    const newPath = path.join(dir, newFilename)
    fs.renameSync(resolved, newPath)
    return { success: true, newPath }
  })

  // ── vault:delete-file ─────────────────────────────────────────────────────────
  ipcMain.handle('vault:delete-file', (_event, absolutePath) => {
    if (!absolutePath || typeof absolutePath !== 'string') throw new Error('Invalid path')
    const resolved = path.resolve(absolutePath)
    if (currentVaultPath && !isInsideVault(currentVaultPath, resolved)) {
      throw new Error(`보안 오류: 볼트 외부 파일은 삭제할 수 없습니다 (${resolved})`)
    }
    if (!fs.existsSync(resolved)) throw new Error(`파일이 존재하지 않습니다: ${resolved}`)
    fs.unlinkSync(resolved)
    return { success: true }
  })

  // ── vault:read-file ───────────────────────────────────────────────────────────
  ipcMain.handle('vault:read-file', async (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') return null
    const resolved = path.resolve(filePath)
    // Must be inside current vault — same guard as vault:save-file and vault:read-image
    if (currentVaultPath && !isInsideVault(currentVaultPath, resolved)) return null
    try {
      return await fs.promises.readFile(resolved, 'utf-8')
    } catch {
      return null
    }
  })

  // ── vault:read-image ──────────────────────────────────────────────────────────
  ipcMain.handle('vault:read-image', (_event, filePath) => {
    if (!filePath || typeof filePath !== 'string') return null
    const resolved = path.resolve(filePath)
    if (currentVaultPath && !isInsideVault(currentVaultPath, resolved)) return null
    if (!fs.existsSync(resolved)) return null
    return readImageAsDataUrl(resolved)
  })

  // ── vault:find-image-by-name ──────────────────────────────────────────────────
  // Legacy fallback IPC (kept for compatibility). Uses the shared resolveImagePath helper.
  ipcMain.handle('vault:find-image-by-name', (_event, filename) => {
    if (!filename || typeof filename !== 'string') return null
    const normName = filename.toLowerCase().replace(/\s+/g, '_')
    const absPath = resolveImagePath(normName)
    if (!absPath) return null
    return readImageAsDataUrl(absPath)
  })

  // ── vault:create-folder ───────────────────────────────────────────────────────
  ipcMain.handle('vault:create-folder', (_event, folderPath) => {
    if (!folderPath || typeof folderPath !== 'string') throw new Error('Invalid folder path')
    const resolved = path.resolve(folderPath)
    if (currentVaultPath && !isInsideVault(currentVaultPath, resolved)) {
      throw new Error(`보안 오류: 볼트 외부에 폴더를 만들 수 없습니다 (${resolved})`)
    }
    fs.mkdirSync(resolved, { recursive: true })
    return { success: true, path: resolved }
  })

  // ── vault:move-file ───────────────────────────────────────────────────────────
  ipcMain.handle('vault:move-file', (_event, absolutePath, destFolderPath) => {
    if (!absolutePath || typeof absolutePath !== 'string') throw new Error('Invalid file path')
    if (!destFolderPath || typeof destFolderPath !== 'string') throw new Error('Invalid destination folder')
    const resolvedSrc = path.resolve(absolutePath)
    const resolvedDest = path.resolve(destFolderPath)
    if (currentVaultPath && !isInsideVault(currentVaultPath, resolvedSrc)) {
      throw new Error(`보안 오류: 볼트 외부 파일은 이동할 수 없습니다 (${resolvedSrc})`)
    }
    if (currentVaultPath) {
      const isVaultRoot = resolvedDest === path.resolve(currentVaultPath)
      if (!isVaultRoot && !isInsideVault(currentVaultPath, resolvedDest)) {
        throw new Error(`보안 오류: 볼트 외부로 파일을 이동할 수 없습니다 (${resolvedDest})`)
      }
    }
    if (!fs.existsSync(resolvedSrc)) throw new Error(`파일이 존재하지 않습니다: ${resolvedSrc}`)
    fs.mkdirSync(resolvedDest, { recursive: true })
    const filename = path.basename(resolvedSrc)
    const newPath = path.join(resolvedDest, filename)
    if (resolvedSrc !== newPath) fs.renameSync(resolvedSrc, newPath)
    return { success: true, newPath }
  })
}

function registerBackendIpcHandlers() {
  ipcMain.handle('backend:getStatus', () => ({
    ready: backendReady,
    port: BACKEND_PORT,
  }))

  ipcMain.handle('backend:isReady', () => backendReady)
}

// ── Window control IPC handlers (Fix 0) ───────────────────────────────────────

function registerWindowIpcHandlers() {
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
  ipcMain.handle('window:toggle-devtools', () => {
    mainWindow?.webContents.toggleDevTools()
  })
}

// ── App asset reader (safe: confined to app directory) ─────────────────────────

ipcMain.handle('tools:read-app-file', (_event, relativePath) => {
  if (!relativePath || typeof relativePath !== 'string') return null
  // Reject absolute paths and traversal sequences before resolving
  if (path.isAbsolute(relativePath) || relativePath.includes('..')) return null
  const appRoot = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..')
  const filePath = path.resolve(path.join(appRoot, relativePath))
  // Use path.relative to check boundary (avoids .startsWith prefix collision e.g. /approot-extra)
  const rel = path.relative(path.resolve(appRoot), filePath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  if (!fs.existsSync(filePath)) return null
  return fs.readFileSync(filePath, 'utf-8')
})

// ── PDF Report export ─────────────────────────────────────────────────────────

ipcMain.handle('report:export-pdf', async (_event, html, suggestedName) => {
  // 저장 경로 선택
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: '보고서 저장',
    defaultPath: suggestedName || '대화보고서.pdf',
    filters: [{ name: 'PDF 파일', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return { ok: false, reason: 'canceled' }

  // 숨겨진 BrowserWindow에 HTML을 로드하고 printToPDF
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  })

  await new Promise((resolve) => {
    win.webContents.once('did-finish-load', resolve)
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  })

  try {
    const pdfData = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { marginType: 'default' },
    })
    fs.writeFileSync(filePath, pdfData)
    shell.showItemInFolder(filePath)
    return { ok: true, filePath }
  } catch (err) {
    return { ok: false, reason: String(err) }
  } finally {
    win.destroy()
  }
})

// ── Web search IPC (DuckDuckGo HTML, no API key) ──────────────────────────────

ipcMain.handle('web:search', async (_event, query) => {
  const https = require('https')
  const querystring = require('querystring')
  return new Promise((resolve) => {
    const params = querystring.stringify({ q: query, kl: 'kr-kr' })
    const req = https.request({
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'Content-Length': Buffer.byteLength(params),
      },
    }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', () => resolve(''))
    req.setTimeout(10000, () => { req.destroy(); resolve('') })
    req.write(params)
    req.end()
  })
})

// ── Confluence IPC handlers ────────────────────────────────────────────────────

function registerConfluenceIpcHandlers() {
  /**
   * Fetch all pages from a Confluence space via REST API v1.
   * Uses Electron's net.fetch to bypass CORS.
   * Returns raw page objects: { id, title, body.storage.value, metadata.labels, version, history }
   */
  /**
   * Returns the REST API base path for a Confluence instance.
   * Atlassian Cloud uses /wiki/rest/api; Server/Data Center uses /rest/api.
   */

  /**
   * Strip Confluence page paths (/display/, /pages/, /browse/, viewpage.action)
   * so users can paste any Confluence URL as the base URL.
   */
  function normalizeConfluenceBaseUrl(baseUrl) {
    try {
      const parsed = new URL(baseUrl)
      const pagePathRe = /\/(display|pages|browse|viewpage\.action)(\/|$)/i
      if (pagePathRe.test(parsed.pathname)) return parsed.origin
    } catch { /* fall through */ }
    return baseUrl.replace(/\/+$/, '')
  }

  function getRestApiBase(baseUrl) {
    try {
      const host = new URL(baseUrl).hostname
      return host.endsWith('atlassian.net') ? `${baseUrl}/wiki/rest/api` : `${baseUrl}/rest/api`
    } catch {
      return `${baseUrl}/rest/api`
    }
  }

  /**
   * Build Authorization header based on auth type.
   * cloud / server_basic → Basic base64(email:token)
   * server_pat           → Bearer <token>
   */
  function buildConfluenceAuthHeaders(authType, email, apiToken) {
    let authHeader
    if (authType === 'server_pat') {
      authHeader = `Bearer ${apiToken}`
    } else {
      authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    }
    return { Authorization: authHeader, Accept: 'application/json' }
  }

  /**
   * Apply SSL bypass for the duration of a callback (corporate self-signed certs).
   * Restores the original verify proc afterward.
   */
  async function withSSLBypass(bypass, fn) {
    if (!bypass) return fn()
    _sslBypassRefCount++
    if (_sslBypassRefCount === 1) {
      // 처음 진입 시에만 SSL bypass 활성화
      session.defaultSession.setCertificateVerifyProc((_req, cb) => cb(0))
    }
    try {
      return await fn()
    } finally {
      _sslBypassRefCount--
      if (_sslBypassRefCount === 0) {
        // 마지막 호출이 끝날 때만 복원
        session.defaultSession.setCertificateVerifyProc(null)
      }
    }
  }

  // ── Jira API ──────────────────────────────────────────────────────────────
  ipcMain.handle('jira:test-connection', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl과 apiToken은 필수입니다.')
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('유효하지 않은 baseUrl 형식입니다. http(s)://... 형식이어야 합니다.') }
    if (authType !== 'server_pat' && !email) throw new Error('이메일(사용자명)이 필요합니다.')

    const base = baseUrl.replace(/\/+$/, '')
    const isCloud = base.includes('atlassian.net')
    const apiVersion = isCloud ? '3' : '2'
    const restBase = `${base}/rest/api/${apiVersion}`

    let authHeader
    if (authType === 'server_pat') {
      authHeader = `Bearer ${apiToken}`
    } else {
      authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    }
    const headers = { Authorization: authHeader, Accept: 'application/json' }

    const url = `${restBase}/myself`
    let res
    try {
      res = await withSSLBypass(bypassSSL, () => net.fetch(url, { headers }))
    } catch (fetchErr) {
      const msg = fetchErr?.message ?? String(fetchErr)
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
        throw new Error(`서버에 연결할 수 없습니다. VPN 및 Base URL을 확인하세요.\n(${msg})`)
      }
      throw new Error(`연결 오류: ${msg}`)
    }

    if (res.status === 401) throw new Error('인증 실패 (401). 이메일/비밀번호 또는 API 토큰을 확인하세요.')
    if (res.status === 403) throw new Error('접근 거부 (403). 계정 권한을 확인하세요.')
    if (!res.ok) throw new Error(`연결 실패: ${res.status} ${res.statusText}`)

    let displayName = ''
    try {
      const data = await res.json()
      displayName = data.displayName ?? data.name ?? ''
    } catch { /* ignore */ }

    return { ok: true, displayName }
  })

  ipcMain.handle('jira:fetch-issues', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, projectKey, jql: customJql, dateFrom, dateTo, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl, apiToken 은 필수 항목입니다.')
    // Validate URL format and protocol to prevent SSRF
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('유효하지 않은 baseUrl 형식입니다. http(s)://... 형식이어야 합니다.') }
    if (authType !== 'server_pat' && !email) throw new Error('Cloud / Server Basic 인증은 이메일이 필요합니다.')
    if (projectKey && !PROJECT_KEY_RE.test(projectKey)) throw new Error('유효하지 않은 Project Key 형식입니다. 영문·숫자·_- (최대 10자) 만 허용됩니다.')

    const effectiveDateFrom = (!dateFrom || dateFrom < JIRA_DATE_HARD_MIN) ? JIRA_DATE_HARD_MIN : dateFrom

    const base = baseUrl.replace(/\/+$/, '')
    const isCloud = authType === 'cloud'
    const apiVersion = isCloud ? '3' : '2'
    const restBase = `${base}/rest/api/${apiVersion}`

    // Build auth header
    let authHeader
    if (authType === 'server_pat') {
      authHeader = `Bearer ${apiToken}`
    } else {
      const b64 = Buffer.from(`${email}:${apiToken}`).toString('base64')
      authHeader = `Basic ${b64}`
    }
    const headers = { 'Authorization': authHeader, 'Accept': 'application/json', 'Content-Type': 'application/json' }

    // Build JQL — customJql은 사용자 입력이므로 위험 패턴 차단
    let jql = customJql?.trim()
    if (jql && /\b(DROP|DELETE|INSERT|UPDATE|EXEC|UNION)\b/i.test(jql)) {
      throw new Error('JQL에 허용되지 않는 키워드가 포함되어 있습니다.')
    }
    if (!jql) {
      jql = projectKey ? `project = "${projectKey}"` : 'order by updated DESC'
      jql += ` AND updated >= "${effectiveDateFrom}"`
      if (dateTo) jql += ` AND updated <= "${dateTo}"`
      jql += ' ORDER BY updated DESC'
    }

    const fields = 'summary,description,status,assignee,reporter,priority,issuetype,labels,components,created,updated,comment,attachment,fixVersions,customfield_10016'

    const issues = []
    let startAt = 0
    const maxResults = 50

    while (true) {
      const url = `${restBase}/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${maxResults}&fields=${encodeURIComponent(fields)}`
      let res
      try {
        res = await withSSLBypass(bypassSSL, () => net.fetch(url, { headers }))
      } catch (fetchErr) {
        const msg = fetchErr?.message ?? String(fetchErr)
        if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND')) {
          throw new Error(`서버에 연결할 수 없습니다. VPN 연결 상태 및 Base URL을 확인하세요.\n(${msg})`)
        }
        throw fetchErr
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => String(res.status))
        if (res.status === 401) throw new Error(`인증 실패 (401). API 토큰 또는 이메일을 확인하세요.`)
        if (res.status === 403) throw new Error(`접근 거부 (403). 해당 프로젝트에 대한 읽기 권한이 없습니다.`)
        throw new Error(`Jira API ${res.status}: ${errText.slice(0, 300)}`)
      }
      const data = await res.json()
      for (const issue of (data.issues ?? [])) issues.push(issue)
      if (issues.length >= data.total || (data.issues ?? []).length < maxResults) break
      startAt += maxResults
    }

    return issues
  })

  ipcMain.handle('jira:save-issues', async (_event, vaultPath, targetFolder, issuesWithMd) => {
    if (!vaultPath || typeof vaultPath !== 'string') throw new Error('Invalid vault path')
    const resolvedVault = path.resolve(vaultPath)
    if (!targetFolder || typeof targetFolder !== 'string') throw new Error('Invalid target folder')
    if (!path.isAbsolute(targetFolder) && targetFolder.includes('..')) throw new Error('Invalid target folder')
    const targetDir = path.isAbsolute(targetFolder) ? targetFolder : path.resolve(path.join(resolvedVault, targetFolder))
    // C2: 절대경로 targetFolder 도 볼트 내부임을 강제 검증 (path traversal 방어)
    if (path.isAbsolute(targetFolder) && !isInsideVault(resolvedVault, targetDir)) {
      throw new Error(`보안 오류: targetFolder 는 볼트 내부여야 합니다 (${targetDir})`)
    }

    fs.mkdirSync(targetDir, { recursive: true })
    let saved = 0
    const savedFiles = []
    for (const { filename, content } of issuesWithMd) {
      if (!filename || typeof content !== 'string') continue
      const safeFilename = path.basename(filename)
      const filePath = path.join(targetDir, safeFilename)
      fs.writeFileSync(filePath, content, 'utf-8')
      saved++
      savedFiles.push(filePath)
    }
    return { saved, targetDir, files: savedFiles }
  })

  // ── Jira: Get assignable project members ──────────────────────────────────
  ipcMain.handle('jira:get-members', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, projectKey, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl과 apiToken은 필수입니다.')
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('유효하지 않은 baseUrl 형식입니다.') }

    const base = baseUrl.replace(/\/+$/, '')
    const isCloud = base.includes('atlassian.net')
    const apiVersion = isCloud ? '3' : '2'
    const restBase = `${base}/rest/api/${apiVersion}`

    let authHeader
    if (authType === 'server_pat') {
      authHeader = `Bearer ${apiToken}`
    } else {
      authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    }
    const headers = { Authorization: authHeader, Accept: 'application/json' }

    // Cloud: /rest/api/3/users/search  (no project required)
    // Server/DC: /rest/api/2/user/assignable/search?project=KEY  (project required)
    //            /rest/api/2/user/search?username=.  (fallback — lists all users)
    const url = projectKey
      ? `${restBase}/user/assignable/search?project=${encodeURIComponent(projectKey)}&maxResults=50`
      : isCloud
        ? `${restBase}/users/search?maxResults=50`
        : `${restBase}/user/search?username=.&maxResults=50`
    let res
    try {
      res = await withSSLBypass(bypassSSL, () => net.fetch(url, { headers }))
    } catch (fetchErr) {
      throw new Error(`연결 오류: ${fetchErr?.message ?? fetchErr}`)
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status))
      throw new Error(`Jira API ${res.status}: ${errText.slice(0, 200)}`)
    }
    const data = await res.json()
    return (Array.isArray(data) ? data : []).map(u => ({
      accountId: u.accountId ?? '',
      displayName: u.displayName ?? '',
      emailAddress: u.emailAddress ?? '',
    }))
  })

  // ── Jira: Create a new issue ──────────────────────────────────────────────
  ipcMain.handle('jira:create-issue', async (_event, config, fields) => {
    const { baseUrl, authType = 'cloud', email, apiToken, projectKey, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl과 apiToken은 필수입니다.')
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('유효하지 않은 baseUrl 형식입니다.') }
    if (!fields?.summary?.trim()) throw new Error('summary(이슈 제목)는 필수입니다.')
    const effectiveProjectKey = (fields.projectKey || projectKey || '').trim()
    if (effectiveProjectKey && !PROJECT_KEY_RE.test(effectiveProjectKey)) throw new Error('유효하지 않은 Project Key 형식입니다. 영문·숫자·_- (최대 10자) 만 허용됩니다.')

    const base = baseUrl.replace(/\/+$/, '')
    const isCloud = authType === 'cloud'
    const restBase = isCloud ? `${base}/rest/api/3` : `${base}/rest/api/2`

    let authHeader
    if (authType === 'server_pat') {
      authHeader = `Bearer ${apiToken}`
    } else {
      authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    }
    const headers = { Authorization: authHeader, Accept: 'application/json', 'Content-Type': 'application/json' }

    const descText = (fields.description ?? '').trim()
    const body = {
      fields: {
        project: { key: effectiveProjectKey },
        summary: fields.summary.trim(),
        description: isCloud
          ? { version: 1, type: 'doc', content: descText ? [{ type: 'paragraph', content: [{ type: 'text', text: descText }] }] : [] }
          : descText,
        issuetype: fields.issuetype
          ? (/^\d+$/.test(fields.issuetype) ? { id: fields.issuetype } : { name: fields.issuetype })
          : { name: 'Task' },
        ...(fields.priority ? { priority: { name: fields.priority } } : {}),
        labels: Array.isArray(fields.labels) ? fields.labels : [],
      },
    }
    if (fields.assigneeAccountId) body.fields.assignee = isCloud
      ? { accountId: fields.assigneeAccountId }
      : { name: fields.assigneeAccountId }
    if (fields.parentKey) body.fields.parent = { key: fields.parentKey }
    if (fields.component) body.fields.components = [{ name: fields.component }]

    let res
    try {
      res = await withSSLBypass(bypassSSL, () => net.fetch(`${restBase}/issue`, {
        method: 'POST', headers, body: JSON.stringify(body),
      }))
    } catch (fetchErr) {
      throw new Error(`연결 오류: ${fetchErr?.message ?? fetchErr}`)
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status))
      if (res.status === 400) throw new Error(`요청 오류 (400): ${errText.slice(0, 300)}`)
      if (res.status === 401) throw new Error('인증 실패 (401). API 토큰을 확인하세요.')
      if (res.status === 403) throw new Error('권한 없음 (403). 이슈 생성 권한이 필요합니다.')
      throw new Error(`Jira API ${res.status}: ${errText.slice(0, 200)}`)
    }
    const data = await res.json()
    const issueKey = data.key

    // ── 활성 스프린트 자동 배정 ───────────────────────────────────────────
    let sprintId = null
    try {
      const agileBase = `${base}/rest/agile/1.0`
      const pKey = fields.projectKey || projectKey
      // 설정에 boardId가 있으면 바로 사용, 없으면 scrum 보드 자동 탐색
      let boardId = config.boardId ?? null
      if (!boardId) {
        const boardRes = await withSSLBypass(bypassSSL, () =>
          net.fetch(`${agileBase}/board?projectKeyOrId=${pKey}&type=scrum&maxResults=10`, { headers })
        )
        if (boardRes.ok) {
          const boardData = await boardRes.json()
          boardId = boardData?.values?.[0]?.id ?? null
        }
      }
      if (boardId) {
        const sprintRes = await withSSLBypass(bypassSSL, () =>
          net.fetch(`${agileBase}/board/${boardId}/sprint?state=active&maxResults=1`, { headers })
        )
        if (sprintRes.ok) {
          const sprintData = await sprintRes.json()
          sprintId = sprintData?.values?.[0]?.id ?? null
        }
      }
    } catch (_) { /* 스프린트 조회 실패 시 백로그 유지 */ }

    if (sprintId) {
      try {
        await withSSLBypass(bypassSSL, () =>
          net.fetch(`${base}/rest/agile/1.0/sprint/${sprintId}/issue`, {
            method: 'POST', headers, body: JSON.stringify({ issues: [issueKey] }),
          })
        )
      } catch (_) { /* 스프린트 배정 실패 시 무시 */ }
    }

    return { key: issueKey, id: data.id, url: `${base}/browse/${issueKey}`, sprintId }
  })

  ipcMain.handle('confluence:test-connection', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl과 apiToken은 필수입니다.')
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('유효하지 않은 baseUrl 형식입니다. http(s)://... 형식이어야 합니다.') }
    if (authType !== 'server_pat' && !email) throw new Error('이메일(사용자명)이 필요합니다.')

    const base = normalizeConfluenceBaseUrl(baseUrl)
    const headers = buildConfluenceAuthHeaders(authType, email, apiToken)
    const restBase = getRestApiBase(base)

    async function tryFetch(url) {
      try {
        return await withSSLBypass(bypassSSL, () => net.fetch(url, { headers }))
      } catch (fetchErr) {
        const msg = fetchErr?.message ?? String(fetchErr)
        if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
          throw new Error(`서버에 연결할 수 없습니다. VPN 및 Base URL을 확인하세요.\n(${msg})`)
        }
        throw new Error(`연결 오류: ${msg}`)
      }
    }

    // /rest/api/space?limit=1 — 모든 Confluence 버전에서 인증 필요, 범용 지원
    const spaceUrl = `${restBase}/space?limit=1`
    const res = await tryFetch(spaceUrl)

    if (res.status === 401) throw new Error('인증 실패 (401). 사용자명/비밀번호 또는 API 토큰을 확인하세요.')
    if (res.status === 403) throw new Error('접근 거부 (403). 계정 권한을 확인하세요.')
    if (!res.ok) throw new Error(`연결 실패: ${res.status} ${res.statusText}`)

    // 사용자 표시명은 /user/current 에서 가져오되, 404여도 연결 성공으로 처리
    let displayName = ''
    try {
      const userRes = await tryFetch(`${restBase}/user/current`)
      if (userRes.ok) {
        const data = await userRes.json()
        displayName = data.displayName ?? data.username ?? data.name ?? ''
      }
    } catch { /* 표시명 취득 실패는 무시 */ }

    return { ok: true, displayName }
  })

  ipcMain.handle('confluence:fetch-pages', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, spaceKey, dateFrom, dateTo, bypassSSL = false } = config

    // Validate required fields (server_pat doesn't need email)
    if (!baseUrl || !apiToken || !spaceKey) {
      throw new Error('baseUrl, apiToken, spaceKey 는 필수 항목입니다.')
    }
    // Validate URL format and protocol to prevent SSRF
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('유효하지 않은 baseUrl 형식입니다. http(s)://... 형식이어야 합니다.') }
    if (authType !== 'server_pat' && !email) {
      throw new Error('Cloud / Server Basic 인증은 이메일(사용자명)이 필요합니다.')
    }

    // Date range validation — hard lower bound: JIRA_DATE_HARD_MIN
    const effectiveDateFrom = (!dateFrom || dateFrom < JIRA_DATE_HARD_MIN) ? JIRA_DATE_HARD_MIN : dateFrom
    if (dateFrom && dateFrom < JIRA_DATE_HARD_MIN) {
      console.warn(`[Confluence] dateFrom(${dateFrom}) < 최소 허용값(${JIRA_DATE_HARD_MIN}), ${JIRA_DATE_HARD_MIN}로 보정합니다.`)
    }

    // Input validation — prevent CQL injection
    const SPACE_KEY_RE = /^[A-Z0-9_~-]{1,100}$/i
    // YYYY-MM-DD 또는 YYYY-MM-DD HH:mm (datetime — lastSyncAt 기반 증분 동기화)
    const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/
    if (!SPACE_KEY_RE.test(spaceKey)) throw new Error('유효하지 않은 Space Key 형식입니다. 영문·숫자·_~- 만 허용됩니다.')
    if (dateTo && !DATE_RE.test(dateTo)) throw new Error('유효하지 않은 dateTo 형식입니다. YYYY-MM-DD 형식이어야 합니다.')
    if (!DATE_RE.test(effectiveDateFrom)) throw new Error('유효하지 않은 dateFrom 형식입니다. YYYY-MM-DD 또는 YYYY-MM-DD HH:mm 형식이어야 합니다.')

    const base = normalizeConfluenceBaseUrl(baseUrl)
    const headers = buildConfluenceAuthHeaders(authType, email, apiToken)
    const restBase = getRestApiBase(base)

    // Build CQL query for server-side date filtering (much more reliable than client-side)
    // lastModified covers both created and modified dates on all Confluence versions
    let cql = `space = "${spaceKey}" AND type = page AND lastModified >= "${effectiveDateFrom}"`
    if (dateTo) cql += ` AND lastModified <= "${dateTo}"`
    cql += ` ORDER BY lastModified DESC`

    const pages = []
    let start = 0
    const limit = 50

    while (true) {
      const url =
        `${restBase}/content/search` +
        `?cql=${encodeURIComponent(cql)}` +
        `&expand=body.storage,body.view,metadata.labels,version,history` +
        `&limit=${limit}` +
        `&start=${start}`

      let res
      try {
        res = await withSSLBypass(bypassSSL, () => net.fetch(url, { headers }))
      } catch (fetchErr) {
        const msg = fetchErr?.message ?? String(fetchErr)
        if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
          throw new Error(`서버에 연결할 수 없습니다. VPN 연결 상태 및 Base URL을 확인하세요.\n(${msg})`)
        }
        if (msg.includes('certificate') || msg.includes('CERT') || msg.includes('SSL')) {
          throw new Error(`SSL 인증서 오류입니다. 사내 CA 인증서 사용 시 "SSL 인증서 우회" 옵션을 활성화하세요.\n(${msg})`)
        }
        throw fetchErr
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => String(res.status))
        if (res.status === 401) {
          const hint = authType === 'server_pat'
            ? 'PAT 토큰이 올바른지 확인하세요.'
            : 'API 토큰 또는 이메일/사용자명을 확인하세요.'
          throw new Error(`인증 실패 (401). ${hint}`)
        }
        if (res.status === 403) throw new Error(`접근 거부 (403). 해당 스페이스에 대한 읽기 권한이 없습니다.`)
        if (res.status === 404) throw new Error(`스페이스 또는 검색 API를 찾을 수 없습니다 (404). Space Key와 Base URL을 확인하세요.`)
        throw new Error(`Confluence API ${res.status}: ${errText.slice(0, 300)}`)
      }
      const data = await res.json()

      for (const page of (data.results ?? [])) {
        pages.push(page)
      }

      // CQL search returns totalSize; stop when we have all results
      const totalSize = data.totalSize ?? data.size ?? 0
      if (pages.length >= totalSize || (data.results ?? []).length < limit) break
      start += limit
    }

    return pages
  })

  /**
   * Write converted markdown files into the vault.
   * pagesWithMd: Array<{ filename: string; content: string }>
   */
  ipcMain.handle('confluence:save-pages', async (_event, vaultPath, targetFolder, pagesWithMd) => {
    if (!vaultPath || typeof vaultPath !== 'string') throw new Error('Invalid vault path')
    const resolvedVault = path.resolve(vaultPath)

    if (!targetFolder || typeof targetFolder !== 'string') throw new Error('Invalid target folder')
    if (!path.isAbsolute(targetFolder) && targetFolder.includes('..')) throw new Error('Invalid target folder')
    const targetDir = path.isAbsolute(targetFolder) ? targetFolder : path.resolve(path.join(resolvedVault, targetFolder))
    // C2: 절대경로 targetFolder 도 볼트 내부임을 강제 검증 (path traversal 방어)
    if (path.isAbsolute(targetFolder) && !isInsideVault(resolvedVault, targetDir)) {
      throw new Error(`보안 오류: targetFolder 는 볼트 내부여야 합니다 (${targetDir})`)
    }

    fs.mkdirSync(targetDir, { recursive: true })
    let saved = 0
    const savedFiles = []
    for (const { filename, content } of pagesWithMd) {
      if (!filename || typeof content !== 'string') continue
      const safeFilename = path.basename(filename)
      const filePath = path.join(targetDir, safeFilename)
      fs.writeFileSync(filePath, content, 'utf-8')
      savedFiles.push(filePath)
      saved++
    }
    return { saved, targetDir, activeDir: targetDir, files: savedFiles }
  })

  /**
   * Rollback: delete the given file paths and remove empty directories.
   * Returns { deleted, errors } — errors are non-fatal (file locked / already gone).
   */
  // ── MCP Config sync (GUI → mcp-config.json) ──────────────────────────────
  ipcMain.handle('config:write-mcp', async (_event, patch) => {
    // SEC-4: allowlist — only known GUI-managed keys may be written
    const ALLOWED_MCP_KEYS = new Set(['jira', 'confluence', 'slackBot', 'vaultPath'])
    const mcpConfigPath = process.env.STRATA_SYNC_CONFIG
      || path.join(__dirname, '..', 'mcp-config.json')
    let current = {}
    try { current = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8')) } catch {}
    // Deep merge one level (top-level keys like jira, confluence, slackBot)
    const merged = { ...current }
    for (const [k, v] of Object.entries(patch)) {
      if (!ALLOWED_MCP_KEYS.has(k)) {
        console.warn(`[config:write-mcp] 허용되지 않은 키 무시: "${k}"`)
        continue
      }
      merged[k] = typeof v === 'object' && v !== null && !Array.isArray(v)
        ? { ...(current[k] ?? {}), ...v }
        : v
    }
    fs.writeFileSync(mcpConfigPath, JSON.stringify(merged, null, 2), 'utf-8')
    return { ok: true }
  })

  // ── Settings file persistence (userData/settings.json, vault.json) ────────
  // Atomic write: tmp → rename (크래시 시 파일 손상 방지)
  // Backup: 쓰기 성공 시 .bak 유지 → 읽기 실패 시 .bak 복구
  const settingsDir = app.getPath('userData')
  const ALLOWED_SETTINGS_FILES = new Set(['settings.json', 'vault.json'])

  function validateSettingsFile(filename) {
    if (!ALLOWED_SETTINGS_FILES.has(filename)) throw new Error(`허용되지 않은 설정 파일: "${filename}"`)
    return path.join(settingsDir, filename)
  }

  ipcMain.handle('settings:read', async (_event, filename) => {
    const filePath = validateSettingsFile(filename)
    const bakPath = filePath + '.bak'
    // 1차: 원본 파일
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[settings:read] ${filename} 손상 또는 읽기 불가:`, err.message, '— .bak 시도')
      }
    }
    // 2차: 백업 파일 복구
    try {
      const raw = fs.readFileSync(bakPath, 'utf-8')
      const parsed = JSON.parse(raw)
      console.warn(`[settings:read] ${filename} → .bak에서 복구 완료`)
      fs.writeFileSync(filePath, raw, 'utf-8')
      return parsed
    } catch { /* 백업도 없음 — 최초 실행 */ }
    return null
  })

  ipcMain.handle('settings:write', async (_event, filename, data) => {
    const filePath = validateSettingsFile(filename)
    const tmpPath = filePath + '.tmp'
    const bakPath = filePath + '.bak'

    // 데이터 타입 검증
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`settings:write — data must be a plain object`)
    }

    // JSON 직렬화 (circular ref, BigInt 등 방어)
    let json
    try {
      json = JSON.stringify(data, null, 2)
    } catch (err) {
      throw new Error(`settings:write — JSON 직렬화 실패: ${err.message}`)
    }

    // 크기 제한 (10MB)
    if (json.length > 10 * 1024 * 1024) {
      throw new Error(`settings:write — 파일 크기 초과 (${(json.length / 1024 / 1024).toFixed(1)}MB > 10MB)`)
    }

    // Atomic write
    fs.writeFileSync(tmpPath, json, 'utf-8')
    try { fs.renameSync(filePath, bakPath) } catch { /* 최초 저장 시 원본 없음 */ }
    try {
      fs.renameSync(tmpPath, filePath)
    } catch (err) {
      // 2차 rename 실패 → .bak에서 원본 복구
      console.error(`[settings:write] ${filename} rename 실패:`, err.message)
      try { fs.renameSync(bakPath, filePath) } catch { /* .bak 복구도 실패 */ }
      try { fs.unlinkSync(tmpPath) } catch { /* tmp 정리 */ }
      throw err
    }
    return { ok: true }
  })

  // ── Confluence Write: get page info ───────────────────────────────────────
  ipcMain.handle('confluence:get-page-info', async (_event, config, pageIdOrUrl) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl과 apiToken은 필수입니다.')
    const base = normalizeConfluenceBaseUrl(baseUrl)
    const headers = buildConfluenceAuthHeaders(authType, email, apiToken)
    const restBase = getRestApiBase(base)

    // Extract numeric page ID from URL or use directly
    let pageId = String(pageIdOrUrl).trim()
    const urlMatch = pageId.match(/pageId=(\d+)/) || pageId.match(/\/pages\/(\d+)/)
    if (urlMatch) pageId = urlMatch[1]
    if (!/^\d+$/.test(pageId)) throw new Error('페이지 ID를 추출할 수 없습니다. pageId=XXXXXX 형식의 URL을 붙여넣으세요.')

    const url = `${restBase}/content/${pageId}?expand=version,space,ancestors`
    const res = await withSSLBypass(bypassSSL, () => net.fetch(url, { headers }))
    if (!res.ok) {
      const txt = await res.text().catch(() => String(res.status))
      if (res.status === 404) throw new Error(`페이지를 찾을 수 없습니다 (ID: ${pageId})`)
      throw new Error(`Confluence ${res.status}: ${txt.slice(0, 200)}`)
    }
    const data = await res.json()
    return {
      id: data.id,
      title: data.title,
      version: data.version?.number ?? 1,
      spaceKey: data.space?.key ?? '',
      url: `${base}/pages/${data.id}`,
    }
  })

  // ── Confluence Write: create new page ─────────────────────────────────────
  ipcMain.handle('confluence:create-page', async (_event, config, opts) => {
    const { baseUrl, authType = 'cloud', email, apiToken, spaceKey, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl과 apiToken은 필수입니다.')
    if (!opts?.title?.trim()) throw new Error('페이지 제목은 필수입니다.')
    if (!opts?.storageBody?.trim()) throw new Error('페이지 내용은 필수입니다.')

    const effectiveSpaceKey = opts.spaceKey || spaceKey
    if (!effectiveSpaceKey) throw new Error('Space Key가 없습니다. Confluence 설정에서 Space Key를 입력하세요.')

    const base = normalizeConfluenceBaseUrl(baseUrl)
    const headers = { ...buildConfluenceAuthHeaders(authType, email, apiToken), 'Content-Type': 'application/json' }
    const restBase = getRestApiBase(base)

    const body = {
      type: 'page',
      title: opts.title.trim(),
      space: { key: effectiveSpaceKey },
      body: { storage: { value: opts.storageBody, representation: 'storage' } },
    }
    if (opts.parentId) body.ancestors = [{ id: String(opts.parentId) }]

    const res = await withSSLBypass(bypassSSL, () => net.fetch(`${restBase}/content`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }))
    if (!res.ok) {
      const txt = await res.text().catch(() => String(res.status))
      if (res.status === 400) throw new Error(`요청 오류 (400): ${txt.slice(0, 300)}`)
      if (res.status === 403) throw new Error('권한 없음 (403). 페이지 생성 권한이 필요합니다.')
      throw new Error(`Confluence ${res.status}: ${txt.slice(0, 200)}`)
    }
    const data = await res.json()
    return { id: data.id, title: data.title, url: `${base}/pages/${data.id}` }
  })

  // ── Confluence Write: update existing page ────────────────────────────────
  ipcMain.handle('confluence:update-page', async (_event, config, opts) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl과 apiToken은 필수입니다.')
    if (!opts?.pageId) throw new Error('pageId는 필수입니다.')
    if (!opts?.title?.trim()) throw new Error('페이지 제목은 필수입니다.')
    if (!opts?.storageBody?.trim()) throw new Error('페이지 내용은 필수입니다.')
    if (!opts?.currentVersion) throw new Error('currentVersion은 필수입니다.')

    const base = normalizeConfluenceBaseUrl(baseUrl)
    const headers = { ...buildConfluenceAuthHeaders(authType, email, apiToken), 'Content-Type': 'application/json' }
    const restBase = getRestApiBase(base)

    const body = {
      type: 'page',
      title: opts.title.trim(),
      version: { number: opts.currentVersion + 1 },
      body: { storage: { value: opts.storageBody, representation: 'storage' } },
    }

    const res = await withSSLBypass(bypassSSL, () => net.fetch(`${restBase}/content/${opts.pageId}`, {
      method: 'PUT', headers, body: JSON.stringify(body),
    }))
    if (!res.ok) {
      const txt = await res.text().catch(() => String(res.status))
      if (res.status === 409) throw new Error('버전 충돌 (409). 페이지가 다른 사람에 의해 수정됐습니다. 새로고침 후 재시도하세요.')
      if (res.status === 403) throw new Error('권한 없음 (403). 페이지 편집 권한이 필요합니다.')
      throw new Error(`Confluence ${res.status}: ${txt.slice(0, 200)}`)
    }
    const data = await res.json()
    return { id: data.id, title: data.title, version: data.version?.number, url: `${base}/pages/${data.id}` }
  })

  ipcMain.handle('confluence:rollback', async (_event, files, dirs) => {
    if (!currentVaultPath) throw new Error('볼트가 열려있지 않습니다')
    const resolvedVault = path.resolve(currentVaultPath)
    let deleted = 0
    const errors = []

    for (const f of (files ?? [])) {
      const resolved = path.resolve(f)
      if (!isInsideVault(resolvedVault, resolved)) {
        errors.push(`보안: 볼트 외부 경로 거부됨 — ${path.basename(f)}`)
        continue
      }
      try {
        if (fs.existsSync(resolved)) { fs.unlinkSync(resolved); deleted++ }
      } catch (e) {
        errors.push(`${path.basename(f)}: ${e.message}`)
      }
    }

    // Remove directories only if now empty
    for (const d of (dirs ?? [])) {
      const resolved = path.resolve(d)
      if (!isInsideVault(resolvedVault, resolved)) {
        errors.push(`보안: 볼트 외부 폴더 거부됨 — ${path.basename(d)}`)
        continue
      }
      try {
        if (fs.existsSync(resolved)) {
          const remaining = fs.readdirSync(resolved)
          if (remaining.length === 0) fs.rmdirSync(resolved)
          else errors.push(`폴더 비어있지 않음 (${remaining.length}개): ${path.basename(d)}`)
        }
      } catch (e) {
        errors.push(`폴더 삭제 실패 (${path.basename(d)}): ${e.message}`)
      }
    }

    return { deleted, errors }
  })

  /**
   * Download Confluence image attachments for a page and save to attachments folder.
   * Returns array of { filename, savedPath }.
   */
  ipcMain.handle('confluence:download-attachments', async (_event, config, vaultPath, targetFolder, pageId) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    const base = normalizeConfluenceBaseUrl(baseUrl)
    const headers = buildConfluenceAuthHeaders(authType, email, apiToken)
    const restBase = getRestApiBase(base)

    // Fetch attachment list
    const listUrl = `${restBase}/content/${pageId}/child/attachment?expand=version&limit=50&mediaType=image`
    const res = await net.fetch(listUrl, { headers })
    if (!res.ok) return []
    const data = await res.json()
    const attachments = data.results ?? []

    const resolvedVault = path.resolve(vaultPath)
    // Images go to vault root attachments/ (per Graph RAG manual: vault/attachments/)
    const attDir = path.join(resolvedVault, 'attachments')
    if (!isInsideVault(resolvedVault, attDir)) throw new Error('Attachments dir is outside vault')
    fs.mkdirSync(attDir, { recursive: true })

    const savedFilePaths = []
    for (const att of attachments) {
      // Use path.basename to strip any traversal in server-supplied filename
      const rawName = att.title ?? att.metadata?.mediaType ?? 'attachment'
      const filename = path.basename(rawName) || 'attachment'
      const downloadUrl = att._links?.download
        ? `${base}${att._links.download}`
        : `${base}/wiki/download/attachments/${pageId}/${encodeURIComponent(filename)}`
      try {
        const imgRes = await withSSLBypass(bypassSSL, () => net.fetch(downloadUrl, { headers }))
        if (!imgRes.ok) continue
        const buf = Buffer.from(await imgRes.arrayBuffer())
        const savedPath = path.join(attDir, filename)
        if (!isInsideVault(resolvedVault, savedPath)) continue
        fs.writeFileSync(savedPath, buf)
        savedFilePaths.push(savedPath)
      } catch { /* skip failed images */ }
    }
    return { downloaded: savedFilePaths.length, files: savedFilePaths }
  })

  /**
   * Run a Python script from manual/scripts/ with given args.
   * Returns { stdout, stderr, exitCode }.
   */
  ipcMain.handle('tools:run-script', async (_event, scriptName, args) => {
    // Reject any scriptName containing path separators or traversal
    if (!scriptName || typeof scriptName !== 'string' ||
        scriptName.includes('/') || scriptName.includes('\\') || scriptName.includes('..')) {
      throw new Error(`Invalid script name: ${scriptName}`)
    }
    // Validate args: must be array of strings; each item either a known flag or a safe path
    const safeArgs = Array.isArray(args) ? args : []
    const ALLOWED_FLAGS = new Set(['--vault', '--dry-run', '--verbose', '--force', '--fix', '--top', '--days', '--threshold'])
    const NUMERIC_FLAGS = new Set(['--top', '--days', '--threshold'])
    for (let i = 0; i < safeArgs.length; i++) {
      const arg = safeArgs[i]
      if (typeof arg !== 'string') throw new Error('Script args must be strings')
      if (arg.startsWith('-')) {
        if (!ALLOWED_FLAGS.has(arg)) throw new Error(`Unknown flag: ${arg}`)
        // Validate flag values
        if (NUMERIC_FLAGS.has(arg)) {
          const val = safeArgs[i + 1]
          if (typeof val !== 'string' || !/^\d+(\.\d+)?$/.test(val)) {
            throw new Error(`${arg} requires a numeric value`)
          }
          i++  // 값 소비 — 다음 반복에서 숫자 값을 플래그로 오인하지 않도록
        }
        if (arg === '--vault') {
          const val = safeArgs[i + 1]
          if (typeof val !== 'string') throw new Error('--vault requires a path value')
          const resolvedVal = path.resolve(val)
          const resolvedVault = currentVaultPath ? path.resolve(currentVaultPath) : null
          if (resolvedVault && !resolvedVal.startsWith(resolvedVault)) {
            throw new Error(`--vault value must be inside the current vault`)
          }
          i++  // 값 소비
        }
      }
    }

    const appDir = app.isPackaged
      ? path.join(process.resourcesPath, 'manual', 'scripts')
      : path.join(__dirname, '..', 'manual', 'scripts')
    const scriptPath = path.resolve(path.join(appDir, scriptName))
    // Verify resolved path is still inside appDir
    if (!scriptPath.startsWith(path.resolve(appDir))) {
      throw new Error(`Script path escapes scripts directory`)
    }
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`스크립트를 찾을 수 없습니다: ${scriptPath}`)
    }

    return new Promise((resolve) => {
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3'
      const proc = spawn(pyCmd, ['-X', 'utf8', scriptPath, ...(args ?? [])], {
        cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', d => { stdout += d.toString() })
      proc.stderr.on('data', d => { stderr += d.toString() })
      let timer = null
      proc.on('close', exitCode => { if (timer) clearTimeout(timer); resolve({ stdout, stderr, exitCode }) })
      proc.on('error', err => { if (timer) clearTimeout(timer); resolve({ stdout: '', stderr: err.message, exitCode: -1 }) })
      // Safety timeout: 60s max per script
      timer = setTimeout(() => { proc.kill(); resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: -1 }) }, 60000)
    })
  })

  // ── tools:run-vault-tool — Edit Agent용 tools/ 폴더 파이썬 스크립트 실행 ────────
  ipcMain.handle('tools:run-vault-tool', async (_event, scriptName, args) => {
    if (!scriptName || typeof scriptName !== 'string' ||
        scriptName.includes('/') || scriptName.includes('\\') || scriptName.includes('..')) {
      throw new Error(`Invalid script name: ${scriptName}`)
    }
    const toolsDir = app.isPackaged
      ? path.join(process.resourcesPath, 'tools')
      : path.join(__dirname, '..', 'tools')
    const scriptPath = path.resolve(path.join(toolsDir, scriptName))
    if (!scriptPath.startsWith(path.resolve(toolsDir))) {
      throw new Error('Script path escapes tools directory')
    }
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`스크립트를 찾을 수 없습니다: ${scriptPath}`)
    }
    const safeArgs = (Array.isArray(args) ? args : []).map(String)
    return new Promise((resolve) => {
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3'
      const proc = spawn(pyCmd, ['-X', 'utf8', scriptPath, ...safeArgs], {
        cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', d => { stdout += d.toString() })
      proc.stderr.on('data', d => { stderr += d.toString() })
      let timer = null
      proc.on('close', exitCode => { if (timer) clearTimeout(timer); resolve({ stdout, stderr, exitCode }) })
      proc.on('error', err => { if (timer) clearTimeout(timer); resolve({ stdout: '', stderr: err.message, exitCode: -1 }) })
      timer = setTimeout(() => { proc.kill(); resolve({ stdout, stderr: stderr + '\n[TIMEOUT 120s]', exitCode: -1 }) }, 120000)
    })
  })

  // ── gstack:execute — gstack 헤드리스 브라우저 바이너리 실행 ─────────────────────
  ipcMain.handle('gstack:execute', async (_event, command, args) => {
    const ALLOWED = new Set(['goto', 'text', 'snapshot', 'click', 'fill', 'js'])
    if (!ALLOWED.has(command)) return { success: false, output: '', error: `Unknown command: ${command}` }
    const safeArgs = (Array.isArray(args) ? args : []).map(String)
    const os = require('os')
    const gstackBin = path.join(os.homedir(), '.claude', 'skills', 'gstack', 'browse', 'dist', 'browse')
    const gstackBinWin = gstackBin + '.exe'
    const binPath = process.platform === 'win32' && fs.existsSync(gstackBinWin) ? gstackBinWin : gstackBin
    if (!fs.existsSync(binPath)) {
      return { success: false, output: '', error: `gstack binary not found: ${binPath}` }
    }
    return new Promise((resolve) => {
      const proc = spawn(binPath, [command, ...safeArgs], { env: { ...process.env } })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', d => { stdout += d.toString() })
      proc.stderr.on('data', d => { stderr += d.toString() })
      let timer = null
      proc.on('close', code => { if (timer) clearTimeout(timer); resolve({ success: code === 0, output: stdout, error: stderr || undefined }) })
      proc.on('error', err => { if (timer) clearTimeout(timer); resolve({ success: false, output: '', error: err.message }) })
      timer = setTimeout(() => { proc.kill(); resolve({ success: false, output: stdout, error: stderr + '\n[TIMEOUT 30s]' }) }, 30000)
    })
  })
}

// ── Window creation ────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1200,
    minHeight: 700,
    title: 'SANDBOX MAP',
    icon: path.join(__dirname, '..', '..', 'ico.png'),  // window titlebar icon
    frame: true,
    titleBarStyle: 'hidden',   // Hide native title text, keep window controls
    titleBarOverlay: {
      color: '#202020',        // matches --color-bg-secondary dark theme
      symbolColor: '#9b9a97', // matches --color-text-secondary
      height: 36,              // matches TopBar h-9
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
    autoHideMenuBar: true,
    backgroundColor: '#191919',
    show: false,  // ready-to-show 이벤트 후 표시 — JS 파싱 중 '응답없음' 방지
  })

  // JS 번들 파싱·첫 렌더 완료 후 창 표시 (Electron 공식 권장 패턴)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
  })

  // Explicitly set taskbar icon on Windows (setAppUserModelId must be called before this)
  if (process.platform === 'win32') {
    const iconPath = path.join(__dirname, '..', '..', 'ico.png')
    if (require('fs').existsSync(iconPath)) mainWindow.setIcon(iconPath)
  }

  // ── Security: Handle CORS for allowed API domains ──
  // Strip Origin header so Chromium does not enforce CORS preflight at all.
  const apiUrlPatterns = ALLOWED_API_DOMAINS.map(d => `https://${d}/*`)
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: apiUrlPatterns },
    (details, callback) => {
      delete details.requestHeaders['Origin']
      delete details.requestHeaders['Referer']
      callback({ requestHeaders: details.requestHeaders })
    }
  )

  // Also inject permissive CORS response headers as a fallback.
  // For OPTIONS preflight: return 204 so the browser accepts the CORS check
  // (some API servers return 4xx for OPTIONS, which fails the preflight).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const url = new URL(details.url)
    const isAllowed = ALLOWED_API_DOMAINS.some(d => url.hostname === d)
    if (isAllowed) {
      const responseHeaders = {
        ...details.responseHeaders,
        'access-control-allow-origin': ['*'],
        'access-control-allow-headers': ['*'],
        'access-control-allow-methods': ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      }
      if (details.method === 'OPTIONS') {
        callback({ responseHeaders, statusLine: 'HTTP/1.1 204 No Content' })
      } else {
        callback({ responseHeaders })
      }
    } else {
      callback({ responseHeaders: details.responseHeaders })
    }
  })

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL)
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  // ── Crash recovery: renderer process gone (GPU crash, OOM, etc.) ───────────
  let rendererCrashCount = 0
  const CRASH_RESET_MS = 30_000  // 30초 내 크래시 횟수 기준
  let crashResetTimer = null

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logCrash('render-process-gone', `reason: ${details.reason}, exitCode: ${details.exitCode}`)
    console.error('[main] render-process-gone:', details.reason, 'exitCode:', details.exitCode)
    if (details.reason === 'clean-exit') return

    rendererCrashCount++
    console.warn(`[main] 렌더러 크래시 횟수: ${rendererCrashCount}`)

    // 30초 안에 3번 이상 크래시하면 무한 재시작 방지 — 재로드 중단
    if (rendererCrashCount >= 3) {
      console.error('[main] 반복 크래시 감지 — 자동 재시작 중단. 앱을 수동으로 재시작하세요.')
      return
    }

    // 타이머: 30초 후 카운터 리셋
    if (crashResetTimer) clearTimeout(crashResetTimer)
    crashResetTimer = setTimeout(() => { rendererCrashCount = 0 }, CRASH_RESET_MS)

    // Wait a moment then reload — GPU driver / OS may need time to release resources
    const delay = details.reason === 'oom' ? 2500 : 1500
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      console.log(`[main] reloading after renderer crash (reason: ${details.reason})`)
      const crashParam = `crashed=${encodeURIComponent(details.reason)}`
      if (process.env.VITE_DEV_SERVER_URL) {
        const base = process.env.VITE_DEV_SERVER_URL.replace(/\/$/, '')
        mainWindow.loadURL(`${base}?${crashParam}`)
      } else {
        mainWindow.loadFile(
          path.join(__dirname, '..', 'dist', 'index.html'),
          { query: { crashed: details.reason } }
        )
      }
    }, delay)
  })

  // ── Unresponsive renderer: log for now (could show dialog if needed) ───────
  mainWindow.on('unresponsive', () => {
    logCrash('unresponsive', 'window became unresponsive')
  })
  mainWindow.on('responsive', () => {
    console.log('[main] window responsive again')
  })

  // GPU 프로세스 크래시 등 — Electron child process 전체
  app.on('child-process-gone', (_event, details) => {
    logCrash('child-process-gone', `type: ${details.type}, reason: ${details.reason}, exitCode: ${details.exitCode}`)
  })
}

// ── Single instance lock ───────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock()

if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

// ── RAG API HTTP server (Slack bot bridge) ─────────────────────────────────────
const RAG_API_PORT = 7331
const _ragResolvers = new Map()

// MiroFish 실시간 진행 상태 — /mirofish-progress 폴링용
let _mirofishProgress = { running: false, feed: [], round: 0, totalRounds: 0 }

// 렌더러에서 보내는 부분 피드 업데이트 수신
ipcMain.on('rag:mirofish:progress', (_event, data) => {
  if (data && typeof data === 'object') {
    _mirofishProgress = { ...data }
  }
})

function startRagApiServer() {
  const http = require('http')

  function ipcRequest(ipcChannel, payload, timeoutMs = 10000) {
    return new Promise((resolve) => {
      if (!mainWindow) { resolve(null); return }
      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const startMs = Date.now()
      const timer = setTimeout(() => {
        _ragResolvers.delete(requestId)
        console.warn(`[RAG] timeout channel=${ipcChannel} req=${requestId} limit=${timeoutMs}ms`)
        resolve(null)
      }, timeoutMs)
      _ragResolvers.set(requestId, (data) => {
        clearTimeout(timer)
        _ragResolvers.delete(requestId)
        console.log(`[RAG] done channel=${ipcChannel} req=${requestId} elapsed=${Date.now() - startMs}ms`)
        resolve(data)
      })
      mainWindow.webContents.send(ipcChannel, { requestId, ...payload })
    })
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${RAG_API_PORT}`)
    const send = (status, data) => {
      if (res.headersSent) return
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(data))
    }
    // 최상위 예외 방어 — async 핸들러의 unhandled rejection 방지
    const _handleRequest = async () => {

    // C1: 모든 RAG HTTP 엔드포인트는 x-rag-auth 헤더의 랜덤 토큰을 요구한다.
    // 127.0.0.1 바인딩만으로는 같은 머신의 타 프로세스 접근을 막지 못함.
    const _authed = req.headers['x-rag-auth'] === _ragAuthToken
    if (!_authed) {
      return send(401, { error: 'unauthorized' })
    }

    if (url.pathname === '/settings') {
      const data = await ipcRequest('rag:get-settings', {})
      return data ? send(200, data) : send(503, { error: 'unavailable' })
    }

    if (url.pathname === '/search') {
      const query = url.searchParams.get('q') || ''
      const topN  = Math.min(parseInt(url.searchParams.get('n') || '5', 10), 20)
      if (!query.trim()) return send(400, { error: 'query required' })
      const results = await ipcRequest('rag:search', { query, topN }, 28000)
      return results ? send(200, results) : send(504, { error: 'timeout' })
    }

    if (url.pathname === '/images') {
      const query = url.searchParams.get('q') || ''
      if (!query.trim()) return send(400, { error: 'query required' })
      const results = await ipcRequest('rag:get-images', { query }, 5000)
      return send(200, results ?? { paths: [] })
    }

    if (url.pathname === '/mirofish') {
      let body = {}
      if (req.method === 'POST') {
        try {
          const raw = await new Promise((resolve, reject) => {
            const chunks = []
            let totalLen = 0
            req.on('data', c => { totalLen += c.length; if (totalLen > 20971520) { req.destroy(); reject(new Error('body too large')); return } chunks.push(c) })
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            req.on('error', reject)
          })
          try { body = JSON.parse(raw) } catch { /* ignore malformed */ }
        } catch { return send(400, { error: 'invalid request' }) }
      }
      const _MIRO_MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250514', 'claude-sonnet-4-6', 'claude-opus-4-6', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4o', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']
      const topic   = (body.topic || '').slice(0, 2000)
      const _np     = parseInt(body.numPersonas, 10)
      const _nr     = parseInt(body.numRounds,   10)
      const numPersonas = Math.min(Math.max(isNaN(_np) ? 5 : _np, 3), 50)
      const numRounds   = Math.min(Math.max(isNaN(_nr) ? 3 : _nr, 2), 10)
      const modelId = _MIRO_MODELS.includes(body.modelId) ? body.modelId : 'claude-haiku-4-5-20251001'
      const context        = typeof body.context === 'string' ? body.context.slice(0, 8000) : undefined
      const segment        = typeof body.segment === 'string' ? body.segment.slice(0, 100) : undefined
      const presetPersonas = Array.isArray(body.presetPersonas) ? body.presetPersonas.slice(0, 50) : undefined
      const images         = Array.isArray(body.images)
        ? body.images.filter(i => i && typeof i.data === 'string' && typeof i.mediaType === 'string').slice(0, 5)
        : undefined
      if (!topic.trim()) return send(400, { error: 'topic required' })
      const result = await ipcRequest('rag:mirofish', { topic, numPersonas, numRounds, modelId, context, segment, presetPersonas, images }, 300000)
      return result ? send(200, result) : send(504, { error: 'timeout' })
    }

    if (url.pathname === '/mirofish-progress') {
      // 현재 실행 중인 시뮬레이션의 부분 피드 반환 (폴링용)
      return send(200, _mirofishProgress)
    }

    if (url.pathname === '/mirofish-save') {
      // MiroFish 시뮬레이션 결과를 볼트 MD 파일로 저장
      if (req.method !== 'POST') return send(405, { error: 'POST required' })
      // currentVaultPath가 null이면 렌더러에서 직접 조회 (앱 시작 직후 타이밍 경쟁 방어)
      if (!currentVaultPath) {
        const rendererVaultPath = await ipcRequest('rag:get-vault-path', {}, 5000)
        if (rendererVaultPath && typeof rendererVaultPath === 'string') {
          currentVaultPath = rendererVaultPath
          console.log('[mirofish-save] currentVaultPath 복원 via IPC:', currentVaultPath)
        }
      }
      if (!currentVaultPath) return send(503, { error: 'vault not loaded' })
      let rawSave = ''
      try {
        rawSave = await new Promise((resolve, reject) => {
          const chunks = []; let len = 0
          req.on('data', c => { len += c.length; if (len > 2097152) { req.destroy(); reject(new Error('too large')) } chunks.push(c) })
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          req.on('error', reject)
        })
      } catch { return send(400, { error: 'invalid request' }) }
      let body = {}
      try { body = JSON.parse(rawSave) } catch { return send(400, { error: 'invalid json' }) }
      const topic    = (typeof body.topic    === 'string' ? body.topic    : '').slice(0, 200)
      const report   = (typeof body.report   === 'string' ? body.report   : '').slice(0, 50000)
      const brief    = (typeof body.brief    === 'string' ? body.brief    : '').slice(0, 5000)
      const feedArr  = Array.isArray(body.feed) ? body.feed.slice(0, 200) : []
      if (!topic) return send(400, { error: 'topic required' })

      const now    = new Date()
      const dateStr = now.toISOString().slice(0, 10)
      const timeStr = now.toTimeString().slice(0, 5).replace(':', '-')
      const slug   = topic.replace(/[^\uAC00-\uD7A3\u3131-\u314Ea-zA-Z0-9]/g, '_').slice(0, 40)
      const fname  = `MiroFish_${dateStr}_${timeStr}_${slug}.md`
      const folder = path.join(currentVaultPath, 'MiroFish')
      const fpath  = path.join(folder, fname)

      const feedMd = feedArr.map(p => {
        const shift = p.stanceShifted ? ` 🔄${p.prevStance}→${p.stance}` : ''
        return `> **[R${p.round}] ${p.personaName}** (${p.stance}${shift})\n> ${p.content}`
      }).join('\n\n')

      const md = [
        `---`,
        `title: "${topic}"`,
        `date: ${dateStr}`,
        `tags: [mirofish, simulation]`,
        `---`,
        ``,
        `# 🐟 MiroFish 시뮬레이션: ${topic}`,
        ``,
        brief ? `## PM 브리프\n${brief}\n` : '',
        `## 분석 보고서`,
        report,
        ``,
        feedMd ? `## 시뮬레이션 피드\n\n${feedMd}` : '',
      ].filter(l => l !== undefined).join('\n')

      // 경로 순회(path traversal) 방어 — 최종 파일 경로가 vault 내부인지 검증
      if (!isInsideVault(currentVaultPath, fpath)) {
        return send(400, { error: 'invalid filename' })
      }
      try {
        fs.mkdirSync(folder, { recursive: true })
        fs.writeFileSync(fpath, md, 'utf-8')
        return send(200, { ok: true, path: fpath, filename: fname })
      } catch (e) {
        console.error('[mirofish-save] write error:', e)
        return send(500, { error: 'internal error' })
      }
    }

    if (url.pathname === '/ask') {
      // POST body 파싱 (history 포함 가능), GET 파라미터 폴백
      let body = {}
      if (req.method === 'POST') {
        try {
          const raw = await new Promise((resolve, reject) => {
            const chunks = []
            let totalLen = 0
            const MAX_BODY = 2 * 1024 * 1024  // 2MB
            req.on('data', chunk => {
              totalLen += chunk.length
              if (totalLen > MAX_BODY) { req.destroy(); reject(new Error('request body too large')); return }
              chunks.push(chunk)
            })
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
            req.on('error', reject)
          })
          try { body = JSON.parse(raw) } catch { /* ignore malformed */ }
        } catch { return send(400, { error: 'invalid request' }) }
      }
      const _VALID_DIRECTORS = ['chief_director', 'art_director', 'prog_director', 'plan_director']
      const _ALLOWED_MEDIA   = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
      const query      = ((body.q || url.searchParams.get('q') || '').slice(0, 10000)).trim()
      const directorId = _VALID_DIRECTORS.includes(body.director) ? body.director
                       : _VALID_DIRECTORS.includes(url.searchParams.get('director')) ? url.searchParams.get('director')
                       : 'chief_director'
      const history = (Array.isArray(body.history) ? body.history : [])
        .filter(m => m && typeof m === 'object' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.length <= 8000)
        .slice(0, 40)
      const images = (Array.isArray(body.images) ? body.images : [])
        .filter(m => m && typeof m === 'object' && typeof m.data === 'string' && _ALLOWED_MEDIA.includes(m.mediaType))
        .slice(0, 5)
      if (!query) return send(400, { error: 'query required' })
      // 이미지: 150초, 텍스트: 120초 — 멀티볼트 순차 RAG + LLM 지연 대응 (기존 60초에서 확대)
      const timeoutMs  = images.length > 0 ? 150000 : 120000
      const result = await ipcRequest('rag:ask', { query, directorId, history, images }, timeoutMs)
      return result ? send(200, result) : send(504, { error: 'timeout' })
    }

      send(404, { error: 'not found' })
    }
    _handleRequest().catch(err => {
      console.error('[RAG API] unhandled error:', err)
      send(500, { error: 'internal error' })
    })
  })

  ipcMain.on('rag:result', (_event, { requestId, results }) => {
    const resolve = _ragResolvers.get(requestId)
    if (resolve) resolve(results)
  })

  // 렌더러 크래시 시 대기 중인 resolver 모두 null로 해소 (메모리 누수 방지)
  function clearRagResolvers() {
    for (const resolve of _ragResolvers.values()) resolve(null)
    _ragResolvers.clear()
  }

  server.listen(RAG_API_PORT, '127.0.0.1', () => {
    console.log(`[RAG API] http://127.0.0.1:${RAG_API_PORT}`)
  })

  app.on('browser-window-created', (_e, win) => {
    win.webContents.on('render-process-gone', clearRagResolvers)
    win.webContents.on('destroyed', clearRagResolvers)
  })
}

  if (process.platform === 'win32') {
    app.setAppUserModelId('com.strata-sync.app')
  }

  app.whenReady().then(() => {
    // ── rembrandt-img:// protocol — serve vault images directly from disk ──────
    // This replaces the data-URL/IPC approach: no base64 encoding, no size limits,
    // no MIME guessing in the renderer. The browser loads images natively.
    protocol.handle('rembrandt-img', async (request) => {
      try {
        const url = new URL(request.url)
        // URL: rembrandt-img:///image-2025-6-30_12-13-7.png
        // pathname = '/image-2025-6-30_12-13-7.png'
        const normalizedName = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
        if (!normalizedName) return new Response(null, { status: 400 })

        const absPath = resolveImagePath(normalizedName)
        if (!absPath) {
          console.warn('[rembrandt-img] not found:', normalizedName)
          return new Response(null, { status: 404 })
        }

        // Use async read to avoid blocking the main process for large images
        let buffer
        try { buffer = await fs.promises.readFile(absPath) } catch {
          return new Response(null, { status: 500 })
        }

        const mime = detectMime(buffer, absPath) ?? 'application/octet-stream'
        return new Response(new Uint8Array(buffer), {
          status: 200,
          headers: {
            'Content-Type': mime,
            'Cache-Control': 'public, max-age=3600',
          },
        })
      } catch (err) {
        console.error('[rembrandt-img] handler error:', err)
        return new Response(null, { status: 500 })
      }
    })

    registerVaultIpcHandlers()
    registerBackendIpcHandlers()
    registerWindowIpcHandlers()
    registerConfluenceIpcHandlers()
    startPythonBackend()
    createWindow()
    startRagApiServer()

    // ── Cron Job Scheduler IPC ──────────────────────────────────────────────────
    // Initialize scheduler async — 시작 시 메인 프로세스 블로킹 방지
    ;(async () => {
      try {
        const settingsPath = path.join(app.getPath('userData'), 'settings.json')
        let cronConfigs = null
        try {
          const raw = await fs.promises.readFile(settingsPath, 'utf-8')
          const settings = JSON.parse(raw)
          cronConfigs = settings?.state?.cronConfigs || null
        } catch { /* first run — no settings file yet */ }
        cronScheduler.initCronScheduler(
          cronConfigs,
          () => slackBotProcess
        )
      } catch (err) {
        console.error('[main] Cron scheduler init failed:', err)
      }
    })()

    ipcMain.handle('cron:get-state', () => cronScheduler.getFullState())
    ipcMain.handle('cron:update-config', async (_event, jobId, patch) => {
      cronScheduler.updateJobConfig(jobId, patch)
      return { ok: true }
    })
    ipcMain.handle('cron:run-now', async (_event, jobId) => {
      cronScheduler.executeJob(jobId).catch(err => {
        console.error(`[cron] Job ${jobId} failed:`, err.message)
      })
      return { ok: true }
    })
    ipcMain.handle('cron:get-logs', () => cronScheduler.getLogs())
    ipcMain.handle('cron:get-runs', () => cronScheduler.getRuns())
    ipcMain.handle('cron:list-log-files', () => cronScheduler.listLogFiles())
    ipcMain.handle('cron:load-log-file', (_event, date) => cronScheduler.loadLogFile(date))
    // 렌더러(editAgentRunner 등)가 run 내부 세부 로그를 scheduler 에 주입
    ipcMain.handle('cron:append-log', (_event, jobId, level, message, extra) => {
      cronScheduler.addLog(jobId, level, message, extra || {})
      return { ok: true }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    cronScheduler.shutdown()
    stopPythonBackend()
    stopSlackBot()
  })

  // ── Slack bot IPC ──────────────────────────────────────────────────────────
  ipcMain.handle('bot:start', (_event, config) => startSlackBot(config))
  ipcMain.handle('bot:stop',  () => { stopSlackBot(); return { ok: true } })
  ipcMain.handle('bot:status', () => ({ running: slackBotProcess !== null }))
  ipcMain.handle('bot:get-logs', () => [...slackBotLogBuffer])
  ipcMain.handle('bot:read-log-file', async (_event, date) => {
    if (!date || typeof date !== 'string') return null
    const logPath = path.join(__dirname, '..', 'bot', 'slackbot_logs', `${date}.log`)
    try {
      return await fs.promises.readFile(logPath, 'utf-8')
    } catch {
      return null
    }
  })
}
