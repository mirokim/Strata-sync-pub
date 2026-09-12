"""
rag_simple.py — Slack 봇용 간단 키워드 RAG
"""
import json
import logging
import math
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, TypedDict
from .vault_scanner import scan_vault, find_active_folders, VaultDoc
from .paths import VAULT_ACCESS_PATH

logger = logging.getLogger(__name__)


class RagResult(TypedDict):
    title: str
    stem: str
    body: str
    score: float
    date: str
    tags: list[str]
    doc_type: str   # VaultDoc.doc_type — "reference" | "daily" | etc.

# ── scan_vault 메모리 캐시 (TTL 60초) ─────────────────────────────────────────
# 매 검색마다 전체 .md 파싱을 방지. 60초 내 동일 볼트 재검색 시 캐시 반환.
# corpus_idf: 문서와 동일한 TTL 로 IDF 도 캐시 (쿼리마다 전 코퍼스 재토크나이즈 방지).
#   {active_only: (docs, corpus, idf)} — docs 는 재스캔 감지용 identity 체크에 사용.
_vault_cache: dict = {}
_VAULT_CACHE_TTL = 60.0
_VAULT_CACHE_LOCK = threading.Lock()


def _get_cached_docs(vault_path: str) -> list[VaultDoc]:
    now = time.time()
    with _VAULT_CACHE_LOCK:
        if (_vault_cache.get("path") == vault_path
                and now - _vault_cache.get("ts", 0.0) < _VAULT_CACHE_TTL):
            return _vault_cache["docs"]
    docs = scan_vault(vault_path)
    with _VAULT_CACHE_LOCK:
        # 재스캔 → 파생 캐시(IDF) 무효화
        _vault_cache.update({
            "path": vault_path, "docs": docs, "ts": time.time(), "corpus_idf": {},
        })
    return docs


def _get_corpus_and_idf(
    vault_path: str, active_only: bool
) -> tuple[list[VaultDoc], dict[str, float]]:
    """검색 대상 코퍼스와 IDF 를 문서 캐시와 같은 TTL 로 캐시해 반환.

    IDF 계산은 코퍼스 전체 재토크나이즈라 쿼리당 수백 ms 가 든다.
    문서 목록이 바뀌지 않는 한 재사용한다.
    """
    docs = _get_cached_docs(vault_path)

    with _VAULT_CACHE_LOCK:
        if _vault_cache.get("path") == vault_path:
            cached = (_vault_cache.get("corpus_idf") or {}).get(active_only)
            # docs identity 로 재스캔 여부 확인 (TTL 만료 후 갱신 시 자동 미스)
            if cached is not None and cached[0] is docs:
                return cached[1], cached[2]

    corpus_docs = docs
    if active_only:
        active_set = {str(Path(f).resolve()) for f in find_active_folders(vault_path)}
        # parent_resolved 는 스캔 시 미리 계산됨 — 쿼리마다 문서 수만큼 resolve() 하지 않는다
        corpus_docs = [d for d in docs if d.parent_resolved in active_set]

    corpus = [d for d in corpus_docs if not d.stem.startswith("index_")]
    idf = _build_idf(corpus)

    with _VAULT_CACHE_LOCK:
        if _vault_cache.get("path") == vault_path and _vault_cache.get("docs") is docs:
            _vault_cache.setdefault("corpus_idf", {})[active_only] = (docs, corpus, idf)

    return corpus, idf


# ── 핫스코어 (OpenViking memory_lifecycle 기반) ───────────────────────────────
# 자주/최근 참조된 문서에 보너스를 부여해 검색 결과 재정렬.
# 공식: sigmoid(log1p(접근횟수)) × exp(-decay × 경과일수)

_HOTNESS_HALF_LIFE_DAYS: float = 7.0
_HOTNESS_ALPHA: float = 0.15  # 검색점수 85% + 핫스코어 15%
_ACCESS_STORE_PATH = VAULT_ACCESS_PATH
_ACCESS_STORE_LOCK = threading.Lock()  # 동시 read-modify-write 보호


