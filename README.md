# STRATA SYNC

<details>
<summary><b>🇰🇷 한국어</b></summary>

## 개요

STRATA SYNC는 Obsidian 스타일 마크다운 볼트를 읽어 **위키링크 기반 지식 그래프**를 구축하는 데스크탑 애플리케이션입니다. 멀티 AI 디렉터 페르소나가 그래프를 탐색하여 프로젝트에 대한 깊은 인사이트를 전달합니다.

```
Vault 폴더 (.md 파일)
  ↓ 로드 + 파싱
지식 그래프 (WikiLink 연결)
  ↓ directVaultSearch + BM25 + TF-IDF + Vector Embedding + BFS + PPR
컨텍스트 수집
  ↓ Multi-Agent RAG (Chief + Worker LLM)
딥 인사이트 (스트리밍)
```

**로컬 모드** — 백엔드 서버 없이 동작합니다. BM25, TF-IDF, 그래프 탐색은 디바이스에서 실행되고, 벡터 임베딩은 로컬 BGE-M3 서버(오프라인)나 Gemini API 중 가용한 쪽을 씁니다.

**팀 모드 (진행 중)** — 볼트를 Cloudflare R2로 동기화하고, 임베딩·볼트 린트·리뷰를 서버 배치로 돌려 팀 전체가 같은 그래프를 보게 하는 작업이 진행 중입니다. 계획은 `docs/plan-team-vault-2026-09.html`을 참고하세요.

---

## 주요 기능

### 지식 그래프 시각화
- **2D Graph (SVG)**: d3-force 물리 엔진 기반 인터랙티브 그래프 — 기본 모드
- **2D Graph (Canvas)**: 대규모 볼트용 Fast Mode 고성능 렌더러
- **3D Graph**: Three.js + d3-force-3d 볼륨 그래프 (InstancedMesh 최적화, dirty-render 버짓 시스템)
- **Obsidian 스타일 노드 크기**: 링크 수(degree)에 비례, √degree 스케일
- **노드 컬러 모드**: 문서 타입 / 스피커 / 폴더 / 태그 / 토픽 클러스터별 색상
- **Phantom 노드**: 존재하지 않는 파일을 가리키는 위키링크도 그래프에 표시
- **이미지 노드**: `![[image.png]]`으로 참조된 이미지가 다이아몬드 모양 노드로 표시
- **AI 하이라이트**: AI 응답에서 언급된 문서가 자동으로 펄스 애니메이션 하이라이트
- **미니맵**: 그래프 전체 개요 네비게이션
- **노드 검색**: Ctrl+F로 그래프 내 노드 검색
- **볼트 비교 뷰**: 두 볼트를 나란히 비교

### 그래프 보강 RAG
- **directVaultSearch**: 날짜 파일명(`[2026.01.28] 피드백.md`) 및 정확한 제목 검색 — BM25 이전에 실행
- **BM25 검색**: Web Worker에서 BM25 스코어링 기반 문서 랭킹, IndexedDB 캐싱으로 즉시 복원
- **동의어 확장**: 도메인 동의어 자동 적용 (프론트엔드/MCP 공유)
- **쿼리 커버리지 패널티**: 부분 매칭 문서 억제
- **최신성 부스트**: 6개월 지수 감쇠로 최신 문서 우선
- **패시지 레벨 검색**: 문서 전체가 아닌 가장 관련성 높은 섹션만 선택
- **링크 강도**: 위키링크 참조 횟수 정규화 [0.15, 1.0]
- **Personalized PageRank (PPR)**: 강도 가중 랜덤 워커 기반 문서 중요도 산출
- **암묵적 링크 발견**: BM25 벡터 코사인 유사도로 숨겨진 연결 탐지
- **클러스터 토픽 라벨**: 클러스터별 빈도 기반 키워드 자동 추출
- **브릿지 노드 탐지**: 다중 클러스터를 연결하는 아키텍처 핵심 문서 식별

### 벡터 임베딩 검색
- **임베딩 프로바이더 자동 선택**: 로컬 BGE-M3 서버(`scripts/local_embed_server.py`, 1,024차원, 오프라인)가 떠 있으면 우선 사용, 없으면 Google Gemini `gemini-embedding-001`(3,072차원, API 키 필요). 프로바이더가 바뀌면 캐시를 전량 재빌드해 차원 불일치를 막습니다
- **3단계 검색 전략**: 벡터 검색 → ChromaDB → BM25 폴백 (가용성 기반 자동 전환)
- **하이브리드 리랭킹**: BM25 스코어 40% + 코사인 유사도 60% 가중 합산으로 최종 순위 결정
- **백엔드 임베딩**: ChromaDB + `sentence-transformers/all-MiniLM-L6-v2` (384차원, 오프라인, API 키 불필요)
- **증분 캐시**: 볼트 안 `.vector_cache_v6.json`에 섹션별 임베딩을 mtime과 함께 저장 — 문서 하나를 고치면 그 문서만 다시 임베딩합니다. 청커 버전이 바뀌면 자동 재빌드
- **백그라운드 빌드**: 볼트 로드 후 비동기 임베딩 생성 (20개/배치)
- **섹션 단위 청킹**: 마크다운 헤딩 기준으로 나누고 300자 미만 섹션은 이웃과 병합 (`src/lib/markdownParser.ts`)

### 멀티에이전트 RAG
- **Chief + Worker 구조**: 핵심 문서는 Chief LLM이 전체(20K)를 읽고, 보조 문서는 Worker LLM이 병렬 요약(200자)
- **자동 Worker 모델 선택**: 동일 프로바이더의 최저가 모델 자동 배정
- **병렬 요약**: 최대 5개 문서를 `Promise.all`로 동시 처리
- **폴백 안전장치**: Worker 실패 시 문서 첫 300자로 대체
- **토글**: Settings → AI 탭에서 활성화/비활성화

