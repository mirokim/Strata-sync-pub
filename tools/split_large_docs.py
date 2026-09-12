#!/usr/bin/env python3
"""
split_large_docs.py — §5 Large document hub-spoke split

Split criteria (§5.1):
  - Targets files whose total line count is at least LINE_LIMIT (default 200)
  - Splits into sections at ## headings
  - Saves each section as a separate spoke file
  - Replaces the original file with a hub file that serves as a table of contents

Output structure:
  Hub file:   {stem}.md            (original location, table of contents only)
  Spoke file: {stem} - {section title}.md

Usage:
  python split_large_docs.py <active_dir> [--lines 200] [--dry-run] [--verbose]
  python split_large_docs.py <single.md>  [--lines 200] [--dry-run] [--verbose]
"""

import re
import sys
import argparse
from pathlib import Path
from datetime import datetime


LINE_LIMIT = 200    # Minimum line count for splitting (§5.1)
SECTION_LINES = 200  # Section split threshold (at or above → separate file)


# ── Parse frontmatter ──────────────────────────────────────────────
def parse_frontmatter(content: str) -> tuple[dict, str, str]:
    """Returns (fields_dict, fm_block, body)."""
    if not content.startswith('---'):
        return {}, '', content
    end = content.find('\n---\n', 4)
    if end == -1:
        return {}, '', content
    fm_block = content[:end + 5]
    body     = content[end + 5:]
    fields   = {}
    for line in content[3:end].strip().splitlines():
        m = re.match(r'^(\w+):\s*(.*)', line)
        if m:
            fields[m.group(1)] = m.group(2).strip()
    return fields, fm_block, body


def get_fm_field(fields: dict, key: str, default: str = '') -> str:
    return fields.get(key, default).strip().strip('"\'')


# ── Parse sections ────────────────────────────────────────────────────
def parse_sections(body: str) -> list[dict]:
    """Split into sections at ## headings. [{'title': str, 'content': str}]"""
    sections  = []
    current   = {'title': '_intro', 'content': ''}
    heading_re = re.compile(r'^(## .+)', re.MULTILINE)

    parts = heading_re.split(body)
    # parts[0] = intro text before the first ##
    # parts[1], parts[2], parts[3], parts[4], ... = heading, content, heading, content ...

    # Intro (before the first ## heading)
    intro_text = parts[0].strip()
    if intro_text:
        sections.append({'title': '_intro', 'content': intro_text})

    # Heading + content pairs
    i = 1
    while i < len(parts) - 1:
        heading = parts[i].strip()   # '## Title'
        content = parts[i + 1]       # Content before the next ##
        title   = heading.lstrip('#').strip()
        sections.append({'title': title, 'content': heading + '\n' + content})
        i += 2

    return sections


def safe_filename(title: str) -> str:
    """Section title → filename-safe string."""
    cleaned = re.sub(r'[\\/:*?"<>|]', '', title)
    cleaned = cleaned.strip().strip('.')
    return cleaned[:60]   # Max 60 chars


# ── Generate hub file ────────────────────────────────────────────────
def build_hub(stem: str, fields: dict, spoke_titles: list[str],
              intro_text: str, date: str) -> str:
    tags_raw  = get_fm_field(fields, 'tags', 'spec')
    # Add hub to tags field
    if tags_raw.startswith('['):
        tags_inner = tags_raw[1:-1].rstrip(']')
        if 'hub' not in tags_inner:
            tags_raw = '[' + tags_inner + ', hub]'
    else:
        tags_raw = f'[{tags_raw}, hub]' if tags_raw else '[hub]'

    doc_type = get_fm_field(fields, 'type', 'spec')
    status   = get_fm_field(fields, 'status', 'active')
    origin   = get_fm_field(fields, 'origin', 'md')
    title    = get_fm_field(fields, 'title', stem)

    fm = (
        f"---\n"
        f"title: \"{title}\"\n"
        f"date: {date}\n"
        f"type: {doc_type}\n"
        f"status: {status}\n"
        f"tags: {tags_raw}\n"
        f"origin: {origin}\n"
        f"---\n\n"
    )

    body = f"# {title}\n\n"
    if intro_text:
        body += f"> {intro_text[:200]}\n\n"

    body += "## 목차\n\n"
    for i, t in enumerate(spoke_titles, start=1):
        spoke_stem = f"{stem} - {safe_filename(t)}"
        body += f"- [[{spoke_stem}|{i}. {t}]]\n"

    return fm + body


