> **외부 게임 레퍼런스 정제 — 수집 · 변환 · RAG 통합**

*경쟁/레퍼런스 게임 데이터를 볼트에 통합하고, 벡터 RAG 검색에 활용하는 전체 파이프라인을 기술한다.*

v1.0 | 2026-03-31

---

## 목차

| § | 내용 |
|---|------|
| 1 | 목적 및 원칙 |
| 2 | 파일 구조 및 Frontmatter 규칙 |
| 3 | 수집 파이프라인 (Fandom / 나무위키) |
| 4 | RAG 통합 방식 — 듀얼 트랙 벡터 검색 |
| 5 | 벡터 임베딩 노이즈 제거 |
| 6 | 웹 검색 자동 보완 |
| 7 | Edit Agent 연동 |
| 8 | 신규 게임 추가 체크리스트 |

---

## §1 목적 및 원칙

### 1.1 목적

유저가 "Battlerite 아레나 구조를 프로젝트 A에 어떻게 적용할 수 있어?" 같은 비교 분석 질문을 할 때, AI가 외부 게임 데이터를 참조하여 구체적인 인사이트를 제공하도록 한다.

### 1.2 핵심 원칙

- **내부 문서와 명확히 분리**: `type: external-reference` 로 마킹, 내부 의사결정 근거로 직접 인용 금지
- **비교 분석 컨텍스트 전용**: AI 답변에서 "외부 게임 레퍼런스" 로 출처 명시 후 활용
- **RAG 자동 포함**: 게임 관련 질문에 내부 문서와 함께 자동으로 검색 결과에 포함
- **데이터 품질 우선**: 나무위키 PDF 노이즈(각주, 날짜 헤더, 표 마크업) 제거 후 임베딩

---

## §2 파일 구조 및 Frontmatter 규칙

### 2.1 폴더 위치

```
{볼트}/
├── active/
│   └── games/
│       └── [게임] GameName.md          # 주 파일 (RAG 포함)
└── _reference/
    └── games/
        └── [게임] GameName.md          # 백업 또는 추가 출처
```

`active/games/` 가 RAG 검색의 주 대상이다. `_reference/games/` 는 출처가 다른 보완 자료에 사용한다.

### 2.2 필수 Frontmatter

```yaml
---
type: external-reference
ref_game: "GameName"               # 게임 공식 영문명 (RAG context 레이블에 사용됨)
ref_source: "fandom"               # 출처: fandom / namu / official / steam
ref_wiki: "gamename.fandom.com"    # 출처 URL (도메인만)
ref_collected: YYYY-MM-DD          # 수집일 (RAG context 날짜 표시에 사용)
internal: false
tags: [external-reference, game-analysis, {장르태그}, ...]
---
```

> ⚠️ `ref_game` 과 `ref_collected` 는 RAG 컨텍스트 헤더 생성에 직접 사용된다.
> 누락 시 파일명 파싱으로 폴백되므로 반드시 입력할 것.

### 2.3 본문 구조 권장

```markdown
> ⚠️ **[외부 레퍼런스]** 이 문서는 **{GameName}** (외부 출시 게임)에 대한 데이터입니다.
> 프로젝트 A 내부 의사결정 근거로 **직접 인용 금지**.
> 비교 분석 컨텍스트로만 활용하세요.
> 출처: {출처} | 수집일: YYYY-MM-DD

# GameName

> **선정 이유**: [왜 이 게임을 레퍼런스로 선정했는지 1-2줄]

## 게임 개요
## 핵심 메커니즘
## 프로젝트 A 비교 포인트   ← 이 섹션이 가장 중요
## [기타 분석 섹션]
```

---

## §3 수집 파이프라인

### 3.1 Fandom Wiki 출처

**`tools/import_fandom_ref.py`** 사용 (또는 수동 작성):

1. Fandom Wiki 페이지에서 핵심 내용 수동 복사 또는 API 호출
2. 노이즈 제거: 광고 텍스트, 네비게이션 박스, 에디트 버튼 텍스트 제거
3. Frontmatter 작성 후 `active/games/[게임] {GameName}.md` 저장
4. **`tools/fix_game_ref_links.py`** 실행 → 깨진 링크 정리, 내부 wikilink 제거

### 3.2 나무위키 PDF 출처

**`tools/import_namu_wiki_ref.py`** 사용:

```bash
python tools/import_namu_wiki_ref.py \
  --pdf "{나무위키 PDF 경로}" \
  --game "GameName" \
  --output active/games
```

스크립트가 처리하는 노이즈:
- `[1][2][3]` 형태 각주 제거
- `| 텍스트 |` 나무위키 테이블 마크업 제거
- `YYYY. MM. DD` 날짜 헤더 제거
- `https://...` 외부 URL 제거
- `⚠️ 경고 텍스트` 나무위키 알림 제거
- 3줄 이상 연속 빈 줄 압축

> **나무위키 PDF 주의사항**:
> 나무위키 PDF는 날짜 헤더·각주·표 마크업이 3000자 임베딩 한도를 빠르게 소모한다.
> `import_namu_wiki_ref.py` 없이 원본을 직접 넣으면 벡터 품질이 급격히 저하된다.

### 3.3 Fandom 전체 파이프라인 순서

Edit Agent의 Confluence·Jira 최신화 명령 내 게임 레퍼런스 추가 시:

