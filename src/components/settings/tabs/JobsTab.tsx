/**
 * JobsTab — standing instructions for the AI clients connected over MCP. The server stores them,
 * hands the due ones out as the `jobs` MCP prompt, and records what each run produced. No model
 * runs on the server: whoever runs `/mcp__strata__jobs` (or a cron line) does the thinking with
 * their own client.
 */
import { useEffect, useState } from 'react'
import { Bot, Plus, Trash2, Save, Loader2, AlertTriangle, Check, Terminal } from 'lucide-react'
import { fieldInputStyle } from '../settingsShared'
import { currentRemoteVault } from '@/web/remoteVault'
import { loadWebConfig } from '@/web/config'
import type { Job, JobsConfig } from '@/web/remoteClient'

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
const codeBox: React.CSSProperties = {
  display: 'block', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
  color: 'var(--color-text-primary)', background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)',
  borderRadius: 2, padding: '8px 10px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

function when(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function slug(base: string, taken: Set<string>): string {
  let id = base, n = 2
  while (taken.has(id)) id = `${base}-${n++}`
  return id
}

export default function JobsTab() {
  const client = currentRemoteVault()?.client
  const config = loadWebConfig()
  const [jobs, setJobs] = useState<JobsConfig | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  useEffect(() => {
    if (!client) return
    client.jobs().then(setJobs).catch(e => setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) }))
  }, [client])

  if (!client) return <div style={hint}>Jobs live on the team server; connect first (Settings → Server).</div>
  if (!jobs) return <div style={hint}>{message ? message.text : 'Loading…'}</div>

  const update = (next: JobsConfig) => { setJobs(next); setDirty(true); setMessage(null) }
  const setJob = (i: number, patch: Partial<Job>) => update({ ...jobs, jobs: jobs.jobs.map((j, k) => (k === i ? { ...j, ...patch } : j)) })
  const add = () => update({ ...jobs, jobs: [...jobs.jobs, { id: slug('job', new Set(jobs.jobs.map(j => j.id))), title: 'New job', instructions: '', cadence: 'daily', enabled: true, runs: [] }] })
  const problem = jobs.jobs.some(j => !j.title.trim() || !j.instructions.trim()) ? 'Every job needs a title and instructions.' : null

  const save = async () => {
    if (problem) { setMessage({ kind: 'error', text: problem }); return }
    setBusy(true); setMessage(null)
    try { setJobs(await client.saveJobs(jobs)); setDirty(false); setMessage({ kind: 'ok', text: 'Saved — the next run picks these up.' }) }
    catch (e) { setMessage({ kind: 'error', text: e instanceof Error ? e.message : String(e) }) }
    finally { setBusy(false) }
  }

  const due = jobs.jobs.filter(j => j.enabled && j.cadence !== 'manual').length
  const cron = `claude -p "/mcp__strata__jobs" --allowedTools "mcp__strata__*"`

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: '2px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 2, background: 'var(--color-bg-surface)', border: '1px solid var(--color-border)' }}>
        <Bot size={16} color="var(--color-accent)" />
        <div style={{ flex: 1, fontSize: 12, color: 'var(--color-text-primary)' }}>
          {jobs.jobs.length} job{jobs.jobs.length === 1 ? '' : 's'}, {due} scheduled. Whoever runs them writes proposals into <code>_agent/</code> — nothing changes until a person promotes it.
        </div>
      </div>

      <div>
        <div style={sectionLabel}>How they run</div>
        <div style={card}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <Terminal size={13} style={{ flexShrink: 0, marginTop: 3, color: 'var(--color-text-muted)' }} />
            <div style={{ flex: 1 }}>
              <div style={hint}>In Claude Code, with the <code>strata</code> MCP server added (Settings → MCP), type:</div>
              <code style={{ ...codeBox, marginTop: 6 }}>/mcp__strata__jobs</code>
              <div style={{ ...hint, marginTop: 8 }}>Or let a scheduler do it every morning (cron, Task Scheduler, a CI job) with the same account:</div>
              <code style={{ ...codeBox, marginTop: 6 }}>{cron}</code>
              <div style={{ ...hint, marginTop: 6 }}>The prompt only includes jobs that are due (daily / weekly since their last run); add <code>all=true</code> to run everything. Each run is recorded below with who ran it and what it proposed.</div>
            </div>
          </div>
        </div>
      </div>

      <div>
        <div style={{ ...sectionLabel, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Jobs</span>
          <button onClick={add} disabled={jobs.jobs.length >= 20} style={{ ...button, padding: '3px 8px', fontSize: 11 }} data-testid="jobs-add"><Plus size={11} /> Add</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {jobs.jobs.map((j, i) => {
            const last = j.runs.length ? j.runs[j.runs.length - 1] : null
            return (
              <div key={j.id} style={{ ...card, gap: 8, opacity: j.enabled ? 1 : 0.6 }} data-testid={`job-${j.id}`}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="checkbox" checked={j.enabled} onChange={e => setJob(i, { enabled: e.target.checked })} title="Enabled" />
                  <input value={j.title} onChange={e => setJob(i, { title: e.target.value })} placeholder="Title" style={{ ...fieldInputStyle, fontWeight: 600 }} />
                  <select value={j.cadence} onChange={e => setJob(i, { cadence: e.target.value as Job['cadence'] })} style={{ ...fieldInputStyle, width: 'auto' }}>
                    <option value="daily">daily</option><option value="weekly">weekly</option><option value="manual">manual</option>
                  </select>
                  <button onClick={() => update({ ...jobs, jobs: jobs.jobs.filter((_, k) => k !== i) })} title="Remove" style={{ ...button, padding: '4px 6px', color: 'var(--color-error)' }}><Trash2 size={11} /></button>
                </div>
                <textarea value={j.instructions} onChange={e => setJob(i, { instructions: e.target.value })} rows={4} style={{ ...fieldInputStyle, resize: 'vertical', lineHeight: 1.5 }} placeholder="What the AI should do, which tools to use, what to propose. Plain language." />
                <div style={hint} data-testid={`job-last-${j.id}`}>
                  {last
                    ? <>Last run {when(last.at)} by {last.by} — {last.summary}{last.proposals.length > 0 ? <> · {last.proposals.length} proposal{last.proposals.length === 1 ? '' : 's'}</> : ''}</>
                    : 'Never run yet.'}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button onClick={save} disabled={busy || !dirty} data-testid="jobs-save" style={{ ...button, background: dirty ? 'var(--color-accent)' : 'transparent', color: dirty ? 'var(--color-bg-primary)' : 'var(--color-text-muted)', border: dirty ? 'none' : '1px solid var(--color-border)' }}>
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save to server
        </button>
        {message && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: message.kind === 'ok' ? 'var(--color-success)' : 'var(--color-error)' }}>
            {message.kind === 'ok' ? <Check size={12} /> : <AlertTriangle size={12} />} {message.text}
          </span>
        )}
      </div>
      {config?.auth !== 'oauth' && <div style={hint}>Runs are attributed to the author name of whoever runs them; with Google sign-in that is their account.</div>}
    </div>
  )
}
