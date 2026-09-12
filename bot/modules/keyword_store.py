"""
keyword_store.py — keyword_index.json CRUD operations
"""
import json
from datetime import datetime
from pathlib import Path

from .constants import KEYWORD_INDEX_REL_PATH


DEFAULT_STORE = {
    "version": 1,
    "updated": "",
    "keywords": {}
    # "keyword": {"hub_stem": "...", "display": "...", "added": "YYYY-MM-DD", "hit_count": 0}
}


class KeywordStoreError(Exception):
    """Keyword index load/save failure. Propagated to prevent index loss from an overwrite."""


class KeywordStore:
    def __init__(self, vault_path: str, rel_path: str = KEYWORD_INDEX_REL_PATH):
        self.store_path = Path(vault_path) / rel_path
        self.data: dict = DEFAULT_STORE.copy()
        self.data["keywords"] = {}
        # Saving is forbidden until load() has captured the existing content (or confirmed the file is absent).
        # Ignoring a load failure and calling save() would overwrite the whole accumulated index with a few new entries.
        self._save_allowed = False

    def load(self) -> bool:
        """Read the stored index. Returns False when the file is missing (new store); raises when corrupted."""
        if not self.store_path.exists():
            self._save_allowed = True
            return False
        try:
            raw = self.store_path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except Exception as e:
            self._save_allowed = False
            raise KeywordStoreError(
                f"Failed to load keyword index ({self.store_path}): {e}"
            ) from e
        if not isinstance(data, dict) or not isinstance(data.get("keywords"), dict):
            self._save_allowed = False
            raise KeywordStoreError(
                f"Keyword index format error ({self.store_path}): keywords dict missing"
            )
        self.data = data
        self._save_allowed = True
        return True

    def save(self):
        if not self._save_allowed:
            raise KeywordStoreError(
                f"Cannot save: load failed or load() has not been called yet ({self.store_path}). "
                "Aborting save to avoid overwriting the existing keyword index."
            )
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self.data["updated"] = datetime.now().isoformat(timespec="seconds")
        payload = json.dumps(self.data, ensure_ascii=False, indent=2)
        # write → replace atomic save (preserves the existing file if interrupted mid-write)
        tmp_path = self.store_path.with_suffix(self.store_path.suffix + ".tmp")
        tmp_path.write_text(payload, encoding="utf-8")
        tmp_path.replace(self.store_path)

    def get_keywords(self) -> dict:
        return self.data.get("keywords", {})

    def upsert(self, keyword: str, hub_stem: str, display: str = ""):
        today = datetime.now().strftime("%Y-%m-%d")
        existing = self.data["keywords"].get(keyword)
        if existing:
            existing["hub_stem"] = hub_stem
            existing["display"] = display or keyword
        else:
            self.data["keywords"][keyword] = {
                "hub_stem": hub_stem,
                "display": display or keyword,
                "added": today,
                "hit_count": 0,
            }

    def remove(self, keyword: str):
        self.data["keywords"].pop(keyword, None)

    def increment_hit(self, keyword: str, count: int = 1):
        kw = self.data["keywords"].get(keyword)
        if kw:
            kw["hit_count"] = kw.get("hit_count", 0) + count

    def to_inject_map(self) -> dict:
        """inject_keywords.py format: keyword → (hub_stem, display)"""
        return {
            kw: (info["hub_stem"], info.get("display", kw))
            for kw, info in self.data["keywords"].items()
            if info.get("hub_stem")
        }

    def count(self) -> int:
        return len(self.data.get("keywords", {}))
