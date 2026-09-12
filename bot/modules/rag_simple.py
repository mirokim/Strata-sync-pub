"""
rag_simple.py — simple keyword RAG for the Slack bot
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

# ── scan_vault in-memory cache (TTL 60s) ──────────────────────────────────────
# Avoids re-parsing every .md on each search. Re-searching the same vault within 60s returns the cache.
# corpus_idf: IDF is cached with the same TTL as the docs (avoids re-tokenizing the whole corpus per query).
#   {active_only: (docs, corpus, idf)} — docs is used for an identity check to detect a rescan.
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
        # Rescan → invalidate derived cache (IDF)
        _vault_cache.update({
            "path": vault_path, "docs": docs, "ts": time.time(), "corpus_idf": {},
        })
    return docs


def _get_corpus_and_idf(
    vault_path: str, active_only: bool
) -> tuple[list[VaultDoc], dict[str, float]]:
    """Return the search corpus and IDF, cached with the same TTL as the doc cache.

    Computing IDF re-tokenizes the whole corpus, costing hundreds of ms per query.
    Reused as long as the document list has not changed.
    """
    docs = _get_cached_docs(vault_path)

    with _VAULT_CACHE_LOCK:
        if _vault_cache.get("path") == vault_path:
            cached = (_vault_cache.get("corpus_idf") or {}).get(active_only)
            # Check for a rescan via docs identity (automatic miss after a refresh past TTL)
            if cached is not None and cached[0] is docs:
                return cached[1], cached[2]

    corpus_docs = docs
    if active_only:
        active_set = {str(Path(f).resolve()) for f in find_active_folders(vault_path)}
        # parent_resolved is precomputed at scan time — no per-query resolve() for every document
        corpus_docs = [d for d in docs if d.parent_resolved in active_set]

    corpus = [d for d in corpus_docs if not d.stem.startswith("index_")]
    idf = _build_idf(corpus)

    with _VAULT_CACHE_LOCK:
        if _vault_cache.get("path") == vault_path and _vault_cache.get("docs") is docs:
            _vault_cache.setdefault("corpus_idf", {})[active_only] = (docs, corpus, idf)

    return corpus, idf


# ── Hotness score (based on OpenViking memory_lifecycle) ─────────────────────
# Re-ranks search results by giving a bonus to frequently/recently referenced documents.
# Formula: sigmoid(log1p(access_count)) × exp(-decay × age_days)

_HOTNESS_HALF_LIFE_DAYS: float = 7.0
_HOTNESS_ALPHA: float = 0.15  # search score 85% + hotness score 15%
_ACCESS_STORE_PATH = VAULT_ACCESS_PATH
_ACCESS_STORE_LOCK = threading.Lock()  # guards concurrent read-modify-write


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
        os.replace(tmp_path, _ACCESS_STORE_PATH)  # atomic rename — safe against concurrent writes
    except PermissionError:
        logger.error("Permission error: failed to write vault_access.json (%s)", _ACCESS_STORE_PATH)
    except OSError as e:
        logger.error("File system error: failed to save vault_access.json: %s", e)
    except Exception:
        logger.exception("Unexpected error: _save_access_store")


def record_doc_access(stems: list[str]) -> None:
    """Record access counts for the document stems returned as search results."""
    # stems: vault-relative file names (without extension)
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
    """OpenViking formula: sigmoid(log1p(count)) × exp(-decay × age_days)"""
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
    """Blend the hotness score into search results and re-rank. Updates the original score field."""
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


# Korean particle list, identical to the frontend stemKorean()
_KO_SUFFIXES = [
    '이라는', '이라고', '에서는', '에게서', '한테서', '으로서', '으로써', '으로는',
    '에서의', '으로의', '에서도', '으로도',
    '이라', '에서', '에게', '한테', '까지', '부터', '처럼', '같은', '같이',
    '만큼', '으로', '이랑', '라는', '라고', '이란', '에는', '하고',
    '은', '는', '이', '가', '을', '를', '와', '과',
    '에', '도', '만', '의', '로',
]

# Hangul syllable range: 가(0xAC00) ~ 힣(0xD7A3)
def _ko_syllables(s: str) -> list[str]:
    return [ch for ch in s if '\uAC00' <= ch <= '\uD7A3']


def _stem_korean(token: str) -> list[str]:
    """Same logic as the frontend stemKorean(): particle stripping + 2-gram sub-tokens."""
    results = [token]
    stem = token
    for suffix in _KO_SUFFIXES:
        if token.endswith(suffix) and len(token) > len(suffix) + 1:
            stem = token[:-len(suffix)]
            results.append(stem)
            break
    # Add 2-gram sub-tokens for 3+ syllables
    syllables = _ko_syllables(stem)
    if len(syllables) >= 3:
        for i in range(len(syllables) - 1):
            results.append(syllables[i] + syllables[i + 1])
    return list(dict.fromkeys(results))  # order-preserving dedup


def _tokenize_raw(text: str) -> list[str]:
    """Split text into a list of lowercase tokens (on whitespace/special chars). No morphological analysis."""
    # Punctuation (?!:;) is a separator too — otherwise particle stripping fails on tokens like "밸런스는?"
    tokens = re.split(r"[\s\[\](),./|_\-?!:;]+", text.lower())
    # Keep single-char tokens if they are in the synonym map (e.g. '몹', '적')
    return [t for t in tokens if len(t) >= 2 or t in _SYNONYM_MAP]


def _tokenize(text: str) -> list[str]:
    """Split text into a list of lowercase tokens + Korean morphological analysis.
    Applies particle stripping + compound-noun 2-gram decomposition and returns them alongside the original tokens.
    """
    result: list[str] = []
    for t in _tokenize_raw(text):
        result.extend(_stem_korean(t))
    return result


def _expand_synonyms(tokens: list[str]) -> list[str]:
    """Apply synonym expansion to a token list (2-hop). Same logic as the TypeScript expandTerms()."""
    expanded = dict.fromkeys(tokens)  # order-preserving set
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


# Must be kept in sync with mcp/src/synonyms.ts and src/lib/synonyms.ts
_SYNONYM_MAP: dict[str, tuple[str, ...]] = {
    # ── Abbreviation expansion ──
    '배틀로얄':    ('br', 'br모드'),
    'br':          ('배틀로얄', 'br모드'),

    # ── Sound group ──
    '음향':        ('사운드',),
    '효과음':      ('사운드', 'sfx'),
    '배경음':      ('bgm', '사운드'),
    '배경음악':    ('bgm', '사운드'),
    '오디오':      ('사운드',),
    '소리':        ('사운드',),

    # ── Server group ──
    '전용서버':    ('데디케이트',),
    '독립서버':    ('데디케이트',),
    '데디케이트':  ('전용서버', '클라서버'),

    # ── Map ──
    '지도':        ('맵', 'world_map'),
    '세계지도':    ('맵', 'world_map', '월드맵'),

    # ── Skill ──
    '능력':        ('스킬',),
    '특수능력':    ('스킬',),

    # ── Monster/NPC ──
    '적':          ('몬스터', 'npc'),
    '적군':        ('몬스터', 'npc'),
    '보스':        ('몬스터', '레이드보스'),
    '몹':          ('몬스터', 'npc'),

    # ── Crafting ──
    '조합':        ('레시피', '크래프팅'),
    '제작':        ('레시피', '크래프팅'),

    # ── Awakening ──
    '각성':        ('성장', '강화'),
    '눈뜨기':      ('각성',),

    # ── Safe zone ──
    '세이프존':    ('안전지대', '안전 지대'),
    '안전구역':    ('안전지대', '안전 지대'),
    '안전지대':    ('안전 지대', '세이프존'),

    # ── Ultimate ──
    '얼티밋':      ('궁극기', 'ultimate'),
    '필살기':      ('궁극기',),
    '궁극기':      ('얼티밋', 'ultimate'),
    'ultimate':    ('궁극기', '얼티밋'),

    # ── Onboarding ──
    '온보딩':      ('튜토리얼', '신규 입사자'),
    '신입':        ('신규 입사자', '튜토리얼'),

    # ── Reports/meetings ──
    '리포트':      ('보고', '보고서', '정례보고'),
    '위클리':      ('정례', '주간'),
    '주간보고':    ('정례보고', '정례'),
    '임원':        ('이사장', '의장', '회장'),
    '경영진':      ('이사장', '의장'),

    # ── Outsourcing ──
    '아웃소싱':    ('외주',),
    '협력사':      ('외주',),
    '외주':        ('아웃소싱', '협력사'),

    # ── Game modes ──
    '컨퀘스트':    ('점령전',),
    '점령전':      ('컨퀘스트', 'conquest'),
    'conquest':    ('점령전',),
    '난투전':      ('brawl',),
    'brawl':       ('난투전',),
    '팀전':        ('점령전', '난투전'),
    '레이드':      ('레이드보스',),
    '보스전':      ('레이드보스', '레이드'),

    # ── Art/visual ──
    '일러스트':    ('원화', '컨셉아트'),
    '비주얼':      ('아트',),
    '시네마틱':    ('연출', '컷씬'),
    '컷씬':        ('연출', '시네마틱'),

    # ── Block/voxel ──
    '건축':        ('블록', '복셀', '빌딩'),
    '빌딩':        ('블록', '복셀', '건축'),
    '복셀':        ('블록', '복셀엔진'),

    # ── Design documents ──
    'gdd':         ('기획서', '기획'),
    '스펙':        ('기획', '상세기획'),
    '설계':        ('기획',),
    '데모':        ('시연', '빌드'),
    '프레젠테이션': ('정례보고', '시연'),
    '로드맵':      ('마일스톤', '릴리즈'),

    # ── QA/issues ──
    '버그':        ('이슈', '결함'),
    '이슈':        ('버그', '결함'),
    'qa':          ('테스트', '품질'),

    # ── Rendering ──
    '렌더파이프라인': ('hdrp',),
    '렌더링':      ('hdrp',),
    '렌더':        ('hdrp', '렌더링'),

    # ── Additional mappings (added after 2nd test round) ──
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

    # ── Character English↔Korean mapping ──
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

    # ── English game terms → Korean ──
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

    # ── Loanword spelling variants ──
    '셰이더':      ('쉐이더',),
    '대미지':      ('데미지', 'damage'),
    '데미지':      ('대미지', 'damage'),
    '발란스':      ('밸런스',),
    '이팩트':      ('이펙트', 'effect'),
    '이펙트':      ('이팩트', 'effect'),

    # ── Reverse mappings ──
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
    """Compute the IDF value of each token across the whole corpus.

    IDF = log(1 + (N - df + 0.5) / (df + 0.5))  — BM25 smoothing
    Plain log(N/df) gives IDF=0 to terms that appear in every document, ignoring them entirely,
    and in a single-document corpus every term becomes 0, so searches always return nothing.
    With smoothing, common terms keep a small but positive weight.

    IDF is computed on raw tokens (morphological expansion is applied only on the query side).
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
    """TF-IDF based document score.
    Title, file name and body are weighted differently, with IDF suppressing common words.
    """
    title_lower = doc.title.lower()
    stem_lower  = doc.stem.lower()
    body_lower  = doc.body.lower()
    score = 0.0
    for token in query_tokens:
        idf_val = idf.get(token, 0.0)
        if idf_val <= 0:
            continue  # appears in every document → no discriminative power, skip
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

    # Corpus + IDF are reused with the same TTL as the doc cache (index_ files excluded)
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

    parts = ["## Reference Documents\n"]
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
