"""
keyword_store.py — keyword_index.json CRUD
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
    """키워드 인덱스 로드/저장 실패. 덮어쓰기로 인한 인덱스 소실을 막기 위해 전파한다."""


class KeywordStore:
    def __init__(self, vault_path: str, rel_path: str = KEYWORD_INDEX_REL_PATH):
        self.store_path = Path(vault_path) / rel_path
        self.data: dict = DEFAULT_STORE.copy()
        self.data["keywords"] = {}
        # load() 로 기존 내용을 확보(또는 파일 부재 확인)하기 전에는 저장 금지.
        # 로드 실패를 무시하고 save() 하면 누적된 인덱스 전체가 신규 몇 개로 덮어써진다.
        self._save_allowed = False

    def load(self) -> bool:
        """저장된 인덱스를 읽는다. 파일이 없으면 False(신규 생성), 손상 시 예외."""
        if not self.store_path.exists():
            self._save_allowed = True
            return False
        try:
            raw = self.store_path.read_text(encoding="utf-8")
            data = json.loads(raw)
        except Exception as e:
            self._save_allowed = False
            raise KeywordStoreError(
                f"키워드 인덱스 로드 실패 ({self.store_path}): {e}"
            ) from e
        if not isinstance(data, dict) or not isinstance(data.get("keywords"), dict):
            self._save_allowed = False
            raise KeywordStoreError(
                f"키워드 인덱스 형식 오류 ({self.store_path}): keywords 딕셔너리 없음"
            )
        self.data = data
        self._save_allowed = True
        return True

    def save(self):
        if not self._save_allowed:
            raise KeywordStoreError(
                f"로드에 실패했거나 load() 전이라 저장할 수 없습니다 ({self.store_path}). "
                "기존 키워드 인덱스를 덮어쓰지 않도록 저장을 중단합니다."
            )
        self.store_path.parent.mkdir(parents=True, exist_ok=True)
        self.data["updated"] = datetime.now().isoformat(timespec="seconds")
        payload = json.dumps(self.data, ensure_ascii=False, indent=2)
        # write → replace 원자적 저장 (쓰기 도중 중단 시 기존 파일 보존)
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
        """inject_keywords.py 형식: keyword → (hub_stem, display)"""
        return {
            kw: (info["hub_stem"], info.get("display", kw))
            for kw, info in self.data["keywords"].items()
            if info.get("hub_stem")
        }

    def count(self) -> int:
        return len(self.data.get("keywords", {}))
