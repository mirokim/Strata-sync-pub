"""
Graph RAG freshness bug check script (check_outdated.py)  v1.0
────────────────────────────────────────────────────────────
Function:
  Automatically checks for and reports the main causes of the bug where
  the Graph RAG bot answers with stale data.

Check items:
  ① Files with status: outdated but no superseded_by
     → moved to .archive/ automatically with the --fix option
  ② Isolated files: new documents within the last N days with 0 backlinks
     → rerun gen_year_hubs.py or add links manually
  ③ Warn when the date field of currentSituation.md / _index.md is older than N days
  ④ Check the yearly hub order in chief persona.md
     → warn if the latest year is not at the top

Extra options:
  --batch-check   List dates shared by 5 or more files
                  (diagnoses date contamination from Confluence batch sync)

Usage:
    python check_outdated.py <vault_dir> [--vault <vault_root>]
                             [--days N] [--fix] [--batch-check]

Dependencies:
    pip install PyYAML
"""

import os
import re
import sys
import shutil
import yaml
from collections import Counter, defaultdict
from datetime import datetime, timedelta


HUB_YEAR_PAT   = re.compile(r'회의록_(\d{4})')
WIKILINK_PAT   = re.compile(r'\[\[([^\[\]]+?)\]\]')
CHIEF_PERSONAS = ['chief persona.md', 'chief persona(0.1.0).md']


def resolve_active_dir(vault_dir: str) -> str:
    active = os.path.join(vault_dir, 'active')
    if os.path.isdir(active):
        return active
    return vault_dir


def split_fm(text: str) -> tuple[dict, str]:
    if text.startswith('---'):
        end = text.find('\n---', 3)
        if end != -1:
            try:
                fm = yaml.safe_load(text[3:end]) or {}
            except Exception:
                fm = {}
            return fm, text[end + 4:]
    return {}, text


def get_date(fm: dict) -> datetime | None:
    val = fm.get('date')
    if not val:
        return None
    try:
        return datetime.strptime(str(val).strip(), '%Y-%m-%d')
    except Exception:
        return None


