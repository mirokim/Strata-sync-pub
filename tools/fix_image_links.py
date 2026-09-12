#!/usr/bin/env python3
"""
fix_image_links.py — Fix broken image links for filenames with parentheses

Problem: when referencing attachments whose filename contains ')'
  ![[stem_without_paren]]_N.ext)   ← malformed
  ![[stem_without_paren) rest]]_N.ext)  ← malformed

Cause: in postprocess_md the regex [^)]+ stops at ')', truncating the filename

Fix: restore both patterns by matching against the attachment file list

Usage:
  python fix_image_links.py <active_dir> <attachments_dir>
"""

import re
import sys
from pathlib import Path


def fix_image_links(active_dir: Path, attachments_dir: Path) -> int:
    all_attachments = {f.name for f in attachments_dir.iterdir()} if attachments_dir.exists() else set()

    # Pattern 1: ![[STEM]]_N.ext)  → when STEM + ')' + _N.ext exists in attachments
    pattern1 = re.compile(r'!\[\[([^\]]+)\]\](_\d+\.\w+)\)')

    # Pattern 2: ![[STEM]] REST)   → when STEM + ')' + REST exists in attachments
    pattern2 = re.compile(r'!\[\[([^\]]+)\]\]([^)]*)\)')

    total_fixed = 0

    for md in sorted(active_dir.glob('*.md')):
        content = md.read_text(encoding='utf-8', errors='replace')

        def fix_p1(m):
            stem, suffix = m.group(1), m.group(2)
            candidate = f"{stem}){suffix}"
            if candidate in all_attachments:
                return f'![[{candidate}]]'
            return m.group(0)

        def fix_p2(m):
            stem, suffix = m.group(1), m.group(2)
            candidate = f"{stem}){suffix}"
            if candidate in all_attachments:
                return f'![[{candidate}]]'
            return m.group(0)

        new_content, n1 = pattern1.subn(fix_p1, content)
        new_content, n2 = pattern2.subn(fix_p2, new_content)
        n = n1 + n2

        if n > 0:
            md.write_text(new_content, encoding='utf-8')
            total_fixed += n
            print(f"  Modified: {md.name} ({n})")

    return total_fixed


def main():
    if len(sys.argv) < 3:
        print(f"Usage: python {sys.argv[0]} <active_dir> <attachments_dir>")
        sys.exit(1)

    active_dir = Path(sys.argv[1])
    attachments_dir = Path(sys.argv[2])

    print("Image link bug fix starting...")
    n = fix_image_links(active_dir, attachments_dir)
    print(f"\n{n} links fixed, Complete")


if __name__ == '__main__':
    main()
