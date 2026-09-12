# Sandbox Map 완성도 향상 계획

> 작성일: 2026-04-02
> 프로젝트 전체 탐색 기반 분석 결과

---

## 1. Critical — 보안

### 1-1. mcp-config.json 자격증명 평문 노출
- **위치**: `mcp-config.json:32-42`
- **문제**: Confluence/Jira의 `email`, `apiToken`이 평문으로 저장되어 있으며, `.gitignore`에 포함되지 않아 원격 저장소에 노출 가능
- **조치**:
  - `mcp-config.json`을 `.gitignore`에 추가
  - `mcp-config.example.json` 생성 (플레이스홀더 값)
  - 환경 변수 또는 Electron `safeStorage` API로 자격증명 이관
  - 노출된 자격증명 즉시 로테이션

### 1-2. API 키 localStorage 평문 저장
- **위치**: `src/stores/settingsStore.ts:269`
- **문제**: LLM API 키 4종이 Zustand `persist` 미들웨어로 `localStorage`에 평문 저장
- **조치**: Electron `safeStorage.encryptString` / `decryptString`으로 암호화 저장 전환

### 1-3. settings.local.json 자격증명 노출
- **위치**: `.claude/settings.local.json:67`
- **문제**: curl 명령어에 Basic Auth 자격증명(`jhoonn:Smilegate01*`)이 포함
- **조치**: 해당 항목 제거 또는 환경 변수 참조로 교체

---

## 2. High — 이식성·정확성

### 2-1. MCP 서버 python 명령어 하드코딩
- **위치**: `mcp/src/server.ts:305, 323`
- **문제**: `execFile('python', ...)`으로 하드코딩 — macOS/Linux에서는 `python3`이 필요
- **조치**: `process.platform === 'win32' ? 'python' : 'python3'` 분기 적용 (Electron `main.cjs`에는 이미 구현됨)

### 2-2. MCP config shallow merge
- **위치**: `mcp/src/config.ts:99`
- **문제**: `{ ...DEFAULTS, ...JSON.parse(raw) }` — 중첩 객체(`confluence`, `jira`, `slackBot`)가 통째로 교체되어 기본값 서브키 손실 가능
- **조치**: recursive deep merge 함수로 교체

### 2-3. 테스트 파일 머신 경로 하드코딩
- **위치**: `src/__tests__/searchScenarios100.test.ts:15`, `searchScenarios200.test.ts:15`, `searchScenariosJira.test.ts:15`, `searchWeakness.test.ts:18`
- **문제**: `const VAULT = 'C:/dev2/refined_vault'` — 다른 환경에서 실패
- **조치**: 환경 변수(`VAULT_PATH`) 또는 리포 내 fixture vault 사용

---

## 3. Medium — 유지보수성

### 3-1. God file 모듈 분리
- **대상 파일 및 규모**:
  - `electron/main.cjs` — 2082줄
  - `src/services/llmClient.ts` — 1671줄
  - `bot/bot.py` — 2029줄
  - `src/services/editAgentRunner.ts` — 1374줄
- **분리 방안**:
  - `main.cjs` → `electron/ipc-jira.cjs`, `electron/ipc-confluence.cjs`, `electron/rag-server.cjs`, `electron/bot-manager.cjs`
  - `bot.py` → `bot_gui.py`, `bot_slack.py`, `bot_main.py`
  - `llmClient.ts` → provider별 라우팅, RAG 파이프라인, 스트리밍을 별도 모듈로

### 3-2. 중복 인증 헤더 로직 통합
- **문제**: `buildAuthHeader` 패턴이 `main.cjs`와 `server.ts`에 8군데 이상 반복
- **조치**: `shared/auth.ts` (또는 `.cjs`) 공통 유틸로 추출

### 3-3. MCP 서버 테스트 부재
- **위치**: `mcp/src/` — 849줄, 테스트 파일 0개
- **조치**: vault CRUD, search, settings 도구 스모크 테스트 작성 (최소 커버리지)

### 3-4. MCP usage log 휘발성
- **위치**: `mcp/src/llm/client.ts:60-77`
- **문제**: `_usageLog`가 인메모리 — 서버 재시작 시 사용 이력 전부 소실
- **조치**: JSON 파일로 영속화 (mcp-config.json 옆에 `usage-log.json`)

### 3-5. RAG API 오프라인 상태 UI 미표시
- **위치**: `src/hooks/useRagApi.ts`, `bot/modules/rag_electron.py`
- **문제**: `127.0.0.1:7331` 미응답 시 사용자에게 상태 피드백 없음
- **조치**: 연결 실패 시 UI 토스트/배너 표시 + 봇 측 로그 경고 강화

---

