import { useState, useMemo } from 'react'
import { ChevronDown, ChevronRight, RotateCcw, Trash, Plus, X } from 'lucide-react'
import { useSettingsStore, type CustomPersona } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { PERSONA_PROMPTS } from '@/lib/personaPrompts'
import { DEFAULT_PERSONA_MODELS } from '@/lib/modelConfig'
import { SPEAKER_CONFIG, SPEAKER_IDS, computeDarkBg } from '@/lib/speakerConfig'
import { GROUPED_OPTIONS, PROVIDER_LABELS, fieldInputStyle, fieldLabelStyle } from '../settingsShared'

// ── Local helpers ─────────────────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT_TEMPLATE = (label: string) =>
  `당신은 게임 개발 스튜디오의 ${label} 디렉터입니다.\n\n역할과 책임:\n- \n\n커뮤니케이션 스타일:\n- `

// ── DocPickerField ─────────────────────────────────────────────────────────────

/**
 * 특정 페르소나에 볼트 문서를 연결하는 검색+선택 UI.
 * 선택된 문서의 내용이 해당 페르소나의 시스템 프롬프트에 주입됩니다.
 */
function DocPickerField({ personaId }: { personaId: string }) {
  const loadedDocuments = useVaultStore(s => s.loadedDocuments)
  const { personaDocumentIds, setPersonaDocumentId } = useSettingsStore()
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)

  const selectedDocId = personaDocumentIds[personaId] ?? null
  const selectedDoc = useMemo(
    () => loadedDocuments?.find(d => d.id === selectedDocId) ?? null,
    [loadedDocuments, selectedDocId]
  )

  const filtered = useMemo(() => {
    if (!loadedDocuments || !query.trim()) return []
    const q = query.toLowerCase()
    // Filename match first; content search limited to first 300 chars to avoid O(n×m) cost
    return loadedDocuments
      .filter(d =>
        d.filename.toLowerCase().includes(q) ||
        d.rawContent.slice(0, 300).toLowerCase().includes(q)
      )
      .slice(0, 10)
  }, [loadedDocuments, query])

  if (!loadedDocuments) {
    return (
      <div style={{ marginBottom: 10 }}>
        <label style={fieldLabelStyle}>페르소나 참고 문서</label>
        <p style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>볼트를 먼저 로드하세요.</p>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 10 }}>
      <label style={fieldLabelStyle}>페르소나 참고 문서</label>
      {selectedDoc ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              flex: 1,
              fontSize: 11,
              padding: '4px 8px',
              border: '1px solid var(--color-accent)',
              borderRadius: 2,
              background: 'rgba(59,130,246,0.07)',
              color: 'var(--color-accent)',
              fontFamily: 'monospace',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={selectedDoc.filename}
          >
            {selectedDoc.filename}
          </span>
          <button
            onClick={() => setPersonaDocumentId(personaId, null)}
            style={{ flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '2px 4px' }}
            title="연결 해제"
          >
            <X size={12} />
          </button>
        </div>
      ) : (
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            value={query}
            onChange={e => { setQuery(e.target.value); setOpen(true) }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
            placeholder="문서 파일명 또는 키워드 검색..."
            style={{ ...fieldInputStyle, paddingRight: 8 }}
          />
          {open && filtered.length > 0 && (
            <div
              style={{
                position: 'absolute',
                top: '100%',
                left: 0,
                right: 0,
                zIndex: 50,
                border: '1px solid var(--color-border)',
                borderRadius: 2,
                background: 'var(--color-bg-surface)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                maxHeight: 180,
                overflowY: 'auto',
              }}
            >
              {filtered.map(doc => (
                <button
                  key={doc.id}
                  onMouseDown={() => {
                    setPersonaDocumentId(personaId, doc.id)
                    setQuery('')
                    setOpen(false)
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '5px 10px',
                    fontSize: 11,
                    fontFamily: 'monospace',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid var(--color-border)',
                    color: 'var(--color-text-secondary)',
                    cursor: 'pointer',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={doc.filename}
                >
                  {doc.filename}
                  {doc.folderPath && (
                    <span style={{ color: 'var(--color-text-muted)', marginLeft: 6 }}>
                      ({doc.folderPath})
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <p style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 3 }}>
        선택한 문서의 내용이 이 페르소나의 시스템 프롬프트에 주입됩니다.
      </p>
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function PersonasTab() {
  const {
    personaPromptOverrides, setPersonaPromptOverride,
    customPersonas, addPersona, updatePersona, removePersona,
    personaModels, setPersonaModel,
    disabledPersonaIds, disableBuiltInPersona, restoreBuiltInPersona,
    directorBios, setDirectorBio,
  } = useSettingsStore()

  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newRole, setNewRole] = useState('')
  const [newColor, setNewColor] = useState('#60a5fa')

  const toggle = (id: string) => setExpandedId(prev => prev === id ? null : id)

  const handleAddPersona = () => {
    const label = newLabel.trim()
    if (!label) return
    const color = newColor
    const darkBg = computeDarkBg(color)
    const id = `custom_${Date.now()}`
    addPersona({
      id,
      label,
      role: newRole.trim() || '커스텀 디렉터',
      color,
      darkBg,
      systemPrompt: DEFAULT_SYSTEM_PROMPT_TEMPLATE(label),
      modelId: DEFAULT_PERSONA_MODELS['chief_director'],
    } satisfies CustomPersona)
    setNewLabel('')
    setNewRole('')
    setNewColor('#60a5fa')
    setShowAddForm(false)
    setExpandedId(id)
  }

  const chipStyle = (color: string, darkBg: string): React.CSSProperties => ({
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 4,
    background: darkBg,
    color,
    flexShrink: 0,
    fontFamily: 'monospace',
  })

  return (
    <div className="flex flex-col gap-6">

      {/* ── Built-in personas ── */}
      <section>
        <h3 className="text-xs font-semibold mb-1" style={{ color: 'var(--color-text-secondary)' }}>
          PM 페르소나
        </h3>
        <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
          AI 시스템 프롬프트를 수정할 수 있습니다.
        </p>

        {/* Active built-in personas */}
        <div className="flex flex-col gap-1 mb-2">
          {SPEAKER_IDS.filter(id => !disabledPersonaIds.includes(id)).map(id => {
            const meta = SPEAKER_CONFIG[id]
            const isExpanded = expandedId === id
            const isOverridden = Boolean(personaPromptOverrides[id])
            const prompt = personaPromptOverrides[id] ?? PERSONA_PROMPTS[id] ?? ''
            const selectedModel = personaModels[id]

            return (
              <div
                key={id}
                style={{ border: '1px solid var(--color-border)', borderRadius: 2, overflow: 'hidden' }}
              >
                {/* Row header */}
                <div style={{ display: 'flex', alignItems: 'center', background: 'var(--color-bg-surface)' }}>
                  <button
                    onClick={() => toggle(id)}
                    className="flex-1 flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
                  >
                    {isExpanded
                      ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                      : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                    }
                    <span style={chipStyle(meta.color, meta.darkBg)}>{meta.label}</span>
                    <span className="text-xs flex-1" style={{ color: 'var(--color-text-muted)' }}>{meta.role}</span>
                    {isOverridden && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(59,130,246,0.15)', color: 'var(--color-accent)' }}>
                        수정됨
                      </span>
                    )}
                  </button>
                  {/* Delete built-in persona */}
                  <button
                    onClick={() => {
                      if (window.confirm(`"${meta.label}" 페르소나를 비활성화하시겠습니까?\n페르소나 탭에서 언제든 복원할 수 있습니다.`)) {
                        disableBuiltInPersona(id)
                        if (expandedId === id) setExpandedId(null)
                      }
                    }}
                    style={{
                      flexShrink: 0,
                      background: 'transparent',
                      border: 'none',
                      padding: '0 12px',
                      color: 'var(--color-text-muted)',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      height: '100%',
                    }}
                    title="페르소나 비활성화"
                  >
                    <Trash size={12} />
                  </button>
                </div>

                {/* Expanded editor */}
                {isExpanded && (
                  <div style={{ padding: '10px 12px 12px', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-primary)' }}>
                    {/* Model selector */}
                    <div style={{ marginBottom: 10 }}>
                      <label style={fieldLabelStyle}>모델</label>
                      <div style={{ position: 'relative' }}>
                        <select
                          value={selectedModel}
                          onChange={e => setPersonaModel(id, e.target.value)}
                          style={{ ...fieldInputStyle, appearance: 'none', paddingRight: 24 }}
                        >
                          {Object.entries(GROUPED_OPTIONS).map(([provider, models]) => (
                            <optgroup key={provider} label={PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider}>
                              {models.map(m => (
                                <option key={m.id} value={m.id}>{m.label}</option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: 'var(--color-text-muted)', pointerEvents: 'none' }}>▾</span>
                      </div>
                    </div>

                    {/* Director bio */}
                    <div style={{ marginBottom: 10 }}>
                      <label style={fieldLabelStyle}>개인 소개 · 성향</label>
                      <textarea
                        value={directorBios[id] ?? ''}
                        onChange={e => setDirectorBio(id, e.target.value)}
                        placeholder={`${meta.label} 디렉터의 성향, 전문성, 우선순위 등... (AI 프롬프트에 추가로 반영됩니다)`}
                        rows={3}
                        style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.6 }}
                      />
                    </div>

                    {/* Persona document injection */}
                    <DocPickerField personaId={id} />

                    {/* System prompt editor */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                      <div style={{ flex: 1 }}>
                        <label style={fieldLabelStyle}>시스템 프롬프트</label>
                        <textarea
                          value={prompt}
                          onChange={e => setPersonaPromptOverride(id, e.target.value)}
                          rows={8}
                          style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.6, fontFamily: 'monospace', fontSize: 11 }}
                        />
                      </div>
                      {isOverridden && (
                        <button
                          onClick={() => setPersonaPromptOverride(id, '')}
                          style={{
                            marginTop: 18,
                            flexShrink: 0,
                            background: 'transparent',
                            border: '1px solid var(--color-border)',
                            borderRadius: 2,
                            padding: '5px 7px',
                            color: 'var(--color-text-muted)',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                          }}
                          title="프롬프트 기본값으로 복원"
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Disabled built-in personas */}
        {disabledPersonaIds.filter(id => SPEAKER_IDS.includes(id as typeof SPEAKER_IDS[number])).length > 0 && (
          <div>
            <p className="text-[10px] mb-1.5" style={{ color: 'var(--color-text-muted)' }}>비활성화된 페르소나</p>
            <div className="flex flex-col gap-1">
              {SPEAKER_IDS.filter(id => disabledPersonaIds.includes(id)).map(id => {
                const meta = SPEAKER_CONFIG[id]
                return (
                  <div
                    key={id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      border: '1px dashed var(--color-border)',
                      borderRadius: 2,
                      opacity: 0.6,
                    }}
                  >
                    <span style={{ ...chipStyle(meta.color, meta.darkBg), opacity: 0.5 }}>{meta.label}</span>
                    <span className="text-xs flex-1" style={{ color: 'var(--color-text-muted)', textDecoration: 'line-through' }}>{meta.role}</span>
                    <button
                      onClick={() => restoreBuiltInPersona(id)}
                      style={{
                        flexShrink: 0,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        background: 'transparent',
                        border: '1px solid var(--color-border)',
                        borderRadius: 4,
                        padding: '3px 8px',
                        color: 'var(--color-text-muted)',
                        cursor: 'pointer',
                        fontSize: 10,
                      }}
                      title="페르소나 복원"
                    >
                      <RotateCcw size={10} />
                      복원
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* ── Custom personas ── */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <h3 className="text-xs font-semibold" style={{ color: 'var(--color-text-secondary)' }}>커스텀 페르소나</h3>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              새 디렉터 역할을 추가하고 전용 AI 프롬프트를 설정하세요.
            </p>
          </div>
          <button
            onClick={() => setShowAddForm(f => !f)}
            style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'var(--color-accent)',
              border: 'none',
              borderRadius: 2,
              padding: '5px 10px',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 11,
            }}
          >
            <Plus size={11} />
            페르소나 추가
          </button>
        </div>

        {/* Add form */}
        {showAddForm && (
          <div
            style={{
              border: '1px dashed var(--color-accent)',
              borderRadius: 2,
              padding: '10px 12px',
              marginBottom: 10,
              background: 'rgba(59,130,246,0.04)',
            }}
          >
            <p className="text-xs font-medium mb-3" style={{ color: 'var(--color-accent)' }}>새 페르소나</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px' }}>
              <div>
                <label style={fieldLabelStyle}>이름 *</label>
                <input
                  type="text"
                  value={newLabel}
                  onChange={e => setNewLabel(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddPersona()}
                  placeholder="예: QA, Sound, Producer..."
                  style={fieldInputStyle}
                  autoFocus
                />
              </div>
              <div>
                <label style={fieldLabelStyle}>역할 설명</label>
                <input
                  type="text"
                  value={newRole}
                  onChange={e => setNewRole(e.target.value)}
                  placeholder="예: 품질 관리 · 버그 리포트"
                  style={fieldInputStyle}
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <div>
                <label style={fieldLabelStyle}>색상</label>
                <input
                  type="color"
                  value={newColor}
                  onChange={e => setNewColor(e.target.value)}
                  style={{ width: 40, height: 28, padding: 2, border: '1px solid var(--color-border)', borderRadius: 2, background: 'var(--color-bg-surface)', cursor: 'pointer' }}
                />
              </div>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => setShowAddForm(false)}
                style={{ background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 2, padding: '5px 10px', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 11 }}
              >
                취소
              </button>
              <button
                onClick={handleAddPersona}
                disabled={!newLabel.trim()}
                style={{
                  background: newLabel.trim() ? 'var(--color-accent)' : 'var(--color-bg-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 2,
                  padding: '5px 12px',
                  color: newLabel.trim() ? '#fff' : 'var(--color-text-muted)',
                  cursor: newLabel.trim() ? 'pointer' : 'not-allowed',
                  fontSize: 11,
                  opacity: newLabel.trim() ? 1 : 0.5,
                }}
              >
                추가
              </button>
            </div>
          </div>
        )}

        {/* Custom persona list */}
        {customPersonas.length === 0 && !showAddForm ? (
          <p className="text-xs" style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>
            아직 커스텀 페르소나가 없습니다.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {customPersonas.map(persona => {
              const isExpanded = expandedId === persona.id
              return (
                <div
                  key={persona.id}
                  style={{ border: '1px solid var(--color-border)', borderRadius: 2, overflow: 'hidden' }}
                >
                  {/* Row header */}
                  <div style={{ display: 'flex', alignItems: 'center', background: 'var(--color-bg-surface)' }}>
                    <button
                      onClick={() => toggle(persona.id)}
                      className="flex-1 flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-[var(--color-bg-hover)]"
                    >
                      {isExpanded
                        ? <ChevronDown size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                        : <ChevronRight size={12} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
                      }
                      <span style={chipStyle(persona.color, persona.darkBg)}>{persona.label}</span>
                      <span className="text-xs" style={{ color: 'var(--color-text-muted)' }}>{persona.role}</span>
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm(`"${persona.label}" 페르소나를 삭제하시겠습니까?`)) {
                          removePersona(persona.id)
                          if (expandedId === persona.id) setExpandedId(null)
                        }
                      }}
                      style={{
                        flexShrink: 0,
                        background: 'transparent',
                        border: 'none',
                        padding: '0 12px',
                        color: 'var(--color-text-muted)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        height: '100%',
                      }}
                      title="페르소나 삭제"
                    >
                      <Trash size={12} />
                    </button>
                  </div>

                  {/* Expanded editor */}
                  {isExpanded && (
                    <div style={{ padding: '10px 12px 12px', borderTop: '1px solid var(--color-border)', background: 'var(--color-bg-primary)' }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 12px', marginBottom: 10 }}>
                        <div>
                          <label style={fieldLabelStyle}>이름</label>
                          <input
                            type="text"
                            value={persona.label}
                            onChange={e => updatePersona(persona.id, { label: e.target.value })}
                            style={fieldInputStyle}
                          />
                        </div>
                        <div>
                          <label style={fieldLabelStyle}>역할 설명</label>
                          <input
                            type="text"
                            value={persona.role}
                            onChange={e => updatePersona(persona.id, { role: e.target.value })}
                            style={fieldInputStyle}
                          />
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
                        <div>
                          <label style={fieldLabelStyle}>색상</label>
                          <input
                            type="color"
                            value={persona.color}
                            onChange={e => {
                              const color = e.target.value
                              updatePersona(persona.id, { color, darkBg: computeDarkBg(color) })
                            }}
                            style={{ width: 40, height: 28, padding: 2, border: '1px solid var(--color-border)', borderRadius: 2, background: 'var(--color-bg-surface)', cursor: 'pointer' }}
                          />
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={fieldLabelStyle}>모델</label>
                          <div style={{ position: 'relative' }}>
                            <select
                              value={persona.modelId}
                              onChange={e => updatePersona(persona.id, { modelId: e.target.value })}
                              style={{ ...fieldInputStyle, appearance: 'none', paddingRight: 24 }}
                            >
                              {Object.entries(GROUPED_OPTIONS).map(([provider, models]) => (
                                <optgroup key={provider} label={PROVIDER_LABELS[provider as keyof typeof PROVIDER_LABELS] ?? provider}>
                                  {models.map(m => (
                                    <option key={m.id} value={m.id}>{m.label}</option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            <span style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', fontSize: 10, color: 'var(--color-text-muted)', pointerEvents: 'none' }}>▾</span>
                          </div>
                        </div>
                      </div>

                      {/* Persona document injection */}
                      <DocPickerField personaId={persona.id} />

                      <div>
                        <label style={fieldLabelStyle}>시스템 프롬프트</label>
                        <textarea
                          value={persona.systemPrompt}
                          onChange={e => updatePersona(persona.id, { systemPrompt: e.target.value })}
                          rows={8}
                          style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.6, fontFamily: 'monospace', fontSize: 11 }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
