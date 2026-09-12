"""
KEYWORD_MAP auto-generation script (gen_keyword_map.py)  v1.0
────────────────────────────────────────────────────────
Function:
  Analyzes the wikilink stems in _index.md and automatically
  generates/updates the KEYWORD_MAP of inject_keywords.py.

Algorithm:
  1. Extract every [[stem]] link from _index.md
  2. Tokenize each stem to extract candidate keywords
  3. A keyword is valid if it appears in at least MIN_STEM_COUNT stems
  4. Pick a "representative hub stem" for each keyword
     (the stem whose last meaningful token is the keyword = most general hub)
  5. Count plain-text occurrences of the keyword across the vault
     → drop if below MIN_FREQ or above MAX_RATE (filters generic terms)
  6. Write the result into the KEYWORD_MAP block of inject_keywords.py

Usage:
    # Preview candidates (no file changes)
    python gen_keyword_map.py <vault_dir>

    # Apply to inject_keywords.py
    python gen_keyword_map.py <vault_dir> --apply

Options:
    --apply            Auto-update the KEYWORD_MAP in inject_keywords.py
    --min-stems N      Minimum number of stems the keyword must appear in (default 3)
    --min-freq N       Minimum number of files with plain-text occurrences across the vault (default 3)
    --max-rate F       Maximum occurrence ratio across the vault, 0~1 (default 0.15 = 15%)

Dependencies:
    None (standard library only)
"""

import os
import re
import sys

# ── Stopwords (these tokens are excluded from keyword candidates) ───────────
STOPWORDS: set[str] = {
    # ── Korean generic verbs/nouns ─────────────────────────────────────────────
    '캐릭터', '아트', '기획', '보고', '회의록', '회의', '작업', '정리',
    '리스트', '내용', '결과', '버전', '업데이트', '수정', '추가', '삭제',
    '가이드', '문서', '자료', '파일', '데이터', '정보', '참고',
    '1차', '2차', '3차', '최종', '초안', '검토', '완료', '진행',
    '모델링', '디자인', '원화', '애니메이션', '이펙트', '사운드',
    # ── Game development generic terms (Project A) ────────────────────────────
    '개요', '설정', '연출', '관련', '컨셉', '게임', '제작', '플레이',
    '레벨', '전투', '배경', '사항', '방향성', '방향', '레퍼런스',
    '전사', '개발', '세계관', '논의', '요소', '변경', '퀘스트',
    '크래프팅', '시나리오', '구현', '시스템', '오브젝트', '영역',
    '직업', '궁극기', '정례', '구성', '확인', '구분', '테스트',
    '제안', '기능', '아이디어', '신규', '지역', '구조', '처리',
    '위치', '빌드', '개선', '종족', '스케치', '모션', '영웅',
    '국가', 'NPC', '효과', '프로젝트', '관리', '항목', '신전',
    '표시', '레시피', '리소스', '퍼즐', '피격', '외형', '타워',
    '조작', '인원', '스폰', '분석', '이슈', '세팅', '인지', '매칭',
    '현황', '교체', '심화', '목록', '요청', '조사', '마법',
    '블록', '정례보고', '링크', '임시', '사망', '외주', '소개',
    '구역', '슬롯', '암석', '스크립트',
    '스킬', '약한', '상세', '규칙', '파괴', '내부',
    '프로토', '드랍', '플로우', '테이블', '입력', '폴리싱', '리서치',
    '마블', '원신', '3D', '2D',
    # ── English generic terms ──────────────────────────────────────────────────
    'the', 'and', 'for', 'of', 'to', 'in', 'a', 'an', 'is', 'at',
    'list', 'data', 'info', 'doc', 'file', 'ver', 'v1', 'v2', 'v3',
    'backup', 'copy', 'final', 'draft', 'review', 'update',
    'overview', 'guide', 'report', 'project', 'system',
}