## 4. Low — 완성도 폴리시

### 4-1. 깨진 디렉토리 정리
- `c:dev2Sandbox_Mapdocs` — 경로 인코딩 아티팩트, 삭제 필요

### 4-2. 테스트 커버리지 임계값 설정
- **위치**: `vitest.config.ts`
- **조치**: `coverage.thresholds` 추가하여 커버리지 퇴행 방지

### 4-3. Python 테스트 보강
- **미테스트 파일**: `mirofish_handler.py`(809줄), `slack_scheduler.py`, `report_builder.py`, `slack_image.py`
- **조치**: 핵심 비즈니스 로직 단위 테스트 추가

### 4-4. CLAUDE.md 확장
- 현재 8줄(250바이트)로 최소한의 내용만 포함
- **추가 내용**: dev 명령어(`npm run dev`, `npm test`), Python 봇 실행법, 코딩 컨벤션

### 4-5. 예외 무시(silent swallowing) 개선
- `bot/bot.py:96` — `except Exception: pass`
- `mcp/src/server.ts:489-497` — sprint 조회 실패 시 무시
- `mcp/src/config.ts:101` — JSON 파싱 실패 시 로그 없이 기본값 반환
- **조치**: 최소한 `console.error` / `logger.warning` 추가

---

---

## 5. 신규 기능 제안

### 5-1. 볼트 변경 이력 타임라인 (Vault Changelog)
- **현황**: Edit Agent가 파일에 날짜 스탬프(`<!-- edit-agent: YYYY-MM-DD -->`)를 남기지만, "언제 무엇이 바뀌었는지" 시각적 이력이 없음
- **제안**:
  - `vault_diff` MCP 도구 추가 — 특정 파일의 git diff 또는 스탬프 기반 변경 요약 반환
  - UI에 파일별 타임라인 뷰 추가 (DocViewer 사이드바 또는 별도 탭)
  - Edit Agent 로그(`edit-agent-logs.jsonl`)와 연동하여 AI가 수정한 내용 하이라이트

### 5-2. Implicit Link → Wikilink 원클릭 승격
- **현황**: `graph_implicit_links`가 BM25 코사인 유사도로 암묵적 연결을 탐지하지만, 결과를 보기만 할 수 있음
- **제안**:
  - InsightsPanel의 implicit links 결과에 "링크 추가" 버튼 추가
  - 클릭 시 해당 문서의 frontmatter `related:` 또는 본문에 `[[wikilink]]` 자동 삽입
  - 일괄 승격 모드 — 유사도 임계값 이상인 모든 링크를 한 번에 적용

### 5-3. 토론(Debate) 결과 볼트 저장 및 PDF 내보내기
- **현황**: MiroFish 시뮬레이션은 볼트 저장(`save_mirofish_to_vault`) + PDF 내보내기가 있으나, Debate 결과물은 채팅 UI에만 존재
- **제안**:
  - "볼트에 저장" 버튼 — 토론 전문을 참가자·라운드별로 구조화된 마크다운으로 저장
  - PDF 내보내기 — 기존 `report_builder` 파이프라인 재활용
  - 토론 요약 자동 생성 — 각 참가자의 핵심 주장, 합의점, 미해결 쟁점 정리

### 5-4. 크로스-볼트 통합 그래프 뷰
- **현황**: `CompareGraphCanvas`로 두 볼트를 나란히 비교할 수 있지만, 통합(union) 뷰는 없음
- **제안**:
  - 여러 볼트의 노드/링크를 하나의 그래프로 합침
  - 볼트별 색상 구분 + 크로스-볼트 공유 노드 하이라이트
  - 볼트 간 암묵적 연결 탐지 (서로 다른 볼트 문서 간 BM25 유사도)

### 5-5. 사용량 분석 차트 (Usage Analytics Dashboard)
- **현황**: `UsageTab`에서 일별 요약과 로그 목록만 제공 — 트렌드 파악 어려움
- **제안**:
  - 일/주/월별 토큰 사용량 및 비용 추이 라인 차트
  - 모델별 사용 비율 파이 차트 (Claude vs GPT vs Gemini vs Grok)
  - 기능별 분류 (chat, debate, edit-agent, mirofish, report)
  - 경량 차트 라이브러리 활용 (recharts 또는 chart.js)

### 5-6. 대화 분기(Conversation Branching)
- **현황**: 채팅이 완전 선형 구조 — 특정 메시지에서 다른 방향으로 탐색 불가
- **제안**:
  - 메시지 우클릭 → "여기서 분기" — 해당 지점까지의 히스토리로 새 대화 탭 생성
  - 분기 트리 시각화 (사이드바 미니맵)
  - 분기 간 비교 — 같은 질문에 다른 맥락/모델로 답변 비교

