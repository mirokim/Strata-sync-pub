#!/usr/bin/env python3
"""
extract_images.py — §4.2 PDF image extraction standalone script

Features:
  - Extract images from a single PDF or every PDF in a folder
  - Save images into the attachments/ folder
  - Filename rule: {stem}_p{page}_{index}.png  (§4.0 common principle)
  - Minimum size filter: exclude icons/bullets under 100px in both width and height
  - Print the list of extracted images and the wikilink strings to insert into MD

Libraries:
  pip install pymupdf Pillow

Usage:
  python extract_images.py <input_pdf_or_dir> <attachments_dir> [--min-width 100] [--min-height 100] [--verbose]
"""

import sys
import argparse
from pathlib import Path


MIN_WIDTH_DEFAULT  = 100   # Minimum width in pixels
MIN_HEIGHT_DEFAULT = 100   # Minimum height in pixels


def extract_images_from_pdf(pdf_path: Path, attachments_dir: Path,
                             min_width: int, min_height: int,
                             verbose: bool) -> list[Path]:
    """Extract images from a single PDF and save to attachments_dir."""
    try:
        import fitz  # pymupdf
    except ImportError:
        print("Error: pymupdf not installed. Run 'pip install pymupdf' and retry.")
        sys.exit(1)

    attachments_dir.mkdir(parents=True, exist_ok=True)

    doc      = fitz.open(str(pdf_path))
    stem     = pdf_path.stem
    saved    = []
    idx_global = 0

    for page_num, page in enumerate(doc, start=1):
        image_list = page.get_images(full=True)
        for img_idx, img_info in enumerate(image_list, start=1):
            xref = img_info[0]
            try:
                base_img = doc.extract_image(xref)
            except Exception:
                continue

            width  = base_img.get('width',  0)
            height = base_img.get('height', 0)
            if width < min_width or height < min_height:
                if verbose:
                    print(f"  Skipped (small {width}×{height}): p{page_num}_{img_idx}")
                continue

            ext      = base_img.get('ext', 'png')
            img_data = base_img['image']

            # Normalize to PNG (every format including JPEG/WebP → saved as PNG)
            out_name = f"{stem}_p{page_num:03d}_{img_idx:02d}.png"
            out_path = attachments_dir / out_name

            if ext == 'png':
                out_path.write_bytes(img_data)
            else:
                # Convert via PIL
                try:
                    from PIL import Image
                    import io
                    img_obj = Image.open(io.BytesIO(img_data)).convert('RGBA')
                    img_obj.save(str(out_path), 'PNG')
                except ImportError:
                    # Without PIL, save with the original extension
                    out_path = attachments_dir / f"{stem}_p{page_num:03d}_{img_idx:02d}.{ext}"
                    out_path.write_bytes(img_data)
                except Exception:
                    out_path.write_bytes(img_data)

            saved.append(out_path)
            idx_global += 1
            if verbose:
                print(f"  Extracted: {out_path.name}  ({width}×{height})")

    doc.close()
    return saved


def generate_wikilinks(saved: list[Path]) -> str:
    """Generate MD wikilink strings for extracted image list."""
    if not saved:
        return ''
    lines = ['', '## Extracted Images', '']
    for p in saved:
        lines.append(f'![[{p.name}]]')
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='§4.2 PDF image extraction')
    parser.add_argument('input',           help='PDF file or folder containing PDF files')
    parser.add_argument('attachments_dir', help='Image output folder (attachments/)')
    parser.add_argument('--min-width',  type=int, default=MIN_WIDTH_DEFAULT,
                        help=f'Minimum width in pixels (default: {MIN_WIDTH_DEFAULT})')
    parser.add_argument('--min-height', type=int, default=MIN_HEIGHT_DEFAULT,
                        help=f'Minimum height in pixels (default: {MIN_HEIGHT_DEFAULT})')
    parser.add_argument('--verbose', '-v', action='store_true')
    args = parser.parse_args()

    input_path = Path(args.input)
    att_dir    = Path(args.attachments_dir)

    if input_path.is_file():
        pdf_files = [input_path]
    elif input_path.is_dir():
        pdf_files = sorted(input_path.glob('*.pdf'))
    else:
        print(f"Error: {input_path} not found"); sys.exit(1)

    total_saved = 0
    for pdf in pdf_files:
        print(f"\nProcessing: {pdf.name}")
        saved = extract_images_from_pdf(
            pdf, att_dir, args.min_width, args.min_height, args.verbose
        )
        total_saved += len(saved)
        if saved:
            print(f"  → {len(saved)} images extracted")
            print(generate_wikilinks(saved))
        else:
            print("  → No images extracted (after excluding small ones)")

    print(f"\n{'='*50}")
    print(f"§4.2 extract_images Complete")
    print(f"{'='*50}")
    print(f"  Processed PDFs:   {len(pdf_files)}")
    print(f"  Extracted Images: {total_saved} → {att_dir}")


if __name__ == '__main__':
    main()
