"""
Combined audit & fix script (audit_and_fix.py)  v1.0
────────────────────────────────────────────────────────
Function:
  Detects quality issues in every markdown file under the active/ folder
  and fixes most of them automatically. Merges check_quality.py + fix_all.py into one.

  ▶ --audit-only option: print the report only, no fixes
  ▶ --fix-only  option: run fixes only, no report

Detected / fixed items:
  ① Nested wikilink  [[stem|[[inner|text]]...]]  → replaced with the inner link
  ② Triple+ brackets [[[ (excluding date-style [YYYY...)  → reduced to [[
  ③ Broken wikilink (non-existent file)            → fixed via MANUAL_MAP or slash_map
  ④ Broken image link ![[image.ext]]              → removed
  ⑤ Missing frontmatter                          → auto-generated
  ⑥ Missing required frontmatter fields (date/type/status/tags)
  ⑦ Leftover HTML tags (<div>, <span>, etc.)      → removed
  ⑧ 3+ consecutive blank lines                   → reduced to 2 blank lines

Usage:
    python audit_and_fix.py <vault_active_dir> [--vault <vault_root>]
                             [--audit-only] [--fix-only] [--verbose]

    # Audit only (default)
    python audit_and_fix.py ./active/

    # Run fixes as well
    python audit_and_fix.py ./active/ --vault . --fix

    # Specify the vault root to check broken links against the full stem set
    python audit_and_fix.py ./active/ --vault .

Configuration:
  Register broken links that cannot be resolved automatically → real stem in the MANUAL_MAP dict below.

Dependencies:
    pip install PyYAML
"""

import os
import re
import sys
import yaml
import datetime
from collections import Counter, defaultdict

# ── Per-project manual configuration ────────────────────────────────────────
# Broken link whose stem cannot be found automatically → real file stem mapping
# e.g. "TLS": "TLS(TimeLineSkill)시스템_588781620"
MANUAL_MAP: dict[str, str] = {
    # "broken_stem": "real_stem",
    # ── Confluence ID suffix / date bracket format mismatch ────────────────
    # Date bracket format mismatch: "2026.01.07 ..." → "[2026.01.07] ..."
    '2026.01.07 프로젝트A 캐릭터팀 이사장님 피드백_652878547': '[2026.01.07] 프로젝트A 캐릭터팀 이사장님 피드백_652878547',
    # Special-character substitution in filenames: link with quotes → filename with underscores
    '"안 배우고 바로 제작하는 TLS 스킬 만들기"': '_안 배우고 바로 제작하는 TLS 스킬 만들기__596273256',
    # ID suffix mismatch (case not detected by short_to_stem)
    '정례보고 자료_2025': '정례보고 자료_2025_499298623',
    # Backslash-escaped pattern: [[정례보고 자료\_2025]] form inside markdown tables
    '정례보고 자료\\_2025': '정례보고 자료_2025_499298623',
}

# Date inference: parse the date from the filename (YYYY-MM-DD or [YYYY.MM.DD])
DATE_FROM_FNAME = re.compile(r'[\[\(]?(\d{4})[.\-](\d{2})[.\-](\d{2})[\]\)]?')

# ── Regexes ─────────────────────────────────────────────────────────────────
WIKILINK      = re.compile(r'\[\[(.*?)\]\]', re.DOTALL)
IMG_LINK      = re.compile(r'!\[\[([^\]]*\.(png|jpg|jpeg|gif|webp|svg|bmp))\]\]', re.I)
TRIPLE_PAT    = re.compile(r'\[{4,}')  # Check 4+ only (triple is a valid [[+[category]stem pattern)
NESTED_PAT    = re.compile(r'\[\[([^\[\]]*)\[\[([^\[\]]+?)(?:\|([^\[\]]+?))?\]\]([^\[\]]*)\]\]')
HTML_TAG      = re.compile(r'</?(?:div|span|p|br|hr|table|tr|td|th|ul|ol|li|'
                           r'strong|em|b|i|a|img|h[1-6])[^>]*>', re.I)