### 5-7. Edit Agent 예약 실행 (Scheduled Sweep)
- **현황**: Edit Agent는 수동 실행 또는 UI 타이머로만 동작. MiroFish에는 `scheduledTopics` 크론이 있으나 Edit Agent에는 없음
- **제안**:
  - 설정에 Edit Agent 예약 스케줄 추가 (매일 새벽 2시 등)
  - 실행 결과를 Slack 채널로 자동 리포트 (수정 파일 수, 스킵 사유 요약)
  - `sim_needed: true`처럼 `review_needed: true` frontmatter 태그로 우선 대상 지정

### 5-8. 그래프 클러스터 → Confluence 자동 발행
- **현황**: `confluence_write_page` 도구는 있으나, 그래프 분석 결과를 Confluence에 직접 발행하는 워크플로는 없음
- **제안**:
  - InsightsPanel 클러스터 탭에서 "Confluence에 발행" 버튼
  - 클러스터 내 문서들을 LLM이 요약 → 구조화된 Confluence 페이지로 자동 생성
  - 주기적 자동 발행 옵션 (주간 프로젝트 현황 페이지)

### 5-9. Insight Sweep UI 패널
- **현황**: `insight_sweep.py`가 볼트 전체에서 패턴/모순/갭을 탐지하지만, Edit Agent 채팅으로만 실행 가능 — 전용 UI 없음
- **제안**:
  - InsightsPanel에 5번째 탭 "AI Sweep" 추가
  - 카테고리별 인사이트 카드 (반복 패턴, 모순점, 누락 주제, 시계열 변화)
  - 각 인사이트에서 관련 문서로 바로 이동 + "Edit Agent로 수정" 원클릭

### 5-10. 멀티쿼리 검색 UI 토글
- **현황**: Slack 봇은 쿼리를 3개로 확장하여 병합 검색하지만, Electron UI에는 이 기능이 노출되지 않음
- **제안**:
  - 검색 설정에 "멀티쿼리 모드" 토글 추가
  - 활성화 시 LLM이 원본 쿼리를 2~3개 관점으로 분해 → 결과 병합
  - 각 서브쿼리가 어떤 문서를 찾았는지 RAG 프리뷰에 표시

### 5-11. 페르소나 간 비동기 메모 (Director Notes)
- **현황**: Debate에서 페르소나가 동기적으로 대화하지만, 비동기적으로 "메모를 남기는" 기능은 없음
- **제안**:
  - 볼트에 `_director_notes/` 폴더 — 각 페르소나가 다른 페르소나에게 남기는 메모
  - 예: PM이 분석 후 아트 디렉터에게 "이 캐릭터 비주얼 검토 필요" 메모 생성
  - 대상 페르소나 채팅 시 미읽은 메모 자동 주입

### 5-12. Slack 채널별 페르소나 자동 라우팅
- **현황**: Slack 봇에서 `@태그`로 페르소나를 수동 선택 — 채널에 따라 자동 배정되지 않음
- **제안**:
  - 설정에서 채널 ↔ 페르소나 매핑 (예: `#art-review` → 아트 디렉터)
  - 매핑된 채널에서는 `@태그` 없이도 해당 페르소나로 자동 응답
  - 복수 페르소나 매핑 시 round-robin 또는 키워드 기반 선택

---

## 6. 검색 품질 개선 — 심층 분석 및 제안

> 검색 파이프라인 전체(프론트엔드·MCP·Slack 봇)를 코드 레벨로 분석한 결과입니다.

### 6-1. 한국어 형태소 분석 강화 [High]

**현황** (`graphAnalysis.ts:19-59`):
- `stemKorean()` — 끝부분 조사 24종만 제거하는 규칙 기반 접미사 스트리핑
- 복합명사 미분리: "전투시스템" → 단일 토큰 (쿼리 "시스템"과 불일치)
- 용언 어간 추출 없음: "공격하다" → "공격" 변환 불가
- 짧은 조사 "이"를 무조건 제거: "아이" → "아" (오류)

**Python 봇** (`rag_simple.py:133`):
- 한국어 조사 스트리핑 **완전 미구현** — "시스템이"와 "시스템" 불일치
- 프론트엔드와 리콜 격차 심각

**제안**:
- **단기**: 프론트엔드 `stemKorean()` 복합명사 분리 규칙 추가 — 2음절 이상 한글 토큰을 2-gram 서브토큰으로 분해 (예: "전투시스템" → ["전투시스템", "전투", "시스템"])
- **단기**: Python 봇에 프론트엔드와 동일한 조사 스트리핑 이식
- **중기**: 경량 한국어 형태소 분석기 도입 (wasm-mecab 또는 es-hangul) — 브라우저에서도 동작 가능
- **효과**: 한국어 리콜 30~40% 향상 추정

