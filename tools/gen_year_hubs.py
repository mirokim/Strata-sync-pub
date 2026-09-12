"""
Yearly hub file generation script (gen_year_hubs.py)  v1.0
────────────────────────────────────────────────────────
Function:
  Groups feedback files whose tags include 'chief' by year and
  auto-creates/updates hub files (회의록_YYYY.md).
  Adds a "recently added (latest N)" section at the top of the latest year hub.
  Also refreshes the yearly hub list in chief persona.md, newest first.

Usage:
    python gen_year_hubs.py <vault_dir> [--top N]

Options:
    --top N   Number of recently added documents to show in the latest year hub (default: 5)
    --vault   Unused (interface compatibility with audit_and_fix.py)

Dependencies:
    pip install PyYAML
"""

import os
import re
import sys
import yaml
from collections import defaultdict
from datetime import datetime

# Yearly hub filename pattern
HUB_NAME_PAT = re.compile(r'^회의록_(\d{4})\.md$')
# Extract the date from the filename ([YYYY.MM.DD] or [YYYY_MM_DD] pattern)
FNAME_DATE_PAT = re.compile(r'\[(\d{4})[._](\d{2})[._](\d{2})\]')
# chief persona filename candidates
CHIEF_PERSONA_PATS = ['chief persona.md', 'chief persona(0.1.0).md']


def load_frontmatter(text: str) -> tuple[dict, int]:
    if not text.startswith('---'):
        return {}, -1
    close = text.find('\n---', 3)
    if close == -1:
        return {}, -1
    try:
        fm = yaml.safe_load(text[3:close]) or {}
    except Exception:
        fm = {}
    return fm, close + 4


def get_date(fm: dict, fname: str) -> datetime | None:
    """Prefer the frontmatter date; otherwise extract [YYYY.MM.DD] from the filename."""
    date_val = fm.get('date')
    if date_val:
        try:
            return datetime.strptime(str(date_val).strip(), '%Y-%m-%d')
        except Exception:
            pass
    m = FNAME_DATE_PAT.search(fname)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except Exception:
            pass
    return None


def has_chief_tag(fm: dict) -> bool:
    tags = fm.get('tags', [])
    if isinstance(tags, str):
        tags = [tags]
    return any(str(t).lower() == 'chief' for t in (tags or []))


def make_hub_content(year: int, entries: list[tuple[datetime, str, str]], top_n: int, is_latest: bool) -> str:
    """Generate the yearly hub file content.
    entries: [(date, stem, title), ...] — passed already sorted by date, newest first
    """
    today = datetime.now().strftime('%Y-%m-%d')
    lines = [
        '---',
        f'title: 회의록_{year}',
        f'date: {today}',
        'type: meeting',
        'status: active',
        'tags: [chief]',
        'speaker: chief_director',
        f'related: [chief persona]',
        'origin: generated',
        '---',
        '',
        f'# 회의록_{year}',
        '',
    ]

    if is_latest and top_n > 0 and entries:
        recent = entries[:top_n]
        lines += [
            f'## 최근 추가 (최신 {len(recent)}개)',
            '',
            '> 최신 피드백이 필요하면 이 섹션을 먼저 볼 것.',
            '',
        ]
        for dt, stem, title in recent:
            date_str = dt.strftime('%Y.%m.%d')
            lines.append(f'- [[{stem}]] ({date_str})')
        lines.append('')

    lines += [
        f'## 전체 목록 ({len(entries)}개 · 최신순)',
        '',
    ]
    for dt, stem, title in entries:
        date_str = dt.strftime('%Y.%m.%d')
        lines.append(f'- [[{stem}]] ({date_str})')

    lines.append('')
    return '\n'.join(lines)


