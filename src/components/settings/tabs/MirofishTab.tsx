/**
 * MirofishTab — Settings > MiroFish 시뮬레이터 탭
 *
 * 레이아웃:
 *   시뮬레이션 설정 (주제, 라운드, 모델 등)
 *   실행 제어 (시작/정지, 진행 상황)
 *   페르소나 목록 (수동 편집)
 *   피드 (실시간 반응)
 *   보고서 (완료 후)
 */

import { useRef, useEffect, useState } from 'react'
import { Play, Square, Plus, Trash2, RotateCcw, Save, Clock, History, ChevronDown, ChevronRight } from 'lucide-react'
import { useMiroStore } from '@/stores/miroStore'
import { MODEL_OPTIONS } from '@/lib/modelConfig'
import type { MirofishPersona, MirofishScheduledTopic, MirofishHistoryEntry } from '@/services/mirofish/types'

// ── 색상 매핑 ─────────────────────────────────────────────────────────────────

const STANCE_COLOR: Record<MirofishPersona['stance'], string> = {
  supportive: 'var(--color-accent)',
  opposing:   'var(--color-error)',
  neutral:    'var(--color-text-secondary)',
  observer:   'var(--color-text-muted)',
}

const STANCE_LABEL: Record<MirofishPersona['stance'], string> = {
  supportive: '지지',
  opposing:   '반대',
  neutral:    '중립',
  observer:   '관찰',
}

// ── 하위 컴포넌트 ─────────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
      textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 10,
    }}>
      {children}
    </div>
  )
}

