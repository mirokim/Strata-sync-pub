/**
 * JiraTab — Edit Agent가 사용하는 Jira 연결 설정.
 * 가져오기 실행은 Edit Agent 탭에서 활성화한 자동 동기화가 처리합니다.
 */

import { useState, useEffect, useRef } from 'react'
import { useSettingsStore, DEFAULT_JIRA_CONFIG, MIGRATED_CONFIG_KEY, type JiraConfig } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { syncJiraToMcp } from '@/lib/syncMcpConfig'

function FieldRow({ label, value, onChange, placeholder, type = 'text', isPassword = false }: {
  label: string; value: string; onChange: (v: string) => void
  placeholder?: string; type?: string; isPassword?: boolean
}) {
  const [visible, setVisible] = useState(false)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <label style={{ fontSize: 11, color: 'var(--color-text-muted)', minWidth: 90, flexShrink: 0 }}>{label}</label>
      <div style={{ flex: 1, position: 'relative' }}>
        <input
          type={isPassword ? (visible ? 'text' : 'password') : type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          style={{
            width: '100%', borderRadius: 2, padding: '5px 8px',
            background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border)', fontSize: 12, outline: 'none',
            fontFamily: isPassword ? 'monospace' : 'inherit',
            paddingRight: isPassword ? 44 : undefined,
            boxSizing: 'border-box',
          }}
        />
        {isPassword && (
          <button
            type="button"
            onClick={() => setVisible(v => !v)}
            style={{
              position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
              fontSize: 10, color: 'var(--color-text-muted)', background: 'none', border: 'none',
              cursor: 'pointer', padding: '1px 4px', borderRadius: 3,
            }}
            tabIndex={-1}
          >{visible ? '숨김' : '보기'}</button>
        )}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 12 }}>
      {children}
    </h3>
  )
}

type TestStatus = { state: 'idle' } | { state: 'testing' } | { state: 'ok'; name: string } | { state: 'err'; msg: string }

