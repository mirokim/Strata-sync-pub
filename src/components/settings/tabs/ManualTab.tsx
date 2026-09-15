import { ExternalLink, Plug } from 'lucide-react'
import { useT } from '@/i18n'

export default function ManualTab({ openMcp }: { openMcp: () => void }) {
  const t = useT()
  const manualUrl = `${import.meta.env.BASE_URL}manual.html`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%', minHeight: 420 }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', flexShrink: 0 }}>
        <button onClick={openMcp} style={{ display: 'inline-flex', gap: 8, alignItems: 'center', padding: '8px 12px', borderRadius: 4, background: 'var(--color-accent)', color: '#fff', border: 0, cursor: 'pointer' }}>
          <Plug size={16} />{t('Connect MCP')}
        </button>
        <a href={manualUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', color: 'var(--color-text-primary)', textDecoration: 'underline', textUnderlineOffset: 4 }}>
          <ExternalLink size={16} />{t('Open in new window')}
        </a>
      </div>
      <iframe src={manualUrl} title={t('Strata Sync user manual')} style={{ display: 'block', width: '100%', flex: 1, minHeight: 360, border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-bg-primary)' }} />
    </div>
  )
}
