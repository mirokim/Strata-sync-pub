import BrandLogo from '@/components/layout/BrandLogo'
/**
 * AboutTab — what this thing is, in one screen. Kept in step with the product: a shared brain for
 * a team (vault + graph + AI members over MCP), not the earlier director-persona proxy.
 */
import { isWebMode } from '@/web/config'
import { useT } from '@/i18n'

const VERSION = '0.5.0'

export default function AboutTab() {
  const t = useT()
  const web = isWebMode()
  const sectionTitle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    marginBottom: 8,
  }
  const badge: React.CSSProperties = {
    display: 'inline-block',
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 4,
    background: 'var(--color-bg-active)',
    color: 'var(--color-accent)',
    marginRight: 4,
    marginBottom: 4,
  }
  const row: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 2,
    padding: '6px 0',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    fontSize: 11,
  }

  const stack = web
    ? ['React 19', 'TypeScript 5', 'Vite 5', 'Three.js', 'd3-force', 'CodeMirror 6', 'Zustand 5', 'Tailwind CSS 4', 'Cloudflare Workers', 'R2 · D1 · Vectorize · Queues', 'Vercel']
    : ['Electron 41', 'React 19', 'TypeScript 5', 'Vite 5', 'Three.js', 'd3-force', 'CodeMirror 6', 'Zustand 5', 'Tailwind CSS 4', 'Cloudflare Workers', 'MCP']

  return (
    <div className="flex flex-col gap-6">

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>
            <BrandLogo width={220} />
          </h2>
          <p style={{ fontSize: 11, color: 'var(--color-accent)', marginTop: 2 }} data-testid="about-version">
            {t('v{version} · A shared brain for your team', { version: VERSION })}
          </p>
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'right', lineHeight: 1.6 }}>
          <div>{t('Developer')}</div>
          <a href="mailto:miro85a@gmail.com" style={{ color: 'var(--color-accent)', textDecoration: 'none' }}>
            miro85a@gmail.com
          </a>
        </div>
      </div>

      {/* Overview */}
      <div>
        <p style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--color-text-secondary)' }}>
          {(() => {
            const strongStyle = { color: 'var(--color-text-primary)' } as const
            const overview = t('One Markdown vault the whole team writes into, shown as a {tag1} so you can see what connects to what, what is missing, and what is drifting. The same vault is an {tag2}: any AI client you already use can search it, read it and propose to it. {tag3} — roles you define, each with a scope and a memory of its own — react to what people save and run routines, and only ever write proposals for a person to accept.')
            const [p1, rest1] = overview.split('{tag1}')
            const [p2, rest2] = rest1.split('{tag2}')
            const [p3, p4] = rest2.split('{tag3}')
            return <>
              {p1}<strong style={strongStyle}>{t('wikilink graph')}</strong>{p2}
              <strong style={strongStyle}>{t('MCP server')}</strong>{p3}
              <strong style={strongStyle}>{t('AI members')}</strong>{p4}
            </>
          })()}
        </p>
      </div>

      {/* What it does */}
      <div>
        <p style={sectionTitle}>{t('What it does')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[
            { name: t('One vault, many editors'), desc: t('Every save goes to the team server; every other machine picks it up within seconds. Two people editing the same document get a conflict copy, never a silent overwrite.') },
            { name: t('Graph of the shared memory'), desc: t('Documents are nodes, wikilinks are edges. Lint finds phantom links everyone points at, single points of failure, orphans, stale hubs and near-duplicates.') },
            { name: t('Search that understands'), desc: t('BM25 keyword search fused with semantic search (bge-m3 embeddings, rebuilt nightly in batches) — one ranking, both kinds of hit.') },
            { name: t('MCP server'), desc: t('vault_search, vault_read, graph_lint, vault_propose and friends, hosted on the Worker with Google sign-in. Claude Code, Cursor, Claude Desktop connect in one line (Settings → MCP).') },
            { name: t('AI members'), desc: t('A Librarian by default; add a Designer, Editor, Researcher or your own. Each has a role, a scope, routines on a cadence, and a memory note in _members/. They react on save and can be taken on from any MCP client.') },
            { name: t('Proposals, not edits'), desc: t('Whatever an AI wants the team to adopt lands in _agent/ as a proposal. A person promotes it into the vault — or does not.') },
          ].map(({ name, desc }) => (
            <div key={name} style={row}>
              <span style={{ color: 'var(--color-text-primary)', fontWeight: 600, fontSize: 11 }}>{name}</span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 10, lineHeight: 1.5 }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tech Stack */}
      <div>
        <p style={sectionTitle}>{t('Built with')}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
          {stack.map(item => <span key={item} style={badge}>{item}</span>)}
        </div>
      </div>

      {/* Under the hood */}
      <div>
        <p style={sectionTitle}>{t('Under the hood')}</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[
            { name: t('Sync'), desc: t('Sequence-numbered manifest; clients pull changes after their cursor, save with If-Match on the content hash.') },
            { name: t('Graph analysis'), desc: t('PageRank for hubs, union-find for clusters, betweenness for bridges, TF-IDF cosine for near-duplicates. Korean particle stripping in the tokenizer.') },
            { name: t('Layout'), desc: t('d3-force in 2D and 3D; instanced spheres with title labels in the 3D view.') },
            { name: t('Nightly batch'), desc: t('04:00 Asia/Seoul: lint report into _reports/, embedding batches checkpointed so a cut-off run resumes, log in _system/batch-log.json (Settings → Server).') },
          ].map(({ name, desc }) => (
            <div key={name} style={row}>
              <span style={{ color: 'var(--color-text-primary)', fontWeight: 600, fontSize: 11 }}>{name}</span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 10, lineHeight: 1.5 }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  )
}
