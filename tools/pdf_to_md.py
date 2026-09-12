#!/usr/bin/env python3
"""
pdf_to_md.py — §4.2 PDF → Obsidian Markdown conversion

PDF auto-routes to three cases:
  Text PDF    — text + tables extracted with pdfplumber, images with pymupdf
  Scanned PDF — each full page converted to a PNG image (OCR can be skipped)
  Hybrid PDF  — text extraction + page images in parallel (art/design slides, etc.)

Image filename rule: {stem}_p{page_number}_{index}.png

Usage:
  python pdf_to_md.py <src_dir_or_file> <active_dir> <attachments_dir>

  # Single file
  python pdf_to_md.py /path/file.pdf active/ attachments/

  # Folder recursion (including _files subfolders)
  python pdf_to_md.py /path/downloaded_pages active/ attachments/
"""

import re
import sys
import os
import shutil
import argparse
from pathlib import Path
from datetime import datetime

try:
    import pdfplumber
except ImportError:
    print("ERROR: pip install pdfplumber --break-system-packages")
    sys.exit(1)

try:
    import fitz  # pymupdf
except ImportError:
    print("ERROR: pip install pymupdf --break-system-packages")
    sys.exit(1)


# ── Noise removal patterns (§4.2.1) ─────────────────────────────────────
NOISE_PATTERNS = [
    re.compile(r'Powered\s+by\s+Confluence', re.I),
    re.compile(r'Edit\s+this\s+page', re.I),
    re.compile(r'View\s+history', re.I),
    re.compile(r'All\s+rights\s+reserved', re.I),
    re.compile(r'CC\s+BY', re.I),
    re.compile(r'https?://\S+\s+\d+/\d+'),   # URL + page number
    re.compile(r'^\s*\d+\s*/\s*\d+\s*$'),      # Standalone page number
]

# A page with at least this much text counts as a "text PDF"
TEXT_PDF_THRESHOLD = 150   # chars/page
HYBRID_THRESHOLD   = 30    # chars/page (below this = pure scan)

# Image DPI (for page → PNG conversion)
PAGE_IMAGE_DPI = 150


def detect_pdf_type(pdf_path: Path) -> str:
    """Determine the PDF kind: 'text' | 'hybrid' | 'scan'"""
    try:
        with pdfplumber.open(pdf_path) as pdf:
            if not pdf.pages:
                return 'scan'
            sample_pages = pdf.pages[:min(3, len(pdf.pages))]
            total_chars = sum(
                len((p.extract_text() or '').strip())
                for p in sample_pages
            )
            avg = total_chars / len(sample_pages)
            if avg >= TEXT_PDF_THRESHOLD:
                return 'text'
            elif avg >= HYBRID_THRESHOLD:
                return 'hybrid'
            else:
                return 'scan'
    except Exception:
        return 'scan'


def clean_text(text: str) -> str:
    """Remove noise and normalize"""
    if not text:
        return ''
    lines = text.split('\n')
    cleaned = []
    for line in lines:
        if any(p.search(line) for p in NOISE_PATTERNS):
            continue
        cleaned.append(line)
    return '\n'.join(cleaned).strip()


def extract_page_image(page, stem: str, page_num: int, img_idx: int, attachments_dir: Path) -> str:
    """Convert a pymupdf page to PNG and save into attachments/. Returns the filename."""
    fname = f"{stem}_p{page_num}_{img_idx}.png"
    out_path = attachments_dir / fname
    if out_path.exists():
        return fname
    try:
        mat = fitz.Matrix(PAGE_IMAGE_DPI / 72, PAGE_IMAGE_DPI / 72)
        pix = page.get_pixmap(matrix=mat, alpha=False)
        pix.save(str(out_path))
        return fname
    except Exception as e:
        return ''


def extract_embedded_images(fitz_page, stem: str, page_num: int, attachments_dir: Path) -> list:
    """Extract images embedded in the page. Returns a list of filenames."""
    fnames = []
    try:
        image_list = fitz_page.get_images(full=True)
        for img_idx, img_info in enumerate(image_list, start=1):
            xref = img_info[0]
            fname = f"{stem}_p{page_num}_{img_idx}.png"
            out_path = attachments_dir / fname
            if out_path.exists():
                fnames.append(fname)
                continue
            try:
                base_image = fitz_page.parent.extract_image(xref)
                img_bytes = base_image.get('image', b'')
                ext = base_image.get('ext', 'png')
                if img_bytes and len(img_bytes) > 2000:  # Exclude very small images (icons)
                    fname_ext = f"{stem}_p{page_num}_{img_idx}.{ext}"
                    out_path_ext = attachments_dir / fname_ext
                    out_path_ext.write_bytes(img_bytes)
                    fnames.append(fname_ext)
            except Exception:
                continue
    except Exception:
        pass
    return fnames


