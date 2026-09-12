"""
insight_sweep.py — Analyze internal vault documents and generate an insight report

Calls the Claude API directly to detect patterns, contradictions, repeated signals and design gaps.
external-reference documents are excluded automatically (internal documents only).

Usage:
  python insight_sweep.py --vault /path/to/vault/active --api-key sk-ant-xxx
  python insight_sweep.py --vault /path/to/vault/active --api-key sk-ant-xxx --model claude-sonnet-4-6
  python insight_sweep.py --vault /path/to/vault/active --api-key sk-ant-xxx --date-from 2024-01-01
  python insight_sweep.py --vault /path/to/vault/active --api-key sk-ant-xxx --top-n 15 --compare-refs

The Edit Agent can invoke this directly via run_python_tool.
Output: {vault}/_insights/sweep-YYYY-MM-DD.md
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path
from typing import Optional

# ── Configuration ─────────────────────────────────────────────────────────────

DEFAULT_MODEL    = "claude-sonnet-4-6"
MAX_TOKENS       = 4096
MAX_DOC_CHARS    = 2000   # Max characters per document (saves context)
MAX_TOTAL_CHARS  = 80000  # Total context ceiling

SYSTEM_PROMPT = """You are an insight agent that analyzes a game development project vault.

Analysis principles:
1. Do not correct formatting or grammar. Analyze only **meaning, patterns and structure**.
2. State signals that recur across multiple documents together with their counts.
3. Explicitly identify **contradictions or tensions** between documents.
4. **"What is left unsaid"** — point out what should be in the feedback but is missing.
5. **Design gaps** — detect documents or decisions that should exist but do not.
6. Use external reference documents (those carrying the [외부 레퍼런스] marker) only as comparison context;
   never describe them as if they were internal project patterns.

