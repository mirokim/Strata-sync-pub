/**
 * JiraDispatchTab — AI 인사이트 기반 팀원 Jira 일감 발행
 *
 * 섹션:
 *   1. 팀원 카드 (Jira 조회 → 자동 생성, vault 파일 저장, 역할/업무 편집)
 *   2. AI 일감 생성 (피드백 → LLM → 초안 카드)
 *   3. 초안 검토 + 발행
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Plus, Trash2, RefreshCw, Loader, CheckCircle, XCircle, Send } from 'lucide-react'
import { useSettingsStore, type JiraTeamMember, MIGRATED_CONFIG_KEY } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { streamMessageRaw } from '@/services/llmClient'

// ── Vault file helpers ─────────────────────────────────────────────────────────

const MEMBERS_FILENAME = 'jira-members.md'

function parseMembersFile(content: string): JiraTeamMember[] {
  const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (!match) return []
  try { return JSON.parse(match[1].trim()) } catch { return [] }
}

function formatMembersFile(members: JiraTeamMember[], projectKey: string): string {
  return [
    '---',
    'type: jira-team-members',
    `project: ${projectKey}`,
    `synced: ${new Date().toISOString()}`,
    '---',
    '',
    '<!-- Sandbox Map이 자동 관리합니다. 역할/담당업무는 직접 수정해도 됩니다. -->',
    '',
    '```json',
    JSON.stringify(members, null, 2),
    '```',
    '',
  ].join('\n')
}

// ── Local types ────────────────────────────────────────────────────────────────

interface DraftIssue {
  localId: string
  summary: string
  description: string
  assigneeName: string
  assigneeAccountId: string
  priority: 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest'
  labels: string[]
  accepted: boolean
  publishedKey?: string
  publishError?: string
}

// ── Tiny helpers ───────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
      textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 12,
    }}>{children}</h3>
  )
}

function uid() { return Math.random().toString(36).slice(2) }

// ── Member card ────────────────────────────────────────────────────────────────

function MemberCard({
  member, onUpdate, onDelete,
}: {
  member: JiraTeamMember
  onUpdate: (m: JiraTeamMember) => void
  onDelete: () => void
}) {
  const inp = (field: keyof JiraTeamMember, value: string) =>
    onUpdate({ ...member, [field]: value })

  const inputStyle: React.CSSProperties = {
    fontSize: 12, padding: '4px 8px', borderRadius: 2,
    border: '1px solid var(--color-border)',
    background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
    outline: 'none', width: '100%', boxSizing: 'border-box',
  }

  const hasMapped = Boolean(member.jiraAccountId)

  return (
    <div style={{
      border: `1px solid ${hasMapped ? 'var(--color-accent)' : 'var(--color-border)'}`,
      borderRadius: 6, padding: 12, background: 'var(--color-bg-surface)',
      display: 'flex', flexDirection: 'column', gap: 8, position: 'relative',
    }}>
      {/* 이름 + accountId badge + 삭제 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <input
            value={member.name}
            onChange={e => inp('name', e.target.value)}
            placeholder="이름"
            style={{ ...inputStyle, fontWeight: 600, fontSize: 13 }}
          />
        </div>
        <button
          onClick={onDelete}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--color-text-muted)', padding: 2, flexShrink: 0, marginTop: 2,
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>

      {/* accountId */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0 }}>ID</span>
        <input
          value={member.jiraAccountId}
          onChange={e => inp('jiraAccountId', e.target.value)}
          placeholder="Jira accountId (조회 후 자동 입력)"
          style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10, color: 'var(--color-text-muted)' }}
        />
      </div>

      {/* 역할 */}
      <input
        value={member.role}
        onChange={e => inp('role', e.target.value)}
        placeholder="역할 (예: 아트디렉터)"
        style={{ ...inputStyle }}
      />

      {/* 담당 업무 */}
      <textarea
        value={member.responsibilities}
        onChange={e => inp('responsibilities', e.target.value)}
        placeholder="담당 업무 (예: 캐릭터 원화 감수, 외주 관리)"
        rows={2}
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
      />

      {/* 컴포넌트 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0 }}>컴포넌트</span>
        <input
          value={member.component ?? ''}
          onChange={e => inp('component', e.target.value)}
          placeholder="Jira 컴포넌트 (예: [V1_아트실] 원화파트)"
          style={{ ...inputStyle, fontSize: 11 }}
        />
      </div>

      {/* 매핑 상태 */}
      {hasMapped && (
        <span style={{
          position: 'absolute', top: 8, right: 28,
          fontSize: 9, color: 'var(--color-accent)',
          fontWeight: 600, letterSpacing: '0.05em',
        }}>매핑됨</span>
      )}
    </div>
  )
}

