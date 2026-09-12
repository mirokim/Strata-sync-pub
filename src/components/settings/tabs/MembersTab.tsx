/**
 * MembersTab — the team's AI members. Each one is a role (a lens on the vault), a scope, a set of
 * routines, and its own memory note in _members/. The server stores the definitions; the thinking
 * happens in whichever MCP client takes on the member (`/mcp__strata__member name=…`), or on the
 * server when a document in scope is saved (reactions, needs the API key there). Members never
 * edit team documents: proposals in _agent/ and their own memory note only.
 */
import { useEffect, useState } from 'react'
import { Users, Plus, Trash2, Save, Loader2, AlertTriangle, Check, Terminal, ChevronDown, ChevronRight, Zap } from 'lucide-react'
import { fieldInputStyle } from '../settingsShared'
import { currentRemoteVault } from '@/web/remoteVault'
import type { Member, MembersConfig, MembersResponse, Routine } from '@/web/remoteClient'

const sectionLabel: React.CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase',
  color: 'var(--color-text-muted)', marginBottom: 10,
}
const card: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 12, padding: 14, borderRadius: 2,
  background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)',
}
const hint: React.CSSProperties = { fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }
const button: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px', borderRadius: 2, fontSize: 12, fontWeight: 500,
  border: '1px solid var(--color-border)', background: 'transparent', color: 'var(--color-text-primary)', cursor: 'pointer',
}
const smallButton: React.CSSProperties = { ...button, padding: '3px 8px', fontSize: 11 }
const codeBox: React.CSSProperties = {
  display: 'block', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  color: 'var(--color-text-primary)', background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)',
  borderRadius: 2, padding: '8px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}
const fieldLabel: React.CSSProperties = { fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 3 }

