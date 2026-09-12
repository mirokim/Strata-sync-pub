#!/usr/bin/env python3
"""
Seed a Strata Sync vault with real, freely licensed, naturally cross-referenced documents.

Presets
  decisions     Python PEPs (public domain) + Rust RFCs (MIT/Apache-2.0): decision records with
                status, authors, dates and dense references — the "team decision log" persona.
                Superseded / rejected records give the linter something real to flag.
  encyclopedia  A Korean Wikipedia subset (CC BY-SA 4.0): articles within two hops of a few seed
                topics, links kept as wikilinks, attribution in the frontmatter.

Usage
  python scripts/seed_vault.py decisions    --out ./seed                      # write to a folder
  python scripts/seed_vault.py decisions    --server https://<worker> --token <team token>
  python scripts/seed_vault.py encyclopedia --server ... --token ... --max 2000 \
         --seeds "인공지능,대한민국의 경제,양자역학,제2차 세계 대전,한글,축구"
  python scripts/seed_vault.py wipe --server ... --token ... [--prefix worlds/ --prefix analysis/]

Only the standard library and git are needed. Uploads go through the sync API (PUT /v1/file),
recorded with author "seed"; re-running is idempotent (unchanged files answer 204).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

UA = "StrataSyncSeed/0.1 (+https://github.com/mirokim/Strata-sync)"
SEED_PREFIXES = ["worlds/", "analysis/", "decisions/", "wiki/"]

# ── Small helpers ─────────────────────────────────────────────────────────────

def yaml_str(s: str) -> str:
    return json.dumps(s, ensure_ascii=False)

def yaml_list(items: list[str]) -> str:
    return "[" + ", ".join(yaml_str(i) for i in items) + "]"

def frontmatter(fields: dict) -> str:
    lines = ["---"]
    for k, v in fields.items():
        if v is None or v == "" or v == []:
            continue
        if isinstance(v, list):
            lines.append(f"{k}: {yaml_list([str(x) for x in v])}")
        elif isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        else:
            lines.append(f"{k}: {yaml_str(str(v))}")
    lines.append("---")
    return "\n".join(lines)

def safe_name(name: str) -> str:
    """File name inside the vault: no path separators or characters Windows refuses."""
    name = re.sub(r'[\\/:*?"<>|]', "-", name).strip().rstrip(".")
    return re.sub(r"\s+", " ", name)[:120]

def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)

def clone(repo: str, dest: Path) -> Path:
    if not dest.exists():
        log(f"cloning {repo} → {dest}")
        subprocess.run(["git", "clone", "--depth", "1", "--quiet", repo, str(dest)], check=True)
    return dest

# ── Output (folder and/or server) ─────────────────────────────────────────────

class Sink:
    def __init__(self, out: str | None, server: str | None, token: str | None, author: str):
        self.out = Path(out) if out else None
        self.server = server.rstrip("/") if server else None
        self.token = token
        self.author = author
        self.written = self.unchanged = self.failed = 0
        if self.server and not self.token:
            sys.exit("--server needs --token (or STRATA_TEAM_TOKEN)")

    def _request(self, method: str, path: str, body: bytes | None = None, extra: dict | None = None):
        headers = {"Authorization": f"Bearer {self.token}", "X-Author": urllib.parse.quote(self.author, safe=""), "User-Agent": UA}
        headers.update(extra or {})
        req = urllib.request.Request(f"{self.server}{path}", data=body, headers=headers, method=method)
        return urllib.request.urlopen(req, timeout=60)

    def put(self, rel: str, content: str) -> None:
        if self.out:
            file = self.out / rel
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content, encoding="utf-8", newline="\n")
        if self.server:
            body = content.encode("utf-8")
            for attempt in range(3):
                try:
                    with self._request("PUT", f"/v1/file?path={urllib.parse.quote(rel, safe='')}", body,
                                       {"Content-Type": "application/octet-stream", "X-Mtime": str(int(time.time() * 1000))}) as r:
                        if r.status == 204:
                            self.unchanged += 1
                        else:
                            self.written += 1
                    return
                except urllib.error.HTTPError as e:
                    detail = e.read().decode("utf-8", "replace")[:200]
                    if e.code >= 500 and attempt < 2:
                        time.sleep(1 + attempt)
                        continue
                    self.failed += 1
                    log(f"  {e.code} {rel}: {detail}")
                    return
                except (urllib.error.URLError, TimeoutError):
                    if attempt < 2:
                        time.sleep(1 + attempt)
                        continue
                    self.failed += 1
                    log(f"  unreachable {rel}")
                    return

    def put_many(self, docs: list[tuple[str, str]], workers: int = 6) -> None:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            list(ex.map(lambda d: self.put(*d), docs))
        where = " + ".join(x for x in [str(self.out) if self.out else "", self.server or ""] if x)
        log(f"{len(docs)} documents → {where}: {self.written} written, {self.unchanged} unchanged, {self.failed} failed")

    def wipe(self, prefixes: list[str]) -> int:
        """Tombstone every live server file under the given prefixes."""
        removed = 0
        since = 0
        while True:
            with self._request("GET", f"/v1/manifest?since={since}") as r:
                page = json.load(r)
            for row in page["files"]:
                if row["deleted"] or not any(row["path"].startswith(p) for p in prefixes):
                    continue
                try:
                    with self._request("DELETE", f"/v1/file?path={urllib.parse.quote(row['path'], safe='')}") as d:
                        if d.status in (200, 204):
                            removed += 1
                except urllib.error.HTTPError as e:
                    if e.code != 404:
                        log(f"  delete {e.code} {row['path']}")
            if page.get("next") is None:
                break
            since = page["next"]
        log(f"wiped {removed} files under {', '.join(prefixes)}")
        return removed

# ── Preset: decisions (PEPs + Rust RFCs) ──────────────────────────────────────

PEP_HEADER_KEYS = {"PEP", "Title", "Author", "Status", "Type", "Topic", "Created", "Python-Version",
                   "Replaces", "Superseded-By", "Requires", "Sponsor", "PEP-Delegate", "BDFL-Delegate", "Resolution"}

def rst_to_md(text: str) -> str:
    """Enough RST → Markdown for PEP bodies to read well: headings, literals, PEP references."""
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    in_code = False
    code_indent = 0
    while i < len(lines):
        line = lines[i]
        # end of an indented literal block
        if in_code:
            if line.strip() == "" or (len(line) - len(line.lstrip(" ")) >= code_indent):
                out.append(line[code_indent:] if line.strip() else "")
                i += 1
                continue
            out.append("@@FENCE@@")
            in_code = False
        # section titles: text line followed by a line of the same length made of = - ~ ^ etc.
        if i + 1 < len(lines) and lines[i + 1] and re.fullmatch(r"[=\-~^\"'`*+#]{3,}", lines[i + 1]) and line.strip() and len(lines[i + 1]) >= len(line.rstrip()) - 1:
            ch = lines[i + 1][0]
            level = {"=": "##", "-": "###"}.get(ch, "####")
            if i > 0 and lines[i - 1] and re.fullmatch(r"[=\-~^\"'`*+#]{3,}", lines[i - 1]):
                level = "#"  # over-and-underlined = document title
            out.append(f"{level} {line.strip()}")
            i += 2
            continue
        if re.fullmatch(r"[=\-~^\"'`*+#]{3,}", line) and out and out[-1].startswith("#"):
            i += 1
            continue
        # directives
        m = re.match(r"^\s*\.\. code-block::\s*(\w+)?", line) or re.match(r"^\s*\.\. code::\s*(\w+)?", line)
        if m:
            out.append(f"@@FENCE@@{m.group(1) or ''}")
            i += 1
            while i < len(lines) and lines[i].strip() == "":
                i += 1
            code_indent = len(lines[i]) - len(lines[i].lstrip(" ")) if i < len(lines) else 0
            in_code = True
            continue
        if re.match(r"^\s*\.\. (note|warning|important|tip)::", line):
            kind = re.match(r"^\s*\.\. (\w+)::", line).group(1)
            out.append(f"> **{kind.capitalize()}**")
            i += 1
            while i < len(lines) and (lines[i].strip() == "" or lines[i].startswith(" ")):
                if lines[i].strip():
                    out.append("> " + lines[i].strip())
                i += 1
            continue
        if re.match(r"^\s*\.\. (_[^:]+:|\[|contents::|highlight::|canonical|image::|figure::|toctree::|sectnum|header::)", line) or line.startswith(".. "):
            i += 1
            continue
        # literal block introduced by "::"
        if line.rstrip().endswith("::"):
            head = line.rstrip()[:-2].rstrip()
            if head:
                out.append(head + ":")
            out.append("@@FENCE@@")
            i += 1
            while i < len(lines) and lines[i].strip() == "":
                i += 1
            code_indent = len(lines[i]) - len(lines[i].lstrip(" ")) if i < len(lines) else 0
            in_code = True
            continue
        out.append(line)
        i += 1
    if in_code:
        out.append("```")
    md = "\n".join(out)
    # inline markup
    md = re.sub(r":pep:`(\d+)(?:#[^`]*)?`", lambda m: f"[[PEP {int(m.group(1))}]]", md)
    md = re.sub(r":rfc:`(\d+)`", r"RFC \1", md)
    md = re.sub(r":(?:class|func|mod|meth|attr|data|exc|term|ref|doc|const|obj|py:\w+):`([^`]+)`", r"`\1`", md)
    md = re.sub(r"``([^`]+)``", r"`\1`", md)
    md = re.sub(r"`([^`<]+?)\s*<([^>`]+)>`_+", r"[\1](\2)", md)
    md = re.sub(r"`([^`]+)`_", r"\1", md)
    md = re.sub(r"(?<![\w\[])PEP[  ](\d{1,4})(?!\d)", lambda m: f"[[PEP {int(m.group(1))}]]", md)
    md = re.sub(r"\[\[\[\[PEP (\d+)\]\]\]\]", r"[[PEP \1]]", md)
    md = md.replace("@@FENCE@@", "```")
    return md.strip() + "\n"

def import_peps(cache: Path) -> list[tuple[str, str]]:
    repo = clone("https://github.com/python/peps.git", cache / "peps")
    docs = []
    for file in sorted((repo / "peps").glob("pep-*.rst")):
        text = file.read_text(encoding="utf-8", errors="replace")
        head, _, body = text.partition("\n\n")
        meta: dict[str, str] = {}
        last = None
        for line in head.split("\n"):
            m = re.match(r"^([A-Za-z-]+):\s*(.*)$", line)
            if m and m.group(1) in PEP_HEADER_KEYS:
                meta[m.group(1)] = m.group(2).strip()
                last = m.group(1)
            elif last and line.startswith(" "):
                meta[last] += " " + line.strip()
        if "PEP" not in meta or "Title" not in meta:
            continue
        num = int(meta["PEP"])
        if num == 0:
            continue
        name = f"PEP {num}"
        title = meta["Title"]
        related = []
        for key in ("Replaces", "Superseded-By", "Requires"):
            for n in re.findall(r"\d+", meta.get(key, "")):
                related.append(f"[[PEP {int(n)}]]")
        fm = frontmatter({
            "title": f"{name} — {title}",
            "type": "decision",
            "status": meta.get("Status"),
            "kind": meta.get("Type"),
            "topic": meta.get("Topic"),
            "authors": [a.strip() for a in re.sub(r"<[^>]+>", "", meta.get("Author", "")).split(",") if a.strip()][:6],
            "date": meta.get("Created"),
            "python_version": meta.get("Python-Version"),
            "replaces": [f"PEP {int(n)}" for n in re.findall(r"\d+", meta.get("Replaces", ""))],
            "superseded_by": [f"PEP {int(n)}" for n in re.findall(r"\d+", meta.get("Superseded-By", ""))],
            "requires": [f"PEP {int(n)}" for n in re.findall(r"\d+", meta.get("Requires", ""))],
            "source": f"https://peps.python.org/pep-{num:04d}/",
            "license": "Public domain (PEP 1)",
            "tags": ["decision", "pep", (meta.get("Status") or "").lower(), (meta.get("Topic") or "").lower()],
        })
        lineage = ""
        if related:
            lineage = "\n\n## Lineage\n\n" + "\n".join(
                f"- {k}: {' '.join(f'[[PEP {int(n)}]]' for n in re.findall(chr(92) + 'd+', meta[k]))}"
                for k in ("Replaces", "Superseded-By", "Requires") if meta.get(k)
            )
        body_md = rst_to_md(body)
        content = f"{fm}\n\n# {name} — {title}\n\n**Status:** {meta.get('Status', '?')} · **Type:** {meta.get('Type', '?')} · **Created:** {meta.get('Created', '?')}{lineage}\n\n{body_md}"
        docs.append((f"decisions/Python PEPs/{safe_name(name)}.md", content))
    log(f"PEPs: {len(docs)} documents")
    return docs

def import_rust_rfcs(cache: Path) -> list[tuple[str, str]]:
    repo = clone("https://github.com/rust-lang/rfcs.git", cache / "rfcs")
    docs = []
    slug_to_num: dict[str, int] = {}
    files = sorted((repo / "text").glob("*.md"))
    for file in files:
        m = re.match(r"^(\d{4})-(.+)\.md$", file.name)
        if m:
            slug_to_num[m.group(2)] = int(m.group(1))
    for file in files:
        m = re.match(r"^(\d{4})-(.+)\.md$", file.name)
        if not m:
            continue
        num, slug = int(m.group(1)), m.group(2)
        text = file.read_text(encoding="utf-8", errors="replace")
        meta = dict(re.findall(r"^- ([A-Za-z ]+): (.+)$", text, flags=re.M))
        feature = meta.get("Feature Name", "").strip("`") or slug.replace("-", "_")
        start = meta.get("Start Date", "").strip()
        title = feature.replace("_", " ")
        name = f"RFC {num}"
        body = re.sub(r"^(- [A-Za-z ]+: .+\n)+", "", text, count=1).strip()
        # cross references → wikilinks
        body = re.sub(r"\]\(\.?/?(?:text/)?(\d{4})-[a-z0-9_\-]+\.md\)", lambda mm: f"]([[RFC {int(mm.group(1))}]])", body)
        body = re.sub(r"\[([^\]]+)\]\(\[\[RFC (\d+)\]\]\)", r"\1 ([[RFC \2]])", body)
        body = re.sub(r"https://github\.com/rust-lang/rfcs/(?:pull|blob/master/text)/(\d{4})(?:-[a-z0-9_\-]+\.md)?", lambda mm: f"[[RFC {int(mm.group(1))}]]", body)
        body = re.sub(r"rust-lang/rfcs#(\d+)", lambda mm: f"[[RFC {int(mm.group(1))}]]", body)
        body = re.sub(r"(?<![\w\[/-])RFC[  ]#?(\d{3,4})(?!\d)", lambda mm: f"[[RFC {int(mm.group(1))}]]", body)
        body = re.sub(r"\[\[\[\[RFC (\d+)\]\]\]\]", r"[[RFC \1]]", body)
        # Only RFC references are wikilinks; `[[bin]]`-style TOML tables and `[[1]]` footnotes stay plain
        body = re.sub(r"\[\[(?!RFC \d+\]\])([^\]\n]*)\]\]", r"[\1]", body)
        fm = frontmatter({
            "title": f"{name} — {title}",
            "type": "decision",
            "status": "Merged",
            "feature": feature,
            "date": start,
            "source": f"https://rust-lang.github.io/rfcs/{num:04d}-{slug}.html",
            "rfc_pr": re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", meta.get("RFC PR", "")),
            "license": "MIT OR Apache-2.0",
            "tags": ["decision", "rust-rfc", "merged"],
        })
        content = f"{fm}\n\n# {name} — {title}\n\n{body}\n"
        docs.append((f"decisions/Rust RFCs/{safe_name(name)}.md", content))
    log(f"Rust RFCs: {len(docs)} documents")
    return docs

def decisions_index(peps: int, rfcs: int) -> tuple[str, str]:
    fm = frontmatter({"title": "Decision records — index", "type": "overview", "tags": ["decision", "hub"]})
    content = f"""{fm}

