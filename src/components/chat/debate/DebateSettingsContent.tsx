/**
 * DebateSettingsContent — Debate configuration UI for SettingsPanel.
 * Participants are personas (chief_director, art_director, …), not raw providers.
 * A persona is "enabled" when its assigned model's provider has an API key configured.
 */
import { useMemo, useRef } from 'react'
import { AlertCircle, FileText, Upload, X } from 'lucide-react'
import { useDebateStore } from '@/stores/debateStore'
import { useSettingsStore, getApiKey } from '@/stores/settingsStore'
import { getProviderForModel } from '@/lib/modelConfig'
import { SPEAKER_IDS, SPEAKER_CONFIG } from '@/lib/speakerConfig'
import { generateId } from '@/lib/utils'
import {
  ROLE_OPTIONS,
  ROLE_GROUPS,
  DEBATE_MAX_FILES,
  DEBATE_ACCEPTED_TYPES,
  DEBATE_ACCEPTED_EXTENSIONS,
  readFileAsDataUrl,
} from '@/services/debateRoles'
import { MAX_FILE_SIZE } from '@/lib/constants'
import type { DiscussionMode, ReferenceFile } from '@/types'

const DEBATE_MODES: DiscussionMode[] = ['roundRobin', 'freeDiscussion', 'roleAssignment', 'battle']

const MODE_LABELS: Record<DiscussionMode, string> = {
  roundRobin: '라운드 로빈',
  freeDiscussion: '자유 토론',
  roleAssignment: '역할 배정',
  battle: '결전모드',
}

const MODE_DESCRIPTIONS: Record<DiscussionMode, string> = {
  roundRobin: 'AI들이 순서대로 돌아가며 발언합니다',
  freeDiscussion: 'AI들이 자유롭게 서로의 의견에 반박/동의합니다',
  roleAssignment: '각 AI에 캐릭터/역할을 부여하여 토론합니다',
  battle: 'AI 2명이 대결하고 1명이 심판으로 채점합니다',
}

const DELAY_OPTIONS = [5, 10, 15, 30] as const
const REF_MAX_LENGTH = 10_000

const ROLE_LABEL_MAP = new Map(ROLE_OPTIONS.map((r) => [r.value, r.label]))

