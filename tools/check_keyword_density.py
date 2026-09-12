#!/usr/bin/env python3
"""
check_keyword_density.py — §9.6 KEYWORD_MAP density monitoring

Pre-check what % of documents each keyword will be injected into before running inject_keywords.py.
Output warning for keywords exceeding the threshold (default 15%).

Usage:
  python check_keyword_density.py <active_dir> [--threshold 15]
"""

import re
import sys
import argparse
from pathlib import Path

# Shared KEYWORD_MAP — imported from inject_keywords.py
try:
    import importlib.util
    _spec = importlib.util.spec_from_file_location(
        'inject_keywords',
        Path(__file__).parent / 'inject_keywords.py',
    )
    _mod = importlib.util.module_from_spec(_spec)   # type: ignore[arg-type]
    _spec.loader.exec_module(_mod)                  # type: ignore[union-attr]
    KEYWORD_MAP: dict[str, str] = _mod.KEYWORD_MAP
except Exception as e:
    print(f"Error: cannot load inject_keywords.py — {e}")
    sys.exit(1)


def split_frontmatter(content: str) -> tuple[str, str]:
    if content.startswith('---'):
        end = content.find('\n---\n', 4)
        if end != -1:
            return content[:end + 5], content[end + 5:]
    return '', content


def check_density(active_dir: Path, threshold: float = 15.0) -> None:
    md_files = list(active_dir.glob('*.md'))
    total = len(md_files)
    if total == 0:
        print("Error: no .md files found.")
        sys.exit(1)

    # Count files where each keyword appears
    counts: dict[str, int] = {kw: 0 for kw in KEYWORD_MAP}
    patterns: dict[str, re.Pattern] = {}
    for kw in KEYWORD_MAP:
        esc = re.escape(kw)
        patterns[kw] = re.compile(rf'(?<![가-힣\w]){esc}(?![가-힣\w])')

    for md in md_files:
        try:
            content = md.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue
        _, body = split_frontmatter(content)
        for kw, pat in patterns.items():
            if pat.search(body):
                counts[kw] += 1

    # Calculate ratios and sort (descending)
    results: list[tuple[str, str, float]] = []
    for kw, target in KEYWORD_MAP.items():
        pct = counts[kw] / total * 100
        results.append((kw, target, pct))
    results.sort(key=lambda x: -x[2])

    # Output
    print("=" * 65)
    print(f"§9.6 KEYWORD_MAP density check (threshold: {threshold:.0f}%, {total} files total)")
    print("=" * 65)

    warnings: list[tuple[str, float]] = []
    BAR_WIDTH = 20

    print(f"\n{'Keyword':<14} {'Rate%':>6}  {'Bar':<{BAR_WIDTH}}  Target stem")
    print("-" * 65)
    for kw, target, pct in results:
        bar_len = int(pct / 100 * BAR_WIDTH)
        bar = '█' * bar_len + '░' * (BAR_WIDTH - bar_len)
        flag = ' ⚠️ ' if pct >= threshold else '    '
        stem_short = target[:35] + ('…' if len(target) > 35 else '')
        print(f"{kw:<14} {pct:5.1f}%  {bar}  {stem_short}{flag}")
        if pct >= threshold:
            warnings.append((kw, pct))

    print()
    if warnings:
        print(f"⚠️  Keywords above threshold ({threshold:.0f}%): {len(warnings)}")
        for kw, pct in warnings:
            print(f"   '{kw}' ({pct:.1f}%) — consider removing before running inject_keywords.py")
        print()
        print("※ Removal criterion: remove generic terms that carry no distinct hub meaning.")
        print("  Keep proper nouns and character names even at high rates, as they are required for BFS traversal.")
    else:
        print(f"✅ All keywords below threshold — inject_keywords.py can be run")


def main():
    parser = argparse.ArgumentParser(description='§9.6 KEYWORD_MAP density monitor')
    parser.add_argument('active_dir', help='active/ folder path')
    parser.add_argument('--threshold', type=float, default=15.0,
                        help='Warning threshold %% (default: 15)')
    args = parser.parse_args()

    active_dir = Path(args.active_dir)
    if not active_dir.is_dir():
        print(f"Error: {active_dir} folder not found.")
        sys.exit(1)

    check_density(active_dir, threshold=args.threshold)


if __name__ == '__main__':
    main()
