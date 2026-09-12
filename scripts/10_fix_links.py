# -*- coding: utf-8 -*-
"""
10_fix_links.py — vault 위키링크 수정

1) 중첩 깨진 링크 복구:  [[PRE [[INNER|ANC]] SUF|OUT]]  →  [[<ID로 찾은 실제 문서>|OUT]]
2) 문서 내 중복 링크 제거: 같은 대상은 첫 등장만 링크, 이후는 평문 앵커

- 이미지 임베드 ![[...]] 는 건드리지 않음
- frontmatter 는 건드리지 않음
사용: python 10_fix_links.py [--apply]
"""
import re, sys, json
from pathlib import Path
from collections import Counter

VAULT = Path(r"C:\dev2\refined_vault")
DIRS = ["active", "active260323", ".archive", "jira", "_reference"]
APPLY = "--apply" in sys.argv

# ---------- 문서 인덱스 ----------
def build_index():
    by_id, names = {}, set()
    for d in DIRS:
        p = VAULT / d
        if not p.exists():
            continue
        for f in p.rglob("*.md"):
            names.add(f.stem)
            m = re.match(r"^(\d{6,})_", f.stem)
            if m:
                by_id.setdefault(m.group(1), []).append(f.stem)
    return by_id, names

# ---------- 링크 스팬 파싱 ----------
def find_spans(text):
    """[[ ... ]] 스팬을 중첩 고려하여 (start, end, content, nested) 로 반환"""
    spans, i, n = [], 0, len(text)
    while i < n - 1:
        if text[i] == "[" and text[i + 1] == "[":
            if i > 0 and text[i - 1] == "!":       # 이미지 임베드 제외
                i += 2
                continue
            depth, j, nested = 1, i + 2, False
            while j < n - 1:
                if text[j] == "[" and text[j + 1] == "[":
                    depth += 1
                    nested = True
                    j += 2
                elif text[j] == "]" and text[j + 1] == "]":
                    depth -= 1
                    j += 2
                    if depth == 0:
                        break
                else:
                    j += 1
            if depth == 0:
                spans.append((i, j, text[i + 2:j - 2], nested))
                i = j
                continue
        i += 1
    return spans

INNER_P = re.compile(r"\[\[([^\[\]\|]+)\|([^\[\]]+)\]\]")
INNER_B = re.compile(r"\[\[([^\[\]]+)\]\]")

def flatten(content):
    """스팬 내부의 중첩 링크를 앵커 텍스트로 축약"""
    for _ in range(10):
        new = INNER_P.sub(lambda m: m.group(2), content)
        new = INNER_B.sub(lambda m: m.group(1), new)
        if new == content:
            break
        content = new
    return content

def split_link(content):
    if "|" in content:
        tgt, anc = content.rsplit("|", 1)
        return tgt.strip(), anc.strip()
    return content.strip(), content.strip()

# ---------- 메인 ----------
def main():
    by_id, names = build_index()
    print(f"문서 인덱스: {len(names):,}개 (숫자 ID {len(by_id):,}개)")

    stat = Counter()
    unresolved = Counter()
    changed_files = 0

    for d in DIRS:
        p = VAULT / d
        if not p.exists():
            continue
        for f in p.rglob("*.md"):
            text = f.read_text(encoding="utf-8", errors="ignore")
            spans = find_spans(text)
            if not spans:
                continue

            out, cursor, seen = [], 0, set()
            for s, e, content, nested in spans:
                out.append(text[cursor:s])
                cursor = e

                flat = flatten(content) if nested else content
                tgt, anc = split_link(flat)

                if nested:
                    stat["nested"] += 1
                    m = re.match(r"^(\d{6,})_", tgt)
                    if m and m.group(1) in by_id:
                        tgt = by_id[m.group(1)][0]
                        stat["nested_fixed"] += 1
                    elif tgt in names:
                        stat["nested_fixed"] += 1
                    else:
                        unresolved[tgt[:60]] += 1
                        stat["nested_plain"] += 1
                        out.append(anc)          # 해결 불가 → 평문
                        continue

                key = tgt
                if key in seen:                   # 중복 → 평문
                    stat["dedup"] += 1
                    out.append(anc)
                else:
                    seen.add(key)
                    stat["kept"] += 1
                    out.append(f"[[{tgt}|{anc}]]" if anc != tgt else f"[[{tgt}]]")

            out.append(text[cursor:])
            new = "".join(out)
            if new != text:
                changed_files += 1
                if APPLY:
                    f.write_text(new, encoding="utf-8")

    print()
    print(f"{'적용' if APPLY else '试 DRY-RUN (미적용)'}")
    print(f"  링크 유지(그래프 간선)   : {stat['kept']:,}")
    print(f"  중복 제거 → 평문         : {stat['dedup']:,}")
    print(f"  중첩 발견                : {stat['nested']:,}")
    print(f"    └ ID로 복구            : {stat['nested_fixed']:,}")
    print(f"    └ 해결 불가 → 평문     : {stat['nested_plain']:,}")
    print(f"  변경 파일                : {changed_files:,}")
    if unresolved:
        print("\n  해결 못한 대상 상위:")
        for k, v in unresolved.most_common(8):
            print(f"    {v:4}  {k}")

if __name__ == "__main__":
    main()
