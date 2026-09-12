/**
 * JiraDispatchTab — Dispatch Jira tasks to team members based on AI insights
 *
 * Sections:
 *   1. Team member cards (fetched from Jira → auto-created, saved to a vault file, role/duties editable)
 *   2. AI task generation (feedback → LLM → draft cards)
 *   3. Draft review + publish
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Plus, Trash2, RefreshCw, Loader, CheckCircle, XCircle, Send } from 'lucide-react'
import { useSettingsStore, type JiraTeamMember, MIGRATED_CONFIG_KEY } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { streamMessageRaw } from '@/services/llmClient'
import { useT } from '@/i18n'

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
    '<!-- Managed automatically by Strata Sync. Roles/responsibilities may be edited by hand. -->',
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
  const t = useT()
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
      {/* Name + accountId badge + delete */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ flex: 1 }}>
          <input
            value={member.name}
            onChange={e => inp('name', e.target.value)}
            placeholder={t('Name')}
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
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0 }}>{t('ID')}</span>
        <input
          value={member.jiraAccountId}
          onChange={e => inp('jiraAccountId', e.target.value)}
          placeholder={t('Jira accountId (filled automatically after fetch)')}
          style={{ ...inputStyle, fontFamily: 'monospace', fontSize: 10, color: 'var(--color-text-muted)' }}
        />
      </div>

      {/* Role */}
      <input
        value={member.role}
        onChange={e => inp('role', e.target.value)}
        placeholder={t('Role (e.g. Art Director)')}
        style={{ ...inputStyle }}
      />

      {/* Responsibilities */}
      <textarea
        value={member.responsibilities}
        onChange={e => inp('responsibilities', e.target.value)}
        placeholder={t('Responsibilities (e.g. character concept art review, outsourcing management)')}
        rows={2}
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5, fontFamily: 'inherit' }}
      />

      {/* Component */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0 }}>{t('Component')}</span>
        <input
          value={member.component ?? ''}
          onChange={e => inp('component', e.target.value)}
          placeholder={t('Jira component (e.g. [V1_Art] Concept Art)')}
          style={{ ...inputStyle, fontSize: 11 }}
        />
      </div>

      {/* Mapping status */}
      {hasMapped && (
        <span style={{
          position: 'absolute', top: 8, right: 28,
          fontSize: 9, color: 'var(--color-accent)',
          fontWeight: 600, letterSpacing: '0.05em',
        }}>{t('Mapped')}</span>
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
  const t = useT()
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
        placeholder={t('Issue summary')}
        style={{ ...inputStyle, fontWeight: 600, fontSize: 13, marginBottom: 8 }}
      />

      <textarea
        value={draft.description}
        onChange={e => onUpdate({ description: e.target.value })}
        placeholder={t('Issue description')}
        rows={3}
        style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.6, marginBottom: 8 }}
      />

      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'block', marginBottom: 3 }}>{t('Assignee')}</label>
          <select
            value={draft.assigneeName}
            onChange={e => {
              const m = teamMembers.find(m => m.name === e.target.value)
              onUpdate({ assigneeName: e.target.value, assigneeAccountId: m?.jiraAccountId ?? '' })
            }}
            style={inputStyle}
          >
            <option value="">{t('-- Unassigned --')}</option>
            {teamMembers.map(m => (
              <option key={m.id} value={m.name}>{m.name}{m.role ? ` (${m.role})` : ''}</option>
            ))}
          </select>
        </div>
        <div style={{ width: 120 }}>
          <label style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'block', marginBottom: 3 }}>{t('Priority')}</label>
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
        placeholder={t('Labels (comma-separated)')}
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
              <CheckCircle size={12} /> {t('Accept')}
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
              <XCircle size={12} /> {t('Reject')}
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
            {t('Publish')}
          </button>
        )}

        {isPublished && (
          <span style={{ fontSize: 11, color: '#4ade80', display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
            <CheckCircle size={12} /> {t('{key} published', { key: draft.publishedKey ?? '' })}
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
  const t = useT()

  const jiraCfg = (activeVaultId ? jiraConfigs[activeVaultId] : undefined)
    ?? jiraConfigs[MIGRATED_CONFIG_KEY]

  // ── Load vault file (once on mount) ─────────────────────────────────────

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

  // ── Save vault file (debounced on member changes) ───────────────────────

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

  // ── Member CRUD ────────────────────────────────────────────────────────

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

  // ── Fetch Jira members ─────────────────────────────────────────────────

  const [syncStatus, setSyncStatus] = useState<'idle' | 'loading' | 'ok' | 'err'>('idle')
  const [syncError, setSyncError] = useState('')

  const handleSync = async () => {
    if (!jiraCfg?.baseUrl || !jiraCfg?.apiToken) {
      setSyncStatus('err')
      setSyncError(t('Jira connection is not configured. Set it up under Settings › Jira Import first.'))
      return
    }
    if (!jiraCfg.projectKey) {
      setSyncStatus('err')
      setSyncError(t('No Project Key. Fetching without a project returns every user in the company, so tasks could be dispatched to the wrong person.'))
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

      // Preserve existing cards (keep role/responsibilities by matching on name)
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
      setSyncError(e?.message ?? t('Fetch failed'))
    }
  }

  const handleClearAll = async () => {
    setJiraTeamMembers([])
    setSyncStatus('idle')
    setSyncError('')
    if (vaultPath) {
      // Empty the file contents (write an empty file instead of deleting)
      await window.vaultAPI?.saveFile(`${vaultPath}/${MEMBERS_FILENAME}`, '<!-- cleared -->\n')
    }
  }

  // ── AI task generation ─────────────────────────────────────────────────

  const [feedbackText, setFeedbackText] = useState('')
  const [drafts, setDrafts] = useState<DraftIssue[]>([])
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState('')
  const [publishingIds, setPublishingIds] = useState<Set<string>>(new Set())
  const [publishAllRunning, setPublishAllRunning] = useState(false)

  const handleGenerate = async () => {
    if (!feedbackText.trim()) return
    if (jiraTeamMembers.length === 0) {
      setGenerateError(t('No team member cards. Fetch Jira members first.'))
      return
    }
    setGenerating(true)
    setGenerateError('')
    setDrafts([])

    const teamRoster = jiraTeamMembers.map(m =>
      `- ${m.name} (${m.role || 'role not specified'}): ${m.responsibilities || 'responsibilities not specified'}`
    ).join('\n')

    const systemPrompt =
`You are a project manager. Using the team roster and roles below, extract action items from the feedback and create a suitable Jira issue for each team member.

[Team roster]
${teamRoster}

[Output rules]
- Return ONLY a JSON array. Do not include code fences (\`\`\`) or any other text.
- Fields per object: summary(string), description(string), assigneeName(string, one of the team member names above), priority("Highest"|"High"|"Medium"|"Low"|"Lowest"), labels(string[])
- Write all text in Korean.
- If there are no issues, return an empty array [].`

    const userMsg = `[Feedback]\n${feedbackText.trim()}\n\nExtract action items from the feedback above and return a JSON array of Jira issues.`

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
      setGenerateError(t('Generation failed: {error}. Raw: {raw}', { error: e?.message ?? t('Unknown error'), raw: accumulated.slice(0, 200) }))
    } finally {
      setGenerating(false)
    }
  }

  // ── Publish ────────────────────────────────────────────────────────────

  const updateDraft = useCallback((localId: string, patch: Partial<DraftIssue>) => {
    setDrafts(ds => ds.map(d => d.localId === localId ? { ...d, ...patch } : d))
  }, [])

  const publishOne = async (draft: DraftIssue) => {
    if (!jiraCfg?.baseUrl || !jiraCfg?.apiToken) {
      updateDraft(draft.localId, { publishError: t('Jira is not configured.') })
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
      updateDraft(draft.localId, { publishError: e?.message ?? t('Publish failed') })
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

      {/* ── 1. Team member cards ─────────────────────────────────────── */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <SectionTitle>{jiraTeamMembers.length > 0 ? t('Team Members ({count})', { count: jiraTeamMembers.length }) : t('Team Members')}</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Save status */}
            {saveState === 'saving' && (
              <span style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 3 }}>
                <Loader size={9} className="animate-spin" /> {t('Saving')}
              </span>
            )}
            {saveState === 'saved' && (
              <span style={{ fontSize: 10, color: '#4ade80', display: 'flex', alignItems: 'center', gap: 3 }}>
                <CheckCircle size={9} /> {t('Saved')}
              </span>
            )}
            {/* Jira fetch button */}
            <button
              onClick={handleSync}
              disabled={syncStatus === 'loading' || !canSync}
              title={!jiraConfigured ? t('Jira setup required') : !projectKey ? t('Project Key required (Settings › Jira Import)') : ''}
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
                ? <><Loader size={10} className="animate-spin" /> {t('Fetching…')}</>
                : <><RefreshCw size={10} /> {projectKey ? t('Fetch {project} Members', { project: projectKey }) : t('Fetch Jira Members')}</>}
            </button>
            {/* Reset all */}
            {jiraTeamMembers.length > 0 && (
              <button
                onClick={handleClearAll}
                style={{
                  fontSize: 11, padding: '4px 10px', borderRadius: 2, cursor: 'pointer',
                  border: '1px solid var(--color-border)', background: 'transparent',
                  color: 'var(--color-text-muted)', display: 'flex', alignItems: 'center', gap: 4,
                }}
                title={t('Reset all team member cards (also empties the vault file)')}
              >
                <XCircle size={10} /> {t('Reset')}
              </button>
            )}
          </div>
        </div>

        {!jiraConfigured && (
          <p style={{ fontSize: 11, color: 'var(--color-warning)', marginBottom: 10 }}>
            {t('⚠ Jira is not configured. Set up the connection under Settings › Jira Import first.')}
          </p>
        )}
        {jiraConfigured && !projectKey && (
          <p style={{ fontSize: 11, color: 'var(--color-warning)', marginBottom: 10 }}>
            {t('⚠ Project Key not set. To avoid fetching every user in the company, enter a Project Key under Settings › Jira Import.')}
          </p>
        )}
        {syncStatus === 'err' && (
          <p style={{ fontSize: 11, color: 'var(--color-error)', marginBottom: 10, lineHeight: 1.5 }}>{syncError}</p>
        )}
        {syncStatus === 'ok' && (
          <p style={{ fontSize: 11, color: '#4ade80', marginBottom: 10 }}>
            {t('{count} members fetched · saved to jira-members.md', { count: jiraTeamMembers.length })}
          </p>
        )}

        {jiraTeamMembers.length === 0 ? (
          <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
            {t('Use the "Fetch {project} Members" button to load project members. Fetched members are saved to the vault and persist across sessions.', { project: projectKey || 'Jira' })}
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

        {/* Manual add */}
        <button
          onClick={addMember}
          style={{
            fontSize: 11, padding: '4px 12px', borderRadius: 2, cursor: 'pointer',
            border: '1px dashed var(--color-border)',
            background: 'transparent', color: 'var(--color-text-muted)',
            display: 'flex', alignItems: 'center', gap: 4,
          }}
        >
          <Plus size={11} /> {t('Add Manually')}
        </button>
      </section>

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* ── 2. AI task generation ────────────────────────────────────── */}
      <section>
        <SectionTitle>{t('AI Task Generation')}</SectionTitle>
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10, lineHeight: 1.6 }}>
          {t('Paste feedback, meeting notes or issues and the AI drafts Jira tasks for each team member.')}
        </p>

        <textarea
          value={feedbackText}
          onChange={e => setFeedbackText(e.target.value)}
          placeholder={t('Paste feedback, meeting notes, issues, etc...')}
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
            {generating ? <><Loader size={13} className="animate-spin" /> {t('Analyzing…')}</> : t('✦ AI Analysis → Generate Drafts')}
          </button>
          <span style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>
            {t('Model: {model}', { model: editAgentConfig.modelId || 'claude-sonnet-4-6' })}
          </span>
        </div>

        {generateError && (
          <p style={{ fontSize: 11, color: 'var(--color-error)', marginTop: 8, lineHeight: 1.5 }}>{generateError}</p>
        )}
      </section>

      {/* ── 3. Draft review + publish ────────────────────────────────────── */}
      {drafts.length > 0 && (
        <>
          <div style={{ borderTop: '1px solid var(--color-border)' }} />
          <section>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <SectionTitle>{t('Review {count} Drafts', { count: drafts.length })}</SectionTitle>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                  {t('Accepted {accepted} / Published {published}', { accepted: acceptedCount, published: publishedCount })}
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
                      ? <><Loader size={11} className="animate-spin" /> {t('Publishing…')}</>
                      : <><Send size={11} /> {t('Publish {count} Accepted', { count: pendingPublish })}</>}
                  </button>
                )}
              </div>
            </div>

            {!jiraConfigured && (
              <p style={{ fontSize: 11, color: 'var(--color-warning)', marginBottom: 10 }}>
                {t('⚠ Jira is not configured.')}
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
