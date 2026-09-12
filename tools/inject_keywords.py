"""
Automatic keyword link injection script (inject_keywords.py)  v3.0
────────────────────────────────────────────────────────
Function:
  Replaces the first mention of each core keyword in the body with a
  [[hub_stem|keyword]] wikilink automatically.

v3 changes:
  Added automatic _index.md analysis mode.
  On run, the wikilink stems in _index.md are analyzed to build the keyword map automatically.
  Entries registered manually in KEYWORD_MAP_MANUAL take precedence over automatic ones.
  No need to run gen_keyword_map.py separately.

Automatic keyword selection criteria:
  1. At least MIN_STEMS stems in _index.md contain the same keyword
  2. Appears as plain text in at least MIN_FREQ files across the vault
  3. Appears in no more than MAX_RATE of all vault files (excludes generic terms)

Usage:
    python inject_keywords.py <vault_dir>

Manual override:
    Entries added directly to the KEYWORD_MAP_MANUAL dict
    take precedence over auto-generated entries.

⚠️  wikilink contamination prevention:
  Existing [[ ... ]] ranges are masked in full before replacement,
  preventing the bug where a keyword inside a stem gets double-linked.

Dependencies:
    None (standard library only)
"""

import os
import re
import sys

# ── Manual override (takes precedence over auto-generated) ─────────────────
# "keyword": ("hub_file_stem", "display text")
KEYWORD_MAP_MANUAL: dict[str, tuple[str, str]] = {
    # "이사장":   ("chief persona(0.1.0)",              "이사장"),
    # "TLS":      ("TLS(TimeLineSkill)시스템_588781620", "TLS"),
}

# ── Auto mode parameters ────────────────────────────────────────────────────
AUTO_MIN_STEMS = 3      # Minimum number of stems the keyword must appear in
AUTO_MIN_FREQ  = 3      # Minimum number of files with plain-text occurrences in the vault
AUTO_MAX_RATE  = 0.15   # Maximum occurrence ratio across the vault (filters generic terms)

# ── Auto mode stopwords ─────────────────────────────────────────────────────
_STOPWORDS_RAW = {
    # Korean generic terms
    '캐릭터', '아트', '기획', '보고', '회의록', '회의', '작업', '정리',
    '리스트', '내용', '결과', '버전', '업데이트', '수정', '추가', '삭제',
    '가이드', '문서', '자료', '파일', '데이터', '정보', '참고',
    '1차', '2차', '3차', '최종', '초안', '검토', '완료', '진행',
    '모델링', '디자인', '원화', '애니메이션', '이펙트', '사운드',
    # Game development generic terms (Project A)
    '개요', '설정', '연출', '관련', '컨셉', '게임', '제작', '플레이',
    '레벨', '전투', '배경', '사항', '방향성', '방향', '레퍼런스',
    '전사', '개발', '세계관', '논의', '요소', '변경', '퀘스트',
    '크래프팅', '시나리오', '구현', '시스템', '오브젝트', '영역',
    '직업', '궁극기', '정례', '구성', '확인', '구분', '테스트',
    '제안', '기능', '아이디어', '신규', '지역', '구조', '처리',
    '위치', '빌드', '개선', '종족', '스케치', '모션', '영웅',
    '국가', 'npc', '효과', '프로젝트', '관리', '항목', '신전',
    '표시', '레시피', '리소스', '퍼즐', '피격', '외형', '타워',
    '조작', '인원', '스폰', '분석', '이슈', '세팅', '인지', '매칭',
    '현황', '교체', '심화', '목록', '요청', '조사', '마법',
    '블록', '정례보고', '링크', '임시', '사망', '외주', '소개',
    '구역', '슬롯', '암석', '스크립트', '스킬', '약한', '상세',
    '규칙', '파괴', '내부', '프로토', '드랍', '플로우', '테이블',
    '입력', '폴리싱', '리서치', '마블', '원신', '3d', '2d',
    # English generic terms
    'the', 'and', 'for', 'of', 'to', 'in', 'a', 'an', 'is', 'at',
    'list', 'data', 'info', 'doc', 'file', 'ver', 'v1', 'v2', 'v3',
    'backup', 'copy', 'final', 'draft', 'review', 'update',
    'overview', 'guide', 'report', 'project', 'system',
}
STOPWORDS = frozenset(s.lower() for s in _STOPWORDS_RAW)

