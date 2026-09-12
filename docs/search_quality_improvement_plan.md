# 검색 품질 개선 계획

> 작성일: 2026-04-01
> 현재 파이프라인 분석 후 도출한 개선안 (효과순 정렬)

---

## 현재 검색 파이프라인 요약

```
사용자 쿼리
  ├─ directVaultSearch (문자열 grep 매칭, 파일명 60% + 본문 40%)
  ├─ TF-IDF 코사인 유사도 (graphAnalysis.ts tfidfIndex)
  ├─ Gemini 벡터 임베딩 fullVectorSearch (문서 단위 3072차원)
  ├─ BM25 보완 (벡터 미매칭 키워드 문서 추가, 0.4 가중)
  ├─ LLM 리랭킹 (선택, Haiku로 후보 재평가)
  ├─ PPR 그래프 탐색 (WikiLink 기반 Personalized PageRank)
  ├─ 패시지-레벨 섹션 선택 (쿼리 토큰 매칭 기반)
  └─ Worker 에이전트 요약 (3개+ 문서 시 병렬 200자 압축)
```

**듀얼 트랙**: 내부 문서 80% + 외부 게임 레퍼런스(type: external-reference) 20% 분리 검색

---

## 높은 효과 (바로 적용 가능)

### 1. 섹션 단위 벡터 임베딩 ⭐ 최우선

**현재 문제**: `vectorEmbedIndex.ts`의 `docText()` 함수가 문서 전체(최대 3000자)를 하나의 벡터로 임베딩. 긴 문서에서 관련 없는 섹션들이 벡터를 희석시켜 정밀도가 떨어짐.

**개선안**: 섹션(heading) 단위로 임베딩 → 검색 시 섹션 벡터와 쿼리 벡터 비교.

**구현 포인트**:
- `embeddings` Map 키를 `docId` → `sectionId`로 변경
- `docText()` → `sectionText(section, doc)` 으로 분리
- IndexedDB 캐시 스키마 업데이트 (마이그레이션)
- `fullVectorSearch`에서 섹션 스코어를 문서 단위로 집계 (max 또는 weighted avg)
- 임베딩 수 증가에 따른 API 비용 관리: 3개 이하 섹션 문서는 기존 문서 단위 유지

**예상 효과**: 긴 게임 레퍼런스 문서(나무위키 임포트 등)에서 관련 섹션만 정확히 찾아줌. 체감 정밀도 30~50% 향상 예상.

**영향 파일**:
- `src/lib/vectorEmbedIndex.ts` — 핵심 변경
- `src/lib/vectorEmbedCache.ts` — 캐시 스키마
- `src/hooks/useRagApi.ts` — 검색 결과 처리
- `src/hooks/useVaultLoader.ts` — 빌드 트리거

---

### 2. 동의어 테이블 확장 + 자동화

**현재 문제**: `synonyms.ts`에 약 20개 수동 매핑만 존재. 볼트에서 사용하는 용어(예: "점령전" ↔ "영토 장악", "DPS" ↔ "딜러")가 누락되면 검색 실패.

**개선안 A — 볼트 기반 자동 추출**:
- 볼트 로드 시 TF-IDF 공동출현(co-occurrence) 분석
- 같은 문서/섹션에서 자주 함께 등장하는 용어 쌍을 동의어 후보로 추출
- UI에서 확인/편집 가능하게 제공

**개선안 B — 임베딩 기반 유사 용어**:
- 이미 구축된 Gemini 임베딩으로 단어 벡터 유사도 계산
- 코사인 유사도 0.85+ 용어 쌍을 자동 동의어로 등록

**구현 포인트**:
- `synonyms.ts`의 `SYNONYM_MAP`을 정적 → 동적 병합 (기본 + 볼트 파생)
- 볼트 로드 후 백그라운드에서 co-occurrence 분석 (Web Worker)
- 설정 탭에서 자동 생성된 동의어 확인/삭제 UI

**영향 파일**:
- `src/lib/synonyms.ts` — 동적 확장 로직
- `src/lib/graphAnalysis.ts` — co-occurrence 분석 추가
- `src/components/settings/tabs/VectorEmbedTab.tsx` — UI

---

### 3. 태그/frontmatter 기반 스코어링 강화

**현재 문제**: `type`, `tags`, `related` 등 풍부한 메타데이터가 있지만 검색 스코어링에 `speaker` 태그 부스트(+10%)만 적용. 나머지 메타데이터는 사전 필터링에만 사용.

**개선안**:
- 쿼리에서 도메인 키워드 감지 → 해당 `type`/`tags` 문서 부스팅
  - "밸런스" → `tags: [balance, design]` 문서 +20%
  - "캐릭터 설정" → `type: spec`, `tags: [character]` 문서 +20%
- `related:` frontmatter의 문서를 BFS 시드에 자동 추가
- `status: active` 문서를 outdated/deprecated보다 강하게 우선

