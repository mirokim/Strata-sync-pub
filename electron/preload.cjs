const { contextBridge, ipcRenderer } = require('electron')

// ── electronAPI ────────────────────────────────────────────────────────────────
// Allowed channels the renderer may use for one-way IPC to main (whitelist)
const _ALLOWED_IPC_SEND = new Set(['rag:mirofish:progress'])

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,
  /** Send one-way IPC to the main process — only allowed channels pass */
  ipcSend: (channel, data) => {
    if (!_ALLOWED_IPC_SEND.has(channel)) {
      console.warn('[preload] ipcSend: blocked channel:', channel)
      return
    }
    ipcRenderer.send(channel, data)
  },
})

// ── windowAPI (Fix 0) — frameless window controls ─────────────────────────────
contextBridge.exposeInMainWorld('windowAPI', {
  minimize:       () => ipcRenderer.invoke('window:minimize'),
  maximize:       () => ipcRenderer.invoke('window:maximize'),
  close:          () => ipcRenderer.invoke('window:close'),
  toggleDevTools: () => ipcRenderer.invoke('window:toggle-devtools'),
})

// ── vaultAPI (Phase 6) ────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('vaultAPI', {
  /** Open a folder picker dialog; returns the selected path or null */
  selectFolder: () => ipcRenderer.invoke('vault:select-folder'),

  /** Load all .md files from the given absolute vault path */
  loadFiles: (dirPath) => ipcRenderer.invoke('vault:load-files', dirPath),

  /** Lightweight metadata scan (path + mtime only, no content) for docs cache fingerprint */
  scanMetadata: (dirPath) => ipcRenderer.invoke('vault:scan-metadata', dirPath),

  /** Start watching the vault directory for changes (debounced 500ms) */
  watchStart: (dirPath) => ipcRenderer.invoke('vault:watch-start', dirPath),

  /** Stop the active file watcher */
  watchStop: () => ipcRenderer.invoke('vault:watch-stop'),

  /** Save a file to the filesystem (used by MD converter and editor) */
  saveFile: (filePath, content) => ipcRenderer.invoke('vault:save-file', filePath, content),

  /** Proactively update currentVaultPath on vault switch (for the loadVaultCached → vault:save-file security check) */
  setActivePath: (vaultPath) => ipcRenderer.invoke('vault:set-active-path', vaultPath),

  /** Rename a file — newFilename is just the filename (no path) */
  renameFile: (absolutePath, newFilename) =>
    ipcRenderer.invoke('vault:rename-file', absolutePath, newFilename),

  /** Permanently delete a file */
  deleteFile: (absolutePath) => ipcRenderer.invoke('vault:delete-file', absolutePath),

  /** Read a single file by absolute path; returns null if not found */
  readFile: (filePath) => ipcRenderer.invoke('vault:read-file', filePath),

  /** Read an image file as base64 data URL; returns null if not found or outside vault */
  readImage: (filePath) => ipcRenderer.invoke('vault:read-image', filePath),

  /** Fallback: find an image anywhere in the vault by its filename (basename search) */
  findImageByName: (filename) => ipcRenderer.invoke('vault:find-image-by-name', filename),

  /** Create a directory (and any missing parents) inside the vault */
  createFolder: (folderPath) => ipcRenderer.invoke('vault:create-folder', folderPath),

  /** Move a file to a different folder inside the vault */
  moveFile: (absolutePath, destFolderPath) =>
    ipcRenderer.invoke('vault:move-file', absolutePath, destFolderPath),

  /**
   * Subscribe to vault file-change events.
   * Returns a cleanup function that removes the listener.
   */
  onChanged: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('vault:changed', listener)
    return () => ipcRenderer.removeListener('vault:changed', listener)
  },
})

// ── confluenceAPI ─────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('confluenceAPI', {
  /** Test Confluence credentials. Returns { ok, displayName } or throws. */
  testConnection: (config) => ipcRenderer.invoke('confluence:test-connection', config),

  /** Fetch all pages from a Confluence space. Returns raw page objects. */
  fetchPages: (config) => ipcRenderer.invoke('confluence:fetch-pages', config),

  /** Save converted markdown files to the vault. */
  savePages: (vaultPath, targetFolder, pagesWithMd) =>
    ipcRenderer.invoke('confluence:save-pages', vaultPath, targetFolder, pagesWithMd),

  /** Download image attachments for a single page. */
  downloadAttachments: (config, vaultPath, targetFolder, pageId) =>
    ipcRenderer.invoke('confluence:download-attachments', config, vaultPath, targetFolder, pageId),

  /** Run a Python script from manual/scripts/. Returns { stdout, stderr, exitCode }. */
  runScript: (scriptName, args) =>
    ipcRenderer.invoke('tools:run-script', scriptName, args),

  /** Delete saved files and remove empty dirs. Returns { deleted, errors }. */
  rollback: (files, dirs) =>
    ipcRenderer.invoke('confluence:rollback', files, dirs),

  /** Get page info (id, title, version, spaceKey) by pageId or URL. */
  getPageInfo: (config, pageIdOrUrl) =>
    ipcRenderer.invoke('confluence:get-page-info', config, pageIdOrUrl),

  /** Create a new Confluence page. opts: { title, storageBody, spaceKey?, parentId? } */
  createPage: (config, opts) =>
    ipcRenderer.invoke('confluence:create-page', config, opts),

  /** Update an existing Confluence page. opts: { pageId, title, storageBody, currentVersion } */
  updatePage: (config, opts) =>
    ipcRenderer.invoke('confluence:update-page', config, opts),

  /** Read a file from the app directory (e.g. 'manual/foo.md'). Returns text or null. */
  readAppFile: (relativePath) =>
    ipcRenderer.invoke('tools:read-app-file', relativePath),
})

