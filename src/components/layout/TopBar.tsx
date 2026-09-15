import { Settings, Terminal, PanelLeft, Type, Bot, ScrollText, User } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useBotStore } from '@/stores/botStore'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import VaultTabs from './VaultTabs'
import BrandLogo from './BrandLogo'

// ── Component ─────────────────────────────────────────────────────────────────

export default function TopBar() {
  const t = useT()
  const {
    graphMode, centerTab,
    leftPanelCollapsed,
    setGraphMode, setCenterTab,
    toggleLeftPanel,
    toggleSettingsPanel,
  } = useUIStore()
  const { toggleNodeLabels } = useSettingsStore()
  const isFast = useSettingsStore(s => s.paragraphRenderQuality === 'fast')
  const showNodeLabels = useSettingsStore(s => s.showNodeLabels)
  const slackConfigured = useSettingsStore(s => !!(s.slackBotConfig?.botToken && s.slackBotConfig?.appToken))
  const { running: botRunning, startBot, stopBot } = useBotStore()

  const isElectron =
    typeof window !== 'undefined' && window.electronAPI?.isElectron === true

  return (
    <div
      className="flex items-center h-9 shrink-0 select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left: favicon + app name */}
      <div className="flex items-center gap-2" style={{ padding: '0 10px', flexShrink: 0, WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <BrandLogo width={142} />
        <span style={{
          fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
          color: 'var(--color-accent)', background: 'var(--color-accent-bg)',
          border: '1px solid var(--color-accent-border-md)',
          borderRadius: 3, padding: '1px 5px',
          lineHeight: 1.4,
        }}>
          {t('beta')}
        </span>
      </div>

      {/* Center: vault tabs */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', alignItems: 'stretch' }}>
        <VaultTabs />
      </div>

      {/* Right: controls — no-drag so buttons are clickable */}
      <div className="flex items-center gap-0.5 px-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>

        {/* ── Group 2: view controls ── */}

        {/* Node label toggle */}
        <button
          onClick={toggleNodeLabels}
          className={cn('flex items-center justify-center w-7 h-7 rounded transition-colors', 'hover:bg-[var(--color-bg-hover)]')}
          style={{ color: showNodeLabels ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
          title={showNodeLabels ? t('Hide node labels') : t('Show node labels')}
          aria-label={t('Toggle node labels')}
        >
          <Type size={13} />
        </button>

        {/* 3D / 2D toggle — hidden in fast mode */}
        {!isFast && (
          <button
            onClick={() => setGraphMode(graphMode === '3d' ? '2d' : '3d')}
            className={cn('flex items-center justify-center h-7 px-1.5 rounded transition-colors', 'hover:bg-[var(--color-bg-hover)]')}
            style={{ color: 'var(--color-text-primary)', fontSize: 10, fontWeight: 700, letterSpacing: '0.04em', border: '1px solid var(--color-border)', minWidth: 28, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
            title={t('{mode} graph — click to switch to {target}', { mode: graphMode.toUpperCase(), target: graphMode === '3d' ? '2D' : '3D' })}
            aria-label={t('Switch to {target} graph', { target: graphMode === '3d' ? '2D' : '3D' })}
            data-testid="graph-mode-toggle"
          >
            {graphMode.toUpperCase()}
          </button>
        )}

        {/* Settings */}
        <button
          onClick={toggleSettingsPanel}
          className={cn('flex items-center justify-center w-7 h-7 rounded transition-colors', 'hover:bg-[var(--color-bg-hover)]')}
          style={{ color: 'var(--color-text-muted)' }}
          title={t('Settings')}
          aria-label={t('Open settings')}
          data-testid="settings-button"
        >
          <Settings size={13} />
        </button>

        {/* DevTools — dev + Electron only */}
        {isElectron && import.meta.env.DEV && (
          <button
            onClick={() => window.windowAPI?.toggleDevTools()}
            className={cn('flex items-center justify-center w-7 h-7 rounded transition-colors', 'hover:bg-[var(--color-bg-hover)]')}
            style={{ color: 'var(--color-text-muted)' }}
            title={t('Developer Tools')}
            aria-label={t('Toggle developer tools')}
          >
            <Terminal size={13} />
          </button>
        )}

        {/* Slack bot — Electron only, shown when token is configured */}
        {isElectron && slackConfigured && (
          <button
            onClick={() => botRunning ? stopBot() : startBot()}
            className={cn('flex items-center gap-1 px-2 h-7 rounded transition-colors', 'hover:bg-[var(--color-bg-hover)]')}
            style={{
              border: `1px solid ${botRunning ? 'var(--color-info-border)' : 'transparent'}`,
              background: botRunning ? 'var(--color-info-bg)' : 'transparent',
              color: botRunning ? 'var(--color-accent)' : 'var(--color-text-muted)',
            }}
            title={botRunning ? t('Stop Slack bot') : t('Start Slack bot')}
            aria-label={t('Toggle Slack bot')}
          >
            <span style={{
              width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
              background: botRunning ? 'var(--color-accent)' : 'var(--color-text-muted)',
              boxShadow: botRunning ? '0 0 4px var(--color-accent)' : 'none',
            }} />
            <Bot size={12} />
          </button>
        )}

        {/* My desk — web mode only (needs the team server's identity) */}
        {!isElectron && (
          <button
            onClick={() => setCenterTab(centerTab === 'me' ? 'graph' : 'me')}
            className={cn('flex items-center justify-center w-7 h-7 rounded transition-colors', 'hover:bg-[var(--color-bg-hover)]')}
            style={{ color: centerTab === 'me' ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
            title={t('My desk')}
            aria-label={t('My desk')}
            data-testid="my-desk-button"
          >
            <User size={13} />
          </button>
        )}

        {/* Slack log viewer */}
        {isElectron && slackConfigured && (
          <button
            onClick={() => setCenterTab(centerTab === 'slack-logs' ? 'graph' : 'slack-logs')}
            className={cn('flex items-center justify-center w-7 h-7 rounded transition-colors', 'hover:bg-[var(--color-bg-hover)]')}
            style={{ color: centerTab === 'slack-logs' ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
            title={t('Slack logs')}
            aria-label={t('Slack logs')}
          >
            <ScrollText size={13} />
          </button>
        )}

        {/* ── Divider ── */}
        <div style={{ width: 1, height: 14, background: 'var(--color-border)', margin: '0 4px' }} />

        {/* ── Group 3: panel layout toggles ── */}
        <button
          onClick={toggleLeftPanel}
          className={cn('flex items-center justify-center w-7 h-7 rounded transition-colors', 'hover:bg-[var(--color-bg-hover)]')}
          style={{ color: leftPanelCollapsed ? 'var(--color-text-muted)' : 'var(--color-text-primary)' }}
          title={leftPanelCollapsed ? t('Open left panel') : t('Close left panel')}
          aria-label={t('Toggle left panel')}
        >
          <PanelLeft size={14} />
        </button>

      </div>

      {/* Spacer — reserves space for OS window controls (titleBarOverlay) */}
      <div style={{ width: 'calc(100vw - env(titlebar-area-width, calc(100vw - 138px)))', flexShrink: 0 }} />
    </div>
  )
}