# ── Regexes ─────────────────────────────────────────────────────────────────
_WIKILINK_PAT = re.compile(r'\[\[([^\[\]]+?)\]\]')
_LINK_PAT     = re.compile(r'\[\[.*?\]\]', re.DOTALL)
_NUM_ONLY     = re.compile(r'^\d+$')


# ════════════════════════════════════════════════════════════════════════════
#  Automatic keyword map build
# ════════════════════════════════════════════════════════════════════════════

def _tokenize_stem(stem: str) -> list[str]:
    """stem -> list of meaningful tokens (IDs, numbers and stopwords removed)"""
    parts = re.split(r'[\s_\(\)\[\]\.\-/\\|,]+', stem)
    tokens = []
    for p in parts:
        p = p.strip()
        if not p or len(p) < 2:
            continue
        if _NUM_ONLY.match(p):
            continue
        if p.lower() in STOPWORDS:
            continue
        tokens.append(p)
    return tokens


def _best_hub(keyword: str, stems: list[str]) -> str:
    """Pick the representative hub stem for a keyword.
    Stems whose last meaningful token is the keyword are preferred (most general hub);
    ties go to the stem with fewer tokens.
    """
    candidates = []
    for stem in stems:
        tokens = _tokenize_stem(stem)
        is_last = bool(tokens) and tokens[-1].lower() == keyword.lower()
        candidates.append((stem, is_last, len(tokens)))
    candidates.sort(key=lambda x: (not x[1], x[2]))
    return candidates[0][0] if candidates else stems[0]


def build_auto_keyword_map(
    active_dir: str,
    file_cache: dict[str, str],
) -> dict[str, tuple[str, str]]:
    """Analyze _index.md -> build the automatic keyword map."""
    index_path = os.path.join(active_dir, '_index.md')
    if not os.path.exists(index_path):
        return {}

    with open(index_path, encoding='utf-8') as f:
        index_text = f.read()

    # Collect [[stem]] entries from _index.md
    index_stems = [m.group(1).split('|')[0].strip()
                   for m in _WIKILINK_PAT.finditer(index_text)]
    if not index_stems:
        return {}

    index_stem_set = set(index_stems)

    # Map keyword -> list of stems
    kw_to_stems: dict[str, list[str]] = {}
    for stem in index_stems:
        for tok in _tokenize_stem(stem):
            kw_to_stems.setdefault(tok, []).append(stem)

    # MIN_STEMS filter
    candidates = {kw: stems for kw, stems in kw_to_stems.items()
                  if len(stems) >= AUTO_MIN_STEMS}

    total = len(file_cache)
    if total == 0:
        return {}

    # Measure plain-text frequency (reuses the file cache: O(keywords x files) but no file I/O)
    result: dict[str, tuple[str, str]] = {}
    for kw, stems in candidates.items():
        kw_pat = re.compile(r'(?<!\[)(?<!\|)\b' + re.escape(kw) + r'\b(?!\|)(?!\])',
                            re.MULTILINE)
        count = 0
        for fname, text in file_cache.items():
            if fname[:-3] in index_stem_set:
                continue
            masked = _WIKILINK_PAT.sub('', text)
            if kw_pat.search(masked):
                count += 1

        rate = count / total
        if count < AUTO_MIN_FREQ or rate > AUTO_MAX_RATE:
            continue

        hub = _best_hub(kw, stems)
        result[kw] = (hub, kw)

    return result