### 에이전틱 도구 사용
- **streamMessageWithTools**: 파일 읽기/쓰기, 검색 등 도구를 자율적으로 사용하는 에이전트 루프
- **도메인 분류**: 문서를 서사/캐릭터 vs 시스템/게임플레이 도메인으로 자동 분류 후 도메인별 합성

### 컨텍스트 압축
- **자동 대화 압축**: 채팅 히스토리가 20,000자 초과 시 Worker LLM이 요약하여 시스템 프롬프트에 주입
- **최근 메시지 유지**: 최신 컨텍스트는 항상 보존
- **자동 메모리 저장**: 요약이 자동으로 영구 메모리에 저장 — 세션 간 인사이트 축적

### 편집 에이전트
- **자율 편집**: AI가 사용자 지시에 따라 마크다운을 읽고/수정
- **즉시 캐시 무효화**: 파일 저장 후 BM25 캐시 자동 클리어
- **자동 품질 검사**: 편집 후 `check_quality.py` 실행
- **후처리 파이프라인**: `inject_keywords.py → strengthen_links.py → enhance_wikilinks.py`
- **토큰 추적**: 사이클별 LLM 토큰 사용량 로깅

### 멀티 LLM 페르소나
- 5개 디렉터 페르소나 (Chief / Art / Plan / Level / Prog)
- 지원 프로바이더: **Anthropic Claude**, **OpenAI GPT**, **Google Gemini**, **xAI Grok**
- 이미지 첨부 지원 (Anthropic, OpenAI, Gemini)
- 페르소나별 커스텀 시스템 프롬프트

### 토론 모드
- 디렉터 페르소나들이 주제에 대해 토론 (라운드 로빈 / 자유 토론 / 역할 배정 / 대결 모드)
- 참고 자료 첨부 (텍스트 / 이미지 / PDF), 실시간 스트리밍 출력

### 마크다운 에디터 (CodeMirror 6)
- Obsidian 스타일 `[[WikiLink]]` WYSIWYG 렌더링 + 자동완성
- `~~취소선~~`, `==하이라이트==`, `%% 주석 %%` 시각 처리
- 키보드 단축키: `Ctrl+Shift+S` (취소선), `Ctrl+Shift+H` (하이라이트), `Ctrl+Shift+C` (인라인 코드)
- 스마트 Enter: 번호 리스트 자동 증가 / 인용 블록 연속
- 3초 자동 저장

### MiroFish 시뮬레이션
- 소셜 그래프 기반 AI 페르소나 시뮬레이션 엔진
- OASIS 프레임워크 기반 소셜 미디어 환경 시뮬레이션
- 팀 역학 분석 및 리포트 생성

### 웹 검색
- 볼트 외부 정보 검색으로 RAG 보강
- LLM이 자율적으로 웹 검색 필요성 판단

### 채팅 리포트
- 대화 내용 기반 리포트 자동 생성
- PDF / 마크다운 내보내기

### 파일 트리
- 폴더 / 스피커 / 태그 분류 뷰
- 이름순 또는 수정일순 정렬
- 우클릭 컨텍스트 메뉴: 에디터 열기 / 복사 / 북마크 / 이름 변경 / 삭제

---

## 기술 스택

| 영역 | 기술 | 버전 |
|------|------|------|
| UI | React + TypeScript | 19.x / 5.5 |
| 빌드 | Vite | 5.4 |
| 스타일링 | Tailwind CSS | 4.x |
| 상태 관리 | Zustand | 5.x |
| 애니메이션 | Framer Motion | 12.x |
| 2D 그래프 | d3-force | 3.x |
| 3D 그래프 | Three.js + d3-force-3d | 0.175 / 3.x |
| 에디터 | CodeMirror | 6.x |
| 데스크탑 | Electron | 41.x |
| 백엔드 | FastAPI + ChromaDB | - |
| 테스트 | Vitest + pytest | - |

---

## 핵심 알고리즘

### 1. directVaultSearch (`src/lib/graphRAG.ts`)
날짜 파일명 등 BM25로 찾기 어려운 제목 기반 검색. Strong match (score >= 0.4) / Weak match 2단계.

### 2. BM25 검색 (`src/workers/bm25Worker.ts`)
Web Worker에서 BM25 스코어링 실행. IndexedDB 캐싱으로 볼트 재오픈 시 즉시 복원.

### 3. TF-IDF (`src/lib/graphAnalysis.ts`)
`TF x IDF` 가중치 기반 문서 유사도 산출. 암묵적 링크 발견에 코사인 유사도 활용.

### 4. Personalized PageRank (`src/workers/pprWorker.ts`)
링크 강도 가중 랜덤 워커 기반. 메인 RAG 파이프라인의 핵심 랭킹 알고리즘.

### 5. BFS 그래프 탐색 (`src/lib/graphRAG.ts`)
위키링크를 따라 최대 N홉까지 관련 문서 수집. 노드 선택 분석 시 사용.

### 6. Union-Find 클러스터 탐지 (`src/lib/graphAnalysis.ts`)
위키링크로 연결된 문서 그룹을 자동 클러스터링. Path compression으로 준-O(1) 복잡도.

### 7. 벡터 임베딩 (`src/lib/vectorEmbedIndex.ts`)
Gemini 임베딩으로 시맨틱 검색 및 하이브리드 리랭킹. BM25 키워드 검색과 벡터 코사인 유사도를 40:60 비율로 합산.

---

## Multi-Agent RAG 아키텍처