TRIPLE_BLANK  = re.compile(r'\n{4,}')
LINK_DISPLAY  = re.compile(r'!\[\[([^\]]*)\]\]')  # Every ![[]] including broken images

# ── Utilities ───────────────────────────────────────────────────────────────

def split_fm(text: str) -> tuple[dict, str, str]:
    """Returns (frontmatter_dict, frontmatter_raw, body)"""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            fm_raw = text[:end + 4]
            try:
                fm = yaml.safe_load(text[3:end]) or {}
            except Exception:
                fm = {}
            return fm, fm_raw, text[end + 4:]
    return {}, "", text


def build_stem_maps(search_root: str) -> tuple[set[str], dict[str, str], dict[str, str]]:
    """
    all_stems      : set of all vault stems
    slash_map      : "subpath/stem" → stem  (resolves links containing slashes)
    short_to_stem  : "stem_without_ID" → "full_stem_with_ID"  (resolves shortened links)
    """
    all_stems: set[str] = set()
    slash_map: dict[str, str] = {}
    short_to_stem: dict[str, str] = {}

    for root, dirs, files in os.walk(search_root):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for f in files:
            if f.endswith(".md"):
                stem = f[:-3]
                all_stems.add(stem)
                # For paths containing slashes
                rel = os.path.relpath(os.path.join(root, f), search_root)
                rel_stem = rel.replace("\\", "/")[:-3]
                slash_map[rel_stem] = stem
                # Strip the ID suffix (trailing _ + 6+ digits)
                short = re.sub(r'_\d{6,}$', '', stem)
                if short != stem:
                    short_to_stem[short] = stem

    return all_stems, slash_map, short_to_stem


def infer_fm(fname: str) -> dict:
    """Infer initial frontmatter values from the filename"""
    fm: dict = {}
    # Date
    m = DATE_FROM_FNAME.search(fname)
    if m:
        fm["date"] = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    else:
        fm["date"] = datetime.date.today().isoformat()
    # type
    stem = fname[:-3].lower()
    if any(w in stem for w in ["회의", "meeting", "피드백", "feedback"]):
        fm["type"] = "meeting"
    elif any(w in stem for w in ["spec", "기획", "설계", "design"]):
        fm["type"] = "spec"
    elif any(w in stem for w in ["index", "_index"]):
        fm["type"] = "index"
    else:
        fm["type"] = "reference"
    fm["status"] = "active"
    fm["tags"] = []
    return fm


# ── FIX functions ───────────────────────────────────────────────────────────

def fix_nested_wikilinks(text: str) -> tuple[str, int]:
    """Fix nested wikilink [[outer|[[inner|disp]]rest]] → [[inner]] or [[inner|disp]]"""
    count = 0
    def replacer(m: re.Match) -> str:
        nonlocal count
        # outer_left + [[inner|disp]] + outer_right
        inner_stem    = m.group(2)
        inner_display = m.group(3)
        replacement   = f"[[{inner_stem}|{inner_display}]]" if inner_display else f"[[{inner_stem}]]"
        count += 1
        return replacement

    new_text = NESTED_PAT.sub(replacer, text)
    # Reprocess remaining nested patterns (up to 3 passes)
    for _ in range(2):
        newer = NESTED_PAT.sub(replacer, new_text)
        if newer == new_text:
            break
        new_text = newer
    return new_text, count


def fix_triple_brackets(text: str) -> tuple[str, int]:
    """[[[ → [[ (excluding date-style)"""
    count = [0]
    def replacer(m: re.Match) -> str:
        count[0] += 1
        return "[["
    new_text = TRIPLE_PAT.sub(replacer, text)
    return new_text, count[0]