# Decision records — index

Two real decision logs, imported as-is so the graph, the linter and the search can be judged on
documents people already know.

- **Python PEPs** ({peps}) — `decisions/Python PEPs/`. Each record carries its status (Draft, Accepted,
  Final, Rejected, Superseded, Withdrawn…), authors, creation date and its lineage (replaces /
  superseded by / requires) as wikilinks. Start from [[PEP 1]] (the process) or [[PEP 8]].
- **Rust RFCs** ({rfcs}) — `decisions/Rust RFCs/`. Merged design decisions with motivation,
  alternatives and unresolved questions. Start from [[RFC 2]] or [[RFC 1122]].

What the nightly lint finds here is real: records that many others cite but that were withdrawn,
superseded records still acting as hubs, and clusters that drifted apart.
"""
    return ("decisions/Decision records — index.md", content)

# ── Preset: encyclopedia (Korean Wikipedia subset) ────────────────────────────

WIKI_API = "https://ko.wikipedia.org/w/api.php"
SKIP_NS = ("분류:", "파일:", "틀:", "위키백과:", "도움말:", "포털:", "특수:", "사용자:", "토론:", "미디어:", "Category:", "File:", "Template:", "Wikipedia:", "Help:", "Portal:")

def wiki_get(params: dict) -> dict:
    params = {**params, "format": "json", "formatversion": 2}
    req = urllib.request.Request(f"{WIKI_API}?{urllib.parse.urlencode(params)}", headers={"User-Agent": UA})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < 5:  # be polite: honour Retry-After, otherwise back off
                time.sleep(float(e.headers.get("Retry-After") or 5 * (attempt + 1)))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 5:
                raise
            time.sleep(2 * (attempt + 1))
    return {}

def wiki_links(titles: list[str]) -> dict[str, list[str]]:
    """Article-namespace link targets of up to 50 pages in one request series (follows continuation)."""
    out: dict[str, list[str]] = {t: [] for t in titles}
    params = {"action": "query", "prop": "links", "plnamespace": 0, "pllimit": "max", "titles": "|".join(titles)}
    while True:
        d = wiki_get(params)
        for p in d.get("query", {}).get("pages", []):
            out.setdefault(p["title"], []).extend(l["title"] for l in p.get("links", []))
        if "continue" not in d:
            return out
        params = {**params, **d["continue"]}
        time.sleep(0.2)

def wiki_content(titles: list[str]) -> dict[str, dict]:
    """title → {text, timestamp} for up to 50 titles; redirects are resolved to their target."""
    d = wiki_get({"action": "query", "prop": "revisions", "rvprop": "content|timestamp", "rvslots": "main", "redirects": 1, "titles": "|".join(titles)})
    out = {}
    for p in d.get("query", {}).get("pages", []):
        if p.get("missing") or not p.get("revisions"):
            continue
        rev = p["revisions"][0]
        out[p["title"]] = {"text": rev["slots"]["main"]["content"], "timestamp": rev.get("timestamp", "")}
    return out

def strip_templates(text: str) -> str:
    """Remove {{...}} (nested) — infoboxes, citations, navboxes carry no prose."""
    while True:
        new = re.sub(r"\{\{(?:[^{}]|\{[^{}]*\})*\}\}", "", text)
        if new == text:
            return new
        text = new

def wikitext_to_md(text: str, known: set[str], max_chars: int) -> tuple[str, list[str]]:
    """Light wikitext → Markdown. Links to articles in `known` stay wikilinks, others become text."""
    cats = re.findall(r"\[\[분류:([^\]|]+)(?:\|[^\]]*)?\]\]", text)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    text = re.sub(r"<ref[^>/]*/>", "", text)
    text = re.sub(r"<ref[^>]*>.*?</ref>", "", text, flags=re.S)
    text = re.sub(r"<(math|gallery|timeline|syntaxhighlight|source|score|imagemap)[^>]*>.*?</\1>", "", text, flags=re.S)
    text = strip_templates(text)
    text = re.sub(r"\{\|.*?\|\}", "", text, flags=re.S)
    text = re.sub(r"\[\[(?:파일|File|그림|Image|분류|Category|위키공용체|wikt|미디어):[^\]\n]*(?:\[\[[^\]\n]*\]\][^\]\n]*)*\]\]", "", text)
    def link(m: re.Match) -> str:
        target = m.group(1).strip()
        label = (m.group(2) or target).strip()
        target = target.split("#")[0].replace("_", " ")
        if target and target[0].islower():
            target = target[0].upper() + target[1:]
        if target in known:  # placeholders survive the orphan-bracket cleanup below
            return f"@@L@@{target}@@R@@" if label == target else f"@@L@@{target}|{label}@@R@@"
        return label
    text = re.sub(r"\[\[([^\]|]+)(?:\|([^\]]*))?\]\]", link, text)
    text = re.sub(r"\[(https?://[^\s\]]+)\s+([^\]]+)\]", r"[\2](\1)", text)
    text = re.sub(r"\[(https?://[^\s\]]+)\]", "", text)
    text = re.sub(r"<br\s*/?>", "\n", text)
    text = re.sub(r"</?(?:small|big|sup|sub|span|div|center|u|s|nowiki|poem|blockquote|abbr|code|tt|b|i|font)[^>]*>", "", text)
    text = re.sub(r"^\s*[:;]+\s*", "", text, flags=re.M)
    # lists before bold/italic markup, so a leading ** is never read as a list marker
    text = re.sub(r"^\*{1,3}(?=[^*])\s*", lambda m: "  " * (len(m.group(0).strip()) - 1) + "- ", text, flags=re.M)
    text = re.sub(r"^#{1,3}(?![# ])\s*", "1. ", text, flags=re.M)
    text = re.sub(r"^\s*(={2,6})\s*(.+?)\s*\1\s*$", lambda m: "\n" + "#" * len(m.group(1)) + " " + m.group(2) + "\n", text, flags=re.M)
    text = re.sub(r"'''''(.+?)'''''", r"***\1***", text)
    text = re.sub(r"'''(.+?)'''", r"**\1**", text)
    text = re.sub(r"''(.+?)''", r"*\1*", text)
    text = text.replace("]]", "").replace("[[", "")  # brackets orphaned by stripped nested markup
    text = text.replace("@@L@@", "[[").replace("@@R@@", "]]")
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    # drop trailing boilerplate sections
    text = re.split(r"\n## (?:같이 보기|각주|외부 링크|참고 문헌|참고 자료|출처|주석)\b.*", text, maxsplit=1)[0].rstrip()
    if len(text) > max_chars:
        cut = text.rfind("\n## ", 0, max_chars)
        text = (text[:cut] if cut > max_chars // 2 else text[:max_chars]).rstrip() + "\n\n*(이하 생략 — 원문 링크 참조)*"
    return text, [c.strip() for c in cats][:6]

def import_wikipedia(seeds: list[str], max_docs: int, max_chars: int, cache: Path) -> list[tuple[str, str]]:
    cache_file = cache / f"kowiki-{max_docs}.json"
    if cache_file.exists():
        log(f"using cached crawl {cache_file}")
        crawl = json.loads(cache_file.read_text(encoding="utf-8"))
    else:
        # hop 1: every article each seed links to; hop 2: the most-cited targets of hop-1 pages
        origin: dict[str, str] = {}
        for s in seeds:
            origin.setdefault(s, s)
        hop1: dict[str, str] = {}
        for s, links in wiki_links(list(seeds)).items():
            for t in links:
                if t.startswith(SKIP_NS):
                    continue
                origin.setdefault(t, s)
                hop1.setdefault(t, s)
        log(f"hop 1: {len(hop1)} articles from {len(seeds)} seeds")
        counts: dict[str, int] = {}
        hop1_titles = list(hop1)
        for i in range(0, len(hop1_titles), 25):  # 25 pages per request keeps the API happy
            for src, links in wiki_links(hop1_titles[i:i + 25]).items():
                for t in links:
                    if t.startswith(SKIP_NS):
                        continue
                    origin.setdefault(t, hop1.get(src, seeds[0]))
                    counts[t] = counts.get(t, 0) + 1
            time.sleep(0.3)
        ordered = list(seeds) + [t for t in hop1 if t not in seeds]
        for t, _ in sorted(counts.items(), key=lambda kv: -kv[1]):
            if t not in hop1 and t not in seeds:
                ordered.append(t)
        ordered = ordered[: int(max_docs * 1.3)]  # over-fetch: some are redirects, stubs or disambiguations
        log(f"fetching {len(ordered)} articles")
        pages: dict[str, dict] = {}
        for i in range(0, len(ordered), 50):
            pages.update(wiki_content(ordered[i:i + 50]))
            time.sleep(0.3)
        crawl = {"origin": origin, "pages": pages, "order": ordered}
        cache_file.write_text(json.dumps(crawl, ensure_ascii=False), encoding="utf-8")

    origin, pages, order = crawl["origin"], crawl["pages"], crawl["order"]
    chosen: dict[str, dict] = {}
    for t in order:
        p = pages.get(t)
        if not p:
            continue
        raw = p["text"]
        if "{{동음이의" in raw or "{{다른 뜻" in raw[:200] and len(raw) < 1500 or raw.lstrip().lower().startswith("#redirect") or raw.lstrip().startswith("#넘겨주기"):
            continue
        if len(raw) < 1500:
            continue
        chosen[t] = p
        if len(chosen) >= max_docs:
            break
    known = set(chosen)
    docs = []
    for title, p in chosen.items():
        body, cats = wikitext_to_md(p["text"], known, max_chars)
        seed = origin.get(title, seeds[0])
        fm = frontmatter({
            "title": title,
            "type": "article",
            "date": p["timestamp"][:10],
            "source": f"https://ko.wikipedia.org/wiki/{urllib.parse.quote(title.replace(' ', '_'))}",
            "license": "CC BY-SA 4.0 — 한국어 위키백과 기여자",
            "cluster": seed,
            "tags": ["wiki", *cats[:4]],
        })
        docs.append((f"wiki/{safe_name(seed)}/{safe_name(title)}.md", f"{fm}\n\n# {title}\n\n{body}\n\n---\n*출처: [한국어 위키백과]({fm and 'https://ko.wikipedia.org/wiki/' + urllib.parse.quote(title.replace(' ', '_'))}) · CC BY-SA 4.0*\n"))
    fm = frontmatter({"title": "위키백과 부분집합 — 안내", "type": "overview", "tags": ["wiki", "hub"]})
    docs.append(("wiki/위키백과 부분집합 — 안내.md", f"""{fm}

