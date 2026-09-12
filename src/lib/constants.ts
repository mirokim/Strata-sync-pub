/**
 * constants.ts — 프로젝트 전역 상수
 *
 * 여러 파일에 흩어져 있던 하드코딩된 값들을 한 곳에서 관리합니다.
 */

// ── Vault / 파일 시스템 ────────────────────────────────────────────────────────

/** 볼트 내 페르소나 설정 파일 경로 (볼트 루트 기준) */
export const PERSONA_CONFIG_PATH = '.rembrandt/personas.md'

// ── 채팅 / 파일 업로드 ────────────────────────────────────────────────────────

/** 멀티 페르소나 동시 스트리밍 시 페르소나별 시작 지연 (ms) */
export const STREAM_STAGGER_MS = 100

/** 채팅 첨부파일 / 토론 참고자료 업로드 최대 크기 (10 MB) */
export const MAX_FILE_SIZE = 10 * 1024 * 1024

// ── 그래프 ────────────────────────────────────────────────────────────────────

/** 위키링크로 생성되는 그래프 엣지의 기본 강도 */
export const DEFAULT_LINK_STRENGTH = 0.5

/** 노드 레이블 겹침 방지 최소 화면 픽셀 간격 (Graph2D / Graph2DCanvas 공유) */
export const LABEL_MIN_GAP = 64

/** fit-to-view 시 사용하는 뷰포트 패딩 픽셀 (Graph2D / Graph2DCanvas 공유) */
export const GRAPH_VIEW_PADDING = 48

// ── TF-IDF / 그래프 분석 ──────────────────────────────────────────────────────

/** 암묵적 링크 계산 시 O(N²) 폭발 방지를 위한 최대 문서 수 */
export const TFIDF_MAX_DOCS = 250

// ── LLM / 토큰 ───────────────────────────────────────────────────────────────

/** Edit Agent / Chat 도구 루프 1회 LLM 호출 최대 출력 토큰 */
export const AGENT_MAX_OUTPUT_TOKENS = 8096

/** RAG 컨텍스트 문자열 최대 길이 (글자 수) */
export const RAG_CONTEXT_MAX_CHARS = 10000

/** 텍스트 첨부파일 컨텍스트 최대 길이 (글자 수) */
export const TEXT_ATTACH_MAX_CHARS = 12000

/** Edit Agent 파일 1개당 최대 처리 글자 수 */
export const EDIT_AGENT_MAX_FILE_CHARS = 12000

// ── UI 타이머 ─────────────────────────────────────────────────────────────────

/** 볼트 변경 감지 배지 자동 닫기 시간 (ms) */
export const WATCH_DIFF_AUTO_CLOSE_MS = 8000

// ── 백엔드 / 서버 ─────────────────────────────────────────────────────────────

/** Python 백엔드 기본 포트 */
export const BACKEND_DEFAULT_PORT = 8765
