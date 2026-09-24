/**
 * BrainPanel — what the shared brain knows around the open document, without being asked:
 * what the AI members said when it was saved, how it changed (server history), which documents
 * point at it and which it points to, proposals that cite it, and documents living in the same
 * neighbourhood. Everything but history comes from the loaded vault (src/lib/brain.ts).
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, History, Link2, MessageSquare, Sparkles, FileQuestion, ArrowUpRight, EyeOff } from 'lucide-react'
import type { LoadedDocument } from '@/types'
import { useVaultStore } from '@/stores/vaultStore'
import { useUIStore } from '@/stores/uiStore'
import { around, docPath, docTitle, type Around } from '@/lib/brain'
import { currentRemoteVault } from '@/web/remoteVault'
import type { HistoryDiff, HistoryVersion } from '@/web/remoteClient'
import { useT } from '@/i18n'

const panel: React.CSSProperties = {
  width: 300, flexShrink: 0, borderLeft: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)',
  overflowY: 'auto', fontSize: 11, color: 'var(--color-text-secondary)', display: 'flex', flexDirection: 'column',
}
const head: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '7px 10px', background: 'transparent', border: 'none',
  borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-primary)', fontSize: 10, fontWeight: 700,
  letterSpacing: '0.06em', textTransform: 'uppercase', cursor: 'pointer', textAlign: 'left',
}
const count: React.CSSProperties = { marginLeft: 'auto', fontWeight: 500, color: 'var(--color-text-muted)', letterSpacing: 0, textTransform: 'none' }
const row: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 6, width: '100%', padding: '4px 10px', background: 'transparent', border: 'none',
  color: 'var(--color-text-primary)', cursor: 'pointer', textAlign: 'left', fontSize: 11,
}
const muted: React.CSSProperties = { color: 'var(--color-text-muted)', fontSize: 10 }
const empty: React.CSSProperties = { padding: '6px 10px', color: 'var(--color-text-muted)', fontSize: 10, lineHeight: 1.5 }

function when(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function Section({ id, icon, title, n, defaultOpen = true, children }: { id: string; icon: React.ReactNode; title: string; n?: number; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div data-testid={`brain-${id}`}>
      <button style={head} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {icon}
        <span>{title}</span>
        {n !== undefined && <span style={count}>{n}</span>}
      </button>
      {open && <div style={{ padding: '4px 0' }}>{children}</div>}
    </div>
  )
}

function DocRow({ doc, note, onOpen }: { doc: LoadedDocument; note?: string; onOpen: (id: string) => void }) {
  const t = useT()
  return (
    <button style={row} onClick={() => onOpen(doc.id)} title={docPath(doc)}>
      {doc.personal && <EyeOff size={10} style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} aria-label={t('Only you can see this')} />}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{docTitle(doc)}</span>
      {note && <span style={{ ...muted, marginLeft: 'auto', flexShrink: 0 }}>{note}</span>}
    </button>
  )
}

/** Remark text: `### Heading` lines become labels, `[[links]]` lose their brackets. */
function RemarkBody({ text }: { text: string }) {
  const lines = text.split('\n').filter(l => l.trim())
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, lineHeight: 1.5 }}>
      {lines.map((l, i) => {
        const h = /^###\s+(.*)$/.exec(l)
        if (h) return <div key={i} style={{ ...muted, fontWeight: 600, marginTop: i ? 4 : 0 }}>{h[1]}</div>
        return <div key={i} style={{ color: 'var(--color-text-secondary)' }}>{l.replace(/^\s*-\s+/, '· ').replace(/\[\[([^\]]+)\]\]/g, '$1')}</div>
      })}
    </div>
  )
}

