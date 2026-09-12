# Strata Sync — Claude Code 지침

## MCP 풀 컨트롤 모드

이 프로젝트에는 **strata-sync MCP 서버**가 등록되어 있습니다 (`.mcp.json`).
MCP 서버가 연결되면 GUI의 API 키를 사용하지 않고, 모든 작업을 MCP 도구로 수행합니다.

### 빠른 시작
1. `vault_reload` — 볼트 로드 (검색/그래프 도구 사용 전 필수)
2. `search_bm25` — 문서 검색
3. `chat_persona` — 페르소나 채팅 (RAG 자동 적용)
4. `graph_stats` → `graph_pagerank` — 볼트 구조 파악

### MCP 설정
- 설정 파일: `mcp-config.json` (API 키, 볼트 경로, 프로젝트 정보)
- `settings_get` / `settings_update` 도구로 런타임 변경 가능

### 프롬프트 주입
MCP 게이트 프롬프트(`strata-sync-gate`)가 연결 시 사용 가능합니다.
도구 목록과 사용 원칙이 포함되어 있으니 `prompts/get`으로 확인하세요.

## 개발 환경

### 빠른 시작
- `npm run dev` — Vite 개발 서버
- `npm run build` — TypeScript 컴파일 + Vite 프로덕션 빌드
- `npm run preview` — 빌드 결과 미리보기
- `npm test` 또는 `npx vitest run` — 전체 테스트
- `npm run test:watch` — 테스트 워치 모드
- `npm run test:coverage` — 커버리지 포함 테스트
- `npx vitest run src/__tests__/특정파일.test.ts` — 개별 테스트

### Electron
- `npm run electron:dev` — Electron 개발 모드 (Vite + Electron 동시 실행)
- `npm run electron:build` — Electron 배포 빌드
- 메인 프로세스: `electron/main.cjs`
- 프리로드: `electron/preload.cjs`

### Slack 봇
- `cd bot && python bot.py` — 봇 실행
- 설정: `bot/config.json`
- 환경 변수: `bot/.env` (gitignore됨)

### MCP 서버
- `cd mcp && npm start` — MCP 서버 실행
- `cd mcp && npm run dev` — TypeScript 워치 모드
- 설정: `mcp-config.json` (gitignore됨, example 참고)

## 코딩 컨벤션
- TypeScript strict mode, 세미콜론 없음
- Zustand 상태 관리, React 함수형 컴포넌트
- 한국어 주석 허용, 커밋 메시지는 한국어
- 테스트: Vitest + @testing-library/react