# ════════════════════════════════════════════════════════════════════════════
#  Link injection
# ════════════════════════════════════════════════════════════════════════════

def _mask_links(text: str) -> tuple[str, list[str]]:
    saved: list[str] = []
    def replacer(m: re.Match) -> str:
        idx = len(saved)
        saved.append(m.group(0))
        return f"\x00WLINK{idx}\x00"
    return _LINK_PAT.sub(replacer, text), saved


def _restore_links(masked: str, saved: list[str]) -> str:
    return re.sub(r'\x00WLINK(\d+)\x00',
                  lambda m: saved[int(m.group(1))], masked)


def _code_ranges(text: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in re.finditer(r'```[\s\S]*?```', text)]


def inject(text: str, keyword_map: dict[str, tuple[str, str]]) -> str:
    """Inject a link at the first occurrence of each keyword in the body after the frontmatter."""
    fm_end = 0
    if text.startswith('---'):
        end = text.find('\n---', 3)
        if end != -1:
            fm_end = end + 4
    frontmatter = text[:fm_end]
    body = text[fm_end:]

    masked, saved = _mask_links(body)
    code_blocks = _code_ranges(masked)

    for keyword, (hub_stem, display) in keyword_map.items():
        pat = re.compile(re.escape(keyword))
        offset = 0
        new_masked = masked

        for m in pat.finditer(masked):
            pos = m.start()
            if any(s <= pos < e for s, e in code_blocks):
                continue
            link_text = f'[[{hub_stem}|{display}]]'
            new_masked = (masked[:pos + offset]
                          + link_text
                          + masked[m.end() + offset:])
            offset += len(link_text) - len(keyword)
            masked = new_masked
            break  # Only the first occurrence per file

    return frontmatter + _restore_links(masked, saved)


# ════════════════════════════════════════════════════════════════════════════
#  Main
# ════════════════════════════════════════════════════════════════════════════

def resolve_active_dir(vault_dir: str) -> str:
    active = os.path.join(vault_dir, 'active')
    return active if os.path.isdir(active) else vault_dir


def run(vault_dir: str) -> None:
    active_dir = resolve_active_dir(vault_dir)
    md_files = sorted(f for f in os.listdir(active_dir) if f.endswith('.md'))

    # 1. Read every file once and cache it
    file_cache: dict[str, str] = {}
    for fname in md_files:
        try:
            with open(os.path.join(active_dir, fname), encoding='utf-8') as f:
                file_cache[fname] = f.read()
        except Exception:
            pass

    # 2. Build the automatic keyword map
    auto_map = build_auto_keyword_map(active_dir, file_cache)

    # 3. Merge manual overrides (manual takes precedence over auto)
    keyword_map = {**auto_map, **KEYWORD_MAP_MANUAL}

    print(f'Keyword map: {len(auto_map)} auto + {len(KEYWORD_MAP_MANUAL)} manual = {len(keyword_map)} total')

    # 4. Inject links
    updated = 0
    keyword_hit: dict[str, int] = {k: 0 for k in keyword_map}

    for fname, original in sorted(file_cache.items()):
        new_text = inject(original, keyword_map)
        if new_text == original:
            continue

        for kw, (hub_stem, display) in keyword_map.items():
            link = f'[[{hub_stem}|{display}]]'
            if original.count(link) < new_text.count(link):
                keyword_hit[kw] += 1

        with open(os.path.join(active_dir, fname), 'w', encoding='utf-8') as f:
            f.write(new_text)
        updated += 1

    print(f'Done: {updated} files updated')
    hit_items = [(kw, cnt) for kw, cnt in keyword_hit.items() if cnt > 0]
    if hit_items:
        print()
        print(f"{'Keyword':<25} {'Files':>8}")
        print('-' * 36)
        for kw, cnt in sorted(hit_items, key=lambda x: -x[1]):
            print(f'{kw:<25} {cnt:>8} files')


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    run(sys.argv[1])
