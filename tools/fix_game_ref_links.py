"""
fix_game_ref_links.py — active/games/ 내 게임 레퍼런스 파일 링크 수정

1. 중첩 wikilink 수정: [[[게임] X — Y|...]] → [[게임] X — Y|...]]
2. 스포크 파일에 허브 백링크 주입: ## 관련 문서 섹션에 [[허브]] 추가
3. 허브 파일에 스포크 목차 누락 시 보완

사용법:
  python fix_game_ref_links.py <games_dir>
  python fix_game_ref_links.py C:/dev2/refined_vault/active/games
"""

import os
import re
import sys
from pathlib import Path

def fix_nested_wikilinks(text: str) -> str:
    """[[[X|Y]] → [[X|Y]], [[[X]]] → [[X]] 등 앞쪽 중복 [ 제거."""
    # 반복 적용 (중첩이 여러 겹일 수 있음)
    for _ in range(3):
        prev = text
        # [[[...]] → [[...]] (앞 [ 하나 제거)
        text = re.sub(r'\[\[(\[[^\[\]]+(?:\[[^\[\]]*\][^\[\]]*)*\|[^\[\]]+)\]\]', r'[[\1]]', text)
        # [[[stem|display]] → [[stem|display]]
        text = re.sub(r'\[\[\[([^\[\]]*\|[^\[\]]*)\]\]', r'[[\1]]', text)
        # [[[stem]]] → [[stem]]
        text = re.sub(r'\[\[\[([^\[\]]+)\]\]\]', r'[[\1]]', text)
        if text == prev:
            break
    return text


def get_hub_stem(spoke_filename: str) -> str:
    """스포크 파일명에서 허브 stem 추출. '[게임] LoL — 챔피언.md' → '[게임] LoL'"""
    stem = Path(spoke_filename).stem  # '[게임] LoL — 챔피언'
    return stem.split(' — ')[0].strip()


def ensure_backlink(content: str, hub_stem: str, hub_display: str) -> str:
    """스포크 파일에 허브 백링크가 없으면 ## 관련 문서 섹션에 추가."""
    backlink = f'[[{hub_stem}|{hub_display}]]'
    if hub_stem in content:
        return content  # 이미 있음

    # ## 관련 문서 섹션이 있으면 거기에 추가
    if '## 관련 문서' in content:
        return content.replace(
            '## 관련 문서',
            f'## 관련 문서\n- {backlink} (허브 문서)',
            1
        )

    # 없으면 ## 비교 분석 메모 앞에 삽입
    if '## 비교 분석 메모' in content:
        return content.replace(
            '## 비교 분석 메모',
            f'## 관련 문서\n\n- {backlink} (허브 문서)\n\n## 비교 분석 메모',
            1
        )

    # 그것도 없으면 파일 끝에 추가
    return content.rstrip() + f'\n\n## 관련 문서\n\n- {backlink} (허브 문서)\n'


def ensure_spoke_links_in_hub(content: str, hub_stem: str, spoke_stems: list) -> str:
    """허브 파일에 스포크 링크 목차가 없거나 누락된 스포크가 있으면 보완."""
    if not spoke_stems:
        return content

    missing = []
    for stem in spoke_stems:
        if stem not in content:
            missing.append(stem)

    if not missing:
        return content

    # ## 세부 문서 섹션이 있으면 거기에 추가
    if '## 세부 문서' in content:
        insert = '\n'.join(f'- [[{s}|{s.split(" — ")[-1]}]]' for s in missing)
        return content.replace(
            '## 세부 문서',
            f'## 세부 문서',
            1
        ).replace(
            '## 세부 문서\n',
            '## 세부 문서\n' + insert + '\n',
            1
        )

    # 없으면 오염 방지 마커 바로 다음에 삽입
    section = '\n## 세부 문서\n\n' + '\n'.join(f'- [[{s}|{s.split(" — ")[-1]}]]' for s in missing) + '\n\n'
    # 첫 번째 ## 헤딩 앞에
    m = re.search(r'\n## ', content)
    if m:
        return content[:m.start()] + section + content[m.start():]
    return content + section


def main():
    if len(sys.argv) < 2:
        print(f"사용법: python {sys.argv[0]} <games_dir>", file=sys.stderr)
        sys.exit(1)

    games_dir = Path(sys.argv[1])
    if not games_dir.is_dir():
        print(f"오류: 폴더 없음 — {games_dir}", file=sys.stderr)
        sys.exit(1)

    all_files = sorted(games_dir.glob('*.md'))
    hubs   = {f.stem: f for f in all_files if ' — ' not in f.stem}
    spokes = {f.stem: f for f in all_files if ' — ' in f.stem}

    # 허브별 스포크 목록
    hub_spokes: dict = {h: [] for h in hubs}
    for stem in spokes:
        hub_stem = stem.split(' — ')[0].strip()
        if hub_stem in hub_spokes:
            hub_spokes[hub_stem].append(stem)

    fixed_nested = 0
    fixed_backlink = 0
    fixed_hub = 0

    # ── 스포크 수정 ──────────────────────────────────────────────────────────
    for stem, path in spokes.items():
        content = path.read_text(encoding='utf-8')
        original = content

        # 1. 중첩 링크 수정
        content = fix_nested_wikilinks(content)

        # 2. 허브 백링크 주입
        hub_stem = stem.split(' — ')[0].strip()
        hub_display = hub_stem.replace('[게임] ', '')
        content = ensure_backlink(content, hub_stem, hub_display)

        if content != original:
            path.write_text(content, encoding='utf-8')
            if fix_nested_wikilinks(original) != original:
                fixed_nested += 1
            if hub_stem not in original:
                fixed_backlink += 1

    # ── 허브 수정 ────────────────────────────────────────────────────────────
    for stem, path in hubs.items():
        content = path.read_text(encoding='utf-8')
        original = content

        # 1. 중첩 링크 수정
        content = fix_nested_wikilinks(content)

        # 2. 스포크 링크 보완
        my_spokes = hub_spokes.get(stem, [])
        content = ensure_spoke_links_in_hub(content, stem, my_spokes)

        if content != original:
            path.write_text(content, encoding='utf-8')
            fixed_hub += 1

    total = len(all_files)
    print(f"[fix_game_ref_links] 완료 ({total}개 파일)")
    print(f"  중첩 링크 수정: {fixed_nested}개 파일")
    print(f"  백링크 주입:    {fixed_backlink}개 파일")
    print(f"  허브 보완:      {fixed_hub}개 파일")


if __name__ == '__main__':
    main()
