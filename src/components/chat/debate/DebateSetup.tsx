/**
 * DebateSetup — Topic input and start button for a new debate.
 * All other settings (mode, participants, roles, rounds, pacing, reference)
 * are configured in Settings > 토론 설정.
 */
import { useState } from 'react'
import { Play, ArrowLeft, Settings } from 'lucide-react'
import { useDebateStore } from '@/stores/debateStore'

interface DebateSetupProps {
  onBack?: () => void
  onOpenSettings?: () => void
}

export function DebateSetup({ onBack, onOpenSettings }: DebateSetupProps) {
  const [topic, setTopic] = useState('')
  const settings = useDebateStore((s) => s.settings)
  const startDebate = useDebateStore((s) => s.startDebate)

  const { mode, maxRounds, selectedProviders, roles, judgeProvider, useReference, referenceText, referenceFiles, pacingMode, autoDelay } = settings

  const canStart =
    topic.trim().length > 0 &&
    selectedProviders.length >= 2 &&
    (mode !== 'battle' || (selectedProviders.length >= 3 && judgeProvider !== null))

  const handleStart = () => {
    if (!canStart) return
    startDebate({
      mode,
      topic: topic.trim(),
      maxRounds,
      selectedProviders,
      roles: mode === 'roleAssignment' || mode === 'battle' ? roles : [],
      judgeProvider: mode === 'battle' ? (judgeProvider ?? undefined) : undefined,
      referenceText: useReference ? referenceText : '',
      useReference,
      referenceFiles: useReference ? referenceFiles : [],
      pacingMode,
      autoDelay,
    })
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-xl mx-auto px-4 py-6 space-y-5">
        {/* Back to Chat */}
        {onBack && (
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs transition"
            style={{ color: 'var(--color-text-muted)' }}
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            채팅으로 돌아가기
          </button>
        )}

        {/* Topic */}
        <div className="space-y-1.5">
          <label
            className="block text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: 'var(--color-text-muted)' }}
          >
            토론 주제
          </label>
          <textarea
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="토론 주제를 입력하세요..."
            className="w-full px-3 py-2.5 text-sm rounded-lg resize-none focus:outline-none transition"
            style={{
              background: 'var(--color-bg-surface)',
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-primary)',
            }}
            rows={2}
          />
        </div>

        {/* Validation messages */}
        {selectedProviders.length < 2 && (
          <p className="text-[11px]" style={{ color: '#ff9800' }}>
            설정에서 2개 이상의 AI를 선택하세요.{' '}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="underline transition"
                style={{ color: 'var(--color-accent)' }}
              >
                토론 설정 열기
              </button>
            )}
          </p>
        )}
        {mode === 'battle' && selectedProviders.length >= 2 && selectedProviders.length < 3 && (
          <p className="text-[11px]" style={{ color: '#ff9800' }}>
            결전모드는 3개의 AI가 필요합니다 (토론자 2 + 심판 1)
          </p>
        )}

        {/* Start Button */}
        <button
          onClick={handleStart}
          disabled={!canStart}
          className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg font-semibold text-sm transition-all active:scale-[0.98]"
          style={
            canStart
              ? { background: 'var(--color-accent)', color: '#fff' }
              : { background: 'var(--color-bg-surface)', color: 'var(--color-text-muted)', cursor: 'not-allowed' }
          }
        >
          <Play className="w-4 h-4" />
          {mode === 'battle' ? '결전 시작' : '토론 시작'}
        </button>

        {/* Settings shortcut */}
        {onOpenSettings && (
          <button
            onClick={onOpenSettings}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-xs transition"
            style={{
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-muted)',
            }}
          >
            <Settings className="w-3.5 h-3.5" />
            토론 설정
          </button>
        )}
      </div>
    </div>
  )
}
