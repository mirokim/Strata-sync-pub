"""
fix_game_ref_links.py — Fix links in the game reference files under active/games/

1. Fix nested wikilinks: [[[게임] X — Y|...]] → [[게임] X — Y|...]]
2. Inject hub backlinks into spoke files: add [[hub]] to the ## 관련 문서 (related documents) section
3. Fill in missing spoke tables of contents in hub files

Usage:
  python fix_game_ref_links.py <games_dir>
  python fix_game_ref_links.py C:/dev2/refined_vault/active/games
"""

import os
import re
import sys
from pathlib import Path

def fix_nested_wikilinks(text: str) -> str:
    """Remove leading duplicate [ such as [[[X|Y]] → [[X|Y]], [[[X]]] → [[X]]."""
    # Apply repeatedly (nesting may be several levels deep)
    for _ in range(3):
        prev = text
        # [[[...]] → [[...]] (remove one leading [)
        text = re.sub(r'\[\[(\[[^\[\]]+(?:\[[^\[\]]*\][^\[\]]*)*\|[^\[\]]+)\]\]', r'[[\1]]', text)
        # [[[stem|display]] → [[stem|display]]
        text = re.sub(r'\[\[\[([^\[\]]*\|[^\[\]]*)\]\]', r'[[\1]]', text)
        # [[[stem]]] → [[stem]]
        text = re.sub(r'\[\[\[([^\[\]]+)\]\]\]', r'[[\1]]', text)
        if text == prev:
            break
    return text


def get_hub_stem(spoke_filename: str) -> str:
    """Extract the hub stem from a spoke filename. '[게임] LoL — 챔피언.md' → '[게임] LoL'"""
    stem = Path(spoke_filename).stem  # e.g. '[게임] LoL — 챔피언'
    return stem.split(' — ')[0].strip()


def ensure_backlink(content: str, hub_stem: str, hub_display: str) -> str:
    """If the spoke file lacks a hub backlink, add it to the ## 관련 문서 (related documents) section."""
    backlink = f'[[{hub_stem}|{hub_display}]]'
    if hub_stem in content:
        return content  # Already present

    # If a ## 관련 문서 section exists, add it there
    if '## 관련 문서' in content:
        return content.replace(
            '## 관련 문서',
            f'## 관련 문서\n- {backlink} (허브 문서)',
            1
        )

    # Otherwise insert before ## 비교 분석 메모 (comparative analysis notes)
    if '## 비교 분석 메모' in content:
        return content.replace(
            '## 비교 분석 메모',
            f'## 관련 문서\n\n- {backlink} (허브 문서)\n\n## 비교 분석 메모',
            1
        )

    # Failing that, append at the end of the file
    return content.rstrip() + f'\n\n## 관련 문서\n\n- {backlink} (허브 문서)\n'


def ensure_spoke_links_in_hub(content: str, hub_stem: str, spoke_stems: list) -> str:
    """Fill in the spoke link table of contents in the hub file if missing or incomplete."""
    if not spoke_stems:
        return content

    missing = []
    for stem in spoke_stems:
        if stem not in content:
            missing.append(stem)

    if not missing:
        return content

    # If a ## 세부 문서 (detail documents) section exists, add there
    if '## 세부 문서' in content:
        insert = '\n'.join(f'- [[{s}|{s.split(" — ")[-1]}]]' for s in missing)
        return content.replace(
            '## 세부 문서',
            f'## 세부 문서',
            1
        ).replace(
            '## 세부 문서\n',
            '## 세부 문서\n' + insert + '\n',
            1
        )

    # Otherwise insert right after the contamination prevention marker
    section = '\n## 세부 문서\n\n' + '\n'.join(f'- [[{s}|{s.split(" — ")[-1]}]]' for s in missing) + '\n\n'
    # Before the first ## heading
    m = re.search(r'\n## ', content)
    if m:
        return content[:m.start()] + section + content[m.start():]
    return content + section


def main():
    if len(sys.argv) < 2:
        print(f"Usage: python {sys.argv[0]} <games_dir>", file=sys.stderr)
        sys.exit(1)

    games_dir = Path(sys.argv[1])
    if not games_dir.is_dir():
        print(f"Error: folder not found — {games_dir}", file=sys.stderr)
        sys.exit(1)

    all_files = sorted(games_dir.glob('*.md'))
    hubs   = {f.stem: f for f in all_files if ' — ' not in f.stem}
    spokes = {f.stem: f for f in all_files if ' — ' in f.stem}

    # Spoke list per hub
    hub_spokes: dict = {h: [] for h in hubs}
    for stem in spokes:
        hub_stem = stem.split(' — ')[0].strip()
        if hub_stem in hub_spokes:
            hub_spokes[hub_stem].append(stem)

    fixed_nested = 0
    fixed_backlink = 0
    fixed_hub = 0

    # ── Fix spokes ──────────────────────────────────────────────────────────
    for stem, path in spokes.items():
        content = path.read_text(encoding='utf-8')
        original = content

        # 1. Fix nested links
        content = fix_nested_wikilinks(content)

        # 2. Inject hub backlink
        hub_stem = stem.split(' — ')[0].strip()
        hub_display = hub_stem.replace('[게임] ', '')
        content = ensure_backlink(content, hub_stem, hub_display)

        if content != original:
            path.write_text(content, encoding='utf-8')
            if fix_nested_wikilinks(original) != original:
                fixed_nested += 1
            if hub_stem not in original:
                fixed_backlink += 1

    # ── Fix hubs ────────────────────────────────────────────────────────────
    for stem, path in hubs.items():
        content = path.read_text(encoding='utf-8')
        original = content

        # 1. Fix nested links
        content = fix_nested_wikilinks(content)

        # 2. Fill in spoke links
        my_spokes = hub_spokes.get(stem, [])
        content = ensure_spoke_links_in_hub(content, stem, my_spokes)

        if content != original:
            path.write_text(content, encoding='utf-8')
            fixed_hub += 1

    total = len(all_files)
    print(f"[fix_game_ref_links] Done ({total} files)")
    print(f"  Nested links fixed:  {fixed_nested} files")
    print(f"  Backlinks injected:  {fixed_backlink} files")
    print(f"  Hubs completed:      {fixed_hub} files")


if __name__ == '__main__':
    main()
