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

// ── Number input row ───────────────────────────────────────────────────────────

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
              수정됨
            </span>
          )}
        </div>
        <p className="text-[11px] mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          {desc} <span style={{ color: 'var(--color-text-muted)', opacity: 0.6 }}>(기본값: {def})</span>
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

// ── Section header ─────────────────────────────────────────────────────────────

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

// ── Component ──────────────────────────────────────────────────────────────────

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
          RAG 검색 알고리즘의 점수 가중치 및 임계값을 조정합니다.
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
          title="모든 값을 기본값으로 초기화"
        >
          <RotateCcw size={12} />
          초기화
        </button>
      </div>

      {/* 파일명 vs 본문 가중치 */}
      <Section title="파일명 / 본문 가중치">
        <NumRow label="파일명 가중치" desc="파일명에 쿼리 단어가 포함될 때 점수 (높을수록 제목 매칭 우선)"
          field="filenameWeight" min={1} max={50} step={1} value={sc.filenameWeight} onChange={set} />
        <NumRow label="본문 가중치" desc="본문에 쿼리 단어가 포함될 때 점수"
          field="bodyWeight" min={1} max={10} step={1} value={sc.bodyWeight} onChange={set} />
      </Section>

      {/* Recency 부스트 */}
      <Section title="최신성 부스트 (Recency Boost)">
        <NumRow label="반감기 (일)" desc="날짜가 이 일수만큼 지나면 boost가 절반이 됨"
          field="recencyHalfLifeDays" min={7} max={730} step={7} value={sc.recencyHalfLifeDays} onChange={set} />
        <NumRow label="일반 쿼리 계수" desc="최신 인텐트가 없는 일반 쿼리의 recency 가중치"
          field="recencyCoeffNormal" min={0} max={5} step={0.1} value={sc.recencyCoeffNormal} onChange={set} />
        <NumRow label="최신 인텐트 계수" desc="'최신', '현황', '진행 방향' 등 최신성 쿼리의 recency 가중치"
          field="recencyCoeffHot" min={0} max={10} step={0.1} value={sc.recencyCoeffHot} onChange={set} />
      </Section>

      {/* 검색 후보 수 */}
      <Section title="후보 문서 수">
        <NumRow label="일반 쿼리 직접 검색 후보" desc="Stage 1 직접 문자열 검색 풀 크기"
          field="directCandidatesNormal" min={5} max={200} step={5} value={sc.directCandidatesNormal} onChange={set} />
        <NumRow label="최신 쿼리 직접 검색 후보" desc="최신 인텐트 감지 시 검색 풀 크기"
          field="directCandidatesRecency" min={5} max={200} step={5} value={sc.directCandidatesRecency} onChange={set} />
        <NumRow label="BFS 시드 수" desc="직접 검색 상위 N개를 그래프 탐색 시작점으로 사용"
          field="directHitSeeds" min={1} max={20} step={1} value={sc.directHitSeeds} onChange={set} />
        <NumRow label="BM25 후보 수" desc="직접 검색 미흡 시 BM25 폴백 후보 수"
          field="bm25Candidates" min={1} max={30} step={1} value={sc.bm25Candidates} onChange={set} />
        <NumRow label="리랭킹 시드 수" desc="BM25 결과를 리랭킹 후 최종 시드로 사용할 개수"
          field="rerankSeeds" min={1} max={15} step={1} value={sc.rerankSeeds} onChange={set} />
      </Section>

      {/* 임계값 */}
      <Section title="점수 임계값">
        <NumRow label="직접 히트 임계값" desc="이 점수 이상이면 BM25 폴백 없이 직접 검색 결과를 시드로 사용"
          field="minDirectHitScore" min={0.01} max={1} step={0.01} value={sc.minDirectHitScore} onChange={set} />
        <NumRow label="전체 본문 주입 임계값" desc="이 점수 이상이면 문서 전체 본문을 LLM 컨텍스트에 직접 주입"
          field="minPinnedScore" min={0.01} max={1} step={0.01} value={sc.minPinnedScore} onChange={set} />
        <NumRow label="BM25 최소 점수" desc="이 점수 미만의 BM25 결과는 무시"
          field="minBm25Score" min={0} max={0.5} step={0.01} value={sc.minBm25Score} onChange={set} />
      </Section>

      {/* 리랭킹 가중치 */}
      <Section title="리랭킹 가중치 (BM25 폴백 경로)">
        <NumRow label="BM25 점수 가중치" desc="BM25 검색 점수의 비중"
          field="rerankVectorWeight" min={0} max={1} step={0.05} value={sc.rerankVectorWeight} onChange={set} />
        <NumRow label="키워드 점수 가중치" desc="키워드 겹침 점수의 비중"
          field="rerankKeywordWeight" min={0} max={1} step={0.05} value={sc.rerankKeywordWeight} onChange={set} />
      </Section>

      {/* 그래프 탐색 */}
      <Section title="그래프 탐색 (BFS / PPR)">
        <NumRow label="최대 홉 수" desc="시드 문서에서 위키링크를 몇 단계까지 따라갈지"
          field="bfsMaxHops" min={1} max={6} step={1} value={sc.bfsMaxHops} onChange={set} />
        <NumRow label="최대 수집 문서 수" desc="그래프 탐색으로 수집할 최대 문서 수"
          field="bfsMaxDocs" min={5} max={60} step={5} value={sc.bfsMaxDocs} onChange={set} />
      </Section>

      {/* 소형 볼트 전체 주입 */}
      <Section title="소형 볼트 전체 주입 (Claude Cowork 방식)">
        <NumRow
          label="전체 주입 한도 (글자 수)"
          desc="볼트 전체가 이 글자 수 이하이면 RAG 없이 모든 문서를 컨텍스트에 직접 주입. 0 = 비활성화"
          field="fullVaultThreshold"
          min={0} max={300000} step={10000}
          value={sc.fullVaultThreshold}
          onChange={set}
        />
      </Section>

      {/* AI 추론 설정 */}
      <Section title="AI 추론 & 인사이트">
        <ToggleRow
          label="구조화 추론"
          desc="분석·설계·의사결정 질문에 [관찰]→[연결고리]→[분석]→[결론/제안] 구조 강제. 단순 질문은 자동 생략"
          checked={rc.structuredReasoning ?? DEFAULT_REASONING_CONFIG.structuredReasoning}
          onChange={v => rtoggle('structuredReasoning', v)}
        />
        <ToggleRow
          label="Extended Thinking"
          desc="Claude가 응답 전 내부 추론 과정을 거침 — 복잡한 설계·분석 질문에서 답변 품질 대폭 향상 (Anthropic 전용, Haiku 미지원, 응답 느려짐)"
          checked={rc.extendedThinking ?? DEFAULT_REASONING_CONFIG.extendedThinking}
          onChange={v => rtoggle('extendedThinking', v)}
        />
        {(rc.extendedThinking ?? DEFAULT_REASONING_CONFIG.extendedThinking) && (
          <ReasoningNumRow
            label="추론 토큰 예산"
            desc="Extended Thinking에 할당할 최대 토큰 수 (높을수록 깊은 추론, 비용 증가)"
            value={rc.thinkingBudget ?? DEFAULT_REASONING_CONFIG.thinkingBudget}
            min={1000} max={32000} step={1000}
            onChange={v => setReasoningConfig({ thinkingBudget: v })}
          />
        )}
      </Section>

      {/* AI 검색 품질 향상 */}
      <Section title="검색 품질 향상 (AI 보조)">
        <ToggleRow
          label="메타데이터 필터"
          desc="쿼리에서 화자·태그를 자동 감지해 관련 문서만 사전 필터링 — 특정 인물/주제 검색 정밀도 향상"
          checked={sc.metadataFilter ?? DEFAULT_SEARCH_CONFIG.metadataFilter}
          onChange={v => toggle('metadataFilter', v)}
        />
        <ToggleRow
          label="쿼리 확장"
          desc="모호하거나 짧은 쿼리를 LLM(Haiku)으로 보강해 벡터 검색 재현율 향상 (Anthropic API 키 필요, ~5초 추가)"
          checked={sc.queryExpansion ?? DEFAULT_SEARCH_CONFIG.queryExpansion}
          onChange={v => toggle('queryExpansion', v)}
        />
        <ToggleRow
          label="LLM 리랭킹"
          desc="벡터 검색 후보를 LLM(Haiku)으로 재평가해 관련성 높은 문서 우선 배치 (Anthropic API 키 필요, ~8초 추가)"
          checked={sc.llmRerank ?? DEFAULT_SEARCH_CONFIG.llmRerank}
          onChange={v => toggle('llmRerank', v)}
        />
      </Section>

    </div>
  )
}
