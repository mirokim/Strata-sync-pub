"""
multi_agent_rag.py — Parallel sub-agent document analysis + main agent review

Flow:
  1. Top N search results → parallel sub-agent execution (each handles 1 document)
  2. Each sub-agent: document relevance score (0-10) + key summary + key points
  3. Main agent reviews the highest-scoring document with full content
  4. All summaries + best document analysis → final RAG context string
"""
import hashlib
import json
import logging
import os
import time
import threading
from pathlib import Path
from typing import Callable, TypedDict

from .claude_client import ClaudeClient
from .rag_simple import RagResult
from .paths import RAG_CHECKPOINTS_DIR

logger = logging.getLogger(__name__)


class SubAgentResult(TypedDict):
    idx: int
    doc: RagResult
    score: float
    summary: str
    key_points: list[str]

# ── Sub-agent checkpoints (based on MiroFish realtime_output pattern) ─────────
# Save analysis results to file in real-time → skip already-analyzed docs on restart.

_CHECKPOINT_DIR = RAG_CHECKPOINTS_DIR
_CHECKPOINT_TTL_SECS = 86400  # 24-hour TTL (supports resuming long simulations)
_CHECKPOINT_MAX_MB = 10        # LRU cleanup threshold

# Overall sub-agent wait cap (a total deadline, not per-thread)
_SUB_AGENT_TIMEOUT = 35.0

# Prevent concurrent save / _clear_stale_checkpoints access (avoids a race where LRU deletion hits a tmp file mid-rename)
_CHECKPOINT_LOCK = threading.Lock()


def _make_checkpoint_key(query: str, stems: list[str]) -> str:
    key = query + "|" + ",".join(sorted(stems))
    return hashlib.md5(key.encode()).hexdigest()[:12]


def _doc_key(doc: RagResult) -> str:
    """Document identifier for checkpoint matching.

    The checkpoint key (_make_checkpoint_key) sorts stems and is order-independent,
    but matching the payload by positional index attaches cached analyses to the
    wrong documents when the order changes (e.g. hotness re-ranking). Use the doc id (stem).
    """
    return str(doc.get("stem") or doc.get("title") or "")


def _load_checkpoint(key: str) -> list[dict]:
    path = os.path.join(_CHECKPOINT_DIR, f"{key}.json")
    try:
        if not os.path.exists(path):
            return []
        if time.time() - os.path.getmtime(path) > _CHECKPOINT_TTL_SECS:
            os.remove(path)
            return []
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _save_checkpoint(key: str, analyses: list[dict]) -> None:
    try:
        os.makedirs(_CHECKPOINT_DIR, exist_ok=True)
        path = os.path.join(_CHECKPOINT_DIR, f"{key}.json")
        tmp_path = path + ".tmp"
        # Exclude doc body from save (size savings) — only save identifier/score/summary/key_points.
        # Saving by doc_key (document id) keeps restores attached to the right document even if the order changes.
        slim = [
            {"doc_key": _doc_key(a.get("doc") or {}), "idx": a["idx"], "score": a["score"],
             "summary": a["summary"], "key_points": a["key_points"]}
            for a in analyses
        ]
        # write → rename atomic save, sharing the Lock with LRU cleanup
        with _CHECKPOINT_LOCK:
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(slim, f, ensure_ascii=False)
            os.replace(tmp_path, path)
    except OSError as e:
        logger.error("Checkpoint save failed (key=%s): %s", key, e)


def _clear_stale_checkpoints() -> None:
    """Delete files exceeding TTL + LRU cleanup when directory exceeds size limit.

    Guarded by the same Lock as _save_checkpoint — protects the tmp file's mid-rename state.
    """
    try:
        if not os.path.isdir(_CHECKPOINT_DIR):
            return
        with _CHECKPOINT_LOCK:
            files = sorted(
                Path(_CHECKPOINT_DIR).glob("*.json"),
                key=lambda f: f.stat().st_mtime,
            )
            now = time.time()
            # 1) Delete TTL-expired files
            surviving = []
            for f in files:
                if now - f.stat().st_mtime > _CHECKPOINT_TTL_SECS:
                    f.unlink()
                else:
                    surviving.append(f)
            # 2) LRU delete oldest first when over size limit
            limit = _CHECKPOINT_MAX_MB * 1024 * 1024
            total = sum(f.stat().st_size for f in surviving)
            for f in surviving:
                if total <= limit:
                    break
                total -= f.stat().st_size
                f.unlink()
    except OSError as e:
        logger.warning("Checkpoint cleanup failed: %s", e)


_SUB_AGENT_SYSTEM = "Game development document relevance evaluation expert. Output JSON only."