def fix_broken_wikilinks(body: str,
                         all_stems: set[str],
                         slash_map: dict[str, str],
                         short_to_stem: dict[str, str]) -> tuple[str, int]:
    """Fix broken wikilinks via MANUAL_MAP / slash_map / short_to_stem"""
    count = 0

    def replacer(m: re.Match) -> str:
        nonlocal count
        content = m.group(1)
        if "[[" in content:          # Nested → skip
            return m.group(0)
        pipe_idx = content.find("|")
        s    = (content[:pipe_idx] if pipe_idx != -1 else content).strip()
        disp = content[pipe_idx+1:].strip() if pipe_idx != -1 else None

        if not s or s in all_stems:
            return m.group(0)
        # Skip image extensions
        if re.search(r'\.(png|jpg|gif|webp|jpeg|svg|bmp)$', s, re.I):
            return m.group(0)

        # MANUAL_MAP
        if s in MANUAL_MAP:
            real = MANUAL_MAP[s]
            count += 1
            return f"[[{real}|{disp}]]" if disp else f"[[{real}]]"

        # slash_map (e.g. "active/filename" → "filename")
        for key, val in slash_map.items():
            if key.endswith("/" + s) or key == s:
                count += 1
                return f"[[{val}|{disp}]]" if disp else f"[[{val}]]"

        # short_to_stem (links without ID)
        if s in short_to_stem:
            real = short_to_stem[s]
            count += 1
            return f"[[{real}|{disp}]]" if disp else f"[[{real}]]"

        return m.group(0)  # Cannot fix

    return WIKILINK.sub(replacer, body), count


def fix_broken_images(text: str, all_stems: set[str], vault_root: str | None = None) -> tuple[str, int]:
    """Remove image links ![[...]] that point to non-existent files.
    When vault_root is given, only remove after checking whether the image file actually exists."""
    # Build the set of actual image filenames (every image in the vault)
    actual_images: set[str] = set()
    if vault_root and os.path.isdir(vault_root):
        for root, dirs, files in os.walk(vault_root):
            dirs[:] = [d for d in dirs if not d.startswith('.')]
            for f in files:
                if re.search(r'\.(png|jpg|jpeg|gif|webp|svg|bmp|tiff?)$', f, re.I):
                    actual_images.add(f.lower())

    count = [0]
    def replacer(m: re.Match) -> str:
        s = m.group(1).split("|")[0].strip()
        fname = os.path.basename(s)
        # Keep if the file actually exists in the vault
        if fname.lower() in actual_images:
            return m.group(0)
        count[0] += 1
        return ""
    new_text = IMG_LINK.sub(replacer, text)
    return new_text, count[0]


def fix_html_tags(text: str) -> tuple[str, int]:
    """Remove leftover HTML tags"""
    count = [0]
    def replacer(m: re.Match) -> str:
        count[0] += 1
        return ""
    return HTML_TAG.sub(replacer, text), count[0]


def fix_triple_blank(text: str) -> tuple[str, int]:
    """4+ consecutive blank lines → reduced to 2"""
    count = [0]
    def replacer(m: re.Match) -> str:
        count[0] += 1
        return "\n\n"
    return TRIPLE_BLANK.sub(replacer, text), count[0]


def fix_frontmatter(text: str, fname: str) -> tuple[str, bool]:
    """Auto-generate frontmatter if missing"""
    if text.startswith("---"):
        return text, False
    fm = infer_fm(fname)
    fm_lines = ["---"]
    for k, v in fm.items():
        if isinstance(v, list):
            fm_lines.append(f"{k}: {v}")
        else:
            fm_lines.append(f"{k}: {v}")
    fm_lines.append("---")
    fm_lines.append("")
    return "\n".join(fm_lines) + text, True


# ── AUDIT function ──────────────────────────────────────────────────────────

