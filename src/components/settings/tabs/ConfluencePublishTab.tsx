/**
 * ConfluencePublishTab — Generate a Confluence page draft with AI and publish it.
 *
 * Modes:
 *   create — create a new page (spaceKey + optional parent page)
 *   update — update an existing page (looked up by URL/ID)
 */

import { useState, useRef } from 'react'
import { RefreshCw, Loader, CheckCircle, Send } from 'lucide-react'
import { useSettingsStore, MIGRATED_CONFIG_KEY, type ConfluenceConfig } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { streamMessageRaw } from '@/services/llmClient'
import { useT } from '@/i18n'

// ── Markdown → Confluence Storage Format ─────────────────────────────────────

function mdToStorage(md: string): string {
  // Process code blocks first to avoid double-escaping
  const codeBlocks: string[] = []
  let processed = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length
    codeBlocks.push(
      `<ac:structured-macro ac:name="code">` +
      (lang ? `<ac:parameter ac:name="language">${lang}</ac:parameter>` : '') +
      `<ac:plain-text-body><![CDATA[${code.trim()}]]></ac:plain-text-body>` +
      `</ac:structured-macro>`
    )
    return `\x00CODE${idx}\x00`
  })

  // Headings
  processed = processed.replace(/^#### (.+)$/gm, '<h4>$1</h4>')
  processed = processed.replace(/^### (.+)$/gm, '<h3>$1</h3>')
  processed = processed.replace(/^## (.+)$/gm, '<h2>$1</h2>')
  processed = processed.replace(/^# (.+)$/gm, '<h1>$1</h1>')

  // Horizontal rule
  processed = processed.replace(/^---+$/gm, '<hr />')

  // Bold / italic / inline code
  processed = processed.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  processed = processed.replace(/\*(.+?)\*/g, '<em>$1</em>')
  processed = processed.replace(/`([^`]+)`/g, '<code>$1</code>')

  // Lists — collect consecutive list lines into ul/ol blocks
  processed = processed.replace(/((?:^[ \t]*[-*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*] /, '')}</li>`).join('')
    return `<ul>${items}</ul>\n`
  })
  processed = processed.replace(/((?:^[ \t]*\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*\d+\. /, '')}</li>`).join('')
    return `<ol>${items}</ol>\n`
  })

  // Wrap plain text blocks in <p> — split on blank lines
  const blocks = processed.split(/\n{2,}/)
  const out = blocks.map(b => {
    const trimmed = b.trim()
    if (!trimmed) return ''
    if (trimmed.startsWith('<') || trimmed.startsWith('\x00CODE')) return trimmed
    return `<p>${trimmed.replace(/\n/g, '<br />')}</p>`
  }).filter(Boolean)

  // Restore code blocks
  let result = out.join('\n')
  codeBlocks.forEach((code, i) => {
    result = result.replace(`\x00CODE${i}\x00`, code)
  })
  return result
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.07em',
      textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 12,
    }}>{children}</h3>
  )
}

function extractPageId(urlOrId: string): string {
  // pageId=12345 or /pages/12345
  const m1 = urlOrId.match(/pageId=(\d+)/i)
  if (m1) return m1[1]
  const m2 = urlOrId.match(/\/pages\/(\d+)/i)
  if (m2) return m2[1]
  // plain numeric ID
  if (/^\d+$/.test(urlOrId.trim())) return urlOrId.trim()
  return ''
}

// ── Main component ─────────────────────────────────────────────────────────────

type Mode = 'create' | 'update'
type GenState = 'idle' | 'generating' | 'done' | 'error'
type PubState = 'idle' | 'publishing' | 'done' | 'error'

interface PageInfo { id: string; title: string; version: number; spaceKey: string }

export default function ConfluencePublishTab() {
  const confluenceConfigs = useSettingsStore(s => s.confluenceConfigs)
  const vaults = useVaultStore(s => s.vaults)
  const activeVaultId = useVaultStore(s => s.activeVaultId)
  const editAgentConfig = useSettingsStore(s => s.editAgentConfig)
  const t = useT()

  // Vault selector
  const [selectedVaultId, setSelectedVaultId] = useState(activeVaultId ?? '')
  const cfg: ConfluenceConfig = confluenceConfigs[selectedVaultId]
    ?? confluenceConfigs[MIGRATED_CONFIG_KEY]
    ?? { baseUrl: '', email: '', apiToken: '', spaceKey: '', targetFolder: '', authType: 'cloud', bypassSSL: false, dateFrom: '' }

  // Mode
  const [mode, setMode] = useState<Mode>('create')

  // Create mode fields
  const [spaceKey, setSpaceKey] = useState(cfg.spaceKey ?? '')
  const [parentUrl, setParentUrl] = useState('')
  const [pageTitle, setPageTitle] = useState('')

  // Update mode fields
  const [targetUrl, setTargetUrl] = useState('')
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null)
  const [fetchingInfo, setFetchingInfo] = useState(false)
  const [fetchError, setFetchError] = useState('')

  // AI generation
  const [topic, setTopic] = useState('')
  const [markdownDraft, setMarkdownDraft] = useState('')
  const [genState, setGenState] = useState<GenState>('idle')
  const [genError, setGenError] = useState('')
  const abortRef = useRef(false)

  // Review / publish
  const [accepted, setAccepted] = useState(false)
  const [pubState, setPubState] = useState<PubState>('idle')
  const [pubError, setPubError] = useState('')
  const [publishedUrl, setPublishedUrl] = useState('')

  const configForApi = {
    baseUrl: cfg.baseUrl, email: cfg.email, apiToken: cfg.apiToken,
    authType: cfg.authType, bypassSSL: cfg.bypassSSL,
  }
  const confluenceConfigured = Boolean(cfg.baseUrl && cfg.apiToken)

  // ── Fetch existing page info (update mode) ──────────────────────────────────
  const handleFetchInfo = async () => {
    const id = extractPageId(targetUrl)
    if (!id) { setFetchError(t('Enter a URL or page ID.')); return }
    setFetchingInfo(true); setFetchError(''); setPageInfo(null)
    try {
      const info = await (window as any).confluenceAPI.getPageInfo(configForApi, id)
      setPageInfo(info)
      setPageTitle(info.title)
    } catch (e: any) {
      setFetchError(e?.message ?? t('Failed to fetch page'))
    } finally {
      setFetchingInfo(false)
    }
  }

  // ── AI draft generation ─────────────────────────────────────────────────────
  const handleGenerate = async () => {
    if (!topic.trim()) return
    abortRef.current = false
    setGenState('generating')
    setGenError('')
    setMarkdownDraft('')
    setAccepted(false)
    setPubState('idle')
    setPubError('')
    setPublishedUrl('')

    const modelId = editAgentConfig?.modelId || 'claude-sonnet-4-6'
    const titleHint = pageTitle ? `Page title: "${pageTitle}"` : ''
    const systemPrompt = [
      'You are a professional technical writer creating Confluence page content.',
      'Write clear, well-structured Markdown that will be converted to Confluence storage format.',
      'Use headings (##, ###), bullet lists, bold/italic for emphasis.',
      'Do NOT include a top-level h1 title — it will be set as the page title separately.',
      'Respond with ONLY the Markdown content, no explanation.',
      titleHint,
    ].filter(Boolean).join('\n')

    let buffer = ''
    try {
      await streamMessageRaw(
        modelId,
        systemPrompt,
        [{ role: 'user', content: topic }],
        (chunk) => {
          if (abortRef.current) return
          buffer += chunk
          setMarkdownDraft(buffer)
        },
      )
      setGenState('done')
    } catch (e: any) {
      setGenError(e?.message ?? t('Generation failed'))
      setGenState('error')
    }
  }

  // ── Publish ─────────────────────────────────────────────────────────────────
  const handlePublish = async () => {
    if (!accepted || !markdownDraft.trim()) return
    setPubState('publishing'); setPubError(''); setPublishedUrl('')

    const storageBody = mdToStorage(markdownDraft)

    try {
      if (mode === 'create') {
        const parentId = parentUrl ? extractPageId(parentUrl) : undefined
        const result = await (window as any).confluenceAPI.createPage(configForApi, {
          title: pageTitle || topic.slice(0, 100),
          storageBody,
          spaceKey: spaceKey || cfg.spaceKey,
          parentId: parentId || undefined,
        })
        setPublishedUrl(result.url ?? '')
        setPubState('done')
      } else {
        if (!pageInfo) { setPubError(t('Fetch the page info first.')); setPubState('error'); return }
        const result = await (window as any).confluenceAPI.updatePage(configForApi, {
          pageId: pageInfo.id,
          title: pageTitle || pageInfo.title,
          storageBody,
          currentVersion: pageInfo.version,
        })
        setPublishedUrl(result.url ?? '')
        setPubState('done')
        // bump local version cache
        setPageInfo(p => p ? { ...p, version: p.version + 1 } : p)
      }
    } catch (e: any) {
      setPubError(e?.message ?? t('Publish failed'))
      setPubState('error')
    }
  }

  const vaultEntries = Object.entries(vaults)
  const canGenerate = Boolean(confluenceConfigured && topic.trim())
  const canPublish = accepted && markdownDraft.trim().length > 0 && pubState !== 'publishing'

  return (
    <div className="flex flex-col gap-5">
      <section>
        <p style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.7 }}>
          {t('Review an AI-written draft, then publish it to Confluence.')}<br />
          {t('Configure the Confluence connection under')} <strong style={{ color: 'var(--color-text-secondary)' }}>{t('Settings › Confluence Import')}</strong>.
        </p>
      </section>

      {/* Vault selector */}
      {vaultEntries.length > 0 && (
        <section>
          <SectionTitle>{t('Target Vault')}</SectionTitle>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {vaultEntries.map(([id, v]) => {
              const isActive = selectedVaultId === id
              const hasCfg = Boolean(confluenceConfigs[id]?.baseUrl)
              return (
                <button
                  key={id}
                  onClick={() => { setSelectedVaultId(id); setSpaceKey(confluenceConfigs[id]?.spaceKey ?? '') }}
                  style={{
                    fontSize: 11, padding: '4px 12px', borderRadius: 2,
                    border: '1px solid var(--color-border)',
                    background: isActive ? 'var(--color-accent)' : 'var(--color-bg-surface)',
                    color: isActive ? '#fff' : 'var(--color-text-secondary)',
                    fontWeight: isActive ? 600 : 400, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', gap: 5,
                  }}
                >
                  {v.label || id}
                  {hasCfg && (
                    <span style={{ width: 5, height: 5, borderRadius: '50%', background: isActive ? 'rgba(255,255,255,0.7)' : 'var(--color-success)', display: 'inline-block' }} />
                  )}
                </button>
              )
            })}
          </div>
        </section>
      )}

      {!confluenceConfigured && (
        <p style={{ fontSize: 11, color: 'var(--color-warning)' }}>
          {t('⚠ Confluence connection is not configured. Complete the connection settings first.')}
        </p>
      )}

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* Mode selection */}
      <section>
        <SectionTitle>{t('Publish Mode')}</SectionTitle>
        <div style={{ display: 'flex', border: '1px solid var(--color-border)', borderRadius: 2, overflow: 'hidden', width: 'fit-content' }}>
          {([
            { id: 'create', label: t('Create New Page') },
            { id: 'update', label: t('Update Existing Page') },
          ] as const).map((opt, i) => (
            <button
              key={opt.id}
              onClick={() => { setMode(opt.id); setAccepted(false); setPubState('idle') }}
              style={{
                fontSize: 11, padding: '5px 14px', border: 'none', cursor: 'pointer',
                borderRight: i === 0 ? '1px solid var(--color-border)' : 'none',
                background: mode === opt.id ? 'var(--color-accent)' : 'var(--color-bg-surface)',
                color: mode === opt.id ? '#fff' : 'var(--color-text-secondary)',
                fontWeight: mode === opt.id ? 600 : 400,
              }}
            >{opt.label}</button>
          ))}
        </div>
      </section>

      {/* Page settings */}
      <section>
        <SectionTitle>{mode === 'create' ? t('New Page Settings') : t('Target Page')}</SectionTitle>

        {mode === 'create' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <FieldRow label={t('Space Key')} value={spaceKey} onChange={setSpaceKey} placeholder={cfg.spaceKey || 'TEAM'} />
            <FieldRow label={t('Parent Page URL')} value={parentUrl} onChange={setParentUrl} placeholder={t('https://wiki.company.com/pages/12345 (optional)')} />
            <FieldRow label={t('Page Title')} value={pageTitle} onChange={setPageTitle} placeholder={t('Title (leave empty to derive from the AI topic)')} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ flex: 1 }}>
                <FieldRow label={t('Page URL / ID')} value={targetUrl} onChange={v => { setTargetUrl(v); setPageInfo(null); setFetchError('') }} placeholder={t('https://wiki.company.com/pages/12345 or numeric ID')} />
              </div>
              <button
                onClick={handleFetchInfo}
                disabled={!confluenceConfigured || !targetUrl.trim() || fetchingInfo}
                style={{
                  marginTop: 0, fontSize: 11, padding: '5px 12px', borderRadius: 2,
                  border: '1px solid var(--color-border)',
                  background: 'var(--color-bg-surface)', color: 'var(--color-text-secondary)',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                  opacity: (!confluenceConfigured || !targetUrl.trim()) ? 0.5 : 1,
                  whiteSpace: 'nowrap', flexShrink: 0,
                }}
              >
                {fetchingInfo ? <Loader size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                {t('Fetch')}
              </button>
            </div>
            {fetchError && <p style={{ fontSize: 11, color: 'var(--color-error)' }}>{fetchError}</p>}
            {pageInfo && (
              <div style={{ padding: '8px 12px', borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)', fontSize: 11 }}>
                <span style={{ color: 'var(--color-text-muted)' }}>{t('Page:')} </span>
                <strong style={{ color: 'var(--color-text-primary)' }}>{pageInfo.title}</strong>
                <span style={{ color: 'var(--color-text-muted)', marginLeft: 8 }}>{t('v{version} · {space}', { version: pageInfo.version, space: pageInfo.spaceKey })}</span>
              </div>
            )}
            {pageInfo && (
              <FieldRow label={t('Page Title')} value={pageTitle} onChange={setPageTitle} placeholder={pageInfo.title} />
            )}
          </div>
        )}
      </section>

      <div style={{ borderTop: '1px solid var(--color-border)' }} />

      {/* AI draft generation */}
      <section>
        <SectionTitle>{t('AI Draft Generation')}</SectionTitle>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{t('Topic / Instructions')}</label>
          <textarea
            value={topic}
            onChange={e => setTopic(e.target.value)}
            placeholder={t('e.g.: Write the Q1 2026 new feature release notes. Key changes: ...')}
            rows={4}
            style={{
              width: '100%', fontSize: 12, padding: '8px 10px', borderRadius: 2,
              border: '1px solid var(--color-border)',
              background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
              outline: 'none', resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit',
            }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              onClick={handleGenerate}
              disabled={!canGenerate || genState === 'generating'}
              style={{
                fontSize: 11, padding: '5px 14px', borderRadius: 2, cursor: canGenerate ? 'pointer' : 'not-allowed',
                border: '1px solid var(--color-border)',
                background: genState === 'generating' ? 'var(--color-bg-surface)' : 'var(--color-accent)',
                color: genState === 'generating' ? 'var(--color-text-muted)' : '#fff',
                opacity: canGenerate ? 1 : 0.5,
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {genState === 'generating' ? <><Loader size={11} className="animate-spin" /> {t('Generating…')}</> : t('Generate AI Draft')}
            </button>
            {genError && <span style={{ fontSize: 11, color: 'var(--color-error)' }}>{genError}</span>}
          </div>
        </div>
      </section>

      {/* Draft editor */}
      {(markdownDraft || genState === 'generating') && (
        <>
          <div style={{ borderTop: '1px solid var(--color-border)' }} />
          <section>
            <SectionTitle>{t('Review Draft (Markdown editable)')}</SectionTitle>
            <textarea
              value={markdownDraft}
              onChange={e => { setMarkdownDraft(e.target.value); setAccepted(false) }}
              rows={16}
              style={{
                width: '100%', fontSize: 12, padding: '10px 12px', borderRadius: 2,
                border: '1px solid var(--color-border)',
                background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
                outline: 'none', resize: 'vertical', boxSizing: 'border-box',
                fontFamily: 'monospace', lineHeight: 1.6,
              }}
            />

            {/* Accept + Publish */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={accepted}
                  onChange={e => setAccepted(e.target.checked)}
                  style={{ width: 14, height: 14, cursor: 'pointer' }}
                  disabled={genState === 'generating'}
                />
                <CheckCircle size={13} style={{ color: accepted ? 'var(--color-success)' : 'var(--color-text-muted)' }} />
                {t('Approve Draft')}
              </label>

              <button
                onClick={handlePublish}
                disabled={!canPublish}
                style={{
                  fontSize: 11, padding: '5px 16px', borderRadius: 2,
                  border: 'none', cursor: canPublish ? 'pointer' : 'not-allowed',
                  background: canPublish ? 'var(--color-success)' : 'var(--color-bg-surface)',
                  color: canPublish ? '#000' : 'var(--color-text-muted)',
                  fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6,
                  opacity: canPublish ? 1 : 0.5,
                }}
              >
                {pubState === 'publishing'
                  ? <><Loader size={11} className="animate-spin" /> {t('Publishing…')}</>
                  : <><Send size={11} /> {t('Publish to Confluence')}</>
                }
              </button>

              {pubState === 'done' && (
                <span style={{ fontSize: 11, color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle size={12} /> {t('Published')}
                  {publishedUrl && (
                    <a href={publishedUrl} target="_blank" rel="noreferrer"
                      style={{ marginLeft: 4, color: '#60a5fa', textDecoration: 'underline' }}>
                      {t('Open')}
                    </a>
                  )}
                </span>
              )}
              {pubState === 'error' && (
                <span style={{ fontSize: 11, color: 'var(--color-error)', maxWidth: 280, lineHeight: 1.4 }}>{pubError}</span>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ── Minimal FieldRow (local, no password toggle needed) ──────────────────────

function FieldRow({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <label style={{ fontSize: 11, color: 'var(--color-text-muted)', minWidth: 110, flexShrink: 0 }}>{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        style={{
          flex: 1, borderRadius: 2, padding: '5px 8px',
          background: 'var(--color-bg-base)', color: 'var(--color-text-primary)',
          border: '1px solid var(--color-border)', fontSize: 12, outline: 'none',
          boxSizing: 'border-box',
        }}
      />
    </div>
  )
}
