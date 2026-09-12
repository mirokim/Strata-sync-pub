# -*- coding: utf-8 -*-
"""
10_fix_links.py — fix vault wikilinks

1) Repair broken nested links:  [[PRE [[INNER|ANC]] SUF|OUT]]  →  [[<actual document found by ID>|OUT]]
2) Remove duplicate links within a document: only the first occurrence of a target stays a link, later ones become plain anchor text

- Image embeds ![[...]] are left untouched
- frontmatter is left untouched
Usage: python 10_fix_links.py [--apply]
"""
import re, sys, json
from pathlib import Path
from collections import Counter

VAULT = Path(r"C:\dev2\refined_vault")
DIRS = ["active", "active260323", ".archive", "jira", "_reference"]
APPLY = "--apply" in sys.argv

# ---------- Document index ----------
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

# ---------- Link span parsing ----------
def find_spans(text):
    """Return [[ ... ]] spans as (start, end, content, nested), accounting for nesting"""
    spans, i, n = [], 0, len(text)
    while i < n - 1:
        if text[i] == "[" and text[i + 1] == "[":
            if i > 0 and text[i - 1] == "!":       # exclude image embeds
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
    """Collapse nested links inside a span to their anchor text"""
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

# ---------- Main ----------
def main():
    by_id, names = build_index()
    print(f"Document index: {len(names):,} docs ({len(by_id):,} numeric IDs)")

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
                        out.append(anc)          # unresolvable → plain text
                        continue

                key = tgt
                if key in seen:                   # duplicate → plain text
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
    print(f"{'APPLIED' if APPLY else 'DRY-RUN (not applied)'}")
    print(f"  Links kept (graph edges)   : {stat['kept']:,}")
    print(f"  Duplicates → plain text    : {stat['dedup']:,}")
    print(f"  Nested found               : {stat['nested']:,}")
    print(f"    └ repaired by ID         : {stat['nested_fixed']:,}")
    print(f"    └ unresolvable → plain   : {stat['nested_plain']:,}")
    print(f"  Changed files              : {changed_files:,}")
    if unresolved:
        print("\n  Top unresolved targets:")
        for k, v in unresolved.most_common(8):
            print(f"    {v:4}  {k}")

if __name__ == "__main__":
    main()