// ── Draft card ────────────────────────────────────────────────────────────────

function DraftCard({
  draft, teamMembers, onUpdate, onPublish, publishing,
}: {
  draft: DraftIssue
  teamMembers: JiraTeamMember[]
  onUpdate: (d: Partial<DraftIssue>) => void
  onPublish: () => void
  publishing: boolean
}) {
  const inputStyle: React.CSSProperties = {
    fontSize: 12, padding: '4px 8px', borderRadius: 2,
    border: '1px solid var(--color-border)',
    background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
    outline: 'none', width: '100%', boxSizing: 'border-box',
  }

  const isPublished = Boolean(draft.publishedKey)
  const borderColor = isPublished ? '#4ade80'
    : draft.publishError ? 'var(--color-error)'
    : draft.accepted ? 'var(--color-accent)'
    : 'var(--color-border)'

  return (
    <div style={{
      border: `1px solid ${borderColor}`,
      borderRadius: 6, padding: 14, marginBottom: 10,
      background: 'var(--color-bg-surface)',
      opacity: draft.accepted || isPublished ? 1 : 0.55,
      transition: 'opacity 0.15s, border-color 0.15s',
    }}>
      <input
        value={draft.summary}
        onChange={e => onUpdate({ summary: e.target.value })}
        placeholder="이슈 제목"
        style={{ ...inputStyle, fontWeight: 600, fontSize: 13, marginBottom: 8 }}
      />

      <textarea
        value={draft.description}
        onChange={e => onUpdate({ description: e.target.value })}
        placeholder="이슈 설명"
        rows={3}
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6, marginBottom: 8 }}
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'block', marginBottom: 3 }}>담당자</label>
          <select
            value={draft.assigneeName}
            onChange={e => {
              const m = teamMembers.find(m => m.name === e.target.value)
              onUpdate({ assigneeName: e.target.value, assigneeAccountId: m?.jiraAccountId ?? '' })
            }}
            style={inputStyle}
          >
            <option value="">-- 미지정 --</option>
            {teamMembers.map(m => (
              <option key={m.id} value={m.name}>{m.name}{m.role ? ` (${m.role})` : ''}</option>
            ))}
          </select>
        </div>
        <div style={{ width: 120 }}>
          <label style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'block', marginBottom: 3 }}>우선순위</label>
          <select
            value={draft.priority}
            onChange={e => onUpdate({ priority: e.target.value as DraftIssue['priority'] })}
            style={inputStyle}
          >
            {(['Highest', 'High', 'Medium', 'Low', 'Lowest'] as const).map(p => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
      </div>

      <input
        value={draft.labels.join(', ')}
        onChange={e => onUpdate({ labels: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
        placeholder="레이블 (쉼표 구분)"
        style={{ ...inputStyle, marginBottom: 10, fontSize: 11 }}
      />

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {!isPublished && (
          <>
            <button
              onClick={() => onUpdate({ accepted: true })}
              style={{
                fontSize: 11, padding: '4px 12px', borderRadius: 2, cursor: 'pointer', border: 'none',
                background: draft.accepted ? 'var(--color-accent)' : 'var(--color-bg-hover)',
                color: draft.accepted ? '#fff' : 'var(--color-text-secondary)',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <CheckCircle size={12} /> 수락
            </button>
            <button
              onClick={() => onUpdate({ accepted: false })}
              style={{
                fontSize: 11, padding: '4px 12px', borderRadius: 2, cursor: 'pointer', border: 'none',
                background: !draft.accepted ? '#374151' : 'var(--color-bg-hover)',
                color: !draft.accepted ? 'var(--color-error)' : 'var(--color-text-muted)',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <XCircle size={12} /> 거절
            </button>
          </>
        )}

        {draft.accepted && !isPublished && (
          <button
            onClick={onPublish}
            disabled={publishing}
            style={{
              fontSize: 11, padding: '4px 12px', borderRadius: 2, cursor: publishing ? 'wait' : 'pointer',
              border: '1px solid var(--color-accent)', background: 'transparent',
              color: 'var(--color-accent)', marginLeft: 'auto',
              display: 'flex', alignItems: 'center', gap: 4,
              opacity: publishing ? 0.6 : 1,
            }}
          >
            {publishing ? <Loader size={11} className="animate-spin" /> : <Send size={11} />}
            발행
          </button>
        )}

        {isPublished && (
          <span style={{ fontSize: 11, color: '#4ade80', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
            <CheckCircle size={12} /> {draft.publishedKey} 발행 완료
          </span>
        )}
        {draft.publishError && (
          <span style={{ fontSize: 10, color: 'var(--color-error)', marginLeft: 'auto' }}>{draft.publishError}</span>
        )}
      </div>
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function JiraDispatchTab() {
  const jiraTeamMembers = useSettingsStore(s => s.jiraTeamMembers)
  const setJiraTeamMembers = useSettingsStore(s => s.setJiraTeamMembers)
  const jiraConfigs = useSettingsStore(s => s.jiraConfigs)
  const editAgentConfig = useSettingsStore(s => s.editAgentConfig)
  const activeVaultId = useVaultStore(s => s.activeVaultId)
  const vaultPath = useVaultStore(s => s.vaultPath)

  const jiraCfg = (activeVaultId ? jiraConfigs[activeVaultId] : undefined)
    ?? jiraConfigs[MIGRATED_CONFIG_KEY]

  // ── Vault file 로드 (마운트 시 1회) ──────────────────────────────────────

  const [fileLoaded, setFileLoaded] = useState(false)
  useEffect(() => {
    if (!vaultPath || fileLoaded) return
    const filePath = `${vaultPath}/${MEMBERS_FILENAME}`
    window.vaultAPI?.readFile(filePath).then(content => {
      if (content) {
        const loaded = parseMembersFile(content)
        if (loaded.length > 0) setJiraTeamMembers(loaded)
      }
      setFileLoaded(true)
    }).catch(() => setFileLoaded(true))
  }, [vaultPath, fileLoaded, setJiraTeamMembers])

  // ── Vault file 저장 (멤버 변경 시 debounce) ──────────────────────────────

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')

  const saveToVault = useCallback((members: JiraTeamMember[]) => {
    if (!vaultPath || members.length === 0) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    setSaveState('saving')
    saveTimer.current = setTimeout(async () => {
      const filePath = `${vaultPath}/${MEMBERS_FILENAME}`
      const content = formatMembersFile(members, jiraCfg?.projectKey ?? '')
      await window.vaultAPI?.saveFile(filePath, content)
      setSaveState('saved')
      setTimeout(() => setSaveState('idle'), 2000)
    }, 600)
  }, [vaultPath, jiraCfg?.projectKey])

  // ── 멤버 CRUD ──────────────────────────────────────────────────────────

  const updateMember = useCallback((id: string, m: JiraTeamMember) => {
    const next = jiraTeamMembers.map(x => x.id === id ? m : x)
    setJiraTeamMembers(next)
    saveToVault(next)
  }, [jiraTeamMembers, setJiraTeamMembers, saveToVault])

  const deleteMember = useCallback((id: string) => {
    const next = jiraTeamMembers.filter(x => x.id !== id)
    setJiraTeamMembers(next)
    saveToVault(next)
  }, [jiraTeamMembers, setJiraTeamMembers, saveToVault])

  const addMember = () => {
    const next = [...jiraTeamMembers, { id: uid(), name: '', jiraAccountId: '', role: '', responsibilities: '', component: '' }]
    setJiraTeamMembers(next)
    saveToVault(next)
  }

  // ── Jira 멤버 조회 ────────────────────────────────────────────────────

  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle')
  const [syncError, setSyncError] = useState('')

  const handleSync = async () => {
    if (!jiraCfg?.baseUrl || !jiraCfg?.apiToken) {
      setSyncStatus('err')
      setSyncError('Jira 연결 설정이 없습니다. 설정 › Jira 가져오기에서 먼저 설정하세요.')
      return
    }
    if (!jiraCfg.projectKey) {
      setSyncStatus('err')
      setSyncError('Project Key가 없습니다. 프로젝트 없이 조회하면 전사 사용자가 나와 엉뚱한 사람에게 일감이 발행될 수 있습니다.')
      return
    }
    setSyncStatus('loading')
    setSyncError('')
    try {
      const fetched = await window.jiraAPI!.getMembers({
        baseUrl: jiraCfg.baseUrl,
        authType: jiraCfg.authType,
        email: jiraCfg.email,
        apiToken: jiraCfg.apiToken,
        projectKey: jiraCfg.projectKey,
        bypassSSL: jiraCfg.bypassSSL,
      })

      // 기존 카드 보존 (이름 매칭으로 role/responsibilities 유지)
      const merged: JiraTeamMember[] = fetched.map(r => {
        const existing = jiraTeamMembers.find(m =>
          m.name === r.displayName ||
          r.displayName.includes(m.name) ||
          m.name.includes(r.displayName)
        )
        return {
          id: existing?.id ?? uid(),
          name: r.displayName,
          jiraAccountId: r.accountId,
          role: existing?.role ?? '',
          responsibilities: existing?.responsibilities ?? '',
          component: existing?.component ?? '',
        }
      })

      setJiraTeamMembers(merged)
      saveToVault(merged)
      setSyncStatus('ok')
    } catch (e: any) {
      setSyncStatus('err')
      setSyncError(e?.message ?? '조회 실패')
    }
  }

  const handleClearAll = async () => {
    setJiraTeamMembers([])
    setSyncStatus('idle')
    setSyncError('')
    if (vaultPath) {
      // 파일 내용 비우기 (삭제 대신 빈 파일로)
      await window.vaultAPI?.saveFile(`${vaultPath}/${MEMBERS_FILENAME}`, '<!-- cleared -->\n')
    }
  }

  // ── AI 일감 생성 ──────────────────────────────────────────────────────

  const [feedbackText, setFeedbackText] = useState('')
  const [drafts, setDrafts] = useState<DraftIssue[]>([])
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set())
  const [publishAllRunning, setPublishAllRunning] = useState(false)

  const handleGenerate = async () => {
    if (!feedbackText.trim()) return
    if (jiraTeamMembers.length === 0) {
      setGenerateError('팀원 카드가 없습니다. 먼저 Jira 멤버를 조회하세요.')
      return
    }
    setGenerating(true)
    setGenerateError('')
    setDrafts([])

    const teamRoster = jiraTeamMembers.map(m =>
      `- ${m.name} (${m.role || '역할 미기재'}): ${m.responsibilities || '담당 업무 미기재'}`
    ).join('\n')

    const systemPrompt =
`당신은 프로젝트 매니저입니다. 아래 팀원 목록과 역할을 참고하여, 피드백에서 액션 아이템을 추출하고 각 팀원에게 적합한 Jira 이슈를 생성하세요.

[팀원 목록]
${teamRoster}

[출력 규칙]
- 반드시 JSON 배열만 반환하세요. 코드 블록(\`\`\`)이나 다른 텍스트를 포함하지 마세요.
- 각 객체 필드: summary(string), description(string), assigneeName(string, 위 팀원 이름 중 하나), priority("Highest"|"High"|"Medium"|"Low"|"Lowest"), labels(string[])
- 모든 텍스트는 한국어로 작성하세요.
- 이슈가 없으면 빈 배열 []을 반환하세요.`

    const userMsg = `[피드백]\n${feedbackText.trim()}\n\n위 피드백에서 액션 아이템을 추출하여 Jira 이슈 JSON 배열을 반환하세요.`

    let accumulated = ''
    try {
      await streamMessageRaw(
        editAgentConfig.modelId || 'claude-sonnet-4-6',
        systemPrompt,
        [{ role: 'user', content: userMsg }],
        (chunk) => { accumulated += chunk },
      )

      const cleaned = accumulated
        .replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim()

      const parsed: { summary: string; description: string; assigneeName: string; priority: string; labels: string[] }[] = JSON.parse(cleaned)
      setDrafts(parsed.map(item => {
        const member = jiraTeamMembers.find(m => m.name === item.assigneeName)
        return {
          localId: uid(),
          summary: item.summary ?? '',
          description: item.description ?? '',
          assigneeName: item.assigneeName ?? '',
          assigneeAccountId: member?.jiraAccountId ?? '',
          priority: (item.priority as DraftIssue['priority']) ?? 'Medium',
          labels: Array.isArray(item.labels) ? item.labels : [],
          accepted: false,
        }
      }))
    } catch (e: any) {
      setGenerateError(`생성 실패: ${e?.message ?? '알 수 없는 오류'}. 원본: ${accumulated.slice(0, 200)}`)
    } finally {
      setGenerating(false)
    }
  }

  // ── 발행 ──────────────────────────────────────────────────────────────

  const updateDraft = useCallback((localId: string, patch: Partial<DraftIssue>) => {
    setDrafts(ds => ds.map(d => d.localId === localId ? { ...d, ...patch } : d))
  }, [])

  const publishOne = async (draft: DraftIssue) => {
    if (!jiraCfg?.baseUrl || !jiraCfg?.apiToken) {
      updateDraft(draft.localId, { publishError: 'Jira 설정이 없습니다.' })
      return
    }
    setPublishingIds(prev => new Set(prev).add(draft.localId))
    updateDraft(draft.localId, { publishError: undefined })
    try {
      const result = await window.jiraAPI!.createIssue(
        { baseUrl: jiraCfg.baseUrl, authType: jiraCfg.authType, email: jiraCfg.email, apiToken: jiraCfg.apiToken, projectKey: jiraCfg.projectKey, bypassSSL: jiraCfg.bypassSSL },
        { summary: draft.summary, description: draft.description, issuetype: 'Task', assigneeAccountId: draft.assigneeAccountId || undefined, priority: draft.priority, labels: draft.labels },
      )
      updateDraft(draft.localId, { publishedKey: result.key })
    } catch (e: any) {
      updateDraft(draft.localId, { publishError: e?.message ?? '발행 실패' })
    } finally {
      setPublishingIds(prev => { const s = new Set(prev); s.delete(draft.localId); return s })
    }
  }

  const publishAll = async () => {
    const targets = drafts.filter(d => d.accepted && !d.publishedKey)
    if (!targets.length) return
    setPublishAllRunning(true)
    await Promise.all(targets.map(d => publishOne(d)))
    setPublishAllRunning(false)
  }

  const acceptedCount = drafts.filter(d => d.accepted).length
  const publishedCount = drafts.filter(d => d.publishedKey).length
  const pendingPublish = drafts.filter(d => d.accepted && !d.publishedKey).length
  const jiraConfigured = Boolean(jiraCfg?.baseUrl && jiraCfg?.apiToken)
  const projectKey = jiraCfg?.projectKey ?? ''
  const canSync = jiraConfigured && Boolean(projectKey)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── 1. 팀원 카드 ──────────────────────────────────────────────── */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <SectionTitle>팀원 {jiraTeamMembers.length > 0 ? `(${jiraTeamMembers.length}명)` : ''}</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* 저장 상태 */}
            {saveState === 'saving' && (
              <span style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
                <Loader size={9} className="animate-spin" /> 저장 중
              </span>
            )}
            {saveState === 'saved' && (
              <span style={{ fontSize: 10, color: '#4ade80', display: 'flex', alignItems: 'center', gap: 3 }}>
                <CheckCircle size={9} /> 저장됨
              </span>
            )}
            {/* Jira 조회 버튼 */}
            <button
              onClick={handleSync}
              disabled={syncStatus === 'loading' || !canSync}
              title={!jiraConfigured ? 'Jira 설정 필요' : !projectKey ? 'Project Key 필요 (설정 › Jira 가져오기)' : ''}
              style={{
                fontSize: 11, padding: '4px 12px', borderRadius: 2,
                cursor: canSync ? 'pointer' : 'not-allowed',
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg-surface)',
                color: canSync ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
                display: 'flex', alignItems: 'center', gap: 4,
                opacity: canSync ? 1 : 0.5,
              }}
            >
              {syncStatus === 'loading'
                ? <><Loader size={10} className="animate-spin" /> 조회 중…</>
                : <><RefreshCw size={10} /> {projectKey ? `${projectKey} 멤버 조회` : 'Jira 멤버 조회'}</>}
            </button>
            {/* 전체 초기화 */}
            {jiraTeamMembers.length > 0 && (
              <button
                onClick={handleClearAll}
                style={{
                  fontSize: 11, padding: '4px 10px', borderRadius: 2, cursor: 'pointer',
                  border: '1px solid var(--color-border)', background: 'transparent',
                  color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4,
                }}
                title="팀원 카드 전체 초기화 (vault 파일도 비워짐)"
              >
                <XCircle size={10} /> 초기화
              </button>
            )}
          </div>
        </div>

        {!jiraConfigured && (
          <p style={{ fontSize: 11, color: 'var(--color-warning)', marginBottom: 10 }}>
            ⚠ Jira 설정이 없습니다. 설정 › Jira 가져오기에서 연결 설정 후 사용하세요.
          </p>
        )}
        {jiraConfigured && !projectKey && (
          <p style={{ fontSize: 11, color: 'var(--color-warning)', marginBottom: 10 }}>
            ⚠ Project Key 미설정. 전사 사용자 전체 조회를 방지하려면 설정 › Jira 가져오기 › Project Key를 입력하세요.
          </p>
        )}
        {syncStatus === 'err' && (
          <p style={{ fontSize: 11, color: 'var(--color-error)', marginBottom: 10, lineHeight: 1.5 }}>{syncError}</p>
        )}
        {syncStatus === 'ok' && (
          <p style={{ fontSize: 11, color: '#4ade80', marginBottom: 10 }}>
            {jiraTeamMembers.length}명 조회 완료 · jira-members.md에 저장됨
          </p>
        )}

        {jiraTeamMembers.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
            "{projectKey || 'Jira'} 멤버 조회" 버튼으로 프로젝트 멤버를 불러오세요.
            조회한 멤버는 vault에 저장되어 다음에도 유지됩니다.
          </p>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 10, marginBottom: 10,
          }}>
            {jiraTeamMembers.map(m => (
              <MemberCard
                key={m.id}
                member={m}
                onUpdate={(updated) => updateMember(m.id, updated)}
                onDelete={() => deleteMember(m.id)}
              />
            ))}
          </div>
        )}

        {/* 수동 추가 */}
        <button
          onClick={addMember}
          style={{
            fontSize: 11, padding: '4px 12px', borderRadius: 2, cursor: 'pointer',
            border: '1px dashed var(--color-border)',
            background: 'transparent', color: 'var(--color-text-muted)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <Plus size={11} /> 직접 추가
        </button>
      </section>

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* ── 2. AI 일감 생성 ────────────────────────────────────────────── */}
      <section>
        <SectionTitle>AI 일감 생성</SectionTitle>
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
          피드백·회의록·이슈 내용을 입력하면 AI가 팀원별 Jira 일감 초안을 생성합니다.
        </p>

        <textarea
          value={feedbackText}
          onChange={e => setFeedbackText(e.target.value)}
          placeholder="피드백, 회의록, 이슈 등을 붙여넣으세요..."
          rows={6}
          style={{
            width: '100%', fontSize: 12, padding: '8px 10px', borderRadius: 4,
            border: '1px solid var(--color-border)',
            background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
            resize: 'vertical', lineHeight: 1.7, outline: 'none', boxSizing: 'border-box',
            marginBottom: 10,
          }}
        />

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={handleGenerate}
            disabled={generating || !feedbackText.trim()}
            style={{
              fontSize: 12, padding: '6px 18px', borderRadius: 2, cursor: generating ? 'wait' : 'pointer',
              border: 'none',
              background: feedbackText.trim() ? 'var(--color-accent)' : 'var(--color-bg-hover)',
              color: feedbackText.trim() ? '#fff' : 'var(--color-text-muted)',
              display: 'flex', alignItems: 'center', gap: 6,
              opacity: generating ? 0.7 : 1,
            }}
          >
            {generating ? <><Loader size={13} className="animate-spin" /> 분석 중…</> : '✦ AI 분석 → 초안 생성'}
          </button>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            모델: {editAgentConfig.modelId || 'claude-sonnet-4-6'}
          </span>
        </div>

        {generateError && (
          <p style={{ fontSize: 11, color: 'var(--color-error)', marginTop: 8, lineHeight: 1.5 }}>{generateError}</p>
        )}
      </section>

      {/* ── 3. 초안 검토 + 발행 ──────────────────────────────────────────── */}
      {drafts.length > 0 && (
        <>
          <div style={{ borderTop: '1px solid var(--color-border)' }} />
          <section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <SectionTitle>{drafts.length}개 초안 검토</SectionTitle>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  수락 {acceptedCount} / 발행완료 {publishedCount}
                </span>
                {pendingPublish > 0 && (
                  <button
                    onClick={publishAll}
                    disabled={publishAllRunning}
                    style={{
                      fontSize: 11, padding: '5px 14px', borderRadius: 2,
                      cursor: publishAllRunning ? 'wait' : 'pointer',
                      background: 'var(--color-accent)', color: '#fff', border: 'none',
                      display: 'flex', alignItems: 'center', gap: 5,
                      opacity: publishAllRunning ? 0.7 : 1,
                    }}
                  >
                    {publishAllRunning
                      ? <><Loader size={11} className="animate-spin" /> 발행 중…</>
                      : <><Send size={11} /> 수락된 {pendingPublish}개 일괄 발행</>}
                  </button>
                )}
              </div>
            </div>

            {!jiraConfigured && (
              <p style={{ fontSize: 11, color: 'var(--color-warning)', marginBottom: 10 }}>
                ⚠ Jira 설정이 없습니다.
              </p>
            )}

            {drafts.map(d => (
              <DraftCard
                key={d.localId}
                draft={d}
                teamMembers={jiraTeamMembers}
                onUpdate={(patch) => updateDraft(d.localId, patch)}
                onPublish={() => publishOne(d)}
                publishing={publishingIds.has(d.localId)}
              />
            ))}
          </section>
        </>
      )}
    </div>
  )
}