def audit(active_dir: str, all_stems: set[str], verbose: bool = False) -> dict:
    """Return the audit result as a dict"""
    md_files = sorted(f for f in os.listdir(active_dir) if f.endswith(".md"))
    total = len(md_files)

    issues: dict[str, list] = {
        "nested":        [],   # (stem, snippet)
        "triple":        [],   # (stem, count)
        "broken_link":   [],   # (stem, [link, ...])
        "broken_img":    [],   # stem
        "no_fm":         [],   # stem
        "fm_missing_f":  [],   # (stem, field)
        "html_tags":     [],   # (stem, count)
        "triple_blank":  [],   # stem
        "no_link":       [],   # stem
        "tiny":          [],   # stem
    }

    for fname in md_files:
        path = os.path.join(active_dir, fname)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        stem = fname[:-3]
        fm, _, body = split_fm(text)

        # ① Nested wikilink
        for m in NESTED_PAT.finditer(body):
            issues["nested"].append((stem, m.group()[:80]))

        # ② Triple brackets
        cnt = len(TRIPLE_PAT.findall(text))
        if cnt:
            issues["triple"].append((stem, cnt))

        # ③ Broken wikilink
        broken = []
        for m in WIKILINK.finditer(body):
            s = m.group(1).split("|")[0].strip()
            if "[[" in s:
                continue
            if s and s not in all_stems:
                if not re.search(r'\.(png|jpg|gif|webp|jpeg|svg|bmp)$', s, re.I):
                    broken.append(s)
        if broken:
            issues["broken_link"].append((stem, list(dict.fromkeys(broken))[:5]))

        # ④ Broken image
        if IMG_LINK.search(text):
            issues["broken_img"].append(stem)

        # ⑤ Missing frontmatter
        if not text.startswith("---"):
            issues["no_fm"].append(stem)
        else:
            # ⑥ Required fields
            for field in ("date", "type", "status", "tags"):
                if field not in fm:
                    issues["fm_missing_f"].append((stem, field))

        # ⑦ Leftover HTML
        cnt_html = len(HTML_TAG.findall(text))
        if cnt_html:
            issues["html_tags"].append((stem, cnt_html))

        # ⑧ Consecutive blank lines
        if TRIPLE_BLANK.search(text):
            issues["triple_blank"].append(stem)

        # ⑨ Files with no links
        if not WIKILINK.search(body):
            issues["no_link"].append(stem)

        # ⑩ Tiny files
        if len(body) < 300:
            issues["tiny"].append(stem)

    return {"total": total, "issues": issues}


def print_report(result: dict, verbose: bool = False) -> None:
    total = result["total"]
    issues = result["issues"]

    def pct(n: int) -> str:
        return f"{n}/{total} ({n/total*100:.1f}%)" if total else "0/0"

    def show(label: str, items: list, key_fmt=None, warn_if_any: bool = True) -> None:
        status = "WARN" if (items and warn_if_any) else ("INFO" if items else "PASS")
        print(f"[{status}] {label}: {pct(len(items))}")
        if verbose:
            for item in items[:10]:
                if key_fmt:
                    print(f"       - {key_fmt(item)}")
                else:
                    print(f"       - {item}")
            if len(items) > 10:
                print(f"       ... and {len(items)-10} more")
        else:
            for item in items[:3]:
                if key_fmt:
                    print(f"       - {key_fmt(item)}")
                else:
                    print(f"       - {item}")
            if len(items) > 3:
                print(f"       ... and {len(items)-3} more")
        print()

    print(f"\n{'='*60}")
    print(f" Audit report  (target: {total} files)")
    print(f"{'='*60}\n")

    show("① Nested wikilink (inject bug artifact)",
         issues["nested"], key_fmt=lambda x: f"{x[0][:40]}: {x[1]}")
    show("② Triple+ brackets (non-date)",
         issues["triple"], key_fmt=lambda x: f"{x[0][:55]}: {x[1]}")
    show("③ Non-existent wikilink",
         issues["broken_link"],
         key_fmt=lambda x: f"{x[0][:40]}: {', '.join(x[1])}")
    show("④ Broken image link (![[]])",
         issues["broken_img"], warn_if_any=True)
    show("⑤ Frontmatter entirely missing",
         issues["no_fm"])
    show("⑥ Missing required frontmatter field",
         issues["fm_missing_f"],
         key_fmt=lambda x: f"{x[0][:50]}  ← '{x[1]}' missing")
    show("⑦ Leftover HTML tags",
         issues["html_tags"],
         key_fmt=lambda x: f"{x[0][:55]}: {x[1]}", warn_if_any=True)
    show("⑧ Excessive consecutive blank lines (4+)",
         issues["triple_blank"], warn_if_any=False)
    show("⑨ Files with no links",
         issues["no_link"])
    show("⑩ Tiny files under 300 chars",
         issues["tiny"], warn_if_any=False)

    total_fix = sum(len(issues[k]) for k in
                    ["nested","triple","broken_link","broken_img","no_fm","html_tags","triple_blank"])
    print(f"{'='*60}")
    print(f" Auto-fixable issues: {total_fix}")
    print(f" (run with --fix to fix most of them automatically)")
    print(f"{'='*60}\n")


