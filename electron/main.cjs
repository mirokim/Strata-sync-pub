const { app, BrowserWindow, shell, session, ipcMain, dialog, protocol, net, safeStorage } = require('electron')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const cronScheduler = require('./cronScheduler.cjs')
const teamSync = require('./sync/manager.cjs')
const proposals = require('./proposals.cjs')

// ── C1: RAG HTTP server auth token (generated once per process) ───────────
// Bound to 127.0.0.1, but other local processes can still reach it, so a random token is required.
// bot.py receives it via the rag_auth_token field in config.json and must send it in the x-rag-auth header.
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

// Raise renderer memory limit (default ~512MB → 2GB) — prevents OOM crashes
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
  if (slackBotProcess) return { ok: false, error: 'Already running' }
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
  // C1: inject the auth token bot.py uses when calling the RAG HTTP server
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
    // H6: mask Slack tokens (xoxb-/xoxa-/xoxp-/xoxs- etc.) before storing
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
    sendToWindow('bot:log', `[ERROR] Process error: ${err.message}`)
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
/** Set of absolute paths of all loaded vaults — added on vault:load-files and vault:set-active-path */
const loadedVaultPaths = new Set()
/** Current active vault path (single reference) */
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

/** Recognized image file extensions within the vault */
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

// ── Image registry cache (for strata-img:// protocol handler) ───────────────
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