**구현 포인트**:
- `graphRAG.ts`의 `rerankResults`에 태그 매칭 로직 확장
- 도메인 → 태그 매핑 테이블 추가 (synonyms.ts와 유사 구조)
- `fetchRAGContext`에서 `related:` 링크를 BFS 시드에 병합

**영향 파일**:
- `src/lib/graphRAG.ts` — rerankResults, fetchRAGContext
- `src/lib/synonyms.ts` 또는 새 `tagMapping.ts`

---

## 중간 효과

### 4. 쿼리-섹션 Cross-Attention 리랭킹

**현재 문제**: `rerankResults`가 단순 키워드 오버랩(문자열 includes) 기반. "전투 밸런스가 너무 쉽다"와 "난이도 조절 필요" 사이의 의미적 연결을 놓침.

**개선안**: 쿼리 임베딩 ↔ 각 후보 섹션 임베딩의 코사인 유사도로 리랭킹.
- 1번(섹션 단위 임베딩) 완료 후 자연스럽게 적용 가능
- 추가 API 호출 1회(쿼리 임베딩)만 필요 — 섹션 임베딩은 이미 캐시됨

**영향 파일**:
- `src/lib/graphRAG.ts` — rerankResults
- `src/lib/vectorEmbedIndex.ts` — 섹션 임베딩 조회 API

---

### 5. 대화 히스토리 기반 쿼리 보강

**현재 문제**: `fetchRAGContext`가 현재 메시지만 보고 검색. "그거 더 자세히", "아까 그 게임 비교해줘" 같은 후속 질문에서 맥락을 잃음.

**개선안**:
- 직전 2~3턴의 user 메시지에서 핵심 명사/키워드를 추출
- 현재 쿼리에 보이지 않게 append하여 검색 (사용자에게는 표시 안 됨)
- 대명사/지시어 감지 ("그거", "아까", "위에서 말한") 시에만 활성화

**구현 포인트**:
- `llmClient.ts`의 `streamMessage`에서 history 최근 3턴 키워드 추출
- `fetchRAGContext`에 `contextTerms?: string[]` 파라미터 추가
- 추출된 키워드를 검색 쿼리에 낮은 가중치(0.3)로 병합

**영향 파일**:
- `src/services/llmClient.ts` — streamMessage, fetchRAGContext 호출부
- `src/lib/graphRAG.ts` — directVaultSearch, frontendKeywordSearch에 contextTerms 반영

---

### 6. Reciprocal Rank Fusion (RRF)

**현재 문제**: 벡터 + BM25 합산이 단순 가중 합산(`0.4 * BM25 + 0.6 * vector`). 스코어 분포가 다른 두 시스템의 점수를 직접 합산하면 한쪽이 지배적이 될 수 있음.

**개선안**: RRF 공식 적용 — `score = Σ 1/(k + rank_i)` (k=60 표준)
- 각 검색 시스템의 순위만 사용, 절대 점수에 무관
- 두 시스템에서 모두 상위에 오른 문서가 자연스럽게 최상위로

**구현 포인트**:
- `useRagApi.ts`의 벡터+BM25 합산 로직을 RRF로 교체
- `vectorEmbedIndex.ts`의 `hybridRerank`에도 동일 적용

```typescript
function rrfScore(ranks: number[], k = 60): number {
  return ranks.reduce((sum, rank) => sum + 1 / (k + rank), 0)
}
```

**영향 파일**:
- `src/hooks/useRagApi.ts` — 합산 로직
- `src/lib/vectorEmbedIndex.ts` — hybridRerank

---

## 낮은 효과 (장기 과제)

### 7. 청크 오버랩 슬라이딩 윈도우
문서를 고정 섹션이 아닌 오버랩 청크(500자 윈도우, 100자 오버랩)로 분할하면 섹션 경계에 걸친 정보를 놓치지 않음. 다만 1번(섹션 단위)으로 충분한 경우가 많아 우선순위 낮음.

### 8. 쿼리 의도 분류 (Intent Classification)
검색 쿼리를 사전에 분류(사실 확인 / 비교 분석 / 브레인스토밍 / 최신 현황)하여 검색 전략 자체를 분기. 현재 RECENCY_INTENT_RE, GLOBAL_INTENT_RE로 부분 구현되어 있으나 확장 가능.

---

## 우선순위 로드맵

| 순서 | 항목 | 예상 작업량 | 의존성 |
|------|------|------------|--------|
| 1 | 섹션 단위 임베딩 | 중 | 없음 |
| 2 | 대화 히스토리 쿼리 보강 | 소 | 없음 |
| 3 | RRF 합산 | 소 | 없음 |
| 4 | 태그 스코어링 강화 | 소 | 없음 |
| 5 | Cross-Attention 리랭킹 | 소 | #1 완료 |
| 6 | 동의어 자동화 | 중 | 없음 |