```
사용자 쿼리
    |
    +-- directVaultSearch() <-- 날짜/제목 직접 검색
    |       |
    |       +-- Strong match?
    |               +-- YES --> Chief LLM (전체 20K) + Worker LLM x N (병렬 요약)
    |               +-- NO  --> 벡터/BM25 + TF-IDF 경로
    |
    +-- 3단계 검색 (가용성 기반 자동 전환)
    |       |
    |       +-- 1순위: Gemini 벡터 검색 (API 키 있을 때)
    |       +-- 2순위: ChromaDB 시맨틱 검색 (백엔드 실행 시)
    |       +-- 3순위: BM25 키워드 검색 (항상 가용)
    |
    +-- 하이브리드 리랭킹 (BM25 40% + 코사인 유사도 60%)
            |
            +-- PPR (Personalized PageRank) 기반 문서 랭킹
            +-- 도메인 분류 (서사 vs 시스템) → 도메인별 합성
            +-- 웹 검색 보강 (선택)
```

### Worker 모델 자동 선택

| Chief 프로바이더 | Worker 모델 |
|-----------------|------------|
| Anthropic | `claude-haiku-4-5-20251001` |
| OpenAI | `gpt-4.1-mini` |
| Google | `gemini-2.5-flash-lite` |
| xAI | `grok-3-mini` |

---

## 시스템 아키텍처

```
FRONTEND (React 19 + TypeScript + Vite)
+-- 그래프 시각화 (D3-Force 2D/3D, Three.js)
+-- RAG 검색 (BM25 Worker + PPR + TF-IDF)
+-- 채팅 UI (5 페르소나 + 토론)
+-- 편집 에이전트
+-- 파일 에디터 (CodeMirror)
+-- 설정 (18개 탭)
+-- 상태 관리 (Zustand 15개 스토어)

ELECTRON (v41)
+-- 메인 프로세스 (IPC, 파일 시스템, 파일 감시)
+-- RAG API HTTP (port 7331)
+-- strata-img:// 프로토콜

BACKEND (FastAPI + ChromaDB)
+-- 문서 CRUD API
+-- RAG 서비스

BOTS
+-- Slack Bot (Socket Mode)
+-- Telegram Bot (Long Polling)

MCP SERVER (Node.js + TypeScript)
+-- Claude Code / Cursor 연동
+-- 볼트 검색 + LLM 호출

VAULT TOOLS (Python 30개)
+-- 포맷 변환 (DOCX/PDF/PPTX/XLSX → MD)
+-- 링크 강화 + 키워드 주입
+-- 품질 감사 + 인덱스 생성
```

---

## 설치 및 설정

### 전제 조건
- Node.js 18+
- Python 3.10+ (백엔드/봇/도구용)

### 개발
```bash
npm install
npm run electron:dev
```

### 프로덕션 빌드
```bash
npm run electron:build
```

### 백엔드
```bash
cd backend
pip install -r requirements.txt
python main.py
```

### 테스트
```bash
npm test              # Frontend
cd backend && pytest  # Backend
cd bot && pytest      # Bot
```

---

## 사용 가이드

### 1. 볼트 로드
앱 실행 → "Open Vault" → Obsidian 볼트 폴더 선택 → 지식 그래프 자동 생성

### 2. 그래프 탐색
- **드래그**: 이동/회전 | **스크롤**: 확대/축소
- **노드 클릭**: 문서 선택 | **더블클릭**: 에디터 열기
- **Ctrl+F**: 노드 검색 | **미니맵**: 전체 네비게이션

### 3. AI 분석
- **노드 분석**: 노드 클릭 → "AI Analysis" → 관련 문서 자동 탐색
- **전체 분석**: 노드 미선택 → "Full AI Analysis" → 허브 노드 기반 전체 개요

### 4. AI 채팅
- 우측 패널에서 페르소나 선택 후 자연어로 질문
- 이미지 자동 첨부: 선택된 문서에 `![[...]]` 이미지가 있으면 자동 전송

---

## 팀 동기화 (Cloudflare)

여러 PC의 볼트를 하나로 합칩니다. 원본은 Cloudflare R2에 있고, 각 PC의 볼트 폴더는 그 복제본입니다. 서버 코드는 `cloud/`(Wrangler 프로젝트)에 있습니다.

**서버 한 번 배포 (팀당 1회)**
```bash
cd cloud && npm install
npx wrangler d1 create strata-sync-db          # 출력된 database_id를 wrangler.toml에 붙여넣기
npx wrangler r2 bucket create strata-vault
npx wrangler secret put TEAM_TOKEN             # 팀이 공유할 긴 임의 문자열
npx wrangler d1 migrations apply strata-sync-db --remote
npx wrangler deploy                             # → https://strata-sync-cloud.<account>.workers.dev
```

**각 PC에서** Settings → Vault → Team Sync에 서버 URL, 팀 토큰, 이름을 넣고 켭니다. 토큰은 OS 키체인으로 암호화해 이 PC에만 저장됩니다.

**동작 방식**
- 저장 후 2초 뒤 업로드, 30초마다 다른 사람의 변경을 내려받습니다. 오프라인이면 큐에 쌓아두고 다시 시도합니다.
- 같은 파일을 둘이 고치면 서버 버전이 원래 이름을 갖고, 내 버전은 옆에 `이름 (conflict 내이름 날짜 시각).md`로 남습니다. 이 사본도 동기화되므로 팀 전체가 충돌을 봅니다. 아무것도 덮어쓰지 않습니다.
- 누가 지운 파일을 내가 고치고 있었다면 내 파일은 남고 다시 올라갑니다.
- `.md`와 이미지(`png/jpg/gif/webp/svg/pdf`), `.canvas`만 동기화합니다. 점(`.`)으로 시작하는 폴더·파일(`.obsidian`, `.strata-sync`, 캐시)은 이 PC에만 있습니다. 파일 하나 최대 10MB.
- 프로토콜: `GET /v1/manifest?since=<seq>`, `GET/PUT/DELETE /v1/file?path=` — sha256 ETag와 `If-Match`로 충돌을 잡습니다. 자세한 건 `cloud/src/sync.ts`.

