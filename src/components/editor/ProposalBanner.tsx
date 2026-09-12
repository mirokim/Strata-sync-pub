/**
 * ProposalBanner — shown above a document that lives in `_agent/`.
 *
 * Agents may only write proposals; a person decides here whether the note joins the vault
 * (frontmatter stripped, moved to the chosen folder) or is discarded.
 */
import { useMemo, useState } from 'react'
import { Bot, Check, Trash2 } from 'lucide-react'
import type { LoadedDocument } from '@/types'
import { isProposal, proposalSource, promoteProposal, discardProposal } from '@/lib/proposals'
import { useT } from '@/i18n'

interface Props {
  doc: LoadedDocument
  vaultPath: string | null
  /** Vault folders offered as destinations (top-level, without `_`-prefixed ones). */
  folders: string[]
  onDone: (result: { kind: 'promoted'; newAbsolutePath: string } | { kind: 'discarded' }) => void
  onError: (message: string) => void
}

export default function ProposalBanner({ doc, vaultPath, folders, onDone, onError }: Props) {
  const t = useT()
  const [dest, setDest] = useState('')
  const [busy, setBusy] = useState<'promote' | 'discard' | null>(null)
  const source = useMemo(() => proposalSource(doc), [doc])
  const options = useMemo(() => folders.filter(f => f && !f.startsWith('_') && !f.startsWith('.')).sort(), [folders])

  if (!isProposal(doc) || !vaultPath) return null

  const promote = async () => {
    setBusy('promote')
    try {
      const r = await promoteProposal(doc, vaultPath, dest)
      onDone({ kind: 'promoted', newAbsolutePath: r.newAbsolutePath })
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }
  const discard = async () => {
    if (!window.confirm(t('Discard the proposal "{name}"? This deletes the file.', { name: doc.filename.replace(/\.md$/i, '') }))) return
    setBusy('discard')
    try {
      await discardProposal(doc)
      onDone({ kind: 'discarded' })
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }

  return (
    <div data-testid="proposal-banner" style={{
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      padding: '8px 12px', borderBottom: '1px solid var(--color-border)',
      background: 'var(--color-bg-surface)', fontSize: 12,
    }}>
      <Bot size={14} color="var(--color-accent)" />
      <span style={{ color: 'var(--color-text-primary)' }}>
        {t('Proposed by')} <strong>{source}</strong> {t('— not part of the vault yet. Search ranks it lower and the lint ignores it.')}
      </span>
      <span style={{ flex: 1 }} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-muted)' }}>
        {t('into')}
        <select value={dest} onChange={e => setDest(e.target.value)} data-testid="proposal-dest"
          style={{ fontSize: 12, padding: '3px 6px', borderRadius: 2, border: '1px solid var(--color-border)', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
          <option value="">{t('(vault root)')}</option>
          {options.map(f => <option key={f} value={f}>{f}/</option>)}
        </select>
      </label>
      <button onClick={promote} disabled={busy !== null} data-testid="proposal-promote"
        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 2, fontSize: 12, fontWeight: 500, border: 'none', background: 'var(--color-accent)', color: '#fff', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
        <Check size={12} /> {t('Promote')}
      </button>
      <button onClick={discard} disabled={busy !== null} data-testid="proposal-discard"
        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 2, fontSize: 12, border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-muted)', cursor: 'pointer' }}>
        <Trash2 size={12} /> {t('Discard')}
      </button>
    </div>
  )
}