export function DebateSettingsContent() {
  const settings = useDebateStore((s) => s.settings)
  const updateSettings = useDebateStore((s) => s.updateSettings)
  const toggleProvider = useDebateStore((s) => s.toggleProvider)
  const updateRole = useDebateStore((s) => s.updateRole)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const {
    mode, maxRounds, selectedProviders, roles, judgeProvider,
    useReference, referenceText, referenceFiles, pacingMode, autoDelay,
  } = settings

  // Personas whose assigned model's provider has an API key set
  const apiKeys = useSettingsStore(s => s.apiKeys)
  const personaModels = useSettingsStore(s => s.personaModels)
  const enabledProviders = useMemo(
    () => SPEAKER_IDS.filter((p) => {
      const model = (personaModels as Record<string, string>)[p]
      if (!model) return false
      const provider = getProviderForModel(model)
      if (!provider) return false
      return Boolean(getApiKey(provider))
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiKeys, personaModels],
  )

  const handleFileUpload = async (fileList: FileList | null) => {
    if (!fileList) return
    const newFiles: ReferenceFile[] = []
    for (const file of Array.from(fileList)) {
      if (!DEBATE_ACCEPTED_TYPES.includes(file.type as typeof DEBATE_ACCEPTED_TYPES[number])) continue
      if (file.size > MAX_FILE_SIZE) continue
      if (referenceFiles.length + newFiles.length >= DEBATE_MAX_FILES) break
      const dataUrl = await readFileAsDataUrl(file)
      newFiles.push({ id: generateId(), filename: file.name, mimeType: file.type, size: file.size, dataUrl })
    }
    updateSettings({ referenceFiles: [...referenceFiles, ...newFiles] })
  }

  const removeFile = (id: string) => {
    updateSettings({ referenceFiles: referenceFiles.filter((f) => f.id !== id) })
  }

  const sectionLabel = (text: string) => (
    <label className="block text-[11px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--color-text-muted)' }}>
      {text}
    </label>
  )

  const modeBtn = (m: DiscussionMode) => (
    <button
      key={m}
      onClick={() => updateSettings({ mode: m })}
      className="px-3 py-2 text-xs rounded-lg transition-all"
      style={
        mode === m
          ? { background: 'rgba(82,156,202,0.1)', border: '1px solid rgba(82,156,202,0.4)', color: 'var(--color-accent)', fontWeight: 600 }
          : { background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }
      }
    >
      {MODE_LABELS[m]}
    </button>
  )

  return (
    <div className="space-y-6">
      <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
        토론 모드, 참여 AI, 역할, 라운드 수 등 토론에 필요한 설정을 구성합니다.
      </p>

      {/* Mode Selection */}
      <div>
        {sectionLabel('토론 모드')}
        <div className="grid grid-cols-2 gap-1.5">
          {DEBATE_MODES.map(modeBtn)}
        </div>
        <p className="text-[11px] mt-1.5 pl-0.5" style={{ color: 'var(--color-text-muted)' }}>
          {MODE_DESCRIPTIONS[mode]}
        </p>
      </div>

      {/* Participants */}
      <div>
        {sectionLabel('참여 AI 선택')}
        {enabledProviders.length < 2 && (
          <div
            className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg mb-2"
            style={{ background: 'rgba(255,152,0,0.1)', color: '#ff9800' }}
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>AI 설정에서 2개 이상의 페르소나에 API 키를 설정하세요</span>
          </div>
        )}
        {mode === 'battle' && selectedProviders.length >= 2 && selectedProviders.length < 3 && (
          <div
            className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg mb-2"
            style={{ background: 'rgba(255,152,0,0.1)', color: '#ff9800' }}
          >
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>결전모드는 3개의 AI가 필요합니다 (토론자 2 + 심판 1)</span>
          </div>
        )}
        <div className="flex flex-wrap gap-1.5">
          {enabledProviders.map((p) => {
            const selected = selectedProviders.includes(p)
            const meta = SPEAKER_CONFIG[p]
            return (
              <button
                key={p}
                onClick={() => toggleProvider(p)}
                className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all"
                style={
                  selected
                    ? {
                        background: `${meta.color}12`,
                        border: `1px solid ${meta.color}60`,
                        color: meta.color,
                        fontWeight: 600,
                      }
                    : {
                        background: 'var(--color-bg-surface)',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text-secondary)',
                      }
                }
              >
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: meta.color }} />
                {meta.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Judge Selection (Battle Mode) */}
      {mode === 'battle' && selectedProviders.length >= 3 && (
        <div>
          {sectionLabel('심판 AI 선택')}
          <div className="flex flex-wrap gap-1.5">
            {selectedProviders.map((p) => {
              const isJudge = judgeProvider === p
              const meta = SPEAKER_CONFIG[p as keyof typeof SPEAKER_CONFIG]
              return (
                <button
                  key={p}
                  onClick={() => updateSettings({ judgeProvider: p })}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-all"
                  style={
                    isJudge
                      ? { background: 'rgba(255,152,0,0.1)', border: '1px solid rgba(255,152,0,0.4)', color: '#ff9800', fontWeight: 600 }
                      : { background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }
                  }
                >
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: meta?.color ?? '#888' }} />
                  {meta?.label ?? p}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Role Assignment */}
      {(mode === 'roleAssignment' || mode === 'battle') && selectedProviders.length > 0 && (
        <div>
          {sectionLabel(mode === 'battle' ? '캐릭터 배정 (선택)' : '역할 배정')}
          <div
            className="space-y-1.5 rounded-lg p-2.5"
            style={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}
          >
            {selectedProviders.map((p) => {
              const isJudgeAI = mode === 'battle' && judgeProvider === p
              const role = roles.find((r) => r.provider === p)?.role || '중립'
              const meta = SPEAKER_CONFIG[p as keyof typeof SPEAKER_CONFIG]
              return (
                <div key={p} className="flex items-center gap-2.5">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: meta?.color ?? '#888' }} />
                  <span className="text-xs w-14 font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                    {meta?.label ?? p}
                  </span>
                  {isJudgeAI ? (
                    <span className="flex-1 px-2 py-1 text-xs font-semibold" style={{ color: '#ff9800' }}>심판</span>
                  ) : (
                    <select
                      value={role}
                      onChange={(e) => updateRole(p, e.target.value)}
                      className="flex-1 px-2 py-1 text-xs rounded focus:outline-none"
                      style={{
                        background: 'var(--color-bg-primary)',
                        border: '1px solid var(--color-border)',
                        color: 'var(--color-text-primary)',
                      }}
                    >
                      {ROLE_GROUPS.map((group) => (
                        <optgroup key={group.label} label={group.label}>
                          {group.roles.map((roleValue) => {
                            const roleLabel = ROLE_LABEL_MAP.get(roleValue)
                            if (!roleLabel) return null
                            return (
                              <option key={roleValue} value={roleLabel}>
                                {roleLabel}
                              </option>
                            )
                          })}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Rounds */}
      <div>
        {sectionLabel(`라운드 수: ${maxRounds}`)}
        <input
          type="range"
          min={1}
          max={10}
          value={maxRounds}
          onChange={(e) => updateSettings({ maxRounds: Number(e.target.value) })}
          className="w-full"
          style={{ accentColor: 'var(--color-accent)' }}
        />
        <div className="flex justify-between text-[10px] px-0.5 mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          <span>1</span>
          <span>10</span>
        </div>
      </div>

      {/* Reference Data */}
      <div>
        <label className="flex items-center gap-2 cursor-pointer">
          {/* Toggle */}
          <div
            className="relative w-8 rounded-full cursor-pointer transition-colors"
            style={{
              height: 18,
              background: useReference ? 'var(--color-accent)' : 'var(--color-bg-hover)',
            }}
            onClick={() => updateSettings({ useReference: !useReference })}
          >
            <div
              className="absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow-sm transition-transform"
              style={{ transform: useReference ? 'translateX(16px)' : 'translateX(2px)' }}
            />
          </div>
          <FileText className="w-3.5 h-3.5" style={{ color: 'var(--color-text-secondary)' }} />
          <span className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>참고 자료 포함</span>
        </label>

        {useReference && (
          <div className="space-y-2 mt-2">
            <textarea
              value={referenceText}
              onChange={(e) => {
                if (e.target.value.length <= REF_MAX_LENGTH) updateSettings({ referenceText: e.target.value })
              }}
              placeholder="토론에 참고할 텍스트를 붙여넣으세요."
              className="w-full px-3 py-2.5 text-sm rounded-lg resize-none focus:outline-none transition"
              style={{
                background: 'var(--color-bg-surface)',
                border: '1px solid var(--color-border)',
                color: 'var(--color-text-primary)',
              }}
              rows={3}
            />
            <div className="flex justify-end">
              <span
                className="text-[10px]"
                style={{ color: referenceText.length > REF_MAX_LENGTH * 0.9 ? '#ff9800' : 'var(--color-text-muted)' }}
              >
                {referenceText.length.toLocaleString()} / {REF_MAX_LENGTH.toLocaleString()}자
              </span>
            </div>

            {/* File Upload */}
            <label
              className="flex flex-col items-center justify-center gap-2 p-4 border-2 border-dashed rounded-lg cursor-pointer transition-all"
              style={{
                borderColor: referenceFiles.length >= DEBATE_MAX_FILES ? 'var(--color-border)' : 'var(--color-border)',
                color: referenceFiles.length >= DEBATE_MAX_FILES ? 'var(--color-text-muted)' : 'var(--color-text-secondary)',
                opacity: referenceFiles.length >= DEBATE_MAX_FILES ? 0.4 : 1,
                cursor: referenceFiles.length >= DEBATE_MAX_FILES ? 'not-allowed' : 'pointer',
              }}
              onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
              onDrop={(e) => {
                e.preventDefault(); e.stopPropagation()
                if (referenceFiles.length < DEBATE_MAX_FILES) void handleFileUpload(e.dataTransfer.files)
              }}
            >
              <Upload className="w-4 h-4" />
              <span className="text-xs font-medium">이미지/PDF 드래그 또는 클릭</span>
              <span className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                최대 10MB | 최대 {DEBATE_MAX_FILES}개
              </span>
              <input
                ref={fileInputRef}
                type="file"
                accept={DEBATE_ACCEPTED_EXTENSIONS}
                multiple
                className="hidden"
                onChange={(e) => void handleFileUpload(e.target.files)}
                disabled={referenceFiles.length >= DEBATE_MAX_FILES}
              />
            </label>

            {referenceFiles.length > 0 && (
              <div className="space-y-1">
                {referenceFiles.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg"
                    style={{ background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}
                  >
                    {file.mimeType.startsWith('image/') ? (
                      <img src={file.dataUrl} alt={file.filename} className="w-8 h-8 object-cover rounded shrink-0" />
                    ) : (
                      <div className="w-8 h-8 flex items-center justify-center rounded shrink-0" style={{ background: 'var(--color-bg-hover)' }}>
                        <FileText className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <p className="text-xs truncate" style={{ color: 'var(--color-text-primary)' }}>{file.filename}</p>
                      <p className="text-[10px]" style={{ color: 'var(--color-text-muted)' }}>
                        {file.size < 1024 ? `${file.size} B` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(1)} MB`}
                      </p>
                    </div>
                    <button
                      onClick={() => removeFile(file.id)}
                      className="p-1 rounded transition shrink-0"
                      style={{ color: 'var(--color-text-muted)' }}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Pacing */}
      <div>
        {sectionLabel('턴 속도 제어')}
        <div className="grid grid-cols-2 gap-1.5 mb-2">
          {(['auto', 'manual'] as const).map((m) => (
            <button
              key={m}
              onClick={() => updateSettings({ pacingMode: m })}
              className="px-3 py-2 text-xs rounded-lg transition-all"
              style={
                pacingMode === m
                  ? { background: 'rgba(82,156,202,0.1)', border: '1px solid rgba(82,156,202,0.4)', color: 'var(--color-accent)', fontWeight: 600 }
                  : { background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }
              }
            >
              {m === 'auto' ? '자동' : '수동'}
            </button>
          ))}
        </div>

        {pacingMode === 'auto' ? (
          <div className="grid grid-cols-4 gap-1">
            {DELAY_OPTIONS.map((d) => (
              <button
                key={d}
                onClick={() => updateSettings({ autoDelay: d })}
                className="px-2 py-1.5 text-xs rounded-lg transition-all"
                style={
                  autoDelay === d
                    ? { background: 'rgba(82,156,202,0.1)', border: '1px solid rgba(82,156,202,0.3)', color: 'var(--color-accent)', fontWeight: 500 }
                    : { background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-muted)' }
                }
              >
                {d}초
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[11px] pl-0.5" style={{ color: 'var(--color-text-muted)' }}>
            각 AI 응답 후 '다음 턴' 버튼을 눌러야 진행됩니다
          </p>
        )}
      </div>
    </div>
  )
}