### 6-2. 파일명 매치 점수 과대 보정 [High]

**현황** (`graphRAG.ts:421`):
```
파일명에 1개라도 매치 → score = 0.5 + base * 0.5 → 최소 0.5
→ strongPinnedHits (≥ 0.4) 경로 진입
→ 문서 본문 전체가 LLM 컨텍스트에 주입
```
- "회의"처럼 흔한 단어가 파일명에 포함된 문서가 **무조건** 핀 고정됨
- BFS/벡터 검색을 우회하여 관련 없는 문서가 최상위에 위치

**제안**:
- 파일명 매치 바닥값을 `0.5` → `0.3`으로 하향
- 핀 고정 임계값을 `0.4` → `0.6`으로 상향 (2개 이상 키워드 매치 시에만 핀 고정)
- 파일명 매치에도 IDF 가중치 적용 — 흔한 단어("회의", "정리", "기획")의 파일명 매치 점수 감소

### 6-3. 시간 가중치 이중 적용 문제 [High]

**현황**: 시간 보정이 **3곳**에서 독립적으로 적용됨:
1. `graphAnalysis.ts:394` — BM25 내부 `score *= 1 + 0.1 * exp(-daysOld/180)` (곱셈)
2. `graphRAG.ts:452` — `directVaultSearch`에서 동일 공식 (곱셈)
3. `llmClient.ts:596-607` — 외부 `+0.4 * exp(...)` (덧셈, hot 쿼리 시 **+2.0**)

- hot 쿼리에서 최근 문서: BM25 보정(×1.1) + 직접검색 보정(×1.1) + 외부 보정(+2.0)
- 관련도 0.3인 최근 문서가 관련도 0.9인 6개월 된 문서를 압도

**제안**:
- 시간 보정 단일화: BM25 내부 보정 제거, `fetchRAGContext`의 외부 단계에서만 1회 적용
- `recencyCoeffHot` 기본값 `2.0` → `0.8`로 하향 (관련도 대비 시간의 영향을 50% 이하로)
- 시간 보정 적용 후 최종 점수 = `max(relevanceScore, timeAdjustedScore * 0.7)` — 관련도 바닥 보장

### 6-4. 벡터 임베딩 3000자 절단 [High]

**현황** (`vectorEmbedIndex.ts:58,69`):
- 섹션/문서 텍스트를 3000자에서 하드 절단
- Gemini embedding-001은 ~8000토큰(~32000자) 지원 → 대부분의 용량을 사용하지 않음
- 긴 회의록·스펙 문서의 후반부가 벡터 검색에 완전히 투명

**제안**:
- 절단 한도를 `3000` → `6000`자로 상향 (API 한도의 ~75%)
- 또는 긴 문서에 대해 슬라이딩 윈도우 임베딩: 3000자씩 1500자 오버랩으로 2~3개 벡터 생성
- 검색 시 max-pool (가장 높은 코사인 유사도 채택)

### 6-5. BM25 후보 수 부족 [Medium]

**현황** (`settingsStore.ts:53`):
- `bm25Candidates: 8` — BM25에서 겨우 8개만 후보로 선정
- 벡터 검색 불가 시(API 키 없음) 전체 검색이 8개 문서 풀에서 결정
- 정답 문서가 BM25 9위면 영원히 검색 결과에 포함되지 않음

**제안**:
- `bm25Candidates` 기본값 `8` → `20`으로 상향
- 벡터 검색 불가 시 자동으로 `bm25Candidates * 2`로 확장하는 폴백 로직 추가

### 6-6. 한국어 버전 표기 중복 제거 누락 [Medium]

**현황** (`graphRAG.ts:670-702`):
```ts
const VERSION_RE = /[_\s]v(\d+(?:\.\d+)?)(?:\.md)?$/i
```
- `_v2`, `_v3.1` 패턴만 인식
- 한국어 버전 표기 미인식: `규칙_2차.md`, `기획서_최종.md`, `spec-2026-01.md`
- 구버전·신버전 문서가 모두 LLM 컨텍스트에 포함 → 모순 정보 주입

**제안**:
```ts
// 확장된 버전 패턴
const VERSION_RE = /[_\s](?:v(\d+(?:\.\d+)?)|(\d+)차|(\d{4}[-.]?\d{2}[-.]?\d{2}))(?:\.md)?$/i
const FINAL_RE  = /[_\s](최종|final|revised|개정)(?:\.md)?$/i
```
- 날짜 기반 버전: 동일 제목 + 다른 날짜 → 최신만 보존
- "최종" 태그: `_최종` 접미어 문서가 있으면 동명 구버전 제외

