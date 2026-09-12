"""
Automatic speaker field injection script (inject_speaker.py)  v1.0
────────────────────────────────────────────────────────
Function:
  Infers and injects the speaker field automatically based on the frontmatter tags.
  Files that already have a speaker field are skipped.

Tag → speaker mapping:
  chief                    → chief_director
  art                      → art_director
  tech / prog              → tech_director
  spec / plan / design     → design_director
  level                    → level_director
  none of the above        → unknown

Usage:
    python inject_speaker.py <vault_dir>

Dependencies:
    pip install PyYAML
"""

import os
import re
import sys
import yaml

# ── Tag → speaker mapping (order matters: first match wins) ────────────────
TAG_TO_SPEAKER: list[tuple[set[str], str]] = [
    ({'chief'},                  'chief_director'),
    ({'art'},                    'art_director'),
    ({'tech', 'prog'},           'tech_director'),
    ({'spec', 'plan', 'design'}, 'design_director'),
    ({'level'},                  'level_director'),
]
DEFAULT_SPEAKER = 'unknown'


def load_frontmatter(text: str) -> tuple[dict, int]:
    """Parse the YAML frontmatter. Returns (fm_dict, fm_end_idx); ({}, -1) if there is no frontmatter."""
    if not text.startswith('---'):
        return {}, -1
    close = text.find('\n---', 3)
    if close == -1:
        return {}, -1
    fm_end = close + 4  # Up to and including \n---
    try:
        fm = yaml.safe_load(text[3:close]) or {}
    except Exception:
        fm = {}
    return fm, fm_end


def infer_speaker(tags: list) -> str:
    tag_set = {str(t).lower() for t in tags}
    for tag_keywords, speaker in TAG_TO_SPEAKER:
        if tag_set & tag_keywords:
            return speaker
    return DEFAULT_SPEAKER


def inject_speaker_field(text: str, speaker: str) -> str:
    """Insert the speaker field into the frontmatter block right after the tags line."""
    # Locate the frontmatter range
    close = text.find('\n---', 3)
    fm_block = text[3:close]  # Content between --- and \n---

    # Find the tags: line and insert right after it
    tags_pat = re.compile(r'^(tags\s*:.*(?:\n  ?-[^\n]+)*)', re.MULTILINE)
    m = tags_pat.search(fm_block)
    if m:
        insert_pos = m.end()
        new_fm = fm_block[:insert_pos] + f'\nspeaker: {speaker}' + fm_block[insert_pos:]
    else:
        # If the tags line is not found, append at the end of the frontmatter
        new_fm = fm_block.rstrip('\n') + f'\nspeaker: {speaker}\n'

    return '---' + new_fm + text[close:]


def resolve_active_dir(vault_dir: str) -> str:
    """Return whichever of the vault root or the active/ subfolder actually holds the md files."""
    active = os.path.join(vault_dir, 'active')
    if os.path.isdir(active):
        return active
    return vault_dir


def run(vault_dir: str) -> None:
    active_dir = resolve_active_dir(vault_dir)
    files = sorted(f for f in os.listdir(active_dir) if f.endswith('.md'))
    updated = 0
    skipped_has = 0
    skipped_no_fm = 0
    speaker_counts: dict[str, int] = {}

    for fname in files:
        path = os.path.join(active_dir, fname)
        try:
            with open(path, encoding='utf-8') as f:
                text = f.read()
        except Exception:
            continue

        fm, fm_end = load_frontmatter(text)
        if fm_end == -1:
            skipped_no_fm += 1
            continue
        if 'speaker' in fm:
            skipped_has += 1
            continue

        tags = fm.get('tags', [])
        if isinstance(tags, str):
            tags = [tags]
        speaker = infer_speaker(tags or [])

        new_text = inject_speaker_field(text, speaker)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_text)

        speaker_counts[speaker] = speaker_counts.get(speaker, 0) + 1
        updated += 1

    print(f'Done: speaker field injected into {updated} files')
    print(f'Skipped (already present): {skipped_has}  |  Skipped (no frontmatter): {skipped_no_fm}')
    if speaker_counts:
        print()
        print(f"{'speaker':<30} {'Files':>8}")
        print('-' * 40)
        for sp, cnt in sorted(speaker_counts.items(), key=lambda x: -x[1]):
            print(f'{sp:<30} {cnt:>8}')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python inject_speaker.py <vault_dir>', file=sys.stderr)
        sys.exit(1)
    run(sys.argv[1])