def _load_access_store() -> dict:
    try:
        with open(_ACCESS_STORE_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_access_store(store: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_ACCESS_STORE_PATH), exist_ok=True)
        tmp_path = _ACCESS_STORE_PATH + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(store, f, ensure_ascii=False)
        os.replace(tmp_path, _ACCESS_STORE_PATH)  # atomic rename — concurrent write 안전
    except PermissionError:
        logger.error("권한 오류: vault_access.json 쓰기 실패 (%s)", _ACCESS_STORE_PATH)
    except OSError as e:
        logger.error("파일 시스템 오류: vault_access.json 저장 실패: %s", e)
    except Exception:
        logger.exception("예상치 못한 오류: _save_access_store")


def record_doc_access(stems: list[str]) -> None:
    """검색 결과로 반환된 문서 stem 목록의 접근 횟수를 기록."""
    # stems: vault-relative 파일명 (확장자 없음)
    if not stems:
        return
    with _ACCESS_STORE_LOCK:
        store = _load_access_store()
        now_iso = datetime.now(timezone.utc).isoformat()
        for stem in stems:
            entry = store.get(stem, {"count": 0, "last_access": now_iso})
            entry["count"] = entry.get("count", 0) + 1
            entry["last_access"] = now_iso
            store[stem] = entry
        _save_access_store(store)


def _hotness_score(active_count: int, updated_at_iso: str | None) -> float:
    """OpenViking 공식: sigmoid(log1p(count)) × exp(-decay × age_days)"""
    if not updated_at_iso:
        return 0.0
    try:
        updated_at = datetime.fromisoformat(updated_at_iso)
    except Exception:
        return 0.0
    now = datetime.now(timezone.utc)
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=timezone.utc)
    freq = 1.0 / (1.0 + math.exp(-math.log1p(active_count)))
    age_days = max((now - updated_at).total_seconds() / 86400.0, 0.0)
    decay_rate = math.log(2) / _HOTNESS_HALF_LIFE_DAYS
    recency = math.exp(-decay_rate * age_days)
    return freq * recency


def apply_hotness_rerank(results: list[RagResult]) -> list[RagResult]:
    """검색 결과에 핫스코어를 블렌딩해 재정렬. 원본 score 필드를 업데이트."""
    if not results:
        return results
    with _ACCESS_STORE_LOCK:
        store = _load_access_store()
    max_score = max((r.get("score", 0) for r in results), default=1.0) or 1.0
    for r in results:
        stem = r.get("stem", "")
        entry = store.get(stem, {})
        h = _hotness_score(entry.get("count", 0), entry.get("last_access"))
        norm = r.get("score", 0) / max_score
        r["score"] = ((1 - _HOTNESS_ALPHA) * norm + _HOTNESS_ALPHA * h) * max_score
    results.sort(key=lambda r: -r.get("score", 0))
    return results


# 프론트엔드 stemKorean()과 동일한 한국어 조사 목록
_KO_SUFFIXES = [
    '이라는', '이라고', '에서는', '에게서', '한테서', '으로서', '으로써', '으로는',
    '에서의', '으로의', '에서도', '으로도',
    '이라', '에서', '에게', '한테', '까지', '부터', '처럼', '같은', '같이',
    '만큼', '으로', '이랑', '라는', '라고', '이란', '에는', '하고',
    '은', '는', '이', '가', '을', '를', '와', '과',
    '에', '도', '만', '의', '로',
]

# 한글 음절 범위: 가(0xAC00) ~ 힣(0xD7A3)
def _ko_syllables(s: str) -> list[str]:
    return [ch for ch in s if '\uAC00' <= ch <= '\uD7A3']


def _stem_korean(token: str) -> list[str]:
    """프론트엔드 stemKorean()과 동일 로직: 조사 제거 + 2-gram 서브토큰."""
    results = [token]
    stem = token
    for suffix in _KO_SUFFIXES:
        if token.endswith(suffix) and len(token) > len(suffix) + 1:
            stem = token[:-len(suffix)]
            results.append(stem)
            break
    # 3음절 이상이면 2-gram 서브토큰 추가
    syllables = _ko_syllables(stem)
    if len(syllables) >= 3:
        for i in range(len(syllables) - 1):
            results.append(syllables[i] + syllables[i + 1])
    return list(dict.fromkeys(results))  # 순서 유지 중복 제거


def _tokenize_raw(text: str) -> list[str]:
    """텍스트를 소문자 토큰 리스트로 분리 (공백·특수문자 기준). 형태소 분석 미적용."""
    # 문장부호(?!:;)도 구분자 — 빠지면 "밸런스는?" 같은 토큰에서 조사 제거가 실패한다
    tokens = re.split(r"[\s\[\](),./|_\-?!:;]+", text.lower())
    # 1글자라도 동의어 맵에 있으면 유지 (예: '몹', '적')
    return [t for t in tokens if len(t) >= 2 or t in _SYNONYM_MAP]


