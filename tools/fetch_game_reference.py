"""
fetch_game_reference.py — Fandom Wiki API로 외부 게임 데이터를 수집해 볼트에 저장

사용법:
  python fetch_game_reference.py --vault /path/to/vault/active
  python fetch_game_reference.py --vault /path/to/vault/active --games "The Finals,Deadlock"
  python fetch_game_reference.py --vault /path/to/vault/active --force
  python fetch_game_reference.py --vault /path/to/vault/active --index-only

데이터 소스:
  Fandom Wiki (MediaWiki API) — 게임플레이 메카닉, 영웅/캐릭터, 맵/모드, 패치노트 (키 불필요)

저장 위치:
  {vault}/_reference/games/[게임] {name}.md   — 게임별 상세 문서
  {vault}/_reference/index_reference_games.md  — 전체 인덱스 (wikilink 포함)

오염 방지: type: external-reference frontmatter + 상단 경고 마커 자동 삽입
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path
from typing import Optional

# ── 기본 수집 대상 ──────────────────────────────────────────────────────────────

GAME_CONFIGS = [
    {
        "name":   "The Finals",
        "wiki":   "thefinals",          # {wiki}.fandom.com
        "reason": "파괴 환경 + 집단 팀전, 샌드박스 PvP 구조 유사",
        "pages":  ["Gameplay", "Cashout", "Gadgets", "Maps", "Seasons"],
    },
    {
        "name":   "Heroes of the Storm",
        "wiki":   "heroesofthestorm",
        "reason": "팀 중심 MOBA 성공·실패 교훈 (개인 캐리 제거)",
        "pages":  ["Gameplay", "Heroes", "Battlegrounds", "Roles"],
    },
    {
        "name":   "Predecessor",
        "wiki":   "predecessor",
        "reason": "3인칭 MOBA 실패 사례 (Paragon 유산)",
        "pages":  ["Gameplay", "Heroes", "Map"],
    },
    {
        "name":   "Battlerite",
        "wiki":   "battlerite",
        "reason": "레인 없는 순수 팀 아레나 — 집단 PvP 핵심 구조",
        "pages":  ["Gameplay", "Champions", "Arena"],
    },
    {
        "name":   "Gigantic",
        "wiki":   "gigantic",
        "reason": "집단전 + 수호 구조 — 실패 원인 분석",
        "pages":  ["Gameplay", "Heroes", "Guardian"],
    },
    {
        "name":   "Deadlock",
        "wiki":   "deadlock-game",
        "reason": "밸브 MOBA 슈터 최신작",
        "pages":  ["Gameplay", "Heroes", "Mechanics", "Map"],
    },
    {
        "name":   "Naraka: Bladepoint",
        "wiki":   "naraka-bladepoint",
        "reason": "BR 레퍼런스 (볼트 내 언급됨)",
        "pages":  ["Gameplay", "Characters", "Weapons", "Game_Modes"],
    },
    {
        "name":   "Marvel Rivals",
        "wiki":   "marvelrivals",
        "reason": "히어로 슈터 비교 기준",
        "pages":  ["Gameplay", "Heroes", "Game_Modes", "Maps"],
    },
]


# ── Fandom MediaWiki API ────────────────────────────────────────────────────────

def fetch_json(url: str, timeout: int = 20) -> Optional[dict]:
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "SandboxMapBot/1.0 (game research; contact: research@example.com)"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"  [HTTP {e.code}] {url[:80]}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  [오류] {url[:80]}: {e}", file=sys.stderr)
        return None


def fandom_base(wiki: str) -> str:
    return f"https://{wiki}.fandom.com/api.php"


def fetch_fandom_page(wiki: str, page_title: str, verbose: bool = False) -> str:
    """Fandom Wiki에서 페이지 텍스트 수집 (plain text extract)."""
    base = fandom_base(wiki)
    params = urllib.parse.urlencode({
        "action":         "query",
        "titles":         page_title,
        "prop":           "extracts",
        "explaintext":    "true",
        "exsectionformat":"plain",
        "redirects":      "1",
        "format":         "json",
    })
    data = fetch_json(f"{base}?{params}")
    if not data:
        return ""

    pages = data.get("query", {}).get("pages", {})
    for page in pages.values():
        if page.get("pageid", -1) == -1:
            if verbose:
                print(f"    Fandom/{wiki}: '{page_title}' — 페이지 없음")
            return ""
        text = page.get("extract", "")
        if verbose:
            print(f"    Fandom/{wiki}: '{page_title}' — {len(text):,}자")
        return text
    return ""


def fetch_fandom_search(wiki: str, query: str, limit: int = 3, verbose: bool = False) -> list:
    """Fandom Wiki 검색으로 관련 페이지 제목 목록 반환."""
    base = fandom_base(wiki)
    params = urllib.parse.urlencode({
        "action":  "query",
        "list":    "search",
        "srsearch": query,
        "srlimit": limit,
        "format":  "json",
    })
    data = fetch_json(f"{base}?{params}")
    if not data:
        return []
    results = data.get("query", {}).get("search", [])
    titles = [r["title"] for r in results]
    if verbose and titles:
        print(f"    검색 '{query}': {titles}")
    return titles


def collect_game_pages(cfg: dict, verbose: bool = False) -> dict:
    """게임 설정에 따라 Fandom 페이지들을 수집해 섹션 dict 반환."""
    wiki    = cfg["wiki"]
    name    = cfg["name"]
    pages   = cfg["pages"]
    sections: dict = {}

    for page_title in pages:
        text = fetch_fandom_page(wiki, page_title, verbose=verbose)
        if not text:
            # 페이지 없으면 검색으로 대체 시도
            candidates = fetch_fandom_search(wiki, page_title, limit=2, verbose=verbose)
            for candidate in candidates:
                text = fetch_fandom_page(wiki, candidate, verbose=verbose)
                if text:
                    page_title = candidate
                    break
        if text:
            # 너무 긴 텍스트는 잘라냄 (섹션당 최대 2500자)
            sections[page_title] = text[:2500] + ("…(이하 생략)" if len(text) > 2500 else "")
        time.sleep(0.4)  # Fandom rate limit

    return sections


# ── 마크다운 생성 ──────────────────────────────────────────────────────────────

def clean_wiki_text(text: str) -> str:
    """MediaWiki plain text에서 불필요한 패턴 정리."""
    # 연속 빈 줄 3개 이상 → 2개로
    text = re.sub(r"\n{3,}", "\n\n", text)
    # 섹션 제목 앞 공백 정리
    text = re.sub(r"\n\s+\n", "\n\n", text)
    return text.strip()


def build_markdown(cfg: dict, sections: dict, collected: str) -> str:
    name   = cfg["name"]
    wiki   = cfg["wiki"]
    reason = cfg.get("reason", "")
    wiki_url = f"https://{wiki}.fandom.com"

    lines = []

    # ── Frontmatter ────────────────────────────────────────────────────────────
    lines += [
        "---",
        "type: external-reference",
        f"ref_game: \"{name}\"",
        f"ref_source: \"fandom\"",
        f"ref_wiki: \"{wiki}.fandom.com\"",
        f"ref_collected: {collected}",
        "internal: false",
        "tags: [external-reference, game-analysis]",
        "---",
        "",
    ]

    # ── 오염 방지 마커 ─────────────────────────────────────────────────────────
    lines += [
        f"> ⚠️ **[외부 레퍼런스]** 이 문서는 **{name}** (외부 출시 게임)에 대한 데이터입니다.",
        "> 프로젝트 A 내부 의사결정 근거로 **직접 인용 금지**.",
        "> 비교 분석 컨텍스트로만 활용하세요.",
        f"> 출처: Fandom Wiki ({wiki_url}) | 수집일: {collected}",
        "",
    ]

    # ── 본문 ───────────────────────────────────────────────────────────────────
    lines += [f"# {name}", ""]

    if reason:
        lines += [f"> **선정 이유**: {reason}", ""]

    lines += [
        f"**Fandom Wiki**: [{wiki_url}]({wiki_url})",
        "",
        "---",
        "",
    ]

    if not sections:
        lines += [
            "> ⚠️ Fandom Wiki 데이터를 수집하지 못했습니다.",
            f"> 직접 확인: [{wiki_url}]({wiki_url})",
            "",
        ]
    else:
        for page_title, text in sections.items():
            # 페이지 제목을 섹션 헤더로
            display = page_title.replace("_", " ")
            lines += [
                f"## {display}",
                "",
                clean_wiki_text(text),
                "",
            ]

    # ── 비교 분석 메모 ─────────────────────────────────────────────────────────
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


# ── 인덱스 파일 생성 ───────────────────────────────────────────────────────────

def build_index(output_dir: str, vault_path: str, collected: str) -> None:
    """_reference/games/ 내 모든 게임 파일을 스캔해 index_reference_games.md 생성."""
    games_dir  = Path(output_dir)
    game_files = sorted(games_dir.glob("[[]게임[]] *.md"))

    entries = []
    for f in game_files:
        content = f.read_text(encoding="utf-8", errors="ignore")

        ref_game  = re.search(r'^ref_game:\s*"?([^"\n]+)"?', content, re.MULTILINE)
        ref_wiki  = re.search(r'^ref_wiki:\s*"?([^"\n]+)"?', content, re.MULTILINE)
        ref_coll  = re.search(r'^ref_collected:\s*(\S+)', content, re.MULTILINE)

        game_name = ref_game.group(1).strip() if ref_game else f.stem
        wiki_url  = ref_wiki.group(1).strip()  if ref_wiki  else ""
        coll_date = ref_coll.group(1)          if ref_coll  else collected

        reason_m  = re.search(r'^\*\*선정 이유\*\*:\s*(.+)$', content, re.MULTILINE)
        reason    = reason_m.group(1).strip() if reason_m else ""

        # 수집된 섹션 목록 파악
        page_titles = re.findall(r'^## (.+)$', content, re.MULTILINE)
        page_titles = [p for p in page_titles if p not in ("비교 분석 메모",)]

        entries.append({
            "stem":     f.stem,
            "name":     game_name,
            "wiki_url": wiki_url,
            "date":     coll_date,
            "reason":   reason,
            "sections": page_titles,
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
        f"> 마지막 업데이트: {collected} | 수집 게임: {len(entries)}개",
        "> 샌드박스 MOBA/집단 PvP 비교 레퍼런스. 내부 프로젝트 문서가 아님.",
        "",
        "---",
        "",
        "## 게임 목록",
        "",
        "| 게임 | Fandom Wiki | 수집 섹션 | 선정 이유 |",
        "|------|------------|---------|---------|",
    ]

    for e in entries:
        wikilink   = f"[[{e['stem']}|{e['name']}]]"
        wiki_link  = f"[Wiki]({e['wiki_url']})" if e["wiki_url"] else "—"
        sections   = ", ".join(e["sections"]) if e["sections"] else "—"
        lines.append(f"| {wikilink} | {wiki_link} | {sections} | {e['reason']} |")

    lines += [
        "",
        "---",
        "",
        "## 개별 문서 링크",
        "",
    ]
    for e in entries:
        wiki_part = f" · [Fandom Wiki]({e['wiki_url']})" if e["wiki_url"] else ""
        lines.append(f"- [[{e['stem']}|{e['name']}]]{wiki_part}")

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


# ── 메인 ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Fandom Wiki 게임 데이터를 볼트 레퍼런스로 수집")
    parser.add_argument("--vault",      required=True,       help="볼트 active 폴더 경로")
    parser.add_argument("--games",      default="",          help="수집할 게임 이름 (콤마 구분). 미지정 시 기본 목록 사용")
    parser.add_argument("--force",      action="store_true", help="이미 존재하는 파일도 덮어씀")
    parser.add_argument("--index-only", action="store_true", help="게임 수집 없이 인덱스만 재생성")
    parser.add_argument("--verbose",    action="store_true", help="상세 출력")
    args = parser.parse_args()

    vault_path = os.path.abspath(args.vault)
    output_dir = os.path.join(vault_path, "_reference", "games")
    os.makedirs(output_dir, exist_ok=True)
    collected = date.today().isoformat()

    if args.index_only:
        build_index(output_dir, vault_path, collected)
        return

    # 수집 대상 결정
    if args.games.strip():
        filter_names = {g.strip().lower() for g in args.games.split(",")}
        targets = [c for c in GAME_CONFIGS if c["name"].lower() in filter_names]
        if not targets:
            print(f"오류: 일치하는 게임 없음 — {args.games}", file=sys.stderr)
            print(f"사용 가능: {', '.join(c['name'] for c in GAME_CONFIGS)}", file=sys.stderr)
            sys.exit(1)
    else:
        targets = GAME_CONFIGS

    print(f"[fetch_game_reference] {len(targets)}개 게임 수집 시작 (소스: Fandom Wiki)")
    print(f"  저장 위치 → {output_dir}")

    success = 0
    skipped = 0
    failed  = 0

    for cfg in targets:
        name      = cfg["name"]
        safe_name = re.sub(r'[<>:"/\\|?*]', "", name).strip()
        out_path  = os.path.join(output_dir, f"[게임] {safe_name}.md")

        if os.path.exists(out_path) and not args.force:
            print(f"  ⏭  {name} — 이미 존재 (--force로 덮어쓰기)")
            skipped += 1
            continue

        print(f"  ↓  {name} (wiki: {cfg['wiki']}.fandom.com)...")
        sections = collect_game_pages(cfg, verbose=args.verbose)

        if not sections:
            print(f"  ✗  {name} — 수집된 데이터 없음")
            failed += 1
            continue

        md = build_markdown(cfg, sections, collected)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(md)

        total_chars = sum(len(v) for v in sections.values())
        print(f"  ✓  {name} — {len(sections)}개 섹션, {total_chars:,}자")
        success += 1
        time.sleep(0.5)

    print(f"\n완료: {success}개 저장, {skipped}개 건너뜀, {failed}개 실패")

    # 인덱스 항상 재생성
    build_index(output_dir, vault_path, collected)


if __name__ == "__main__":
    main()
