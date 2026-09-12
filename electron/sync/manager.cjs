/**
 * Team sync manager — owns the SyncEngine for the active vault, persists the team-sync settings
 * (token encrypted with Electron safeStorage when the OS keychain is available) and exposes the
 * IPC surface used by Settings → Team Sync.
 *
 *   sync:get-state             → { config (token masked), status }
 *   sync:update-config(patch)  → save + restart engine if needed
 *   sync:now                   → run one full cycle
 *   sync:test-connection       → GET /health with the current URL/token
 *   event 'sync:status'        → pushed to the renderer on every status change
 */
'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { SyncEngine } = require('./engine.cjs')

const CONFIG_FILE = 'team-sync.json'

const DEFAULT_CONFIG = { enabled: false, url: '', token: '', author: '', pullIntervalMs: 30_000 }

let _deps = null           // { userDataDir, safeStorage, getVaultPath, send, log }
let _config = { ...DEFAULT_CONFIG }
let _engine = null
let _watcher = null
let _vaultPath = null

// ── Config persistence ───────────────────────────────────────────────────────

function configPath() { return path.join(_deps.userDataDir, CONFIG_FILE) }

function encryptToken(token) {
  if (!token) return ''
  const ss = _deps.safeStorage
  if (ss && ss.isEncryptionAvailable()) return 'enc:' + ss.encryptString(token).toString('base64')
  return 'plain:' + token
}

function decryptToken(stored) {
  if (!stored) return ''
  if (stored.startsWith('enc:')) {
    const ss = _deps.safeStorage
    if (!ss || !ss.isEncryptionAvailable()) return ''
    try { return ss.decryptString(Buffer.from(stored.slice(4), 'base64')) } catch { return '' }
  }
  if (stored.startsWith('plain:')) return stored.slice(6)
  return stored
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf-8'))
    _config = { ...DEFAULT_CONFIG, ...raw, token: decryptToken(raw.token) }
  } catch { _config = { ...DEFAULT_CONFIG } }
}

function saveConfig() {
  fs.mkdirSync(_deps.userDataDir, { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify({ ..._config, token: encryptToken(_config.token) }, null, 2), 'utf-8')
}

function publicConfig() {
  return { ..._config, token: _config.token ? '••••' + _config.token.slice(-4) : '', hasToken: Boolean(_config.token) }
}

// ── Engine lifecycle ─────────────────────────────────────────────────────────

function idleStatus() {
  return { enabled: false, inFlight: false, lastSyncAt: null, lastSeq: 0, pending: 0, conflicts: [], errors: [], lastError: null }
}

function getState() {
  return { config: publicConfig(), status: _engine ? _engine.getStatus() : idleStatus(), vaultPath: _vaultPath }
}

function broadcast() { _deps.send('sync:status', getState()) }

function stopEngine() {
  if (_watcher) { try { _watcher.close() } catch { /* ignore */ } _watcher = null }
  if (_engine) { _engine.stop(); _engine = null }
  broadcast()
}

async function startEngine() {
  stopEngine()
  const vaultPath = _deps.getVaultPath()
  if (!_config.enabled || !_config.url || !_config.token || !vaultPath) { _vaultPath = vaultPath; broadcast(); return }
  _vaultPath = vaultPath

  _engine = new SyncEngine({
    vaultPath,
    config: { url: _config.url, token: _config.token, author: _config.author, pullIntervalMs: _config.pullIntervalMs },
    deps: { fs: fsp, fetch: globalThis.fetch, log: _deps.log },
    onStatus: () => broadcast(),
  })

  try {
    _watcher = fs.watch(vaultPath, { recursive: true }, (_event, filename) => {
      if (!filename || !_engine) return
      _engine.noteLocalChange(filename.toString())
    })
  } catch (e) {
    _deps.log(`[sync] watcher unavailable (${e.message}); relying on periodic reconcile`)
  }

  await _engine.start()
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * @param {{ userDataDir: string, safeStorage?: Electron.SafeStorage, getVaultPath: () => string | null,
 *           send: (channel: string, payload: unknown) => void, log?: (msg: string) => void }} deps
 */
function init(deps) {
  _deps = { log: msg => console.log(msg), ...deps }
  loadConfig()
  return startEngine()
}

/** Call when the active vault changes so the engine follows it. */
function onVaultChanged() { return startEngine() }

async function updateConfig(patch) {
  const next = { ..._config }
  for (const key of ['enabled', 'url', 'author', 'pullIntervalMs']) if (key in patch) next[key] = patch[key]
  if (typeof patch.token === 'string' && patch.token && !patch.token.startsWith('••••')) next.token = patch.token.trim()
  if (patch.clearToken) next.token = ''
  next.url = String(next.url || '').trim().replace(/\/+$/, '')
  next.author = String(next.author || '').trim().slice(0, 80)
  next.pullIntervalMs = Math.max(10_000, Number(next.pullIntervalMs) || 30_000)
  _config = next
  saveConfig()
  await startEngine()
  return getState()
}

async function syncNow() {
  if (!_engine) return getState()
  await _engine.syncNow()
  return getState()
}

async function testConnection(url, token) {
  const target = String(url || _config.url || '').trim().replace(/\/+$/, '')
  const bearer = token && !token.startsWith('••••') ? token : _config.token
  if (!target) return { ok: false, error: 'server URL is empty' }
  try {
    const health = await fetch(`${target}/health`)
    if (!health.ok) return { ok: false, error: `health check returned ${health.status}` }
    const auth = await fetch(`${target}/v1/manifest?since=0`, { headers: { authorization: `Bearer ${bearer}` } })
    if (auth.status === 401) return { ok: false, error: 'server reachable but the token was rejected' }
    if (!auth.ok) return { ok: false, error: `manifest returned ${auth.status}` }
    const body = await auth.json()
    return { ok: true, head: body.head, files: Array.isArray(body.files) ? body.files.length : 0 }
  } catch (e) {
    return { ok: false, error: e.message || String(e) }
  }
}

function shutdown() { stopEngine() }

module.exports = { init, onVaultChanged, updateConfig, syncNow, testConnection, getState, shutdown }