**Obsidian만 쓰는 팀원**: Remotely Save를 S3 호환 모드로 같은 R2 버킷에 연결하면 됩니다. 버킷에 직접 쓴 파일은 R2 이벤트 알림 → Queue → Worker가 해시를 계산해 색인에 넣습니다(작성자 `external`). 한 번만 설정:
```bash
npx wrangler queues create strata-vault-events
npx wrangler r2 bucket notification create strata-vault --event-type object-create --event-type object-delete --queue strata-vault-events
```

### 새벽 배치 (서버)
Worker의 Cron Trigger가 매일 04:00(Asia/Seoul)에 돕니다. 로컬 크론과 별개로, 팀 볼트 전체를 한 번만 처리합니다.

- **볼트 린트 리포트** — `graph_lint`와 같은 규칙을 팀 볼트에 돌려 `_reports/lint-YYYY-MM-DD.md`로 씁니다. 일반 문서처럼 동기화되고 위키링크가 있어 그래프에서 바로 보입니다. 클러스터 스냅샷은 R2 `_system/`에 보관(클라이언트엔 안 보임), 30일 지난 리포트는 자동 삭제.
- **임베딩** — 바뀐 문서만 Workers AI `@cf/baai/bge-m3`(1,024차원, 로컬 서버와 같은 모델)로 임베딩해 Vectorize에 넣습니다. 지운 문서의 벡터는 제거. AI/Vectorize 바인딩이 없으면 이 단계만 건너뜁니다.
- **시맨틱 검색** — `POST /v1/search {query, topK}`. 앱은 로컬 임베딩 인덱스가 없을 때 이 결과를 검색 2순위로 씁니다(BM25와 RRF 융합, 문서 id 체계가 같아 그대로 매핑).
- 수동 실행: `POST /v1/lint/run` (팀 토큰 필요).

임베딩을 켜려면:
```bash
npx wrangler vectorize create strata-vault-vectors --dimensions=1024 --metric=cosine
npx wrangler deploy
```

## 자동화 (크론)

Electron 메인 프로세스의 스케줄러(`electron/cronScheduler.cjs`, node-cron)가 두 가지 작업을 돌립니다.

| 작업 | 기본 스케줄 | 내용 |
|------|-------------|------|
| `daily-run` | 매일 04:00 (Asia/Seoul) | 편집 에이전트 → 볼트 리로드 → 벡터 재빌드 체인 |
| `health-check` | 5분마다 | 앱·봇 상태 점검 |

Settings → Cron 탭에서 스케줄 변경, 수동 실행, 실행 로그 확인이 가능합니다. Jira·Confluence 자동 동기화(Settings → Jira / Confluence)는 별도 주기로 돌며 결과를 볼트에 마크다운으로 씁니다.

## 봇 연동

### Slack Bot
```bash
cd bot && pip install -r requirements.txt && python bot.py
```
설정: [bot/SLACK_SETUP.md](bot/SLACK_SETUP.md)

### Telegram Bot
```bash
cd bot && export TELEGRAM_BOT_TOKEN="your-token" && python telegram_bot.py
```

| 커맨드 | 설명 |
|--------|------|
| `/ask [persona] 질문` | 페르소나 RAG 질의 |
| `/search 키워드` | 볼트 문서 검색 |
| `/debate 주제` | 멀티 페르소나 토론 |
| `/mirofish 주제` | MiroFish 시뮬레이션 |
| `/help` | 도움말 |

설정: [bot/TELEGRAM_SETUP.md](bot/TELEGRAM_SETUP.md)

---

## Backend & MCP Server

### Backend (FastAPI + ChromaDB)
```bash
cd backend && pip install -r requirements.txt && python main.py
```

### MCP Server
Claude Code / Cursor 등 외부 에이전트와 볼트를 연동합니다.
```bash
cd mcp && npm install && npm start
```

#### 볼트 린트 (`graph_lint`)
링크 그래프의 구조적 문제를 심각도와 함께 돌려주는 툴입니다. 에이전트가 문서를 만들거나 고치기 전에 호출하도록 설계했습니다.

| 규칙 | 잡는 것 |
|------|---------|
| `phantom-hot` | 여러 문서(기본 3개 이상)가 링크하는데 존재하지 않는 문서 — 참조 수 순위 = "만들어야 할 문서" 순위 |
| `bridge-spof` | 지우면 다른 문서들이 고립되는 문서(단절점), 그리고 링크 두 개로 두 토픽 클러스터를 잇는 문서 |
| `orphan` | 들어오는 링크도 나가는 링크도 없는 문서 (깨진 링크만 있는 경우 따로 표시) |
| `stale-hub` | PageRank 상위 10%인데 90일 이상 안 바뀐 문서 |
| `near-duplicate` | 코사인 유사도 0.92 이상인데 서로 링크가 없는 문서 쌍 |
| `cluster-drift` | 직전 실행의 토픽 클러스터가 이번엔 흩어진 경우 (`.strata-sync/lint-snapshot.json` 비교) |

토픽 클러스터는 연결 요소가 아니라 Louvain 커뮤니티로 계산합니다(`graph_clusters`, `graph_bridges`도 같은 기준). CLI로도 돌릴 수 있어 CI에 넣을 수 있습니다:
```bash
npm run lint:vault -- --vault <path> --format md --fail-on error
```

---

## 볼트 도구

`tools/` 디렉토리에 30개의 Python 유틸리티가 포함되어 있습니다.

| 도구 | 용도 |
|------|------|
| `audit_and_fix.py` | 품질 감사 및 자동 수정 |
| `enhance_wikilinks.py` | 위키링크 보강 |
| `inject_keywords.py` | 도메인 키워드 주입 |
| `strengthen_links.py` | 링크 빈도 강화 |
| `gen_index.py` | 인덱스 자동 생성 |
| `pdf_to_md.py` | PDF → Markdown |
| `docx_to_md.py` | DOCX → Markdown |
| `pptx_to_md.py` | PPTX → Markdown |
| `xlsx_to_md.py` | XLSX → Markdown |
| `split_large_docs.py` | 대용량 문서 분할 |
| `check_quality.py` | 문서 품질 검사 |
| `pipeline.py` | 전체 파이프라인 오케스트레이션 |

