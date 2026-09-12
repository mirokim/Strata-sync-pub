/**
 * Settings tab for Edit Agent configuration.
 * Controls: enable/disable, interval, model, refinement manual.
 */
import { useState, useEffect } from 'react'
import { useSettingsStore, DEFAULT_EDIT_AGENT_CONFIG } from '@/stores/settingsStore'
import { useEditAgentStore } from '@/stores/editAgentStore'
import { useVaultStore } from '@/stores/vaultStore'
import { MODEL_OPTIONS } from '@/lib/modelConfig'
import { runEditAgentCycle } from '@/services/editAgentRunner'
import { Play, Square, FolderOpen, RefreshCw } from 'lucide-react'

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--color-text-muted)',
  marginBottom: 4,
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 10px',
  background: 'var(--color-bg-tertiary)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: 'var(--color-text-primary)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
}

const SECTION_DEFS = [
  { file: 's01_overview.md',     label: '§1-2 Overview & Pipeline' },
  { file: 's02_triage.md',       label: '§3 Delete/Isolate/Enhance Triage' },
  { file: 's03_conversion.md',   label: '§4 Format→MD Conversion (Confluence)' },
  { file: 's04_structure.md',    label: '§5-6 Split & Frontmatter' },
  { file: 's05_links.md',        label: '§7-9 Link Injection & Keywords' },
  { file: 's06_optimization.md', label: '§10-11 BFS·PageRank' },
  { file: 's07_quality.md',      label: '§12-16 Quality Audit & Checklist' },
  { file: 's08_operations.md',   label: '§17 Operations Guide' },
  { file: 's09_troubleshoot.md', label: '§18- Bug Response & Changelog' },
  { file: 's10_jira_fetch.md',  label: '§Jira Fetch/Convert/Triage' },
  { file: 's11_jira_aggregate.md', label: '§Jira Epic/Release Aggregation' },
  { file: 's12_jira_crosslink.md', label: '§Jira Cross-linking' },
  { file: 's13_game_reference.md', label: '§Game Reference' },
] as const

const DEFAULT_SECTIONS = [
  's01_overview.md',    // Overview & pipeline
  's02_triage.md',      // Delete/isolate/enhance triage
  's04_structure.md',   // Split & frontmatter
  's05_links.md',       // Link injection & keywords — BFS/PPR core
  's06_optimization.md', // BFS & PageRank optimization — directly affects search quality
]

