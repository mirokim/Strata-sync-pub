#!/usr/bin/env python3
"""
crosslink_jira.py — Jira ↔ Active vault cross-link injection

Creates wikilinks between Jira files (Epic, Release, attachments_md) and the Active vault
to ensure BFS reachability.

Usage:
  python crosslink_jira.py [vault_path] --dry-run   # Preview
  python crosslink_jira.py [vault_path] --apply      # Apply for real
"""

import io
import re
import sys
import argparse
from pathlib import Path
from collections import defaultdict

# Force UTF-8 output on the Windows console
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ── Skip keywords (too generic terms) ────────────────────────────────────
SKIP_TERMS = frozenset({
    '프로젝트', '작업', '이슈', '기획', '개발', '아트', '테스트', '구현',
    '수정', '추가', '관련', '정리', '목록', '문서', '확인', '내용', '결과',
    '진행', 'Complete', '검토', '요청', '반영', '변경', '적용', '정리',
    '필요', '처리', '예정', '참고', '기타', '기능', '상태', '현황',
})

# Confluence ID pattern: prefix starting with digits_
CONFLUENCE_ID_RE = re.compile(r'^\d{6,}_')

# Separate frontmatter
def split_frontmatter(content: str) -> tuple:
    """Returns (frontmatter_str, body_str). Without frontmatter returns ('', content)."""
    if content.startswith('---'):
        end = content.find('\n---\n', 4)
        if end != -1:
            return content[:end + 5], content[end + 5:]
        # Case where only --- sits at the end of the file
        if content.rstrip().endswith('---') and content.count('---') >= 2:
            end2 = content.find('---', 4)
            return content[:end2 + 3] + '\n', content[end2 + 3:]
    return '', content


def parse_related(fm: str) -> list:
    """Parse the related: [] value from the frontmatter."""
    m = re.search(r'related:\s*\[([^\]]*)\]', fm)
    if not m:
        return []
    raw = m.group(1).strip()
    if not raw:
        return []
    return [t.strip().strip('"').strip("'") for t in raw.split(',') if t.strip()]


def update_related_fm(fm: str, new_stems: list) -> str:
    """Add new entries to the related array in the frontmatter."""
    if not new_stems:
        return fm
    existing = parse_related(fm)
    existing_set = set(existing)
    to_add = [s for s in new_stems if s not in existing_set]
    if not to_add:
        return fm
    merged = existing + to_add
    new_val = ', '.join(merged)
    if re.search(r'related:\s*\[', fm):
        return re.sub(r'related:\s*\[[^\]]*\]', f'related: [{new_val}]', fm)
    # If there is no related field, insert after tags
    if 'tags:' in fm:
        return re.sub(r'(tags:\s*\[[^\]]*\]\n)', rf'\1related: [{new_val}]\n', fm)
    # Last resort: right before ---
    return fm.rstrip().rstrip('-').rstrip() + f'\nrelated: [{new_val}]\n---\n'


# ── Keyword extraction ────────────────────────────────────────────────────────

def extract_tokens_from_stem(stem: str) -> list:
    """Extract meaningful tokens from a file stem.
    Strips the Confluence ID prefix, then splits on underscores/whitespace/special characters."""
    # Strip the Confluence ID
    clean = CONFLUENCE_ID_RE.sub('', stem)
    # Strip date patterns (2024_03_11, 20240311, etc.)
    clean = re.sub(r'\b20\d{2}[_\-.]?\d{2}[_\-.]?\d{2}\b', '', clean)
    clean = re.sub(r'\b20\d{2}년?\b', '', clean)
    # Remove brackets while keeping their contents
    clean = clean.replace('[', ' ').replace(']', ' ')
    clean = clean.replace('(', ' ').replace(')', ' ')
    # Split by delimiters
    parts = re.split(r'[_\s\-./·,]+', clean)
    tokens = []
    for p in parts:
        p = p.strip()
        if len(p) >= 2 and p not in SKIP_TERMS:
            # Skip numeric-only tokens
            if re.match(r'^\d+$', p):
                continue
            tokens.append(p)
    return tokens