전체 목록: [tools/README.md](tools/README.md)

---

## 볼트 구조 가이드

### 권장 프런트매터
```yaml
---
speaker: prog_director
date: 2024-01-15
tags: [combat, balance, RPG]
type: design
---
```

### 위키링크와 이미지 임베드
```markdown
## Combat System
기본 공격 메커니즘은 [[Skill Tree]]와 연결됩니다.
밸런싱 원칙은 [[Game Design Principles]]를 따릅니다.
![[combat_flowchart.png]]
```

위키링크가 많을수록 BFS 탐색 범위가 넓어지고 AI 컨텍스트가 풍부해집니다.

### 스피커 ID

| ID | 역할 |
|----|------|
| `chief_director` | 수석 디렉터 |
| `art_director` | 아트 디렉터 |
| `plan_director` | 기획 디렉터 |
| `level_director` | 레벨 디렉터 |
| `prog_director` | 프로그래밍 디렉터 |

---

## LLM 설정

Settings 패널 → API 키 입력 → 페르소나별 모델 선택:

| 프로바이더 | 모델 | 이미지 |
|-----------|------|--------|
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-sonnet-4-5-20250514, claude-haiku-4-5-20251001 | O |
| OpenAI | gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini, o3, o3-mini, o4-mini | O |
| Google Gemini | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash | O |
| xAI Grok | grok-3, grok-3-mini, grok-3-fast | X |

페르소나별 독립 모델 할당 가능 — 각 디렉터가 서로 다른 프로바이더/모델 사용 가능.

---

## 프로젝트 구조

```
strata-sync/
+-- src/
|   +-- components/    # chat, editor, editAgent, fileTree, graph, layout, settings, shared
|   +-- lib/           # graphAnalysis, graphRAG, bm25WorkerClient, markdownParser ...
|   +-- services/      # llmClient, editAgentRunner, agentLoop, debateEngine, mirofish/ ...
|   +-- stores/        # Zustand 15개 스토어
|   +-- hooks/         # useVaultLoader, useRagApi, useGraphSimulation ...
|   +-- workers/       # bm25Worker, pprWorker
|   +-- __tests__/     # Vitest 테스트
+-- electron/          # Electron 메인 프로세스
+-- backend/           # FastAPI 백엔드
+-- bot/               # Slack + Telegram 봇
+-- mcp/               # MCP 서버
+-- tools/             # Python 볼트 유틸리티 30개
+-- docs/              # 기술 문서
+-- manual/            # 사용자 매뉴얼
```

---

## License

MIT License

> *"볼트에 문서가 많을수록 그래프는 깊어지고, AI가 탐색할 수 있는 범위는 넓어집니다."*

</details>

---

<details>
<summary><b>🇺🇸 English</b></summary>

## Overview

STRATA SYNC is a desktop application that reads an Obsidian-style markdown vault and builds a **wikilink-based knowledge graph**. Multiple AI director personas traverse the graph and deliver deep, contextual insights about your project.

```
Vault folder (.md files)
  ↓ Load + Parse
Knowledge Graph (WikiLink connections)
  ↓ directVaultSearch + BM25 + TF-IDF + Vector Embedding + BFS + PPR
Context collection
  ↓ Multi-Agent RAG (Chief + Worker LLMs)
Deep insights (streaming)
```

**Local mode** — runs without a backend server. BM25, TF-IDF and graph traversal execute on-device; vector embeddings use whichever is available: a local BGE-M3 server (offline) or the Gemini API.

**Team mode (in progress)** — syncing the vault to Cloudflare R2 and running embeddings, vault lint and reviews as a server batch so the whole team sees the same graph. See `docs/plan-team-vault-2026-09.html` for the plan.

---

## Key Features

### Knowledge Graph Visualization
- **2D Graph (SVG)**: Interactive graph powered by d3-force physics — default mode
- **2D Graph (Canvas)**: Fast Mode high-performance renderer for large vaults
- **3D Graph**: Three.js + d3-force-3d volumetric graph (InstancedMesh optimization, dirty-render budget system)
- **Obsidian-style node sizing**: Node size proportional to link count (√degree scale)
- **Node color modes**: By document type / speaker / folder / tags / topic cluster
- **Phantom nodes**: Wikilinks pointing to non-existent files still appear in the graph
- **Image nodes**: Images via `![[image.png]]` shown as diamond-shaped nodes
- **AI highlight**: Documents mentioned in AI responses auto-highlighted with pulse animation
- **Minimap**: Graph overview navigation
- **Node search**: Ctrl+F to search nodes
- **Vault comparison**: Side-by-side comparison of two vaults

### Graph-Augmented RAG
- **directVaultSearch**: Grep-style search for date-named files and exact title matches — runs before BM25
- **BM25 search**: BM25 probabilistic scoring in Web Worker, IndexedDB caching for instant restore
- **Synonym expansion**: Domain synonyms auto-applied (shared frontend/MCP)
- **Query coverage penalty**: Suppresses partial-match documents
- **Recency boost**: 6-month exponential decay for recent documents
- **Passage-level search**: Selects only the most relevant section per document
- **Link strength**: WikiLink reference count normalized to [0.15, 1.0]
- **Personalized PageRank (PPR)**: Strength-weighted random walker for document importance
- **Implicit link discovery**: Cosine similarity on BM25 weight vectors detects hidden connections
- **Cluster topic labels**: Frequency-based keyword extraction per cluster
- **Bridge node detection**: Identifies keystone documents connecting multiple clusters

