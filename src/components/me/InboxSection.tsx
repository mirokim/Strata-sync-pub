/**
 * Inbox on My desk — questions and tasks between teammates (and their agents).
 *
 * "Waiting for you": items addressed to me, each with a reply box (answered / done / declined).
 * "Sent": what I asked others, with their replies. "Ask a teammate": send a new one by name.
 * The same items reach agents through MCP `inbox_list` / `inbox_reply` / `inbox_send`.
 */
import { useState } from 'react'
import { Send, MessageCircleQuestion, ClipboardList, Check, X } from 'lucide-react'
import type { InboxItem, InboxKind, InboxStatus, InboxView } from '@/web/remoteClient'
import { currentRemoteVault } from '@/web/remoteVault'
import { showToast } from '@/stores/toastStore'
import { useT } from '@/i18n'

interface Props {
  inbox: InboxView
  /** Called after any change so the desk reloads */
  onChanged: () => void
  /** Open a vault path in the editor */
  open: (path: string) => void
  relative: (iso: string) => string
}

const STATUS_LABEL: Record<InboxStatus, string> = { open: 'Waiting', answered: 'Answered', done: 'Done', declined: 'Declined' }

export default function InboxSection({ inbox, onChanged, open, relative }: Props) {
  const t = useT()
  const [replyFor, setReplyFor] = useState<string | null>(null)
  const [replyText, setReplyText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [compose, setCompose] = useState(false)
  const [draft, setDraft] = useState<{ to: string; kind: InboxKind; title: string; body: string }>({ to: '', kind: 'question', title: '', body: '' })

  const client = () => currentRemoteVault()?.client

  const reply = async (item: InboxItem, status: Exclude<InboxStatus, 'open'>) => {
    const c = client()
    if (!c) return
    const text = replyText.trim()
    if (!text && status !== 'declined') { showToast(t('Write a reply first'), 'error'); return }
    setBusy(item.path)
    try {
      await c.inboxReply(item.path, text || t('(declined without a reply)'), status)
      setReplyFor(null); setReplyText('')
      showToast(status === 'declined' ? t('Declined') : t('Reply sent to {name}', { name: item.from }), 'success')
      onChanged()
    } catch (e) { showToast(e instanceof Error ? e.message : String(e), 'error') }
    finally { setBusy(null) }
  }

  const send = async () => {
    const c = client()
    if (!c) return
    if (!draft.to.trim() || !draft.title.trim() || !draft.body.trim()) { showToast(t('Name, title and text are required'), 'error'); return }
    setBusy('compose')
    try {
      await c.inboxSend({ to: draft.to.trim(), kind: draft.kind, title: draft.title.trim(), body: draft.body.trim() })
      showToast(t('Sent to {name} — their agent will see it next time it runs', { name: draft.to.trim() }), 'success')
      setDraft({ to: '', kind: 'question', title: '', body: '' }); setCompose(false)
      onChanged()
    } catch (e) { showToast(e instanceof Error ? e.message : String(e), 'error') }
    finally { setBusy(null) }
  }

  const waiting = inbox.forMe.filter(i => i.status === 'open')
  const doneForMe = inbox.forMe.filter(i => i.status !== 'open')
  const box = { border: '1px solid var(--color-border)', background: 'var(--color-bg-secondary)' }
  const input = { width: '100%', background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)', borderRadius: 4, color: 'var(--color-text-primary)', padding: '5px 7px', fontSize: 12 } as const
  const btn = (accent = false) => ({ display: 'flex', alignItems: 'center', gap: 4, background: accent ? 'var(--color-accent)' : 'transparent', border: `1px solid ${accent ? 'var(--color-accent)' : 'var(--color-border)'}`, borderRadius: 4, color: accent ? '#fff' : 'var(--color-text-secondary)', cursor: 'pointer', padding: '3px 8px', fontSize: 11 } as const)

  const Item = ({ item, mine }: { item: InboxItem; mine: boolean }) => (
    <div className="rounded px-2 py-1.5" style={{ fontSize: 12 }} data-testid={`inbox-item-${item.path}`}>
      <div className="flex items-center gap-2">
        <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>{item.kind === 'task' ? <ClipboardList size={12} /> : <MessageCircleQuestion size={12} />}</span>
        <button onClick={() => open(item.path)} className="truncate flex-1 text-left hover:underline" style={{ color: 'var(--color-text-primary)' }} title={item.path}>{item.title}</button>
        <span style={{ color: 'var(--color-text-muted)', fontSize: 11, flexShrink: 0 }}>{mine ? `→ ${item.to}` : `← ${item.from}`} · {relative(item.created)}</span>
        {item.status !== 'open' && <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 8, background: 'var(--color-bg-hover)', color: 'var(--color-text-muted)' }}>{t(STATUS_LABEL[item.status])}</span>}
      </div>
      <div style={{ color: 'var(--color-text-secondary)', margin: '3px 0 0 20px', whiteSpace: 'pre-wrap' }}>{item.body.length > 400 ? item.body.slice(0, 400) + '…' : item.body}</div>
      {item.replies.map((r, i) => (
        <div key={i} style={{ margin: '4px 0 0 20px', paddingLeft: 8, borderLeft: '2px solid var(--color-accent)', color: 'var(--color-text-primary)', whiteSpace: 'pre-wrap' }}>
          <span style={{ color: 'var(--color-accent)', fontSize: 11 }}>{r.author} · {relative(r.at)}</span><br />{r.text}
        </div>
      ))}
      {!mine && item.status === 'open' && (
        replyFor === item.path ? (
          <div className="flex flex-col gap-1.5" style={{ margin: '6px 0 0 20px' }}>
            <textarea value={replyText} onChange={e => setReplyText(e.target.value)} rows={3} style={{ ...input, resize: 'vertical' }} placeholder={item.kind === 'task' ? t('What you did, with links to the results') : t('Your answer')} data-testid="inbox-reply-text" />
            <div className="flex gap-1.5">
              <button style={btn(true)} disabled={busy === item.path} onClick={() => void reply(item, item.kind === 'task' ? 'done' : 'answered')} data-testid="inbox-reply-send"><Check size={11} />{item.kind === 'task' ? t('Done') : t('Answer')}</button>
              <button style={btn()} disabled={busy === item.path} onClick={() => void reply(item, 'declined')}><X size={11} />{t('Decline')}</button>
              <button style={btn()} onClick={() => { setReplyFor(null); setReplyText('') }}>{t('Cancel')}</button>
            </div>
          </div>
        ) : (
          <button style={{ ...btn(), margin: '6px 0 0 20px' }} onClick={() => { setReplyFor(item.path); setReplyText('') }} data-testid="inbox-reply-open">{item.kind === 'task' ? t('Report result') : t('Reply')}</button>
        )
      )}
      {mine && item.status === 'open' && (
        <button style={{ ...btn(), margin: '6px 0 0 20px' }} disabled={busy === item.path} onClick={() => { setReplyText(''); void reply(item, 'declined') }}>{t('Withdraw')}</button>
      )}
    </div>
  )

  return (
    <>
      <section className="rounded-lg p-3" style={box} data-testid="me-section-inbox">
        <div className="flex items-center gap-1.5 mb-2" style={{ color: 'var(--color-text-secondary)', fontSize: 12, fontWeight: 600 }}>
          <MessageCircleQuestion size={13} style={{ color: 'var(--color-text-muted)' }} />
          <span>{t('Waiting for you')}</span>
          <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>{waiting.length}</span>
          <div className="flex-1" />
          <button style={btn(!compose)} onClick={() => setCompose(v => !v)} data-testid="inbox-compose"><Send size={11} />{t('Ask a teammate')}</button>
        </div>
        {compose && (
          <div className="flex flex-col gap-1.5 mb-3 p-2 rounded" style={{ background: 'var(--color-bg-primary)', border: '1px solid var(--color-border)' }} data-testid="inbox-compose-form">
            <div className="flex gap-1.5">
              <input style={{ ...input, flex: 1 }} placeholder={t('Name of the teammate')} value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} data-testid="inbox-to" />
              <select style={{ ...input, width: 'auto' }} value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as InboxKind })}>
                <option value="question">{t('Question')}</option>
                <option value="task">{t('Task')}</option>
              </select>
            </div>
            <input style={input} placeholder={t('Title')} value={draft.title} onChange={e => setDraft({ ...draft, title: e.target.value })} data-testid="inbox-title" />
            <textarea style={{ ...input, resize: 'vertical' }} rows={3} placeholder={t('What do you want to know or have done? Their agent answers with their context.')} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} data-testid="inbox-body" />
            <div className="flex gap-1.5">
              <button style={btn(true)} disabled={busy === 'compose'} onClick={() => void send()} data-testid="inbox-send"><Send size={11} />{t('Send')}</button>
              <button style={btn()} onClick={() => setCompose(false)}>{t('Cancel')}</button>
            </div>
          </div>
        )}
        {waiting.length === 0 && !compose && <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '2px 8px' }}>{t('Nothing is waiting for you')}</div>}
        <div className="flex flex-col gap-1">{waiting.map(i => <Item key={i.path} item={i} mine={false} />)}</div>
        {doneForMe.length > 0 && (
          <details style={{ marginTop: 6 }}>
            <summary style={{ color: 'var(--color-text-muted)', fontSize: 11, cursor: 'pointer' }}>{t('Answered by you ({count})', { count: doneForMe.length })}</summary>
            <div className="flex flex-col gap-1">{doneForMe.map(i => <Item key={i.path} item={i} mine={false} />)}</div>
          </details>
        )}
      </section>

      <section className="rounded-lg p-3" style={box} data-testid="me-section-sent">
        <div className="flex items-center gap-1.5 mb-2" style={{ color: 'var(--color-text-secondary)', fontSize: 12, fontWeight: 600 }}>
          <Send size={13} style={{ color: 'var(--color-text-muted)' }} />
          <span>{t('Asked by me')}</span>
          <span style={{ color: 'var(--color-text-muted)', fontWeight: 400 }}>{inbox.sent.length}</span>
        </div>
        {inbox.sent.length === 0 && <div style={{ color: 'var(--color-text-muted)', fontSize: 12, padding: '2px 8px' }}>{t('You have not asked anyone yet')}</div>}
        <div className="flex flex-col gap-1">{inbox.sent.map(i => <Item key={i.path} item={i} mine />)}</div>
      </section>
    </>
  )
}