// ── jiraAPI ───────────────────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('jiraAPI', {
  /** Test Jira credentials. Returns { ok, displayName } or throws. */
  testConnection: (config) => ipcRenderer.invoke('jira:test-connection', config),
  fetchIssues: (config) => ipcRenderer.invoke('jira:fetch-issues', config),
  saveIssues: (vaultPath, targetFolder, issuesWithMd) =>
    ipcRenderer.invoke('jira:save-issues', vaultPath, targetFolder, issuesWithMd),
  getMembers: (config) => ipcRenderer.invoke('jira:get-members', config),
  createIssue: (config, fields) => ipcRenderer.invoke('jira:create-issue', config, fields),
  rollback: (files, dirs) =>
    ipcRenderer.invoke('confluence:rollback', files, dirs),
})

// ── configAPI (GUI → mcp-config.json sync) ───────────────────────────────
contextBridge.exposeInMainWorld('configAPI', {
  writeMcp: (patch) => ipcRenderer.invoke('config:write-mcp', patch),
})

// ── settingsAPI (Zustand persist → file storage) ─────────────────────────────
contextBridge.exposeInMainWorld('settingsAPI', {
  read:  (filename) => ipcRenderer.invoke('settings:read', filename),
  write: (filename, data) => ipcRenderer.invoke('settings:write', filename, data),
})

// ── syncAPI (Team vault sync via Cloudflare) ─────────────────────────────────
contextBridge.exposeInMainWorld('syncAPI', {
  getState: () => ipcRenderer.invoke('sync:get-state'),
  updateConfig: (patch) => ipcRenderer.invoke('sync:update-config', patch),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  testConnection: (url, token) => ipcRenderer.invoke('sync:test-connection', url, token),
  onStatus: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('sync:status', listener)
    return () => ipcRenderer.removeListener('sync:status', listener)
  },
})

// ── cronAPI (Cron Job Scheduler) ─────────────────────────────────────────────
contextBridge.exposeInMainWorld('cronAPI', {
  getState: () => ipcRenderer.invoke('cron:get-state'),
  updateConfig: (jobId, patch) => ipcRenderer.invoke('cron:update-config', jobId, patch),
  runNow: (jobId) => ipcRenderer.invoke('cron:run-now', jobId),
  getLogs: () => ipcRenderer.invoke('cron:get-logs'),
  getRuns: () => ipcRenderer.invoke('cron:get-runs'),
  listLogFiles: () => ipcRenderer.invoke('cron:list-log-files'),
  loadLogFile: (date) => ipcRenderer.invoke('cron:load-log-file', date),
  appendLog: (jobId, level, message, extra) =>
    ipcRenderer.invoke('cron:append-log', jobId, level, message, extra),
  onStateUpdate: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('cron:state-update', listener)
    return () => ipcRenderer.removeListener('cron:state-update', listener)
  },
  onLogAppend: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('cron:log-append', listener)
    return () => ipcRenderer.removeListener('cron:log-append', listener)
  },
  /** @deprecated — replaced by onStateUpdate, alias kept for existing hook compatibility */
  onJobStatus: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('cron:state-update', listener)
    return () => ipcRenderer.removeListener('cron:state-update', listener)
  },
  onExecuteJob: (jobType, callback) => {
    const channel = `cron:execute-${jobType}`
    const listener = (_event, data) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },
  sendResult: (requestId, result) => {
    ipcRenderer.send(`cron:result:${requestId}`, result)
  },
})

// ── backendAPI (Phase 1-3) ────────────────────────────────────────────────────
const BACKEND_PORT = parseInt(process.env.BACKEND_PORT || '8765', 10)
const BACKEND_BASE = `http://127.0.0.1:${BACKEND_PORT}`

