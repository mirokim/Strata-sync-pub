/**
 * SlackBotTab — Slack 봇 프로세스 관리 탭.
 * Electron main 프로세스의 bot:start / bot:stop IPC를 통해
 * bot/bot.py --headless 를 spawn/kill 하고 로그를 실시간으로 표시합니다.
 */

import { useState, useEffect, useRef } from 'react'
import { Play, Square } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useBotStore } from '@/stores/botStore'
import { fieldInputStyle } from '../settingsShared'
import { MODEL_OPTIONS } from '@/lib/modelConfig'
import { syncSlackToMcp } from '@/lib/syncMcpConfig'

export default function SlackBotTab() {
  const { slackBotConfig, setSlackBotConfig } = useSettingsStore()
  const { running, setRunning, startBot, stopBot } = useBotStore()

  type LogEntry = { id: string; text: string }
  const [logs, setLogs] = useState<LogEntry[]>([])
  const addLog = (msg: string) =>
    setLogs(prev => [...prev.slice(-500), { id: crypto.randomUUID(), text: msg }])
  const logEndRef = useRef<HTMLDivElement>(null)

  // 초기 상태 동기화 + 버퍼된 로그 불러오기
  useEffect(() => {
    window.botAPI?.getStatus().then(s => setRunning(s.running)).catch(() => {})
    window.botAPI?.getLogs?.().then((lines: string[]) => {
      if (lines?.length) setLogs(lines.slice(-500).map(t => ({ id: crypto.randomUUID(), text: t })))
    }).catch(() => {})
  }, [setRunning])

  // 로그 + 종료 이벤트 구독
  useEffect(() => {
    const offLog     = window.botAPI?.onLog(line => addLog(line))
    const offStopped = window.botAPI?.onStopped(() => setRunning(false))
    return () => { offLog?.(); offStopped?.() }
  }, [setRunning])

  // mcp-config.json 자동 동기화 (1초 디바운스)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!slackBotConfig.botToken && !slackBotConfig.appToken) return
    if (syncTimer.current) clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => syncSlackToMcp(slackBotConfig), 1000)
    return () => { if (syncTimer.current) clearTimeout(syncTimer.current) }
  }, [slackBotConfig])

  // 로그 자동 스크롤
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs])

  const handleStart = async () => {
    const result = await startBot()
    if (result.ok) {
      addLog('▶ 봇 시작됨')
    } else {
      addLog(`❌ 시작 실패: ${result.error}`)
    }
  }

  const handleStop = async () => {
    const result = await stopBot()
    if (!result?.ok) {
      addLog(`■ 봇 정지 실패: ${'알 수 없는 오류'}`)
    } else {
      addLog('■ 봇 정지됨')
    }
  }

  const canStart = slackBotConfig.botToken.trim() && slackBotConfig.appToken.trim()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 0' }}>

      {/* Status card */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px', borderRadius: 2,
        background: running ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)' : 'var(--color-bg-surface)',
        border: `1px solid ${running ? 'color-mix(in srgb, var(--color-accent) 35%, transparent)' : 'var(--color-border)'}`,
        transition: 'border-color 0.2s, background 0.2s',
      }}>
        <div style={{ position: 'relative', width: 9, height: 9, flexShrink: 0 }}>
          <div style={{ width: 9, height: 9, borderRadius: '50%', background: running ? 'var(--color-accent)' : 'var(--color-text-muted)' }} />
          {running && (
            <div style={{
              position: 'absolute', inset: -3, borderRadius: '50%',
              background: 'var(--color-accent)', opacity: 0.25,
              animation: 'slackPing 1.8s ease-out infinite',
            }} />
          )}
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: running ? 'var(--color-accent)' : 'var(--color-text-primary)', lineHeight: 1.3 }}>
            {running ? 'Slack 봇 실행 중' : 'Slack 봇'}
          </div>
          {!canStart && !running && (
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
              토큰을 먼저 입력하세요
            </div>
          )}
        </div>

        <button
          onClick={running ? handleStop : handleStart}
          disabled={!running && !canStart}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '6px 14px', borderRadius: 2, fontSize: 12, fontWeight: 500,
            border: running ? '1px solid var(--color-error-border)' : 'none',
            cursor: (!running && !canStart) ? 'not-allowed' : 'pointer',
            background: running ? 'var(--color-error-bg)' : 'var(--color-accent)',
            color: running ? 'var(--color-error)' : '#fff',
            opacity: (!running && !canStart) ? 0.4 : 1,
            flexShrink: 0, whiteSpace: 'nowrap',
          }}
        >
          {running ? <><Square size={11} /> 정지</> : <><Play size={11} /> 시작</>}
        </button>
      </div>

      <style>{`@keyframes slackPing { 0% { transform: scale(1); opacity: 0.25; } 100% { transform: scale(3); opacity: 0; } }`}</style>

      {/* Credentials */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 10 }}>
          연결 설정
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14, borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }}>Bot Token</label>
            <input
              type="password"
              value={slackBotConfig.botToken}
              onChange={e => setSlackBotConfig({ botToken: e.target.value })}
              placeholder="xoxb-..."
              style={fieldInputStyle}
              spellCheck={false}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }}>App Token</label>
            <input
              type="password"
              value={slackBotConfig.appToken}
              onChange={e => setSlackBotConfig({ appToken: e.target.value })}
              placeholder="xapp-..."
              style={fieldInputStyle}
              spellCheck={false}
            />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }}>응답 모델</label>
            <select
              value={slackBotConfig.model}
              onChange={e => setSlackBotConfig({ model: e.target.value })}
              style={{ ...fieldInputStyle, cursor: 'pointer' }}
            >
              {MODEL_OPTIONS.filter(m => m.provider === 'anthropic').map(m => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)' }}>이미지 업로드</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>볼트 이미지를 Slack에 자동 첨부</div>
            </div>
            <input
              type="checkbox"
              checked={slackBotConfig.sendImages ?? true}
              onChange={e => setSlackBotConfig({ sendImages: e.target.checked })}
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
          </div>
        </div>
      </div>

      {/* Log panel */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-muted)' }}>
            로그
          </div>
          {logs.length > 0 && (
            <button
              onClick={() => setLogs([])}
              style={{ fontSize: 11, color: 'var(--color-text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px', borderRadius: 4 }}
            >
              지우기
            </button>
          )}
        </div>
        <div style={{
          height: 380, overflowY: 'auto',
          background: 'var(--color-bg-base)',
          border: '1px solid var(--color-border)',
          borderRadius: 2, padding: '8px 10px',
          fontFamily: 'monospace', fontSize: 12,
          color: 'var(--color-text-secondary)',
        }}>
          {logs.length === 0
            ? <span style={{ color: 'var(--color-text-muted)' }}>봇을 시작하면 로그가 표시됩니다.</span>
            : logs.map(entry => (
              <div key={entry.id} style={{
                lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                color: (entry.text.startsWith('[ERR]') || entry.text.startsWith('❌')) ? 'var(--color-error)'
                  : entry.text.startsWith('▶') ? 'var(--color-accent)'
                  : undefined,
              }}>{entry.text}</div>
            ))
          }
          <div ref={logEndRef} />
        </div>
      </div>

    </div>
  )
}
