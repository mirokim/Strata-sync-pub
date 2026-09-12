import { RotateCcw } from 'lucide-react'
import { useSettingsStore, DEFAULT_SEARCH_CONFIG, DEFAULT_REASONING_CONFIG, type SearchConfig, type ReasoningConfig } from '@/stores/settingsStore'

// ── Toggle row ──────────────────────────────────────────────────────────────────

function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2"
      style={{ borderBottom: '1px solid var(--color-border)' }}>
      <div className="flex-1 min-w-0">
        <div className="text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{label}</div>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{desc}</p>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
      />
    </div>
  )
}

// Number input row

function NumRow({
  label, desc, field, min, max, step, value, onChange,
}: {
  label: string
  desc: string
  field: keyof SearchConfig
  min: number
  max: number
  step: number
  value: number
  onChange: (f: keyof SearchConfig, v: number) => void
}) {
  const def = DEFAULT_SEARCH_CONFIG[field] as number
  const isDirty = value !== def
  return (
    <div className="flex items-center justify-between gap-3 py-2"
      style={{ borderBottom: '1px solid var(--color-border)' }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{label}</span>
          {isDirty && (
            <span className="text-[10px] px-1 rounded" style={{ background: 'var(--color-accent)', color: '#fff' }}>
              Modified
            </span>
          )}
        </div>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          {desc} <span style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>(default: {def})</span>
        </p>
      </div>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => {
          const v = parseFloat(e.target.value)
          if (!isNaN(v) && v >= min && v <= max) onChange(field, v)
        }}
        className="w-20 text-right text-[13px] px-2 py-1 rounded"
        style={{
          background: 'var(--color-surface)',
          border: '1px solid var(--color-border)',
          color: 'var(--color-text-primary)',
          outline: 'none',
        }}
      />
    </div>
  )
}

// Section header

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="text-[13px] font-semibold mb-2" style={{ color: 'var(--color-text-secondary)' }}>
        {title}
      </h3>
      <div className="rounded-lg overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
        <div className="px-3">{children}</div>
      </div>
    </section>
  )
}

// Component

// ── NumRow for ReasoningConfig ─────────────────────────────────────────────────

function ReasoningNumRow({ label, desc, value, min, max, step, onChange }: {
  label: string; desc: string; value: number; min: number; max: number; step: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2"
      style={{ borderBottom: '1px solid var(--color-border)' }}>
      <div className="flex-1 min-w-0">
        <div className="text-[13px]" style={{ color: 'var(--color-text-primary)' }}>{label}</div>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{desc}</p>
      </div>
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= min && v <= max) onChange(v) }}
        className="w-24 text-right text-[13px] px-2 py-1 rounded"
        style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-primary)', outline: 'none' }}
      />
    </div>
  )
}