function HistorySection({ doc }: { doc: LoadedDocument }) {
  const t = useT()
  const remote = currentRemoteVault()
  const client = remote?.client
  // The server keeps personal documents under their owner's prefix; the app path is virtual
  const path = remote ? remote.physicalOf(docPath(doc)) : docPath(doc)
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ etag: string; data: HistoryDiff | null; loading: boolean } | null>(null)

  useEffect(() => {
    if (!client) return
    let live = true
    setVersions(null); setDiff(null); setError(null)
    client.history(path).then(h => { if (live) setVersions(h.versions) }).catch(e => { if (live) setError(e instanceof Error ? e.message : String(e)) })
    return () => { live = false }
  }, [client, path, doc.mtime])

  if (!client) return null
  const show = async (etag: string) => {
    if (diff?.etag === etag) { setDiff(null); return }
    setDiff({ etag, data: null, loading: true })
    try { setDiff({ etag, data: await client.historyDiff(path, etag), loading: false }) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setDiff(null) }
  }
  return (
    <Section id="history" icon={<History size={11} />} title={t('History')} n={versions?.length} defaultOpen={false}>
      {error && <div style={empty}>{error}</div>}
      {versions && versions.length === 0 && <div style={empty}>{t('Only one version so far — the next save starts the history.')}</div>}
      {versions?.slice(0, 8).map(v => (
        <div key={v.etag}>
          <button style={row} onClick={() => show(v.etag)} data-testid={`brain-version-${v.etag.slice(0, 8)}`}>
            <span>{when(v.at)}</span>
            <span style={{ ...muted, marginLeft: 'auto' }}>{v.author || t('unknown')}</span>
          </button>
          {diff?.etag === v.etag && (
            <div style={{ padding: '2px 10px 8px' }}>
              {diff.loading ? <div style={muted}>{t('Comparing…')}</div> : diff.data && (
                <>
                  <div style={{ ...muted, marginBottom: 4 }}>{t('vs now: +{added} −{removed}', { added: diff.data.stats.added, removed: diff.data.stats.removed })}</div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 10, lineHeight: 1.45, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: 2, padding: 6, maxHeight: 260, overflow: 'auto' }}>
                    {diff.data.text.split('\n').map((l, i) => (
                      <div key={i} style={{ color: l.startsWith('+') ? 'var(--color-success)' : l.startsWith('-') ? 'var(--color-error)' : l.startsWith('@@') ? 'var(--color-text-muted)' : 'var(--color-text-secondary)' }}>{l}</div>
                    ))}
                  </pre>
                </>
              )}
            </div>
          )}
        </div>
      ))}
    </Section>
  )
}

function BrainPanel({ doc }: { doc: LoadedDocument }) {
  const t = useT()
  const loadedDocuments = useVaultStore(s => s.loadedDocuments)
  const openInEditor = useUIStore(s => s.openInEditor)
  const info: Around | null = useMemo(() => (loadedDocuments ? around(loadedDocuments, doc) : null), [loadedDocuments, doc])
  if (!info) return null

  return (
    <aside style={panel} data-testid="brain-panel" aria-label={t('Around this document')}>
      <Section id="remarks" icon={<MessageSquare size={11} />} title={t('Members said')} n={info.remarks.length}>
        {info.remarks.length === 0 && <div style={empty}>{t('No member has reacted to this document yet. Members react to saves in their scope (Settings → Members).')}</div>}
        {info.remarks.map(r => (
          <div key={r.doc.id} style={{ padding: '4px 10px 8px', borderBottom: '1px solid var(--color-border)' }} data-testid={`brain-remark-${r.doc.id}`}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 4 }}>
              <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{r.member}</span>
              {r.doc.mtime ? <span style={muted}>{when(r.doc.mtime)}</span> : null}
              <button onClick={() => openInEditor(r.doc.id)} title={t('Open the remark')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 0 }}><ArrowUpRight size={11} /></button>
            </div>
            <RemarkBody text={r.body} />
          </div>
        ))}
      </Section>

      <HistorySection doc={doc} />

      <Section id="linked-from" icon={<Link2 size={11} />} title={t('Linked from')} n={info.linkedFrom.length}>
        {info.linkedFrom.length === 0 && <div style={empty}>{t('Nothing links here yet.')}</div>}
        {info.linkedFrom.map(d => <DocRow key={d.id} doc={d} note={d.folderPath || undefined} onOpen={openInEditor} />)}
      </Section>

      <Section id="links-to" icon={<ArrowUpRight size={11} />} title={t('Links to')} n={info.linksTo.length} defaultOpen={false}>
        {info.linksTo.length === 0 && <div style={empty}>{t('This document links to nothing that exists.')}</div>}
        {info.linksTo.map(d => <DocRow key={d.id} doc={d} note={d.folderPath || undefined} onOpen={openInEditor} />)}
      </Section>

      <Section id="proposals" icon={<FileQuestion size={11} />} title={t('Proposals citing it')} n={info.proposals.length}>
        {info.proposals.length === 0 && <div style={empty}>{t('No pending proposal mentions this document.')}</div>}
        {info.proposals.map(d => <DocRow key={d.id} doc={d} note={d.mtime ? when(d.mtime).slice(5, 10) : undefined} onOpen={openInEditor} />)}
      </Section>

      <Section id="similar" icon={<Sparkles size={11} />} title={t('Same neighbourhood')} n={info.similar.length}>
        {info.similar.length === 0 && <div style={empty}>{t('No document shares its links or tags yet.')}</div>}
        {info.similar.map(s => <DocRow key={s.doc.id} doc={s.doc} note={t('{count} shared', { count: s.shared })} onOpen={openInEditor} />)}
      </Section>
    </aside>
  )
}

/** The editor re-renders per keystroke; the panel only cares about the document object and the vault. */
export default memo(BrainPanel)
