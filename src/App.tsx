import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useUIStore } from '@/stores/uiStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useVaultLoader } from '@/hooks/useVaultLoader'
import { usePersonaVaultSaver } from '@/hooks/usePersonaVaultSaver'
import { useRagApi } from '@/hooks/useRagApi'
import { useSettingsStore } from '@/stores/settingsStore'
import { useBotStore } from '@/stores/botStore'
import { useSyncStore } from '@/stores/syncStore'
import { useEditAgent } from '@/hooks/useEditAgent'
import { useEditAgentStore } from '@/stores/editAgentStore'
import { useCronExecutor } from '@/hooks/useCronExecutor'
import LaunchPage from '@/components/launch/LaunchPage'
import MainLayout from '@/components/layout/MainLayout'
import LoadingOverlay from '@/components/layout/LoadingOverlay'
import { useChatStore } from '@/stores/chatStore'

const CRASH_LABELS: Record<string, string> = {
  oom:        '메모리 부족(OOM)으로 재시작했습니다. 볼트 크기를 줄이거나 그래프 필터를 사용해보세요.',
  crashed:    '렌더러 프로세스가 비정상 종료되어 재시작했습니다.',
  killed:     '시스템에 의해 프로세스가 종료되어 재시작했습니다.',
  'gpu-process-crashed': 'GPU 드라이버 오류로 재시작했습니다.',
}

