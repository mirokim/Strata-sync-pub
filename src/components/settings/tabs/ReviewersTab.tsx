/**
 * ReviewersTab — who reads a saved document on the server. The set lives in the vault
 * (_system/reviewers.json) so every teammate and every client sees the same reviewers. Presets
 * cover common kinds of teams; everything is editable, and any reviewer can be the one who
 * writes the synthesis.
 */
import { useEffect, useState } from 'react'
import { Users, Plus, Trash2, Save, Loader2, AlertTriangle, Check } from 'lucide-react'
import { fieldInputStyle } from '../settingsShared'
import { currentRemoteVault } from '@/web/remoteVault'
import type { ReviewerConfig, Reviewer } from '@/web/remoteClient'

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
  color: 'var(--color-text-muted)', marginBottom: 10,
}
const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12, padding: 14, borderRadius: 2,
  background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)',
}
const label: React.CSSProperties = { fontSize: 11, fontWeight: 500, color: 'var(--color-text-muted)', display: 'block', marginBottom: 5 }
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }
const button: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 2, fontSize: 12, fontWeight: 500,
  border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer',
}
const PRESET_LABELS: Record<string, string> = {
  generic: 'General team', product: 'Product team', legal: 'Legal', research: 'Research group', worldbuilding: "Writers' room", game: 'Game studio',
}

function slug(name: string, taken: Set<string>): string {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'reviewer'
  let id = base, n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  return id
}

export default function ReviewersTab() {
  const client = currentRemoteVault()?.client
  const [config, setConfig] = useState<ReviewerConfig | null>(null)
  const [presets, setPresets] = useState<Record<string, ReviewerConfig>>({})
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!client) return
    client.reviewers().then(r => { setConfig(r.config); setPresets(r.presets) }).catch(e => setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) }))
  }, [client])

  if (!client) return <div style={hint}>Reviewers are configured on the team server; connect first (Settings → Server).</div>
  if (!config) return <div style={hint}>{message ? message.text : 'Loading…'}</div>

  const update = (next: ReviewerConfig) => { setConfig(next); setDirty(true); setMessage(null) }
  const setReviewer = (i: number, patch: Partial<Reviewer>) => update({ ...config, reviewers: config.reviewers.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const remove = (i: number) => {
    const reviewers = config.reviewers.filter((_, j) => j !== i)
    const synthesizer = reviewers.some(r => r.id === config.synthesizer && r.enabled) ? config.synthesizer : (reviewers.find(r => r.enabled)?.id ?? '')
    update({ ...config, reviewers, synthesizer })
  }
  const add = () => {
    const taken = new Set(config.reviewers.map(r => r.id))
    update({ ...config, reviewers: [...config.reviewers, { id: slug('reviewer', taken), name: 'New reviewer', focus: '', enabled: true }] })
  }
  const enabledIds = config.reviewers.filter(r => r.enabled)
  const problem = config.reviewers.length === 0 ? 'Add at least one reviewer.'
    : enabledIds.length === 0 ? 'Enable at least one reviewer.'
    : !enabledIds.some(r => r.id === config.synthesizer) ? 'Pick an enabled reviewer to write the synthesis.'
    : config.reviewers.some(r => !r.name.trim() || !r.focus.trim()) ? 'Every reviewer needs a name and a focus.'
    : null

  const save = async () => {
    if (problem) { setMessage({ kind: 'error', text: problem }); return }
    setBusy(true); setMessage(null)
    try {
      const r = await client.saveReviewers(config)
      setConfig(r.config); setDirty(false); setMessage({ kind: 'ok', text: 'Saved — the next review uses this set.' })
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
        <Users size={16} color="var(--color-accent)" />
        <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-primary)' }}>
          {enabledIds.length} reviewer{enabledIds.length === 1 ? '' : 's'} read every saved document independently; <b>{config.reviewers.find(r => r.id === config.synthesizer)?.name ?? '—'}</b> writes the synthesis into <code>_reviews/</code>.
        </div>
        <select
          value=""
          onChange={e => { const p = presets[e.target.value]; if (p) update({ ...p }) }}
          style={{ ...fieldInputStyle, width: 'auto' }}
          data-testid="reviewers-preset"
        >
          <option value="">Load preset…</option>
          {Object.keys(presets).map(k => <option key={k} value={k}>{PRESET_LABELS[k] ?? k}</option>)}
        </select>
      </div>

      <div>
        <div style={sectionLabel}>The vault is…</div>
        <div style={card}>
          <input value={config.context} onChange={e => update({ ...config, context: e.target.value })} placeholder="a product team's decision log" style={fieldInputStyle} data-testid="reviewers-context" />
          <div style={hint}>Finishes the sentence “You are the … reviewing a document a colleague just saved to …”. Reviews are written in the document's language.</div>
        </div>
      </div>

      <div>
        <div style={{ ...sectionLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Reviewers</span>
          <button onClick={add} disabled={config.reviewers.length >= 8} style={{ ...button, padding: '3px 8px', fontSize: 11 }} data-testid="reviewers-add"><Plus size={11} /> Add</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {config.reviewers.map((r, i) => (
            <div key={r.id} style={{ ...card, gap: 8, opacity: r.enabled ? 1 : 0.6 }} data-testid={`reviewer-${r.id}`}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" checked={r.enabled} onChange={e => setReviewer(i, { enabled: e.target.checked })} title="Enabled" />
                <input value={r.name} onChange={e => setReviewer(i, { name: e.target.value })} placeholder="Name" style={{ ...fieldInputStyle, fontWeight: 600 }} data-testid={`reviewer-name-${r.id}`} />
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                  <input type="radio" name="synthesizer" checked={config.synthesizer === r.id} disabled={!r.enabled} onChange={() => update({ ...config, synthesizer: r.id })} /> writes synthesis
                </label>
                <button onClick={() => remove(i)} title="Remove" style={{ ...button, padding: '4px 6px', color: 'var(--color-error)' }}><Trash2 size={11} /></button>
              </div>
              <div>
                <label style={label}>What this reviewer looks for</label>
                <textarea value={r.focus} onChange={e => setReviewer(i, { focus: e.target.value })} rows={3} style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.5 }} placeholder="The lens: what to check, what to question, what to flag." />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={save} disabled={busy || !dirty} data-testid="reviewers-save" style={{ ...button, background: dirty ? 'var(--color-accent)' : 'transparent', color: dirty ? 'var(--color-bg-primary)' : 'var(--color-text-muted)', border: dirty ? 'none' : '1px solid var(--color-border)' }}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save to server
        </button>
        {message && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: message.kind === 'ok' ? 'var(--color-success)' : 'var(--color-error)' }}>
            {message.kind === 'ok' ? <Check size={12} /> : <AlertTriangle size={12} />} {message.text}
          </span>
        )}
        {!message && problem && dirty && <span style={{ fontSize: 11, color: 'var(--color-warning)' }}>{problem}</span>}
      </div>
      <div style={hint}>Reviews run on the server when a document is saved and need <code>ANTHROPIC_API_KEY</code> there. Folders starting with <code>_</code> or <code>.</code>, conflict copies and notes under 400 characters are never reviewed.</div>
    </div>
  )
}
