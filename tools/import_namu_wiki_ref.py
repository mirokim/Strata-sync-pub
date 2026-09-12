"""
import_namu_wiki_ref.py — Convert Namu Wiki PDFs into external game reference MD files

Usage:
  python import_namu_wiki_ref.py --src /path/to/.game_ref --vault /path/to/refined_vault
  python import_namu_wiki_ref.py --src /path/to/.game_ref --vault /path/to/refined_vault --force
  python import_namu_wiki_ref.py --src /path/to/.game_ref --vault /path/to/refined_vault --index-only

Processing flow:
  1. Convert .game_ref/*.pdf → temporary active/ via pdf_to_md.py (reuses the existing refinement pipeline)
  2. Post-process the converted MD with type: external-reference frontmatter + contamination prevention marker
  3. Remove leftover Namu Wiki noise (URLs, ads, page paths)
  4. Restructure into hub-spoke: "{game}.md" → hub, "{game}_{section}.md" → spoke
  5. Save to _reference/games/[게임] {name}.md
  6. Refresh the _reference/index_reference_games.md index

Output location: {vault}/_reference/games/[게임] {name}.md
Dependencies: pdf_to_md.py (tools/), pdfplumber, pymupdf
"""

import argparse
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date
from pathlib import Path
from typing import Optional

# Force UTF-8 stdout on Windows
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if sys.stderr.encoding and sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ── Game name normalization ────────────────────────────────────────────────────

GAME_NAME_MAP = {
    "더 파이널스":           "더 파이널스 (The Finals)",
    "Deadlock(게임)":        "Deadlock",
    "Deadlock":              "Deadlock",
    "도타 2":                "도타 2 (Dota 2)",
    "리그 오브 레전드":       "리그 오브 레전드 (LoL)",
    "마블 라이벌즈":          "마블 라이벌즈 (Marvel Rivals)",
    "브롤스타즈":             "브롤스타즈 (Brawl Stars)",
    "아크 레이더스":          "아크 레이더스 (ARC Raiders)",
    "오버워치":               "오버워치 (Overwatch)",
    "크로스파이어(FPS)":      "크로스파이어",
    "포 아너":                "포 아너 (For Honor)",
    "포트나이트":             "포트나이트 (Fortnite)",
    "레고 포트나이트":        "레고 포트나이트 (LEGO Fortnite)",
    "리그 오브 레전드 유니버스": "리그 오브 레전드 유니버스",
}

SELECTION_REASONS = {
    "더 파이널스 (The Finals)":       "파괴 환경 + 집단 팀전, 샌드박스 PvP 구조 유사",
    "Deadlock":                        "밸브 MOBA 슈터 최신작, 레인 없는 하이브리드 구조",
    "도타 2 (Dota 2)":                 "MOBA 원형 — 역할·성장·오브젝트 시스템 기준",
    "리그 오브 레전드 (LoL)":          "MOBA 대중화 사례 — 챔피언 다양성·랭크 구조",
    "마블 라이벌즈 (Marvel Rivals)":   "히어로 슈터 비교 기준, 팀 시너지 메카닉",
    "브롤스타즈 (Brawl Stars)":        "모바일 집단 PvP — 짧은 매치·게임 모드 다양성",
    "아크 레이더스 (ARC Raiders)":     "PvPvE 샌드박스 — 환경 활용 전투 레퍼런스",
    "오버워치 (Overwatch)":            "팀 역할 분담(탱딜힐) + 영웅 교체 메타",
    "크로스파이어":                     "대규모 팀 FPS — 아시아 시장 성공 사례",
    "포 아너 (For Honor)":             "근접 전투 + 방향 기반 공방 시스템",
    "포트나이트 (Fortnite)":           "샌드박스 BR + 건설 메카닉 — 환경 변형 레퍼런스",
    "레고 포트나이트 (LEGO Fortnite)": "샌드박스 크래프팅 — 레고 포트나이트 비교",
    "리그 오브 레전드 유니버스":        "MOBA IP 세계관 확장 전략",
}

