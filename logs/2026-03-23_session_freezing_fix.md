# 세션 로그 — 2026-03-23 (UI 프리징 수정)

**작업자**: Claude Sonnet 4.6 (AI)
**날짜**: 2026-03-23

---

## 프리징 원인 분석 (전체 코드리뷰)

### CRITICAL
| # | 파일 | 위치 | 원인 | 영향 |
|---|------|------|------|------|
| 1 | `graphRAG.ts` | `buildDeepGraphContext` | PPR 15회 iteration + PageRank + 클러스터 계산이 메인 스레드에서 동기 실행 | AI 응답 전 100ms+ UI 블로킹 |
| 2 | `chatStore.ts` | `appendChunk` | SSE 청크마다 Zustand setState → 초당 50~100회 React 리렌더링 | 스트리밍 중 프리징 |
| 3 | `MessageBubble.tsx` | `renderedContent` | 스트리밍 중 매 청크마다 ReactMarkdown 전체 재파싱 | 응답 길이 비례 가속 프리징 |

### HIGH
| # | 파일 | 위치 | 원인 | 영향 |
|---|------|------|------|------|
| 4 | `Graph2D.tsx` | `useGraphStore()` | 셀렉터 없이 전체 구독 → graphStore 어떤 필드 변경에도 리렌더 | 그래프 상호작용 중 불필요한 리렌더 |
| 5 | `Graph3D.tsx` | `useGraphStore()` | 동일 | 동일 |

### MEDIUM
| # | 파일 | 위치 | 원인 | 영향 |
|---|------|------|------|------|
| 6 | `main.cjs` | `readImageAsDataUrl` | `fs.readFileSync` 동기 파일 읽기 | 이미지 로드 시 Electron 메인 프로세스 블로킹 |

---

## 적용된 수정 사항

### 1회차 수정 (appendChunk + MessageBubble)

#### `src/stores/chatStore.ts`
- 모듈 레벨 `_pendingChunks` Map + `_scheduleFlush()` 추가
- `appendChunk`: 매 청크 setState 대신 버퍼에 누적 → 50ms마다 일괄 적용
- `finishStreaming`: 남은 버퍼를 즉시 flush 후 `streaming: false` 처리

#### `src/components/chat/MessageBubble.tsx`
- `message.streaming === true` 동안: `<div style="white-space: pre-wrap">` plain text 렌더링
- `streaming: false` 전환 시: ReactMarkdown 1회만 파싱

### 2회차 수정 (PPR async + useShallow + readImageAsDataUrl)

#### `src/lib/graphRAG.ts`
- `buildDeepGraphContext` → `async function` (반환 타입 `Promise<string>`)
  - PPR 실행 전 `await new Promise(r => setTimeout(r, 0))` — 이벤트 루프 양보
  - `buildStructureHeader` 실행 전 추가 yield
- `buildDeepGraphContextFromDocId` → `async function`
  - `buildStructureHeader` 전 yield
- `buildGlobalGraphContext` → `async function`
  - `buildStructureHeader` 전 yield

#### `src/services/llmClient.ts`
- `buildGlobalGraphContext(35, 4)` → `await buildGlobalGraphContext(35, 4)`
- `buildDeepGraphContext(bfsSeeds, ...)` → `await buildDeepGraphContext(bfsSeeds, ...)`
- `buildDeepGraphContext(seeds, ...)` → `await buildDeepGraphContext(seeds, ...)`

#### `src/components/graph/GraphPanel.tsx`
- `buildDeepGraphContextFromDocId(selectedNodeId)` → `await ...`
- `buildGlobalGraphContext(35, 4)` → `await ...`

#### `src/components/graph/Graph2D.tsx`
- `useShallow` import 추가 (`zustand/react/shallow`)
- `useGraphStore()` → `useGraphStore(useShallow(s => ({ ...12개 필드... })))`
  - 선택한 필드만 shallow 비교 → 관련 없는 store 변경 시 리렌더 방지

#### `src/components/graph/Graph3D.tsx`
- 동일하게 `useShallow` 적용 (13개 필드)

#### `electron/main.cjs`
- `readImageAsDataUrl`: `fs.readFileSync` → `await fs.promises.readFile`
  - IPC 핸들러(`vault:read-image`, `vault:find-image-by-name`)가 이미 async이므로 호환

---

## 효과 예상

| 수정 | 예상 개선 |
|------|----------|
| PPR async yield | AI 응답 전 로딩 인디케이터 표시, 100ms+ 블로킹 체감 감소 |
| appendChunk 50ms 배치 | 스트리밍 중 setState 횟수 ~95% 감소 (100/s → 20/s) |
| MessageBubble plain text | 스트리밍 중 ReactMarkdown 재파싱 비용 제거 |
| useShallow Graph2D/3D | simPositions 등 무관한 graphStore 변경으로 인한 리렌더 차단 |
| readImageAsDataUrl async | 대형 이미지 로드 시 메인 프로세스 비응답 해소 |

---

### 3회차 수정 (appendThinkingChunk + getClusterTopics 캐시 + buildStructureHeader async)

#### `src/stores/chatStore.ts`
- `_pendingThinkingChunks` Map 추가
- `_scheduleFlush`: content + thinking 두 버퍼를 동시에 처리하도록 확장
- `appendThinkingChunk`: 직접 `set()` → 버퍼 누적 + `_scheduleFlush()` (50ms 배치)
- `finishStreaming`: thinking 버퍼도 즉시 flush 처리

#### `src/lib/graphAnalysis.ts`
- `getClusterTopics` 앞에 모듈 레벨 캐시 변수 3개 추가
  - `_cachedClusterTopicsResult`, `_cachedClusterTopicsClusters`, `_cachedClusterTopicsTopK`
- `clusters` Map 참조 + `topK` 동일 시 재계산 없이 캐시 반환
- `_cachedMetrics` 덕분에 쿼리 횟수와 무관하게 첫 번째 호출 이후 O(1)

#### `src/lib/graphRAG.ts`
- `buildStructureHeader`: `function` → `async function` (반환 `Promise<string>`)
  - `getClusterTopics` 호출 전 `await new Promise(r => setTimeout(r, 0))` 추가
  - `findImplicitLinks` 호출 전 `await new Promise(r => setTimeout(r, 0))` 추가
- 3곳의 `buildStructureHeader(...)` 호출을 모두 `await buildStructureHeader(...)` 로 변경

---

## 효과 예상 (3회차 추가분)

| 수정 | 예상 개선 |
|------|----------|
| `appendThinkingChunk` 배치 | thinking 청크도 50ms 배치, thinking 스트리밍 중 리렌더 횟수 ~95% 감소 |
| `getClusterTopics` 캐시 | 동일 볼트 상태 유지 시 200-400ms → O(1) |
| `buildStructureHeader` async yield | getClusterTopics/findImplicitLinks 전 이벤트 루프 양보 → 로딩 인디케이터 유지 |

---

## 잔존 성능 이슈 (미수정)

| 항목 | 내용 | 완전 해결책 |
|------|------|------------|
| `hoveredNodeId` 리렌더 | 마우스 호버 시마다 Graph2D 리렌더 | hover 로직을 완전 imperative (ref 기반)으로 분리 |
| `findImplicitLinks` 첫 호출 | TF-IDF O(N²) cache miss 시 500-800ms | 별도 Worker로 이동 |
