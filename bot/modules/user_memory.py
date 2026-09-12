"""User memory management module"""
from __future__ import annotations
import json
import logging
import os
import threading
from pathlib import Path
from typing import Callable, Any

logger = logging.getLogger(__name__)

_USER_MEMORY_PATH = Path(__file__).parent.parent / "user_memory.json"


class UserMemoryStore:
    def __init__(self, log_fn: Callable[[str], None]):
        self._log = log_fn
        self._memory: dict[str, str] = {}
        self._lock = threading.RLock()

    def load(self) -> None:
        if _USER_MEMORY_PATH.exists():
            try:
                data = json.loads(_USER_MEMORY_PATH.read_text("utf-8"))
                if isinstance(data, dict):
                    with self._lock:
                        self._memory.update(data)
            except Exception as e:
                logger.warning("[user_memory] load failed: %s", e)

    def save(self) -> None:
        """Atomic save: write to a tmp file and swap with os.replace (prevents partial writes)."""
        try:
            with self._lock:
                snapshot = dict(self._memory)
            payload = json.dumps(snapshot, ensure_ascii=False, indent=2)
            tmp_path = _USER_MEMORY_PATH.with_suffix(_USER_MEMORY_PATH.suffix + ".tmp")
            tmp_path.write_text(payload, "utf-8")
            os.replace(tmp_path, _USER_MEMORY_PATH)
        except Exception as e:
            logger.error("[user_memory] save failed: %s", e)

    def get(self, user_id: str) -> str:
        with self._lock:
            return self._memory.get(user_id, "")

    def update(self, user_id: str, value: str) -> None:
        with self._lock:
            self._memory[user_id] = value

    def __len__(self) -> int:
        with self._lock:
            return len(self._memory)

    def auto_update(
        self,
        user_id: str,
        history: list[dict],
        claude: Any,
        api_key: str | None = None,
    ) -> None:
        """Every 5 turns, summarize the conversation and refresh the user memory."""
        if not user_id or len(history) < 10:
            return
        turn_count = len(history) // 2
        if turn_count % 5 != 0:
            return

        # If no claude client is given, create an anthropic client directly from api_key
        _client = claude
        if _client is None:
            if not api_key:
                return
            try:
                import anthropic as _anthropic
                _raw = _anthropic.Anthropic(api_key=api_key)

                class _SimpleClient:
                    """Adapter wrapping anthropic.Anthropic in the ClaudeClient.complete() interface."""
                    def __init__(self, raw: Any) -> None:
                        self._raw = raw

                    def complete(self, system: str, user: str, max_tokens: int = 400) -> str:
                        msg = self._raw.messages.create(
                            model="claude-haiku-4-5",
                            max_tokens=max_tokens,
                            system=system,
                            messages=[{"role": "user", "content": user}],
                        )
                        return msg.content[0].text if msg.content else ""

                _client = _SimpleClient(_raw)
            except Exception:
                return

        with self._lock:
            existing = self._memory.get(user_id, "")
        hist_text = "\n".join(
            f"{'👤' if m['role'] == 'user' else '🤖'} {m['content'][:200]}"
            for m in history[-10:]
        )
        summary_prompt = (
            "Summarize the conversation below in 300 characters or less, focusing on key decisions, agreements, and important context. Output only the summary."
        )
        if existing:
            summary_prompt += f"\n\nExisting memory:\n{existing}"
        try:
            summary = _client.complete(summary_prompt, f"Conversation:\n{hist_text}", max_tokens=400).strip()
            if summary:
                with self._lock:
                    current = self._memory.get(user_id, "")
                    # Only overwrite if the value hasn't been updated by another thread
                    if current == existing:
                        self._memory[user_id] = summary
                    # If current != existing, a newer update arrived — don't overwrite it
                self.save()
        except Exception:
            pass