WIKILINK_PAT = re.compile(r'\[\[([^\[\]]+?)\]\]')
NUM_ONLY     = re.compile(r'^\d+$')
SHORT_ID     = re.compile(r'^[A-Za-z0-9]{1,3}$')   # 2-3 char alphanumeric IDs (meaningful abbreviations are exceptions)


def resolve_active_dir(vault_dir: str) -> str:
    active = os.path.join(vault_dir, 'active')
    if os.path.isdir(active):
        return active
    return vault_dir


def tokenize_stem(stem: str) -> list[str]:
    """stem -> list of meaningful tokens (IDs, numbers and stopwords removed)"""
    # Delimiters: _, whitespace, (, ), [, ], ., -, /, \, |
    parts = re.split(r'[\s_\(\)\[\]\.\-/\\|,]+', stem)
    tokens = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if NUM_ONLY.match(p):       # Pure digits (Confluence IDs, etc.)
            continue
        if len(p) < 2:              # Single character
            continue
        if p.lower() in {s.lower() for s in STOPWORDS}:
            continue
        tokens.append(p)
    return tokens


def best_hub_for_keyword(keyword: str, stems: list[str]) -> str:
    """Pick the representative hub stem for a keyword.
    Priority:
      1) Stem whose last meaningful token is the keyword (most general hub)
      2) Fewer meaningful tokens first (simpler title = more general)
    """
    candidates = []
    for stem in stems:
        tokens = tokenize_stem(stem)
        if not tokens:
            continue
        is_last = tokens[-1] == keyword
        candidates.append((stem, is_last, len(tokens)))

    # is_last=True first, then fewer tokens
    candidates.sort(key=lambda x: (not x[1], x[2]))
    return candidates[0][0] if candidates else stems[0]


def count_plain_occurrences(keyword: str, md_files: list[str], active_dir: str,
                             exclude_stems: set[str]) -> int:
    """Number of files where the keyword appears as plain text (outside wikilinks)"""
    kw_pat = re.compile(r'(?<!\[\[)(?<!\|)\b' + re.escape(keyword) + r'\b(?!\|)(?!\]\])',
                         re.MULTILINE)
    count = 0
    for fname in md_files:
        stem = fname[:-3]
        if stem in exclude_stems:
            continue
        path = os.path.join(active_dir, fname)
        try:
            with open(path, encoding='utf-8') as f:
                text = f.read()
        except Exception:
            continue
        # Search plain text after masking wikilinks
        masked = WIKILINK_PAT.sub('', text)
        if kw_pat.search(masked):
            count += 1
    return count


def load_index_stems(active_dir: str) -> list[str]:
    """Extract the list of [[stem]] links from _index.md"""
    index_path = os.path.join(active_dir, '_index.md')
    if not os.path.exists(index_path):
        print('⚠ _index.md not found.', file=sys.stderr)
        return []
    with open(index_path, encoding='utf-8') as f:
        text = f.read()
    stems = [m.group(1).split('|')[0].strip() for m in WIKILINK_PAT.finditer(text)]
    return stems


