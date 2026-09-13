/**
 * My desk — the vault from one person's side (web mode only; reads GET /v1/me/overview).
 *
 * Same data an MCP client gets from `vault_me`; the tool hands the user `?view=me`, which opens
 * this panel. Rows open the document in the editor (remarks open it with the Brain panel, where
 * the remark is shown).
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, FileText, EyeOff, MessageSquare, Lightbulb, Users, User } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useVaultStore } from '@/stores/vaultStore'
import { currentRemoteVault } from '@/web/remoteVault'
import type { MeOverview, MeItem } from '@/web/remoteClient'
import { useT } from '@/i18n'
import InboxSection from './InboxSection'

function relative(iso: string, t: ReturnType<typeof useT>): string {
  const ms = Date.now() - Date.parse(iso)
  const m = Math.round(ms / 60_000)
  if (m < 1) return t('just now')
  if (m < 60) return t('{n} min ago', { n: m })
  const h = Math.round(m / 60)
  if (h < 24) return t('{n} h ago', { n: h })
  const d = Math.round(h / 24)
  if (d < 30) return t('{n} d ago', { n: d })
  return iso.slice(0, 10)
}

export default function MyDeskPanel() {
  const t = useT()
  const [data, setData] = useState<MeOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const openInEditor = useUIStore(s => s.openInEditor)
  const loadedDocuments = useVaultStore(s => s.loadedDocuments)

  const load = useCallback(async () => {
    const client = currentRemoteVault()?.client
    if (!client) { setError(t('Connect to a team server to see your desk')); return }
    setLoading(true)
    try { setData(await client.meOverview()); setError(null) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setLoading(false) }
  }, [t])

  useEffect(() => { void load() }, [load])

  // Server paths are physical (`_personal/<owner>/…`); the app knows documents by their virtual path
  const open = useCallback((path: string, withBrain = false) => {
    const virtual = currentRemoteVault()?.virtualOf(path).path ?? path
    const rel = (d: { folderPath: string; filename: string }) => (d.folderPath ? `${d.folderPath}/${d.filename}` : d.filename).replace(/\\/g, '/')
    const doc = loadedDocuments?.find(d => rel(d) === virtual || rel(d) === path)
    if (!doc) return
    if (withBrain) useUIStore.setState({ brainPanelOpen: true })
    openInEditor(doc.id)
  }, [loadedDocuments, openInEditor])

  // Render functions rather than components defined inside render (those remount on every render)
  const row = (item: MeItem, icon?: React.ReactNode, sub?: string) => (
    <button
      key={item.path}
      onClick={() => open(item.path)}
      className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
      style={{ color: 'var(--color-text-primary)', fontSize: 12 }}
      title={item.path}
    >
      <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>{icon ?? (item.personal ? <EyeOff size={12} /> : <FileText size={12} />)}</span>
      <span className="truncate flex-1">{item.title}</span>
      <span style={{ color: 'var(--color-text-muted)', fontSize: 11, flexShrink: 0 }}>{sub ?? relative(item.at, t)}</span>
    </button>
  )

  const section = (title: string, count: number, icon: React.ReactNode, empty: string, children: React.ReactNode) => (
    <section key={title} className="rounded-lg p-3" style={{ border: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)' }} data-testid={`me-section-${title}`}>
      <div className="flex items-center gap-1.5 mb-2" style={{ color: 'var(--color-text-secondary)', fontSize: 12, fontWeight: 600 }}>
        <span style={{ color: 'var(--color-text-muted)' }}>{icon}</span>
        <span>{title}</span>
        <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>{count}</span>
      </div>
      {count === 0 ? <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '2px 8px' }}>{empty}</div> : <div className="flex flex-col">{children}</div>}
    </section>
  )

  return (
    <div className="flex flex-col h-full overflow-hidden" data-testid="my-desk">
      <div className="flex items-center gap-2 px-4 py-2.5" style={{ borderBottom: '1px solid var(--color-border)' }}>
        <User size={14} style={{ color: 'var(--color-accent)' }} />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)' }}>{t('My desk')}</span>
        {data && <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{data.identity.author || data.identity.sub}</span>}
        <div className="flex-1" />
        <button onClick={() => void load()} disabled={loading} title={t('Refresh')} aria-label={t('Refresh')}
          className="flex items-center justify-center w-7 h-7 rounded transition-colors hover:bg-[var(--color-bg-hover)]"
          style={{ color: 'var(--color-text-muted)' }}>
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {error && <div style={{ color: 'var(--color-error)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
        {!data && !error && <div style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>{t('Loading…')}</div>}
        {data && (
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
            <InboxSection inbox={data.inbox} onChanged={() => void load()} open={open} relative={iso => relative(iso, t)} />
            {section(t('Remarks on my documents'), data.remarks.length, <MessageSquare size={13} />, t('No member has remarked on your documents yet'), <>
              {data.remarks.map(r => (
                <button key={`${r.member}/${r.path}`} onClick={() => open(r.path, true)} title={r.path}
                  className="w-full text-left flex items-center gap-2 px-2 py-1.5 rounded transition-colors hover:bg-[var(--color-bg-hover)]" style={{ color: 'var(--color-text-primary)', fontSize: 12 }}>
                  <span style={{ color: 'var(--color-accent)', flexShrink: 0 }}>{r.member}</span>
                  <span className="truncate flex-1">{r.title}</span>
                  <span style={{ color: 'var(--color-text-muted)', fontSize: 11, flexShrink: 0 }}>{relative(r.at, t)}</span>
                </button>
              ))}
            </>)}

            {section(t('Proposals citing my documents'), data.proposalsCitingMine.length, <Lightbulb size={13} />, t('No open proposal cites your documents'), <>
              {data.proposalsCitingMine.map(p => (
                row({ path: p.path, title: p.title, author: p.author, at: p.at }, <Lightbulb size={12} />, `${p.author} → ${p.cites.join(', ')}`)
              ))}
            </>)}

            {section(t('Changed by others recently'), data.recentByOthers.length, <Users size={13} />, t('Nothing changed by others yet'), <>
              {data.recentByOthers.map(i => row(i, undefined, `${i.author} · ${relative(i.at, t)}`))}
            </>)}

            {section(t('My recent documents'), data.counts.authored, <FileText size={13} />, t('You have not saved a team document yet'), <>
              {data.authored.map(i => row(i))}
            </>)}

            {section(t('My personal documents'), data.counts.personal, <EyeOff size={13} />, data.identity.service ? t('Sign in with Google to keep personal documents') : t('No personal documents — mark one "Only me" in the editor'), <>
              {data.personal.map(i => row(i))}
            </>)}
          </div>
        )}
      </div>
    </div>
  )
}