### 6-7. LLM 리랭킹 상위 20개 제한 [Medium]

**현황** (`llmClient.ts:339`):
- `candidates.slice(0, 20)` — 상위 20개만 LLM 리랭킹 대상
- 21번째 이후 후보는 원본 점수 유지 → 리랭킹된 후보와 점수 체계 불일치
- 리랭킹으로 하향된 1~20위 후보가 리랭킹 미적용 21위 이하보다 낮아져도 재정렬 안 됨

**제안**:
- 리랭킹 후 전체 배열 재정렬: `[...reranked, ...candidates.slice(20)].sort((a,b) => b.score - a.score)`
- 또는 리랭킹 미적용 후보에도 동일 가중치 변환 적용: `score = origScore * 0.4 + 0.5 * 0.6` (중립 LLM 점수 0.5 가정)

### 6-8. 프론트엔드·MCP·봇 간 BM25 파라미터 불일치 [Medium]

**현황**:
| 파라미터 | 프론트엔드 | MCP | 봇 |
|----------|-----------|-----|-----|
| BM25 B값 | 0.75 | 0.3 | N/A (TF-IDF) |
| 한국어 스테밍 | 24종 조사 | 24종 조사 | **없음** |
| 본문 절단 | 8000자 | 8000자 | **2000자** |
| 암묵적 링크 임계값 | 0.25 | 0.15 | N/A |

- 같은 쿼리라도 채널(Electron/MCP/Slack)에 따라 검색 결과가 크게 다름

**제안**:
- BM25 B값 통일: `0.55` (중간값, 문서 길이 다양성 고려)
- 봇 본문 절단 `2000` → `4000`자로 상향
- 봇에 한국어 조사 스트리핑 이식 (6-1과 연계)
- 공통 검색 파라미터를 `mcp-config.json`에서 관리 → 3곳 모두 동일 값 사용

### 6-9. Worker 요약 200자 제한 과도 [Medium]

**현황** (`llmClient.ts:286`):
```
'문서를 질문 관점에서 핵심만 200자 이내로 요약하세요.'
```
- 한국어 200자 ≈ 100단어 — 숫자, 날짜, 구체적 사실이 모두 탈락
- 메인 에이전트가 보는 것은 극도로 압축된 요약뿐 → 정밀한 답변 불가

**제안**:
- 요약 한도 `200자` → `500자`로 상향
- 또는 "핵심 수치/날짜/이름은 반드시 포함" 지시 추가
- 토큰 비용 우려 시: 워커 모델을 Haiku로 유지하되 출력 한도만 확장 (비용 미미)

### 6-10. fullVaultThreshold 무차별 주입 [Medium]

**현황** (`llmClient.ts:557-572`):
- 볼트 전체 ≤ 60000자면 **모든 문서를 관련도 순서 없이** LLM에 주입
- 쿼리와 무관한 문서도 포함 → LLM의 주의력 분산, 노이즈 증가

**제안**:
- 전체 주입 시에도 BM25 기반 정렬 적용 — 가장 관련성 높은 문서를 앞에 배치
- 각 문서에 `[관련도: ★★★]` 같은 마커 추가하여 LLM이 우선순위 판단 가능

### 6-11. 쿼리 확장(Query Expansion) Anthropic 종속 [Medium]

**현황** (`llmClient.ts:310-325`):
- `expandQueryWithLLM`이 Anthropic 프로바이더에 하드코딩
- OpenAI/Gemini/Grok 사용자는 Anthropic 키 없으면 기능 비활성
- 기본값도 `queryExpansion: false`

**제안**:
- 현재 선택된 프로바이더의 워커 모델로 쿼리 확장 수행
- 기본값을 `true`로 변경 (검색 품질 향상 효과가 비용 대비 높음)
- LLM 없이도 동작하는 규칙 기반 확장 폴백: 동의어 사전 + 한영 변환

### 6-12. PPR에서 구버전 문서 영향 전파 [Low]

**현황** (`graphRAG.ts:928-930`):
- `isOutdatedDoc`에 의한 0.3 감쇠가 PPR 이후에 적용
- PPR 전파 중에는 구버전 허브 문서가 정상 가중치로 이웃에게 점수 전파
- 구버전 허브가 연결된 최신 문서들의 PPR 점수를 오염

**제안**:
- PPR 입력 그래프에서 outdated 노드의 outgoing edge 가중치를 0.3으로 사전 감쇠
- 또는 outdated 문서를 PPR seed에서 제외하되 경유 노드로는 허용

### 6-13. 클러스터 토픽 추출 IDF 미적용 [Low]

