"""
graph_expand.py — wikilink 기반 컨텍스트 확장 (Phase 3)

top-K 리트리벌 결과의 wikilink 를 코인용(co-citation) 기준으로 랭킹해
관련 문서 2개 내외를 컨텍스트에 추가한다.
링크 빈도 × 입링크(in-degree) 보너스 → 볼트 내 중요 문서를 우선.

의존성: rag_simple._get_cached_docs, vault_scanner.get_wikilinks
"""
from __future__ import annotations
import logging
import re
import time
from collections import Counter

logger = logging.getLogger(__name__)

# link-in degree 캐시 — (vault_path, ts, dict[stem_lower, indegree])
_indegree_cache: dict = {}
_INDEGREE_TTL = 3600.0  # 1시간

# 확장 동작 파라미터
MAX_EXPAND_DOCS = 2        # top-K 기준 몇 개 추가할지
MIN_CO_CITATION = 2        # 최소 몇 개의 top-K 문서가 공통으로 링크해야 후보
EXPAND_SCORE_WEIGHT = 0.5  # 원본 점수 대비 확장 문서 가중치


def _build_indegree(docs) -> dict[str, int]:
    """볼트 전체 스캔해 stem → in-degree 맵 빌드."""
    from .vault_scanner import get_wikilinks
    deg: Counter = Counter()
    for d in docs:
        for link in get_wikilinks(d.raw or d.body or ""):
            stem = link.strip().lower()
            if stem:
                deg[stem] += 1
    return dict(deg)


def _get_indegree(vault_path: str) -> dict[str, int]:
    """in-degree 맵을 TTL 캐시로 반환. 실패 시 빈 dict."""
    now = time.time()
    hit = _indegree_cache.get(vault_path)
    if hit and now - hit[0] < _INDEGREE_TTL:
        return hit[1]
    try:
        from .rag_simple import _get_cached_docs
        docs = _get_cached_docs(vault_path)
        indeg = _build_indegree(docs)
        _indegree_cache[vault_path] = (now, indeg)
        return indeg
    except Exception as e:
        logger.warning("[graph_expand] indegree 빌드 실패: %s", e)
        return {}


def _find_doc_by_stem(vault_path: str, target_stem: str):
    """stem 매칭으로 VaultDoc 찾기 (case-insensitive 완전 일치 우선, 실패 시 부분 일치)."""
    try:
        from .rag_simple import _get_cached_docs
        docs = _get_cached_docs(vault_path)
    except Exception:
        return None
    target_lower = target_stem.strip().lower()
    if not target_lower:
        return None
    # 1. 완전 일치
    for d in docs:
        if d.stem.lower() == target_lower:
            return d
    # 2. 부분 일치 (target 이 stem 의 부분 문자열)
    for d in docs:
        if target_lower in d.stem.lower() and len(target_lower) >= 4:
            return d
    return None


def expand_via_wikilinks(
    results: list[dict],
    vault_path: str,
    top_consider: int = 3,
    max_expand: int = MAX_EXPAND_DOCS,
    log_fn=None,
) -> list[dict]:
    """
    results 의 상위 `top_consider` 개 문서의 wikilink 를 분석하여
    `max_expand` 개 관련 문서를 `results` 끝에 추가한 새 리스트를 반환한다.

    - co-citation ≥ MIN_CO_CITATION 후보를 우선
    - 같은 빈도면 in-degree 높은 쪽 우선
    - 이미 결과에 있는 stem, 대상 문서 자신의 stem 제외
    - 추가 문서의 score 는 원본 top3 평균 × EXPAND_SCORE_WEIGHT
    """
    if not results or not vault_path:
        return results

    _log = log_fn if log_fn else (lambda m: None)

    from .vault_scanner import get_wikilinks

    top = results[:top_consider]
    existing_stems = {(r.get("stem") or "").lower() for r in results}

    # 각 top 문서에서 wikilinks 추출, 집계
    link_counter: Counter = Counter()
    for r in top:
        body = r.get("body") or ""
        links = get_wikilinks(body)
        # 자기 자신 제외 + 중복 없이 set 으로
        for link in set(links):
            stem = link.strip().lower()
            if not stem or stem == (r.get("stem") or "").lower():
                continue
            # wikilink 에 `|display` 분리된 경우 get_wikilinks 가 이미 앞부분만 반환
            # 파일명 중첩이면 # 또는 / 제거
            stem = re.sub(r'[#/].*$', '', stem).strip()
            if stem and stem not in existing_stems:
                link_counter[stem] += 1

    if not link_counter:
        return results

    indegree = _get_indegree(vault_path)

    # (count, indegree, stem) 내림차순 정렬
    ranked = sorted(
        link_counter.items(),
        key=lambda kv: (-kv[1], -indegree.get(kv[0], 0), kv[0]),
    )

    # 상위 max_expand 개 중 실제 문서 찾기
    avg_top_score = sum(r.get("score", 0) for r in top) / max(len(top), 1)
    expand_score = avg_top_score * EXPAND_SCORE_WEIGHT

    added: list[dict] = []
    for stem, cnt in ranked:
        if len(added) >= max_expand:
            break
        if cnt < MIN_CO_CITATION and len(added) >= 1:
            # 이미 하나라도 co-citation≥2 로 추가했다면 나머지는 co-citation<2 추가 중단
            # 첫 번째는 co-citation=1 이어도 in-degree 높으면 허용
            break
        doc = _find_doc_by_stem(vault_path, stem)
        if not doc:
            continue
        if doc.stem.lower() in existing_stems:
            continue
        added.append({
            "title": doc.title or doc.stem,
            "stem": doc.stem,
            "body": (doc.body or "").strip()[:3000],  # 확장 문서는 본문 더 짧게
            "score": expand_score,
            "date": doc.date_str,
            "tags": doc.tags,
            "doc_type": doc.doc_type,
            "_expanded": True,
            "_expand_reason": f"co-citation={cnt}, indegree={indegree.get(stem, 0)}",
        })
        existing_stems.add(doc.stem.lower())

    if added:
        _log(f"[그래프확장] +{len(added)}건 ({', '.join(a['stem'] for a in added)})")
    return results + added
