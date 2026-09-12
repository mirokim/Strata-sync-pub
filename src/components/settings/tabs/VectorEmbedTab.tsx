import { useState, useEffect } from 'react'
import { Eye, EyeOff, RefreshCw, CheckCircle2, Loader2, AlertCircle, Trash2 } from 'lucide-react'
import { useSettingsStore } from '@/stores/settingsStore'
import { vectorEmbedIndex, isEmbeddingReady, resetLocalEmbedProbe } from '@/lib/vectorEmbedIndex'
import { useVaultStore } from '@/stores/vaultStore'
import { invalidateVectorEmbedCache } from '@/lib/vectorEmbedCache'

export default function VectorEmbedTab() {
  const { apiKeys, setApiKey } = useSettingsStore()
  const { loadedDocuments, vaultPath } = useVaultStore()
  const [showKey, setShowKey] = useState(false)
  const [status, setStatus] = useState({
    isBuilt: vectorEmbedIndex.isBuilt,
    isBuilding: vectorEmbedIndex.isBuilding,
    progress: vectorEmbedIndex.progress,
    size: vectorEmbedIndex.size,
    lastError: vectorEmbedIndex.lastError,
  })

  // Status polling — every 500ms while building, plus one refresh after completion
  useEffect(() => {
    const tick = () => setStatus({
      isBuilt: vectorEmbedIndex.isBuilt,
      isBuilding: vectorEmbedIndex.isBuilding,
      progress: vectorEmbedIndex.progress,
      size: vectorEmbedIndex.size,
      lastError: vectorEmbedIndex.lastError,
    })
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [])

  const geminiKey = apiKeys['gemini'] ?? ''
  // A running local embedding server allows building without a Gemini key
  const [localReady, setLocalReady] = useState(false)
  useEffect(() => {
    let alive = true
    isEmbeddingReady(geminiKey).then(ok => { if (alive) setLocalReady(ok) })
    return () => { alive = false }
  }, [geminiKey])
  const hasKey = Boolean(geminiKey) || localReady
  const docCount = loadedDocuments?.length ?? 0

  function handleBuild() {
    if (!hasKey || status.isBuilding || docCount === 0) return
    vectorEmbedIndex.buildFull(loadedDocuments ?? [], geminiKey, vaultPath ?? '')
      .catch(() => { /* errors are handled by the logger */ })
  }

  async function handleReset() {
    if (status.isBuilding) return
    resetLocalEmbedProbe()  // Re-check, the server may have been started later
    await invalidateVectorEmbedCache(vaultPath ?? '')
    vectorEmbedIndex.reset()
  }

  const hasError = Boolean(status.lastError) && !status.isBuilt && !status.isBuilding
  const statusIcon = status.isBuilding
    ? <Loader2 size={14} className="animate-spin" style={{ color: 'var(--color-accent)' }} />
    : status.isBuilt
      ? <CheckCircle2 size={14} style={{ color: '#4caf50' }} />
      : hasError
        ? <AlertCircle size={14} style={{ color: 'var(--color-error)' }} />
        : <AlertCircle size={14} style={{ color: 'var(--color-text-muted)' }} />

  const statusText = status.isBuilding
    ? `Building… ${status.progress}%`
    : status.isBuilt
      ? `Ready — ${status.size} documents indexed`
      : hasError
        ? `Build failed`
        : hasKey ? 'No index — builds automatically on vault load' : 'Gemini API key required'

  return (
    <div className="flex flex-col gap-5">

      <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
        Vectorizes documents with Google Gemini's <strong>gemini-embedding-001</strong> model.
        Reranks BM25 keyword search results by semantic similarity to improve accuracy on abstract queries.
        <span style={{ color: '#4caf50' }}> Free (within API quota)</span>
      </p>

      {/* ── Status ── */}
      <section>
        <h3 className="text-[13px] font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
          Index Status
        </h3>
        <div
          className="rounded-lg px-4 py-3 flex items-center justify-between gap-3"
          style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface)' }}
        >
          <div className="flex items-center gap-2">
            {statusIcon}
            <span className="text-[13px]" style={{ color: 'var(--color-text-primary)' }}>
              {statusText}
            </span>
          </div>
          {status.isBuilding && (
            <div
              className="flex-1 max-w-32 h-1.5 rounded-full overflow-hidden"
              style={{ background: 'var(--color-border)' }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${status.progress}%`, background: 'var(--color-accent)' }}
              />
            </div>
          )}
        </div>
        {hasError && (
          <p className="text-[11px] mt-1.5 px-1" style={{ color: 'var(--color-error)' }}>
            {status.lastError}
          </p>
        )}
        <p className="text-[11px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
          Built incrementally on vault load. Only changed documents are re-embedded; the rest are restored from cache.
        </p>
      </section>

      {/* ── Gemini API key ── */}
      <section>
        <h3 className="text-[13px] font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
          Gemini API Key
        </h3>
        <div className="relative">
          <input
            type={showKey ? 'text' : 'password'}
            value={geminiKey}
            onChange={e => setApiKey('gemini', e.target.value.trim())}
            placeholder="AIza..."
            className="w-full text-[13px] rounded px-3 py-2 pr-9 font-mono"
            style={{
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
              outline: 'none',
            }}
            autoComplete="off"
          />
          <button
            onClick={() => setShowKey(v => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5"
            style={{ color: 'var(--color-text-muted)' }}
            tabIndex={-1}
          >
            {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <p className="text-[11px] mt-1.5" style={{ color: 'var(--color-text-muted)' }}>
          Issued by Google AI Studio — same as the Gemini key in the AI Settings tab.
        </p>
      </section>

      {/* ── Manual rebuild ── */}
      <section>
        <h3 className="text-[13px] font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
          Manual Rebuild
        </h3>
        <div className="flex items-center gap-3">
          <button
            onClick={handleBuild}
            disabled={!hasKey || status.isBuilding || docCount === 0}
            className="flex items-center gap-2 px-3 py-2 rounded text-[13px] transition-opacity"
            style={{
              background: 'var(--color-accent)',
              color: '#fff',
              opacity: (!hasKey || status.isBuilding || docCount === 0) ? 0.4 : 1,
              cursor: (!hasKey || status.isBuilding || docCount === 0) ? 'not-allowed' : 'pointer',
            }}
          >
            {status.isBuilding
              ? <Loader2 size={13} className="animate-spin" />
              : <RefreshCw size={13} />}
            {status.isBuilding ? `Building (${status.progress}%)` : 'Build Now'}
          </button>
          <button
            onClick={handleReset}
            disabled={status.isBuilding}
            className="flex items-center gap-2 px-3 py-2 rounded text-[13px] transition-opacity"
            style={{
              border: '1px solid var(--color-border)',
              color: 'var(--color-text-muted)',
              opacity: status.isBuilding ? 0.4 : 1,
              cursor: status.isBuilding ? 'not-allowed' : 'pointer',
            }}
          >
            <Trash2 size={13} />
            Reset
          </button>
          <span className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
            {docCount > 0 ? `${docCount} documents` : 'Available after vault load'}
          </span>
        </div>
        {!hasKey && (
          <p className="text-[11px] mt-2" style={{ color: 'var(--color-warning)' }}>
            ⚠ Enter the Gemini API key first.
          </p>
        )}
      </section>

      {/* ── How it works ── */}
      <section>
        <h3 className="text-[13px] font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
          How It Works
        </h3>
        <div
          className="rounded-lg px-4 py-3 text-[12px] flex flex-col gap-1.5"
          style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}
        >
          <div>① <strong style={{ color: 'var(--color-text-primary)' }}>BM25</strong> — pulls the top 50 candidates by query keywords (existing method)</div>
          <div>② <strong style={{ color: 'var(--color-text-primary)' }}>Query Embedding</strong> — converts the query into a 768-dim vector (1 API call)</div>
          <div>③ <strong style={{ color: 'var(--color-text-primary)' }}>Reranking</strong> — final ranking from BM25 40% + semantic similarity 60%</div>
          <div className="mt-1" style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>
            Document embeddings are stored in a file cache — only changed documents are regenerated incrementally.
          </div>
        </div>
      </section>

    </div>
  )
}