# ── Generate spoke file ─────────────────────────────────────────────
def build_spoke(hub_stem: str, section_title: str,
                section_content: str, fields: dict, date: str) -> str:
    tags_raw  = get_fm_field(fields, 'tags', 'spec')
    doc_type  = get_fm_field(fields, 'type', 'spec')
    status    = get_fm_field(fields, 'status', 'active')
    origin    = get_fm_field(fields, 'origin', 'md')
    title     = f"{get_fm_field(fields, 'title', hub_stem)} - {section_title}"

    fm = (
        f"---\n"
        f"title: \"{title}\"\n"
        f"date: {date}\n"
        f"type: {doc_type}\n"
        f"status: {status}\n"
        f"tags: {tags_raw}\n"
        f"origin: {origin}\n"
        f"---\n\n"
    )

    # Hub back-reference link
    back_link = f"> 허브: [[{hub_stem}]]\n\n"
    return fm + back_link + section_content.strip() + '\n'


# ── Execute split ─────────────────────────────────────────────────────
def split_file(md_path: Path, out_dir: Path,
               line_limit: int, section_lines: int,
               dry_run: bool, verbose: bool) -> dict:
    result = {'split': False, 'spokes': 0, 'skipped': False}

    try:
        content = md_path.read_text(encoding='utf-8', errors='replace')
    except Exception as e:
        print(f"  Error: {md_path.name} — {e}")
        result['skipped'] = True
        return result

    total_lines = content.count('\n')
    if total_lines < line_limit:
        result['skipped'] = True
        return result

    fields, fm_block, body = parse_frontmatter(content)
    sections = parse_sections(body)

    if len(sections) <= 1:
        # Cannot split — no ## headings
        if verbose:
            print(f"  Skipped (no headings): {md_path.name}")
        result['skipped'] = True
        return result

    # Separate intro
    intro_text = ''
    split_sections = []
    for s in sections:
        if s['title'] == '_intro':
            intro_text = s['content']
        else:
            split_sections.append(s)

    if not split_sections:
        result['skipped'] = True
        return result

    date     = get_fm_field(fields, 'date') or datetime.today().strftime('%Y-%m-%d')
    hub_stem = md_path.stem
    spoke_titles = [s['title'] for s in split_sections]

    if verbose:
        print(f"\n  Splitting: {md_path.name}  ({total_lines} lines, {len(split_sections)} sections)")

    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)

        # Save hub (replaces original)
        hub_content = build_hub(hub_stem, fields, spoke_titles, intro_text, date)
        md_path.write_text(hub_content, encoding='utf-8')

        # Save spokes
        for s in split_sections:
            spoke_stem    = f"{hub_stem} - {safe_filename(s['title'])}"
            spoke_path    = out_dir / f"{spoke_stem}.md"
            spoke_content = build_spoke(hub_stem, s['title'], s['content'], fields, date)
            spoke_path.write_text(spoke_content, encoding='utf-8')
            if verbose:
                lines_cnt = spoke_content.count('\n')
                print(f"    → {spoke_path.name}  ({lines_cnt} lines)")

    result['split']  = True
    result['spokes'] = len(split_sections)
    return result


def main():
    parser = argparse.ArgumentParser(description='§5 Large document hub-spoke split')
    parser.add_argument('input',    help='MD file or active/ folder')
    parser.add_argument('--lines',  type=int, default=LINE_LIMIT,
                        help=f'Minimum line count for splitting (default: {LINE_LIMIT})')
    parser.add_argument('--dry-run', action='store_true', help='Preview without changing files')
    parser.add_argument('--verbose', '-v', action='store_true')
    args = parser.parse_args()

    input_path = Path(args.input)

    if input_path.is_file():
        md_files = [input_path]
        out_dir  = input_path.parent
    elif input_path.is_dir():
        md_files = sorted(input_path.glob('*.md'))
        out_dir  = input_path
    else:
        print(f"Error: {input_path} not found"); sys.exit(1)

    total = split_count = spoke_count = skipped = 0
    candidates = []

    for md in md_files:
        total += 1
        line_cnt = md.read_text(encoding='utf-8', errors='replace').count('\n')
        if line_cnt >= args.lines:
            candidates.append((md, line_cnt))

    print(f"§5 split_large_docs starting{'  [DRY-RUN]' if args.dry_run else ''}...")
    print(f"  Total MDs: {total} / split candidates ({args.lines}+ lines): {len(candidates)}")

    for md, line_cnt in candidates:
        r = split_file(md, out_dir, args.lines, SECTION_LINES,
                       args.dry_run, args.verbose)
        if r['skipped']:
            skipped += 1
        elif r['split']:
            split_count += 1
            spoke_count += r['spokes']

    print(f"\n{'='*50}")
    print(f"§5 split_large_docs Complete{'  [DRY-RUN]' if args.dry_run else ''}")
    print(f"{'='*50}")
    print(f"  Split complete:    {split_count} files")
    print(f"  Generated spokes:  {spoke_count} files")
    print(f"  Skipped:       {skipped} (no headings, etc.)")
    if args.dry_run:
        print("  ※ --dry-run mode: no files were changed")


if __name__ == '__main__':
    main()