function when(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function slug(base: string, taken: Set<string>): string {
  const root = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'member'
  let id = root, n = 2
  while (taken.has(id)) id = `${root}-${n++}`
  return id
}

const splitList = (s: string) => s.split(',').map(x => x.trim()).filter(Boolean)

function validate(config: MembersConfig): string | null {
  for (const m of config.members) {
    if (!m.name.trim()) return 'Every member needs a name.'
    if (!m.role.trim()) return `${m.name}: describe the role in a sentence or two.`
    for (const r of m.routines) if (!r.title.trim() || !r.instructions.trim()) return `${m.name}: every routine needs a title and instructions.`
  }
  const names = config.members.map(m => m.name.trim().toLowerCase())
  if (new Set(names).size !== names.length) return 'Two members share a name; their memory notes would collide.'
  return null
}

export default function MembersTab() {
  const client = currentRemoteVault()?.client
  const [data, setData] = useState<MembersResponse | null>(null)
  const [config, setConfig] = useState<MembersConfig | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!client) return
    client.members().then(d => { setData(d); setConfig(d.config) }).catch(e => setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) }))
  }, [client])

  if (!client) return <div style={hint}>AI members live on the team server; connect first (Settings → Server).</div>
  if (!data || !config) return <div style={hint}>{message ? message.text : 'Loading…'}</div>

  const update = (next: MembersConfig) => { setConfig(next); setDirty(true); setMessage(null) }
  const setMember = (i: number, patch: Partial<Member>) => update({ ...config, members: config.members.map((m, k) => (k === i ? { ...m, ...patch } : m)) })
  const setRoutine = (i: number, j: number, patch: Partial<Routine>) =>
    setMember(i, { routines: config.members[i].routines.map((r, k) => (k === j ? { ...r, ...patch } : r)) })
  const toggle = (id: string) => setOpen(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const addMember = (template: string) => {
    const taken = new Set(config.members.map(m => m.id))
    const base: Omit<Member, 'id'> = template && data.templates[template]
      ? data.templates[template]
      : { name: 'New member', role: '', scope: { folders: [], tags: [] }, reactsOnSave: true, enabled: true, routines: [] }
    const id = slug(base.name, taken)
    const names = new Set(config.members.map(m => m.name.trim().toLowerCase()))
    const name = names.has(base.name.toLowerCase()) ? `${base.name} ${config.members.length + 1}` : base.name
    update({ ...config, members: [...config.members, { ...base, id, name, routines: base.routines.map(r => ({ ...r, runs: [] })) }] })
    setOpen(prev => new Set(prev).add(id))
  }
  const addRoutine = (i: number) => {
    const m = config.members[i]
    const id = slug('routine', new Set(m.routines.map(r => r.id)))
    setMember(i, { routines: [...m.routines, { id, title: 'New routine', instructions: '', cadence: 'weekly', enabled: true, runs: [] }] })
  }

  const save = async () => {
    const problem = validate(config)
    if (problem) { setMessage({ kind: 'error', text: problem }); return }
    setBusy(true); setMessage(null)
    try {
      const saved = await client.saveMembers(config)
      setConfig(saved.config); setDirty(false)
      setMessage({ kind: 'ok', text: 'Saved — clients pick this up on their next `member` prompt.' })
    } catch (e) { setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false) }
  }

  const enabled = config.members.filter(m => m.enabled)
  const first = enabled[0]?.name ?? 'Librarian'
  const routineCount = enabled.reduce((n, m) => n + m.routines.filter(r => r.enabled && r.cadence !== 'manual').length, 0)
  const cron = `claude -p "/mcp__strata__member name=${first}" --allowedTools "mcp__strata__*"`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
        <Users size={16} color="var(--color-accent)" />
        <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-primary)', lineHeight: 1.5 }}>
          {enabled.length} member{enabled.length === 1 ? '' : 's'}, {routineCount} scheduled routine{routineCount === 1 ? '' : 's'}. A member reads the vault through its role, keeps its own memory note in <code>_members/</code>, and writes proposals into <code>_agent/</code> — nothing changes until a person promotes it.
        </div>
      </div>

      <div>
        <div style={sectionLabel}>How a member works</div>
        <div style={card}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Terminal size={13} style={{ flexShrink: 0, marginTop: 3, color: 'var(--color-text-muted)' }} />
            <div style={{ flex: 1 }}>
              <div style={hint}>In Claude Code, with the <code>strata</code> MCP server added (Settings → MCP), take on a member — it runs the routines that are due, then answers you in that role:</div>
              <code style={{ ...codeBox, marginTop: 6 }}>{`/mcp__strata__member name=${first}`}</code>
              <div style={{ ...hint, marginTop: 8 }}>Or let a scheduler wake it every morning (cron, Task Scheduler, a CI job):</div>
              <code style={{ ...codeBox, marginTop: 6 }}>{cron}</code>
              <div style={{ ...hint, marginTop: 6 }}>Add <code>all=true</code> to run every routine regardless of cadence. Each run is recorded under the routine with who ran it.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Zap size={13} style={{ flexShrink: 0, marginTop: 3, color: data.reactionsEnabled ? 'var(--color-success)' : 'var(--color-text-muted)' }} />
            <div style={{ ...hint, flex: 1 }} data-testid="reactions-status">
              {data.reactionsEnabled
                ? <>Reactions are on: when someone saves a document in a member's scope, the member leaves a short remark in <code>_members/&lt;Name&gt;/</code> — what changed, what it collides with, one question.</>
                : <>Reactions on save are off — the server has no <code>ANTHROPIC_API_KEY</code> and reaction queue. Members still work through MCP clients.</>}
            </div>
          </div>
        </div>
      </div>

      <div>
        <div style={{ ...sectionLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Members</span>
          <select value="" onChange={e => { if (e.target.value !== '') addMember(e.target.value) }} disabled={config.members.length >= 12} style={{ ...fieldInputStyle, width: 'auto', padding: '3px 6px', fontSize: 11 }} data-testid="members-add">
            <option value="">+ Add member…</option>
            {Object.entries(data.templates).map(([key, t]) => <option key={key} value={key}>{t.name}</option>)}
            <option value="blank">Blank</option>
          </select>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {config.members.map((m, i) => {
            const expanded = open.has(m.id)
            return (
              <div key={m.id} style={{ ...card, gap: 10, opacity: m.enabled ? 1 : 0.6 }} data-testid={`member-${m.id}`}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => toggle(m.id)} title={expanded ? 'Collapse' : 'Expand'} style={{ ...button, padding: 4, border: 'none' }} data-testid={`member-toggle-${m.id}`}>
                    {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <input type="checkbox" checked={m.enabled} onChange={e => setMember(i, { enabled: e.target.checked })} title="Enabled" />
                  <input value={m.name} onChange={e => setMember(i, { name: e.target.value })} placeholder="Name" style={{ ...fieldInputStyle, fontWeight: 600 }} />
                  <span style={{ ...hint, whiteSpace: 'nowrap' }}>{m.routines.length} routine{m.routines.length === 1 ? '' : 's'}</span>
                  <button onClick={() => update({ ...config, members: config.members.filter((_, k) => k !== i) })} title="Remove member" style={{ ...button, padding: '4px 6px', color: 'var(--color-error)' }}><Trash2 size={11} /></button>
                </div>
                {!expanded && <div style={{ ...hint, paddingLeft: 30, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.role || 'No role yet.'}</div>}
                {expanded && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 30 }}>
                    <div>
                      <div style={fieldLabel}>Role — what this member cares about and how it thinks</div>
                      <textarea value={m.role} onChange={e => setMember(i, { role: e.target.value })} rows={3} style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.5 }} placeholder="You hold the user's eye and hand. You care about flows, screens, states…" />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                      <div>
                        <div style={fieldLabel}>Folders (comma-separated; empty = whole vault)</div>
                        <input value={m.scope.folders.join(', ')} onChange={e => setMember(i, { scope: { ...m.scope, folders: splitList(e.target.value) } })} placeholder="design, ui" style={fieldInputStyle} />
                      </div>
                      <div>
                        <div style={fieldLabel}>Tags</div>
                        <input value={m.scope.tags.join(', ')} onChange={e => setMember(i, { scope: { ...m.scope, tags: splitList(e.target.value) } })} placeholder="ui, ux" style={fieldInputStyle} />
                      </div>
                    </div>
                    <label style={{ ...hint, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={m.reactsOnSave} onChange={e => setMember(i, { reactsOnSave: e.target.checked })} />
                      React when a document in scope is saved
                    </label>
                    <div style={hint}>Memory note: <code>_members/{m.name.trim() || 'Name'} (memory).md</code> — the one document this member writes on its own.</div>

                    <div style={{ ...sectionLabel, marginBottom: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>Routines</span>
                      <button onClick={() => addRoutine(i)} disabled={m.routines.length >= 12} style={smallButton} data-testid={`routine-add-${m.id}`}><Plus size={11} /> Add</button>
                    </div>
                    {m.routines.map((r, j) => {
                      const last = r.runs.length ? r.runs[r.runs.length - 1] : null
                      return (
                        <div key={r.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 2, border: '1px solid var(--color-border)', opacity: r.enabled ? 1 : 0.6 }} data-testid={`routine-${m.id}-${r.id}`}>
                          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                            <input type="checkbox" checked={r.enabled} onChange={e => setRoutine(i, j, { enabled: e.target.checked })} title="Enabled" />
                            <input value={r.title} onChange={e => setRoutine(i, j, { title: e.target.value })} placeholder="The question this routine answers" style={{ ...fieldInputStyle, fontWeight: 600 }} />
                            <select value={r.cadence} onChange={e => setRoutine(i, j, { cadence: e.target.value as Routine['cadence'] })} style={{ ...fieldInputStyle, width: 'auto' }}>
                              <option value="daily">daily</option><option value="weekly">weekly</option><option value="manual">manual</option>
                            </select>
                            <button onClick={() => setMember(i, { routines: m.routines.filter((_, k) => k !== j) })} title="Remove routine" style={{ ...button, padding: '4px 6px', color: 'var(--color-error)' }}><Trash2 size={11} /></button>
                          </div>
                          <textarea value={r.instructions} onChange={e => setRoutine(i, j, { instructions: e.target.value })} rows={3} style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.5 }} placeholder="What to read, what to look for, what to propose. Plain language." />
                          <div style={hint} data-testid={`routine-last-${m.id}-${r.id}`}>
                            {last
                              ? <>Last run {when(last.at)} by {last.by} — {last.summary}{last.proposals.length > 0 ? <> · {last.proposals.length} proposal{last.proposals.length === 1 ? '' : 's'}</> : ''}</>
                              : 'Never run yet.'}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={save} disabled={busy || !dirty} data-testid="members-save" style={{ ...button, background: dirty ? 'var(--color-accent)' : 'transparent', color: dirty ? 'var(--color-bg-primary)' : 'var(--color-text-muted)', border: dirty ? 'none' : '1px solid var(--color-border)' }}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save to server
        </button>
        {message && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: message.kind === 'ok' ? 'var(--color-success)' : 'var(--color-error)' }}>
            {message.kind === 'ok' ? <Check size={12} /> : <AlertTriangle size={12} />} {message.text}
          </span>
        )}
      </div>
    </div>
  )
}