### Vector Embedding Search
- **Automatic provider selection**: a local BGE-M3 server (`scripts/local_embed_server.py`, 1,024 dims, offline) is preferred when running; otherwise Google Gemini `gemini-embedding-001` (3,072 dims, API key required). A provider change triggers a full cache rebuild to avoid dimension mismatches
- **3-tier retrieval strategy**: Vector search → ChromaDB → BM25 fallback (auto-switches based on availability)
- **Hybrid reranking**: Weighted combination of BM25 score (40%) + cosine similarity (60%) for final ranking
- **Backend embeddings**: ChromaDB + `sentence-transformers/all-MiniLM-L6-v2` (384 dimensions, offline, no API key required)
- **Incremental cache**: per-section embeddings stored with mtimes in `.vector_cache_v6.json` inside the vault — editing one document re-embeds only that document; a chunker version change rebuilds everything
- **Background build**: Async embedding generation after vault load (20 items/batch)
- **Section-based chunking**: split on markdown headings, sections under 300 chars are merged with a neighbour (`src/lib/markdownParser.ts`)

### Multi-Agent RAG
- **Chief + Worker structure**: Key documents read in full (20K) by Chief LLM; secondary documents summarized in parallel by Worker LLM (200 chars each)
- **Auto Worker model selection**: Picks cheapest model from same provider
- **Parallel summarization**: Up to 5 documents via `Promise.all`
- **Fallback safety**: Worker failures fall back to first 300 chars
- **Toggle**: Enable/disable in Settings → AI tab

### Agentic Tool-Use
- **streamMessageWithTools**: Agent loop that autonomously uses file read/write, search tools
- **Domain classification**: Auto-classifies documents into narrative/character vs system/gameplay domains

### Context Compaction
- **Auto compression**: When chat history exceeds 20,000 chars, Worker LLM summarizes and injects into system prompt
- **Recent messages preserved**: Latest context always kept intact
- **Auto memory save**: Summaries saved to persistent memory — insights accumulate across sessions

### Edit Agent
- **Autonomous editing**: AI reads/modifies markdown per user instructions
- **Instant cache invalidation**: BM25 cache auto-cleared after file save
- **Auto quality check**: Runs `check_quality.py` after edits
- **Post-processing pipeline**: `inject_keywords.py → strengthen_links.py → enhance_wikilinks.py`
- **Token tracking**: Per-cycle LLM token usage logging

### Multiple LLM Personas
- 5 director personas (Chief / Art / Plan / Level / Prog)
- Providers: **Anthropic Claude**, **OpenAI GPT**, **Google Gemini**, **xAI Grok**
- Image attachment support (Anthropic, OpenAI, Gemini)
- Custom system prompts per persona

### Debate Mode
- Director personas debate topics (Round-Robin / Free Discussion / Role Assignment / Battle modes)
- Reference material attachment (text / image / PDF), real-time streaming

### Markdown Editor (CodeMirror 6)
- Obsidian-style `[[WikiLink]]` WYSIWYG rendering + autocomplete
- `~~strikethrough~~`, `==highlight==`, `%% comments %%` visual processing
- Shortcuts: `Ctrl+Shift+S` (strikethrough), `Ctrl+Shift+H` (highlight), `Ctrl+Shift+C` (inline code)
- Smart Enter: auto-increment numbered lists / continue blockquotes
- 3-second auto-save

### MiroFish Simulation
- Social graph-based AI persona simulation engine
- OASIS framework-based social media environment simulation
- Team dynamics analysis and report generation

### Web Search
- External web search to augment vault RAG
- LLM autonomously decides when web search is needed

### Chat Reports
- Auto-generate reports from conversations
- PDF / Markdown export

### File Tree
- Folder / speaker / tag classification views
- Sort by name or modification date
- Right-click context menu: Open in editor / Copy / Bookmark / Rename / Delete

---

## Tech Stack

| Area | Technology | Version |
|------|-----------|---------|
| UI | React + TypeScript | 19.x / 5.5 |
| Build | Vite | 5.4 |
| Styling | Tailwind CSS | 4.x |
| State | Zustand | 5.x |
| Animation | Framer Motion | 12.x |
| 2D Graph | d3-force | 3.x |
| 3D Graph | Three.js + d3-force-3d | 0.175 / 3.x |
| Editor | CodeMirror | 6.x |
| Desktop | Electron | 41.x |
| Backend | FastAPI + ChromaDB | - |
| Testing | Vitest + pytest | - |

---

## Core Algorithms

### 1. directVaultSearch (`src/lib/graphRAG.ts`)
Title-based search for date-named files that BM25 struggles with. Two-tier: Strong match (score >= 0.4) / Weak match.

### 2. BM25 Search (`src/workers/bm25Worker.ts`)
BM25 probabilistic scoring in Web Worker. IndexedDB caching for instant restore on vault re-open.

### 3. TF-IDF (`src/lib/graphAnalysis.ts`)
TF x IDF weighted document similarity. Cosine similarity used for implicit link detection.

### 4. Personalized PageRank (`src/workers/pprWorker.ts`)
Strength-weighted random walker. Core ranking algorithm in the main RAG pipeline.

### 5. BFS Graph Traversal (`src/lib/graphRAG.ts`)
Follows wikilinks up to N hops to collect related documents. Used for node-selection analysis.

### 6. Union-Find Cluster Detection (`src/lib/graphAnalysis.ts`)
Auto-clusters wikilink-connected document groups. Path compression for near-O(1) amortized complexity.

### 7. Vector Embedding (`src/lib/vectorEmbedIndex.ts`)
Gemini embeddings for semantic search and hybrid reranking. Combines BM25 keyword score (40%) with vector cosine similarity (60%).

---

## Multi-Agent RAG Architecture

```
User query
    |
    +-- directVaultSearch() <-- date/title direct search
    |       |
    |       +-- Strong match?
    |               +-- YES --> Chief LLM (full 20K) + Worker LLM x N (parallel summary)
    |               +-- NO  --> Vector/BM25 + TF-IDF path
    |
    +-- 3-tier retrieval (auto-switches by availability)
    |       |
    |       +-- Priority 1: Gemini vector search (when API key present)
    |       +-- Priority 2: ChromaDB semantic search (when backend running)
    |       +-- Priority 3: BM25 keyword search (always available)
    |
    +-- Hybrid reranking (BM25 40% + cosine similarity 60%)
            |
            +-- PPR (Personalized PageRank) document ranking
            +-- Domain classification (narrative vs system) → per-domain synthesis
            +-- Web search augmentation (optional)
```