**현황** (`graphAnalysis.ts:710-728`):
- 클러스터 키워드가 단순 빈도(TF)로 추출 — "회의", "기획", "문서" 같은 범용어가 상위
- 이 키워드가 구조 헤더로 LLM 시스템 프롬프트에 주입 → 노이즈

**제안**:
- TF × IDF 적용: 해당 클러스터 TF × 볼트 전체 IDF → 클러스터 고유 키워드 추출
- 범용어 불용어 리스트 추가 (게임, 회의, 문서, 내용, 진행, 확인 등 20~30개)

### 6-14. HyDE(Hypothetical Document Embedding) 도입 [Low]

**현황**: 벡터 검색은 쿼리 텍스트를 그대로 임베딩 — 짧은 한국어 쿼리(3~7토큰)와 긴 문서 본문 간 의미 공간 괴리

**제안**:
- 쿼리를 LLM에 보내 "이 질문에 답하는 가상 문서 1단락"을 생성
- 가상 문서를 임베딩하여 벡터 검색 수행
- 짧은 쿼리의 벡터 검색 정확도를 크게 향상 (논문 기준 recall@10 +15~25%)
- 비용: 워커 모델 1회 호출 (Haiku 수준이면 ~$0.001)

---

### 검색 개선 우선순위 요약

| 등급 | 항목 | 핵심 효과 |
|------|------|-----------|
| 🔴 P0 | 6-1 한국어 형태소 + 봇 조사 스트리핑 | 한국어 리콜 30~40% 향상 |
| 🔴 P0 | 6-3 시간 가중치 이중 적용 제거 | 관련도 역전 현상 해소 |
| 🔴 P0 | 6-2 파일명 매치 과대 보정 수정 | 잘못된 핀 고정 방지 |
| 🟠 P1 | 6-4 벡터 임베딩 3000→6000자 | 긴 문서 후반부 검색 가능 |
| 🟠 P1 | 6-5 BM25 후보 8→20개 | 벡터 미사용 시 리콜 2.5배 |
| 🟠 P1 | 6-8 프론트엔드·MCP·봇 파라미터 통일 | 채널 간 일관성 |
| 🟡 P2 | 6-9 Worker 요약 200→500자 | 답변 정밀도 향상 |
| 🟡 P2 | 6-6 한국어 버전 중복 제거 | 모순 정보 제거 |
| 🟡 P2 | 6-7 LLM 리랭킹 재정렬 | 점수 체계 일관성 |
| 🟢 P3 | 6-14 HyDE 도입 | 짧은 쿼리 recall 향상 |
| 🟢 P3 | 6-11 쿼리 확장 프로바이더 독립 | 비 Anthropic 사용자 지원 |

---

## 7. 메모리 최적화 및 프리징 감소

> 코드 레벨 분석 기반. 500문서 볼트 × 8볼트 캐시 시 추정 메모리와 UI 블로킹 시간 포함.

### A. 메모리 — 데이터 구조 최적화

#### 7-1. `rawContent` + `sections` 이중 저장 해소 [High]
- **위치**: `src/types/index.ts:140`, `vaultStore.ts`
- **문제**: `LoadedDocument`에 `rawContent`(원본 전문)와 `sections[].body`(같은 텍스트 파싱 결과)가 동시 보관 → 문서당 텍스트 2배 저장
- **영향**: 500문서 × 5KB × 2 = ~5MB/볼트, 8볼트 캐시 시 **~40MB** 낭비
- **제안**: `sections`이 비어있지 않으면 `rawContent`를 getter로 대체 — `sections[].body`를 합쳐 반환. 파싱 후 `rawContent = ''`으로 해제

#### 7-2. `_stemCache` 무한 증가 (메모리 누수) [High]
- **위치**: `src/lib/graphAnalysis.ts:28`
- **문제**: `Map<string, string[]>` 모듈 레벨 싱글톤, 삭제/제한 없음. 볼트 전환·검색·증분 업데이트마다 계속 누적
- **영향**: 장시간 세션에서 10만+ 엔트리 → **~10MB 이상** 누적 가능
- **제안**: `clearMetricsCache()` 호출 시 `_stemCache.clear()` 추가, 또는 LRU 캡(5만 엔트리)

#### 7-3. `vaultDocsCache` 볼트 제거 시 미정리 [High]
- **위치**: `src/stores/vaultStore.ts:263`
- **문제**: `removeVault(id)` 호출 시 `vaultDocsCache[id]`와 `vaultMetaCache[id]`가 삭제되지 않음 → 제거된 볼트의 문서 배열이 GC 불가
- **제안**: `removeVault` 내부에 `delete vaultDocsCache[id]`, `delete vaultMetaCache[id]` 추가