_MAIN_REVIEW_SYSTEM = (
    "Game development knowledge analyst. Synthesize document analysis results to construct key insights and context needed for the question. "
    "Actively derive connections, patterns, and important facts across documents."
)


def _analyze_doc(
    client: ClaudeClient,
    query: str,
    doc: RagResult,
    idx: int,
    results: list[SubAgentResult],
    lock: threading.Lock,
    log_fn: Callable[[str], None] | None = None,
) -> None:
    """Sub-agent: analyze a single document against the query."""
    title = doc.get("title", "")
    body = doc.get("body", "")[:1400]

    user_prompt = (
        f"Q: {query}\n"
        f"Title: {title} | Date: {doc.get('date', '')} | Tags: {', '.join(doc.get('tags') or [])}\n"
        f"Content:\n{body}\n\n"
        'JSON: {"score":0~10, "summary":"key summary 2-3 lines", "key_points":["","",""]}'
    )

    score = 0.0
    summary = ""
    key_points: list[str] = []

    _MAX_RETRIES = 2
    for attempt in range(_MAX_RETRIES + 1):
        try:
            raw = client.complete(_SUB_AGENT_SYSTEM, user_prompt, max_tokens=400)
            # Remove markdown code blocks
            if "```" in raw:
                parts = raw.split("```")
                if len(parts) > 1:
                    raw = parts[1].lstrip("json").strip()
            # Extract JSON object only
            start = raw.find("{")
            end = raw.rfind("}") + 1
            if start >= 0 and end > start:
                raw = raw[start:end]
            data = json.loads(raw)
            score = float(data.get("score", 0))
            summary = data.get("summary", "")
            key_points = data.get("key_points", [])
            break  # Success
        except json.JSONDecodeError as e:
            # JSON parse failure — no point retrying, fall back immediately
            if log_fn:
                log_fn(f"[Sub-agent #{idx}] JSON parse failed: {e}")
            logger.warning("[Sub-agent #%d] JSON parse failed (attempt %d): %s", idx, attempt + 1, e)
            break
        except (ConnectionError, TimeoutError, OSError) as e:
            # Network/IO error — retry
            logger.warning("[Sub-agent #%d] Network error (attempt %d/%d): %s", idx, attempt + 1, _MAX_RETRIES + 1, e)
            if attempt < _MAX_RETRIES:
                time.sleep(2 ** attempt)  # Exponential backoff: 1s, 2s
                continue
            if log_fn:
                log_fn(f"[Sub-agent #{idx}] Retries exceeded: {e}")
            break
        except Exception as e:
            logger.exception("[Sub-agent #%d] Unexpected error: %s", idx, e)
            if log_fn:
                log_fn(f"[Sub-agent #{idx}] Error: {e}")
            break

    # Score-based fallback if no valid result
    if not summary:
        raw_score = doc.get("score", 0)
        score = min(float(raw_score) * 0.8, 7.0) if raw_score else 0.0
        summary = body[:150] + ("…" if len(body) > 150 else "")
        key_points = []

    with lock:
        results.append({
            "idx": idx,
            "doc": doc,
            "score": score,
            "summary": summary,
            "key_points": key_points,
        })


def run_sub_agents(
    client: ClaudeClient,
    query: str,
    docs: list[RagResult],
    n_agents: int = 6,
    log_fn: Callable[[str], None] | None = None,
) -> list[SubAgentResult]:
    """
    Run parallel sub-agents on the top n_agents documents from docs.
    Skip already-analyzed documents if checkpoints exist.
    Return results sorted by score in descending order.
    """
    target = docs[:n_agents]
    stems = [d.get("stem", "") for d in target]
    ck_key = _make_checkpoint_key(query, stems)

    # Restore checkpoint — keyed by document id (positional index is fragile under re-ranking)
    cached = _load_checkpoint(ck_key)
    cached_by_key = {c["doc_key"]: c for c in cached if c.get("doc_key")}
    if cached_by_key and log_fn:
        log_fn(f"[Sub-agent] Checkpoint restored: skipping {len(cached_by_key)}/{len(target)}")

    results: list[dict] = []
    lock = threading.Lock()
    threads: list[tuple[threading.Thread, int, RagResult]] = []

    for i, doc in enumerate(target):
        hit = cached_by_key.get(_doc_key(doc))
        if hit:
            entry = dict(hit)
            entry["idx"] = i
            entry["doc"] = doc
            with lock:
                results.append(entry)
            continue
        t = threading.Thread(
            target=_analyze_doc,
            args=(client, query, doc, i, results, lock, log_fn),
            daemon=True,
        )
        threads.append((t, i, doc))
        t.start()

    # Giving each thread a fresh 35s multiplies the total wait by the thread count → use one overall deadline
    deadline = time.time() + _SUB_AGENT_TIMEOUT
    for t, _i, _doc in threads:
        t.join(timeout=max(deadline - time.time(), 0.0))

    # Snapshot under the lock — sorting while a thread that missed the deadline
    # is still appending late would corrupt the list
    with lock:
        collected = list(results)

    # Only keep actually analyzed results in the checkpoint (caching timeout fallbacks
    # would restore the same low-quality summaries on the next run)
    _save_checkpoint(ck_key, collected)
    _clear_stale_checkpoints()

    # Fill documents with no result due to timeout using a search-score fallback (prevents loss)
    done_keys = {_doc_key(a.get("doc") or {}) for a in collected}
    timed_out = 0
    for t, i, doc in threads:
        if not t.is_alive():
            continue
        if _doc_key(doc) in done_keys:
            continue
        timed_out += 1
        raw_score = doc.get("score", 0)
        body = doc.get("body", "")
        collected.append({
            "idx": i,
            "doc": doc,
            "score": min(float(raw_score) * 0.8, 7.0) if raw_score else 0.0,
            "summary": body[:150] + ("…" if len(body) > 150 else ""),
            "key_points": [],
        })
    if timed_out:
        logger.warning("[Sub-agent] %d timed out → score-based fallback", timed_out)
        if log_fn:
            log_fn(f"[Sub-agent] {timed_out} timed out → using search-score fallback")

    collected.sort(key=lambda x: -x["score"])
    return collected