// ── Register strata-img:// custom protocol ─────────────────────────────────
// Must be called before app.ready — registers the scheme as "secure" so Chromium
// treats it like https:// (no mixed-content errors when served from http:// dev server).
protocol.registerSchemesAsPrivileged([
  { scheme: 'strata-img', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

/**
 * Recursively collect all .md files, image files, AND subdirectory paths in dirPath.
 * - Skips hidden dirs/files (starting with '.')
 * - Stops at depth > 10
 * Returns { files: string[], folders: string[], images: string[] }
 *   files:   absolute paths to .md files
 *   folders: vault-relative paths to subdirectories (e.g. "Minion System")
 *   images:  absolute paths to image files (paths only, content not read)
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

    // 1) .md file
    if (entry.name.toLowerCase().endsWith('.md')) {
      if (isInsideVault(vaultPath, fullPath)) files.push(fullPath)
      continue
    }

    // 2) Image file — collect path only
    if (IMAGE_EXTENSIONS.test(entry.name) && isInsideVault(vaultPath, fullPath)) {
      images.push(fullPath)
      continue
    }

    // 3) Check if directory (handles folders with extensions like "3D.v2")
    let entryIsDir = false
    try { entryIsDir = entry.isDirectory() } catch {}
    if (!entryIsDir && /\.\w{1,10}$/.test(entry.name)) continue

    // 4) Subdirectory — async parallel traversal
    const relPath = path.relative(vaultPath, fullPath).replace(/\\/g, '/')
    folders.push(relPath)
    subPromises.push(
      collectVaultContents(vaultPath, fullPath, depth + 1).then(sub => {
        files.push(...sub.files)
        folders.push(...sub.folders)
        images.push(...sub.images)
      }).catch((e) => { console.warn('[vault] Subdirectory read failed:', e.message) })
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
      title: 'Select Vault Folder',
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
      throw new Error(`Vault path does not exist: ${resolvedVault}`)
    }

    const vaultSwitched = currentVaultPath !== resolvedVault
    currentVaultPath = resolvedVault
    loadedVaultPaths.add(resolvedVault)
    if (vaultSwitched) teamSync.onVaultChanged().catch(err => console.error('[sync] vault switch failed:', err))
    const { files: filePaths, folders: folderRelPaths, images: imagePaths } =
      await collectVaultContents(resolvedVault, resolvedVault)
    console.log(`[vault] Found ${filePaths.length} .md files, ${folderRelPaths.length} folders, ${imagePaths.length} images (${resolvedVault})`)

    // Read files: up to BATCH_SIZE in parallel (unbounded concurrent I/O → Windows file handle explosion)
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

    // Image files: return paths only as a registry (filename → {relativePath, absolutePath})
    const imageRegistry = {}
    for (const absPath of imagePaths) {
      const filename = path.basename(absPath)
      const relativePath = path.relative(resolvedVault, absPath).replace(/\\/g, '/')
      if (!imageRegistry[filename]) {
        imageRegistry[filename] = { relativePath, absolutePath: absPath }
      }
    }

    // Keep in-memory copy for the strata-img:// protocol handler
    currentImageRegistry = imageRegistry
    currentNormalizedImageMap = buildNormalizedImageMap(imageRegistry)

    console.log(`[vault] ${files.length}/${filePaths.length} files read successfully, ${Object.keys(imageRegistry).length} images registered`)
    return { files, folders: folderRelPaths, imageRegistry }
  })

  // ── vault:scan-metadata ───────────────────────────────────────────────────────
  // Return only path + mtime without file contents (lightweight scan for cache fingerprint)
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
  // Proactively update currentVaultPath when loadVaultCached does not call vault:load-files
  // H5: when the active path changes, replace the set with only the new path so old vault permissions do not accumulate
  ipcMain.handle('vault:set-active-path', (_event, vaultPath) => {
    if (!vaultPath || typeof vaultPath !== 'string') return false
    const resolved = path.resolve(vaultPath)
    try { fs.accessSync(resolved) } catch { return false }
    const vaultSwitched = currentVaultPath !== resolved
    currentVaultPath = resolved
    loadedVaultPaths.clear()
    loadedVaultPaths.add(resolved)
    if (vaultSwitched) teamSync.onVaultChanged().catch(err => console.error('[sync] vault switch failed:', err))
    return true
  })

  // ── vault:save-file ──────────────────────────────────────────────────────────
  ipcMain.handle('vault:save-file', async (_event, filePath, content) => {
    if (!filePath || typeof filePath !== 'string') throw new Error('Invalid file path')
    if (typeof content !== 'string') throw new Error('Invalid content')
    const resolved = path.resolve(filePath)
    // Allow if inside any of the loaded vault paths (multi-vault support)
    const vaultPaths = loadedVaultPaths.size > 0 ? loadedVaultPaths : (currentVaultPath ? new Set([currentVaultPath]) : null)
    if (vaultPaths && ![...vaultPaths].some(vp => isInsideVault(vp, resolved))) {
      throw new Error(`Security error: cannot write to path outside vault (${resolved})`)
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
      throw new Error(`Security error: cannot rename file outside vault (${resolved})`)
    }
    if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${resolved}`)
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
      throw new Error(`Security error: cannot delete file outside vault (${resolved})`)
    }
    if (!fs.existsSync(resolved)) throw new Error(`File does not exist: ${resolved}`)
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
      throw new Error(`Security error: cannot create folder outside vault (${resolved})`)
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
      throw new Error(`Security error: cannot move file outside vault (${resolvedSrc})`)
    }
    if (currentVaultPath) {
      const isVaultRoot = resolvedDest === path.resolve(currentVaultPath)
      if (!isVaultRoot && !isInsideVault(currentVaultPath, resolvedDest)) {
        throw new Error(`Security error: cannot move file to a location outside vault (${resolvedDest})`)
      }
    }
    if (!fs.existsSync(resolvedSrc)) throw new Error(`File does not exist: ${resolvedSrc}`)
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
  // Choose save path
  const { canceled, filePath } = await dialog.showSaveDialog({
    title: 'Save Report',
    defaultPath: suggestedName || 'chat-report.pdf',
    filters: [{ name: 'PDF File', extensions: ['pdf'] }],
  })
  if (canceled || !filePath) return { ok: false, reason: 'canceled' }

  // Load HTML into a hidden BrowserWindow and printToPDF
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
      // Enable SSL bypass only on first entry
      session.defaultSession.setCertificateVerifyProc((_req, cb) => cb(0))
    }
    try {
      return await fn()
    } finally {
      _sslBypassRefCount--
      if (_sslBypassRefCount === 0) {
        // Restore only when the last call finishes
        session.defaultSession.setCertificateVerifyProc(null)
      }
    }
  }

  // ── Jira API ──────────────────────────────────────────────────────────────
  ipcMain.handle('jira:test-connection', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl and apiToken are required.')
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('Invalid baseUrl format. Must be in the form http(s)://...') }
    if (authType !== 'server_pat' && !email) throw new Error('Email (username) is required.')

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
        throw new Error(`Cannot connect to server. Check your VPN and Base URL.\n(${msg})`)
      }
      throw new Error(`Connection error: ${msg}`)
    }

    if (res.status === 401) throw new Error('Authentication failed (401). Check your email/password or API token.')
    if (res.status === 403) throw new Error('Access denied (403). Check your account permissions.')
    if (!res.ok) throw new Error(`Connection failed: ${res.status} ${res.statusText}`)

    let displayName = ''
    try {
      const data = await res.json()
      displayName = data.displayName ?? data.name ?? ''
    } catch { /* ignore */ }

    return { ok: true, displayName }
  })

  ipcMain.handle('jira:fetch-issues', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, projectKey, jql: customJql, dateFrom, dateTo, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl and apiToken are required.')
    // Validate URL format and protocol to prevent SSRF
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('Invalid baseUrl format. Must be in the form http(s)://...') }
    if (authType !== 'server_pat' && !email) throw new Error('Cloud / Server Basic auth requires an email.')
    if (projectKey && !PROJECT_KEY_RE.test(projectKey)) throw new Error('Invalid Project Key format. Only letters, digits, and _- (max 10 chars) are allowed.')

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

    // Build JQL — customJql is user input, so block dangerous patterns
    let jql = customJql?.trim()
    if (jql && /\b(DROP|DELETE|INSERT|UPDATE|EXEC|UNION)\b/i.test(jql)) {
      throw new Error('JQL contains disallowed keywords.')
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
          throw new Error(`Cannot connect to server. Check your VPN connection and Base URL.\n(${msg})`)
        }
        throw fetchErr
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => String(res.status))
        if (res.status === 401) throw new Error(`Authentication failed (401). Check your API token or email.`)
        if (res.status === 403) throw new Error(`Access denied (403). You do not have read permission for this project.`)
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
    // C2: enforce that an absolute targetFolder is also inside the vault (path traversal defense)
    if (path.isAbsolute(targetFolder) && !isInsideVault(resolvedVault, targetDir)) {
      throw new Error(`Security error: targetFolder must be inside the vault (${targetDir})`)
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
    if (!baseUrl || !apiToken) throw new Error('baseUrl and apiToken are required.')
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('Invalid baseUrl format.') }

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
      throw new Error(`Connection error: ${fetchErr?.message ?? fetchErr}`)
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
    if (!baseUrl || !apiToken) throw new Error('baseUrl and apiToken are required.')
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('Invalid baseUrl format.') }
    if (!fields?.summary?.trim()) throw new Error('summary (issue title) is required.')
    const effectiveProjectKey = (fields.projectKey || projectKey || '').trim()
    if (effectiveProjectKey && !PROJECT_KEY_RE.test(effectiveProjectKey)) throw new Error('Invalid Project Key format. Only letters, digits, and _- (max 10 chars) are allowed.')

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
      throw new Error(`Connection error: ${fetchErr?.message ?? fetchErr}`)
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => String(res.status))
      if (res.status === 400) throw new Error(`Request error (400): ${errText.slice(0, 300)}`)
      if (res.status === 401) throw new Error('Authentication failed (401). Check your API token.')
      if (res.status === 403) throw new Error('Permission denied (403). Issue creation permission is required.')
      throw new Error(`Jira API ${res.status}: ${errText.slice(0, 200)}`)
    }
    const data = await res.json()
    const issueKey = data.key

    // ── Auto-assign to active sprint ──────────────────────────────────────
    let sprintId = null
    try {
      const agileBase = `${base}/rest/agile/1.0`
      const pKey = fields.projectKey || projectKey
      // Use boardId from settings if present, otherwise auto-discover a scrum board
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
    } catch (_) { /* keep in backlog if sprint lookup fails */ }

    if (sprintId) {
      try {
        await withSSLBypass(bypassSSL, () =>
          net.fetch(`${base}/rest/agile/1.0/sprint/${sprintId}/issue`, {
            method: 'POST', headers, body: JSON.stringify({ issues: [issueKey] }),
          })
        )
      } catch (_) { /* ignore sprint assignment failure */ }
    }

    return { key: issueKey, id: data.id, url: `${base}/browse/${issueKey}`, sprintId }
  })

  ipcMain.handle('confluence:test-connection', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl and apiToken are required.')
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('Invalid baseUrl format. Must be in the form http(s)://...') }
    if (authType !== 'server_pat' && !email) throw new Error('Email (username) is required.')

    const base = normalizeConfluenceBaseUrl(baseUrl)
    const headers = buildConfluenceAuthHeaders(authType, email, apiToken)
    const restBase = getRestApiBase(base)

    async function tryFetch(url) {
      try {
        return await withSSLBypass(bypassSSL, () => net.fetch(url, { headers }))
      } catch (fetchErr) {
        const msg = fetchErr?.message ?? String(fetchErr)
        if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT')) {
          throw new Error(`Cannot connect to server. Check your VPN and Base URL.\n(${msg})`)
        }
        throw new Error(`Connection error: ${msg}`)
      }
    }

    // /rest/api/space?limit=1 — requires auth on all Confluence versions, universally supported
    const spaceUrl = `${restBase}/space?limit=1`
    const res = await tryFetch(spaceUrl)

    if (res.status === 401) throw new Error('Authentication failed (401). Check your username/password or API token.')
    if (res.status === 403) throw new Error('Access denied (403). Check your account permissions.')
    if (!res.ok) throw new Error(`Connection failed: ${res.status} ${res.statusText}`)

    // Fetch the user display name from /user/current, but treat a 404 as a successful connection
    let displayName = ''
    try {
      const userRes = await tryFetch(`${restBase}/user/current`)
      if (userRes.ok) {
        const data = await userRes.json()
        displayName = data.displayName ?? data.username ?? data.name ?? ''
      }
    } catch { /* ignore display name lookup failure */ }

    return { ok: true, displayName }
  })

  ipcMain.handle('confluence:fetch-pages', async (_event, config) => {
    const { baseUrl, authType = 'cloud', email, apiToken, spaceKey, dateFrom, dateTo, bypassSSL = false } = config

    // Validate required fields (server_pat doesn't need email)
    if (!baseUrl || !apiToken || !spaceKey) {
      throw new Error('baseUrl, apiToken, and spaceKey are required.')
    }
    // Validate URL format and protocol to prevent SSRF
    try {
      const parsed = new URL(baseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
    } catch { throw new Error('Invalid baseUrl format. Must be in the form http(s)://...') }
    if (authType !== 'server_pat' && !email) {
      throw new Error('Cloud / Server Basic auth requires an email (or username).')
    }

    // Date range validation — hard lower bound: JIRA_DATE_HARD_MIN
    const effectiveDateFrom = (!dateFrom || dateFrom < JIRA_DATE_HARD_MIN) ? JIRA_DATE_HARD_MIN : dateFrom
    if (dateFrom && dateFrom < JIRA_DATE_HARD_MIN) {
      console.warn(`[Confluence] dateFrom(${dateFrom}) < minimum allowed(${JIRA_DATE_HARD_MIN}), correcting to ${JIRA_DATE_HARD_MIN}.`)
    }

    // Input validation — prevent CQL injection
    const SPACE_KEY_RE = /^[A-Z0-9_~-]{1,100}$/i
    // YYYY-MM-DD or YYYY-MM-DD HH:mm (datetime — incremental sync based on lastSyncAt)
    const DATE_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/
    if (!SPACE_KEY_RE.test(spaceKey)) throw new Error('Invalid Space Key format. Only letters, digits, and _~- are allowed.')
    if (dateTo && !DATE_RE.test(dateTo)) throw new Error('Invalid dateTo format. Must be YYYY-MM-DD.')
    if (!DATE_RE.test(effectiveDateFrom)) throw new Error('Invalid dateFrom format. Must be YYYY-MM-DD or YYYY-MM-DD HH:mm.')

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
          throw new Error(`Cannot connect to server. Check your VPN connection and Base URL.\n(${msg})`)
        }
        if (msg.includes('certificate') || msg.includes('CERT') || msg.includes('SSL')) {
          throw new Error(`SSL certificate error. If using a corporate CA certificate, enable the "Bypass SSL Certificate" option.\n(${msg})`)
        }
        throw fetchErr
      }
      if (!res.ok) {
        const errText = await res.text().catch(() => String(res.status))
        if (res.status === 401) {
          const hint = authType === 'server_pat'
            ? 'Check that your PAT token is correct.'
            : 'Check your API token or email/username.'
          throw new Error(`Authentication failed (401). ${hint}`)
        }
        if (res.status === 403) throw new Error(`Access denied (403). You do not have read permission for this space.`)
        if (res.status === 404) throw new Error(`Space or search API not found (404). Check your Space Key and Base URL.`)
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
    // C2: enforce that an absolute targetFolder is also inside the vault (path traversal defense)
    if (path.isAbsolute(targetFolder) && !isInsideVault(resolvedVault, targetDir)) {
      throw new Error(`Security error: targetFolder must be inside the vault (${targetDir})`)
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
        console.warn(`[config:write-mcp] Ignoring disallowed key: "${k}"`)
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
  // Atomic write: tmp → rename (prevents file corruption on crash)
  // Backup: keep .bak after a successful write → restore from .bak on read failure
  const settingsDir = app.getPath('userData')
  const ALLOWED_SETTINGS_FILES = new Set(['settings.json', 'vault.json'])

  function validateSettingsFile(filename) {
    if (!ALLOWED_SETTINGS_FILES.has(filename)) throw new Error(`Disallowed settings file: "${filename}"`)
    return path.join(settingsDir, filename)
  }

  ipcMain.handle('settings:read', async (_event, filename) => {
    const filePath = validateSettingsFile(filename)
    const bakPath = filePath + '.bak'
    // 1st: original file
    try {
      const raw = fs.readFileSync(filePath, 'utf-8')
      return JSON.parse(raw)
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[settings:read] ${filename} corrupted or unreadable:`, err.message, '— trying .bak')
      }
    }
    // 2nd: restore from backup file
    try {
      const raw = fs.readFileSync(bakPath, 'utf-8')
      const parsed = JSON.parse(raw)
      console.warn(`[settings:read] ${filename} → restored from .bak`)
      fs.writeFileSync(filePath, raw, 'utf-8')
      return parsed
    } catch { /* no backup either — first run */ }
    return null
  })

  ipcMain.handle('settings:write', async (_event, filename, data) => {
    const filePath = validateSettingsFile(filename)
    const tmpPath = filePath + '.tmp'
    const bakPath = filePath + '.bak'

    // Validate data type
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error(`settings:write — data must be a plain object`)
    }

    // JSON serialization (guards against circular refs, BigInt, etc.)
    let json
    try {
      json = JSON.stringify(data, null, 2)
    } catch (err) {
      throw new Error(`settings:write — JSON serialization failed: ${err.message}`)
    }

    // Size limit (10MB)
    if (json.length > 10 * 1024 * 1024) {
      throw new Error(`settings:write — file size exceeded (${(json.length / 1024 / 1024).toFixed(1)}MB > 10MB)`)
    }

    // Atomic write
    fs.writeFileSync(tmpPath, json, 'utf-8')
    try { fs.renameSync(filePath, bakPath) } catch { /* no original on first save */ }
    try {
      fs.renameSync(tmpPath, filePath)
    } catch (err) {
      // 2nd rename failed → restore original from .bak
      console.error(`[settings:write] ${filename} rename failed:`, err.message)
      try { fs.renameSync(bakPath, filePath) } catch { /* .bak restore also failed */ }
      try { fs.unlinkSync(tmpPath) } catch { /* clean up tmp */ }
      throw err
    }
    return { ok: true }
  })

  // ── Confluence Write: get page info ───────────────────────────────────────
  ipcMain.handle('confluence:get-page-info', async (_event, config, pageIdOrUrl) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl and apiToken are required.')
    const base = normalizeConfluenceBaseUrl(baseUrl)
    const headers = buildConfluenceAuthHeaders(authType, email, apiToken)
    const restBase = getRestApiBase(base)

    // Extract numeric page ID from URL or use directly
    let pageId = String(pageIdOrUrl).trim()
    const urlMatch = pageId.match(/pageId=(\d+)/) || pageId.match(/\/pages\/(\d+)/)
    if (urlMatch) pageId = urlMatch[1]
    if (!/^\d+$/.test(pageId)) throw new Error('Could not extract page ID. Paste a URL in the form pageId=XXXXXX.')

    const url = `${restBase}/content/${pageId}?expand=version,space,ancestors`
    const res = await withSSLBypass(bypassSSL, () => net.fetch(url, { headers }))
    if (!res.ok) {
      const txt = await res.text().catch(() => String(res.status))
      if (res.status === 404) throw new Error(`Page not found (ID: ${pageId})`)
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
    if (!baseUrl || !apiToken) throw new Error('baseUrl and apiToken are required.')
    if (!opts?.title?.trim()) throw new Error('Page title is required.')
    if (!opts?.storageBody?.trim()) throw new Error('Page content is required.')

    const effectiveSpaceKey = opts.spaceKey || spaceKey
    if (!effectiveSpaceKey) throw new Error('Space Key is missing. Enter a Space Key in the Confluence settings.')

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
      if (res.status === 400) throw new Error(`Request error (400): ${txt.slice(0, 300)}`)
      if (res.status === 403) throw new Error('Permission denied (403). Page creation permission is required.')
      throw new Error(`Confluence ${res.status}: ${txt.slice(0, 200)}`)
    }
    const data = await res.json()
    return { id: data.id, title: data.title, url: `${base}/pages/${data.id}` }
  })

  // ── Confluence Write: update existing page ────────────────────────────────
  ipcMain.handle('confluence:update-page', async (_event, config, opts) => {
    const { baseUrl, authType = 'cloud', email, apiToken, bypassSSL = false } = config
    if (!baseUrl || !apiToken) throw new Error('baseUrl and apiToken are required.')
    if (!opts?.pageId) throw new Error('pageId is required.')
    if (!opts?.title?.trim()) throw new Error('Page title is required.')
    if (!opts?.storageBody?.trim()) throw new Error('Page content is required.')
    if (!opts?.currentVersion) throw new Error('currentVersion is required.')

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
      if (res.status === 409) throw new Error('Version conflict (409). The page was modified by someone else. Refresh and try again.')
      if (res.status === 403) throw new Error('Permission denied (403). Page edit permission is required.')
      throw new Error(`Confluence ${res.status}: ${txt.slice(0, 200)}`)
    }
    const data = await res.json()
    return { id: data.id, title: data.title, version: data.version?.number, url: `${base}/pages/${data.id}` }
  })

  ipcMain.handle('confluence:rollback', async (_event, files, dirs) => {
    if (!currentVaultPath) throw new Error('No vault is currently open')
    const resolvedVault = path.resolve(currentVaultPath)
    let deleted = 0
    const errors = []

    for (const f of (files ?? [])) {
      const resolved = path.resolve(f)
      if (!isInsideVault(resolvedVault, resolved)) {
        errors.push(`Security: path outside vault rejected — ${path.basename(f)}`)
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
        errors.push(`Security: folder outside vault rejected — ${path.basename(d)}`)
        continue
      }
      try {
        if (fs.existsSync(resolved)) {
          const remaining = fs.readdirSync(resolved)
          if (remaining.length === 0) fs.rmdirSync(resolved)
          else errors.push(`Folder not empty (${remaining.length} items): ${path.basename(d)}`)
        }
      } catch (e) {
        errors.push(`Failed to delete folder (${path.basename(d)}): ${e.message}`)
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
          i++  // consume value — so the next iteration does not mistake the numeric value for a flag
        }
        if (arg === '--vault') {
          const val = safeArgs[i + 1]
          if (typeof val !== 'string') throw new Error('--vault requires a path value')
          const resolvedVal = path.resolve(val)
          const resolvedVault = currentVaultPath ? path.resolve(currentVaultPath) : null
          if (resolvedVault && !resolvedVal.startsWith(resolvedVault)) {
            throw new Error(`--vault value must be inside the current vault`)
          }
          i++  // consume value
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
      throw new Error(`Script not found: ${scriptPath}`)
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

  // ── tools:run-vault-tool — run Python scripts in the tools/ folder for the Edit Agent ──
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
      throw new Error(`Script not found: ${scriptPath}`)
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

  // ── gstack:execute — run the gstack headless browser binary ──────────────────
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
    title: 'STRATA SYNC',
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
    show: false,  // show after ready-to-show event — prevents 'Not Responding' during JS parsing
  })

  // Show window after JS bundle parse and first render complete (Electron recommended pattern)
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
  const CRASH_RESET_MS = 30_000  // crash count window of 30 seconds
  let crashResetTimer = null

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logCrash('render-process-gone', `reason: ${details.reason}, exitCode: ${details.exitCode}`)
    console.error('[main] render-process-gone:', details.reason, 'exitCode:', details.exitCode)
    if (details.reason === 'clean-exit') return

    rendererCrashCount++
    console.warn(`[main] Renderer crash count: ${rendererCrashCount}`)

    // If it crashes 3+ times within 30s, stop reloading to prevent an infinite restart loop
    if (rendererCrashCount >= 3) {
      console.error('[main] Repeated crashes detected — stopping auto-restart. Please restart the app manually.')
      return
    }

    // Timer: reset counter after 30s
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

  // GPU process crashes etc. — all Electron child processes
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

// MiroFish real-time progress — for /mirofish-progress polling
let _mirofishProgress = { running: false, feed: [], round: 0, totalRounds: 0 }

// Receive partial feed updates from the renderer
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
    // Top-level exception guard — prevent unhandled rejections in async handler
    const _handleRequest = async () => {

    // C1: every RAG HTTP endpoint requires the random token in the x-rag-auth header.
    // Binding to 127.0.0.1 alone does not block access from other processes on the same machine.
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
      // Return partial feed of the currently running simulation (for polling)
      return send(200, _mirofishProgress)
    }

    if (url.pathname === '/propose') {
      // Bots record ideas/decisions as agent proposals in _agent/ (never straight into the vault).
      // Body: { title, body, tags?, links?, source? } → { ok, path, title }
      if (req.method !== 'POST') return send(405, { error: 'POST required' })
      if (!currentVaultPath) {
        const rendererVaultPath = await ipcRequest('rag:get-vault-path', {}, 5000)
        if (rendererVaultPath && typeof rendererVaultPath === 'string') currentVaultPath = rendererVaultPath
      }
      if (!currentVaultPath) return send(503, { error: 'vault not loaded' })
      let rawPropose = ''
      try {
        rawPropose = await new Promise((resolve, reject) => {
          const chunks = []; let len = 0
          req.on('data', c => { len += c.length; if (len > 1048576) { req.destroy(); reject(new Error('too large')) } chunks.push(c) })
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
          req.on('error', reject)
        })
      } catch { return send(400, { error: 'invalid request' }) }
      let proposeBody = {}
      try { proposeBody = JSON.parse(rawPropose || '{}') } catch { return send(400, { error: 'invalid JSON' }) }
      const title = typeof proposeBody.title === 'string' ? proposeBody.title.trim() : ''
      const text = typeof proposeBody.body === 'string' ? proposeBody.body.trim() : ''
      if (!title || !text) return send(400, { error: 'title and body required' })
      try {
        const written = proposals.writeProposal(currentVaultPath, {
          title, body: text,
          tags: Array.isArray(proposeBody.tags) ? proposeBody.tags.map(String) : [],
          links: Array.isArray(proposeBody.links) ? proposeBody.links.map(String) : [],
          source: typeof proposeBody.source === 'string' ? proposeBody.source.slice(0, 80) : 'bot',
        })
        return send(200, { ok: true, path: written.relPath, title: written.title })
      } catch (e) {
        return send(500, { error: e.message || String(e) })
      }
    }
    if (url.pathname === '/mirofish-save') {
      // Save MiroFish simulation results as a vault MD file
      if (req.method !== 'POST') return send(405, { error: 'POST required' })
      // If currentVaultPath is null, query the renderer directly (guards against a race right after app start)
      if (!currentVaultPath) {
        const rendererVaultPath = await ipcRequest('rag:get-vault-path', {}, 5000)
        if (rendererVaultPath && typeof rendererVaultPath === 'string') {
          currentVaultPath = rendererVaultPath
          console.log('[mirofish-save] currentVaultPath restored via IPC:', currentVaultPath)
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
        `# 🐟 MiroFish Simulation: ${topic}`,
        ``,
        brief ? `## PM Brief\n${brief}\n` : '',
        `## Analysis Report`,
        report,
        ``,
        feedMd ? `## Simulation Feed\n\n${feedMd}` : '',
      ].filter(l => l !== undefined).join('\n')

      // Path traversal defense — verify final file path is inside vault
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
      // Parse POST body (may include history), fall back to GET params
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
      // Images: 150s, text: 120s — accounts for sequential multi-vault RAG + LLM latency (raised from 60s)
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

  // Clear all pending resolvers on renderer crash (prevent memory leaks)
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
    // ── strata-img:// protocol — serve vault images directly from disk ──────
    // This replaces the data-URL/IPC approach: no base64 encoding, no size limits,
    // no MIME guessing in the renderer. The browser loads images natively.
    protocol.handle('strata-img', async (request) => {
      try {
        const url = new URL(request.url)
        // URL: strata-img:///image-2025-6-30_12-13-7.png
        // pathname = '/image-2025-6-30_12-13-7.png'
        const normalizedName = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
        if (!normalizedName) return new Response(null, { status: 400 })

        const absPath = resolveImagePath(normalizedName)
        if (!absPath) {
          console.warn('[strata-img] not found:', normalizedName)
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
        console.error('[strata-img] handler error:', err)
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
    // Initialize scheduler async — avoid blocking the main process at startup
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

    // ── Team sync (Cloudflare) ───────────────────────────────────────────────
    teamSync.init({
      userDataDir: app.getPath('userData'),
      safeStorage,
      getVaultPath: () => currentVaultPath,
      send: (channel, payload) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload) },
      log: msg => console.log(msg),
    }).catch(err => console.error('[sync] init failed:', err))
    ipcMain.handle('sync:get-state', () => teamSync.getState())
    ipcMain.handle('sync:update-config', (_event, patch) => teamSync.updateConfig(patch && typeof patch === 'object' ? patch : {}))
    ipcMain.handle('sync:now', () => teamSync.syncNow())
    ipcMain.handle('sync:test-connection', (_event, url, token) => teamSync.testConnection(url, token))
    ipcMain.handle('sync:search', (_event, query, topK) => teamSync.search(query, topK))

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
    // The renderer (editAgentRunner etc.) injects detailed run logs into the scheduler
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
    teamSync.shutdown()
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