# ── Main ────────────────────────────────────────────────────────────────────

def run(active_dir: str,
        vault_root: str | None = None,
        do_fix: bool = False,
        audit_only: bool = False,
        verbose: bool = False) -> None:

    search_root = vault_root or active_dir
    all_stems, slash_map, short_to_stem = build_stem_maps(search_root)

    # Audit
    result = audit(active_dir, all_stems, verbose=verbose)

    if not audit_only:
        print_report(result, verbose=verbose)

    if not do_fix:
        return

    # Run fixes
    md_files = sorted(f for f in os.listdir(active_dir) if f.endswith(".md"))
    fix_counts: dict[str, int] = Counter()
    updated_files = 0

    for fname in md_files:
        path = os.path.join(active_dir, fname)
        with open(path, encoding="utf-8") as f:
            original = f.read()

        text = original
        fm, fm_raw, body = split_fm(text)

        # FIX-1: Nested wikilink
        new_body, n = fix_nested_wikilinks(body)
        fix_counts["nested"] += n

        # FIX-2: Triple brackets
        new_body, n = fix_triple_brackets(new_body)
        fix_counts["triple"] += n

        # FIX-3: Broken wikilink
        new_body, n = fix_broken_wikilinks(new_body, all_stems, slash_map, short_to_stem)
        fix_counts["broken_link"] += n

        # FIX-4: Broken images
        new_body, n = fix_broken_images(new_body, all_stems, vault_root=search_root)
        fix_counts["broken_img"] += n

        # FIX-5: HTML tags
        new_body, n = fix_html_tags(new_body)
        fix_counts["html_tags"] += n

        # FIX-6: Consecutive blank lines
        new_body, n = fix_triple_blank(new_body)
        fix_counts["triple_blank"] += n

        text = fm_raw + new_body

        # FIX-7: Frontmatter generation
        text, created = fix_frontmatter(text, fname)
        if created:
            fix_counts["no_fm"] += 1

        if text != original:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            updated_files += 1
            if verbose:
                print(f"  [FIX] {fname[:60]}")

    print(f"\n{'='*60}")
    print(f" Fix results")
    print(f"{'='*60}")
    print(f" Updated files: {updated_files}")
    for key, cnt in sorted(fix_counts.items(), key=lambda x: -x[1]):
        label_map = {
            "nested":       "Nested wikilinks fixed",
            "triple":       "Triple brackets fixed",
            "broken_link":  "Broken links fixed",
            "broken_img":   "Broken images removed",
            "html_tags":    "HTML tags removed",
            "triple_blank": "Consecutive blank lines reduced",
            "no_fm":        "Frontmatter generated",
        }
        if cnt:
            print(f"  - {label_map.get(key, key)}: {cnt}")
    print(f"{'='*60}\n")

    # Re-audit after fixes
    print("[Re-audit] Remaining issues after fixes:")
    result2 = audit(active_dir, all_stems, verbose=verbose)
    print_report(result2, verbose=verbose)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(
        description="Obsidian vault audit and auto-fix tool"
    )
    parser.add_argument("active_dir", help="active/ folder path")
    parser.add_argument("--vault", default=None,
                        help="vault root path (collects all stems for broken link checks)")
    parser.add_argument("--fix", action="store_true",
                        help="Run automatic fixes for issues")
    parser.add_argument("--audit-only", action="store_true",
                        help="Print the report only (no fixes)")
    parser.add_argument("--verbose", action="store_true",
                        help="Verbose output (up to 10 issues per file)")
    args = parser.parse_args()

    run(
        active_dir  = args.active_dir,
        vault_root  = args.vault,
        do_fix      = args.fix,
        audit_only  = args.audit_only,
        verbose     = args.verbose,
    )