def build_multi_agent_context(
    client: ClaudeClient,
    query: str,
    docs: list[RagResult],
    n_agents: int = 6,
    max_chars: int = 10000,
    log_fn: Callable[[str], None] | None = None,
) -> str:
    """
    Run n_agents sub-agents in parallel → main agent reviews the highest-scoring document.
    Returns the final RAG context string.
    """
    if not docs:
        return ""

    if log_fn:
        log_fn(f"[Sub-agent] Starting parallel analysis of {min(len(docs), n_agents)} documents...")

    analyses = run_sub_agents(client, query, docs, n_agents, log_fn=log_fn)
    if not analyses:
        return ""

    best = analyses[0]
    best_doc = best["doc"]

    if log_fn:
        log_fn(
            f"[Sub-agent] Complete. Best score: {best['score']:.1f}/10 "
            f"— {best_doc.get('title', '')}"
        )
        log_fn("[Main agent] Reviewing highest-scoring document...")

    # Full summary list
    all_summaries = "\n".join(
        f"  [{a['score']:.1f}/10] {a['doc'].get('title', '')}: {a['summary']}"
        for a in analyses
    )

    # Main agent: review full content of highest-scoring document + all summaries to build context
    main_user = (
        f"Q: {query}\n\n"
        f"Analysis results ({len(analyses)} documents):\n"
        f"{all_summaries}\n\n"
        f"━ Most relevant document (relevance {best['score']:.1f}/10) ━\n"
        f"Title: {best_doc.get('title', '')} | Date: {best_doc.get('date', '')}\n"
        f"{best_doc.get('body', '')[:3000]}\n\n"
        "Based on the above:\n"
        "1. Extract key facts and figures directly related to the question\n"
        "2. Identify important connections between documents\n"
        "3. Describe notable insights and patterns"
    )

    try:
        context_review = client.complete(_MAIN_REVIEW_SYSTEM, main_user, max_tokens=1000)
    except Exception as e:
        if log_fn:
            log_fn(f"[Main agent] Error: {e}")
        context_review = f"{best_doc.get('title', '')}: {best['summary']}"

    # Final context assembly
    parts = [
        f"## Multi-Agent Analysis Results ({len(analyses)} documents reviewed)\n\n",
        f"### Main Agent Comprehensive Analysis\n",
        context_review,
        f"\n\n### Sub-Agent Evaluation Summary\n{all_summaries}\n\n",
        "## Reference Document Details\n",
    ]

    total = sum(len(p) for p in parts)

    for a in analyses[:6]:
        doc = a["doc"]
        tag_str = " ".join(f"`{t}`" for t in (doc.get("tags") or []))
        header = (
            f"### [{a['score']:.1f}/10] {doc.get('title', '')} "
            f"({doc.get('date', '')}) {tag_str}\n"
        )
        kp_lines = "\n".join(f"  - {k}" for k in a["key_points"][:3])
        body = doc.get("body", "")
        available = max_chars - total - len(header) - len(kp_lines) - 20
        if available <= 100:
            break
        if len(body) > available:
            body = body[:available] + "…"
        chunk = header + (kp_lines + "\n" if kp_lines else "") + body + "\n\n"
        parts.append(chunk)
        total += len(chunk)

    return "".join(parts)
