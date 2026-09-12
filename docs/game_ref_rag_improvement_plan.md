# 게임 레퍼런스 RAG 인사이트 개선 계획

> 작성일: 2026-03-31
> 대상 파일: `src/lib/vectorEmbedIndex.ts`, `src/hooks/useRagApi.ts`, `src/types/index.ts`

---

## 배경 및 문제 정의

`active/games/` 폴더에 39개의 외부 게임 레퍼런스 파일이 있지만,
유저 검색 시 AI 컨텍스트에 거의 올라오지 않는 문제가 있다.

### 증상
- "캐릭터 밸런스 어때?" → 내부 기획서만 반환, 오버워치/LoL 비교 없음
- "팀전 구조 참고할 게임 있어?" → 게임 파일이 topN 밖으로 밀림
- AI 답변에 게임 레퍼런스 자발적 인용 없음

### 근본 원인 2가지

#### 원인 1: 임베딩 텍스트 노이즈 (vectorEmbedIndex.ts)
`docText()` 함수가 external-reference 파일도 내부 문서와 동일하게 처리.
나무위키 PDF 변환 특성상 3000자 한도가 아래 노이즈로 채워짐:
- 날짜 헤더: `3. 30. 오후 5:13 리그 오브 레전드 - 나무위키`
- 각주: `[1][2][3][XGP][5][6]...`
- 표 마크업: `| 분류:리그 오브 레전드 | ... |`
- URL, 저작권 표기

결과: 실제 게임플레이 개념어(팀전, 스킬, 밸런스, 랭크)가 임베딩 공간에서 희석됨.
코사인 유사도가 내부 문서 대비 구조적으로 낮아지는 원인.

#### 원인 2: RAG 래퍼 버그 (useRagApi.ts:115-116)
```typescript
// 현재 — 항상 undefined
const refGame = undefined as string | undefined
const refDate = undefined as string | undefined

// AI가 실제로 받는 텍스트
"[외부게임 레퍼런스 — undefined.md / Steam 수집 / ]"
```
`LoadedDocument`에 `frontmatter` raw 필드가 없어서 `ref_game`, `ref_collected`를
읽을 수 없음. AI가 어떤 게임 데이터인지 인식 못하고 컨텍스트 활용도 저하.

---

## 개선 계획

### Fix 1: LoadedDocument에 frontmatter 원본 필드 추가
**파일**: `src/types/index.ts`

`LoadedDocument` 인터페이스에 frontmatter raw 데이터 필드 추가:

```typescript
/** Raw frontmatter key-value pairs (for fields not mapped to typed properties) */
frontmatter?: Record<string, unknown>
```

**파일**: vault 파서 (`src/stores/vaultStore.ts` 또는 파싱 로직)
문서 파싱 시 `frontmatter` 원본 객체를 `LoadedDocument.frontmatter`에 저장.

---

### Fix 2: useRagApi.ts — 래퍼 텍스트 버그 수정
**파일**: `src/hooks/useRagApi.ts` (라인 115-118)

```typescript
// 현재
const refGame = undefined as string | undefined
const refDate = undefined as string | undefined

// 수정
const refGame = doc.frontmatter?.ref_game as string | undefined
const refDate = doc.frontmatter?.ref_collected as string | undefined
```

AI가 받는 컨텍스트:
```
[외부게임 레퍼런스 — 리그 오브 레전드 (LoL) / 나무위키 / 2026-03-30]
챔피언 풀 161종, 랭크 구조, 메타 변화...
[끝 — 위는 외부 게임 데이터이며 프로젝트A 내부 문서가 아님]
```

**Fix 1 완료 전 임시 대응**: `doc.filename`에서 파싱
```typescript
const refGame = doc.filename.replace(/^\[게임\]\s*/, '').replace(/\.md$/i, '')
const refDate = doc.date || ''
```

---

### Fix 3: vectorEmbedIndex.ts — external-reference docText 별도 처리 (핵심)
**파일**: `src/lib/vectorEmbedIndex.ts` (라인 38-46)

`docText()` 함수에 external-reference 전용 텍스트 추출 로직 추가:

