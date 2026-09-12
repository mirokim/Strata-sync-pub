#!/usr/bin/env python3
"""
incremental_update.py — Incremental processing tool for new HTML files

When new Confluence HTML files are added to downloaded_pages/
Skip files already in refined_vault/ and convert only new files.

Usage:
  python incremental_update.py \\
      --src    /path/to/downloaded_pages \\
      --vault  /path/to/refined_vault \\
      --scripts /path/to/.manual/scripts

  # Automatically run normalize + enhance + gen_index after conversion
  python incremental_update.py --src ... --vault ... --scripts ... --full-pipeline
"""

import sys
import subprocess
import argparse
from pathlib import Path


def get_existing_page_ids(active_dir: Path) -> set:
    """Collect page_ids of already converted files."""
    import re
    ids = set()
    for md in active_dir.glob('*.md'):
        try:
            content = md.read_text(encoding='utf-8', errors='replace')[:400]
            m = re.search(r'page_id:\s*["\']?(\d+)["\']?', content)
            if m:
                ids.add(m.group(1))
        except Exception:
            continue
    return ids


def find_new_html_files(src_dirs: list, existing_ids: set) -> list:
    """List of new HTML files (excluding existing page_ids)."""
    import re
    new_files = []
    for src_dir in src_dirs:
        src_path = Path(src_dir)
        if not src_path.is_dir():
            print(f"  ⚠️  Path not found: {src_dir}")
            continue
        for html in src_path.glob('*.html'):
            # Extract page_id from the filename (digits_title.html format)
            m = re.match(r'^(\d+)_', html.stem)
            page_id = m.group(1) if m else None
            if page_id and page_id in existing_ids:
                continue  # Already exists
            new_files.append(html)
    return new_files


def run_pipeline_step(script: Path, args: list):
    """Execute external script."""
    cmd = [sys.executable, str(script)] + args
    result = subprocess.run(cmd, capture_output=False)
    return result.returncode


def main():
    parser = argparse.ArgumentParser(description='Incremental conversion of new HTML files')
    parser.add_argument('--src', nargs='+', required=True,
                        help='downloaded_pages folder path(s) (multiple allowed)')
    parser.add_argument('--vault', required=True,
                        help='refined_vault/ folder path')
    parser.add_argument('--scripts', required=True,
                        help='.manual/scripts/ folder path')
    parser.add_argument('--full-pipeline', action='store_true',
                        help='Run normalize + enhance + gen_index after conversion')
    args = parser.parse_args()

    vault = Path(args.vault)
    active_dir = vault / 'active'
    scripts_dir = Path(args.scripts)

    if not active_dir.is_dir():
        print(f"Error: active/ folder not found: {active_dir}")
        sys.exit(1)

    print("Collecting existing page_ids...")
    existing = get_existing_page_ids(active_dir)
    print(f"  Existing files: {len(existing)}")

    print("Searching for new HTML files...")
    new_html = find_new_html_files(args.src, existing)
    print(f"  New files: {len(new_html)}")

    if not new_html:
        print("No new files. Exiting.")
        return

    # Gather the new files in a temporary folder and convert
    import tempfile, shutil
    with tempfile.TemporaryDirectory() as tmp:
        tmp_src = Path(tmp) / 'new_html'
        tmp_src.mkdir()
        for html in new_html:
            # Copy the files folder along with it
            shutil.copy2(html, tmp_src / html.name)
            files_dir = html.parent / f'{html.stem}_files'
            if files_dir.is_dir():
                shutil.copytree(files_dir, tmp_src / files_dir.name)

        print(f"\nStarting conversion ({len(new_html)} files)...")
        ret = run_pipeline_step(
            scripts_dir / 'refine_html_to_md.py',
            [str(tmp_src), str(active_dir), str(vault / 'attachments')]
        )
        if ret != 0:
            print("Conversion failed!")
            sys.exit(ret)

    if args.full_pipeline:
        print("\nRunning additional pipeline steps...")

        print("  normalize_frontmatter.py ...")
        run_pipeline_step(scripts_dir / 'normalize_frontmatter.py', [str(active_dir)])

        print("  enhance_wikilinks.py ...")
        run_pipeline_step(scripts_dir / 'enhance_wikilinks.py', [str(active_dir)])

        print("  inject_keywords.py ...")
        inject = scripts_dir / 'inject_keywords.py'
        if not inject.exists():
            inject = scripts_dir.parent.parent / '.tools' / 'inject_keywords.py'
        if inject.exists():
            run_pipeline_step(inject, [str(active_dir)])

        print("  gen_year_hubs.py ...")
        run_pipeline_step(scripts_dir / 'gen_year_hubs.py', [str(active_dir)])

        print("  gen_index.py ...")
        run_pipeline_step(scripts_dir / 'gen_index.py', [str(active_dir)])

    print("\n✅ Incremental update Complete")


if __name__ == '__main__':
    main()