async function backendFetch(urlPath, options) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)  // 30s timeout
  try {
    const res = await fetch(`${BACKEND_BASE}${urlPath}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
      signal: controller.signal,  // always fixed — guarantees timeout abort even if the caller passes a signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status))
      throw new Error(`Backend ${res.status}: ${text}`)
    }
    return res.json()
  } finally {
    clearTimeout(timer)
  }
}

contextBridge.exposeInMainWorld('backendAPI', {
  /** Get backend readiness status */
  getStatus: () => ipcRenderer.invoke('backend:getStatus'),

  /** Index document chunks into ChromaDB */
  indexDocuments: (chunks) =>
    backendFetch('/docs/index', {
      method: 'POST',
      body: JSON.stringify({ documents: chunks }),
    }),

  /** Clear the entire vector index */
  clearIndex: () => backendFetch('/docs/clear', { method: 'DELETE' }),

  /** Semantic search — returns top-k matching chunks */
  search: (query, topK) =>
    backendFetch('/docs/search', {
      method: 'POST',
      body: JSON.stringify({ query, top_k: topK !== undefined ? topK : 3 }),
    }),

  /** Get collection stats (chunk count) */
  getStats: () => backendFetch('/docs/stats'),

  /**
   * Subscribe to backend:ready IPC event.
   * Returns a cleanup function.
   */
  onReady: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('backend:ready', listener)
    return () => ipcRenderer.removeListener('backend:ready', listener)
  },
})

// ── ragAPI (Slack RAG bridge) ─────────────────────────────────────────────────
contextBridge.exposeInMainWorld('ragAPI', {
  /** Listen for search requests from the HTTP server (via main process). */
  onSearch: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('rag:search', listener)
    return () => ipcRenderer.removeListener('rag:search', listener)
  },
  /** Listen for settings requests from the HTTP server (via main process). */
  onGetSettings: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('rag:get-settings', listener)
    return () => ipcRenderer.removeListener('rag:get-settings', listener)
  },
  /** Listen for full-answer generation requests (Slack /ask endpoint). */
  onAsk: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('rag:ask', listener)
    return () => ipcRenderer.removeListener('rag:ask', listener)
  },
  /** Listen for image search requests (Slack /images endpoint). */
  onGetImages: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('rag:get-images', listener)
    return () => ipcRenderer.removeListener('rag:get-images', listener)
  },
  /** Listen for MiroFish simulation requests (Slack /mirofish endpoint). */
  onMirofish: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('rag:mirofish', listener)
    return () => ipcRenderer.removeListener('rag:mirofish', listener)
  },
  /** Listen for vault path requests (Slack /mirofish-save fallback). */
  onGetVaultPath: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('rag:get-vault-path', listener)
    return () => ipcRenderer.removeListener('rag:get-vault-path', listener)
  },
  /** Send results/settings back to the HTTP server (via main process). */
  sendResult: (requestId, results) => {
    try {
      ipcRenderer.send('rag:result', { requestId, results })
    } catch (err) {
      // On structured clone failure (BigInt, circular refs, etc.) — fallback: send empty results
      console.error('[preload] sendResult serialization failed:', err)
      ipcRenderer.send('rag:result', { requestId, results: [] })
    }
  },
})

// ── botAPI (Slack bot process management) ──────────────────────────────────────
contextBridge.exposeInMainWorld('botAPI', {
  start:     (config) => ipcRenderer.invoke('bot:start', config),
  stop:      ()       => ipcRenderer.invoke('bot:stop'),
  getStatus: ()       => ipcRenderer.invoke('bot:status'),
  getLogs:   ()       => ipcRenderer.invoke('bot:get-logs'),
  readLogFile: (date) => ipcRenderer.invoke('bot:read-log-file', date),
  onLog: (callback) => {
    const listener = (_event, line) => callback(line)
    ipcRenderer.on('bot:log', listener)
    return () => ipcRenderer.removeListener('bot:log', listener)
  },
  onStopped: (callback) => {
    const listener = (_event, data) => callback(data)
    ipcRenderer.on('bot:stopped', listener)
    return () => ipcRenderer.removeListener('bot:stopped', listener)
  },
})

// ── reportAPI (PDF report export) ─────────────────────────────────────────────
contextBridge.exposeInMainWorld('reportAPI', {
  /** Convert an HTML string to PDF and export via the save dialog */
  exportPdf: (html, suggestedName) =>
    ipcRenderer.invoke('report:export-pdf', html, suggestedName),
})

// ── webSearchAPI (DuckDuckGo via IPC) ─────────────────────────────────────────
contextBridge.exposeInMainWorld('webSearchAPI', {
  /** DuckDuckGo HTML search — returns the result HTML string */
  search: (query) => ipcRenderer.invoke('web:search', query),
})

// ── toolsAPI — run Python scripts in the tools/ folder for the Edit Agent ─────
contextBridge.exposeInMainWorld('toolsAPI', {
  /** Run a Python script in the tools/ folder. Returns { stdout, stderr, exitCode }. */
  runVaultTool: (scriptName, args) =>
    ipcRenderer.invoke('tools:run-vault-tool', scriptName, args),
})

// ── gstackAPI — gstack headless browser automation ────────────────────────────
contextBridge.exposeInMainWorld('gstackAPI', {
  /** Run a gstack browser command. Returns { success, output, error? }. */
  execute: (command, args) =>
    ipcRenderer.invoke('gstack:execute', command, args),
})
