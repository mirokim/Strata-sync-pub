#!/usr/bin/env python3
"""
pdf_import.py — PDF → Markdown conversion and vault storage

Uses the opendataloader-pdf library (top-ranked PDF parser in benchmarks)
  pip install -U opendataloader-pdf

Usage:
  python pdf_import.py <pdf_path_or_dir> <output_dir> [--title <title>]

Output:
  - <output_dir>/<title>.md  (single PDF)
  - <output_dir>/<each filename>.md  (folder input)
"""

import argparse
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path


def safe_filename(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*]', '_', name).strip()


def make_frontmatter(title: str, source_path: str, today: str) -> str:
    return (
        f'---\n'
        f'title: "{title.replace(chr(34), chr(39))}"\n'
        f'created: {today}\n'
        f'modified: {today}\n'
        f'source: pdf\n'
        f'source_file: "{Path(source_path).name}"\n'
        f'tags: [pdf]\n'
        f'---\n\n'
    )


def convert_pdf(input_path: str, output_dir: str, title: str | None = None) -> list[str]:
    try:
        import opendataloader_pdf  # type: ignore
    except ImportError:
        print("ERROR: opendataloader-pdf not installed\n  pip install -U opendataloader-pdf", file=sys.stderr)
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)
    today = datetime.today().strftime('%Y-%m-%d')
    results: list[str] = []

    with tempfile.TemporaryDirectory() as tmp:
        opendataloader_pdf.convert(
            input_path=[input_path],
            output_dir=tmp,
            format='markdown',
        )

        md_files = list(Path(tmp).rglob('*.md'))
        if not md_files:
            print(f"ERROR: {input_path} — no Markdown output", file=sys.stderr)
            sys.exit(2)

        for md_file in md_files:
            raw = md_file.read_text(encoding='utf-8', errors='replace')

            # Determine the title: explicit > first H1 > PDF filename
            doc_title = title
            if not doc_title:
                m = re.search(r'^#\s+(.+)', raw, re.MULTILINE)
                doc_title = m.group(1).strip() if m else Path(input_path).stem

            filename = safe_filename(doc_title) + '.md'
            dest = Path(output_dir) / filename

            content = make_frontmatter(doc_title, input_path, today) + raw
            dest.write_text(content, encoding='utf-8')
            results.append(f'✓ {filename} ({len(raw):,} chars)')

    return results


def main() -> None:
    parser = argparse.ArgumentParser(description='PDF → Markdown conversion')
    parser.add_argument('input',  help='PDF file or folder path')
    parser.add_argument('output', help='Vault folder path to save into')
    parser.add_argument('--title', default='', help='Document title (for a single PDF)')
    args = parser.parse_args()

    input_path = args.input
    if not os.path.exists(input_path):
        print(f'ERROR: file not found: {input_path}', file=sys.stderr)
        sys.exit(1)

    title = args.title.strip() or None
    results = convert_pdf(input_path, args.output, title)

    print(f'PDF conversion Complete ({len(results)} files)')
    for r in results:
        print(r)


if __name__ == '__main__':
    main()