def update_chief_persona(vault_dir: str, years_desc: list[int], top_n: int, year_counts: dict[int, int]) -> bool:
    """Refresh the yearly hub section of chief persona.md. Returns False if the file is missing."""
    # Locate the file
    chief_path = None
    for candidate in CHIEF_PERSONA_PATS:
        p = os.path.join(vault_dir, candidate)
        if os.path.exists(p):
            chief_path = p
            break
    if not chief_path:
        # Search for a file whose name contains 'chief persona'
        for fname in os.listdir(vault_dir):
            if 'chief persona' in fname.lower() and fname.endswith('.md'):
                chief_path = os.path.join(vault_dir, fname)
                break

    if not chief_path:
        print('⚠ chief persona.md not found. Skipping yearly hub section update.')
        return False

    with open(chief_path, encoding='utf-8') as f:
        original = f.read()

    latest_year = years_desc[0] if years_desc else None

    # Build the new section content
    recent_section_lines = ['## 최근 피드백 (현재 기준 — 우선 참조)', '']
    if latest_year:
        count = year_counts.get(latest_year, 0)
        recent_section_lines.append(f'> ⚠️ 가장 최근 이사장 피드백은 아래 링크를 먼저 확인할 것.')
        recent_section_lines.append('')
        recent_section_lines.append(f'- [[회의록_{latest_year}]] — **현재 연도 (최신 {min(top_n, count)}개 문서)**')
        recent_section_lines.append('')

    archive_lines = ['## 연도별 피드백 아카이브', '']
    if len(years_desc) > 1:
        archive_lines.append('> 이전 연도 데이터는 참고용. 현재 기준 정보는 위 섹션 우선.')
        archive_lines.append('')
        for y in years_desc[1:]:
            archive_lines.append(f'- [[회의록_{y}]] — {y}년 전체')
        archive_lines.append('')

    new_section = '\n'.join(recent_section_lines) + '\n' + '\n'.join(archive_lines)

    # Replace the existing section or append at the end
    recent_pat = re.compile(
        r'## 최근 피드백 \(현재 기준.*?\n(?:.*\n)*?(?=^## |\Z)',
        re.MULTILINE
    )
    archive_pat = re.compile(
        r'## 연도별 피드백 아카이브\n(?:.*\n)*?(?=^## |\Z)',
        re.MULTILINE
    )

    if recent_pat.search(original):
        # If both sections already exist, replace them wholesale
        combined_pat = re.compile(
            r'## 최근 피드백 \(현재 기준.*?\n(?:.*\n)*?(?=^## (?!연도별)|\Z)',
            re.MULTILINE
        )
        new_text = combined_pat.sub(new_section + '\n', original)
        # Replace the archive section too
        new_text = archive_pat.sub('', new_text)
    else:
        # Otherwise insert right after the frontmatter
        _, fm_end = load_frontmatter(original)
        if fm_end != -1:
            new_text = original[:fm_end] + '\n' + new_section + '\n' + original[fm_end:].lstrip('\n')
        else:
            new_text = new_section + '\n\n' + original

    if new_text == original:
        print(f'  chief persona.md unchanged')
        return True

    with open(chief_path, 'w', encoding='utf-8') as f:
        f.write(new_text)
    print(f'  chief persona.md yearly hub section updated')
    return True


def resolve_active_dir(vault_dir: str) -> str:
    """Return whichever of the vault root or the active/ subfolder actually holds the md files."""
    active = os.path.join(vault_dir, 'active')
    if os.path.isdir(active):
        return active
    return vault_dir


def run(vault_dir: str, top_n: int = 5) -> None:
    active_dir = resolve_active_dir(vault_dir)

    # 1. Collect chief-tagged files
    chief_entries: list[tuple[datetime, str, str]] = []  # (date, stem, title)
    hub_files: set[str] = set()

    for fname in sorted(os.listdir(active_dir)):
        if not fname.endswith('.md'):
            continue
        stem = os.path.splitext(fname)[0]

        # Skip the yearly hub files themselves
        if HUB_NAME_PAT.match(fname):
            hub_files.add(fname)
            continue

        path = os.path.join(active_dir, fname)
        try:
            with open(path, encoding='utf-8') as f:
                text = f.read()
        except Exception:
            continue

        fm, _ = load_frontmatter(text)
        if not has_chief_tag(fm):
            continue

        dt = get_date(fm, fname)
        if dt is None:
            continue

        title = fm.get('title', stem)
        chief_entries.append((dt, stem, str(title)))

    if not chief_entries:
        print('No chief-tagged files found.')
        return

    # 2. Group by year (sorted newest first)
    by_year: dict[int, list[tuple[datetime, str, str]]] = defaultdict(list)
    for entry in chief_entries:
        by_year[entry[0].year].append(entry)

    for year in by_year:
        by_year[year].sort(key=lambda x: x[0], reverse=True)

    years_desc = sorted(by_year.keys(), reverse=True)
    latest_year = years_desc[0]

    print(f'{len(chief_entries)} chief-tagged files → {len(years_desc)} year groups')

    # 3. Create/update the yearly hub files
    year_counts: dict[int, int] = {}
    for year in years_desc:
        entries = by_year[year]
        year_counts[year] = len(entries)
        is_latest = (year == latest_year)
        content = make_hub_content(year, entries, top_n, is_latest)
        hub_path = os.path.join(active_dir, f'회의록_{year}.md')
        existing = ''
        if os.path.exists(hub_path):
            with open(hub_path, encoding='utf-8') as f:
                existing = f.read()
        if content != existing:
            with open(hub_path, 'w', encoding='utf-8') as f:
                f.write(content)
            action = 'updated' if existing else 'created'
            print(f'  회의록_{year}.md {action} ({len(entries)} documents{", includes recently added section" if is_latest else ""})')
        else:
            print(f'  회의록_{year}.md unchanged')

    # 4. Update chief persona.md
    update_chief_persona(active_dir, years_desc, top_n, year_counts)

    print(f'\nDone: {len(years_desc)} yearly hubs processed')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python gen_year_hubs.py <vault_dir> [--top N]', file=sys.stderr)
        sys.exit(1)

    vault_dir = None
    top_n = 5
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '--top' and i + 1 < len(sys.argv):
            try:
                top_n = int(sys.argv[i + 1])
            except ValueError:
                pass
            i += 2
        elif arg == '--vault' and i + 1 < len(sys.argv):
            i += 2  # --vault is ignored (audit_and_fix.py compatibility)
        elif not arg.startswith('--'):
            vault_dir = arg
            i += 1
        else:
            i += 1

    if not vault_dir:
        print('Error: vault_dir argument is required.', file=sys.stderr)
        sys.exit(1)

    run(vault_dir, top_n)