```
① Fandom/나무위키에서 데이터 수집
② import_namu_wiki_ref.py 또는 import_fandom_ref.py 실행
③ fix_game_ref_links.py 실행 (링크 정제)
④ inject_keywords.py 실행 (키워드 역전파)
⑤ gen_index.py 실행 (_index.md 갱신)
⑥ rebuild_vector_index 도구 호출 (벡터 재빌드)
```

---

## §4 RAG 통합 방식 — 듀얼 트랙 벡터 검색

### 4.1 구조

게임 레퍼런스 파일은 일반 BM25 키워드 검색에서 자연 노출이 어렵다 (게임 전문용어가 내부 문서 키워드와 겹치지 않음). 이를 해결하기 위해 **듀얼 트랙 벡터 검색**을 적용한다.

```
검색 요청 (topN)
    │
    ├── 트랙 A: 내부 문서 벡터 검색     topN × 0.8 슬롯
    │           (type ≠ external-reference)
    │
    └── 트랙 B: 게임 레퍼런스 벡터 검색  topN × 0.2 슬롯
                (type = external-reference)
                ↑ 메타데이터 필터 우회 — 항상 포함
    │
    └── 두 트랙 병합 → BM25 보완 (내부 문서만) → LLM 리랭킹 (선택)
```

### 4.2 AI 답변 컨텍스트 헤더

게임 레퍼런스가 RAG 컨텍스트에 포함될 때 자동으로 아래 헤더가 붙는다:

```
[외부게임 레퍼런스 — {ref_game} / 나무위키 / {ref_collected}]
... 본문 ...
[끝 — 위는 외부 게임 데이터이며 프로젝트A 내부 문서가 아님]
```

AI는 이 헤더를 통해 외부 데이터임을 인식하고 답변에 적절히 맥락화한다.

---

## §5 벡터 임베딩 노이즈 제거

게임 레퍼런스 파일의 임베딩 텍스트(`docText()`)는 내부 문서와 다른 처리를 적용한다:

| 처리 | 대상 |
|------|------|
| `[1][2][3]` 각주 제거 | 나무위키 출처 파일 |
| `\| 텍스트 \|` 표 마크업 제거 | 나무위키 테이블 |
| `YYYY. MM. DD` 날짜 헤더 제거 | 나무위키 히스토리 헤더 |
| `https://...` URL 제거 | 모든 외부 레퍼런스 |
| `⚠️ 경고줄` 제거 | 나무위키 알림 박스 |
| 섹션 헤딩 우선 선택 (페이지 번호 제외) | 의미 있는 섹션만 임베딩 |
| 3000자 한도 | 내부 문서와 동일 |

> **임베딩 재빌드 필요 시점**: 게임 레퍼런스 파일을 추가/수정한 후에는 반드시
> 벡터 임베딩을 재빌드해야 변경사항이 검색에 반영된다.
> Edit Agent의 `rebuild_vector_index` 도구 또는 설정 > 벡터 임베딩 탭의 "초기화" 버튼 사용.

---

## §6 웹 검색 자동 보완

볼트의 게임 레퍼런스 자료가 부족할 때 AI가 자동으로 웹 검색을 수행한다.

**트리거 조건** (AI가 자동 판단):
- 질문에서 언급된 게임의 볼트 자료가 없거나 구체적인 메커니즘 설명이 부족한 경우
- 볼트 자료만으로 충분한 인사이트를 제공하기 어려운 경우
- 최신 업계 동향, 공식 발표가 필요한 경우

**설정**: 설정 > 검색 탭 > "웹 검색" 토글 (기본: ON)

**검색 엔진**: DuckDuckGo (API 키 불필요, Electron 경유)

---

## §7 Edit Agent 연동

### 7.1 사용 가능한 도구

| 도구 | 용도 |
|------|------|
| `write_file` | 게임 레퍼런스 MD 파일 생성/수정 |
| `run_python_tool` | `import_namu_wiki_ref.py`, `fix_game_ref_links.py` 실행 |
| `rebuild_vector_index` | 파일 추가/수정 후 벡터 임베딩 재빌드 |

### 7.2 사용 예시

Edit Agent 채팅창에서:
```
"Deadlock 게임 레퍼런스를 추가하고 벡터 임베딩 재빌드해줘"
```

에이전트가 자동으로:
1. `active/games/[게임] Deadlock.md` 작성
2. `fix_game_ref_links.py` 실행
3. `rebuild_vector_index` 도구 호출

---

## §8 신규 게임 추가 체크리스트

```
□ 1. 파일명 형식: [게임] {GameName}.md (대괄호 포함)
□ 2. 저장 위치: active/games/
□ 3. Frontmatter: type·ref_game·ref_source·ref_wiki·ref_collected·internal·tags 전부 입력
□ 4. 외부 레퍼런스 경고 블록 (본문 최상단)
□ 5. "선정 이유" 항목 작성 (왜 이 게임인가)
□ 6. "프로젝트 A 비교 포인트" 섹션 포함
□ 7. fix_game_ref_links.py 실행
□ 8. inject_keywords.py 실행 (내부 문서와 교차 연결)
□ 9. gen_index.py 실행 (_index.md 반영)
□ 10. 벡터 임베딩 재빌드 (rebuild_vector_index 또는 설정 탭)
```

> **게임 레퍼런스 품질 기준**:
> - 최소 3개 이상의 `##` 섹션
> - "프로젝트 A 비교 포인트" 섹션 필수 (이 섹션이 RAG 답변 품질을 결정)
> - 나무위키 원본을 그대로 붙여넣지 말 것 — `import_namu_wiki_ref.py` 를 통해 노이즈 제거 후 사용
