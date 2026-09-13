/**
 * McpTab — how to talk to this vault from an AI client. The Worker is the MCP server; this tab
 * only hands out the connection commands and lists the tools, for whichever server the app is
 * connected to (web: the team server; desktop: the team server if configured, else the local
 * MCP server in mcp/).
 */
import { useState } from 'react'
import { Terminal, Copy, Check, Plug } from 'lucide-react'
import { isWebMode, loadWebConfig } from '@/web/config'
import { useT } from '@/i18n'

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
  color: 'var(--color-text-muted)', marginBottom: 10,
}
const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12, padding: 14, borderRadius: 2,
  background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)',
}
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }
const codeBox: React.CSSProperties = {
  display: 'block', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  color: 'var(--color-text-primary)', background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)',
  borderRadius: 2, padding: '8px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const TOOLS: [string, string][] = [
  ['vault_search', 'Search the vault (BM25 + semantic, fused by rank)'],
  ['vault_recall', 'What the team knows about a topic — matching documents, the documents linked around them, member memory and remarks, in one bundle'],
  ['vault_read', 'Read a document by path; an image path returns the image and its image document'],
  ['vault_history', 'How a document changed — archived versions and a diff to now'],
  ['images_undescribed', 'Images nobody has described yet — read each with vault_read, write its image document with vault_write'],
  ['vault_list', 'List documents, optionally under a folder'],
  ['graph_lint', 'Structural lint: phantom links, single points of failure, orphans, stale hubs, near-duplicates'],
  ['graph_suggest_links', 'Documents a piece of text should link to'],
  ['vault_propose', 'Record an idea or decision as a proposal in _agent/ (never straight into the vault)'],
  ['vault_proposals', 'List pending proposals'],
  ['vault_promote', 'Promote a proposal into the vault — after a person approves it'],
  ['vault_write', 'Create or replace a document directly (only when explicitly asked); personal=true keeps it to you'],
  ['vault_visibility', 'Share a personal document with the team, or take back one only you have ever saved'],
  ['vault_changes', 'What changed since a date — authors, titles, deletions'],
  ['vault_me', 'Your desk — your documents, remarks on them, proposals citing them, a link to the page'],
  ['members_list · member_remember · member_report', 'The AI members (Settings → AI Members), their memory notes and routine runs; the `member` prompt takes one on'],
]

function CopyButton({ text, id }: { text: string; id: string }) {
  const t = useT()
  const [done, setDone] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) } catch { /* clipboard blocked */ }
  }
  return (
    <button onClick={copy} data-testid={`copy-${id}`} title={t('Copy')} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', borderRadius: 2, fontSize: 11, border: '1px solid var(--color-border)', background: 'transparent', color: done ? 'var(--color-success)' : 'var(--color-text-secondary)', cursor: 'pointer' }}>
      {done ? <Check size={11} /> : <Copy size={11} />} {done ? t('Copied') : t('Copy')}
    </button>
  )
}

function Snippet({ id, title, text, note }: { id: string; title: string; text: string; note?: string }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{title}</span>
        <CopyButton text={text} id={id} />
      </div>
      <code style={codeBox} data-testid={`snippet-${id}`}>{text}</code>
      {note && <div style={{ ...hint, marginTop: 4 }}>{note}</div>}
    </div>
  )
}

export default function McpTab() {
  const t = useT()
  const web = isWebMode()
  const config = loadWebConfig()
  const serverUrl = config?.url ?? ''
  const signedIn = config?.auth === 'oauth'
  const mcpUrl = serverUrl ? `${serverUrl}/mcp` : ''

  const claudeCode = signedIn || !serverUrl
    ? `claude mcp add --transport http strata ${mcpUrl || 'https://<worker>/mcp'}`
    : `claude mcp add --transport http strata ${mcpUrl} --header "Authorization: Bearer <team token>"`
  const jsonConfig = JSON.stringify({
    mcpServers: {
      strata: signedIn || !serverUrl
        ? { type: 'http', url: mcpUrl || 'https://<worker>/mcp' }
        : { type: 'http', url: mcpUrl, headers: { Authorization: 'Bearer <team token>' } },
    },
  }, null, 2)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
        <Plug size={16} color="var(--color-accent)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>
            {serverUrl ? t('This vault is an MCP server') : t('No team server connected')}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2, wordBreak: 'break-all' }} data-testid="mcp-url">
            {mcpUrl || (web ? t('Connect to a server first (Settings → Server).') : t('Team Sync is not configured; the local MCP server in mcp/ still works.'))}
          </div>
        </div>
      </div>

      {serverUrl && (
        <div>
          <div style={sectionLabel}>{t('Connect a client')}</div>
          <div style={card}>
            <Snippet id="claude-code" title="Claude Code" text={claudeCode}
              note={signedIn ? t('The first tool call opens a Google sign-in in your browser; the token is then kept by Claude Code.') : t('Uses the shared team token. With Google sign-in enabled on the server the header is not needed.')} />
            <Snippet id="json" title="Cursor · Claude Desktop · Windsurf (mcp.json)" text={jsonConfig}
              note={t('Add to the client\'s MCP configuration file. Clients that support OAuth sign in on first use.')} />
          </div>
        </div>
      )}

      {!web && (
        <div>
          <div style={sectionLabel}>{t('Local MCP server (desktop)')}</div>
          <div style={card}>
            <Snippet id="local" title={t('Run from the repository')} text={'cd mcp && npm install && npm start'}
              note={t('Reads the vault folder from mcp-config.json. Includes the Python tools and Slack process control that the hosted server does not have.')} />
          </div>
        </div>
      )}

      <div>
        <div style={sectionLabel}>{t('Tools')}</div>
        <div style={card}>
          {TOOLS.map(([name, desc]) => (
            <div key={name} style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 11 }}>
              <code style={{ color: 'var(--color-accent)', flexShrink: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>{name}</code>
              <span style={{ color: 'var(--color-text-muted)' }}>{t(desc)}</span>
            </div>
          ))}
          <div style={{ ...hint, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
            <Terminal size={12} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>{(() => {
              const [before, after] = t('Ask your client things like “what do we know about the stamina system?”, “lint the vault”, or “remember that we decided X” — the last one lands in {tag} as a proposal for a person to promote.').split('{tag}')
              return <>{before}<code>_agent/</code>{after}</>
            })()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