#### 7-4. 벡터 임베딩 메모리 최적화 [Medium]
- **위치**: `src/lib/vectorEmbedIndex.ts:17-35`
- **문제**: `number[]` (64비트) × 3072차원 = 벡터당 **24KB**. 500문서 × 5섹션 = 2,500벡터 → **~60MB**
- **제안**:
  - `Float32Array`로 전환 (메모리 절반, 24KB → 12KB/벡터, 정밀도 충분)
  - 또는 양자화: 8비트 정수 + 스케일 팩터 (3KB/벡터, 메모리 1/8)

#### 7-5. BM25 인덱스 이중 Map 구조 [Medium]
- **위치**: `src/lib/graphAnalysis.ts:169-178`
- **문제**: 문서당 `termFreqs` Map + `bm25Vec` Map → 300토큰/문서 기준 Map 엔트리 30만개 (500문서)
- **영향**: JS Map 오버헤드 포함 **~15-30MB**
- **제안**: `termFreqs`는 `bm25Vec` 계산 후 불필요 — `build()` 완료 시 `termFreqs` 해제. 암묵적 링크용 코사인 유사도는 `bm25Vec`만으로 계산 가능

#### 7-6. `chatStore` 메시지 무제한 누적 [Low]
- **위치**: `src/stores/chatStore.ts:59`
- **문제**: `messages: ChatMessage[]`에 길이 제한 없음. 도구 호출 결과, 확장 사고, base64 이미지 첨부가 포함되면 수MB/메시지
- **제안**: 최대 100~200 메시지 캡 + 오래된 메시지의 `toolCalls[].result`를 요약으로 교체

#### 7-7. `imageDataCache` O(N²) 삽입 [Low]
- **위치**: `src/stores/vaultStore.ts:188-197`
- **문제**: `_imageAccessOrder.filter(k => !newKeys.includes(k))` — `includes`가 O(N) × `filter` O(N) = O(N²)
- **제안**: `newKeys`를 `Set`으로 변환 후 `.has()` 사용 → O(N)

---

### B. 프리징 — UI 스레드 블로킹 제거

#### 7-8. `fullVectorSearch` 코사인 루프 메인 스레드 [High]
- **위치**: `src/lib/vectorEmbedIndex.ts:368`
- **문제**: 2,500 임베딩 × 3,072차원 내적 = **768만 FP 곱셈**이 메인 스레드에서 동기 실행 → 검색당 15~50ms 블로킹
- **제안**: `vectorWorker.ts` 생성하여 Web Worker로 오프로드 (기존 `bm25Worker.ts`, `pprWorker.ts` 패턴 재활용)

#### 7-9. `directVaultSearch` 반복 `toLowerCase()` [High]
- **위치**: `src/lib/graphRAG.ts:389`
- **문제**: 매 검색마다 모든 문서의 `rawContent?.toLowerCase()` 호출 → 500문서 × 5KB = **~2.5MB 문자열 재할당**
- **제안**: 파싱 시점에 `rawContentLower`를 미리 캐시하여 `LoadedDocument`에 저장. 또는 `_cachedLowerMap: Map<string, string>` 활용

#### 7-10. `sim.tick(150)` 동기 실행 [High]
- **위치**: `src/hooks/useGraphSimulation.ts:83`
- **문제**: Fast 모드에서 D3 force 시뮬레이션 150틱을 한 번에 동기 실행. 1,000노드 × 3,000링크 시 **수백 ms 블로킹**
- **제안**: 청크 분할 — `3 × 50틱` + `setTimeout(0)` 또는 `requestIdleCallback`으로 UI 양보

#### 7-11. `rerankResults()` docMap 매번 재생성 [Medium]
- **위치**: `src/lib/graphRAG.ts:604`
- **문제**: `new Map(_docs.map(d => [d.id, d]))` — 매 리랭킹 호출마다 전체 문서 Map 재생성 (O(N))
- **제안**: `getCachedMaps()` 활용 (이미 캐시 구조 존재)

#### 7-12. `markdownParser` 동기 파싱 [Medium]
- **위치**: `src/lib/markdownParser.ts`
- **문제**: 500파일에 `gray-matter`를 동기 호출 → 볼트 로드 시 메인 스레드 블로킹
- **제안**: `parseVaultFiles`를 Web Worker로 이동 (gray-matter는 순수 JS, Worker 호환)

#### 7-13. `settingsStore` persist 직렬화 빈도 [Low]
- **위치**: `src/stores/settingsStore.ts:578-665`
- **문제**: Zustand persist가 모든 상태 변경마다 `JSON.stringify` 실행. `ragInstruction`, `editAgentConfig` 등 큰 문자열 포함
- **제안**: persist에 디바운스 적용 (500ms) — 빠른 연속 변경 시 직렬화 1회로 병합