export default function App() {
  const { appState, theme, panelOpacity, setAppState } = useUIStore()
  const [crashBanner, setCrashBanner] = useState<string | null>(() => {
    const p = new URLSearchParams(window.location.search).get('crashed')
    return p ? (CRASH_LABELS[p] ?? `오류(${p})로 재시작했습니다.`) : null
  })
  const { vaultPath, loadVault, loadVaultBackground } = useVaultLoader()
  usePersonaVaultSaver()
  useRagApi()
  useEditAgent()
  useCronExecutor()
  const vaultLoaded = useRef(false)
  const appReady = useRef(false)

  // ── Chat 세션 영속화 ──────────────────────────────────────────────────────
  const { restoreSession } = useChatStore()
  // 앱 시작 시 이전 세션 복원 (debounce 저장은 chatStore 내부 subscriber가 처리)
  useEffect(() => { restoreSession() }, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const botAutoStarted = useRef(false)
  const slackBotConfig = useSettingsStore(s => s.slackBotConfig)
  const { setRunning, startBot } = useBotStore()
  const { notification, dismissNotification } = useSyncStore()
  const { watchDiff, setWatchDiff } = useVaultStore()
  const vaultRefreshCountdown = useEditAgentStore(s => s.vaultRefreshCountdown)
  const { cancelVaultRefreshCountdown } = useEditAgentStore()

  // Skip launch animation when vault is already set (crash recovery / normal restart)
  // LaunchPage is only shown on first use (no vault selected yet)
  useLayoutEffect(() => {
    if (appState === 'launch' && vaultPath) {
      setAppState('main')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply theme to document root
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  // Sync panel opacity CSS variable so all panels update instantly
  useEffect(() => {
    document.documentElement.style.setProperty('--panel-opacity', panelOpacity.toString())
  }, [panelOpacity])

  // Auto-load persisted vault on app startup
  // UI 렌더링 후 지연 실행 — 시작 시 프리징 방지
  useEffect(() => {
    if (vaultLoaded.current || !vaultPath) return
    // 첫 프레임 렌더 완료 후 볼트 로드 시작 (requestIdleCallback → setTimeout fallback)
    const schedule = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 100))
    const id = schedule(() => {
      if (vaultLoaded.current) return
      vaultLoaded.current = true
      loadVault(vaultPath).then(async () => {
        window.vaultAPI?.watchStart(vaultPath)
        // 백그라운드 볼트 프리로드: 추가 지연 후 실행 (메인 볼트 로드 완료 안정화 대기)
        await new Promise(r => setTimeout(r, 2000))
        const { vaults, activeVaultId } = useVaultStore.getState()
        const others = Object.entries(vaults).filter(([vid, e]) => vid !== activeVaultId && e.path)
        if (others.length > 0) {
          const total = others.length
          let done = 0
          for (const [vid, entry] of others) {
            const label = entry.label || entry.path.split(/[/\\]/).pop() || vid
            useVaultStore.getState().setBgLoadingInfo({ label, done, total })
            await loadVaultBackground(vid, entry.path)
            done++
            useVaultStore.getState().setBgLoadingInfo({ label, done, total })
          }
          useVaultStore.getState().setBgLoadingInfo(null)
        }
      })
    })
    return () => {
      if (window.cancelIdleCallback) window.cancelIdleCallback(id as number)
    }
  }, [vaultPath, loadVault, loadVaultBackground])

  // 슬랙봇 자동 시작 — 토큰이 설정되어 있고 Electron 환경일 때
  useEffect(() => {
    if (botAutoStarted.current) return
    if (!window.botAPI) return
    if (!slackBotConfig?.botToken || !slackBotConfig?.appToken) return
    botAutoStarted.current = true

    window.botAPI.getStatus().then(s => {
      if (s.running) {
        setRunning(true)
      } else {
        startBot()
      }
    })
  }, [slackBotConfig, setRunning, startBot])

  return (
    <>
      {appState === 'launch'
        ? <LaunchPage onComplete={() => setAppState('main')} />
        : <MainLayout />}
      <LoadingOverlay />

      {/* Crash recovery banner */}
      {crashBanner && (
        <div style={{
          position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)',
          zIndex: 10000, display: 'flex', alignItems: 'center', gap: 12,
          padding: '10px 16px', borderRadius: 8, maxWidth: 520,
          background: 'rgba(30,20,10,0.95)',
          border: '1px solid var(--color-warning-bg)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.5)',
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-warning)', flexShrink: 0 }} />
          <div style={{ fontSize: 12, color: '#fbbf24', flex: 1, lineHeight: 1.5 }}>
            {crashBanner}
          </div>
          <button
            onClick={() => setCrashBanner(null)}
            style={{
              fontSize: 11, padding: '2px 10px', borderRadius: 4, flexShrink: 0,
              background: 'var(--color-warning-bg)', color: 'var(--color-warning)',
              border: '1px solid rgba(245,158,11,0.3)', cursor: 'pointer',
            }}
          >
            닫기
          </button>
        </div>
      )}

      {/* 파일 변경 diff 알림 배너 */}
      {watchDiff && (
        <div style={{
          position: 'fixed',
          bottom: 70,
          right: 24,
          zIndex: 9998,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '10px 14px',
          borderRadius: 8,
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
          maxWidth: 320,
        }}>
          <span style={{ fontSize: 15, flexShrink: 0, marginTop: 1 }}>📝</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {watchDiff.filePath.split('/').pop()}
            </div>
            <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>
              {watchDiff.added > 0 && <span style={{ color: 'var(--color-success)', marginRight: 6 }}>+{watchDiff.added}</span>}
              {watchDiff.removed > 0 && <span style={{ color: 'var(--color-error)', marginRight: 6 }}>−{watchDiff.removed}</span>}
              {watchDiff.added === 0 && watchDiff.removed === 0 && '변경됨'}
            </div>
            {watchDiff.preview && (
              <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                + {watchDiff.preview}
              </div>
            )}
          </div>
          <button
            onClick={() => setWatchDiff(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: 0, lineHeight: 1, flexShrink: 0 }}
          >
            ×
          </button>
        </div>
      )}

      {/* Edit Agent 볼트 자동 새로고침 카운트다운 배너 */}
      {vaultRefreshCountdown !== null && (
        <div style={{
          position: 'fixed',
          bottom: 24,
          left: '50%',
          transform: 'translateX(-50%)',
          zIndex: 10001,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          padding: '12px 16px',
          borderRadius: 10,
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-border)',
          boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
          minWidth: 300,
          maxWidth: 380,
        }}>
          {/* 상단: 아이콘 + 텍스트 + 버튼 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 16, flexShrink: 0 }}>✏️</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
                Edit Agent가 파일을 수정했습니다
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
                {vaultRefreshCountdown}초 후 볼트를 자동 새로고침합니다
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
              <button
                onClick={() => { cancelVaultRefreshCountdown(); if (vaultPath) void loadVault(vaultPath) }}
                style={{
                  padding: '4px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600,
                  background: 'var(--color-accent)', color: '#fff',
                  border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
                }}
              >
                지금
              </button>
              <button
                onClick={cancelVaultRefreshCountdown}
                style={{
                  padding: '4px 10px', borderRadius: 5, fontSize: 11,
                  background: 'transparent', color: 'var(--color-text-muted)',
                  border: '1px solid var(--color-border)', cursor: 'pointer',
                }}
              >
                취소
              </button>
            </div>
          </div>
          {/* 프로그레스 바 */}
          <div style={{
            height: 3, borderRadius: 2,
            background: 'var(--color-border)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${(vaultRefreshCountdown / 30) * 100}%`,
              background: 'var(--color-accent)',
              borderRadius: 2,
              transition: 'width 0.9s linear',
            }} />
          </div>
        </div>
      )}

      {/* Confluence 자동 동기화 알림 배너 */}
      {notification && (
        <div style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 9999,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '12px 16px',
          borderRadius: 8,
          background: 'var(--color-bg-surface)',
          border: '1px solid var(--color-accent)',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          minWidth: 280,
        }}>
          <span style={{ fontSize: 18 }}>📥</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>
              {notification.message}
            </div>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
              {notification.count}개 문서가 볼트에 업데이트되었습니다.
            </div>
          </div>
          <button
            onClick={dismissNotification}
            style={{
              padding: '4px 12px',
              borderRadius: 5,
              fontSize: 11,
              fontWeight: 600,
              background: 'var(--color-accent)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            확인
          </button>
        </div>
      )}
    </>
  )
}