export default function SearchTab() {
  const { searchConfig, setSearchConfig, resetSearchConfig, reasoningConfig, setReasoningConfig } = useSettingsStore()
  const sc = searchConfig
  const rc = reasoningConfig
  const set = (f: keyof SearchConfig, v: number) => setSearchConfig({ [f]: v })
  const toggle = (f: keyof SearchConfig, v: boolean) => setSearchConfig({ [f]: v })
  const rtoggle = (f: keyof ReasoningConfig, v: boolean) => setReasoningConfig({ [f]: v })

  const isDefault = Object.keys(DEFAULT_SEARCH_CONFIG).every(
    k => sc[k as keyof SearchConfig] === DEFAULT_SEARCH_CONFIG[k as keyof SearchConfig]
  )

  return (
    <div className="flex flex-col gap-5">

      <div className="flex items-center justify-between">
        <p className="text-[12px]" style={{ color: 'var(--color-text-muted)' }}>
          Adjust the scoring weights and thresholds for the RAG search algorithm.
        </p>
        <button
          onClick={resetSearchConfig}
          disabled={isDefault}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] transition-opacity"
          style={{
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            color: isDefault ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
            opacity: isDefault ? 0.5 : 1,
            cursor: isDefault ? 'not-allowed' : 'pointer',
          }}
          title="Reset all values to defaults"
        >
          <RotateCcw size={12} />
          Reset
        </button>
      </div>

      {/* Filename vs body weights */}
      <Section title="Filename / Body Weights">
        <NumRow label="Filename Weight" desc="Score when query words match the filename (higher = prioritize title matching)"
          field="filenameWeight" min={1} max={50} step={1} value={sc.filenameWeight} onChange={set} />
        <NumRow label="Body Weight" desc="Score when query words match the body text"
          field="bodyWeight" min={1} max={10} step={1} value={sc.bodyWeight} onChange={set} />
      </Section>

      {/* Recency boost */}
      <Section title="Recency Boost">
        <NumRow label="Half-life (days)" desc="Boost halves after this many days"
          field="recencyHalfLifeDays" min={7} max={730} step={7} value={sc.recencyHalfLifeDays} onChange={set} />
        <NumRow label="Normal Query Coefficient" desc="Recency weight for queries without recency intent"
          field="recencyCoeffNormal" min={0} max={5} step={0.1} value={sc.recencyCoeffNormal} onChange={set} />
        <NumRow label="Recency Intent Coefficient" desc="Recency weight for queries like 'latest', 'current status', 'direction'"
          field="recencyCoeffHot" min={0} max={10} step={0.1} value={sc.recencyCoeffHot} onChange={set} />
      </Section>

      {/* Candidate counts */}
      <Section title="Candidate Document Count">
        <NumRow label="Normal Query Direct Candidates" desc="Stage 1 direct string search pool size"
          field="directCandidatesNormal" min={5} max={200} step={5} value={sc.directCandidatesNormal} onChange={set} />
        <NumRow label="Recency Query Direct Candidates" desc="Search pool size when recency intent is detected"
          field="directCandidatesRecency" min={5} max={200} step={5} value={sc.directCandidatesRecency} onChange={set} />
        <NumRow label="BFS Seed Count" desc="Use top N direct search results as graph traversal starting points"
          field="directHitSeeds" min={1} max={20} step={1} value={sc.directHitSeeds} onChange={set} />
        <NumRow label="BM25 Candidates" desc="BM25 fallback candidate count when direct search is insufficient"
          field="bm25Candidates" min={1} max={30} step={1} value={sc.bm25Candidates} onChange={set} />
        <NumRow label="Rerank Seed Count" desc="Number of BM25 results to use as final seeds after reranking"
          field="rerankSeeds" min={1} max={15} step={1} value={sc.rerankSeeds} onChange={set} />
      </Section>

      {/* Thresholds */}
      <Section title="Score Thresholds">
        <NumRow label="Direct Hit Threshold" desc="Above this score, direct search results are used as seeds without BM25 fallback"
          field="minDirectHitScore" min={0.01} max={1} step={0.01} value={sc.minDirectHitScore} onChange={set} />
        <NumRow label="Full Body Injection Threshold" desc="Above this score, the full document body is injected into LLM context"
          field="minPinnedScore" min={0.01} max={1} step={0.01} value={sc.minPinnedScore} onChange={set} />
        <NumRow label="BM25 Minimum Score" desc="BM25 results below this score are ignored"
          field="minBm25Score" min={0} max={0.5} step={0.01} value={sc.minBm25Score} onChange={set} />
      </Section>

      {/* Reranking weights */}
      <Section title="Reranking Weights (BM25 Fallback Path)">
        <NumRow label="BM25 Score Weight" desc="Weight of BM25 search score"
          field="rerankVectorWeight" min={0} max={1} step={0.05} value={sc.rerankVectorWeight} onChange={set} />
        <NumRow label="Keyword Score Weight" desc="Weight of keyword overlap score"
          field="rerankKeywordWeight" min={0} max={1} step={0.05} value={sc.rerankKeywordWeight} onChange={set} />
      </Section>

      {/* Graph traversal */}
      <Section title="Graph Traversal (BFS / PPR)">
        <NumRow label="Max Hops" desc="How many wikilink hops to follow from seed documents"
          field="bfsMaxHops" min={1} max={6} step={1} value={sc.bfsMaxHops} onChange={set} />
        <NumRow label="Max Collected Documents" desc="Maximum documents to collect via graph traversal"
          field="bfsMaxDocs" min={5} max={60} step={5} value={sc.bfsMaxDocs} onChange={set} />
      </Section>

      {/* Small vault full injection */}
      <Section title="Small Vault Full Injection">
        <NumRow
          label="Full Injection Limit (chars)"
          desc="If the entire vault is under this character count, all docs are injected directly without RAG. 0 = disabled"
          field="fullVaultThreshold"
          min={0} max={300000} step={10000}
          value={sc.fullVaultThreshold}
          onChange={set}
        />
      </Section>

      {/* AI reasoning settings */}
      <Section title="AI Reasoning & Insights">
        <ToggleRow
          label="Structured Reasoning"
          desc="Forces an [Observation]→[Connection]→[Analysis]→[Conclusion/Proposal] structure for analysis, design and decision questions. Skipped automatically for simple questions"
          checked={rc.structuredReasoning ?? DEFAULT_REASONING_CONFIG.structuredReasoning}
          onChange={v => rtoggle('structuredReasoning', v)}
        />
        <ToggleRow
          label="Extended Thinking"
          desc="Claude reasons internally before responding — greatly improves answer quality on complex design/analysis questions (Anthropic only, not supported on Haiku, slower responses)"
          checked={rc.extendedThinking ?? DEFAULT_REASONING_CONFIG.extendedThinking}
          onChange={v => rtoggle('extendedThinking', v)}
        />
        {(rc.extendedThinking ?? DEFAULT_REASONING_CONFIG.extendedThinking) && (
          <ReasoningNumRow
            label="Thinking Token Budget"
            desc="Maximum tokens allocated to Extended Thinking (higher = deeper reasoning, higher cost)"
            value={rc.thinkingBudget ?? DEFAULT_REASONING_CONFIG.thinkingBudget}
            min={1000} max={32000} step={1000}
            onChange={v => setReasoningConfig({ thinkingBudget: v })}
          />
        )}
      </Section>

      {/* AI search quality improvements */}
      <Section title="Search Quality (AI-assisted)">
        <ToggleRow
          label="Metadata Filter"
          desc="Auto-detects speakers/tags in the query and pre-filters to relevant documents — improves precision for person/topic searches"
          checked={sc.metadataFilter ?? DEFAULT_SEARCH_CONFIG.metadataFilter}
          onChange={v => toggle('metadataFilter', v)}
        />
        <ToggleRow
          label="Query Expansion"
          desc="Enriches vague or short queries with an LLM (Haiku) to improve vector search recall (requires Anthropic API key, adds ~5s)"
          checked={sc.queryExpansion ?? DEFAULT_SEARCH_CONFIG.queryExpansion}
          onChange={v => toggle('queryExpansion', v)}
        />
        <ToggleRow
          label="LLM Reranking"
          desc="Re-evaluates vector search candidates with an LLM (Haiku) so the most relevant documents rank first (requires Anthropic API key, adds ~8s)"
          checked={sc.llmRerank ?? DEFAULT_SEARCH_CONFIG.llmRerank}
          onChange={v => toggle('llmRerank', v)}
        />
      </Section>

    </div>
  )
}