def pdf_to_md(pdf_path: Path, active_dir: Path, attachments_dir: Path) -> bool:
    """Convert a single PDF to MD. Returns True on success."""
    stem = pdf_path.stem
    # Clean special characters (those not allowed in filenames)
    safe_stem = re.sub(r'[<>:"/\\|?*]', '_', stem)
    out_md = active_dir / f"{safe_stem}.md"

    if out_md.exists():
        return False  # Already converted

    pdf_type = detect_pdf_type(pdf_path)
    sections = []
    image_files = []

    try:
        with pdfplumber.open(pdf_path) as pdf:
            n_pages = len(pdf.pages)
            doc = fitz.open(str(pdf_path))

            for page_num in range(1, n_pages + 1):
                pl_page = pdf.pages[page_num - 1]
                fz_page = doc[page_num - 1]
                section_lines = [f"## 페이지 {page_num}"]

                # Text extraction
                raw_text = pl_page.extract_text() or ''
                text = clean_text(raw_text)

                # Table extraction
                tables_md = []
                try:
                    for tbl in pl_page.extract_tables():
                        if not tbl:
                            continue
                        rows = []
                        for i, row in enumerate(tbl):
                            cells = [str(c or '').replace('\n', ' ').replace('|', '\\|') for c in row]
                            rows.append('| ' + ' | '.join(cells) + ' |')
                            if i == 0:
                                rows.append('| ' + ' | '.join(['---'] * len(cells)) + ' |')
                        tables_md.append('\n'.join(rows))
                except Exception:
                    pass

                # Image handling
                if pdf_type == 'text':
                    # Text PDF: extract embedded images only
                    imgs = extract_embedded_images(fz_page, safe_stem, page_num, attachments_dir)
                    image_files.extend(imgs)
                elif pdf_type == 'hybrid':
                    # Hybrid: pages with no text are replaced by a full-page image
                    if len(text.strip()) < 50:
                        fname = extract_page_image(fz_page, safe_stem, page_num, 1, attachments_dir)
                        if fname:
                            image_files.append(fname)
                            imgs = [fname]
                        else:
                            imgs = []
                    else:
                        imgs = extract_embedded_images(fz_page, safe_stem, page_num, attachments_dir)
                        image_files.extend(imgs)
                else:  # scan
                    # Scan: full-page image
                    fname = extract_page_image(fz_page, safe_stem, page_num, 1, attachments_dir)
                    if fname:
                        image_files.append(fname)
                        imgs = [fname]
                    else:
                        imgs = []

                # Build the section
                if text:
                    section_lines.append(text)
                for tbl in tables_md:
                    section_lines.append(tbl)
                for img in (imgs if pdf_type != 'text' else image_files[-len(imgs):]):
                    section_lines.append(f"![[{img}]]")

                sections.append('\n\n'.join(section_lines))

            doc.close()

    except Exception as e:
        print(f"  ✗ {pdf_path.name}: {e}")
        return False

    # frontmatter
    try:
        mtime = pdf_path.stat().st_mtime
        date_str = datetime.fromtimestamp(mtime).strftime('%Y-%m-%d')
    except Exception:
        date_str = datetime.now().strftime('%Y-%m-%d')

    # Try to extract date from filename
    m_date = re.search(r'(\d{4})[_\-]?(\d{2})[_\-]?(\d{2})', stem)
    if m_date:
        try:
            date_str = f"{m_date.group(1)}-{m_date.group(2)}-{m_date.group(3)}"
        except Exception:
            pass

    # Estimate type
    doc_type = 'spec'
    if any(kw in stem for kw in ['정례', '보고', '피드백', '회의', '이사장']):
        doc_type = 'meeting'
    elif any(kw in stem for kw in ['가이드', '매뉴얼', '튜토리얼']):
        doc_type = 'guide'
    elif any(kw in stem for kw in ['레퍼런스', '분석', '조사']):
        doc_type = 'reference'

    # Generate body
    body_content = '\n\n---\n\n'.join(sections)

    n_img = len(image_files)
    md_content = f"""---
title: "{stem}"
date: {date_str}
type: {doc_type}
status: active
tags: []
source: "{pdf_path.name}"
origin: pdf
pdf_type: {pdf_type}
pages: {n_pages if 'n_pages' in dir() else 0}
---

# {stem}

> 원본: `{pdf_path.name}` ({pdf_type} PDF, {n_pages if 'n_pages' in dir() else '?'}페이지)

## 개요

{body_content}
"""

    out_md.write_text(md_content, encoding='utf-8')
    return True


def process_directory(src_dir: Path, active_dir: Path, attachments_dir: Path) -> tuple:
    """Process all PDFs (recursive) in directory. Returns (success, fail, skip)."""
    pdfs = list(src_dir.rglob('*.pdf'))
    success = skip = fail = 0
    for pdf in pdfs:
        safe = re.sub(r'[<>:"/\\|?*]', '_', pdf.stem)
        already_exists = (active_dir / f"{safe}.md").exists()
        if already_exists:
            skip += 1
            continue
        ok = pdf_to_md(pdf, active_dir, attachments_dir)
        if ok:
            success += 1
            if success % 20 == 0:
                print(f"  ... {success} Complete")
        else:
            fail += 1
    return success, fail, skip


def main():
    parser = argparse.ArgumentParser(description='§4.2 PDF → Markdown conversion')
    parser.add_argument('src', help='PDF file or directory path')
    parser.add_argument('active_dir', help='active/ folder path')
    parser.add_argument('attachments_dir', help='attachments/ folder path')
    args = parser.parse_args()

    src = Path(args.src)
    active_dir = Path(args.active_dir)
    attachments_dir = Path(args.attachments_dir)

    active_dir.mkdir(parents=True, exist_ok=True)
    attachments_dir.mkdir(parents=True, exist_ok=True)

    if src.is_file():
        ok = pdf_to_md(src, active_dir, attachments_dir)
        print('✅ Conversion Complete' if ok else '⚠️ Skipped')
    elif src.is_dir():
        print(f"PDF Starting conversion: {src}")
        total = len(list(src.rglob('*.pdf')))
        print(f"{total} PDFs found")
        success, fail, skip = process_directory(src, active_dir, attachments_dir)
        print(f"\n=== §4.2 PDF conversion Complete ===")
        print(f"  Success: {success}")
        print(f"  Fail: {fail}")
        print(f"  Skipped: {skip} (already exist)")
    else:
        print(f"Error: {src} not found.")
        sys.exit(1)


if __name__ == '__main__':
    main()
