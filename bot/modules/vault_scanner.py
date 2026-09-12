"""
vault_scanner.py — Vault file scanning and parsing
"""
import os
import re
import yaml
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class VaultDoc:
    path: str           # absolute path
    fname: str          # file name
    stem: str           # name without extension
    folder: str         # parent folder name
    parent_resolved: str = ""  # parent folder absolute path precomputed at scan time (avoids recomputing per search)
    title: str = ""
    tags: list = field(default_factory=list)
    doc_type: str = "reference"
    date_str: str = ""
    body: str = ""      # body without frontmatter
    raw: str = ""       # full raw text
    body_len: int = 0


def load_frontmatter(text: str) -> tuple[dict, str]:
    """Parse frontmatter → (dict, body)"""
    if text.startswith("---"):
        end = text.find("\n---", 3)
        if end != -1:
            try:
                fm = yaml.safe_load(text[3:end]) or {}
                return fm, text[end + 4:]
            except Exception:
                pass
    return {}, text


def scan_vault(vault_path: str) -> list[VaultDoc]:
    """Scan all .md files in the vault"""
    docs: list[VaultDoc] = []
    vault = Path(vault_path)
    if not vault.exists():
        return docs

    for md_file in vault.rglob("*.md"):
        # Exclude hidden folders such as .strata-sync and .obsidian.
        # Judged by the path relative to the vault root — looking at the full absolute path
        # would filter out every file when the vault lives under a dot directory
        # (e.g. C:\Users\x\.notes\vault), leaving zero scan results.
        try:
            rel_parts = md_file.relative_to(vault).parts
        except ValueError:
            rel_parts = md_file.parts
        if any(p.startswith(".") for p in rel_parts):
            continue

        try:
            raw = md_file.read_text(encoding="utf-8")
        except Exception:
            continue

        fm, body = load_frontmatter(raw)
        stem = md_file.stem
        parent = md_file.parent
        folder = parent.name

        doc = VaultDoc(
            path=str(md_file),
            fname=md_file.name,
            stem=stem,
            folder=folder,
            # Normalize once at scan time so resolve() is not called per document on every search
            parent_resolved=str(parent.resolve()),
            title=str(fm.get("title", stem)),
            tags=fm.get("tags", []) or [],
            doc_type=str(fm.get("type", "reference")),
            date_str=str(fm.get("date", ""))[:10],
            body=body,
            raw=raw,
            body_len=len(body.strip()),
        )
        docs.append(doc)

    return docs


def find_active_folders(vault_path: str) -> list[str]:
    r"""List of active-family folders (newest date first).

    The actual vault naming convention is `active` (current) and `activeYYMMDD` (snapshot).
    The previous regex `^active_\d{8}$` matched neither, returned an empty list,
    and search_vault (default active_only=True) searched zero documents.
    The legacy `active_YYYYMMDD` format is also accepted.
    """
    vault = Path(vault_path)
    pattern = re.compile(r"^active(?:_?\d{6,8})?$")
    folders = [
        str(vault / d.name)
        for d in vault.iterdir()
        if d.is_dir() and pattern.match(d.name)
    ]
    return sorted(folders, reverse=True)


def get_wikilinks(text: str) -> list[str]:
    """Extract [[stem]] or [[stem|display]] from the body → list of stems"""
    return re.findall(r"\[\[(.*?)(?:\|.*?)?\]\]", text, re.DOTALL)