export default function EditAgentTab() {
  const config        = useSettingsStore(s => s.editAgentConfig ?? DEFAULT_EDIT_AGENT_CONFIG)
  const setConfig     = useSettingsStore(s => s.setEditAgentConfig)
  const isRunning     = useEditAgentStore(s => s.isRunning)
  const lastWakeAt    = useEditAgentStore(s => s.lastWakeAt)
  const vaultPath     = useVaultStore(s => s.vaultPath)
  const [loadStatus, setLoadStatus] = useState<string | null>(null)
  const [selectedSections, setSelectedSections] = useState<string[]>(DEFAULT_SECTIONS)
  const [hasSections, setHasSections] = useState<boolean | null>(null)

  const lastWakeStr = lastWakeAt
    ? new Date(lastWakeAt).toLocaleString('ko-KR')
    : 'Never'

  // Auto-detect sections/ on mount
  useEffect(() => {
    if (!vaultPath || !window.vaultAPI) return
    window.vaultAPI.readFile(`${vaultPath}/manual/sections/${SECTION_DEFS[0].file}`)
      .then((content: string | null) => setHasSections(!!content))
      .catch(() => setHasSections(false))
  }, [vaultPath])

  const handleRunNow = async () => {
    if (isRunning) return
    await runEditAgentCycle()
  }

  /** Detect whether manual/sections/ exists — only checks the first section via readFile */
  const handleDetectSections = async () => {
    if (!vaultPath || !window.vaultAPI) return
    try {
      const probe = await window.vaultAPI.readFile(`${vaultPath}/manual/sections/${SECTION_DEFS[0].file}`)
      setHasSections(!!probe)
    } catch {
      setHasSections(false)
    }
  }

  /** Load only the selected sections directly via readFile (does not use loadFiles — avoids polluting currentVaultPath) */
  const handleLoadLatestManual = async () => {
    if (!vaultPath || !window.vaultAPI) {
      setLoadStatus('No vault is open')
      return
    }
    setLoadStatus('Scanning...')
    try {
      // sections/ folder: load the selected sections directly via readFile
      const parts: string[] = []
      const sorted = selectedSections
        .slice()
        .sort((a, b) => a.localeCompare(b))
      for (const file of sorted) {
        try {
          const content = await window.vaultAPI.readFile(`${vaultPath}/manual/sections/${file}`)
          if (content) parts.push(content)
        } catch { /* skip if the file is missing */ }
      }

      if (parts.length > 0) {
        setHasSections(true)
        setConfig({ refinementManual: parts.join('\n\n---\n\n') })
        const totalKB = Math.round(parts.join('').length / 1024)
        setLoadStatus(`✓ Loaded ${parts.length} sections (~${totalKB}KB)`)
        return
      }

      // fallback: a single file in the manual/ root (directly via readFile)
      setHasSections(false)
      // Try the legacy full-manual filename patterns
      const fallbackNames = ['manual.md', 'README.md']
      for (const name of fallbackNames) {
        try {
          const content = await window.vaultAPI.readFile(`${vaultPath}/manual/${name}`)
          if (content) {
            setConfig({ refinementManual: content })
            setLoadStatus(`✓ Loaded: manual/${name}`)
            return
          }
        } catch { /* try the next one */ }
      }
      setLoadStatus('Selected sections not found — check the manual/sections/ path')
    } catch {
      setLoadStatus('Load failed')
    }
  }

  /** Load the manual from a custom path */
  const handleLoadFromPath = async (relativePath: string) => {
    if (!vaultPath || !window.vaultAPI || !relativePath.trim()) return
    setLoadStatus('Loading...')
    try {
      const content = await window.vaultAPI.readFile(`${vaultPath}/${relativePath.trim()}`)
      if (!content) { setLoadStatus('File missing or unreadable'); return }
      setConfig({ refinementManual: content })
      setLoadStatus(`✓ Loaded: ${relativePath.trim()}`)
    } catch {
      setLoadStatus('Load failed')
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Enable toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)' }}>
            Auto Edit Agent
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
            Automatically analyzes and improves vault files at the configured interval
          </div>
        </div>
        <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24, flexShrink: 0 }}>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={e => setConfig({ enabled: e.target.checked })}
            style={{ opacity: 0, width: 0, height: 0 }}
          />
          <span style={{
            position: 'absolute', cursor: 'pointer', inset: 0,
            background: config.enabled ? 'var(--color-info)' : 'var(--color-bg-disabled)',
            borderRadius: 12,
            transition: 'background 0.2s',
          }} />
          <span style={{
            position: 'absolute',
            height: 18, width: 18,
            left: config.enabled ? 23 : 3,
            bottom: 3,
            background: 'white',
            borderRadius: '50%',
            transition: 'left 0.2s',
          }} />
        </label>
      </div>

      {/* Data sync */}
      {(['syncConfluence', 'syncJira'] as const).map(key => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--color-text-primary)' }}>
              {key === 'syncConfluence' ? 'Confluence Auto-import' : 'Jira Auto-import'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 2 }}>
              Fetches and processes changed data automatically on every wake cycle
            </div>
          </div>
          <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24, flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={config[key] ?? false}
              onChange={e => setConfig({ [key]: e.target.checked })}
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <span style={{
              position: 'absolute', cursor: 'pointer', inset: 0,
              background: (config[key] ?? false) ? 'var(--color-info)' : 'var(--color-bg-disabled)',
              borderRadius: 12, transition: 'background 0.2s',
            }} />
            <span style={{
              position: 'absolute', height: 18, width: 18,
              left: (config[key] ?? false) ? 23 : 3, bottom: 3,
              background: 'white', borderRadius: '50%', transition: 'left 0.2s',
            }} />
          </label>
        </div>
      ))}

      {/* Interval */}
      <div>
        <label style={labelStyle}>Wake Interval (minutes)</label>
        <input
          type="number"
          min={1} max={1440}
          value={config.intervalMinutes}
          onChange={e => setConfig({ intervalMinutes: Number(e.target.value) || 30 })}
          style={{ ...inputStyle, width: 120 }}
        />
      </div>

      {/* Model */}
      <div>
        <label style={labelStyle}>Model</label>
        <select
          value={config.modelId}
          onChange={e => setConfig({ modelId: e.target.value })}
          style={{ ...inputStyle, width: 280 }}
        >
          {MODEL_OPTIONS.map(m => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      {/* Refinement manual */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>Refinement Instructions (agent system prompt)</label>
          <button
            onClick={handleLoadLatestManual}
            title="Prefers sections/, otherwise loads the latest full manual"
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 5, fontSize: 11,
              border: '1px solid var(--color-border)',
              background: 'transparent', color: 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
          >
            <RefreshCw size={11} />
            Load Manual
          </button>
        </div>

        {/* Section selection (shown when the sections/ folder is detected) */}
        {hasSections !== false && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                Select Sections <span style={{ opacity: 0.6 }}>(based on the sections/ folder — pick only what you need to save tokens)</span>
              </span>
              <button
                onClick={handleDetectSections}
                style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4,
                  border: '1px solid var(--color-border)', background: 'transparent',
                  color: 'var(--color-text-muted)', cursor: 'pointer' }}
              >
                Detect
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
              {SECTION_DEFS.map(({ file, label }) => (
                <label key={file} style={{ display: 'flex', alignItems: 'center', gap: 4,
                  fontSize: 11, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={selectedSections.includes(file)}
                    onChange={e => setSelectedSections(prev =>
                      e.target.checked ? [...prev, file] : prev.filter(s => s !== file)
                    )}
                  />
                  {label}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Custom path loader */}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            id="manual-path-input"
            type="text"
            placeholder="manual/sections/s03_conversion.md"
            style={{ ...inputStyle, fontSize: 11 }}
          />
          <button
            onClick={() => {
              const el = document.getElementById('manual-path-input') as HTMLInputElement
              handleLoadFromPath(el?.value ?? '')
            }}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '4px 10px', borderRadius: 5, fontSize: 11, flexShrink: 0,
              border: '1px solid var(--color-border)',
              background: 'transparent', color: 'var(--color-text-secondary)',
              cursor: 'pointer',
            }}
          >
            <FolderOpen size={11} />
            Load
          </button>
        </div>

        {loadStatus && (
          <div style={{ fontSize: 11, color: loadStatus.startsWith('✓') ? 'var(--color-success)' : 'var(--color-error)' }}>
            {loadStatus}
          </div>
        )}

        <textarea
          value={config.refinementManual}
          onChange={e => setConfig({ refinementManual: e.target.value })}
          rows={10}
          style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, fontFamily: 'monospace', fontSize: 12 }}
        />
      </div>

      {/* Status + manual trigger */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 14px',
        background: 'var(--color-bg-subtle)',
        borderRadius: 8,
        fontSize: 12,
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ color: 'var(--color-text-muted)' }}>Last run: {lastWakeStr}</div>
          {isRunning && <div style={{ color: 'var(--color-success)', marginTop: 2 }}>● Running now...</div>}
        </div>
        <button
          onClick={handleRunNow}
          disabled={isRunning}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 14px', borderRadius: 6, border: 'none',
            background: isRunning ? 'var(--color-bg-subtle)' : 'var(--color-info-bg)',
            color: isRunning ? 'var(--color-text-muted)' : 'var(--color-info)',
            cursor: isRunning ? 'not-allowed' : 'pointer',
            fontSize: 12,
          }}
        >
          {isRunning ? <Square size={12} /> : <Play size={12} />}
          {isRunning ? 'Running' : 'Run Now'}
        </button>
      </div>
    </div>
  )
}
