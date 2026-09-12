# 프로젝트 완성도 개선 계획

> 작성일: 2026-04-01
> 코드베이스 전체 분석 (203 TSX/TS 파일, 31 테스트 파일) 기반

---

## 1. 에러 핸들링 — 사용자가 실패를 모르는 곳들

### 높은 심각도

**FileTree.tsx** — 6개 파일 조작 핸들러(rename/delete/move/create)가 `console.error()`만 하고 사용자에게 피드백 없음.
```typescript
// 현재: 사용자는 실패를 모름
catch (e) { console.error('[FileTree] action failed:', e) }

// 개선: Toast 알림
catch (e) { useToastStore.getState().addToast(`파일 작업 실패: ${e}`, 'error') }
```

**영향 파일**: `src/components/fileTree/FileTree.tsx` (lines 235, 269, 289, 308, 343, 371)

**MarkdownEditor.tsx** — 파일 저장/이름변경 실패 시 동일 문제.

**VaultTabs.tsx** (line 59) — `.catch()`가 경고만 로깅, UI 상태 미갱신.

**chatStore.ts** (lines 180-190) — 스트리밍 에러 시 `isLoading: true`가 영구 지속될 수 있음.

---

## 2. 테스트 커버리지 — 핵심 서비스 미테스트

### 테스트 없는 주요 서비스

| 서비스 | 위험도 | 이유 |
|--------|--------|------|
| `confluenceApi.ts` | 높음 | 8개 공개 함수, Confluence 동기화 핵심 |
| `debateEngine.ts` | 높음 | 멀티 에이전트 오케스트레이션 — 미묘한 버그 가능 |
| `editAgentRunner.ts` | 높음 | `needsRefinement()` 휴리스틱 미테스트 |
| `mirofish/*.ts` (3개) | 중간 | 시뮬레이션/리포트/페르소나 생성 로직 |

### 테스트 없는 주요 컴포넌트

- 설정 탭 전체 (`JiraTab`, `SlackBotTab`, `VectorEmbedTab` 등) — `SettingsPanel.test.tsx`만 존재
- `ConfluenceImporter.tsx` — 복잡한 임포트 워크플로우
- Graph3D 고급 기능 — WebGL 컨텍스트 복구, 드래그앤드롭, 팬텀 노드

### 엣지 케이스 미테스트

- 마크다운 파서: frontmatter에 특수문자, 순환 위키링크, `#` 앵커 포함 위키링크
- 스트리밍: 네트워크 중단 후 재시도, 동시 페르소나 스트리밍 충돌

---

## 3. 성능 — 메모리와 렌더링

### 이미지 캐시 메모리 누수 (중간)

`vaultStore.ts`의 `imageDataCache`에 50MB 캡이 있지만, LRU 정책 없이 FIFO 삭제. 대형 볼트에서 메모리 압박 가능.

**개선안**: LRU 캐시로 교체 (최근 접근 순 유지, 50개 엔트리 제한).

### 채팅 배열 복사 (낮음)

`chatStore.ts`에서 매 메시지 추가 시 `.slice()`로 전체 배열 복사. 100+ 메시지에서 비효율.

**개선안**: `immer` 사용 또는 불변 업데이트 패턴으로 타겟 수정.

### 모듈 레벨 타이머 정리 (낮음)

`chatStore.ts`의 `_flushTimer` — 앱 언마운트 시 정리 보장 안 됨. Electron이라 영향 적지만 clean shutdown에 필요.

---

## 4. 접근성 (A11y)

### ARIA 레이블 누락

**FileTree.tsx** — 6개 아이콘 버튼(정렬, 태그, 폴더 생성, 파일 생성)에 `aria-label` 없음.
```typescript
// 현재
<button onClick={...}><SortAsc size={14} /></button>

// 개선
<button onClick={...} aria-label="이름 오름차순 정렬"><SortAsc size={14} /></button>
```

**Graph3D.tsx** — 인터랙티브 캔버스에 폴백 텍스트 없음.
```typescript
// 개선: 캔버스 전에 스크린 리더용 설명 추가
<div role="img" aria-label={`지식 그래프: ${nodes.length}개 노드, ${links.length}개 링크`}>
```

### 키보드 내비게이션

- `FileTree.tsx`의 FolderPickerModal — 화살표 키 내비게이션 미지원, `tabIndex` 누락
- `ChatInput.tsx` — Send 버튼 Tab+Enter 접근 확인 필요

---

## 5. 보안

### 파일 경로 인젝션 (중간)

`FileTree.tsx`에서 `prompt()`로 입력받은 파일명을 검증 없이 경로에 결합:
```typescript
const destPath = `${dir}${sep}${copyFilename}`  // ../../../ 가능
```

**수정**:
```typescript
const SAFE_FILENAME = /^[^\/\\:*?"<>|]+$/
if (!SAFE_FILENAME.test(copyFilename)) { alert('유효하지 않은 파일명'); return }
```

### API 키 저장 (허용된 위험)

`settingsStore.ts`에서 API 키가 `localStorage`에 저장됨. Electron 앱이라 허용 범위이나, 웹 배포 시 XSS 취약. 웹 배포 계획이 있다면 `safeStorage` API로 마이그레이션 필요.

---

## 6. 코드 중복 — 추출 가능한 패턴

### 에러 로깅 패턴 (8회 반복)
```typescript
// FileTree.tsx에서 8번 반복
catch (e) { console.error('[FileTree] 작업 실패:', e) }
```
**수정**: `handleFileOp(label, fn)` 유틸 추출 — 에러 시 Toast + 로깅 일괄 처리.

### Vault API null 체크 (다수 파일)
```typescript
if (!window.vaultAPI) return
if (!vaultPath || !window.vaultAPI) return
```
**수정**: `useVaultAPI()` 커스텀 훅으로 통합 — null이면 noop 반환.

### 파일 경로 정규화 (3+ 위치)
`markdownParser.ts`, `FileTree.tsx` 등에서 인라인으로 경로 정규화 반복.
**수정**: `normalizePath(p: string): string` 유틸 추출.

---

## 7. 긍정적 발견 (잘 되어 있는 것)

- `any` 캐스트 없음
- `dangerouslySetInnerHTML` 사용 없음 (ReactMarkdown으로 안전 렌더링)
- 스트리밍 50ms 배치 버퍼링 — 리렌더링 최적화 우수
- Graph3D 이벤트 리스너 정리 — 포괄적 cleanup
- Dev 환경에서만 debug 로그 — 프로덕션 로그 스팸 방지
- 쿼리 확장 타임아웃 + 폴백 — 우아한 성능 저하

---

## 우선순위 로드맵

| 순서 | 항목 | 심각도 | 작업량 | 카테고리 |
|------|------|--------|--------|----------|
| 1 | FileTree/Editor 에러 핸들링 → Toast | 높음 | 소 | UX |
| 2 | 파일 경로 인젝션 검증 | 중간 | 소 | 보안 |
| 3 | confluenceApi + debateEngine 테스트 | 높음 | 중 | 안정성 |
| 4 | 이미지 캐시 LRU 교체 | 중간 | 소 | 성능 |
| 5 | ARIA 레이블 + 키보드 내비게이션 | 중간 | 소 | 접근성 |
| 6 | 에러 로깅/vaultAPI 중복 추출 | 낮음 | 소 | 유지보수 |
| 7 | editAgentRunner + mirofish 테스트 | 중간 | 중 | 안정성 |
| 8 | 채팅 배열 최적화 (immer) | 낮음 | 소 | 성능 |