def _tokenize(text: str) -> list[str]:
    """텍스트를 소문자 토큰 리스트로 분리 + 한국어 형태소 분석.
    조사 제거 + 복합명사 2-gram 분해를 적용하여 원본 토큰과 함께 반환.
    """
    result: list[str] = []
    for t in _tokenize_raw(text):
        result.extend(_stem_korean(t))
    return result


def _expand_synonyms(tokens: list[str]) -> list[str]:
    """토큰 리스트에 동의어 확장 적용 (2-hop). TypeScript expandTerms()와 동일 로직."""
    expanded = dict.fromkeys(tokens)  # 순서 유지 집합
    first_hop: list[str] = []
    for t in tokens:
        for syn in _SYNONYM_MAP.get(t, ()):
            if syn not in expanded:
                expanded[syn] = None
                first_hop.append(syn)
    for t in first_hop:
        for syn in _SYNONYM_MAP.get(t, ()):
            if syn not in expanded:
                expanded[syn] = None
    return list(expanded)


# mcp/src/synonyms.ts 및 src/lib/synonyms.ts 와 동기화 필요
_SYNONYM_MAP: dict[str, tuple[str, ...]] = {
    # ── 약어 확장 ──
    '배틀로얄':    ('br', 'br모드'),
    'br':          ('배틀로얄', 'br모드'),

    # ── 사운드 그룹 ──
    '음향':        ('사운드',),
    '효과음':      ('사운드', 'sfx'),
    '배경음':      ('bgm', '사운드'),
    '배경음악':    ('bgm', '사운드'),
    '오디오':      ('사운드',),
    '소리':        ('사운드',),

    # ── 서버 그룹 ──
    '전용서버':    ('데디케이트',),
    '독립서버':    ('데디케이트',),
    '데디케이트':  ('전용서버', '클라서버'),

    # ── 맵/지도 ──
    '지도':        ('맵', 'world_map'),
    '세계지도':    ('맵', 'world_map', '월드맵'),

    # ── 스킬 ──
    '능력':        ('스킬',),
    '특수능력':    ('스킬',),

    # ── 몬스터/NPC ──
    '적':          ('몬스터', 'npc'),
    '적군':        ('몬스터', 'npc'),
    '보스':        ('몬스터', '레이드보스'),
    '몹':          ('몬스터', 'npc'),

    # ── 조합/제작 ──
    '조합':        ('레시피', '크래프팅'),
    '제작':        ('레시피', '크래프팅'),

    # ── 각성 ──
    '각성':        ('성장', '강화'),
    '눈뜨기':      ('각성',),

    # ── 안전지대 ──
    '세이프존':    ('안전지대', '안전 지대'),
    '안전구역':    ('안전지대', '안전 지대'),
    '안전지대':    ('안전 지대', '세이프존'),

    # ── 궁극기 ──
    '얼티밋':      ('궁극기', 'ultimate'),
    '필살기':      ('궁극기',),
    '궁극기':      ('얼티밋', 'ultimate'),
    'ultimate':    ('궁극기', '얼티밋'),

    # ── 온보딩 ──
    '온보딩':      ('튜토리얼', '신규 입사자'),
    '신입':        ('신규 입사자', '튜토리얼'),

    # ── 보고/회의 ──
    '리포트':      ('보고', '보고서', '정례보고'),
    '위클리':      ('정례', '주간'),
    '주간보고':    ('정례보고', '정례'),
    '임원':        ('이사장', '의장', '회장'),
    '경영진':      ('이사장', '의장'),

    # ── 외주 ──
    '아웃소싱':    ('외주',),
    '협력사':      ('외주',),
    '외주':        ('아웃소싱', '협력사'),

    # ── 게임 모드 ──
    '컨퀘스트':    ('점령전',),
    '점령전':      ('컨퀘스트', 'conquest'),
    'conquest':    ('점령전',),
    '난투전':      ('brawl',),
    'brawl':       ('난투전',),
    '팀전':        ('점령전', '난투전'),
    '레이드':      ('레이드보스',),
    '보스전':      ('레이드보스', '레이드'),

    # ── 아트/비주얼 ──
    '일러스트':    ('원화', '컨셉아트'),
    '비주얼':      ('아트',),
    '시네마틱':    ('연출', '컷씬'),
    '컷씬':        ('연출', '시네마틱'),

    # ── 블록/복셀 ──
    '건축':        ('블록', '복셀', '빌딩'),
    '빌딩':        ('블록', '복셀', '건축'),
    '복셀':        ('블록', '복셀엔진'),

    # ── 기획 문서 ──
    'gdd':         ('기획서', '기획'),
    '스펙':        ('기획', '상세기획'),
    '설계':        ('기획',),
    '데모':        ('시연', '빌드'),
    '프레젠테이션': ('정례보고', '시연'),
    '로드맵':      ('마일스톤', '릴리즈'),

    # ── QA/이슈 ──
    '버그':        ('이슈', '결함'),
    '이슈':        ('버그', '결함'),
    'qa':          ('테스트', '품질'),

    # ── 렌더링 ──
    '렌더파이프라인': ('hdrp',),
    '렌더링':      ('hdrp',),
    '렌더':        ('hdrp', '렌더링'),

    # ── 추가 매핑 (2차 테스트 보완) ──
    '챔피언':      ('캐릭터', '영웅'),
    '히어로':      ('캐릭터', '영웅'),
    '영웅':        ('캐릭터', '히어로'),
    '태스크':      ('이슈', 'jira'),
    '세이프':      ('안전', '안전 지대'),
    '스킬트리':    ('패시브', '스킬', '성장'),
    'world':       ('세계관', '월드'),
    'project':     ('프로젝트',),
    '프로젝트':    ('project',),
    'building':    ('건설', '빌딩'),
    'management':  ('관리',),
    'art':         ('아트',),
    'production':  ('제작', '프로덕션'),
    'pipeline':    ('파이프라인',),
    '에프엑스':    ('fx', '이펙트'),
    'fx':          ('이펙트', '에프엑스'),

    # ── 캐릭터 영한 매핑 ──
    'daizan':      ('캐릭터G',),
    'taizan':      ('캐릭터G',),
    '캐릭터G':      ('daizan', 'taizan'),
    'scarlet':     ('캐릭터A',),
    '캐릭터A':      ('scarlet',),
    'matini':      ('캐릭터B',),
    '캐릭터B':      ('matini',),
    'altan':       ('캐릭터H',),
    '캐릭터H':        ('altan',),
    'psyche':      ('프시케',),
    '프시케':      ('psyche',),
    'tamaris':     ('캐릭터F',),
    '캐릭터F':    ('tamaris',),
    'wolryeong':   ('캐릭터C',),
    '캐릭터C':        ('wolryeong',),
    'borhu':       ('캐릭터I',),
    '캐릭터I':      ('borhu',),

    # ── 영문 게임 용어 → 한국어 ──
    'skill':       ('스킬',),
    'balance':     ('밸런스',),
    'character':   ('캐릭터',),
    'combat':      ('전투',),
    'damage':      ('데미지', '대미지'),
    'sound':       ('사운드',),
    'level':       ('레벨',),
    'block':       ('블록',),
    'magic':       ('마법', '매직'),
    'quest':       ('퀘스트',),
    'scenario':    ('시나리오',),
    'tutorial':    ('튜토리얼',),
    'outsourcing': ('외주',),
    'meeting':     ('회의', '회의록'),
    'feedback':    ('피드백',),
    'milestone':   ('마일스톤',),
    'release':     ('릴리즈',),
    'server':      ('서버',),
    'animation':   ('애니메이션', '모션'),
    'shader':      ('쉐이더',),

    # ── 외래어 표기 변형 ──
    '셰이더':      ('쉐이더',),
    '대미지':      ('데미지', 'damage'),
    '데미지':      ('대미지', 'damage'),
    '발란스':      ('밸런스',),
    '이팩트':      ('이펙트', 'effect'),
    '이펙트':      ('이팩트', 'effect'),

    # ── 역방향 매핑 ──
    '사운드':      ('음향', '효과음', 'bgm', 'sfx', 'sound'),
    'sfx':         ('효과음', '사운드'),
    'bgm':         ('배경음', '배경음악', '사운드'),
    '맵':          ('지도', 'world_map'),
    '스킬':        ('능력', '특수능력', 'skill'),
    '몬스터':      ('적', '적군', '몹', 'npc'),
    'npc':         ('몬스터', '몹'),
    'br모드':      ('배틀로얄', 'br'),
    '밸런스':      ('balance', '발란스'),
    '캐릭터':      ('character',),
    '전투':        ('combat',),
    '마법':        ('magic', '매직'),
    '매직':        ('magic', '마법'),
    '퀘스트':      ('quest',),
    '시나리오':    ('scenario',),
    '튜토리얼':    ('tutorial', '온보딩'),
    '피드백':      ('feedback',),
    '마일스톤':    ('milestone',),
    '릴리즈':      ('release',),
    '서버':        ('server',),
    '쉐이더':      ('셰이더', 'shader'),
    '레벨':        ('level',),
    '블록':        ('block', '복셀'),
    '레이드보스':  ('레이드', '보스전'),
}