#### 7-14. Electron 메인 프로세스 동기 I/O [Low]
- **위치**: `electron/main.cjs:548` (`writeFileSync`), `main.cjs:592` (`readFileSync`)
- **문제**: 메인 프로세스에서 동기 파일 I/O → IPC 핸들러 블로킹
- **제안**: `fs.promises.writeFile` / `fs.promises.readFile`로 비동기 전환

---

### C. 메모리/프리징 개선 우선순위

| 등급 | 항목 | 핵심 효과 | 추정 절감 |
|------|------|-----------|-----------|
| 🔴 P0 | 7-2 `_stemCache` 누수 수정 | 장시간 세션 메모리 안정화 | ~10MB |
| 🔴 P0 | 7-8 벡터 검색 Worker 오프로드 | 검색 시 15~50ms 프리징 제거 | UI 블로킹 |
| 🔴 P0 | 7-10 `sim.tick(150)` 청크 분할 | 볼트 로드 시 수백ms 프리징 제거 | UI 블로킹 |
| 🟠 P1 | 7-1 `rawContent` 이중 저장 해소 | 문서 텍스트 메모리 절반 | ~20MB (8볼트) |
| 🟠 P1 | 7-3 볼트 제거 시 캐시 정리 | 고아 데이터 GC 가능 | ~5MB/볼트 |
| 🟠 P1 | 7-9 `toLowerCase()` 캐시 | 검색당 2.5MB 재할당 제거 | GC 부하 |
| 🟠 P1 | 7-4 `Float32Array` 전환 | 벡터 메모리 절반 | ~30MB |
| 🟡 P2 | 7-5 BM25 `termFreqs` 해제 | Map 엔트리 절반 제거 | ~10MB |
| 🟡 P2 | 7-11 `rerankResults` docMap 캐시 | 리랭킹 O(N) 할당 제거 | GC 부하 |
| 🟡 P2 | 7-12 마크다운 파서 Worker 이동 | 볼트 로드 프리징 제거 | UI 블로킹 |
| 🟢 P3 | 7-6 채팅 메시지 캡 | 극단 세션 OOM 방지 | 가변 |
| 🟢 P3 | 7-13 persist 디바운스 | 빈번 설정 변경 시 jank 감소 | 미미 |
| 🟢 P3 | 7-14 메인 프로세스 비동기 I/O | IPC 지연 감소 | 미미 |

---

## 우선 실행 로드맵

### Phase 1 — 즉시 (보안·안정성)

| 순서 | 항목 | 예상 영향 |
|------|------|-----------|
| 1 | `mcp-config.json` `.gitignore` + example 파일 | 보안 즉시 개선 |
| 2 | `python` → `python3` 분기 처리 | 크로스플랫폼 호환 |
| 3 | API 키 safeStorage 전환 | 보안 강화 |

### Phase 2 — 단기 (유지보수·품질)

| 순서 | 항목 | 예상 영향 |
|------|------|-----------|
| 4 | `main.cjs` IPC 핸들러 모듈 분리 | 유지보수 병목 해소 |
| 5 | MCP 서버 스모크 테스트 추가 | 안정성 확보 |
| 6 | MCP usage log 영속화 | 데이터 보존 |

### Phase 3 — 중기 (신규 기능)

| 순서 | 항목 | 예상 영향 |
|------|------|-----------|
| 7 | Implicit Link 승격 (5-2) | 볼트 연결 밀도 향상 |
| 8 | 사용량 분석 차트 (5-5) | 비용 가시성 확보 |
| 9 | Debate 볼트 저장/PDF (5-3) | 토론 결과물 자산화 |
| 10 | 멀티쿼리 검색 UI (5-10) | 검색 품질 향상 |
| 11 | Insight Sweep UI (5-9) | AI 분석 접근성 향상 |

### Phase 4 — 장기 (차별화)

| 순서 | 항목 | 예상 영향 |
|------|------|-----------|
| 12 | 볼트 변경 이력 타임라인 (5-1) | 감사 추적 완성 |
| 13 | 대화 분기 (5-6) | 탐색 유연성 극대화 |
| 14 | 크로스-볼트 통합 그래프 (5-4) | 멀티 프로젝트 시너지 |
| 15 | Edit Agent 예약 실행 (5-7) | 볼트 자동 유지보수 |
| 16 | 클러스터 → Confluence 발행 (5-8) | 문서화 자동화 |
| 17 | 페르소나 비동기 메모 (5-11) | 협업 깊이 확장 |
| 18 | Slack 채널별 자동 라우팅 (5-12) | 운영 편의성 |