function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{
      padding: 14, borderRadius: 2,
      background: 'var(--color-bg-surface)',
      border: '1px solid var(--color-border)',
      ...style,
    }}>
      {children}
    </div>
  )
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function MirofishTab() {
  const {
    config, simState,
    setConfig, setPersonas, addPersona, removePersona, updatePersona,
    startSimulation, stopSimulation, resetSimulation,
    presets, savePreset, loadPreset, deletePreset,
    scheduledTopics, addScheduledTopic, updateScheduledTopic, deleteScheduledTopic,
    simulationHistory, deleteHistoryEntry, clearHistory,
  } = useMiroStore()

  const [presetName, setPresetName] = useState('')
  const [newSched, setNewSched] = useState<Omit<MirofishScheduledTopic, 'id'>>({
    topic: '', numPersonas: 5, numRounds: 3, time: '09:00', enabled: true,
  })
  const [vaultToast, setVaultToast] = useState<'saved' | 'copied' | 'error' | null>(null)

  const feedEndRef = useRef<HTMLDivElement>(null)

  // 피드 자동 스크롤
  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [simState.feed, simState.streamingPost])

  const isRunning  = simState.status === 'running' || simState.status === 'generating-personas' || simState.status === 'generating-report'
  const isDone     = simState.status === 'done'
  const canStart   = config.topic.trim().length > 0 && config.personas.length > 0

  const statusText: Record<typeof simState.status, string> = {
    idle:                '대기 중',
    'generating-personas': '페르소나 생성 중...',
    running:             `라운드 ${simState.currentRound} / ${simState.totalRounds} 진행 중...`,
    'generating-report': '보고서 작성 중...',
    done:                '완료',
    error:               `오류: ${simState.errorMessage ?? ''}`,
  }

  // 볼트에 저장
  const saveToVault = async () => {
    if (!simState.report) return
    const date = new Date().toISOString().split('T')[0]
    const slug = config.topic.slice(0, 30).replace(/\s+/g, '_').replace(/[^\w가-힣_-]/g, '')
    const filename = `MiroFish_${slug}_${date}.md`
    const content = `---\ndate: ${date}\ntags: [mirofish, simulation]\n---\n\n# MiroFish 시뮬레이션: ${config.topic}\n\n${simState.report}`
    try {
      const result = await window.vaultAPI?.saveFile?.(filename, content)
      if (result?.success) {
        setVaultToast('saved')
      } else {
        await navigator.clipboard.writeText(content)
        setVaultToast('copied')
      }
    } catch {
      setVaultToast('error')
    }
    setTimeout(() => setVaultToast(null), 3000)
  }

  const copyReport = () => navigator.clipboard.writeText(simState.report)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ── 시뮬레이션 설정 ─────────────────────────────────────────────── */}
      <div>
        <SectionLabel>시뮬레이션 설정</SectionLabel>
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

            {/* 주제 */}
            <div>
              <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }}>
                주제 / 시나리오
              </label>
              <input
                value={config.topic}
                onChange={e => setConfig({ topic: e.target.value })}
                placeholder="예: 새 캐릭터 출시, 가격 인상 발표, 신규 기능 홍보..."
                disabled={isRunning}
                style={{
                  width: '100%', fontSize: 13, padding: '7px 10px', borderRadius: 2,
                  background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                  color: 'var(--color-text-primary)', outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>

            {/* 숫자 설정 행 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }}>
                  페르소나 수 (3–50)
                </label>
                <input
                  type="number" min={3} max={50} value={config.numPersonas}
                  onChange={e => setConfig({ numPersonas: Math.max(3, Math.min(50, +e.target.value)) })}
                  disabled={isRunning}
                  style={{
                    width: '100%', fontSize: 13, padding: '7px 10px', borderRadius: 2, textAlign: 'right',
                    background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                    color: 'var(--color-text-primary)', outline: 'none',
                  }}
                />
              </div>
              <div>
                <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }}>
                  라운드 수 (2–10)
                </label>
                <input
                  type="number" min={2} max={10} value={config.numRounds}
                  onChange={e => setConfig({ numRounds: Math.max(2, Math.min(10, +e.target.value)) })}
                  disabled={isRunning}
                  style={{
                    width: '100%', fontSize: 13, padding: '7px 10px', borderRadius: 2, textAlign: 'right',
                    background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                    color: 'var(--color-text-primary)', outline: 'none',
                  }}
                />
              </div>
            </div>

            {/* 모델 선택 */}
            <div>
              <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }}>
                모델
              </label>
              <select
                value={config.modelId}
                onChange={e => setConfig({ modelId: e.target.value })}
                disabled={isRunning}
                style={{
                  width: '100%', fontSize: 13, padding: '7px 10px', borderRadius: 2,
                  background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                  color: 'var(--color-text-primary)', outline: 'none', cursor: 'pointer',
                }}
              >
                {MODEL_OPTIONS.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            {/* 자동 생성 토글 */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: isRunning ? 'not-allowed' : 'pointer' }}>
              <input
                type="checkbox"
                checked={config.autoGeneratePersonas}
                onChange={e => setConfig({ autoGeneratePersonas: e.target.checked })}
                disabled={isRunning}
              />
              <span style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
                페르소나 주제에 맞게 자동 생성
              </span>
              <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                (LLM이 주제 분석 후 페르소나 생성)
              </span>
            </label>

            {/* 이미지 직접 전달 토글 */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <span style={{ fontSize: 13, color: 'var(--color-text-primary)' }}>
                  이미지 직접 전달
                </span>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)', marginLeft: 6 }}>
                  {config.imageDirectPass ? '각 페르소나가 이미지 직접 인식 (토큰 多)' : '이미지를 텍스트 설명으로 변환 후 공유 (토큰 少)'}
                </span>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={config.imageDirectPass}
                onClick={() => setConfig({ imageDirectPass: !config.imageDirectPass })}
                disabled={isRunning}
                className="shrink-0 ml-4 w-9 h-5 rounded-full transition-colors"
                style={{
                  background: config.imageDirectPass ? 'var(--color-accent)' : 'var(--color-bg-hover)',
                  border: '1px solid var(--color-border)',
                  opacity: isRunning ? 0.5 : 1,
                }}
              >
                <span
                  className="block w-3.5 h-3.5 rounded-full bg-white transition-transform"
                  style={{ transform: config.imageDirectPass ? 'translateX(18px)' : 'translateX(2px)', marginTop: 2 }}
                />
              </button>
            </div>

          </div>
        </Card>
      </div>

      {/* ── 실행 제어 ───────────────────────────────────────────────────── */}
      <div>
        <SectionLabel>실행 제어</SectionLabel>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 14px', borderRadius: 2,
          background: isRunning
            ? 'color-mix(in srgb, var(--color-accent) 8%, transparent)'
            : isDone ? 'color-mix(in srgb, var(--color-success) 8%, transparent)' : 'var(--color-bg-surface)',
          border: `1px solid ${isRunning ? 'color-mix(in srgb, var(--color-accent) 35%, transparent)' : isDone ? 'color-mix(in srgb, var(--color-success) 25%, transparent)' : 'var(--color-border)'}`,
          transition: 'border-color 0.2s, background 0.2s',
        }}>
          {/* 상태 dot */}
          <div style={{ position: 'relative', width: 9, height: 9, flexShrink: 0 }}>
            <div style={{
              width: 9, height: 9, borderRadius: '50%',
              background: isRunning ? 'var(--color-accent)' : isDone ? 'var(--color-success)' : 'var(--color-text-muted)',
            }} />
            {isRunning && (
              <div style={{
                position: 'absolute', inset: -3, borderRadius: '50%',
                background: 'var(--color-accent)', opacity: 0.25,
                animation: 'miroPing 1.8s ease-out infinite',
              }} />
            )}
          </div>

          <div style={{ flex: 1, fontSize: 13, color: isRunning ? 'var(--color-accent)' : isDone ? 'var(--color-success)' : 'var(--color-text-primary)' }}>
            {statusText[simState.status]}
          </div>

          {isDone && (
            <button
              onClick={resetSimulation}
              style={{
                display: 'flex', alignItems: 'center', gap: 5,
                padding: '5px 10px', borderRadius: 2, fontSize: 11,
                background: 'none', border: '1px solid var(--color-border)',
                color: 'var(--color-text-muted)', cursor: 'pointer',
              }}
            >
              <RotateCcw size={10} /> 초기화
            </button>
          )}

          <button
            onClick={isRunning ? stopSimulation : startSimulation}
            disabled={!isRunning && !canStart}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 14px', borderRadius: 2, fontSize: 12, fontWeight: 500,
              border: isRunning ? '1px solid var(--color-error-border)' : 'none',
              cursor: (!isRunning && !canStart) ? 'not-allowed' : 'pointer',
              background: isRunning ? 'var(--color-error-bg)' : 'var(--color-accent)',
              color: isRunning ? 'var(--color-error)' : '#fff',
              opacity: (!isRunning && !canStart) ? 0.4 : 1,
              flexShrink: 0, whiteSpace: 'nowrap',
            }}
          >
            {isRunning ? <><Square size={11} /> 정지</> : <><Play size={11} /> 시작</>}
          </button>
        </div>
        <style>{`@keyframes miroPing { 0% { transform: scale(1); opacity: 0.25; } 100% { transform: scale(3); opacity: 0; } }`}</style>
      </div>

      {/* ── 페르소나 편집 ───────────────────────────────────────────────── */}
      {!config.autoGeneratePersonas && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <SectionLabel>페르소나 목록</SectionLabel>
            <button
              onClick={addPersona}
              disabled={isRunning || config.personas.length >= 50}
              style={{
                display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 8px',
                borderRadius: 2, border: '1px solid var(--color-border)',
                background: 'none', color: 'var(--color-text-muted)', cursor: 'pointer',
              }}
            >
              <Plus size={10} /> 추가
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {config.personas.slice(0, config.numPersonas).map(p => (
              <PersonaCard
                key={p.id}
                persona={p}
                disabled={isRunning}
                onUpdate={(partial) => updatePersona(p.id, partial)}
                onRemove={() => removePersona(p.id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* ── 페르소나 프리셋 ─────────────────────────────────────────────── */}
      <div>
        <SectionLabel>페르소나 프리셋</SectionLabel>
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* 현재 페르소나 저장 */}
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={presetName}
                onChange={e => setPresetName(e.target.value)}
                placeholder="프리셋 이름..."
                style={{
                  flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 2,
                  background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                  color: 'var(--color-text-primary)', outline: 'none',
                }}
              />
              <button
                onClick={() => { if (presetName.trim()) { savePreset(presetName.trim()); setPresetName('') } }}
                disabled={!presetName.trim() || config.personas.length === 0}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '5px 10px', borderRadius: 2, fontSize: 11,
                  background: 'var(--color-accent)', border: 'none', color: '#fff',
                  cursor: presetName.trim() ? 'pointer' : 'not-allowed',
                  opacity: presetName.trim() && config.personas.length > 0 ? 1 : 0.4,
                }}
              >
                <Save size={10} /> 저장
              </button>
            </div>
            {/* 저장된 프리셋 목록 */}
            {presets.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center', padding: '6px 0' }}>
                저장된 프리셋 없음
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {presets.map(preset => (
                  <div key={preset.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', borderRadius: 2,
                    background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                  }}>
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--color-text-primary)' }}>
                      {preset.name}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
                      {preset.personas.length}명
                    </span>
                    <button
                      onClick={() => loadPreset(preset.id)}
                      style={{ ...btnStyle, fontSize: 10, padding: '3px 8px' }}
                    >
                      불러오기
                    </button>
                    <button
                      onClick={() => deletePreset(preset.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-error)', padding: 2 }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ── 자동 실행 스케줄 ─────────────────────────────────────────────── */}
      <div>
        <SectionLabel>자동 실행 스케줄</SectionLabel>
        <Card>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* 새 스케줄 추가 */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={newSched.topic}
                  onChange={e => setNewSched(s => ({ ...s, topic: e.target.value }))}
                  placeholder="주제..."
                  style={{
                    flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 2,
                    background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                    color: 'var(--color-text-primary)', outline: 'none',
                  }}
                />
                <input
                  type="time"
                  value={newSched.time}
                  onChange={e => setNewSched(s => ({ ...s, time: e.target.value }))}
                  style={{
                    fontSize: 12, padding: '5px 8px', borderRadius: 2,
                    background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                    color: 'var(--color-text-primary)', outline: 'none',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>페르소나</span>
                <input
                  type="number" min={3} max={50} value={newSched.numPersonas}
                  onChange={e => setNewSched(s => ({ ...s, numPersonas: Math.max(3, Math.min(50, +e.target.value)) }))}
                  style={{
                    width: 50, fontSize: 12, padding: '4px 6px', borderRadius: 2, textAlign: 'right',
                    background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                    color: 'var(--color-text-primary)', outline: 'none',
                  }}
                />
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>명  라운드</span>
                <input
                  type="number" min={2} max={10} value={newSched.numRounds}
                  onChange={e => setNewSched(s => ({ ...s, numRounds: Math.max(2, Math.min(10, +e.target.value)) }))}
                  style={{
                    width: 50, fontSize: 12, padding: '4px 6px', borderRadius: 2, textAlign: 'right',
                    background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
                    color: 'var(--color-text-primary)', outline: 'none',
                  }}
                />
                <button
                  onClick={() => { if (newSched.topic.trim()) { addScheduledTopic(newSched); setNewSched(s => ({ ...s, topic: '' })) } }}
                  disabled={!newSched.topic.trim()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 4,
                    padding: '5px 10px', borderRadius: 2, fontSize: 11, marginLeft: 'auto',
                    background: 'var(--color-accent)', border: 'none', color: '#fff',
                    cursor: newSched.topic.trim() ? 'pointer' : 'not-allowed',
                    opacity: newSched.topic.trim() ? 1 : 0.4,
                  }}
                >
                  <Clock size={10} /> 추가
                </button>
              </div>
            </div>
            {/* 스케줄 목록 */}
            {scheduledTopics.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center', padding: '4px 0' }}>
                등록된 스케줄 없음
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {scheduledTopics.map(sched => (
                  <div key={sched.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 10px', borderRadius: 2,
                    background: 'var(--color-bg-base)', border: `1px solid ${sched.enabled ? 'color-mix(in srgb, var(--color-accent) 35%, transparent)' : 'var(--color-border)'}`,
                    opacity: sched.enabled ? 1 : 0.5,
                  }}>
                    <span style={{ fontSize: 11, color: 'var(--color-accent)', fontFamily: 'monospace', flexShrink: 0 }}>
                      {sched.time}
                    </span>
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {sched.topic}
                    </span>
                    <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0 }}>
                      {sched.numPersonas}명 {sched.numRounds}라운드
                    </span>
                    <button
                      onClick={() => updateScheduledTopic(sched.id, { enabled: !sched.enabled })}
                      style={{
                        fontSize: 10, padding: '2px 6px', borderRadius: 2,
                        background: sched.enabled ? 'color-mix(in srgb, var(--color-accent) 15%, transparent)' : 'none',
                        border: `1px solid ${sched.enabled ? 'color-mix(in srgb, var(--color-accent) 40%, transparent)' : 'var(--color-border)'}`,
                        color: sched.enabled ? 'var(--color-accent)' : 'var(--color-text-muted)',
                        cursor: 'pointer',
                      }}
                    >
                      {sched.enabled ? 'ON' : 'OFF'}
                    </button>
                    <button
                      onClick={() => deleteScheduledTopic(sched.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-error)', padding: 2 }}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ── 피드 ────────────────────────────────────────────────────────── */}
      {(simState.feed.length > 0 || simState.streamingPost) && (
        <div>
          <SectionLabel>반응 피드</SectionLabel>
          <div style={{
            height: 240, overflowY: 'auto',
            background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
            borderRadius: 2, padding: '8px 10px',
            fontFamily: 'monospace', fontSize: 12,
            color: 'var(--color-text-secondary)',
          }}>
            {simState.feed.map((post, i) => (
              <div key={i} style={{ lineHeight: 1.6, marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>[R{post.round}] </span>
                <span style={{ color: STANCE_COLOR[post.stance], fontWeight: 600 }}>
                  {post.personaName}
                </span>
                <span style={{ color: 'var(--color-text-muted)', fontSize: 10 }}> ({STANCE_LABEL[post.stance]})</span>
                <span style={{ color: 'var(--color-text-primary)' }}>: {post.content}</span>
              </div>
            ))}

            {/* 스트리밍 포스트 */}
            {simState.streamingPost && (
              <div style={{ lineHeight: 1.6, marginBottom: 6, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>[R{simState.currentRound + 1}] </span>
                <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
                  {config.personas.find(p => p.id === simState.streamingPost!.personaId)?.name ?? '...'}
                </span>
                <span style={{ color: 'var(--color-text-primary)' }}>: {simState.streamingPost.content}</span>
                <span style={{ animation: 'blink 1s step-end infinite', color: 'var(--color-accent)' }}>▌</span>
              </div>
            )}
            <div ref={feedEndRef} />
          </div>
          <style>{`@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }`}</style>
        </div>
      )}

      {/* ── 보고서 ──────────────────────────────────────────────────────── */}
      {isDone && simState.report && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <SectionLabel>분석 보고서</SectionLabel>
            <div style={{ display: 'flex', gap: 6 }}>
              <button onClick={copyReport} style={btnStyle}>복사</button>
              <button onClick={saveToVault} style={btnStyle}>
                {vaultToast === 'saved' ? '✓ 저장됨' : vaultToast === 'copied' ? '클립보드 복사' : vaultToast === 'error' ? '저장 실패' : '볼트에 저장'}
              </button>
            </div>
          </div>
          <div style={{
            maxHeight: 320, overflowY: 'auto',
            padding: 14, borderRadius: 2,
            background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)',
            fontSize: 13, lineHeight: 1.7, color: 'var(--color-text-primary)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}>
            {simState.report}
          </div>
        </div>
      )}

      {/* ── 시뮬레이션 히스토리 ──────────────────────────────────────────── */}
      {simulationHistory.length > 0 && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <SectionLabel>시뮬레이션 이력 ({simulationHistory.length})</SectionLabel>
            <button
              onClick={clearHistory}
              style={{ fontSize: 11, padding: '2px 8px', borderRadius: 2, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer' }}
            >
              전체 삭제
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {simulationHistory.map(entry => (
              <HistoryCard
                key={entry.id}
                entry={entry}
                onDelete={() => deleteHistoryEntry(entry.id)}
                onRerun={() => {
                  setConfig({ topic: entry.topic, numPersonas: entry.numPersonas, numRounds: entry.numRounds, autoGeneratePersonas: true })
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
              />
            ))}
          </div>
        </div>
      )}

    </div>
  )
}

// ── 히스토리 카드 ─────────────────────────────────────────────────────────────

function HistoryCard({ entry, onDelete, onRerun }: { entry: MirofishHistoryEntry; onDelete: () => void; onRerun: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const date = new Date(entry.createdAt).toLocaleString('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const stanceCounts = entry.feed.reduce<Record<string, number>>((acc, p) => {
    acc[p.stance] = (acc[p.stance] ?? 0) + 1; return acc
  }, {})

  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 2, background: 'var(--color-bg-surface)', overflow: 'hidden' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {entry.topic}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>
            {date} · {entry.numPersonas}명 · {entry.numRounds}라운드 · 반응 {entry.feed.length}개
            {Object.entries(stanceCounts).map(([s, n]) => (
              <span key={s} style={{ marginLeft: 6, color: s === 'supportive' ? 'var(--color-accent)' : s === 'opposing' ? 'var(--color-error)' : 'var(--color-text-muted)' }}>
                {s === 'supportive' ? '지지' : s === 'opposing' ? '반대' : s === 'neutral' ? '중립' : '관찰'} {n}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 4 }} onClick={e => e.stopPropagation()}>
          <button onClick={onRerun} title="이 주제로 재실행" style={{ fontSize: 11, padding: '2px 6px', borderRadius: 2, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
            재실행
          </button>
          <button onClick={onDelete} title="삭제" style={{ padding: '2px 4px', borderRadius: 2, border: 'none', background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer' }}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '10px 12px', maxHeight: 260, overflowY: 'auto' }}>
          <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
            {entry.report}
          </div>
        </div>
      )}
    </div>
  )
}

// ── 페르소나 카드 ─────────────────────────────────────────────────────────────

function PersonaCard({
  persona, disabled, onUpdate, onRemove,
}: {
  persona: MirofishPersona
  disabled: boolean
  onUpdate: (p: Partial<MirofishPersona>) => void
  onRemove: () => void
}) {
  const inp = (style?: React.CSSProperties): React.CSSProperties => ({
    fontSize: 12, padding: '4px 8px', borderRadius: 2,
    background: 'var(--color-bg-base)', border: '1px solid var(--color-border)',
    color: 'var(--color-text-primary)', outline: 'none',
    ...style,
  })

  return (
    <div style={{
      padding: '10px 12px', borderRadius: 2,
      border: `1px solid var(--color-border)`,
      background: 'var(--color-bg-surface)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* 이름 */}
        <input
          value={persona.name}
          onChange={e => onUpdate({ name: e.target.value })}
          disabled={disabled}
          placeholder="이름"
          style={inp({ flex: 1 })}
        />
        {/* 입장 */}
        <select
          value={persona.stance}
          onChange={e => onUpdate({ stance: e.target.value as MirofishPersona['stance'] })}
          disabled={disabled}
          style={inp({ color: STANCE_COLOR[persona.stance] })}
        >
          <option value="supportive">지지</option>
          <option value="opposing">반대</option>
          <option value="neutral">중립</option>
          <option value="observer">관찰</option>
        </select>
        {/* 활성도 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>활성도</span>
          <input
            type="number" min={0.1} max={1} step={0.1}
            value={persona.activityLevel}
            onChange={e => onUpdate({ activityLevel: Math.max(0.1, Math.min(1, +e.target.value)) })}
            disabled={disabled}
            style={inp({ width: 52, textAlign: 'right' })}
          />
        </div>
        <button
          onClick={onRemove}
          disabled={disabled}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-error)', padding: 4, flexShrink: 0 }}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {/* 시스템 프롬프트 */}
      <textarea
        value={persona.systemPrompt}
        onChange={e => onUpdate({ systemPrompt: e.target.value })}
        disabled={disabled}
        rows={2}
        placeholder="이 페르소나의 관점과 말투를 설명하세요..."
        style={{
          ...inp({ width: '100%', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, boxSizing: 'border-box' }),
        }}
      />
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  fontSize: 11, padding: '4px 10px', borderRadius: 2,
  background: 'none', border: '1px solid var(--color-border)',
  color: 'var(--color-text-muted)', cursor: 'pointer',
}