def _build_idf(docs: list[VaultDoc]) -> dict[str, float]:
    """코퍼스 전체에서 각 토큰의 IDF 값을 계산.

    IDF = log(1 + (N - df + 0.5) / (df + 0.5))  — BM25 스무딩
    단순 log(N/df) 는 전 문서에 등장하는 용어를 IDF=0 으로 만들어 완전히 무시하고,
    문서가 1개뿐인 코퍼스에서는 모든 용어가 0이 되어 검색 결과가 항상 0건이 된다.
    스무딩을 넣으면 흔한 용어도 작지만 양수 가중치를 유지한다.

    원본 토큰 기준으로 IDF를 계산 (형태소 확장은 쿼리 측에서만 적용).
    """
    N = len(docs)
    if N == 0:
        return {}
    df: dict[str, int] = {}
    for doc in docs:
        tokens = set(_tokenize_raw(doc.title + " " + doc.stem + " " + doc.body))
        for t in tokens:
            df[t] = df.get(t, 0) + 1
    return {
        t: math.log(1.0 + (N - count + 0.5) / (count + 0.5))
        for t, count in df.items()
    }


def _score_doc(doc: VaultDoc, query_tokens: list[str], idf: dict[str, float]) -> float:
    """TF-IDF 기반 문서 점수.
    제목·파일명·본문에 가중치를 다르게 적용하되, IDF로 공통 단어 억제.
    """
    title_lower = doc.title.lower()
    stem_lower  = doc.stem.lower()
    body_lower  = doc.body.lower()
    score = 0.0
    for token in query_tokens:
        idf_val = idf.get(token, 0.0)
        if idf_val <= 0:
            continue  # 전 문서에 등장 → 변별력 없음, 스킵
        if token in title_lower:
            score += 3.0 * idf_val
        if token in stem_lower:
            score += 2.0 * idf_val
        count = body_lower.count(token)
        if count > 0:
            score += min(count * 0.5, 3.0) * idf_val
    return score


