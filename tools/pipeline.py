#!/usr/bin/env python3
"""
pipeline.py — Graph RAG data refinement manual v3.8 integrated Pipeline
Phase 2: Source file → MD conversion (following §4.0 common principles)

Execution order:
  1. HTML → MD  (refine_html_to_md.py §4.1)
  2. PPTX → MD  (pptx_to_md.py §4.3)  — attachments in _files folders
  3. DOCX → MD  (docx_to_md.py §4.5)  — attachments in _files folders

Usage:
  python pipeline.py \
      --html-dirs <dir1> [<dir2> ...] \
      --vault <refined_vault_path> \
      [--workers N] \
      [--step html|pptx|docx|all]
"""

import sys
import argparse
import subprocess
from pathlib import Path
import time


SCRIPT_DIR = Path(__file__).parent


def run_step(label: str, cmd: list, cwd: Path = None) -> bool:
    """Execute subprocess. Returns success status."""
    print(f"\n{'='*60}")
    print(f"[{label}] {' '.join(str(c) for c in cmd)}")
    print('='*60)
    t0 = time.time()
    result = subprocess.run(cmd, cwd=cwd)
    elapsed = time.time() - t0
    ok = result.returncode == 0
    status = "Complete" if ok else f"error (code {result.returncode})"
    print(f"\n→ {label} {status} ({elapsed:.1f}s)")
    return ok


def collect_pptx_docx_dirs(html_dirs: list[Path]) -> tuple[list[Path], list[Path]]:
    """
    Collect PPTX/DOCX file paths from the _files folders under html_dirs.
    Returns: (pptx_paths, docx_paths)
    """
    pptx_paths = []
    docx_paths = []
    for html_dir in html_dirs:
        if not html_dir.exists():
            continue
        for files_dir in html_dir.glob('*_files'):
            if not files_dir.is_dir():
                continue
            pptx_paths.extend(sorted(files_dir.glob('*.pptx')))
            docx_paths.extend(sorted(files_dir.glob('*.docx')))
    return pptx_paths, docx_paths


def write_file_list(paths: list[Path], out_path: Path):
    """Save file path list to text file."""
    with open(out_path, 'w', encoding='utf-8') as f:
        for p in paths:
            f.write(str(p) + '\n')


def main():
    parser = argparse.ArgumentParser(description='Graph RAG data refinement integrated Pipeline (§4)')
    parser.add_argument('--html-dirs', nargs='+', required=True,
                        help='Folder(s) containing HTML files, e.g. downloaded_pages downloaded_pages2')
    parser.add_argument('--vault', default='refined_vault',
                        help='Output vault root folder (default: refined_vault)')
    parser.add_argument('--workers', type=int, default=None,
                        help='Number of parallel workers for HTML conversion (default: CPU count)')
    parser.add_argument('--step', choices=['html', 'pptx', 'docx', 'all'], default='all',
                        help='Step to run (default: all)')
    args = parser.parse_args()

    vault = Path(args.vault).resolve()
    active_dir = vault / 'active'
    attachments_dir = vault / 'attachments'
    archive_dir = vault / '.archive'

    for d in [active_dir, attachments_dir, archive_dir]:
        d.mkdir(parents=True, exist_ok=True)

    html_dirs = [Path(d).resolve() for d in args.html_dirs]

    print(f"\nGraph RAG data refinement Pipeline v3.8")
    print(f"  HTML sources: {[str(d) for d in html_dirs]}")
    print(f"  Output vault: {vault}")
    print(f"  Step: {args.step}")

    t_total = time.time()
    success = True

    # ── Step 1: HTML → MD ─────────────────────────────────────────────────
    if args.step in ('html', 'all'):
        cmd = [
            sys.executable,
            str(SCRIPT_DIR / 'refine_html_to_md.py'),
        ] + [str(d) for d in html_dirs] + [
            '--active', str(active_dir),
            '--attachments', str(attachments_dir),
        ]
        if args.workers:
            cmd += ['--workers', str(args.workers)]

        ok = run_step('HTML → MD', cmd)
        success = success and ok

    # ── Step 2: PPTX → MD (attachments in _files folders) ────────────────
    if args.step in ('pptx', 'all'):
        pptx_paths, _ = collect_pptx_docx_dirs(html_dirs)
        if pptx_paths:
            print(f"\n[PPTX] {len(pptx_paths)} PPTX files found in _files folders")
            # Save the path list to a temporary file
            list_file = vault / '.pptx_list.txt'
            write_file_list(pptx_paths, list_file)

            cmd = [
                sys.executable,
                str(SCRIPT_DIR / 'pptx_to_md.py'),
            ] + [str(p) for p in pptx_paths] + [
                '--active', str(active_dir),
                '--attachments', str(attachments_dir),
            ]
            ok = run_step('PPTX → MD', cmd)
            success = success and ok
        else:
            print("\n[PPTX] No PPTX in _files folders — Skipped")

    # ── Step 3: DOCX → MD (attachments in _files folders) ────────────────
    if args.step in ('docx', 'all'):
        _, docx_paths = collect_pptx_docx_dirs(html_dirs)
        if docx_paths:
            print(f"\n[DOCX] {len(docx_paths)} DOCX files found in _files folders")
            cmd = [
                sys.executable,
                str(SCRIPT_DIR / 'docx_to_md.py'),
            ] + [str(p) for p in docx_paths] + [
                '--active', str(active_dir),
                '--attachments', str(attachments_dir),
            ]
            ok = run_step('DOCX → MD', cmd)
            success = success and ok
        else:
            print("\n[DOCX] No DOCX in _files folders — Skipped")

    # ── Final tally ───────────────────────────────────────────────────────
    elapsed = time.time() - t_total
    active_count = len(list(active_dir.glob('*.md')))
    archive_count = len(list(archive_dir.glob('*.md')))
    att_count = len(list(attachments_dir.iterdir())) if attachments_dir.exists() else 0

    print(f"\n{'='*60}")
    print(f"Pipeline {'Complete' if success else 'Complete (some errors)'} ({elapsed:.1f}s)")
    print(f"  active/    : {active_count} MD files")
    print(f"  .archive/  : {archive_count} MD files (stubs)")
    print(f"  attachments: {att_count} attachments")
    print(f"  vault path : {vault}")
    print('='*60)

    if not success:
        sys.exit(1)


if __name__ == '__main__':
    main()
