#!/usr/bin/env python3
"""
enhance_wikilinks.py — §7 Wikilink primary enhancement
- §7.1 Cluster links injected: creates a ## 관련 문서 (related documents) section between files sharing tags
- §7.2 Title matching links: other files' title text in the body -> [[wikilink]] conversion
       (placeholder approach required — prevents v1 bug)

Usage:
  python enhance_wikilinks.py <active_dir> [--max-cluster 8]
"""

import re
import sys
import argparse
from pathlib import Path
from collections import defaultdict


def parse_tags(content: str) -> list:
    """Parse frontmatter tags field."""
    m = re.search(r'tags:\s*\[([^\]]*)\]', content[:500])
    if not m:
        return []
    raw = m.group(1)
    return [t.strip() for t in raw.split(',') if t.strip()]


def get_stem_title_map(active_dir: Path) -> dict:
    """Build the stem -> (title, tags) mapping."""
    result = {}
    for md in active_dir.glob('*.md'):
        try:
            content = md.read_text(encoding='utf-8', errors='replace')[:600]
        except:
            continue
        m_title = re.search(r'title:\s*"?([^"\n]+)"?', content)
        title = m_title.group(1).strip("'\"") if m_title else md.stem
        tags = parse_tags(content)
        result[md.stem] = (title, tags, md)
    return result


def cluster_links(active_dir: Path, max_per_cluster: int = 8):
    """§7.1 Inject cluster links between files sharing the same tags."""
    print("Building cluster links...")
    stem_map = get_stem_title_map(active_dir)

    # Tag -> list of files
    tag_files = defaultdict(list)
    for stem, (title, tags, path) in stem_map.items():
        for tag in tags:
            if tag not in ('hub', 'generated'):  # Exclude hub/generated tags
                tag_files[tag].append(stem)

    injected = 0
    skipped = 0

    for md in sorted(active_dir.glob('*.md')):
        try:
            content = md.read_text(encoding='utf-8', errors='replace')
        except:
            continue

        stem = md.stem
        tags = parse_tags(content)
        if not tags:
            continue

        # Collect related files (shared tags, excluding self)
        related = set()
        for tag in tags:
            peers = tag_files.get(tag, [])
            for peer in peers:
                if peer != stem:
                    related.add(peer)

        # If too many, limit to most recent by date
        if len(related) > max_per_cluster:
            # Sort by date (dates not available in stem_map, approximate by filename)
            related = set(sorted(related, reverse=True)[:max_per_cluster])

        if not related:
            skipped += 1
            continue

        # If ## Related Documents section exists, merge with existing links
        new_links = [f"- [[{r}]]" for r in sorted(related)]
        new_links_text = '\n'.join(new_links)

        if '## 관련 문서' in content:
            # Add new links to existing section (deduplicated)
            existing_links = set(re.findall(r'\[\[([^\]]+)\]\]', content))
            filtered_new = [f"- [[{r}]]" for r in sorted(related)
                           if r not in existing_links]
            if not filtered_new:
                skipped += 1
                continue
            content = content.rstrip() + '\n' + '\n'.join(filtered_new) + '\n'
        else:
            content = content.rstrip() + '\n\n## 관련 문서\n\n' + new_links_text + '\n'

        md.write_text(content, encoding='utf-8')
        injected += 1

    print(f"  Cluster links injected: {injected} files")
    print(f"  Skipped (no tags): {skipped} files")
    return injected


def title_match_links(active_dir: Path):
    """
    §7.2 Inject title-matching links.
    When another file's title appears as text in the body, convert it to a [[wikilink]].
    Existing links are protected via placeholders.
    """
    print("\nBuilding title matching links...")
    stem_map = get_stem_title_map(active_dir)

    # Exclude short or too common titles (prevent false positives)
    # Length 8+ chars, excluding digit-only titles
    candidates = {}
    for stem, (title, tags, path) in stem_map.items():
        title_clean = title.strip()
        if len(title_clean) >= 8 and not title_clean.isdigit():
            candidates[title_clean] = stem

    # Sort by length descending (match longer titles first)
    sorted_candidates = sorted(candidates.items(), key=lambda x: -len(x[0]))

    injected = 0

    for md in sorted(active_dir.glob('*.md')):
        try:
            content = md.read_text(encoding='utf-8', errors='replace')
        except:
            continue

        current_stem = md.stem

        # Separate frontmatter
        fm_end = content.find('\n---\n', 4)
        if fm_end == -1:
            body = content
            fm = ''
        else:
            fm = content[:fm_end + 5]
            body = content[fm_end + 5:]

        # Step 1: Replace existing [[...]] links with placeholders
        placeholders = {}
        ph_counter = [0]

        def replace_wlink(m):
            ph_counter[0] += 1
            key = f'\x00WLINK{ph_counter[0]}\x00'
            placeholders[key] = m.group(0)
            return key

        body_protected = re.sub(r'\[\[[^\]]+\]\]', replace_wlink, body)

        # Step 2: Protect code blocks too
        code_placeholders = {}
        code_counter = [0]

        def replace_code(m):
            code_counter[0] += 1
            key = f'\x00CODE{code_counter[0]}\x00'
            code_placeholders[key] = m.group(0)
            return key

        body_protected = re.sub(r'```.*?```', replace_code, body_protected, flags=re.DOTALL)
        body_protected = re.sub(r'`[^`]+`', replace_code, body_protected)

        # Step 3: Title matching (excluding the current file's own title)
        changed = False
        for title, stem in sorted_candidates:
            if stem == current_stem:
                continue
            # Skip if already linked (protected by placeholder)
            # Replace only the first occurrence
            # Boundary condition: not preceded/followed by a letter/digit
            pattern = r'(?<![가-힣\w\[])\Q' + re.escape(title) + r'\E(?![가-힣\w\]])'
            if re.search(re.escape(title), body_protected):
                new_link = f'[[{stem}|{title}]]'
                body_protected, count = re.subn(
                    re.escape(title),
                    new_link,
                    body_protected,
                    count=1  # First occurrence only
                )
                if count > 0:
                    changed = True

        if changed:
            # Step 4: Restore placeholders
            for key, orig in code_placeholders.items():
                body_protected = body_protected.replace(key, orig)
            for key, orig in placeholders.items():
                body_protected = body_protected.replace(key, orig)

            md.write_text(fm + body_protected, encoding='utf-8')
            injected += 1

    print(f"  Title matching links injected: {injected} files")
    return injected


def main():
    parser = argparse.ArgumentParser(description='Wikilink primary enhancement (§7)')
    parser.add_argument('active_dir', help='active/ folder')
    parser.add_argument('--max-cluster', type=int, default=8,
                        help='Max links per cluster (default: 8)')
    parser.add_argument('--skip-title-match', action='store_true',
                        help='Skip title matching link injection')
    args = parser.parse_args()

    active_dir = Path(args.active_dir)

    # §7.1 Cluster links
    n1 = cluster_links(active_dir, args.max_cluster)

    # §7.2 Title matching links
    if not args.skip_title_match:
        n2 = title_match_links(active_dir)
    else:
        n2 = 0

    print(f"\n=== §7 Wikilink primary enhancement Complete ===")
    print(f"  Cluster links:     {n1} files")
    print(f"  Title matching:    {n2} files")


if __name__ == '__main__':
    main()