```typescript
function docText(doc: LoadedDocument): string {
  if (doc.type === 'external-reference') {
    const raw = doc.rawContent ?? ''

    // 나무위키 노이즈 제거
    const clean = raw
      .replace(/\[\d+\]/g, '')                         // 각주 [1][2][XGP]
      .replace(/\|[^\n]{0,200}\|/g, '')                // 표 행
      .replace(/\d{4}\.\s*\d+\.\s*\d+[^\n]*/g, '')    // 날짜 헤더
      .replace(/https?:\/\/\S+/g, '')                  // URL
      .replace(/⚠️[^\n]*/g, '')                        // 경고 마커
      .replace(/^\s*[-·]\s*$/gm, '')                   // 빈 목록항목
      .replace(/\n{3,}/g, '\n\n')                      // 빈 줄 정리
      .trim()

    // 선정 이유 + 섹션 헤딩 + 정제 본문 (3000자)
    const selected = doc.sections
      .filter(s => s.heading && !s.heading.match(/^페이지\s*\d+/))
      .map(s => `${s.heading}: ${s.body.slice(0, 200)}`)
      .join('\n')

    return [
      doc.filename.replace(/\.md$/i, ''),
      doc.tags?.join(' ') ?? '',
      selected,
      clean,
    ].join('\n').slice(0, 3000)
  }

  // 기존 내부 문서 처리 (변경 없음)
  return [
    doc.filename.replace(/\.md$/i, ''),
    doc.tags?.join(' ') ?? '',
    doc.speaker ?? '',
    ...doc.sections.map(s => `${s.heading} ${s.body}`),
    doc.rawContent ?? '',
  ].join(' ').slice(0, 3000)
}
```

**예상 효과**:
"팀전 구조" 검색 시 `더 파이널스 — 집단 팀전 샌드박스 PvP` 개념이
임베딩 공간에서 정상 경쟁 → 코사인 유사도 0.05~0.15 상승 예상.

---

### Fix 4: Dual-track 검색 — 게임 슬롯 항상 확보 (선택 적용)
**파일**: `src/hooks/useRagApi.ts`

내부 문서와 external-reference를 **별도로** 벡터 검색 후 병합.
Fix 3만으로 부족할 경우 추가 적용.

```typescript
// topN = 10 기준
// 내부 문서 상위 8개 + 게임 레퍼런스 상위 2개 항상 포함

const internalDocs = searchDocs.filter(d => d.type !== 'external-reference')
const externalDocs = searchDocs.filter(d => d.type === 'external-reference')

const internalHits = await vectorEmbedIndex.fullVectorSearch(
  searchQuery, geminiKey, Math.ceil(topN * 0.8), internalDocs
)
const externalHits = await vectorEmbedIndex.fullVectorSearch(
  searchQuery, geminiKey, Math.ceil(topN * 0.2), externalDocs
)

// 병합 후 score 기준 정렬
searchResults = [...(internalHits ?? []), ...(externalHits ?? [])]
```

**트레이드오프**:
- 장점: 쿼리와 무관하게 게임 데이터 항상 컨텍스트 포함
- 단점: 무관한 게임 데이터도 강제 포함될 수 있음 → Fix 3 효과 먼저 측정 후 결정

---

## 실행 순서

| 순서 | Fix | 파일 | 의존성 | 예상 효과 |
|------|-----|------|--------|-----------|
| 1 | Fix 2 임시 (filename 파싱) | useRagApi.ts | 없음 | AI 컨텍스트 게임명 정상화 |
| 2 | Fix 3 | vectorEmbedIndex.ts | 없음 | 벡터 검색 품질 핵심 개선 |
| 3 | Fix 1 | types/index.ts + vaultStore | 없음 | frontmatter 구조화 |
| 4 | Fix 2 정식 | useRagApi.ts | Fix 1 완료 후 | 래퍼 버그 완전 수정 |
| 5 | Fix 4 | useRagApi.ts | Fix 3 효과 측정 후 | 슬롯 보장 |

**Fix 3 적용 후 벡터 캐시 무효화 필수**:
`invalidateVectorEmbedCache()` 호출 또는 앱에서 "벡터 임베딩 초기화" 버튼 클릭.

---

## 완료 기준

- [ ] "캐릭터 밸런스" 검색 시 관련 게임 파일 1개 이상 topN 내 진입
- [ ] AI 답변에서 게임 레퍼런스 자발적 인용 발생
- [ ] RAG 래퍼 텍스트에 `undefined` 미노출
- [ ] 벡터 캐시 재빌드 후 게임 파일 39개 정상 포함 확인