# 위키백과 부분집합 — 안내

한국어 위키백과에서 시드 주제 {len(seeds)}개로부터 두 홉 안에 닿는 문서 {len(chosen)}개를 가져왔습니다.
문서 간 링크는 이 부분집합 안에 있는 문서로만 남겼습니다. 각 문서의 프런트매터에 원문 주소와
라이선스(CC BY-SA 4.0)가 있습니다.

## 시드
{chr(10).join(f'- [[{s}]]' for s in seeds if s in known)}
"""))
    log(f"Wikipedia: {len(docs)} documents ({len(chosen)} articles)")
    return docs

# ── CLI ───────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("preset", choices=["decisions", "encyclopedia", "wipe"])
    ap.add_argument("--out", help="write the documents into this folder")
    ap.add_argument("--server", help="Strata Sync Worker URL")
    ap.add_argument("--token", default=os.environ.get("STRATA_TEAM_TOKEN"), help="team token (or STRATA_TEAM_TOKEN)")
    ap.add_argument("--author", default="seed")
    ap.add_argument("--wipe", action="store_true", help="remove every seeded folder on the server first")
    ap.add_argument("--prefix", action="append", help="wipe: folder prefixes (default: all seed folders)")
    ap.add_argument("--cache", default=str(Path(os.environ.get("TEMP", "/tmp")) / "strata-seed-cache"))
    ap.add_argument("--seeds", default="인공지능,대한민국의 역사,양자역학,제2차 세계 대전,한글,축구,경제학,영화")
    ap.add_argument("--max", type=int, default=2000, help="encyclopedia: number of articles")
    ap.add_argument("--max-chars", type=int, default=24000, help="encyclopedia: body length cap per article")
    a = ap.parse_args()
    if not a.out and not a.server:
        sys.exit("give --out and/or --server")
    cache = Path(a.cache)
    cache.mkdir(parents=True, exist_ok=True)
    sink = Sink(a.out, a.server, a.token, a.author)

    if a.preset == "wipe":
        if not a.server:
            sys.exit("wipe needs --server")
        sink.wipe(a.prefix or SEED_PREFIXES)
        return
    if a.wipe and a.server:
        sink.wipe(a.prefix or SEED_PREFIXES)

    if a.preset == "decisions":
        peps = import_peps(cache)
        rfcs = import_rust_rfcs(cache)
        docs = peps + rfcs + [decisions_index(len(peps), len(rfcs))]
    else:
        seeds = [s.strip() for s in a.seeds.split(",") if s.strip()]
        docs = import_wikipedia(seeds, a.max, a.max_chars, cache)
    sink.put_many(docs)
    if sink.failed:
        sys.exit(1)

if __name__ == "__main__":
    main()
