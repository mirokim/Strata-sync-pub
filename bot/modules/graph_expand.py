"""
graph_expand.py — wikilink-based context expansion (Phase 3)

Ranks the wikilinks of the top-K retrieval results by co-citation and
adds around 2 related documents to the context.
Link frequency x in-degree bonus → prioritizes important documents in the vault.

Dependencies: rag_simple._get_cached_docs, vault_scanner.get_wikilinks
"""
from __future__ import annotations
import logging
import re
import time
from collections import Counter

logger = logging.getLogger(__name__)

# link-in degree cache — (vault_path, ts, dict[stem_lower, indegree])
_indegree_cache: dict = {}
_INDEGREE_TTL = 3600.0  # 1 hour

# Expansion behaviour parameters
MAX_EXPAND_DOCS = 2        # How many docs to add on top of top-K
MIN_CO_CITATION = 2        # Minimum number of top-K docs that must share a link for a candidate
EXPAND_SCORE_WEIGHT = 0.5  # Weight of expanded docs relative to the original score


def _build_indegree(docs) -> dict[str, int]:
    """Scan the whole vault and build a stem → in-degree map."""
    from .vault_scanner import get_wikilinks
    deg: Counter = Counter()
    for d in docs:
        for link in get_wikilinks(d.raw or d.body or ""):
            stem = link.strip().lower()
            if stem:
                deg[stem] += 1
    return dict(deg)


def _get_indegree(vault_path: str) -> dict[str, int]:
    """Return the in-degree map from a TTL cache. Empty dict on failure."""
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
        logger.warning("[graph_expand] indegree build failed: %s", e)
        return {}


def _find_doc_by_stem(vault_path: str, target_stem: str):
    """Find a VaultDoc by stem (case-insensitive exact match first, then partial match)."""
    try:
        from .rag_simple import _get_cached_docs
        docs = _get_cached_docs(vault_path)
    except Exception:
        return None
    target_lower = target_stem.strip().lower()
    if not target_lower:
        return None
    # 1. Exact match
    for d in docs:
        if d.stem.lower() == target_lower:
            return d
    # 2. Partial match (target is a substring of the stem)
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
    Analyze the wikilinks of the top `top_consider` documents in results and
    return a new list with up to `max_expand` related documents appended to `results`.

    - Candidates with co-citation ≥ MIN_CO_CITATION come first
    - On equal frequency, higher in-degree wins
    - Stems already in the results and each source document's own stem are excluded
    - Added documents get score = average of the original top3 x EXPAND_SCORE_WEIGHT
    """
    if not results or not vault_path:
        return results

    _log = log_fn if log_fn else (lambda m: None)

    from .vault_scanner import get_wikilinks

    top = results[:top_consider]
    existing_stems = {(r.get("stem") or "").lower() for r in results}

    # Extract and tally wikilinks from each top document
    link_counter: Counter = Counter()
    for r in top:
        body = r.get("body") or ""
        links = get_wikilinks(body)
        # Exclude self + dedupe via set
        for link in set(links):
            stem = link.strip().lower()
            if not stem or stem == (r.get("stem") or "").lower():
                continue
            # When the wikilink has a `|display` part, get_wikilinks already returns only the front part
            # For nested file names, strip # or /
            stem = re.sub(r'[#/].*$', '', stem).strip()
            if stem and stem not in existing_stems:
                link_counter[stem] += 1

    if not link_counter:
        return results

    indegree = _get_indegree(vault_path)

    # Sort by (count, indegree, stem) descending
    ranked = sorted(
        link_counter.items(),
        key=lambda kv: (-kv[1], -indegree.get(kv[0], 0), kv[0]),
    )

    # Find actual documents among the top max_expand
    avg_top_score = sum(r.get("score", 0) for r in top) / max(len(top), 1)
    expand_score = avg_top_score * EXPAND_SCORE_WEIGHT

    added: list[dict] = []
    for stem, cnt in ranked:
        if len(added) >= max_expand:
            break
        if cnt < MIN_CO_CITATION and len(added) >= 1:
            # Once at least one doc was added with co-citation≥2, stop adding co-citation<2 ones
            # The first one is allowed even with co-citation=1 if its in-degree is high
            break
        doc = _find_doc_by_stem(vault_path, stem)
        if not doc:
            continue
        if doc.stem.lower() in existing_stems:
            continue
        added.append({
            "title": doc.title or doc.stem,
            "stem": doc.stem,
            "body": (doc.body or "").strip()[:3000],  # Shorter body for expanded docs
            "score": expand_score,
            "date": doc.date_str,
            "tags": doc.tags,
            "doc_type": doc.doc_type,
            "_expanded": True,
            "_expand_reason": f"co-citation={cnt}, indegree={indegree.get(stem, 0)}",
        })
        existing_stems.add(doc.stem.lower())

    if added:
        _log(f"[GraphExpand] +{len(added)} ({', '.join(a['stem'] for a in added)})")
    return results + added