export default function JiraTab() {
  const jiraConfigs = useSettingsStore(s => s.jiraConfigs)
  const setJiraConfigForVault = useSettingsStore(s => s.setJiraConfigForVault)
  const vaults = useVaultStore(s => s.vaults)
  const activeVaultId = useVaultStore(s => s.activeVaultId)

  const [selectedVaultId, setSelectedVaultId] = useState(activeVaultId ?? '')
  const [testStatus, setTestStatus] = useState<TestStatus>({ state: 'idle' })
  useEffect(() => { if (activeVaultId && !selectedVaultId) setSelectedVaultId(activeVaultId) }, [activeVaultId, selectedVaultId])
  useEffect(() => { setTestStatus({ state: 'idle' }) }, [selectedVaultId])

  const cfg: JiraConfig = jiraConfigs[selectedVaultId]
    ?? jiraConfigs[MIGRATED_CONFIG_KEY]
    ?? DEFAULT_JIRA_CONFIG

  // mcp-config.json 자동 동기화 (1초 디바운스)
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!cfg.baseUrl && !cfg.apiToken) return
    if (syncTimer.current) clearTimeout(syncTimer.current)
    syncTimer.current = setTimeout(() => syncJiraToMcp(cfg), 1000)
    return () => { if (syncTimer.current) clearTimeout(syncTimer.current) }
  }, [cfg])

  const set = (c: Partial<JiraConfig>) => {
    setJiraConfigForVault(selectedVaultId, c)
    setTestStatus({ state: 'idle' })
  }

  const handleTest = async () => {
    setTestStatus({ state: 'testing' })
    try {
      const result = await (window as any).jiraAPI.testConnection({
        baseUrl: cfg.baseUrl,
        authType: cfg.authType,
        email: cfg.email,
        apiToken: cfg.apiToken,
        bypassSSL: cfg.bypassSSL,
      })
      setTestStatus({ state: 'ok', name: result.displayName || '인증 성공' })
    } catch (e: any) {
      setTestStatus({ state: 'err', msg: e?.message ?? '연결 실패' })
    }
  }

  const canTest = Boolean(cfg.baseUrl && cfg.apiToken && (cfg.authType === 'server_pat' || cfg.email))

  const vaultEntries = Object.entries(vaults)

  return (
    <div className="flex flex-col gap-5">
      <section>
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
          Edit Agent가 Jira 데이터를 자동으로 가져올 때 사용하는 연결 설정입니다.<br />
          자동 동기화 활성화는 <strong style={{ color: 'var(--color-text-secondary)' }}>설정 › Edit Agent</strong>에서 하세요.
        </p>
      </section>

      {/* 볼트 선택기 */}
      {vaultEntries.length > 0 && (
        <section>
          <SectionTitle>대상 볼트</SectionTitle>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {vaultEntries.map(([id, v]) => {
              const isActive = selectedVaultId === id
              const hasConfig = Boolean(jiraConfigs[id]?.baseUrl)
              return (
                <button
                  key={id}
                  onClick={() => setSelectedVaultId(id)}
                  style={{
                    fontSize: 11, padding: '4px 12px', borderRadius: 2, border: '1px solid var(--color-border)',
                    background: isActive ? 'var(--color-accent)' : 'var(--color-bg-surface)',
                    color: isActive ? '#fff' : 'var(--color-text-secondary)',
                    fontWeight: isActive ? 600 : 400, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  {v.label || id}
                  {hasConfig && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: isActive ? 'rgba(255,255,255,0.7)' : 'var(--color-success)', display: 'inline-block' }} />
                  )}
                </button>
              )
            })}
          </div>
        </section>
      )}

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* 인증 */}
      <section>
        <SectionTitle>Jira 연결</SectionTitle>

        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 6 }}>인증 방식</label>
          <div style={{ display: 'flex', border: '1px solid var(--color-border)', borderRadius: 2, overflow: 'hidden', width: 'fit-content' }}>
            {([
              { id: 'cloud',        label: 'Cloud' },
              { id: 'server_pat',   label: 'Server PAT' },
              { id: 'server_basic', label: 'Server Basic' },
            ] as const).map((opt, i, arr) => (
              <button
                key={opt.id}
                onClick={() => set({ authType: opt.id })}
                style={{
                  fontSize: 11, padding: '5px 12px', border: 'none', cursor: 'pointer',
                  borderRight: i < arr.length - 1 ? '1px solid var(--color-border)' : 'none',
                  background: cfg.authType === opt.id ? 'var(--color-accent)' : 'var(--color-bg-surface)',
                  color: cfg.authType === opt.id ? '#fff' : 'var(--color-text-secondary)',
                  fontWeight: cfg.authType === opt.id ? 600 : 400,
                }}
              >{opt.label}</button>
            ))}
          </div>
          <p style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 5 }}>
            {cfg.authType === 'cloud'        && 'Atlassian Cloud — 이메일 + API 토큰 (id.atlassian.com → 보안 → API 토큰)'}
            {cfg.authType === 'server_pat'   && 'Data Center/Server — Personal Access Token (프로필 → Personal Access Tokens)'}
            {cfg.authType === 'server_basic' && 'Data Center/Server — 사용자명 + 비밀번호'}
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14, borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
          <FieldRow
            label="Base URL"
            value={cfg.baseUrl}
            onChange={v => {
              try {
                const parsed = new URL(v)
                if (/\/(browse|issues|projects)(\/|$)/i.test(parsed.pathname)) {
                  set({ baseUrl: parsed.origin })
                  return
                }
              } catch { /* 입력 중이면 무시 */ }
              set({ baseUrl: v })
            }}
            placeholder={cfg.authType === 'cloud' ? 'https://yourcompany.atlassian.net' : 'https://jira.company.com'}
          />
          {cfg.authType !== 'server_pat' && (
            <FieldRow
              label={cfg.authType === 'server_basic' ? '사용자명' : '이메일'}
              value={cfg.email} onChange={v => set({ email: v })}
              placeholder={cfg.authType === 'server_basic' ? 'username' : 'you@company.com'} />
          )}
          <FieldRow
            label={cfg.authType === 'server_pat' ? 'PAT 토큰' : cfg.authType === 'server_basic' ? '비밀번호' : 'API 토큰'}
            value={cfg.apiToken} onChange={v => set({ apiToken: v })}
            isPassword placeholder={cfg.authType === 'server_pat' ? 'Personal Access Token' : 'API 토큰'} />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 }}>
          <input id="jira-bypass-ssl" type="checkbox" checked={cfg.bypassSSL} onChange={e => set({ bypassSSL: e.target.checked })} style={{ width: 13, height: 13, cursor: 'pointer' }} />
          <label htmlFor="jira-bypass-ssl" style={{ fontSize: 11, color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
            SSL 인증서 검증 우회
            <span style={{ color: 'var(--color-text-muted)', marginLeft: 4 }}>(사내 자체 서명 인증서 사용 시)</span>
          </label>
        </div>
        {cfg.bypassSSL && (
          <p style={{ fontSize: 10, color: 'var(--color-warning)', marginTop: 4 }}>⚠ SSL 검증 비활성화 시 중간자 공격에 취약합니다. 사내망에서만 사용하세요.</p>
        )}

        {/* 연결 테스트 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <button
            onClick={handleTest}
            disabled={!canTest || testStatus.state === 'testing'}
            style={{
              fontSize: 11, padding: '5px 14px', borderRadius: 2, cursor: canTest ? 'pointer' : 'not-allowed',
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-surface)',
              color: canTest ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
              opacity: canTest ? 1 : 0.5,
            }}
          >
            {testStatus.state === 'testing' ? '확인 중…' : '연결 테스트'}
          </button>

          {testStatus.state === 'ok' && (
            <span style={{ fontSize: 11, color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-success)', display: 'inline-block' }} />
              {testStatus.name}
            </span>
          )}
          {testStatus.state === 'err' && (
            <span style={{ fontSize: 11, color: 'var(--color-error)', maxWidth: 280, lineHeight: 1.4 }}>
              {testStatus.msg}
            </span>
          )}
        </div>
      </section>

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* 이슈 범위 */}
      <section>
        <SectionTitle>이슈 범위</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <FieldRow label="Project Key" value={cfg.projectKey} onChange={v => set({ projectKey: v })} placeholder="PROJ (JQL 직접 입력 시 비워도 됨)" />
          <FieldRow label="저장 폴더" value={cfg.targetFolder} onChange={v => set({ targetFolder: v })} placeholder="jira" />
          <FieldRow label="증분 시작일" type="date" value={cfg.dateFrom} onChange={v => set({ dateFrom: v })} />
          <div>
            <label style={{ fontSize: 11, color: 'var(--color-text-muted)', display: 'block', marginBottom: 4 }}>
              JQL 직접 입력 <span style={{ opacity: 0.7 }}>(입력 시 Project Key / 날짜 무시)</span>
            </label>
            <input
              type="text"
              value={cfg.jql}
              onChange={e => set({ jql: e.target.value })}
              placeholder='project = PROJ AND status != Done AND updated >= "2026-01-01"'
              style={{
                width: '100%', fontSize: 12, borderRadius: 2, padding: '6px 10px', fontFamily: 'monospace',
                background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
                border: '1px solid var(--color-border)', outline: 'none', boxSizing: 'border-box',
              }}
            />
          </div>
        </div>
        <p style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 8 }}>
          증분 시작일 이후 변경된 이슈만 가져옵니다. Edit Agent 실행 시마다 이 날짜 이후 변경분을 동기화합니다.
        </p>
      </section>
    </div>
  )
}