# Extra Namu Wiki noise patterns (ones pdf_to_md.py cannot catch)
NAMU_NOISE_RE = [
    re.compile(r"https?://namu\.wiki\S*", re.IGNORECASE),
    re.compile(r"^\s*나무위키.*\d{4}년.*$", re.MULTILINE),
    re.compile(r"최근 수정 시각.*\d{4}", re.MULTILINE | re.IGNORECASE),
    re.compile(r"CC BY-NC-SA\s*\d+\.\d+", re.IGNORECASE),
    re.compile(r"이 저작물은.{0,80}이용 허락", re.DOTALL),
    re.compile(r"크리에이티브 커먼즈", re.IGNORECASE),
]

# Namu Wiki numbered heading conversion (1. 개요 → ## 개요)
NAMU_HEADING_RE = re.compile(r"^(\d+(?:\.\d+)*)\.\s+(.+)$", re.MULTILINE)


def parse_pdf_name(filename: str) -> tuple:
    """
    Parse filename → (raw game name, section name or None)
    "리그 오브 레전드_챔피언 - 나무위키.pdf" → ("리그 오브 레전드", "챔피언")
    "더 파이널스 - 나무위키.pdf"              → ("더 파이널스", None)
    """
    stem = Path(filename).stem
    stem = re.sub(r"\s*-\s*나무위키.*$", "", stem).strip()
    # Parenthesized sub-classifiers like "(게임)" stay in the game name (handled by GAME_NAME_MAP)
    if "_" in stem:
        idx = stem.index("_")
        game    = stem[:idx].strip()
        section = stem[idx + 1:].strip()
    else:
        game    = stem
        section = None
    return game, section