def build_active_index(active_dir: Path) -> tuple:
    """Build the (stem→tokens, token→stems) index from the active vault.

    Returns:
        stem_tokens: dict[str, list[str]] — token list for each stem
        token_stems: dict[str, set[str]] — set of stems each token appears in
        stem_title:  dict[str, str]      — stem → title
    """
    stem_tokens = {}
    token_stems = defaultdict(set)
    stem_title = {}

    for md in active_dir.glob('*.md'):
        if md.name.startswith('_'):
            continue
        stem = md.stem
        tokens = extract_tokens_from_stem(stem)
        if not tokens:
            continue
        stem_tokens[stem] = tokens
        for t in tokens:
            token_stems[t].add(stem)
        # Extract title
        try:
            head = md.read_text(encoding='utf-8', errors='replace')[:500]
            m = re.search(r'title:\s*"?([^"\n]+)"?', head)
            stem_title[stem] = m.group(1).strip("'\"") if m else stem
        except Exception:
            stem_title[stem] = stem

    return stem_tokens, token_stems, stem_title


# ── Jira file matching ──────────────────────────────────────────────────

def score_matches(jira_content: str, jira_title: str,
                  stem_tokens: dict, token_stems: dict) -> list:
    """Compute matching scores between a Jira file body and active files.

    Returns: [(stem, score), ...] sorted in descending order
    """
    scores = defaultdict(float)

    # Body text (overview, description, everything)
    body_lower = jira_content.lower()
    title_lower = jira_title.lower()

    # Search for every active token
    checked_tokens = set()
    for token in token_stems:
        if token in checked_tokens:
            continue
        if len(token) < 2:
            continue
        checked_tokens.add(token)

        t_lower = token.lower()
        # Body match
        body_count = body_lower.count(t_lower)
        if body_count == 0:
            continue

        # Title match bonus
        title_bonus = 3.0 if t_lower in title_lower else 0.0

        for stem in token_stems[token]:
            # Base: body occurrences (cap at 5)
            scores[stem] += min(body_count, 5) * 1.0 + title_bonus

    # Full stem name match bonus (after stripping the Confluence ID)
    for stem in stem_tokens:
        clean_stem = CONFLUENCE_ID_RE.sub('', stem).strip('_ ')
        if len(clean_stem) >= 4 and clean_stem.lower() in body_lower:
            scores[stem] += 10.0

    # Minimum 2-token match filter
    # Count token matches
    token_match_count = defaultdict(int)
    for token in token_stems:
        t_lower = token.lower()
        if t_lower in body_lower:
            for stem in token_stems[token]:
                token_match_count[stem] += 1

    # Drop matches with fewer than 2 tokens (full stem matches are exempt)
    filtered = {}
    for stem, score in scores.items():
        clean_stem = CONFLUENCE_ID_RE.sub('', stem).strip('_ ')
        has_full_match = len(clean_stem) >= 4 and clean_stem.lower() in body_lower
        if token_match_count[stem] >= 2 or has_full_match:
            filtered[stem] = score

    ranked = sorted(filtered.items(), key=lambda x: -x[1])
    return ranked


# ── Section injection ───────────────────────────────────────────────────

def has_section(content: str, heading: str) -> bool:
    """Check whether a given ## section already exists."""
    return f'\n{heading}\n' in content or content.startswith(f'{heading}\n')


def append_section(content: str, heading: str, links: list) -> str:
    """Append a section at the end of the file. If it exists, add links to the existing section."""
    link_lines = '\n'.join(f'- [[{link}]]' for link in links)
    block = f'\n\n{heading}\n\n{link_lines}\n'

    if has_section(content, heading):
        # Append to the end of the existing section (avoid duplicates)
        existing_links = set(re.findall(r'\[\[([^\]]+)\]\]', content))
        new_links = [l for l in links if l not in existing_links]
        if not new_links:
            return content
        add_lines = '\n'.join(f'- [[{l}]]' for l in new_links)
        # Locate the section
        idx = content.find(f'\n{heading}\n')
        if idx == -1:
            idx = content.find(f'{heading}\n')
        # Find the next ## or the end of the file
        after = idx + len(heading) + 2
        next_section = content.find('\n## ', after)
        if next_section == -1:
            # Append at the end of the file
            return content.rstrip() + '\n' + add_lines + '\n'
        else:
            return content[:next_section] + '\n' + add_lines + content[next_section:]
    else:
        return content.rstrip() + block