def run(active_dir: str, vault_root: str | None = None,
        days: int = 30, fix: bool = False, batch_check: bool = False) -> None:
    vault_root = vault_root or active_dir
    today = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = today - timedelta(days=days)

    md_files = sorted(f for f in os.listdir(active_dir) if f.endswith('.md'))
    total = len(md_files)

    print(f"\n{'='*60}")
    print(f" Graph RAG freshness check report  v1.0")
    print(f" Target: {active_dir}")
    print(f" Files: {total}  |  Reference date: {today.strftime('%Y-%m-%d')} (last {days} days)")
    print(f"{'='*60}\n")

    # Full stem set and backlink counter
    all_stems: set[str] = set()
    for root, dirs, files in os.walk(vault_root):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for f in files:
            if f.endswith('.md'):
                all_stems.add(f[:-3])

    backlink_count: dict[str, int] = defaultdict(int)
    date_counter: Counter = Counter()
    records: list[tuple[str, dict, str]] = []  # (stem, fm, body)

    for fname in md_files:
        path = os.path.join(active_dir, fname)
        stem = fname[:-3]
        try:
            with open(path, encoding='utf-8') as f:
                text = f.read()
        except Exception:
            continue
        fm, body = split_fm(text)
        records.append((stem, fm, body))

        # Count backlinks
        for m in WIKILINK_PAT.finditer(body):
            target = m.group(1).split('|')[0].strip()
            if target in all_stems:
                backlink_count[target] += 1

        # Count dates (for batch-check)
        if batch_check:
            dt = get_date(fm)
            if dt:
                date_counter[dt.strftime('%Y-%m-%d')] += 1

    # ── ① outdated files (no superseded_by) ─────────────────────────────────
    outdated_no_sup: list[str] = []
    for stem, fm, _ in records:
        if str(fm.get('status', '')).lower() == 'outdated' and not fm.get('superseded_by'):
            outdated_no_sup.append(stem)

    status = 'WARN' if outdated_no_sup else 'PASS'
    print(f"[{status}] ① status:outdated + no superseded_by: {len(outdated_no_sup)}")
    for s in outdated_no_sup[:5]:
        print(f"       - {s[:70]}")
    if len(outdated_no_sup) > 5:
        print(f"       ... and {len(outdated_no_sup)-5} more")
    print()

    if fix and outdated_no_sup:
        archive_dir = os.path.join(active_dir, '.archive')
        os.makedirs(archive_dir, exist_ok=True)
        moved = 0
        for stem in outdated_no_sup:
            src = os.path.join(active_dir, f'{stem}.md')
            dst = os.path.join(archive_dir, f'{stem}.md')
            if os.path.exists(src):
                shutil.move(src, dst)
                moved += 1
        print(f"  [FIX] {moved} files moved → .archive/\n")

    # ── ② Isolated new documents (last N days) with 0 backlinks ────────────
    isolated_new: list[tuple[str, str]] = []
    for stem, fm, _ in records:
        dt = get_date(fm)
        if dt and dt >= cutoff:
            bl = backlink_count.get(stem, 0)
            if bl == 0:
                isolated_new.append((stem, dt.strftime('%Y-%m-%d')))

    status = 'WARN' if isolated_new else 'PASS'
    print(f"[{status}] ② New documents in the last {days} days with 0 backlinks (isolated): {len(isolated_new)}")
    for s, d in isolated_new[:5]:
        print(f"       - {s[:55]} ({d})")
    if len(isolated_new) > 5:
        print(f"       ... and {len(isolated_new)-5} more")
    print()

    # ── ③ currentSituation.md / _index.md date field freshness ─────────────
    hub_targets = ['currentSituation', '_index']
    stale_hubs: list[tuple[str, str]] = []
    for stem, fm, _ in records:
        if stem in hub_targets:
            dt = get_date(fm)
            if dt is None:
                stale_hubs.append((stem, 'no date field'))
            elif dt < cutoff:
                delta = (today - dt).days
                stale_hubs.append((stem, f'{delta} days old (last: {dt.strftime("%Y-%m-%d")})'))

    status = 'WARN' if stale_hubs else 'PASS'
    print(f"[{status}] ③ Hub document freshness ({days}-day threshold):")
    for name, msg in stale_hubs:
        print(f"       - {name}.md: {msg}")
    if not stale_hubs:
        print("       - No issues")
    print()

    # ── ④ chief persona.md yearly hub order check ──────────────────────────
    chief_path = None
    for candidate in CHIEF_PERSONAS:
        p = os.path.join(active_dir, candidate)
        if os.path.exists(p):
            chief_path = p
            break
    if not chief_path:
        for fname in os.listdir(active_dir):
            if 'chief persona' in fname.lower() and fname.endswith('.md'):
                chief_path = os.path.join(active_dir, fname)
                break

    if chief_path:
        with open(chief_path, encoding='utf-8') as f:
            chief_text = f.read()
        years_found = [int(m) for m in HUB_YEAR_PAT.findall(chief_text)]
        if years_found:
            sorted_years = sorted(set(years_found), reverse=True)
            first_occurrence = {y: years_found.index(y) for y in set(years_found)}
            # The first year to appear must be the latest year
            first_year = years_found[0]
            expected_first = sorted_years[0]
            if first_year != expected_first:
                print(f"[WARN] ④ chief persona.md yearly hub order is wrong")
                print(f"       - First year listed: {first_year}  |  Latest year: {expected_first}")
                print(f"       - Rerun gen_year_hubs.py\n")
            else:
                print(f"[PASS] ④ chief persona.md yearly hub order: {sorted_years[0]} correctly at the top\n")
        else:
            print(f"[WARN] ④ No yearly hub links found in chief persona.md\n")
    else:
        print(f"[INFO] ④ chief persona.md not found — check skipped\n")

    # ── --batch-check: batch sync date contamination diagnosis ─────────────
    if batch_check:
        print(f"[INFO] Batch date contamination diagnosis (dates with 5+ files):")
        suspicious = [(date, cnt) for date, cnt in date_counter.most_common() if cnt >= 5]
        if suspicious:
            print(f"       {'Date':<15} {'Files':>8}")
            print(f"       {'-'*25}")
            for date, cnt in suspicious[:15]:
                flag = ' ← suspicious' if cnt >= 10 else ''
                print(f"       {date:<15} {cnt:>8}{flag}")
            if len(suspicious) > 15:
                print(f"       ... and {len(suspicious)-15} more dates")
        else:
            print("       No date shared by 5+ files (no batch contamination detected)")
        print()

    total_issues = len(outdated_no_sup) + len(isolated_new) + len(stale_hubs)
    print(f"{'='*60}")
    print(f" Issues recommended for fixing: {total_issues}")
    if outdated_no_sup and not fix:
        print(f" (use --fix to move {len(outdated_no_sup)} outdated files to .archive/ automatically)")
    print(f"{'='*60}\n")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    days = 30
    fix = False
    batch_check = False
    vault = None
    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '--days' and i + 1 < len(sys.argv):
            try:
                days = int(sys.argv[i + 1])
            except ValueError:
                pass
            i += 2
        elif arg == '--vault' and i + 1 < len(sys.argv):
            vault = sys.argv[i + 1]
            i += 2
        elif arg == '--fix':
            fix = True
            i += 1
        elif arg == '--batch-check':
            batch_check = True
            i += 1
        else:
            i += 1

    active_dir = resolve_active_dir(sys.argv[1])
    run(active_dir, vault or sys.argv[1], days=days, fix=fix, batch_check=batch_check)