def search_vault(
    query: str,
    vault_path: str,
    top_n: int = 5,
    active_only: bool = True,
) -> list[RagResult]:
    query_tokens = _expand_synonyms(_tokenize(query))
    if not query_tokens:
        return []

    # 코퍼스 + IDF 는 문서 캐시와 같은 TTL 로 재사용 (index_ 파일 제외)
    corpus, idf = _get_corpus_and_idf(vault_path, active_only)

    scored = []
    for doc in corpus:
        s = _score_doc(doc, query_tokens, idf)
        if s > 0:
            scored.append((s, doc))

    scored.sort(key=lambda x: -x[0])

    return [
        {
            "title": doc.title,
            "stem":  doc.stem,
            "body":  doc.body.strip()[:4000],
            "score": score,
            "date":     doc.date_str,
            "tags":     doc.tags,
            "doc_type": doc.doc_type,
        }
        for score, doc in scored[:top_n]
    ]


def build_rag_context(results: list[RagResult], max_chars: int = 12000) -> str:
    if not results:
        return ""

    parts = ["## 참고 문서\n"]
    total = 0
    for r in results:
        tag_str = " ".join(f"`{t}`" for t in (r["tags"] or []))
        header  = f"### {r['title']} ({r['date']}) {tag_str}\n"
        body    = r["body"]
        available = max_chars - total - len(header) - 10
        if available <= 100:
            break
        if len(body) > available:
            body = body[:available] + "…"
        chunk = header + body + "\n\n"
        parts.append(chunk)
        total += len(chunk)

    return "".join(parts)