# ── Main logic ──────────────────────────────────────────────────────────

def collect_jira_files(jira_dir: Path) -> list:
    """Collect every MD file from the Jira directory (Epic, Release, attachments_md)."""
    files = []
    # Epic + Release (root level)
    for md in jira_dir.glob('*.md'):
        if md.name == 'jira_index.md':
            continue
        files.append(md)
    # attachments_md
    att_dir = jira_dir / 'attachments_md'
    if att_dir.exists():
        for md in att_dir.glob('*.md'):
            files.append(md)
    return sorted(files)


def run(vault_path: Path, dry_run: bool = True):
    active_dir = vault_path / 'active'
    jira_dir = vault_path / 'jira'

    if not active_dir.exists():
        print(f"ERROR: active directory not found: {active_dir}")
        sys.exit(1)
    if not jira_dir.exists():
        print(f"ERROR: jira directory not found: {jira_dir}")
        sys.exit(1)

    mode = "DRY-RUN" if dry_run else "APPLY"
    print(f"=== crosslink_jira.py [{mode}] ===")
    print(f"Active: {active_dir}")
    print(f"Jira:   {jira_dir}")
    print()

    # 1) Build the Active index
    print("Building Active vault index...")
    stem_tokens, token_stems, stem_title = build_active_index(active_dir)
    print(f"  → {len(stem_tokens)} files, {len(token_stems)} unique tokens")
    print()

    # 2) Scan & match Jira files
    jira_files = collect_jira_files(jira_dir)
    print(f"Jira files scanned: {len(jira_files)}")

    # Accumulate results
    jira_to_active = {}   # jira_path → [active_stems]
    active_to_jira = defaultdict(list)  # active_stem → [jira_stems]

    stats = {
        'jira_scanned': len(jira_files),
        'jira_linked': 0,
        'links_jira_to_active': 0,
        'links_active_to_jira': 0,
        'active_files_modified': 0,
    }

    for jira_md in jira_files:
        try:
            content = jira_md.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue

        fm, body = split_frontmatter(content)
        # Extract title
        m_title = re.search(r'title:\s*"?([^"\n]+)"?', fm)
        title = m_title.group(1).strip("'\"") if m_title else jira_md.stem

        ranked = score_matches(content, title, stem_tokens, token_stems)
        if not ranked:
            continue

        # Top 10
        top = ranked[:10]
        top_stems = [s for s, _ in top]

        jira_to_active[jira_md] = top_stems
        stats['jira_linked'] += 1
        stats['links_jira_to_active'] += len(top_stems)

        # Reverse mapping (active → jira, the max of 5 is applied later)
        jira_stem = jira_md.stem
        # Include the path if the jira file lives in attachments_md
        if jira_md.parent.name == 'attachments_md':
            jira_link = f"jira/attachments_md/{jira_stem}"
        else:
            jira_link = f"jira/{jira_stem}"

        for active_stem in top_stems:
            active_to_jira[active_stem].append((jira_link, jira_stem))

    print(f"  → Matched Jira files: {stats['jira_linked']}")
    print(f"  → Jira→Active links: {stats['links_jira_to_active']}")
    print()

    # 3) Inject ## 관련 문서 (related documents) into Jira files + update related frontmatter
    print("Injecting links into Jira files...")
    for jira_md, active_stems in jira_to_active.items():
        try:
            content = jira_md.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue

        fm, body = split_frontmatter(content)

        # Update frontmatter related
        new_fm = update_related_fm(fm, active_stems)

        # ## Add Related Documents section
        new_body = append_section(body, '## 관련 문서', active_stems)

        new_content = new_fm + new_body

        if new_content != content:
            if dry_run:
                changed_links = len(active_stems)
                print(f"  [DRY] {jira_md.name}: +{changed_links} links")
            else:
                jira_md.write_text(new_content, encoding='utf-8')
                print(f"  [OK]  {jira_md.name}: +{len(active_stems)} links")

    # 4) Inject reverse ## Jira 관련 (Jira related) links into Active files
    print()
    print("Injecting reverse Jira links into Active files...")
    for active_stem, jira_links in active_to_jira.items():
        active_md = active_dir / f"{active_stem}.md"
        if not active_md.exists():
            continue

        # max 5 jira links per active file
        jira_links_unique = []
        seen = set()
        for link, stem in jira_links:
            if link not in seen:
                seen.add(link)
                jira_links_unique.append(link)
            if len(jira_links_unique) >= 5:
                break

        try:
            content = active_md.read_text(encoding='utf-8', errors='replace')
        except Exception:
            continue

        # Check existing links
        existing_links = set(re.findall(r'\[\[([^\]]+)\]\]', content))
        new_jira = [l for l in jira_links_unique if l not in existing_links]
        if not new_jira:
            continue

        new_content = append_section(content, '## Jira 관련', new_jira)

        if new_content != content:
            stats['active_files_modified'] += 1
            stats['links_active_to_jira'] += len(new_jira)
            if dry_run:
                print(f"  [DRY] {active_md.name}: +{len(new_jira)} Jira links")
            else:
                active_md.write_text(new_content, encoding='utf-8')
                print(f"  [OK]  {active_md.name}: +{len(new_jira)} Jira links")

    # 5) Update _index.md
    print()
    index_md = active_dir / '_index.md'
    index_updated = False
    if index_md.exists():
        try:
            idx_content = index_md.read_text(encoding='utf-8', errors='replace')
        except Exception:
            idx_content = ''

        if '[[jira/jira_index]]' not in idx_content and '[[jira_index]]' not in idx_content:
            jira_section = (
                '\n\n## Jira\n\n'
                '- [[jira/jira_index]] — Jira Epic·Release 전체 인덱스\n'
            )
            new_idx = idx_content.rstrip() + jira_section
            if dry_run:
                print(f"  [DRY] _index.md: Jira section added")
            else:
                index_md.write_text(new_idx, encoding='utf-8')
                print(f"  [OK]  _index.md: Jira section added")
            index_updated = True
        else:
            print("  _index.md: Jira link already exists, skipping")
    else:
        print(f"  WARNING: _index.md not found ({index_md})")

    # 6) Print summary
    print()
    print("=" * 50)
    print(f"Total Jira files scanned:  {stats['jira_scanned']}")
    print(f"Jira files with links:     {stats['jira_linked']}")
    print(f"Jira→Active links:         {stats['links_jira_to_active']}")
    print(f"Active→Jira links:         {stats['links_active_to_jira']}")
    print(f"Modified Active files:     {stats['active_files_modified']}")
    print(f"_index.md updated:         {'yes' if index_updated else 'no'}")
    print(f"Total injected links:      {stats['links_jira_to_active'] + stats['links_active_to_jira']}")
    print("=" * 50)

    if dry_run:
        print("\n⚠ DRY-RUN mode: no files were changed. Run with --apply to apply.")


def main():
    parser = argparse.ArgumentParser(
        description='Jira ↔ Active vault cross wikilink injection'
    )
    parser.add_argument(
        'vault_path', nargs='?', default='c:/dev2/refined_vault',
        help='refined_vault root path (default: c:/dev2/refined_vault)'
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--dry-run', action='store_true', help='Preview (no file changes)')
    group.add_argument('--apply', action='store_true', help='Apply changes')

    args = parser.parse_args()
    vault = Path(args.vault_path)

    if not vault.exists():
        print(f"ERROR: vault path not found: {vault}")
        sys.exit(1)

    run(vault, dry_run=not args.apply)


if __name__ == '__main__':
    main()
