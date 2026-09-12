"""
import_namu_wiki_ref.py — 나무위키 PDF를 외부 게임 레퍼런스 MD로 변환

사용법:
  python import_namu_wiki_ref.py --src /path/to/.game_ref --vault /path/to/refined_vault
  python import_namu_wiki_ref.py --src /path/to/.game_ref --vault /path/to/refined_vault --force
  python import_namu_wiki_ref.py --src /path/to/.game_ref --vault /path/to/refined_vault --index-only

처리 흐름:
  1. pdf_to_md.py로 .game_ref/*.pdf → 임시 active/ 변환 (기존 정제 파이프라인 그대로 활용)
  2. 변환된 MD에 type: external-reference frontmatter + 오염 방지 마커 후처리
  3. 나무위키 잔류 노이즈 추가 제거 (URL, 광고, 페이지 경로)
  4. 허브-스포크 구조 재편: "{게임명}.md" → 허브, "{게임명}_{섹션}.md" → 스포크
  5. _reference/games/[게임] {name}.md 저장
  6. _reference/index_reference_games.md 인덱스 갱신

저장 위치: {vault}/_reference/games/[게임] {name}.md
의존성: pdf_to_md.py (tools/), pdfplumber, pymupdf
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

# Windows stdout UTF-8 강제
if sys.stdout.encoding and sys.stdout.encoding.lower() != 'utf-8':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
if sys.stderr.encoding and sys.stderr.encoding.lower() != 'utf-8':
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ── 게임명 정규화 ───────────────────────────────────────────────────────────────

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

# 나무위키 추가 노이즈 패턴 (pdf_to_md.py에서 못 잡는 것)
NAMU_NOISE_RE = [
    re.compile(r"https?://namu\.wiki\S*", re.IGNORECASE),
    re.compile(r"^\s*나무위키.*\d{4}년.*$", re.MULTILINE),
    re.compile(r"최근 수정 시각.*\d{4}", re.MULTILINE | re.IGNORECASE),
    re.compile(r"CC BY-NC-SA\s*\d+\.\d+", re.IGNORECASE),
    re.compile(r"이 저작물은.{0,80}이용 허락", re.DOTALL),
    re.compile(r"크리에이티브 커먼즈", re.IGNORECASE),
]

# 나무위키 번호 헤딩 변환 (1. 개요 → ## 개요)
NAMU_HEADING_RE = re.compile(r"^(\d+(?:\.\d+)*)\.\s+(.+)$", re.MULTILINE)


def parse_pdf_name(filename: str) -> tuple:
    """
    파일명 파싱 → (원시 게임명, 섹션명 or None)
    "리그 오브 레전드_챔피언 - 나무위키.pdf" → ("리그 오브 레전드", "챔피언")
    "더 파이널스 - 나무위키.pdf"              → ("더 파이널스", None)
    """
    stem = Path(filename).stem
    stem = re.sub(r"\s*-\s*나무위키.*$", "", stem).strip()
    # "(게임)" 등 괄호 보조 분류는 게임명에 유지 (GAME_NAME_MAP에서 처리)
    if "_" in stem:
        idx = stem.index("_")
        game    = stem[:idx].strip()
        section = stem[idx + 1:].strip()
    else:
        game    = stem
        section = None
    return game, section


def clean_namu_text(text: str) -> str:
    """나무위키 추가 노이즈 제거 + 번호 헤딩 변환."""
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
    """pdf_to_md.py 출력 frontmatter를 external-reference 형식으로 교체하고 오염 방지 마커 삽입."""
    # 기존 frontmatter 제거
    content = re.sub(r"^---\n.*?\n---\n", "", content, count=1, flags=re.DOTALL).strip()

    # 나무위키 노이즈 추가 제거
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

    # ── 오염 방지 마커 ─────────────────────────────────────────────────────────
    lines += [
        f"> ⚠️ **[외부 레퍼런스]** 이 문서는 **{display_name}** (외부 출시 게임)에 대한 데이터입니다.",
        "> 프로젝트 A 내부 의사결정 근거로 **직접 인용 금지**.",
        "> 비교 분석 컨텍스트로만 활용하세요.",
        f"> 출처: 나무위키 | 수집일: {collected}",
        "",
    ]

    # ── 제목 ───────────────────────────────────────────────────────────────────
    title = display_name if section is None else f"{display_name} — {section}"
    lines += [f"# {title}", ""]

    is_hub = section is None
    reason = SELECTION_REASONS.get(display_name, "")
    if reason and is_hub:
        lines += [f"> **선정 이유**: {reason}", ""]

    # ── 허브: 스포크 목차 ─────────────────────────────────────────────────────
    if is_hub and spoke_links:
        lines += ["## 세부 문서", ""]
        for stem, sec_name in spoke_links:
            lines.append(f"- [[{stem}|{display_name} — {sec_name}]]")
        lines += ["", "---", ""]

    # ── 본문 ───────────────────────────────────────────────────────────────────
    lines += [content, ""]

    # ── 비교 분석 메모 (허브에만) ──────────────────────────────────────────────
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
            continue  # 스포크 제외
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
    print(f"  📋 인덱스 갱신 → {index_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="나무위키 PDF → 외부 게임 레퍼런스 MD 변환")
    parser.add_argument("--src",        required=True,       help=".game_ref 폴더 경로")
    parser.add_argument("--vault",      required=True,       help="볼트 루트 경로 (refined_vault)")
    parser.add_argument("--force",      action="store_true", help="이미 존재하는 파일도 덮어씀")
    parser.add_argument("--index-only", action="store_true", help="변환 없이 인덱스만 재생성")
    parser.add_argument("--verbose",    action="store_true", help="상세 출력")
    args = parser.parse_args()

    src_dir    = Path(os.path.abspath(args.src))
    vault_path = Path(os.path.abspath(args.vault))
    output_dir = vault_path / "_reference" / "games"
    output_dir.mkdir(parents=True, exist_ok=True)
    collected  = date.today().isoformat()

    # tools 디렉터리 (이 스크립트와 같은 위치)
    tools_dir = Path(__file__).parent

    if args.index_only:
        build_index(str(output_dir), str(vault_path), collected)
        return

    pdf_files = sorted(src_dir.glob("*.pdf"))
    if not pdf_files:
        print(f"오류: PDF 파일 없음 — {src_dir}", file=sys.stderr)
        sys.exit(1)

    # 게임별 그룹핑 (허브/스포크)
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

    print(f"[import_namu_wiki_ref] {len(pdf_files)}개 PDF → {len(game_groups)}개 게임 그룹")
    print(f"  저장 위치 → {output_dir}")

    success = 0
    skipped = 0
    failed  = 0

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_active      = Path(tmp_dir) / "active"
        tmp_attachments = Path(tmp_dir) / "attachments"
        tmp_active.mkdir()
        tmp_attachments.mkdir()

        # pdf_to_md.py 일괄 실행 (전체 폴더)
        print(f"  [1/2] pdf_to_md.py 실행 중...")
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
        print(f"  [1/2] 변환 완료 - {len(converted_mds)}개 MD")

        print(f"  [2/2] frontmatter 후처리 + 허브-스포크 구조화...")

        for game_name, group in sorted(game_groups.items()):
            display_name = GAME_NAME_MAP.get(game_name, game_name)
            safe_display = re.sub(r'[<>:"/\\|?*]', "", display_name).strip()

            # 스포크 stem 목록 (허브 목차용)
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
                # 변환된 MD 찾기 (stem 매칭)
                pdf_stem       = pdf_file.stem
                # " - 나무위키" 등 suffix 제거한 stem으로 매칭
                clean_stem     = re.sub(r"\s*-\s*나무위키.*$", "", pdf_stem).strip()
                # pdf_to_md.py는 파일명 그대로 stem 사용
                md_candidates  = [
                    converted_mds.get(pdf_stem),
                    converted_mds.get(clean_stem),
                ]
                md_file = next((c for c in md_candidates if c is not None), None)

                if md_file is None:
                    # 부분 매칭 시도
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
                        print(f"    ⏭  {out_name} — 이미 존재")
                    skipped += 1
                    continue

                if md_file is None:
                    print(f"    ✗  {out_name} — 변환된 MD 없음 (PDF: {pdf_file.name})")
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

            # 허브 PDF 없는 경우 빈 허브 자동 생성
            if group["hub"] is None and spoke_links:
                hub_path = output_dir / f"[게임] {safe_display}.md"
                if not hub_path.exists() or args.force:
                    stub = rewrite_frontmatter(
                        "_허브 문서 (세부 문서 목록)_",
                        game_name, None, display_name, collected, spoke_links
                    )
                    hub_path.write_text(stub, encoding="utf-8")
                    if args.verbose:
                        print(f"    ✓  [허브 자동 생성] [게임] {safe_display}.md")
                    success += 1

    print(f"\n완료: {success}개 저장, {skipped}개 건너뜀, {failed}개 실패")
    build_index(str(output_dir), str(vault_path), collected)


if __name__ == "__main__":
    main()