def clean_namu_text(text: str) -> str:
    """Remove extra Namu Wiki noise + convert numbered headings."""
    for pattern in NAMU_NOISE_RE:
        text = pattern.sub("", text)

    def heading_replace(m: re.Match) -> str:
        num   = m.group(1)
        title = m.group(2).strip()
        depth = num.count(".") + 1
        return f"{'#' * min(depth + 1, 4)} {title}"

    text = NAMU_HEADING_RE.sub(heading_replace, text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def rewrite_frontmatter(content: str, game_name: str, section: Optional[str],
                         display_name: str, collected: str,
                         spoke_links: Optional[list] = None) -> str:
    """Replace the pdf_to_md.py output frontmatter with the external-reference format and insert the contamination prevention marker."""
    # Remove the existing frontmatter
    content = re.sub(r"^---\n.*?\n---\n", "", content, count=1, flags=re.DOTALL).strip()

    # Remove extra Namu Wiki noise
    content = clean_namu_text(content)

    lines = []

    # ── Frontmatter ────────────────────────────────────────────────────────────
    lines += [
        "---",
        "type: external-reference",
        f"ref_game: \"{display_name}\"",
        f"ref_source: \"namu-wiki\"",
        f"ref_collected: {collected}",
        "internal: false",
        "tags: [external-reference, game-analysis]",
        "---",
        "",
    ]

    # ── Contamination prevention marker ───────────────────────────────────────
    lines += [
        f"> ⚠️ **[외부 레퍼런스]** 이 문서는 **{display_name}** (외부 출시 게임)에 대한 데이터입니다.",
        "> 프로젝트 A 내부 의사결정 근거로 **직접 인용 금지**.",
        "> 비교 분석 컨텍스트로만 활용하세요.",
        f"> 출처: 나무위키 | 수집일: {collected}",
        "",
    ]

    # ── Title ─────────────────────────────────────────────────────────────────
    title = display_name if section is None else f"{display_name} — {section}"
    lines += [f"# {title}", ""]

    is_hub = section is None
    reason = SELECTION_REASONS.get(display_name, "")
    if reason and is_hub:
        lines += [f"> **선정 이유**: {reason}", ""]

    # ── Hub: spoke table of contents ──────────────────────────────────────────
    if is_hub and spoke_links:
        lines += ["## 세부 문서", ""]
        for stem, sec_name in spoke_links:
            lines.append(f"- [[{stem}|{display_name} — {sec_name}]]")
        lines += ["", "---", ""]

    # ── Body ──────────────────────────────────────────────────────────────────
    lines += [content, ""]

    # ── Comparative analysis notes (hub only) ─────────────────────────────────
    if is_hub:
        lines += [
            "---",
            "",
            "## 비교 분석 메모",
            "",
            "_프로젝트 A와의 비교 분석 시 아래를 채워넣으세요._",
            "",
            "- **유사점**:",
            "- **차이점**:",
            "- **참고할 점**:",
            "- **피해야 할 점**:",
            "",
        ]

    return "\n".join(lines)


def build_index(output_dir: str, vault_path: str, collected: str) -> None:
    games_dir  = Path(output_dir)
    game_files = sorted(games_dir.glob("[[]게임[]] *.md"))

    entries = []
    for f in game_files:
        if " — " in f.stem:
            continue  # Exclude spokes
        content   = f.read_text(encoding="utf-8", errors="ignore")
        ref_game  = re.search(r'^ref_game:\s*"?([^"\n]+)"?', content, re.MULTILINE)
        game_name = ref_game.group(1).strip() if ref_game else f.stem

        reason_m  = re.search(r'^\*\*선정 이유\*\*:\s*(.+)$', content, re.MULTILINE)
        reason    = reason_m.group(1).strip() if reason_m else SELECTION_REASONS.get(game_name, "")

        base = re.sub(r"\s*\(.*?\)", "", game_name).strip()
        spokes = [sf for sf in game_files if " — " in sf.stem and base.split(" (")[0] in sf.stem]

        entries.append({
            "stem":   f.stem,
            "name":   game_name,
            "reason": reason,
            "spokes": len(spokes),
        })

    lines = [
        "---",
        "type: reference-index",
        f"ref_collected: {collected}",
        "internal: true",
        "tags: [reference, game-analysis, index]",
        "---",
        "",
        "# 외부 게임 레퍼런스 인덱스",
        "",
        f"> 마지막 업데이트: {collected} | 수집 게임: {len(entries)}개 | 출처: 나무위키",
        "> 샌드박스 MOBA/집단 PvP 비교 레퍼런스. 내부 프로젝트 문서가 아님.",
        "",
        "---",
        "",
        "## 게임 목록",
        "",
        "| 게임 | 세부 문서 수 | 선정 이유 |",
        "|------|------------|---------|",
    ]
    for e in entries:
        wikilink   = f"[[{e['stem']}|{e['name']}]]"
        spokes_str = f"{e['spokes']}개" if e["spokes"] else "—"
        lines.append(f"| {wikilink} | {spokes_str} | {e['reason']} |")

    lines += ["", "---", "", "## 개별 문서 링크", ""]
    for e in entries:
        lines.append(f"- [[{e['stem']}|{e['name']}]]")

    lines += [
        "",
        "---",
        "",
        "> ⚠️ 이 인덱스의 모든 게임은 외부 출시 게임입니다. 프로젝트 A 의사결정 근거로 직접 인용 금지.",
        "",
    ]

    index_path = Path(vault_path) / "_reference" / "index_reference_games.md"
    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"  📋 Index updated → {index_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Namu Wiki PDF → external game reference MD conversion")
    parser.add_argument("--src",        required=True,       help="Path to the .game_ref folder")
    parser.add_argument("--vault",      required=True,       help="Vault root path (refined_vault)")
    parser.add_argument("--force",      action="store_true", help="Overwrite existing files too")
    parser.add_argument("--index-only", action="store_true", help="Regenerate only the index, without converting")
    parser.add_argument("--verbose",    action="store_true", help="Verbose output")
    args = parser.parse_args()

    src_dir    = Path(os.path.abspath(args.src))
    vault_path = Path(os.path.abspath(args.vault))
    output_dir = vault_path / "_reference" / "games"
    output_dir.mkdir(parents=True, exist_ok=True)
    collected  = date.today().isoformat()

    # tools directory (same location as this script)
    tools_dir = Path(__file__).parent

    if args.index_only:
        build_index(str(output_dir), str(vault_path), collected)
        return

    pdf_files = sorted(src_dir.glob("*.pdf"))
    if not pdf_files:
        print(f"Error: no PDF files — {src_dir}", file=sys.stderr)
        sys.exit(1)

    # Group by game (hub/spokes)
    game_groups: dict = {}
    for pdf in pdf_files:
        if pdf.name == "index_reference_games.md":
            continue
        game, section = parse_pdf_name(pdf.name)
        if game not in game_groups:
            game_groups[game] = {"hub": None, "spokes": []}
        if section is None:
            game_groups[game]["hub"] = pdf
        else:
            game_groups[game]["spokes"].append((pdf, section))

    print(f"[import_namu_wiki_ref] {len(pdf_files)} PDFs → {len(game_groups)} game groups")
    print(f"  Output location → {output_dir}")

    success = 0
    skipped = 0
    failed  = 0

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_active      = Path(tmp_dir) / "active"
        tmp_attachments = Path(tmp_dir) / "attachments"
        tmp_active.mkdir()
        tmp_attachments.mkdir()

        # Run pdf_to_md.py in batch (whole folder)
        print(f"  [1/2] Running pdf_to_md.py...")
        pdf_cmd = [
            sys.executable,
            str(tools_dir / "pdf_to_md.py"),
            str(src_dir),
            str(tmp_active),
            str(tmp_attachments),
        ]
        result = subprocess.run(pdf_cmd, capture_output=True, text=True)
        if args.verbose and result.stdout:
            print(result.stdout[:2000])
        if result.returncode != 0 and result.stderr:
            print(result.stderr[:500], file=sys.stderr)

        converted_mds = {f.stem: f for f in tmp_active.glob("*.md")}
        print(f"  [1/2] Conversion complete - {len(converted_mds)} MD files")

        print(f"  [2/2] Post-processing frontmatter + hub-spoke structuring...")

        for game_name, group in sorted(game_groups.items()):
            display_name = GAME_NAME_MAP.get(game_name, game_name)
            safe_display = re.sub(r'[<>:"/\\|?*]', "", display_name).strip()

            # Spoke stem list (for the hub table of contents)
            spoke_links = []
            for _, sec_name in group["spokes"]:
                safe_sec   = re.sub(r'[<>:"/\\|?*]', "", sec_name).strip()
                spoke_stem = f"[게임] {safe_display} — {safe_sec}"
                spoke_links.append((spoke_stem, sec_name))

            all_pdfs = []
            if group["hub"]:
                all_pdfs.append((group["hub"], None))
            all_pdfs.extend(group["spokes"])

            for pdf_file, section in all_pdfs:
                # Find the converted MD (stem matching)
                pdf_stem       = pdf_file.stem
                # Match using the stem with suffixes like " - 나무위키" removed
                clean_stem     = re.sub(r"\s*-\s*나무위키.*$", "", pdf_stem).strip()
                # pdf_to_md.py uses the filename as-is for the stem
                md_candidates  = [
                    converted_mds.get(pdf_stem),
                    converted_mds.get(clean_stem),
                ]
                md_file = next((c for c in md_candidates if c is not None), None)

                if md_file is None:
                    # Try partial matching
                    for k, v in converted_mds.items():
                        if clean_stem.lower() in k.lower() or k.lower() in clean_stem.lower():
                            md_file = v
                            break

                if section is None:
                    out_name = f"[게임] {safe_display}.md"
                else:
                    safe_sec = re.sub(r'[<>:"/\\|?*]', "", section).strip()
                    out_name = f"[게임] {safe_display} — {safe_sec}.md"

                out_path = output_dir / out_name

                if out_path.exists() and not args.force:
                    if args.verbose:
                        print(f"    ⏭  {out_name} — already exists")
                    skipped += 1
                    continue

                if md_file is None:
                    print(f"    ✗  {out_name} — no converted MD (PDF: {pdf_file.name})")
                    failed += 1
                    continue

                content = md_file.read_text(encoding="utf-8", errors="ignore")
                rewritten = rewrite_frontmatter(
                    content, game_name, section, display_name, collected,
                    spoke_links if section is None else None
                )
                out_path.write_text(rewritten, encoding="utf-8")
                if args.verbose:
                    print(f"    ✓  {out_name}")
                success += 1

            # Auto-generate an empty hub when there is no hub PDF
            if group["hub"] is None and spoke_links:
                hub_path = output_dir / f"[게임] {safe_display}.md"
                if not hub_path.exists() or args.force:
                    stub = rewrite_frontmatter(
                        "_허브 문서 (세부 문서 목록)_",
                        game_name, None, display_name, collected, spoke_links
                    )
                    hub_path.write_text(stub, encoding="utf-8")
                    if args.verbose:
                        print(f"    ✓  [hub auto-generated] [게임] {safe_display}.md")
                    success += 1

    print(f"\nDone: {success} saved, {skipped} skipped, {failed} failed")
    build_index(str(output_dir), str(vault_path), collected)


if __name__ == "__main__":
    main()