Output format:
- Markdown, structured by section
- Cite the **source document name** for every finding
- Write only what is actually found in the documents, not speculation"""


# ── File collection ───────────────────────────────────────────────────────────

def is_external_reference(content: str) -> bool:
    """Check whether the frontmatter has type: external-reference."""
    if "type: external-reference" in content[:500]:
        return True
    if "[외부 레퍼런스]" in content[:300]:
        return True
    return False


def collect_docs(vault_path: str, date_from: Optional[str], top_n: int,
                 include_refs: bool) -> list[dict]:
    """
    Collect the documents to analyze from the vault.
    Priority: feedback/meeting notes > specs > references
    external-reference docs are included only when include_refs=True (appended at the end for comparison).
    """
    vault = Path(vault_path)
    md_files = list(vault.rglob("*.md"))

    # Exclude the _insights/ folder itself
    md_files = [f for f in md_files if "_insights" not in f.parts]

    docs = []
    ref_docs = []

    for f in md_files:
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        if not content.strip():
            continue

        # date_from filter (date in filename or frontmatter date)
        # Documents whose date cannot be extracted are out of range, so exclude them
        if date_from:
            doc_date = _extract_date(f.name, content)
            if doc_date is None or doc_date < date_from:
                continue

        is_ext = is_external_reference(content)

        entry = {
            "filename": f.name,
            "relpath":  str(f.relative_to(vault)),
            "content":  content[:MAX_DOC_CHARS],
            "size":     len(content),
            "mtime":    f.stat().st_mtime,
            "is_ext":   is_ext,
        }

        if is_ext:
            ref_docs.append(entry)
        else:
            docs.append(entry)

    # Priority sort: feedback/meeting notes > specs > everything else (newest first)
    def priority(d: dict) -> tuple:
        name = d["filename"].lower()
        if "피드백" in name or "feedback" in name:
            return (0, -d["mtime"])
        if "회의록" in name or "정례" in name or "meeting" in name:
            return (1, -d["mtime"])
        if "기획" in name or "제안" in name or "spec" in name:
            return (2, -d["mtime"])
        return (3, -d["mtime"])

    docs.sort(key=priority)
    selected = docs[:top_n]

    # Append at most 5 external references at the end for comparison context
    if include_refs and ref_docs:
        selected += ref_docs[:5]

    return selected


def _extract_date(filename: str, content: str) -> Optional[str]:
    """Extract the date from the filename or frontmatter (YYYY-MM-DD format)."""
    # Filename patterns: [2026_03_11], 2026-03-11, 20260311
    m = re.search(r"(\d{4})[._\-](\d{2})[._\-](\d{2})", filename)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    # frontmatter date:
    m = re.search(r"^date:\s*(\d{4}-\d{2}-\d{2})", content[:300], re.MULTILINE)
    if m:
        return m.group(1)
    return None


# ── Claude API call ───────────────────────────────────────────────────────────

def call_claude(api_key: str, model: str, system: str, user: str) -> str:
    payload = json.dumps({
        "model":      model,
        "max_tokens": MAX_TOKENS,
        "system":     system,
        "messages":   [{"role": "user", "content": user}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "Content-Type":      "application/json",
            "x-api-key":         api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["content"][0]["text"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Claude API error {e.code}: {body[:300]}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Claude API network error: {e.reason}")


# ── Report generation ─────────────────────────────────────────────────────────

def build_user_prompt(docs: list[dict], date_from: Optional[str], include_refs: bool) -> str:
    lines = []

    # Analysis instructions
    lines.append("## Analysis instructions")
    lines.append("")
    lines.append("Analyze the documents below and write an insight report with the following sections:")
    lines.append("")
    lines.append("1. **Repeated signals** — patterns, concerns and requests that recur across documents (state counts)")
    lines.append("2. **Contradictions and tensions** — conflicting content or directions")
    lines.append("3. **What is left unsaid** — areas where an expected discussion is missing")
    lines.append("4. **Design gaps** — documents or decisions that should exist but do not")
    lines.append("5. **Top 3 key insights** — summary of the findings that deserve the most attention")
    if include_refs:
        lines.append("6. **Comparison with external games** — notable differences versus the _reference/games/ documents (if any)")
    lines.append("")
    if date_from:
        lines.append(f"> Analysis scope: only documents from {date_from} onward (prevents contamination from data predating the game design change)")
        lines.append("")

    # Document list
    internal = [d for d in docs if not d["is_ext"]]
    external = [d for d in docs if d["is_ext"]]

    lines.append(f"## Internal documents ({len(internal)})")
    lines.append("")

    total_chars = 0
    for d in internal:
        if total_chars + len(d["content"]) > MAX_TOTAL_CHARS:
            lines.append(f"_(remaining documents omitted due to the context limit)_")
            break
        lines.append(f"### [{d['relpath']}]")
        lines.append("")
        lines.append(d["content"])
        lines.append("")
        lines.append("---")
        lines.append("")
        total_chars += len(d["content"])

    if external:
        lines.append(f"## External reference documents ({len(external)}) — comparison context only")
        lines.append("")
        lines.append("> ⚠️ The documents below are data about externally released games. Do not confuse them with internal patterns.")
        lines.append("")
        for d in external:
            ref_content = d["content"][:1000]  # Keep external references short
            if total_chars + len(ref_content) > MAX_TOTAL_CHARS:
                lines.append(f"_(remaining external reference documents omitted due to the context limit)_")
                break
            lines.append(f"### [{d['filename']}]")
            lines.append("")
            lines.append(ref_content)
            lines.append("")
            lines.append("---")
            lines.append("")
            total_chars += len(ref_content)

    return "\n".join(lines)


def build_report(insight_text: str, docs: list[dict], args) -> str:
    today     = date.today().isoformat()
    now       = datetime.now().strftime("%Y-%m-%d %H:%M")
    n_int     = sum(1 for d in docs if not d["is_ext"])
    n_ext     = sum(1 for d in docs if d["is_ext"])

    header = [
        "---",
        "type: insight-report",
        f"date: {today}",
        f"model: {args.model}",
        f"analyzed_docs: {n_int}",
        f"ref_docs: {n_ext}",
        f"date_from: {args.date_from or 'all'}",
        "internal: true",
        "---",
        "",
        f"# 인사이트 스윕 — {today}",
        "",
        f"> 생성: {now} | 모델: {args.model} | 분석 문서: {n_int}개 내부 + {n_ext}개 외부 레퍼런스",
        f"> 분석 범위: {args.date_from + ' 이후' if args.date_from else '전체'}",
        "",
        "---",
        "",
    ]

    return "\n".join(header) + insight_text


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Vault insight sweep — detect patterns, contradictions and gaps")
    parser.add_argument("--vault",       required=True,                help="Path to the vault active folder")
    parser.add_argument("--api-key",     default="",                   help="Anthropic API key (falls back to the ANTHROPIC_API_KEY environment variable)")
    parser.add_argument("--model",       default=DEFAULT_MODEL,        help=f"Model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--top-n",       type=int, default=20,         help="Number of internal documents to analyze (default: 20)")
    parser.add_argument("--date-from",   default="",                   help="Analyze only documents from this date onward (YYYY-MM-DD, default: all)")
    parser.add_argument("--compare-refs", action="store_true",         help="Also include external reference documents as comparison context")
    parser.add_argument("--output",      default="",                   help="Output file path (default: vault/_insights/sweep-YYYY-MM-DD.md)")
    parser.add_argument("--verbose",     action="store_true",          help="Verbose output")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("Error: --api-key or the ANTHROPIC_API_KEY environment variable is required.", file=sys.stderr)
        sys.exit(1)

    vault_path = os.path.abspath(args.vault)
    if not os.path.isdir(vault_path):
        print(f"Error: vault path not found: {vault_path}", file=sys.stderr)
        sys.exit(1)

    date_from = args.date_from.strip() or None

    print(f"[insight_sweep] Collecting documents... (date_from={date_from or 'all'})")
    docs = collect_docs(vault_path, date_from, args.top_n, args.compare_refs)
    n_int = sum(1 for d in docs if not d["is_ext"])
    n_ext = sum(1 for d in docs if d["is_ext"])
    print(f"  → {n_int} internal documents, {n_ext} external references")

    if n_int == 0:
        print("No internal documents to analyze.", file=sys.stderr)
        sys.exit(1)

    if args.verbose:
        for d in docs:
            tag = "[EXT]" if d["is_ext"] else "     "
            print(f"  {tag} {d['relpath']} ({d['size']:,} chars)")

    print(f"[insight_sweep] Calling Claude API (model: {args.model})...")
    user_prompt = build_user_prompt(docs, date_from, args.compare_refs)

    try:
        insight_text = call_claude(api_key, args.model, SYSTEM_PROMPT, user_prompt)
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    report = build_report(insight_text, docs, args)

    # Determine the output path
    if args.output:
        out_path = args.output
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    else:
        insights_dir = os.path.join(vault_path, "_insights")
        os.makedirs(insights_dir, exist_ok=True)
        out_path = os.path.join(insights_dir, f"sweep-{date.today().isoformat()}.md")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"[insight_sweep] Done → {out_path}")
    # Also print to stdout so the Edit Agent can read the result path
    print(f"INSIGHT_OUTPUT={out_path}")


if __name__ == "__main__":
    main()
