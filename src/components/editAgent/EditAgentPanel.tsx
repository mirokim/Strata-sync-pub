import { useUIStore } from '@/stores/uiStore'
import { useEditAgentStore } from '@/stores/editAgentStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import EditAgentChat from './EditAgentChat'
import EditAgentLog from './EditAgentLog'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import { MessageSquare, ScrollText, X, Pencil, RefreshCw } from 'lucide-react'

export default function EditAgentPanel() {
  const subTab    = useUIStore(s => s.editAgentSubTab)
  const setSubTab = useUIStore(s => s.setEditAgentSubTab)
  const toggle    = useUIStore(s => s.toggleEditAgentPanel)
  const isRunning = useEditAgentStore(s => s.isRunning)
  const countdown = useEditAgentStore(s => s.vaultRefreshCountdown)
  const { cancelVaultRefreshCountdown } = useEditAgentStore()
  const vaultPath = useVaultStore(s => s.vaultPath)
  const { loadVault } = useVaultLoader()
  // Countdown ticking is handled by useEditAgent (global hook in App.tsx)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--color-bg-secondary)',
      borderLeft: '1px solid var(--color-border)',
    }}>

      {/* ── Header ───────────────────────────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center',
        height: 36, padding: '0 4px 0 12px',
        borderBottom: '1px solid var(--color-border)',
        flexShrink: 0, gap: 2,
      }}>
        {/* Title */}
        <span style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 11, fontWeight: 600, letterSpacing: '0.04em',
          color: 'var(--color-text-muted)', textTransform: 'uppercase',
          flex: 1,
        }}>
          <Pencil size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
          Edit Agent
          {/* Running indicator inline */}
          {isRunning && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontSize: 9, fontWeight: 600, letterSpacing: '0.05em',
              color: 'var(--color-accent)',
              background: 'var(--color-accent-bg)',
              border: '1px solid var(--color-accent-border)',
              borderRadius: 3, padding: '1px 5px',
            }}>
              <span style={{
                width: 4, height: 4, borderRadius: '50%',
                background: 'var(--color-accent)',
                animation: 'ea-pulse 1.4s ease-in-out infinite',
                flexShrink: 0,
              }} />
              RUN
            </span>
          )}
          {/* Vault refresh countdown badge */}
          {countdown !== null && (
            <span
              title="편집된 파일을 반영하기 위해 볼트를 자동 새로고침합니다"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 3,
                fontSize: 9, fontWeight: 600, letterSpacing: '0.04em',
                color: 'var(--color-text-muted)',
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 3, padding: '1px 5px',
                cursor: 'pointer',
              }}
              onClick={() => {
                cancelVaultRefreshCountdown()
                if (vaultPath) void loadVault(vaultPath)
              }}
            >
              <RefreshCw size={8} style={{ opacity: 0.7 }} />
              {countdown}s
            </span>
          )}
        </span>

        {/* Tabs */}
        {(['chat', 'log'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setSubTab(tab)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4,
              padding: '0 9px', height: 36, border: 'none',
              borderBottom: subTab === tab
                ? '1px solid var(--color-text-primary)'
                : '1px solid transparent',
              background: 'transparent',
              color: subTab === tab
                ? 'var(--color-text-primary)'
                : 'var(--color-text-muted)',
              cursor: 'pointer', fontSize: 11, fontWeight: 500,
              transition: 'color 0.12s',
            }}
          >
            {tab === 'chat' ? <MessageSquare size={11} /> : <ScrollText size={11} />}
            {tab === 'chat' ? 'Chat' : 'Log'}
          </button>
        ))}

        {/* Close */}
        <button
          onClick={toggle}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, borderRadius: 5, border: 'none',
            background: 'transparent', color: 'var(--color-text-muted)',
            cursor: 'pointer', marginLeft: 2, flexShrink: 0,
            transition: 'background 0.12s, color 0.12s',
          }}
          onMouseEnter={e => {
            const b = e.currentTarget
            b.style.background = 'var(--color-bg-hover)'
            b.style.color = 'var(--color-text-primary)'
          }}
          onMouseLeave={e => {
            const b = e.currentTarget
            b.style.background = 'transparent'
            b.style.color = 'var(--color-text-muted)'
          }}
        >
          <X size={13} />
        </button>
      </div>

      {/* ── Content ──────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, overflow: 'hidden', minHeight: 0 }}>
        <ErrorBoundary>
          {subTab === 'chat' ? <EditAgentChat /> : <EditAgentLog />}
        </ErrorBoundary>
      </div>

      <style>{`
        @keyframes ea-pulse {
          0%, 100% { opacity: 1; }
          50%       { opacity: 0.35; }
        }
      `}</style>
    </div>
  )
}