### Worker Model Auto-selection

| Chief Provider | Worker Model |
|----------------|--------------|
| Anthropic | `claude-haiku-4-5-20251001` |
| OpenAI | `gpt-4.1-mini` |
| Google | `gemini-2.5-flash-lite` |
| xAI | `grok-3-mini` |

---

## System Architecture

```
FRONTEND (React 19 + TypeScript + Vite)
+-- Graph Visualization (D3-Force 2D/3D, Three.js)
+-- RAG Search (BM25 Worker + PPR + TF-IDF)
+-- Chat UI (5 Personas + Debate)
+-- Edit Agent (Autonomous editing)
+-- File Editor (CodeMirror + Markdown)
+-- Settings (18 tabs)
+-- State (Zustand stores x 15)

ELECTRON (v41)
+-- Main Process (IPC, File System, File Watch)
+-- RAG API HTTP (port 7331)
+-- strata-img:// protocol

BACKEND (FastAPI + ChromaDB)
+-- Document CRUD API
+-- RAG Service

BOTS
+-- Slack Bot (Socket Mode)
+-- Telegram Bot (Long Polling)

MCP SERVER (Node.js + TypeScript)
+-- Claude Code / Cursor integration
+-- Vault search + LLM calls

VAULT TOOLS (30 Python utilities)
+-- Format conversion (DOCX/PDF/PPTX/XLSX -> MD)
+-- Link strengthening + keyword injection
+-- Quality audits + index generation
```

---

## Installation & Setup

### Prerequisites
- Node.js 18+
- Python 3.10+ (for backend/bot/tools)

### Development
```bash
npm install
npm run electron:dev
```

### Production Build
```bash
npm run electron:build
```

### Backend
```bash
cd backend && pip install -r requirements.txt && python main.py
```

### Tests
```bash
npm test              # Frontend
cd backend && pytest  # Backend
cd bot && pytest      # Bot
```

---

## Usage Guide

### 1. Load a Vault
Launch app → "Open Vault" → select Obsidian vault folder → knowledge graph auto-generated

### 2. Explore the Graph
- **Drag**: Pan/rotate | **Scroll**: Zoom
- **Node click**: Select document | **Double-click**: Open in editor
- **Ctrl+F**: Search nodes | **Minimap**: Full graph navigation

### 3. AI Analysis
- **Node analysis**: Click node → "AI Analysis" → auto-explore related documents
- **Full vault analysis**: No selection → "Full AI Analysis" → hub-node-based overview

### 4. AI Chat
- Select persona from right panel, ask in natural language
- Auto image attachment: If selected doc has `![[...]]` images, they're sent automatically

---

## Team sync (Cloudflare)

Merges the vaults on several machines into one. The source of truth lives in Cloudflare R2; each machine's vault folder is a replica. The server is the Wrangler project in `cloud/`.

**Deploy the server once per team**
```bash
cd cloud && npm install
npx wrangler d1 create strata-sync-db          # paste the database_id into wrangler.toml
npx wrangler r2 bucket create strata-vault
npx wrangler secret put TEAM_TOKEN             # any long random string the team shares
npx wrangler d1 migrations apply strata-sync-db --remote
npx wrangler deploy                             # → https://strata-sync-cloud.<account>.workers.dev
```

**On each machine** open Settings → Vault → Team Sync, enter the server URL, the team token and your name, and turn it on. The token is encrypted with the OS keychain and stored on that machine only.

**How it behaves**
- Edits upload two seconds after you save; other people's changes are pulled every 30 seconds. Offline edits are queued and retried.
- If two people change the same file, the server version keeps the file name and yours is kept next to it as `name (conflict you date time).md`. The copy is synced too, so the whole team sees the disagreement. Nothing is overwritten.
- A file someone else deleted while you were editing it stays on your machine and is re-published.
- Only `.md`, images (`png/jpg/gif/webp/svg/pdf`) and `.canvas` are synced. Dot-folders and dot-files (`.obsidian`, `.strata-sync`, caches) stay local. One file is capped at 10 MB.
- Protocol: `GET /v1/manifest?since=<seq>`, `GET/PUT/DELETE /v1/file?path=` with sha256 ETags and `If-Match` preconditions. See `cloud/src/sync.ts`.

**Obsidian-only teammates**: point Remotely Save (S3-compatible mode) at the same R2 bucket. Files written straight into the bucket are picked up by R2 event notifications → Queue → Worker, which hashes and indexes them (author `external`). One-time setup:
```bash
npx wrangler queues create strata-vault-events
npx wrangler r2 bucket notification create strata-vault --event-type object-create --event-type object-delete --queue strata-vault-events
```

### Nightly batch (server)
A Cron Trigger runs in the Worker at 04:00 Asia/Seoul, once for the whole team vault (independent of the local cron).

- **Vault lint report** — the `graph_lint` rules run over the team vault and the result is written to `_reports/lint-YYYY-MM-DD.md`. It syncs like any document and carries wikilinks, so it shows up in the graph. Cluster snapshots live in R2 under `_system/` (invisible to clients); reports older than 30 days are removed.
- **Embeddings** — only changed documents are embedded with Workers AI `@cf/baai/bge-m3` (1,024 dims, same model as the local server) into Vectorize; vectors of deleted documents are dropped. Without the AI/Vectorize bindings this step is skipped.
- **Semantic search** — `POST /v1/search {query, topK}`. The app uses it as its second search tier when no local embedding index exists (RRF-fused with BM25; document ids match, so hits map straight onto loaded documents).
- Manual run: `POST /v1/lint/run` (team token).

