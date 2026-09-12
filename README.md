# Sandbox Map

**AI Director Proxy System** — Obsidian 볼트를 지식 그래프로 시각화하고, 여러 AI 페르소나가 그래프를 탐색하며 심층 인사이트를 제공하는 데스크톱 애플리케이션입니다.

---

## 목차

1. [개요](#개요)
2. [주요 기능](#주요-기능)
3. [사용 기술 스택](#사용-기술-스택)
4. [핵심 알고리즘 및 이론](#핵심-알고리즘-및-이론)
5. [Multi-Agent RAG 아키텍처](#multi-agent-rag-아키텍처)
6. [시스템 아키텍처](#시스템-아키텍처)
7. [MCP 서버](#mcp-서버)
8. [설치 및 실행](#설치-및-실행)
9. [Slack Bot](#slack-bot)
10. [사용 방법](#사용-방법)
11. [볼트 구조 가이드](#볼트-구조-가이드)
12. [볼트 정제 도구 (tools/)](#볼트-정제-도구-tools)
13. [LLM 설정](#llm-설정)
14. [프로젝트 구조](#프로젝트-구조)

---

## 개요

Sandbox Map은 Obsidian 스타일의 마크다운 볼트를 읽어 **위키링크 기반 지식 그래프**를 시각화하고, 5명의 AI 디렉터 페르소나가 그래프를 탐색하며 프로젝트에 대한 구체적인 피드백과 인사이트를 제공합니다.

```
볼트 폴더 (.md 파일들)
  ↓ 로드 + 파싱
지식 그래프 (WikiLink 연결 + strength)
  ↓ directVaultSearch + BM25 + PPR + PageRank
컨텍스트 수집
  ↓ Multi-Agent RAG (Chief + Worker LLMs)
구체적 인사이트 (스트리밍)
```

---

## 주요 기능

### 지식 그래프 시각화
- **2D 그래프 (SVG)**: d3-force 물리 시뮬레이션 기반 인터랙티브 그래프 — 일반 모드에서 사용
- **2D 그래프 (Canvas)**: Fast Mode 전용 Canvas 렌더러 — 대용량 볼트에서 고성능 렌더링
- **3D 그래프**: Three.js + d3-force-3d 기반 입체 그래프
- **Obsidian-style 노드 크기**: 링크 수(degree)에 비례해 노드 크기 자동 조절 — 허브 문서는 크게, 고립 문서는 작게 (√degree 스케일)
- **노드 색상 모드**: 문서 유형 / 담당자(speaker) / 폴더 / 태그 / 주제별 색상 구분
- **팬텀 노드**: 링크 대상이 아직 없는 위키링크도 그래프에 표시 (Obsidian 동작 동일)
- **이미지 노드**: `![[image.png]]`로 명시적 참조된 이미지가 그래프 노드로 시각화 (다이아몬드 형태, 보라색)
- **AI 노드 하이라이트**: AI 답변에서 언급된 문서를 그래프에서 자동 하이라이트 + 펄스 애니메이션
- **노드 라벨 토글**: 상단 바에서 전체 노드 라벨 표시/숨기기 전환
- **Fast Mode**: Canvas 렌더러 강제 전환 + 호버 스킵 + 동기 물리 틱으로 대용량 볼트에서도 부드러운 렌더링

### Graph-Augmented RAG (그래프 증강 검색)
- **directVaultSearch**: 날짜명 파일(`[2026.01.28] 피드백.md`) 및 정확한 제목 매칭을 위한 grep-style 직접 검색 — BM25 이전 우선 실행
- **BM25 벡터 검색**: 볼트 로드 시 Web Worker에서 자동 인덱싱, BM25 코사인 유사도로 관련 문서 검색
- **동의어·약어 확장**: 쿼리 토큰에 도메인 동의어 자동 적용 (배틀로얄↔BR, 음향→사운드, 전용서버→데디케이트 등) — 프론트엔드·MCP 양쪽 엔진 공통 적용
- **쿼리 텀 커버리지 패널티**: BM25 점수에 `coverage^0.5` 승수 적용 — 쿼리 단어 일부만 포함하는 문서 억제
- **최근 문서 우선 (Recency Boost)**: 6개월 지수 감쇠 기반 최대 +10% 보너스 — 오래된 문서 대비 최신 문서 우선 반영
- **IndexedDB 캐싱**: 볼트 재오픈 시 BM25 인덱스를 캐시에서 복원 (파일 변경 없으면 재계산 없음) — Edit Agent 파일 수정 시 즉시 캐시 무효화
- **패시지-레벨 검색**: 쿼리와 가장 관련된 섹션만 선택 (문서 앞부분 고정 방식 탈피)
- **링크 strength 계산**: 위키링크 참조 횟수를 [0.15, 1.0]으로 정규화 → 3D 그래프 엣지 밝기로 시각화
- **Personalized PageRank (PPR) 탐색**: BM25 시드에서 출발하는 strength 가중 랜덤 워커 — hop 제한 없이 허브 문서 자동 캡처
- **PageRank 기반 허브 시드**: 연결도가 높은 허브 노드를 탐색 시작점으로 자동 보완
- **전체 탐색 모드**: "전체 프로젝트 인사이트" 등 광범위한 쿼리에 자동 전환
- **묵시적 연결 발견**: WikiLink 없이도 BM25 코사인 유사도가 높은 숨겨진 연관 문서 쌍 감지
- **클러스터 주제 레이블**: 각 클러스터의 BM25 상위 키워드 자동 추출
- **브릿지 노드 탐지**: 여러 클러스터를 연결하는 아키텍처 핵심 문서 감지

### Jira / Confluence 연동
- **Jira 동기화** (`jira_sync`): JQL 조건으로 이슈 fetch → `jira/*.md` + `jira/attachments_md/` 에 자동 저장
- **Confluence 동기화** (`confluence_sync`): 스페이스 페이지 fetch → `active/*.md` 에 자동 저장, 일자 기반 증분 업데이트
- **Jira↔Active 교차 링크**: `crosslink_jira.py` — Epic/이슈와 active 문서 사이에 `[[WikiLink]]` 자동 주입
- **Jira 인덱스 재생성**: `gen_jira_index.py` — `jira/_index.md` 자동 업데이트 (날짜 역순, Epic/이슈 분류)
- **MCP 도구**: `confluence_sync` / `jira_sync` 도구로 Claude Code·Cursor 등 외부 에이전트에서도 동기화 실행 가능

### Multi-Agent RAG
- **Chief + Worker 구조**: 주요 문서는 Chief(메인) LLM이 20K 전체 읽기, 보조 문서는 Worker(저렴한) LLM이 병렬로 200자 요약 후 전달
- **자동 Worker 모델 선택**: 현재 페르소나 모델의 제공자에 맞는 저렴한 모델 자동 선택 (Claude Haiku / GPT-4.1-mini / Gemini Flash Lite / Grok-mini)
- **병렬 요약**: 보조 문서 최대 5개를 `Promise.all`로 동시 처리 → RPM 한도 대응 + 지연 최소화
- **폴백 안전**: Worker 실패 시 문서 앞 300자로 자동 대체
- **토글 가능**: 설정 패널 AI 탭에서 Multi-Agent RAG 켜기/끄기

### Edit Agent _(자율 에이전트)_
- **볼트 자율 편집**: 사용자 지시에 따라 AI가 볼트 내 마크다운 파일을 직접 읽고 수정하는 사이클 실행
- **BM25 캐시 즉시 무효화**: 파일 저장 직후 `invalidateTfIdfCache()` 호출 → 볼트 재오픈 없이도 다음 검색 시 최신 인덱스 반영 (v3.25)
- **품질 자동 점검**: 편집 사이클 완료 후 `check_quality.py` 자동 실행 → WARN 항목·이슈 건수를 EditAgentLog에 표시 (v3.25)
- **동기화 스크립트 파이프라인**: `inject_keywords.py → strengthen_links.py → enhance_wikilinks.py` 순서로 후처리 자동 실행 (POST_SYNC_SCRIPTS)
- **토큰 트래킹**: 편집 사이클별 LLM 입력/출력 토큰 사용량 집계 및 로그 출력

### 컨텍스트 컴팩션
- **자동 대화 압축**: 채팅 히스토리 총 글자 수가 20,000자를 초과하면 오래된 메시지를 Worker LLM으로 자동 요약 → 시스템 프롬프트에 "이전 대화 요약" 섹션으로 주입
- **최근 8개 메시지 보존**: 최신 대화 맥락은 그대로 유지, 오래된 내용만 압축
- **AI 메모리 자동 저장**: 컴팩션 시 요약 내용을 영구 메모리(`memoryStore`)에 자동 추가 → 다음 세션에도 인사이트 누적

### AI 메모리
- **대화 요약 저장 버튼** (📝): 채팅 패널에서 클릭 시 현재 대화를 AI가 요약하여 영구 메모리에 추가
- **수동 + 자동**: 버튼으로 수동 저장 또는 컨텍스트 컴팩션 발동 시 자동 저장
- **누적 메모리**: 이전 세션의 결정사항/인사이트가 현재 AI 프롬프트에 자동 주입

### 대화 보고서 PDF 내보내기
- **보고서 생성 인텐트 감지**: "보고서 써줘 / PDF 만들어줘 / 대화 정리해줘" 등의 메시지를 자동 감지
- **LLM 마크다운 생성 → PDF**: 선택 페르소나가 마크다운 보고서를 스트리밍으로 작성 → 완료 즉시 Electron `printToPDF()`로 저장 다이얼로그 출력
- **커버 + 섹션 레이아웃**: 타이틀 커버, h1/h2/h3 헤딩, 테이블, 코드블록, 리스트, 인용 지원

### AI 분석 패널
- **노드 선택 분석**: 특정 문서 선택 후 해당 노드와 연결된 모든 문서를 AI가 분석
- **전체 분석**: 노드 선택 없이도 전체 프로젝트를 허브 기반으로 분석
- **멀티패스 UI**: "탐색 중 → 분석 중" 단계별 진행 표시
- **QuickQuestions**: 페르소나별 풀에서 랜덤 추천 질문 제공
- **이미지 자동 첨부**: 선택한 문서에 `![[...]]` 이미지가 있으면 채팅 전송 시 자동 첨부 → AI vision 분석 가능

### 다중 LLM 페르소나
- 5명의 디렉터 페르소나 (총괄 / 아트 / 디자인 / 레벨 / 테크)
- 지원 제공자: **Anthropic Claude**, **OpenAI GPT**, **Google Gemini**, **xAI Grok**
- 이미지 첨부 지원 (Anthropic, OpenAI, Gemini)
- 페르소나별 커스텀 시스템 프롬프트 설정 가능

### 마크다운 에디터 (CodeMirror 6)
- Obsidian 스타일 `[[WikiLink]]` WYSIWYG 렌더링 + 자동완성
- `~~취소선~~`, `==하이라이트==`, `%% 주석 %%` 시각적 처리
- 키보드 단축키: `Ctrl+Shift+S` (취소선), `Ctrl+Shift+H` (하이라이트), `Ctrl+Shift+C` (인라인 코드)
- Enter 키 스마트 계속: 번호 목록 자동 증가 / 인용문 계속
- 1.2초 자동 저장

### 토론 모드
- 5명의 디렉터 페르소나 중 선택하여 특정 주제를 두고 토론 (라운드로빈 / 자유 토론 / 역할 배정 / 결전모드)
- **페르소나 기반 참여자**: 동일한 API 키로 여러 페르소나가 동시 참여 가능
- API 키가 설정된 페르소나만 참여 후보로 표시
- 참고 자료 첨부 (텍스트 / 이미지 / PDF), 실시간 스트리밍 표시

### 파일 트리
- 폴더 / 담당자 / 태그별 분류 표시
- 이름 / 수정일 기준 정렬
- 우클릭 컨텍스트 메뉴: 편집기 열기 / 복사 / 북마크 / 이름 변경 / 삭제

---

## 사용 기술 스택

### 프론트엔드
| 기술 | 버전 | 용도 |
|------|------|------|
| React | 19.x | UI 컴포넌트 |
| TypeScript | 5.5 | 타입 안전성 |
| Vite | 5.4 | 빌드 도구 + HMR |
| Tailwind CSS | 4.x | 유틸리티 CSS |
| Zustand | 5.x | 전역 상태 관리 (persist 플러그인) |
| Framer Motion | 12.x | 애니메이션 |
| Lucide React | 0.400 | 아이콘 |

### 그래프 시각화
| 기술 | 버전 | 용도 |
|------|------|------|
| d3-force | 3.x | 2D 물리 시뮬레이션 |
| d3-force-3d | 3.x | 3D 물리 시뮬레이션 |
| Three.js | 0.175 | 3D 렌더링 (WebGL) |

### 에디터
| 기술 | 버전 | 용도 |
|------|------|------|
| CodeMirror | 6.x | 마크다운 에디터 코어 |
| @codemirror/lang-markdown | 6.5 | 마크다운 문법 + 파서 |
| @lezer/highlight | 1.2 | 구문 강조 |

### 마크다운 파싱
| 기술 | 버전 | 용도 |
|------|------|------|
| gray-matter | 4.x | YAML 프론트매터 파싱 |
| unified / remark-parse | 11.x | 마크다운 AST 파싱 |
| react-markdown | 10.x | 마크다운 렌더링 |

### 데스크톱 (Electron)
| 기술 | 버전 | 용도 |
|------|------|------|
| Electron | 31.x | 데스크톱 앱 래퍼 |
| electron-builder | 24.x | 설치 파일 빌드 |

### 백엔드 (선택적)
| 기술 | 용도 |
|------|------|
| Python FastAPI | REST API 서버 |
| ChromaDB | 벡터 데이터베이스 (시맨틱 검색) |

### 테스트
| 기술 | 용도 |
|------|------|
| Vitest | 단위/통합 테스트 |
| @testing-library/react | 컴포넌트 테스트 |
| jsdom | DOM 시뮬레이션 |

---

## 핵심 알고리즘 및 이론

### 1. directVaultSearch — Grep-style 직접 검색 (`src/lib/graphRAG.ts`)

날짜명 파일(`[2026.01.28] 피드백 회의.md`)처럼 BM25가 잘 찾지 못하는 제목 기반 검색을 처리합니다.

**검색 전략**:
1. **강한 매칭** (score ≥ 0.4): 파일명 포함 / 제목 일치 / 숫자 추출 매칭
2. **약한 매칭** (score < 0.4): 본문 substring 매칭

**특징**:
- 한국어 조사 제거: "2월26일의" → "2월26일"
- 숫자 추출: "2026년 1월 28일" 쿼리 → `["2026", "0128", "26"]` 등 복수 패턴 생성
- 강한 매칭 시 해당 문서를 BM25 결과보다 우선하여 "직접 지목 문서"로 처리

```typescript
// 강한 매칭 → 직접 지목 문서 (전체 20K 내용 Chief LLM이 읽음)
if (strongPinnedHits.length > 0) {
  // Top-1: 전체 내용 (20K)
  // Doc 2-5: Worker LLM 병렬 요약 (200자)
}
```

---

### 2. BM25 벡터 검색 (`src/lib/graphAnalysis.ts`, `src/workers/bm25Worker.ts`)

**이론**: BM25 (Best Match 25) — TF-IDF의 개선형

키워드 매칭이 아닌 **통계적 의미 유사도**로 문서를 검색합니다. TF-IDF 대비 문서 길이 정규화와 포화 함수를 적용해 검색 품질이 향상됩니다.

```
BM25(d, q) = Σ IDF(t) × [ TF(t,d) × (k1+1) ] / [ TF(t,d) + k1×(1-b+b×|d|/avgdl) ]

k1 = 1.5  (TF 포화 계수)
b  = 0.75 (문서 길이 정규화 계수)
avgdl = 볼트 평균 문서 길이

코사인 유사도 = (BM25 벡터 · 문서 벡터) / (|BM25 벡터| × |문서 벡터|)
```

**구현 특징**:
- **Web Worker 인덱싱**: 무거운 BM25 빌드 + O(N²) 묵시적 링크 계산을 `bm25Worker.ts`에서 실행 — 메인 스레드 블로킹 없음
- 한국어 조사 제거(형태소 처리): "스칼렛이라는" → "스칼렛"
- OOV(Out-of-Vocabulary) 단어: `IDF = log(2)` 폴백
- **IndexedDB 캐싱** (`src/lib/docsCache.ts`): 파일 mtime 기반 지문(fingerprint)으로 캐시 유효성 검사 → 재오픈 시 ms 단위 복원, 경로 정규화(`\` → `/`)로 캐시 미스 방지
- **Edit Agent 즉시 무효화** (`src/lib/tfidfCache.ts`): 파일 수정 시 `invalidateTfIdfCache()` 호출 → 볼트 재오픈 없이 다음 검색 시 최신 인덱스 반영

```typescript
// 볼트 로드 완료 후 — 캐시 히트 시 findLinks만, 미스 시 전체 빌드
const fingerprint = buildDocsFingerprint(meta)  // "path:mtime|..." 지문
const cached = await loadDocsCache(vaultPath, fingerprint)
if (cached) {
  await findLinksFromCache(serialized, adjacency)  // Worker: 링크 계산만
} else {
  await buildAndFindLinks(docs, adjacency, fingerprint)  // Worker: 전체 빌드
}
```

---

### 3. Personalized PageRank (PPR) 그래프 탐색 (`src/lib/graphRAG.ts`)

**이론**: Personalized PageRank — strength 가중 랜덤 워커

BM25 시드 문서에서 출발해 WikiLink strength를 엣지 가중치로 사용하는 랜덤 워커를 실행합니다. BFS와 달리 hop 수 제한 없이 **강하게 연결된 허브 문서**를 자동으로 높은 점수로 캡처합니다.

```
Power Iteration (15회):
r(t+1)[v] = α·s[v] + (1-α)·Σ_{u→v} r(t)[u] · strength(u,v) / Σ_k strength(u,k)

α = 0.15 (텔레포트 확률 — 시드로 복귀)
s[v] = 시드 벡터 (BM25 결과 문서에 균등 분배)
```

**순위별 내용 예산**:

```
상위 1-3위 [핵심]: 1500자
상위 4-8위 [연관]:  900자
9위 이상  [주변]:  500자
```

**strength 가중의 효과**: hop 3이라도 strength 1.0 체인이면 hop 1 weak-link보다 높게 랭크됩니다. 자주 참조되는 연결망의 핵심 허브가 자동으로 부상합니다.

**허브 노드 보완**: BM25 시드가 2개 미만이면 연결도 상위 5개 허브 노드를 자동으로 시드에 추가합니다.

---

### 4. PageRank (`src/lib/graphAnalysis.ts`)

**이론**: Google PageRank 알고리즘

많은 문서로부터 위키링크로 참조될수록 높은 중요도를 받습니다.

```
PR(d) = (1 - d) / N + d × Σ [PR(i) / OutDegree(i)] for all i linking to d

d = damping factor (0.85)
N = 전체 문서 수
```

**구현 최적화**: 역방향 엣지 사전 계산으로 O(N+M) 시간 복잡도 달성 (25회 반복).

---

### 5. Union-Find 클러스터 감지 (`src/lib/graphAnalysis.ts`)

**이론**: Disjoint Set Union (Union-Find)

위키링크로 연결된 문서 그룹을 자동으로 클러스터로 분류합니다.

```
A - B - C      D - E      F
  클러스터 1    클러스터 2  클러스터 3
```

**경로 압축(Path Compression)** 포함으로 거의 O(1) amortized 복잡도.

---

### 6. d3-force 물리 시뮬레이션

**이론**: Force-Directed Graph Layout

노드 간 반발력(charge)과 링크 인장력(link force)의 균형으로 자연스러운 그래프 레이아웃을 생성합니다.

**파라미터 (실시간 조정 가능)**:
| 파라미터 | 기본값 | 범위 | 설명 |
|---------|-------|------|------|
| centerForce | 0.8 | 0~1 | 중심으로 당기는 힘 |
| charge | -80 | -1000~0 | 노드 간 반발력 |
| linkStrength | 0.7 | 0~2 | 링크 인장력 |
| linkDistance | 60 | 20~300 | 목표 링크 길이 |

---

### 7. Korean 형태소 처리 (간이 토크나이저)

완전한 형태소 분석기 없이 **그리디 조사 제거**로 한국어 검색 품질을 향상시킵니다.

```
"스칼렛이라는" → suffix "이라는" 제거 → "스칼렛"
"전투에서의"   → suffix "에서의" 제거 → "전투"
"게임에"       → suffix "에" 제거     → "게임"
```

---

### 8. 묵시적 연결 발견 (`src/lib/graphAnalysis.ts`)

WikiLink로 직접 연결되지 않은 문서 쌍 중 **BM25 코사인 유사도가 임계값(0.25) 이상**인 쌍을 "숨겨진 연관"으로 감지합니다.

```
문서 A (전투 시스템) + 문서 B (캐릭터 성장)
  → 직접 WikiLink 없음
  → BM25 유사도 = 0.72  ≥  threshold 0.25
  → "숨겨진 연관" 감지
  → AI 구조 헤더에 포함
```

---

### 9. 패시지-레벨 검색 (`src/lib/graphRAG.ts`)

**이론**: Passage-level Relevance Scoring

쿼리 토큰과 가장 많이 매칭되는 **섹션을 선별**합니다.

```
"전투 밸런스" 쿼리
  섹션 1 "## 개요": 0개 매칭
  섹션 2 "## 전투 로직": 2개 매칭  ← 선택
  섹션 3 "## 버그 기록": 0개 매칭
```

---

### 10. 동의어·약어 확장 (`src/lib/synonyms.ts`, `mcp/src/synonyms.ts`)

한국어 게임 도메인 특유의 **약어·외래어 변환 불일치**를 쿼리 단계에서 해소합니다.

```
사용자 입력 → tokenize() → expandTerms() → BM25 검색
```

```typescript
// 사전 기반 단방향 확장
SYNONYM_MAP = {
  '배틀로얄': ['br', 'br모드'],   // 한국어 → 약어
  '배경음악':  ['bgm', '사운드'], // 한국어 → 외래어
  '전용서버':  ['데디케이트'],    // 한국어 → 게임 용어
  '조합':      ['레시피', '크래프팅'],
  '눈뜨기':    ['각성'],          // 문맥 동의어
  ...
}
```

**적용 범위**: `graphAnalysis.ts` TfIdfIndex, `graphRAG.ts` directVaultSearch, `mcp/src/state.ts` bm25Search — 프론트엔드·MCP 양쪽 엔진 동일 동작.

**설계 원칙**: 단방향 우선(사용자 표현 → 문서 표현), 역방향은 명확히 필요한 경우만 추가. 지나치게 범용적인 단어(예: `'적'→'몬스터'` 등 짧은 어휘)는 오탐 주의.

---

### 11. getStrippedBody — 프론트매터 제거 (`src/lib/graphRAG.ts`)

AI 컨텍스트에 문서를 주입할 때 YAML 프론트매터를 제거하고 본문만 전달합니다.

```typescript
// YAML 프론트매터 + (intro) 섹션 제거 후 본문만 반환
export function getStrippedBody(doc: LoadedDocument): string
```

- `rawContent`가 있으면 YAML `---` 블록 제거
- `(intro)` 섹션 헤더 생략
- 모든 처리 실패 시 `rawContent` 원문 폴백

---

## Multi-Agent RAG 아키텍처

```
사용자 쿼리
    │
    ├─ directVaultSearch() ← 날짜명/제목 직접 검색 (grep-style)
    │       │
    │       └─ 강한 매칭(score≥0.4)?
    │               ├─ YES → "직접 지목 문서" 경로
    │               │
    │               │   Top-1 문서
    │               │     └─ Chief LLM → 전체 내용 20K 읽기
    │               │
    │               │   Doc 2~5 (병렬, 최대 5개)
    │               │     └─ Worker LLM × N → 각 200자 요약
    │               │           (실패 시 앞 300자 폴백)
    │               │
    │               └─ NO → BM25 경로
    │
    └─ BM25 코사인 유사도 검색 → 상위 8개 후보
            │
            ├─ 재순위화 (keyword overlap + speaker affinity)
            ├─ 시드 < 2개? → 허브 노드 자동 보완
            └─ PPR 그래프 탐색 (strength 가중, 최대 14개 문서)
                    │
                    └─ buildDeepGraphContext()
                            └─ LLM에 컨텍스트 주입

                                    ↓
                    컨텍스트 컴팩션 (자동)
                    ├─ 히스토리 > 20K chars?
                    │   └─ Worker LLM → 오래된 메시지 요약
                    │         → systemPrompt에 "이전 대화 요약" 주입
                    │         → memoryStore에 자동 저장
                    └─ 최근 8개 메시지 보존
```

### Worker 모델 자동 선택

| Chief 모델 제공자 | Worker 모델 |
|-----------------|------------|
| Anthropic | `claude-haiku-4-5-20251001` |
| OpenAI | `gpt-4.1-mini` |
| Google | `gemini-2.5-flash-lite` |
| xAI | `grok-3-mini` |

**효과**: Chief LLM은 가장 중요한 문서 1개에 집중, Worker LLM이 보조 문서를 저비용으로 병렬 처리 → 응답 품질 ↑, API 비용 최적화

---

## 시스템 아키텍처

```
┌─────────────────────────────────────────────────────┐
│                   Electron Shell                    │
│  ┌─────────────────┐      ┌────────────────────┐   │
│  │   Main Process  │      │  Renderer Process  │   │
│  │  (electron/     │ IPC  │  (React + Vite)    │   │
│  │   main.cjs)     │ ←──→ │                    │   │
│  │                 │      │  ┌──────────────┐  │   │
│  │  • File System  │      │  │  Graph UI    │  │   │
│  │  • Path Watch   │      │  │  (2D + 3D)   │  │   │
│  │  • Python Mgr   │      │  ├──────────────┤  │   │
│  └─────────────────┘      │  │  Chat Panel  │  │   │
│                            │  │  (5 Personas)│  │   │
│  ┌─────────────────┐      │  ├──────────────┤  │   │
│  │ Python Backend  │      │  │  MD Editor   │  │   │
│  │ (FastAPI +      │ HTTP │  │  (CodeMirror)│  │   │
│  │  ChromaDB)      │ ←──→ │  └──────────────┘  │   │
│  └─────────────────┘      └────────────────────┘   │
└─────────────────────────────────────────────────────┘
         ↕                           ↕
   .md Vault Files         LLM APIs (Claude/GPT/
   (로컬 파일 시스템)        Gemini/Grok)
```

### 데이터 흐름

```
.md 파일 로드
  → markdownParser.ts (YAML 프론트매터 + WikiLink 파싱, 비동기 청크 처리)
  → LoadedDocument[]
  → buildGraph() → GraphNode[] + GraphLink[]
  → graphStore / vaultStore 저장
  → 2D/3D 그래프 렌더링

  [백그라운드 — Web Worker]
  → buildDocsFingerprint(meta) → 지문 생성
  → loadDocsCache(vaultPath, fingerprint)
      ├─ 캐시 히트: findLinksFromCache(serialized, adj)  ← 링크 계산만
      └─ 캐시 미스: buildAndFindLinks(docs, adj, fingerprint) → saveDocsCache(...)
  → findImplicitLinks 결과 → graphStore 반영  ← 묵시적 연결 사전 계산

  [Edit Agent 파일 수정 시]
  → invalidateTfIdfCache(vaultPath)  ← 즉시 IndexedDB 캐시 무효화
  → 다음 검색 요청 시 자동 재빌드 (볼트 재오픈 불필요)

  [이미지 on-demand 로드]
  → 볼트 로드 시 일괄 프리로딩 없음 (메모리 절약)
  → 채팅 전송 시 ChatInput에서 필요한 이미지만 IPC readImage() 호출
  → imageDataCache에 단기 캐싱 후 AI vision 전달
```

---

## MCP 서버

`mcp/` 디렉토리에는 **Model Context Protocol (MCP) 서버**가 포함되어 있습니다. Claude Code, Cursor, Continue 등 MCP를 지원하는 AI 에이전트가 Sandbox Map 볼트를 직접 탐색하고 편집할 수 있습니다.

### 제공 도구 (30개)

| 카테고리 | 도구 | 설명 |
|---------|------|------|
| **볼트 관리** | `vault_reload` | 볼트 재로드 + BM25 인덱스 재빌드 |
| | `vault_list` | 파일/폴더 목록 |
| | `vault_read` | 파일 내용 읽기 |
| | `vault_write` | 파일 생성/수정 |
| | `vault_delete` | 파일 삭제 |
| | `vault_rename` | 파일 이름 변경 |
| | `vault_move` | 파일 이동 |
| | `vault_mkdir` | 폴더 생성 |
| **검색** | `search_bm25` | BM25 전문 검색 (동의어 확장 포함) |
| | `search_tags` | 태그 기반 문서 검색 |
| | `search_speaker` | 담당자(speaker) 기반 검색 |
| **그래프 분석** | `graph_stats` | 그래프 통계 (노드/링크/클러스터 수) |
| | `graph_pagerank` | PageRank 상위 문서 목록 |
| | `graph_clusters` | 클러스터(연결 컴포넌트) 감지 |
| | `graph_bridges` | 브릿지 노드 탐지 |
| | `graph_implicit_links` | BM25 유사도 기반 묵시적 연결 탐색 |
| | `graph_neighbors` | 특정 문서의 직접 이웃 목록 |
| **AI 채팅** | `chat` | 원시 LLM 채팅 (모델 직접 지정) |
| | `chat_persona` | 페르소나 채팅 (RAG 자동 적용) |
| | `edit_agent_refine` | Edit Agent로 문서 자율 편집 |
| | `debate_start` | 다중 페르소나 토론 시작 |
| **외부 연동** | `confluence_sync` | Confluence 페이지 → 볼트 동기화 |
| | `jira_sync` | Jira 이슈 → 볼트 동기화 |
| | `slack_send` | Slack 채널 메시지 전송 |
| **도구 실행** | `python_run` | `tools/` 스크립트 실행 |
| **사용량** | `usage_summary` | LLM 토큰 사용량 + 비용 집계 |
| | `usage_log` | 상세 사용 로그 |
| **설정** | `settings_get` | MCP 서버 설정 조회 |
| | `settings_update` | MCP 서버 설정 변경 (런타임) |

### 설정

```json
// mcp-config.json
{
  "vaultPath": "C:/dev2/refined_vault",
  "anthropicApiKey": "sk-ant-...",
  "confluenceBaseUrl": "https://your-confluence.atlassian.net/wiki",
  "jiraBaseUrl": "https://your-jira.atlassian.net"
}
```

```json
// .mcp.json (Claude Code 등록)
{
  "mcpServers": {
    "sandbox-map": {
      "command": "node",
      "args": ["mcp/dist/index.js"]
    }
  }
}
```

### 빠른 시작 (Claude Code)

```
1. vault_reload                     — 볼트 로드 (검색/그래프 도구 사용 전 필수)
2. search_bm25 {"query": "전투 시스템"}  — 문서 검색
3. chat_persona {"persona": "chief_director", "message": "프로젝트 현황 분석해줘"}
4. graph_stats → graph_pagerank     — 볼트 구조 파악
```

### MCP vs 프론트엔드 검색 차이

| 항목 | MCP `search_bm25` | 프론트엔드 검색 |
|------|-----------------|----------------|
| 알고리즘 | BM25 + 동의어 확장 | BM25 + directVaultSearch + 동의어 확장 + Coverage Penalty + Recency Boost |
| 날짜 파일 검색 | 약함 | 강함 (directVaultSearch 우선) |
| 최신 문서 우선 | 없음 | +10% 최대 보너스 |

---

## 설치 및 실행

### 사전 요구사항
- Node.js 18+
- Python 3.10+ (백엔드 선택 사용 시)

### 개발 환경 실행

```bash
# 의존성 설치
npm install

# Electron + Vite 동시 실행
npm run electron:dev
```

### 프로덕션 빌드

```bash
npm run electron:build
```

### MCP 서버 빌드

```bash
cd mcp
npm install
npm run build   # mcp/dist/ 생성
```

### 테스트

```bash
npm run test
```

### Python 백엔드 실행 (선택)

ChromaDB 벡터 검색을 사용하려면 백엔드를 실행합니다. 없어도 BM25 + directVaultSearch로 동작합니다.

```bash
pip install -r requirements.txt
python -m uvicorn backend.main:app --port 8765
```

---

## Slack Bot

Sandbox Map을 Slack 워크스페이스에 연결하면 채널/DM에서 직접 AI 디렉터에게 질문할 수 있습니다.

### 아키텍처

```
Slack 메시지
    │
    ├─ Socket Mode (WebSocket)
    │
    └─ bot/bot.py (Python Slack Bolt)
            │
            ├─ Electron이 켜져 있는 경우
            │     └─ HTTP localhost:7331/ask
            │           └─ Electron RAG 파이프라인
            │                 (Multi-Agent RAG + LLM 스트리밍)
            │
            └─ Electron이 꺼진 경우 (폴백)
                  └─ Python 서브 에이전트 (multi_agent_rag.py)
                        (n_agents=5 병렬 분석)
```

### 주요 기능

- **페르소나 태그**: `[chief]` `[art]` `[spec]` `[tech]` 태그로 AI 디렉터 선택 (기본값: chief)
- **채널 멘션**: `@Rembrandt [art] 아트 방향 알려줘`
- **DM**: 태그 없이 바로 질문
- **이미지 자동 첨부**: 답변에 관련 문서의 `![[이미지.png]]`가 있으면 자동 업로드 후 전송
- **이미지 명시 검색**: "이미지 보여줘" / "사진 보여줘" 키워드 감지 → 볼트에서 파일명 검색 후 첨부
- **Vision 분석**: 사용자가 이미지를 첨부하면 Claude Vision으로 분석

### 실행

```bash
cd bot
pip install -r requirements.txt
python bot.py
```

앱 내 설정 → **Slack 봇** 탭에서 Bot Token / App Token 입력 후 **시작** 클릭.

### 시크릿 관리 (.env)

API 키와 Slack 토큰은 `bot/.env`에서 관리합니다 (`.gitignore` 등록됨):

```bash
# bot/.env (절대 커밋하지 마세요)
ANTHROPIC_API_KEY=sk-ant-...
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-1-...
```

템플릿: `bot/.env.example` 참고. 자세한 설정은 [bot/SLACK_SETUP.md](bot/SLACK_SETUP.md) 참조.

---

## 사용 방법

### 1. 볼트 로드

1. 앱 실행 → 시작 화면에서 "볼트 열기" 클릭
2. Obsidian 볼트 폴더 선택 (`.md` 파일이 있는 폴더)
3. 그래프가 자동으로 생성됩니다

### 2. 그래프 탐색

- **마우스 드래그**: 그래프 회전/이동
- **스크롤**: 줌 인/아웃
- **노드 클릭**: 문서 선택 (우측 문서 뷰어에 내용 표시)
- **노드 더블클릭**: 에디터에서 열기
- **팔레트 버튼** (좌하단): 노드 색상 모드 변경

### 3. AI 분석

**특정 노드 분석**:
1. 그래프에서 노드 클릭으로 선택
2. "AI 분석" 버튼 클릭 (좌하단)
3. 해당 문서와 연결된 모든 관련 문서를 AI가 자동 탐색 후 분석

**전체 프로젝트 분석**:
1. 노드 선택 없이 "AI 전체 분석" 버튼 클릭
2. 허브 노드 기반으로 전체 볼트를 탐색하여 프로젝트 개요 분석

### 4. AI 채팅

- 우측 패널에서 AI 디렉터 페르소나 선택
- 자연어로 질문: 쿼리에 따라 자동으로 관련 문서를 찾아 답변
  - `"2월 26일 피드백 내용을 알려주세요"` → directVaultSearch로 날짜 파일 직접 검색
  - `"RPG 전투 밸런싱 개선점을 알려주세요"` → BM25로 관련 문서 검색 + PPR 탐색
  - `"전체 프로젝트 인사이트를 알려주세요"` → 전체 그래프 탐색
- **이미지 자동 첨부**: 그래프에서 `![[image.png]]`가 있는 문서를 선택하면 채팅창에 "🖼️ N개 이미지 자동 첨부" 배지 표시 → 전송 시 이미지가 AI에게 자동 전달되어 vision 분석 가능

### 5. 대화 요약 저장 (📝)

- 채팅 패널 상단의 📝 버튼 클릭
- AI가 현재 대화를 핵심 결정사항/인사이트 중심으로 요약
- 요약 결과가 AI 메모리에 추가되어 이후 대화에 자동 참고됨

### 6. 마크다운 에디터

- 파일 트리에서 파일 더블클릭 또는 우클릭 → "에디터에서 열기"
- `[[` 입력 시 볼트 내 문서 자동완성
- 저장: `Ctrl+S` 또는 1.2초 후 자동 저장

---

## 볼트 구조 가이드

Sandbox Map은 Obsidian과 완전히 호환됩니다. 더 풍부한 AI 인사이트를 위해 다음 구조를 권장합니다.

### 추천 프론트매터

```yaml
---
speaker: tech_director    # 담당자 (AI 페르소나 매칭)
date: 2024-01-15
tags: [전투, 밸런싱, RPG]
type: design              # 문서 유형
---
```

### 위키링크 및 이미지 임베드 활용

```markdown
## 전투 시스템

기본 공격 메커니즘은 [[스킬 트리]]와 연동됩니다.
밸런싱 기준은 [[게임 디자인 원칙]]을 따릅니다.

![[combat_flowchart.png]]
```

**위키링크가 많을수록, 그리고 자주 참조할수록** PPR 점수가 높아져 AI 인사이트의 품질이 향상됩니다.

**날짜 파일명 권장**: `[2024.01.28] 피드백 회의.md` 형식으로 저장하면 "1월 28일 피드백"처럼 자연어로 검색 가능합니다.

### 헤딩 구조 권장

헤딩(`##`)이 없는 파일은 패시지-레벨 검색 대상에서 제외됩니다. 모든 문서에 `## 개요` 이상의 헤딩을 포함할 것을 권장합니다 (목표: 99% 이상).

### Speaker ID 목록

| ID | 역할 |
|----|------|
| `chief_director` | 총괄 디렉터 |
| `art_director` | 아트 디렉터 |
| `design_director` | 디자인 디렉터 |
| `level_director` | 레벨 디렉터 |
| `tech_director` | 테크 디렉터 |

---

## 볼트 정제 도구 (tools/)

Confluence/Notion 등에서 추출한 문서를 볼트 규격에 맞게 정제하는 Python 스크립트 모음입니다. 자세한 사용법은 [manual/](manual/) 참조.

### 변환 도구

| 스크립트 | 역할 |
|---------|------|
| `refine_html_to_md.py` | HTML → Markdown 변환. BeautifulSoup4+markdownify, 멀티프로세싱 병렬처리 |
| `pdf_to_md.py` | PDF → Markdown 변환. 텍스트/스캔/Confluence PDF 3케이스 자동 분기 |
| `pdf_import.py` | PDF 임포트 + frontmatter 자동 생성 + 볼트 배치 |
| `pptx_to_md.py` | PPTX → Markdown 변환. 슬라이드별 ## 헤딩, 발표자 노트 인용구 |
| `xlsx_to_md.py` | XLSX → Markdown 변환. 시트별 헤딩, 셀 데이터 → 마크다운 테이블 |
| `docx_to_md.py` | DOCX → Markdown 변환. 스타일 기반 헤딩 변환, 표 → 마크다운 테이블 |
| `txt_to_md.py` | TXT → Markdown 변환. frontmatter 자동 생성 |
| `convert_jira.py` | Jira 이슈 JSON → Markdown 변환. Epic/Story/Bug 유형별 템플릿 |

### 정제 도구

| 스크립트 | 역할 |
|---------|------|
| `md_normalize.py` | 기존 MD 파일 frontmatter 정규화. 누락 필드 보완 |
| `normalize_frontmatter.py` | frontmatter YAML 구문 정규화 (따옴표·특수문자 자동 수정) |
| `scan_cleanup.py` | 스텁·구버전 파일 탐지 및 .archive/ 이동 |
| `enhance_wikilinks.py` | 클러스터 링크·제목 매칭 wikilink 주입 (1차 강화) |
| `strengthen_links.py` | 허브 링크·계층 링크·ghost→real 변환 (2차 강화). POST_SYNC_SCRIPTS 포함 |
| `inject_keywords.py` | 핵심 키워드 첫 등장을 허브 wikilink로 자동 교체. `_index.md` 자동 분석 (v3) |
| `gen_index.py` | `_index.md` 재생성 (날짜 역순, 월별 그룹핑) |
| `gen_jira_index.py` | `jira/_index.md` 재생성 (Epic/이슈 분류, 날짜 역순) |
| `gen_year_hubs.py` | 연도별 허브 파일 자동 생성 및 chief persona.md 갱신 |
| `split_large_docs.py` | 대용량 MD 파일을 허브-스포크 구조로 분할 (200줄+ 파일) |
| `crosslink_jira.py` | Jira Epic/이슈 ↔ active 문서 사이에 WikiLink 자동 교차 주입 |
| `extract_images.py` | 볼트 내 이미지 참조 추출 + 경로 정규화 |
| `fix_image_links.py` | 깨진 이미지 링크 자동 수정 (상대경로 재계산) |
| `incremental_update.py` | 변경된 파일만 선택적으로 재처리 (전체 재빌드 없이 빠른 업데이트) |
| `pipeline.py` | 변환 → 정제 → 품질 점검 전체 파이프라인 일괄 실행 |

### 품질 점검 도구

| 스크립트 | 역할 |
|---------|------|
| `check_quality.py` | 품질 체크리스트 자동 점검 (헤딩 보유 99%+ 기준) |
| `check_links.py` | 이미지/문서 링크 분리 점검. 깨진 링크 0개 목표 |
| `audit_and_fix.py` | 감사 + 자동 수정 통합. 괄호 절단 링크, 중첩 wikilink 자동 복구 |
| `check_outdated.py` | outdated 파일·고립 신규 문서·허브 업데이트 일자 점검 |
| `check_keyword_density.py` | KEYWORD_MAP 링크 밀도 감시. 범용어 오주입 방지 |

### 신규 문서 추가 절차

```bash
# 1. gen_index.py 실행 → _index.md에 새 문서 반영
python tools/gen_index.py vault/active

# 2. inject_keywords.py 실행 → 키워드 맵 자동 구성 + 링크 주입
python tools/inject_keywords.py vault/active

# 3. check_quality.py 재실행 → 고립 노드 0 확인
python tools/check_quality.py vault/active
```

---

## LLM 설정

설정 패널 (상단 설정 버튼) → API 키 입력 → 페르소나별 모델 선택:

| 제공자 | 지원 모델 | 이미지 지원 |
|--------|---------|-----------|
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 | ✅ |
| OpenAI | gpt-4.1, gpt-4.1-mini, gpt-4o, o3, o4-mini | ✅ |
| Google Gemini | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite | ✅ |
| xAI Grok | grok-3, grok-3-mini, grok-3-fast | ❌ |

**페르소나별 모델 독립 설정**: 각 디렉터 페르소나마다 다른 모델을 지정할 수 있습니다.
동일한 API 키로 여러 페르소나에게 서로 다른 모델을 할당하거나, 토론 모드에서 같은 제공자로 여러 참여자를 구성할 수 있습니다.

**Multi-Agent RAG 설정**: AI 탭에서 Worker LLM 병렬 요약 기능을 켜기/끄기 할 수 있습니다. 기본값은 활성화입니다.

---

## 프로젝트 구조

```
src/
├── components/
│   ├── chat/           # 채팅 패널 + 토론 모드 (DebateEngine, QuickQuestions)
│   ├── editor/         # CodeMirror 마크다운 에디터
│   ├── fileTree/       # 파일 트리 + 컨텍스트 메뉴
│   ├── graph/          # Graph2D (Canvas), Graph3D, GraphPanel (AI 분석)
│   ├── layout/         # 메인 레이아웃 + 상단 바 (노드 라벨 토글)
│   └── settings/       # 설정 모달 (페르소나별 모델 + Multi-Agent 토글)
│
├── lib/
│   ├── graphAnalysis.ts    # BM25 + PageRank + 클러스터링 + serialize/restore
│   ├── graphRAG.ts         # Graph-Augmented RAG 파이프라인 (directVaultSearch + PPR + getStrippedBody)
│   ├── graphBuilder.ts     # 노드/링크 생성 (팬텀 노드 + 이미지 노드 포함)
│   ├── synonyms.ts         # 동의어·약어 확장 (SYNONYM_MAP + expandTerms)
│   ├── markdownParser.ts   # YAML 프론트매터 + WikiLink + imageRefs 파싱 (비동기 청크)
│   ├── docsCache.ts        # IndexedDB 볼트 문서 + BM25 캐시 (저장/복원/경로 정규화)
│   ├── tfidfCache.ts       # BM25 캐시 무효화 (invalidateTfIdfCache — Edit Agent 연동)
│   ├── bm25WorkerClient.ts # Web Worker 클라이언트 (BM25 빌드 + 묵시적 링크 계산 위임)
│   ├── chatReportExporter.ts # 대화/보고서 → PDF용 standalone HTML 변환
│   ├── speakerConfig.ts    # 페르소나 ID + 라벨 + 색상 중앙 설정
│   ├── modelConfig.ts      # 모델 → 제공자 매핑 + 모델 목록
│   ├── personaVaultConfig.ts # 볼트 내 .rembrant/personas.md 파싱
│   └── nodeColors.ts       # 해시 기반 결정론적 노드 색상 + degree-proportional 크기 계산
│
├── services/
│   ├── editAgentRunner.ts  # Edit Agent 자율 편집 사이클 (파일 수정 + 캐시 무효화 + 품질 점검)
│   ├── syncRunner.ts       # POST_SYNC_SCRIPTS 실행 + runQualityCheck() export
│   ├── debateEngine.ts     # 토론 모드 엔진 (페르소나 기반 참여자)
│   ├── debateRoles.ts      # 토론 역할 + 라벨/색상 설정
│   ├── llmClient.ts        # 다중 LLM 통합 인터페이스 (Multi-Agent RAG + 컨텍스트 컴팩션)
│   └── providers/          # Anthropic / OpenAI / Gemini / Grok
│
├── stores/
│   ├── graphStore.ts       # 노드/링크/선택 상태
│   ├── vaultStore.ts       # 로드된 문서 + imagePathRegistry + imageDataCache
│   ├── settingsStore.ts    # API 키 + 페르소나 모델 + multiAgentRAG (persist)
│   ├── memoryStore.ts      # AI 영구 메모리 (대화 요약 누적, persist)
│   ├── backendStore.ts     # Python 백엔드 상태
│   └── uiStore.ts          # 테마 + 탭 + 편집 문서
│
├── hooks/
│   ├── useVaultLoader.ts       # 볼트 로드 + BM25 캐시 + 이미지 사전 인덱싱
│   ├── useRagApi.ts            # Slack Bot HTTP 요청 처리 (IPC ↔ RAG 파이프라인 브릿지)
│   ├── useGraphSimulation.ts   # 2D d3-force 시뮬레이션 (Canvas + Fast Mode)
│   └── useGraphSimulation3D.ts # 3D 물리 시뮬레이션
│
└── workers/
    └── bm25Worker.ts           # BM25 빌드 + O(N²) 묵시적 링크 계산 (Web Worker)

src/__tests__/              # Vitest 단위/통합 테스트
    ├── graphRAG.test.ts            # directVaultSearch + getStrippedBody + buildDeepGraphContext
    ├── graphAnalysis.test.ts       # BM25 + PageRank + 클러스터링
    ├── llmClient.test.ts           # Multi-Agent RAG + 컨텍스트 컴팩션 + generateSlackAnswer
    ├── searchScenarios100.test.ts  # 검색 시나리오 100건 (001-100)
    ├── searchScenarios200.test.ts  # 검색 시나리오 100건 (101-200)
    ├── searchScenariosJira.test.ts # Jira 중심 검색 시나리오 100건 (201-300)
    ├── searchWeakness.test.ts      # 약점/동의어/오타 시나리오 50건 (301-350)
    └── ...                         # 컴포넌트 테스트

mcp/                        # MCP 서버 (Model Context Protocol)
├── src/
│   ├── index.ts            # MCP 서버 진입점
│   ├── server.ts           # 30개 도구 정의 + 핸들러
│   ├── state.ts            # BM25 인덱스 + 그래프 in-memory 상태
│   ├── synonyms.ts         # 동의어·약어 확장 (프론트엔드와 동일 SYNONYM_MAP)
│   ├── vault.ts            # 볼트 파일 로드
│   ├── parser.ts           # 마크다운 파싱
│   ├── persona.ts          # 페르소나 설정
│   ├── config.ts           # mcp-config.json 로드
│   ├── llm/                # LLM 제공자 (Anthropic/OpenAI/Gemini/Grok)
│   └── tools/              # 외부 연동 클라이언트 (Confluence/Jira/Slack)
├── dist/                   # 빌드 결과물
└── package.json

tools/                      # 볼트 정제 Python 스크립트 (Confluence → Obsidian 변환)
    ├── convert_jira.py         # Jira 이슈 JSON → Markdown
    ├── crosslink_jira.py       # Jira↔Active WikiLink 교차 주입
    ├── gen_jira_index.py       # jira/_index.md 재생성
    ├── enhance_wikilinks.py
    ├── strengthen_links.py
    ├── inject_keywords.py
    ├── gen_index.py
    ├── pipeline.py             # 전체 파이프라인 일괄 실행
    ├── check_quality.py
    └── ...

manual/                     # 볼트 정제 매뉴얼
    ├── 00_index.md
    └── sections/
        ├── s01_overview.md     # §1 개요 + KPI
        ├── s02_triage.md       # §2 트리아지 (문서 분류 기준)
        ├── s03_conversion.md   # §3 변환 도구 사용법
        ├── s04_structure.md    # §4 볼트 구조 설계
        ├── s05_links.md        # §5 WikiLink 강화
        ├── s06_optimization.md # §6 검색 최적화
        ├── s07_quality.md      # §7 품질 관리
        ├── s08_operations.md   # §8 운영 가이드
        ├── s09_troubleshoot.md # §9 트러블슈팅
        ├── s10_jira_fetch.md   # §10 Jira fetch + 첨부파일 처리
        ├── s11_jira_aggregate.md # §11 Jira 집계 + 보고서
        └── s12_jira_crosslink.md # §12 Jira↔Active 교차 링크 자동화

bot/
├── bot.py                  # Slack Bolt 앱 GUI + VaultBot 통합 (tkinter)
├── requirements.txt
├── .env.example
├── SLACK_SETUP.md
└── modules/
    ├── rag_electron.py     # Electron RAG API 클라이언트 (localhost:7331)
    ├── multi_agent_rag.py  # Python 폴백 서브 에이전트 (Electron OFF 시)
    ├── rag_simple.py       # 간단 키워드 RAG + 핫스코어 재정렬
    ├── progress_updater.py # Slack 메시지 실시간 진행률 업데이트 (EWMA 기반)
    └── ...

logs/                       # AI 작업 세션 로그
    └── 2026-03-23_session_v3.25.md
```

---

## 라이선스

MIT License

---

> "문서가 많아질수록 그래프는 더 깊어지고, AI는 더 넓게 탐색합니다."