def run(vault_dir: str, apply: bool = False,
        min_stems: int = 3, min_freq: int = 3, max_rate: float = 0.15) -> None:
    active_dir = resolve_active_dir(vault_dir)

    # 1. Collect the stem list from _index.md
    index_stems = load_index_stems(active_dir)
    if not index_stems:
        return
    print(f'_index.md links: {len(index_stems)} stems')

    # 2. Map keyword -> list of stems
    keyword_to_stems: dict[str, list[str]] = {}
    for stem in index_stems:
        for token in tokenize_stem(stem):
            keyword_to_stems.setdefault(token, []).append(stem)

    # 3. Keep only keywords with at least MIN_STEM_COUNT stems
    candidates = {kw: stems for kw, stems in keyword_to_stems.items()
                  if len(stems) >= min_stems}
    print(f'Keywords appearing in {min_stems}+ stems: {len(candidates)}')

    # 4. Vault file list
    md_files = sorted(f for f in os.listdir(active_dir) if f.endswith('.md'))
    total = len(md_files)
    hub_stems_set = set(index_stems)

    # 5. Plain-text frequency filtering + representative hub selection
    print(f'\nAnalyzing plain-text frequency ({len(candidates)} keywords x {total} files)...\n')

    results: list[tuple[str, str, int, float]] = []  # (keyword, hub_stem, freq, rate)
    for kw, stems in sorted(candidates.items(), key=lambda x: -len(x[1])):
        freq = count_plain_occurrences(kw, md_files, active_dir, hub_stems_set)
        rate = freq / total if total else 0
        if freq < min_freq:
            continue
        if rate > max_rate:
            continue
        hub = best_hub_for_keyword(kw, stems)
        results.append((kw, hub, freq, rate))

    results.sort(key=lambda x: -x[2])  # Highest frequency first

    # 6. Print results
    print(f"{'Keyword':<20} {'Files':>8}  {'Rate':>6}  Hub stem")
    print('-' * 80)
    for kw, hub, freq, rate in results:
        print(f'{kw:<20} {freq:>8}  {rate*100:>5.1f}%  {hub[:45]}')

    print(f'\n→ KEYWORD_MAP candidates: {len(results)}')

    if not apply:
        print('\n(use --apply to write them into inject_keywords.py automatically)')
        return

    # 7. Update the KEYWORD_MAP in inject_keywords.py
    script_dir = os.path.dirname(os.path.abspath(__file__))
    inject_path = os.path.join(script_dir, 'inject_keywords.py')
    if not os.path.exists(inject_path):
        print(f'⚠ {inject_path} not found.', file=sys.stderr)
        return

    with open(inject_path, encoding='utf-8') as f:
        src = f.read()

    # Preserve comments (manual entries) inside the existing KEYWORD_MAP block
    map_pat = re.compile(
        r'(KEYWORD_MAP: dict\[str, tuple\[str, str\]\] = \{)(.*?)(\})',
        re.DOTALL
    )
    m = map_pat.search(src)
    if not m:
        print('⚠ KEYWORD_MAP block not found in inject_keywords.py.', file=sys.stderr)
        return

    existing_block = m.group(2)
    # Preserve comment lines (manual entries)
    manual_lines = [ln for ln in existing_block.splitlines()
                    if ln.strip().startswith('#')]

    # Build auto-generated entries (grouping by category is simply alphabetical)
    auto_lines = []
    auto_lines.append('    # ── Auto-generated (gen_keyword_map.py) ────────────────────────────────')
    for kw, hub, freq, rate in results:
        # Escape quotes in the hub stem
        hub_escaped = hub.replace('\\', '\\\\').replace('"', '\\"')
        auto_lines.append(f'    "{kw}": ("{hub_escaped}", "{kw}"),  # {freq} files ({rate*100:.0f}%)')

    new_block = '\n'.join(manual_lines + [''] + auto_lines + [''])
    new_src = src[:m.start(2)] + '\n' + new_block + src[m.end(2):]

    with open(inject_path, 'w', encoding='utf-8') as f:
        f.write(new_src)

    print(f'\n✅ inject_keywords.py KEYWORD_MAP updated ({len(results)} entries)')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    apply    = '--apply'     in sys.argv
    min_stems = 3
    min_freq  = 3
    max_rate  = 0.15

    i = 1
    while i < len(sys.argv):
        arg = sys.argv[i]
        if arg == '--min-stems' and i + 1 < len(sys.argv):
            try: min_stems = int(sys.argv[i + 1])
            except ValueError: pass
            i += 2
        elif arg == '--min-freq' and i + 1 < len(sys.argv):
            try: min_freq = int(sys.argv[i + 1])
            except ValueError: pass
            i += 2
        elif arg == '--max-rate' and i + 1 < len(sys.argv):
            try: max_rate = float(sys.argv[i + 1])
            except ValueError: pass
            i += 2
        else:
            i += 1

    run(sys.argv[1], apply=apply, min_stems=min_stems,
        min_freq=min_freq, max_rate=max_rate)