To enable embeddings:
```bash
npx wrangler vectorize create strata-vault-vectors --dimensions=1024 --metric=cosine
npx wrangler deploy
```

## Automation (cron)

The scheduler in the Electron main process (`electron/cronScheduler.cjs`, node-cron) runs two jobs.

| Job | Default schedule | What it does |
|-----|------------------|--------------|
| `daily-run` | daily at 04:00 (Asia/Seoul) | edit agent → vault reload → vector rebuild chain |
| `health-check` | every 5 minutes | app / bot health probe |

Settings → Cron lets you change schedules, trigger runs manually and read run logs. Jira and Confluence auto-sync (Settings → Jira / Confluence) run on their own interval and write results into the vault as markdown.

## Bot Integration

### Slack Bot
```bash
cd bot && pip install -r requirements.txt && python bot.py
```
Setup: [bot/SLACK_SETUP.md](bot/SLACK_SETUP.md)

### Telegram Bot
```bash
cd bot && export TELEGRAM_BOT_TOKEN="your-token" && python telegram_bot.py
```

| Command | Description |
|---------|-------------|
| `/ask [persona] question` | Persona RAG query |
| `/search keyword` | Vault document search |
| `/debate topic` | Multi-persona debate |
| `/mirofish topic` | MiroFish simulation |
| `/help` | Help |

Setup: [bot/TELEGRAM_SETUP.md](bot/TELEGRAM_SETUP.md)

---

## Backend & MCP Server

### Backend (FastAPI + ChromaDB)
```bash
cd backend && pip install -r requirements.txt && python main.py
```

### MCP Server
Connects external agents (Claude Code / Cursor) to your vault.
```bash
cd mcp && npm install && npm start
```

#### Vault lint (`graph_lint`)
Returns structural problems in the link graph with a severity. Designed to be called by an agent before it creates or edits documents.

| Rule | What it catches |
|------|-----------------|
| `phantom-hot` | A document that does not exist but is linked from several (default ≥3) documents — ranked by referrers, i.e. "what to write next" |
| `bridge-spof` | Documents whose removal strands others (cut vertices), plus two-link documents joining two topic clusters |
| `orphan` | No links in or out (broken-links-only is reported separately) |
| `stale-hub` | Top-10% PageRank documents untouched for 90+ days |
| `near-duplicate` | Pairs with cosine similarity ≥ 0.92 that do not link each other |
| `cluster-drift` | Topic clusters from the previous run that dissolved (compares `.strata-sync/lint-snapshot.json`) |

Topic clusters are Louvain communities, not connected components (`graph_clusters` and `graph_bridges` use the same). The CLI form runs in CI:
```bash
npm run lint:vault -- --vault <path> --format md --fail-on error
```

---

## Vault Tools

30 Python utilities in `tools/`:

| Tool | Purpose |
|------|---------|
| `audit_and_fix.py` | Quality audit and auto-fix |
| `enhance_wikilinks.py` | WikiLink enrichment |
| `inject_keywords.py` | Domain keyword injection |
| `strengthen_links.py` | Link frequency boost |
| `gen_index.py` | Auto index generation |
| `pdf_to_md.py` | PDF → Markdown |
| `docx_to_md.py` | DOCX → Markdown |
| `pptx_to_md.py` | PPTX → Markdown |
| `xlsx_to_md.py` | XLSX → Markdown |
| `split_large_docs.py` | Large document splitting |
| `check_quality.py` | Document quality check |
| `pipeline.py` | Full pipeline orchestration |

Full list: [tools/README.md](tools/README.md)

---

## Vault Structure Guide

### Recommended Frontmatter
```yaml
---
speaker: prog_director
date: 2024-01-15
tags: [combat, balance, RPG]
type: design
---
```

### Wikilinks and Image Embeds
```markdown
## Combat System
The basic attack mechanism connects to [[Skill Tree]].
Balancing principles follow [[Game Design Principles]].
![[combat_flowchart.png]]
```

More wikilinks = wider BFS traversal = richer AI context.

### Speaker IDs

| ID | Role |
|----|------|
| `chief_director` | Chief Director |
| `art_director` | Art Director |
| `plan_director` | Plan Director |
| `level_director` | Level Director |
| `prog_director` | Programming Director |

---

## LLM Configuration

Settings panel → enter API keys → select model per persona:

| Provider | Models | Image |
|----------|--------|-------|
| Anthropic | claude-opus-4-6, claude-sonnet-4-6, claude-sonnet-4-5-20250514, claude-haiku-4-5-20251001 | Yes |
| OpenAI | gpt-4.1, gpt-4.1-mini, gpt-4.1-nano, gpt-4o, gpt-4o-mini, o3, o3-mini, o4-mini | Yes |
| Google Gemini | gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash | Yes |
| xAI Grok | grok-3, grok-3-mini, grok-3-fast | No |

Independent model assignment per persona — each director can use a different provider/model.

---

## Project Structure

```
strata-sync/
+-- src/
|   +-- components/    # chat, editor, editAgent, fileTree, graph, layout, settings, shared
|   +-- lib/           # graphAnalysis, graphRAG, bm25WorkerClient, markdownParser ...
|   +-- services/      # llmClient, editAgentRunner, agentLoop, debateEngine, mirofish/ ...
|   +-- stores/        # 15 Zustand stores
|   +-- hooks/         # useVaultLoader, useRagApi, useGraphSimulation ...
|   +-- workers/       # bm25Worker, pprWorker
|   +-- __tests__/     # Vitest tests
+-- electron/          # Electron main process
+-- backend/           # FastAPI backend
+-- bot/               # Slack + Telegram bots
+-- mcp/               # MCP server
+-- tools/             # 30 Python vault utilities
+-- docs/              # Technical documentation
+-- manual/            # User manual
```

---

## License

MIT License

> *"The more documents in the vault, the deeper the graph — and the wider the AI can explore."*

</details>
