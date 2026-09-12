export default function AboutTab() {
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
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '5px 0',
    borderBottom: '1px solid rgba(255,255,255,0.04)',
    fontSize: 11,
  }

  return (
    <div className="flex flex-col gap-6">

      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--color-text-primary)', letterSpacing: '-0.02em' }}>
            Sandbox Map
          </h2>
          <p style={{ fontSize: 11, color: 'var(--color-accent)', marginTop: 2 }}>
            v0.3.0 &nbsp;·&nbsp; AI Director Proxy System
          </p>
        </div>
        <div style={{ fontSize: 10, color: 'var(--color-text-muted)', textAlign: 'right', lineHeight: 1.6 }}>
          <div>개발자</div>
          <a
            href="mailto:miro85a@gmail.com"
            style={{ color: 'var(--color-accent)', textDecoration: 'none' }}
          >
            miro85a@gmail.com
          </a>
        </div>
      </div>

      {/* 개요 */}
      <div>
        <p style={{ fontSize: 12, lineHeight: 1.8, color: 'var(--color-text-secondary)' }}>
          Obsidian 볼트를 <strong style={{ color: 'var(--color-text-primary)' }}>위키링크 지식 그래프</strong>로 시각화하고,
          5명의 AI 디렉터 페르소나가 그래프를 BFS 탐색하며 프로젝트 전반의 인사이트와 피드백을 제공합니다.
          게임 개발 스튜디오의 지식 관리 및 의사결정 지원을 목적으로 설계되었습니다.
        </p>
      </div>

      {/* 기술 스택 */}
      <div>
        <p style={sectionTitle}>기술 스택</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 0 }}>
          {[
            'Electron 31', 'React 19', 'TypeScript 5.5', 'Vite 5',
            'Three.js', 'd3-force', 'CodeMirror 6', 'Zustand 5',
            'Tailwind CSS 4', 'Framer Motion', 'FastAPI', 'ChromaDB',
          ].map(t => (
            <span key={t} style={badge}>{t}</span>
          ))}
        </div>
      </div>

      {/* LLM 지원 */}
      <div>
        <p style={sectionTitle}>지원 LLM</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[
            { provider: 'Anthropic', models: 'Claude Opus / Sonnet / Haiku', vision: true },
            { provider: 'OpenAI', models: 'GPT-4o / GPT-4o mini', vision: true },
            { provider: 'Google', models: 'Gemini 1.5 Pro / Flash', vision: true },
            { provider: 'xAI', models: 'Grok Beta', vision: false },
          ].map(({ provider, models, vision }) => (
            <div key={provider} style={row}>
              <span style={{ color: 'var(--color-text-primary)', fontWeight: 500 }}>{provider}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {models}
                {vision && <span style={{ ...badge, marginLeft: 6, marginBottom: 0, color: 'var(--color-text-secondary)' }}>비전</span>}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* 핵심 알고리즘 */}
      <div>
        <p style={sectionTitle}>핵심 알고리즘</p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[
            {
              name: 'TF-IDF 벡터 검색',
              desc: '볼트 로드 시 문서를 벡터화, 코사인 유사도로 의미적 시드 선택',
            },
            {
              name: 'BFS 그래프 탐색',
              desc: 'WikiLink를 따라 최대 4홉, 35개 문서를 홉 거리별 예산으로 수집',
            },
            {
              name: 'PageRank',
              desc: '역방향 엣지 O(N+M) 알고리즘으로 허브 문서 식별 (25회 반복)',
            },
            {
              name: 'Union-Find 클러스터링',
              desc: '경로 압축 포함 연결 컴포넌트 감지, 클러스터별 문서 그룹화',
            },
            {
              name: 'Korean 형태소 처리',
              desc: '그리디 최장 일치 조사 제거 (이라는/에서의/으로 등 50+종)',
            },
            {
              name: 'd3-force 물리 시뮬레이션',
              desc: '반발력·인장력·중심력 균형으로 자연스러운 2D/3D 그래프 레이아웃',
            },
          ].map(({ name, desc }) => (
            <div key={name} style={{ ...row, flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
              <span style={{ color: 'var(--color-text-primary)', fontWeight: 600, fontSize: 11 }}>{name}</span>
              <span style={{ color: 'var(--color-text-muted)', fontSize: 10, lineHeight: 1.5 }}>{desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* RAG 파이프라인 */}
      <div>
        <p style={sectionTitle}>Graph-Augmented RAG 파이프라인</p>
        <div style={{
          background: 'var(--color-bg-active)',
          borderRadius: 2,
          padding: '10px 12px',
          fontSize: 10,
          color: 'var(--color-text-muted)',
          lineHeight: 1.9,
          fontFamily: 'monospace',
        }}>
          {[
            '① 인텐트 감지 → 전체/전반 키워드 → buildGlobalGraphContext()',
            '② TF-IDF 코사인 유사도 검색 → 상위 8개 후보',
            '③ 스코어 필터 (> 0.05) + 재순위화',
            '④ 시드 < 2개 → PageRank 허브 노드 자동 보완',
            '⑤ BFS 탐색 (3홉, 최대 20개 문서)',
            '⑥ 구조 헤더 주입 (PageRank 상위 + 클러스터 개요)',
            '⑦ LLM 스트리밍 분석',
          ].map(line => (
            <div key={line}>{line}</div>
          ))}
        </div>
      </div>

    </div>
  )
}
