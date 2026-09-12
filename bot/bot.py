"""
Strata Sync Source Management Bot — vault management + Slack bot integrated GUI
──────────────────────────────────────────────────────────────────
Features:
  - Scan vault MD files + auto-manage keyword_index.json
  - Inject wikilinks + strengthen cluster links
  - Auto-refresh index_YYYYMMDD.md (timer 1h / 5h)
  - Index MD file browser (view generated indexes)
  - Slack bot (Socket Mode, persona + RAG)

Run:
    python bot.py
"""

import json
import os
import re
import sys
import threading
import time
import tkinter as tk
from tkinter import ttk, scrolledtext, filedialog, messagebox
from datetime import datetime, timedelta
from pathlib import Path

# Load .env file (secret priority: .env > config.json > UI input)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # without python-dotenv, use env vars only

# Add module path
sys.path.insert(0, str(Path(__file__).parent))

from modules.vault_scanner import scan_vault, find_active_folders
from modules.keyword_store import KeywordStore, KeywordStoreError
from modules.claude_client import ClaudeClient
from modules.user_memory import UserMemoryStore
from modules.wikilink_updater import process_folder
from modules.index_generator import generate_index
from modules.progress_updater import ProgressUpdater
from modules.mirofish_runner import run_simulation as mirofish_run_python, STANCE_KO
from modules.constants import DEFAULT_HAIKU_MODEL, KEYWORD_INDEX_REL_PATH
from modules.rag_electron import RAG_API_BASE, set_auth_token as _rag_set_auth_token
from modules.api_keys import get_anthropic_key
from modules.config_schema import BotConfig, default_config
from modules.report_builder import ReportBuilder
from modules.slack_image import SlackImageHandler, _IMAGE_WORDS, _ACTION_WORDS
from modules.mirofish_handler import MiroFishHandler, BotContext
from modules.slack_scheduler import SlackScheduler

CONFIG_PATH = Path(__file__).parent / "config.json"  # can be overridden with the --config argument

# Shared-state sync lock (single instance used bot-wide)
_active_channels_lock = threading.Lock()


_INTENT_VERB_RE = re.compile(
    r'(분석|정리|요약|검토|설명|비교|제안|작성|소개|추천|추출|뽑아)(해줘|해주세요|해봐줘|해봐|줘|주세요|해)\s*$',
    flags=re.IGNORECASE,
)
_INTENT_LABELS = {
    '분석': '분석', '정리': '정리', '요약': '요약', '검토': '검토',
    '설명': '설명', '비교': '비교', '제안': '제안', '작성': '작성',
    '소개': '소개', '추천': '추천', '추출': '추출', '뽑아': '추출',
}


def _extract_intent(q: str) -> str | None:
    """Extract the intent verb at the end of the query (organize/analyze/compare, etc.) as a tag. None if absent."""
    m = _INTENT_VERB_RE.search(q.strip())
    if not m:
        return None
    return _INTENT_LABELS.get(m.group(1))


def _clean_search_query(q: str) -> str:
    """
    Strip meta-instruction phrases from the search query.
    Keeps BM25/TF-IDF from being polluted by vault-wide common words like "report", "analysis", "direction".

    Order of application:
      1. Compound meta-verbs: "analyze this", "organize this", "suggest this", etc.
      2. Meta-noun + action: "write a report", "make a report"
      3. Pure request endings: "tell me", "find me", "do it", "give me", etc.
    If everything gets stripped, return the original as-is.
    The original intent verb can be preserved separately by the caller via `_extract_intent()`.
    """
    out = q.strip()
    # 1. Compound meta-verbs (verb itself carries meta meaning + request ending)
    out = _INTENT_VERB_RE.sub('', out)
    # 2. Meta-noun + action verb: "write a report", "make a report"
    out = re.sub(
        r'\s*(보고서|리포트|report)\s*[\w가-힣]*(써|만들|작성|export|pdf)[\w가-힣\s]*$',
        '', out, flags=re.IGNORECASE,
    )
    # 3. Pure request endings
    out = re.sub(
        r'\s*(알려줘|알려주세요|찾아줘|찾아주세요|말해줘|말해주세요|해줘|해주세요|줘|주세요|부탁해|부탁합니다)\s*$',
        '', out, flags=re.IGNORECASE,
    )
    out = out.strip()
    return out if out else q.strip()


def _classify_query(q: str) -> str:
    """Classify as 'simple' (BM25 alone suffices) or 'complex' (rewrite/decompose is worthwhile).

    Complex conditions (any one suffices):
      - Contains an intent verb (organize/analyze/compare, etc.) — used to pick the response style, so rewrite is worthwhile
      - Cleaned length > 15 chars OR spaces > 2 OR contains punctuation
    """
    if _extract_intent(q) is not None:
        return 'complex'
    cleaned = _clean_search_query(q).strip()
    if len(cleaned) > 15:
        return 'complex'
    if cleaned.count(' ') > 2:
        return 'complex'
    if any(ch in cleaned for ch in '?!.？！。'):
        return 'complex'
    return 'simple'


class _LRUTTLCache:
    """Simple LRU + TTL cache. Not fully thread-safe, but sufficient for the Slack bot's single-interpreter environment."""
    def __init__(self, max_size: int = 512, ttl_seconds: int = 3600):
        from collections import OrderedDict
        self._store: "OrderedDict[str, tuple[float, object]]" = OrderedDict()
        self._max_size = max_size
        self._ttl = ttl_seconds

    def get(self, key: str):
        import time as _t
        hit = self._store.get(key)
        if hit is None:
            return None
        ts, val = hit
        if _t.time() - ts > self._ttl:
            self._store.pop(key, None)
            return None
        self._store.move_to_end(key)
        return val

    def set(self, key: str, val) -> None:
        import time as _t
        self._store[key] = (_t.time(), val)
        self._store.move_to_end(key)
        while len(self._store) > self._max_size:
            self._store.popitem(last=False)


_rewrite_cache = _LRUTTLCache(max_size=512, ttl_seconds=3600)
_decomp_cache  = _LRUTTLCache(max_size=256, ttl_seconds=3600)


# Guard to filter out cases where the LLM returns a conversational reply instead of search keywords
# (e.g. "It would help if you could give me more specific details 😊")
_CHAT_RESPONSE_PATTERNS = re.compile(
    r"(?:"
    # Emoji — including VS16 and extended pictographs (Extended-A/B, Symbols & Pictographs, Dingbats, etc.)
    r"[\U0001F300-\U0001FAFF\u2600-\u27BF\U0001F000-\U0001F1FF]"
    r"|\u2705|\U0001F389|\U0001F680|\U0001F4A1|\u2728|\U0001F525|\U0001F44D|\U0001F64C|\U0001F64F"  # ✅🎉🚀💡✨🔥👍🙌🙏 fallback direct match
    r"|\*\*"                                 # markdown bold
    r"|[.!?？。！]\s|[.!?？。！]$"            # sentence-ending punctuation
    r"|(?:습니다|하세요|주세요|세요|십시오|네요|까요|죠|드려요|에요|예요|이에요)(?:[\s.?!]|$)"
    r"|(?:죄송|제공해|알려주시|알려드|도움|필요하시|내용이\s*없)"
    r")"
)


# Hangul syllables (U+AC00..U+D7A3)
_HANGUL_SYLLABLE_RE = re.compile(r"[가-힣]")


def _is_valid_search_query(s: str) -> bool:
    """Decide whether the LLM output is usable as a 'search keyword' rather than a conversational reply.

    Hangul is judged separately by syllable count. This project's core keywords
    are short (Korean words like 'balance', 'character', 'sound', 'GDD', 'Lumo', 'Enoch', 'characterG'),
    so blanket-rejecting anything 3 characters or fewer would discard them all.

    Failure conditions: empty string, 80+ chars, fewer than 2 Hangul syllables (fewer than 2 chars if no Hangul),
    contains emoji/markdown/sentence endings/apology or guidance phrases.
    """
    if not s:
        return False
    s = s.strip()
    if not s or len(s) >= 80:
        return False
    syllables = _HANGUL_SYLLABLE_RE.findall(s)
    if syllables:
        if len(syllables) < 2:
            return False
    elif len(s) < 2:
        return False
    if _CHAT_RESPONSE_PATTERNS.search(s):
        return False
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Config helpers
# ─────────────────────────────────────────────────────────────────────────────

def load_config() -> BotConfig:
    cfg: BotConfig = default_config()
    if CONFIG_PATH.exists():
        try:
            cfg.update(json.loads(CONFIG_PATH.read_text(encoding="utf-8")))  # type: ignore[arg-type]
        except Exception as e:
            print(f"[bot] Config load failed ({CONFIG_PATH}): {e}")
    # env vars override config.json (secrets are managed only in .env)
    if os.getenv("ANTHROPIC_API_KEY"):
        cfg["claude_api_key"] = os.environ["ANTHROPIC_API_KEY"]
    if os.getenv("SLACK_BOT_TOKEN"):
        cfg["slack_bot_token"] = os.environ["SLACK_BOT_TOKEN"]
    if os.getenv("SLACK_APP_TOKEN"):
        cfg["slack_app_token"] = os.environ["SLACK_APP_TOKEN"]
    # RAG HTTP auth token — injected into bot/config.json by Electron
    _rag_set_auth_token(cfg.get("rag_auth_token"))
    return cfg


_SECRET_KEYS = {"claude_api_key", "slack_bot_token", "slack_app_token"}

def save_config(cfg: dict):
    # Save everything to local config.json (including secrets).
    # If env vars exist, load_config overrides them, so env priority is preserved.
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# Bot logic (runs in background thread)
# ─────────────────────────────────────────────────────────────────────────────

class VaultBot:
    def __init__(self, cfg: dict, log_fn, on_done_fn):
        self.cfg = cfg
        self._log_fn = log_fn      # must be called via after() — not directly from threads
        self.on_done = on_done_fn
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def log(self, msg: str):
        """Thread-safe log: schedules the call on the Tk main thread."""
        self._log_fn(msg)          # _log_fn is App._log_threadsafe which uses after()

    def _run_cycle(self):
        cfg = self.cfg
        vault_path = cfg.get("vault_path", "").strip()
        api_key = get_anthropic_key(cfg)

        if not vault_path or not Path(vault_path).exists():
            self.log("❌ Vault path is missing or does not exist.")
            return

        self.log(f"\n{'='*50}")
        self.log(f"🚀 Run started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        self.log(f"Vault: {vault_path}")

        # 1. Scan vault
        self.log("\n📂 Scanning vault...")
        docs = scan_vault(vault_path)
        self.log(f"  Found {len(docs)} MD files in total")

        active_folders = find_active_folders(vault_path)
        self.log(f"  active folders: {len(active_folders)} → {[Path(f).name for f in active_folders]}")

        # 2. Load keyword store
        store = KeywordStore(vault_path, cfg.get("keyword_index_path", KEYWORD_INDEX_REL_PATH))
        try:
            loaded = store.load()
        except KeywordStoreError as e:
            # Continuing in a failed-load state would let save() overwrite the entire existing index → abort
            self.log(f"\n❌ Keyword index load failed — aborting (protecting index): {e}")
            raise
        self.log(f"\n🔑 Keyword index: {'loaded' if loaded else 'newly created'} ({store.count()} keywords)")

        # 3. Discover new keywords with Claude (only when API key is present)
        if api_key:
            self.log("\n🤖 Claude Haiku — discovering keywords...")
            try:
                client = ClaudeClient(api_key, cfg.get("worker_model", DEFAULT_HAIKU_MODEL))
                # Sample of latest documents from the active folder
                sample_docs = []
                for d in docs:
                    if any(d.path.startswith(f) for f in active_folders[:1]):
                        sample_docs.append({
                            "stem": d.stem,
                            "title": d.title,
                            "body_snippet": d.body[:400],
                        })
                    if len(sample_docs) >= cfg.get("max_files_per_keyword_scan", 20):
                        break

                if sample_docs:
                    new_kws = client.discover_keywords(sample_docs)
                    added = 0
                    for item in new_kws:
                        kw = item.get("keyword", "")
                        hub = item.get("hub_stem", "")
                        display = item.get("display", kw)
                        if kw and hub:
                            store.upsert(kw, hub, display)
                            added += 1
                    self.log(f"  {added} keywords discovered/updated")
                else:
                    self.log("  No documents in active folder — skipping")
            except Exception as e:
                self.log(f"  ⚠️ Claude API error: {e}")
        else:
            self.log("\n⚠️  No API key — skipping keyword discovery (using existing index)")

        store.save()
        self.log(f"  Keyword index saved ({store.count()} entries)")

        # 4. Process wikilinks per active folder
        keyword_map = store.to_inject_map()
        total_updated = 0
        total_hits: dict = {}

        for folder in active_folders:
            self.log(f"\n🔗 Processing wikilinks: {Path(folder).name}")
            result = process_folder(folder, keyword_map, log_fn=self.log)
            total_updated += result["updated"]
            for kw, cnt in result["keyword_hits"].items():
                total_hits[kw] = total_hits.get(kw, 0) + cnt

        self.log(f"\n  {total_updated} files updated in total")
        if total_hits:
            top = sorted(total_hits.items(), key=lambda x: -x[1])[:5]
            self.log(f"  Keyword hits TOP5: {', '.join(f'{k}({v})' for k,v in top)}")

        # 5. Refresh index (latest active folder)
        if active_folders:
            self.log(f"\n📋 Refreshing index: {Path(active_folders[0]).name}")
            generate_index(active_folders[0], log_fn=self.log)

        self.log(f"\n✅ Done: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        self.on_done()

    def run_once(self):
        def _safe():
            try:
                self._run_cycle()
            except Exception as e:
                self.log(f"❌ Fatal error: {e}")
            finally:
                self.on_done()
        t = threading.Thread(target=_safe, daemon=True)
        t.start()

    def start_timer(self, interval_hours: float):
        self._stop.clear()

        def loop():
            while not self._stop.is_set():
                try:
                    self._run_cycle()
                except Exception as e:
                    self.log(f"❌ Fatal error: {e}")
                finally:
                    self.on_done()
                # Wait for interval (check stop every 10 seconds)
                end_time = time.time() + interval_hours * 3600
                while time.time() < end_time and not self._stop.is_set():
                    time.sleep(10)

        self._thread = threading.Thread(target=loop, daemon=True)
        self._thread.start()

    def stop_timer(self):
        self._stop.set()


# ─────────────────────────────────────────────────────────────────────────────
# Slack Bot Runner
# ─────────────────────────────────────────────────────────────────────────────

class SlackBotRunner:
    """Manages the Slack SocketModeHandler in a background thread."""

    def __init__(self, cfg: dict, log_fn, on_status_fn):
        self.cfg = cfg
        self._log = log_fn          # thread-safe (after()-based)
        self._on_status = on_status_fn
        self._handler = None
        self._thread: threading.Thread | None = None
        self._running = False       # stop reconnect loop when stop() is called

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> bool:
        """Start the Slack bot. Returns True on success."""
        try:
            from slack_bolt import App
            from slack_bolt.adapter.socket_mode import SocketModeHandler
            from slack_sdk import WebClient
        except ImportError:
            self._log("❌ slack-bolt package required: pip install slack-bolt")
            return False

        from modules.persona_config import resolve_persona
        from modules.rag_simple import search_vault, build_rag_context, apply_hotness_rerank, record_doc_access
        from modules.graph_expand import expand_via_wikilinks
        from modules.rag_electron import search_via_electron, get_model_for_tag, ask_via_electron, get_images_via_electron, mirofish_via_electron, get_electron_settings, get_api_key_from_settings, save_mirofish_to_vault, is_electron_alive, propose_via_electron
        from modules.slack_utils import extract_slack_files, download_slack_file
        from modules.multi_agent_rag import build_multi_agent_context
        from modules.web_search import search_web, build_web_context

        cfg = self.cfg
        bot_token  = cfg.get("slack_bot_token", "").strip()
        app_token  = cfg.get("slack_app_token", "").strip()
        vault_path = cfg.get("vault_path", "").strip()
        # The api_keys module is the single owner of the priority order (Electron > config > env)
        api_key    = get_anthropic_key(cfg)
        top_n      = cfg.get("slack_rag_top_n", 5)

        if not bot_token or not app_token:
            self._log("❌ slack_bot_token / slack_app_token missing from config.")
            return False
        if not vault_path or not Path(vault_path).exists():
            self._log(f"❌ Vault path not found: {vault_path!r}")
            return False

        _re = re  # alias for local compiled patterns (re imported at top-level)
        web = WebClient(token=bot_token)
        app    = App(token=bot_token)
        _report_builder = ReportBuilder(web, self._log)
        _img_handler = SlackImageHandler(web, bot_token, api_key, self._log)

        PERSONA_TAG_RE = _re.compile(r"\[([^\]]+)\]")
        BOT_MENTION_RE = _re.compile(r"<@[A-Z0-9]+>")
        # MiroFish natural-language detection: 🐟 emoji, mirofish keyword, or simulation action words
        # Trigger: Korean "simulation" or "sim" (standalone keywords; regex below is user-input data)
        MIROFISH_RE = _re.compile(
            r"시뮬레이션|시뮬",
            _re.IGNORECASE,
        )
        # Report-generation intent: identical to REPORT_INTENT_RE in chatStore.ts
        REPORT_INTENT_RE = _re.compile(
            r"보고서.{0,20}(써|만들|작성|뽑아|정리|export|pdf)|(대화|채팅).{0,20}보고서|보고서.{0,20}(대화|채팅)|(pdf|PDF).{0,20}(만들|보고서|저장|export)",
            _re.IGNORECASE,
        )

        # Persona count: "5 people", "with 10 people" (Korean counter suffix)
        MIRO_PERSONAS_RE = _re.compile(r"(\d{1,2})\s{0,3}명")
        # Round count: "3 rounds", "5 rounds", "in 3 rounds" (Korean suffix)
        MIRO_ROUNDS_RE   = _re.compile(r"(\d{1,2})\s{0,3}라운드로?")
        # Target segment: "core", "casual", "hardcore", "light", "new", "returning" users (Korean)
        MIRO_SEGMENT_RE  = _re.compile(
            r"(코어\s*게이머|캐주얼\s*게이머|하드코어\s*게이머|라이트\s*유저|신규\s*유저|복귀\s*유저|"
            r"코어\s*유저|캐주얼\s*유저|하드코어\s*유저|[가-힣a-zA-Z]+\s*세그먼트)",
            _re.IGNORECASE,
        )
        # A vs B comparison: "X vs Y", "X versus Y", "compare X and Y" (Korean particles)
        MIRO_VS_RE = _re.compile(
            r"(.+?)\s+(?:vs\.?|대비|와\s+(.+?)\s+비교)\s+(.+)",
            _re.IGNORECASE,
        )
        # Preset reference: "[preset:name]" (Korean or English keyword)
        MIRO_PRESET_RE = _re.compile(r"\[(?:프리셋|preset)\s*:\s*([^\]]+)\]", _re.IGNORECASE)
        # Per-thread/DM conversation history (key: "channel:thread_ts", max 1000 keys)
        _MAX_HISTORY_KEYS = 1000
        # Shared state container (shared with MiroFishHandler)
        _bot_ctx = BotContext()
        _conv_history      = _bot_ctx.conv_history
        _conv_history_lock = _bot_ctx.conv_history_lock

        # ── Per-Slack-user long-term memory ─────────────────────────────────
        _mem_store = UserMemoryStore(self._log)
        _mem_store.load()

        # ── MiroFish handler initialization ──────────────────────────────────
        # say_fn / download_slack_file are injected at call time (not known when the handler is created)
        _miro_handler = MiroFishHandler(
            web_client=web,
            api_key=api_key,
            cfg=cfg,
            bot_context=_bot_ctx,
            report_builder=_report_builder,
            img_handler=_img_handler,
            say_fn=None,   # injected at runtime
            log_fn=self._log,
        )

        # ── Scheduler initialization ─────────────────────────────────────────
        _scheduler = SlackScheduler(web, cfg, _bot_ctx, _miro_handler, self._log)

        def parse_msg(text: str):
            text = BOT_MENTION_RE.sub("", text).strip()
            tag = "chief"
            m = PERSONA_TAG_RE.search(text)
            if m:
                tag = m.group(1).strip()
                text = text[:m.start()] + text[m.end():]
            return tag, text.strip()

        _SLACK_MAX = 3800  # effective Slack block limit (4000-char buffer)
        # chat.update calls pass blocks=[] to bypass the original section block's 3000-char limit,
        # so the text limit is relaxed to 3500 (also well within the 40KB byte limit).
        _SLACK_UPDATE_MAX = 3500

        def _say_long(text: str, say_fn, thread_ts: str | None, *, update_ts: str | None = None, channel: str | None = None):
            """Auto-split text over 4000 chars and post it. If update_ts is given, the first chunk uses chat_update."""
            chunks, buf = [], ""
            for line in text.splitlines(keepends=True):
                if len(buf) + len(line) > _SLACK_MAX:
                    if buf:
                        chunks.append(buf.rstrip())
                    buf = line
                else:
                    buf += line
            if buf.strip():
                chunks.append(buf.rstrip())
            if not chunks:
                return
            # If the first chunk exceeds the chat.update limit, skip update and use say instead.
            # (update becomes a one-line "done", and the body is sent as a new message)
            if update_ts and channel and chunks and len(chunks[0]) > _SLACK_UPDATE_MAX:
                try:
                    web.chat_update(channel=channel, ts=update_ts, text="✅ Answer ready", blocks=[])
                except Exception as e:
                    self._log(f"[chat_update] Status cleanup failed (ignored): {str(e)[:200]}")
                update_ts = None  # everything after this uses say
            for i, chunk in enumerate(chunks):
                suffix = f"\n\n_({i+1}/{len(chunks)})_" if len(chunks) > 1 else ""
                msg = chunk + suffix
                if i == 0 and update_ts and channel:
                    try:
                        # blocks=[] bypasses the original section block's 3000-char limit
                        web.chat_update(channel=channel, ts=update_ts, text=msg, blocks=[])
                    except Exception as e:
                        self._log(f"[chat_update] Failed ({str(e)[:200]}), falling back to say")
                        say_fn(text=msg, thread_ts=thread_ts)
                else:
                    say_fn(text=msg, thread_ts=thread_ts)

        def _generate_report_html(title: str, content: str) -> Path:
            """Save LLM report markdown as a wkhtmltopdf-compatible HTML file. Returns the file path."""
            return _report_builder.generate_report_html(title, content)

        def _upload_file_to_slack(filepath: Path, channel: str, thread_ts: str | None, title: str = "") -> bool:
            """Upload a file to Slack. Returns whether it succeeded."""
            return _report_builder.upload_file_to_slack(filepath, channel, thread_ts, title)

        def _handle_mirofish(query: str, say, channel: str, thread_ts: str | None, image_files: list | None = None):
            """Handle a MiroFish simulation request — delegated to MiroFishHandler."""
            _miro_handler.handle(
                query=query,
                say=say,
                channel=channel,
                thread_ts=thread_ts,
                image_files=image_files,
                search_via_electron_fn=search_via_electron,
                ask_via_electron_fn=ask_via_electron,
                mirofish_via_electron_fn=mirofish_via_electron,
                get_electron_settings_fn=get_electron_settings,
                save_mirofish_to_vault_fn=save_mirofish_to_vault,
                is_electron_alive_fn=is_electron_alive,
                get_anthropic_key_fn=get_anthropic_key,
                get_model_for_tag_fn=get_model_for_tag,
                mirofish_run_python_fn=mirofish_run_python,
                download_slack_file_fn=download_slack_file,
                claude_client_cls=ClaudeClient,
            )

        # Track channels the bot has replied in — used to send an "updating" message on shutdown
        _active_channels = _bot_ctx.active_channels

        def respond(text: str, say, channel: str, thread_ts: str | None = None, files: list | None = None, user_id: str | None = None):
            """Common response handling for channel mentions / DMs."""
            with _active_channels_lock:
                _active_channels.add(channel)
            tag, query = parse_msg(text)

            # ── 1. Image handling ───────────────────────────────────────────────
            image_files = [f for f in (files or []) if f.get("mimetype", "").startswith("image/")]

            # Cleaned query for search: strip meta-instruction phrases → prevents BM25/TF-IDF pollution
            # (removes request verb phrases like "write a report", "analyze this", "suggest a direction")
            # The original query is kept for final LLM generation (instruction meaning like report/analysis is needed)
            search_query = _clean_search_query(query)
            # Intent tag: extracted from the original before cleaning → injected into the final LLM prompt
            intent_tag = _extract_intent(query)
            if search_query != query:
                self._log(f"[QueryClean] '{query[:40]}' → '{search_query[:40]}'" + (f" [intent={intent_tag}]" if intent_tag else ""))

            if not query and not image_files:
                say(text="How can I help you?", thread_ts=thread_ts)
                return
            if not query:
                query = "Please analyze this image."

            # Help command
            if _re.search(r"^!도움말$|^!help$", query.strip(), _re.IGNORECASE):
                settings_data = get_electron_settings() or {}
                saved_presets = settings_data.get("presets", [])
                if saved_presets:
                    preset_lines = "  " + "  /  ".join(
                        f"`{p['name']}` ({len(p.get('personas', []))} personas)" for p in saved_presets[:6]
                    )
                else:
                    preset_lines = "  _(No saved presets yet. You can create them in Strata Sync Settings > MiroFish)_"
                say(
                    blocks=[
                        {
                            "type": "header",
                            "text": {"type": "plain_text", "text": "🗺️  Strata Sync Bot", "emoji": True},
                        },
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": "I can answer questions based on the game design docs in your vault, and simulate virtual user reactions.",
                            },
                        },
                        {"type": "divider"},
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": (
                                    "*💬  Just ask*\n"
                                    "> _What's the design direction for the new dungeon content?_\n"
                                    "> _[art] Summarize this character's visual concept_\n"
                                    "> _[spec] Give me balance feedback based on this image_  _(+ attach image)_"
                                ),
                            },
                        },
                        {
                            "type": "context",
                            "elements": [{"type": "mrkdwn", "text": "Without a tag the PM answers — use `[art]` `[spec]` `[tech]` tags to pick who responds"}],
                        },
                        {"type": "divider"},
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": (
                                    "*🐟  MiroFish — user reaction simulation*\n"
                                    "Runs automatically when the message contains `시뮬레이션` or `시뮬`.\n\n"
                                    "`신규 캐릭터 출시 시뮬레이션`  — default (5 personas, 3 rounds)\n"
                                    "`가격 인상 발표 시뮬레이션 10명 5라운드`  — set persona/round count\n"
                                    "`PvP 업데이트 시뮬 보고서`  — report only, no feed\n"
                                    "`신규 던전 코어 게이머 시뮬레이션`  — set target segment\n"
                                    "`A vs B 시뮬레이션`  — compare two scenarios side by side\n"
                                    "`... 새로 시뮬레이션`  — ignore the 30-min cache and run fresh"
                                ),
                            },
                        },
                        {
                            "type": "context",
                            "elements": [{"type": "mrkdwn", "text": f"*Saved presets*  {preset_lines}"}],
                        },
                        {"type": "divider"},
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": (
                                    "*⌨️  Slash commands*\n"
                                    "`/ask question`  `/remember`  `/propose title | body`  `/status`  `/help`\n\n"
                                    "*⚡  Global shortcut*\n"
                                    "`ask_sandbox`  — ask a question via popup from any channel"
                                ),
                            },
                        },
                        {
                            "type": "context",
                            "elements": [{"type": "mrkdwn", "text": "🔖 `#시뮬레이션필요` tag in a vault doc → auto notification   •   ⏰ Scheduled auto-run: Settings > MiroFish"}],
                        },
                    ],
                    text="🗺️ Strata Sync Bot usage",
                    thread_ts=thread_ts,
                )
                return

            # Detect MiroFish simulation request → branch to dedicated handler
            if MIROFISH_RE.search(query):
                _handle_mirofish(query, say, channel, thread_ts, image_files=image_files)
                return

            persona = resolve_persona(tag)
            emoji   = persona.get("emoji", "🤖")
            name    = persona.get("name", tag)

            # Create only one thinking message — vision/RAG both update the same ts
            status = "✦ Analyzing image..." if image_files else "✦ Thinking deeply..."
            thinking = say(text=f"{status}", thread_ts=thread_ts)
            think_ts = (thinking or {}).get("ts")
            progress = ProgressUpdater(
                web, channel, think_ts, name=name, emoji=emoji,
                is_electron=True, log_fn=self._log,
            ) if think_ts else None

            # If there are images: download → pass directly to Electron (LLM analyzes image + RAG docs together)
            images_payload: list[dict] = []
            if image_files:
                self._log(f"[Vision] {name}: downloading {len(image_files)} images...")
                images_payload = _img_handler.download_images(image_files, download_slack_file)
                if images_payload:
                    self._log(f"[Vision] Passing {len(images_payload)} to Electron")
                    img_desc = _img_handler.describe_images(images_payload, query)
                    if img_desc:
                        self._log(f"[Vision] Image description done ({len(img_desc)} chars) → augmenting RAG query")
                        query = f"{query}\n\n[Attached image description]\n{img_desc}"
                else:
                    self._log("[Vision] 0 images downloaded → falling back to text-only RAG")

            import time as _time
            _t0 = _time.monotonic()
            def _elapsed() -> str:
                return f"{_time.monotonic() - _t0:.1f}s"

            self._log(f"[Slack] {name}: {query[:80]}")

            # ── 2. RAG search ───────────────────────────────────────────────────
            # Detect explicit image request → /images search
            vault_image_paths: list[str] = []
            is_img_req = any(w in query for w in _IMAGE_WORDS)
            if is_img_req:
                # Strip image/action words → keep only the subject terms (character names, etc.)
                img_query = query
                for w in _IMAGE_WORDS + _ACTION_WORDS:
                    img_query = img_query.replace(w, " ")
                img_query = " ".join(img_query.split()).strip("~,. !?") or query
                vault_image_paths = get_images_via_electron(img_query)
                self._log(f"[Image] Explicit search '{img_query[:40]}': {len(vault_image_paths)} results")

            # Look up per-thread history (DMs use the channel as key)
            hist_key = f"{channel}:{thread_ts or 'dm'}"
            with _conv_history_lock:
                history = list(_conv_history.get(hist_key, []))
                # LRU: move to most-recently-used on access (OrderedDict)
                if hist_key in _conv_history:
                    try:
                        _conv_history.move_to_end(hist_key)
                    except AttributeError:
                        pass  # dict fallback (compat with older state)
            if history:
                self._log(f"[Slack] Restored {len(history)//2} turns of history")

            claude = None  # overwritten in fallback, used for user memory updates
            # Priority 1: Electron /ask — uses Strata Sync's BFS RAG + LLM pipeline as-is
            if progress: progress.start("electron")

            # Check Electron HTTP readiness (/settings responds within 3s)
            # TCP open but HTTP unresponsive = restarting → fall back immediately (avoids 65s wait)
            _electron_alive = is_electron_alive()
            _electron_timed_out = False
            if not _electron_alive:
                if progress:
                    progress.set_message("🔴 The Strata Sync app is off or starting up. Processing with Python RAG...")
                self._log(f"[{_elapsed()}] [RAG] Electron HTTP unresponsive → fallback")
                answer, auto_image_paths = None, []
            else:
                self._log(f"[{_elapsed()}] [RAG] Calling Electron /ask...")
                answer, auto_image_paths = ask_via_electron(query, tag=tag, history=history, images=images_payload or None)
                if not answer:
                    # If HTTP is still alive after the call it's an 'empty response', otherwise 'timeout/disconnected'
                    _still_alive = is_electron_alive()
                    _electron_timed_out = not _still_alive
                    _electron_empty = _still_alive  # server alive but answer is "" or None
                    if progress:
                        progress.set_message(
                            "📭 The app returned an empty response. Processing with Python RAG..."
                            if _electron_empty else
                            "⏱️ App response timed out. Processing with Python RAG..."
                        )
                else:
                    _electron_empty = False

            if progress: progress.done("electron")
            if answer:
                self._log(f"[{_elapsed()}] [RAG] Electron /ask succeeded ({len(answer)} chars)")
                if auto_image_paths:
                    self._log(f"[{_elapsed()}] [Image] {len(auto_image_paths)} auto images")
                final = answer
            else:
                auto_image_paths = []
                # Fallback: Python's own RAG + 10 sub-agents + Claude
                if locals().get("_electron_empty"):
                    self._log(f"[{_elapsed()}] [RAG] Electron /ask empty response → sub-agent RAG")
                elif _electron_timed_out:
                    self._log(f"[{_elapsed()}] [RAG] Electron /ask timed out → sub-agent RAG")
                else:
                    self._log(f"[{_elapsed()}] [RAG] Electron not running → sub-agent RAG")
                # The fallback path is shown as fine-grained steps
                if progress:
                    progress._remaining = ["search", "analyze", "webcheck", "answer"]
                # Initialize Claude client (shared by query rewriting, multi-query, and analysis)
                # slack_model setting takes priority; otherwise use the per-persona-tag model
                _slack_model = self.cfg.get("slack_model")
                model = _slack_model if _slack_model else get_model_for_tag(tag)
                live_key = get_anthropic_key(self.cfg) or api_key
                claude = ClaudeClient(live_key, model) if live_key else None
                self._log(f"[{_elapsed()}] [Model] {model}")

                # ── Query complexity classification — Simple skips rewrite/decompose ──
                _complexity = _classify_query(search_query)
                if _complexity == 'simple':
                    self._log(f"[QueryClass] simple → skipping rewrite/decompose ('{search_query[:40]}')")

                # ── Query rewriting (Complex only, LRU cache + few-shot + 1 retry) ──
                if claude and _complexity == 'complex':
                    _cached = _rewrite_cache.get(search_query)
                    if _cached is not None:
                        if _cached != search_query:
                            self._log(f"[QueryRewrite] Cache hit: '{search_query[:40]}' → '{_cached[:40]}'")
                            search_query = _cached
                    else:
                        _rewrite_sys = (
                            "Convert the input sentence into Korean search keywords only and print them as OUTPUT.\n\n"
                            "Rules:\n"
                            "- Remove verbs, endings, and particles; core nouns only\n"
                            "- 20 characters or fewer, space-separated\n"
                            "- No explanations, sentences, emoji, or markdown\n"
                            "- If conversion is hard, copy only the noun phrases from the input\n\n"
                            "Example 1:\n"
                            "INPUT: 캐릭터E 컨셉과 관련해서 디렉터 피드백을 정리해봐\n"
                            "OUTPUT: 캐릭터E 컨셉 디렉터 피드백\n\n"
                            "Example 2:\n"
                            "INPUT: 최근 회의에서 주요한 의사결정이 뭐였지?\n"
                            "OUTPUT: 최근 회의 주요 의사결정\n\n"
                            "Example 3:\n"
                            "INPUT: 지난달 Strata Sync 성능 이슈 있었나\n"
                            "OUTPUT: Strata Sync 성능 이슈"
                        )
                        _rewrite_user = f"INPUT: {search_query}\nOUTPUT:"
                        _rewritten = None
                        for _attempt in range(2):
                            try:
                                _raw = claude.complete(_rewrite_sys, _rewrite_user, max_tokens=40).strip()
                                # Strip "OUTPUT:" prefix (the model may echo it)
                                if _raw.upper().startswith('OUTPUT:'):
                                    _raw = _raw[7:].strip()
                                # Strip surrounding quotes
                                _raw = _raw.strip('"\'').strip()
                                if _is_valid_search_query(_raw):
                                    _rewritten = _raw
                                    break
                                else:
                                    self._log(f"[QueryRewrite] Invalid response (attempt {_attempt+1}): '{_raw[:40]}'")
                            except Exception as _e:
                                self._log(f"[QueryRewrite] Exception (attempt {_attempt+1}): {_e}")
                        if _rewritten:
                            _rewrite_cache.set(search_query, _rewritten)
                            self._log(f"[QueryRewrite] '{search_query[:40]}' → '{_rewritten[:40]}'")
                            search_query = _rewritten
                        else:
                            # Retry failed — cache the original to avoid repeating the retry cost (within TTL)
                            _rewrite_cache.set(search_query, search_query)

                # Sub-agents analyze up to 10 docs, so search top_n*2
                fetch_n = max(top_n * 2, 10)
                if progress: progress.start("search")
                results = search_via_electron(search_query, top_n=fetch_n)
                if results is None:
                    results = search_vault(search_query, vault_path, top_n=fetch_n)
                    self._log(f"[{_elapsed()}] [RAG] simple search ({len(results)} results)")
                else:
                    self._log(f"[{_elapsed()}] [RAG] Electron TF-IDF ({len(results)} results)")

                # If the query contains "latest/recent/this year" (Korean), boost by date
                # BM25 knows nothing about dates, so this lifts recent docs to the top even when their content is short
                _cur_year = str(datetime.now().year)
                _prev_year = str(datetime.now().year - 1)
                if results and any(w in query for w in ["최신", "최근", _cur_year]):
                    # The boost is applied directly to score. Sorting here would be pointless
                    # because apply_hotness_rerank below re-sorts by score and would undo it.
                    _boost_unit = 0.35 * (max((r.get("score", 0) for r in results), default=0.0) or 1.0)
                    _boosted = 0
                    for r in results:
                        d = r.get("date", "")
                        _b = 2 if _cur_year in d else (1 if _prev_year in d else 0)
                        r["_date_boost"] = _b
                        if _b:
                            r["score"] = r.get("score", 0) + _b * _boost_unit
                            _boosted += 1
                    self._log(f"[RAG] Recency request → date boost applied to {_boosted} scores")

                # ── Multi-query decomposition (Complex + len>25, LRU cache + diversity requirement + 1 retry) ──
                if claude and results and _complexity == 'complex' and len(query) > 25:
                    _sub_queries: list[str] = []
                    _decomp_cached = _decomp_cache.get(query)
                    if _decomp_cached is not None:
                        _sub_queries = list(_decomp_cached)
                        if _sub_queries:
                            self._log(f"[MultiQuery] Cache hit: {_sub_queries}")
                    else:
                        _decomp_sys = (
                            "Decompose the input question into 2 keyword sets from different perspectives, for search diversity.\n\n"
                            "Rules:\n"
                            "- Line 1: core noun phrase (the main keywords of the original)\n"
                            "- Line 2: one of synonym / hypernym / more specific term (a different word set)\n"
                            "- Each line 10 characters or fewer, nouns only, space-separated\n"
                            "- Lines 1 and 2 must not overlap at the word level\n"
                            "- No explanations, sentences, emoji, or markdown\n"
                            "- If it is a single topic and hard to decompose, return an empty response\n\n"
                            "Example:\n"
                            "INPUT: 캐릭터E 컨셉 디렉터 피드백 정리해봐\n"
                            "OUTPUT:\n"
                            "캐릭터E 컨셉 피드백\n"
                            "캐릭터 레퍼런스 방향성"
                        )
                        _decomp_user = f"INPUT: {query}\nOUTPUT:"
                        for _attempt in range(2):
                            try:
                                _sub_raw = claude.complete(_decomp_sys, _decomp_user, max_tokens=80).strip()
                                if _sub_raw.upper().startswith('OUTPUT:'):
                                    _sub_raw = _sub_raw[7:].strip()
                                _candidates = [
                                    qc.strip().strip('"\'').strip()
                                    for qc in _sub_raw.split("\n")
                                    if qc.strip()
                                ]
                                # Guard: validity + length + duplicate word ratio (>50% overlap is rejected)
                                _sub_queries = []
                                _seen_words: set[str] = set()
                                for _cand in _candidates:
                                    if not (1 < len(_cand) < 60 and _is_valid_search_query(_cand)):
                                        continue
                                    _words = set(_cand.split())
                                    if _seen_words and len(_words & _seen_words) / max(len(_words), 1) > 0.5:
                                        continue
                                    _sub_queries.append(_cand)
                                    _seen_words.update(_words)
                                    if len(_sub_queries) >= 2:
                                        break
                                if len(_sub_queries) >= 2:
                                    break
                            except Exception as _e:
                                self._log(f"[MultiQuery] Exception (attempt {_attempt+1}): {_e}")
                        _decomp_cache.set(query, _sub_queries)

                    # Common: if there are valid sub-queries, run the merge loop
                    if len(_sub_queries) >= 2:
                        self._log(f"[MultiQuery] Decomposed: {_sub_queries}")
                        _seen_stems = {r.get("stem") for r in results}
                        _zero_gain_rounds = 0
                        for _sq in _sub_queries:
                            _prev_count = len(_seen_stems)
                            try:
                                _sub_res = search_via_electron(_sq, top_n=5) or search_vault(_sq, vault_path, top_n=5)
                            except Exception as _e:
                                self._log(f"[MultiQuery] Sub-search failed (ignored): {_e}")
                                _sub_res = []
                            for _r in (_sub_res or []):
                                if _r.get("stem") not in _seen_stems:
                                    results.append(_r)
                                    _seen_stems.add(_r.get("stem"))
                            if len(_seen_stems) == _prev_count:
                                _zero_gain_rounds += 1
                                if _zero_gain_rounds >= 2:
                                    self._log("[MultiQuery] Convergence detected → early exit")
                                    break
                            else:
                                _zero_gain_rounds = 0
                        self._log(f"[MultiQuery] {len(results)} results after merge")

                # ── Graph expansion (Phase 3): add common wikilink neighbors of top docs ─
                # Runs before hot-score reranking so expanded docs also get hot score applied
                if results:
                    try:
                        results = expand_via_wikilinks(results, vault_path, top_consider=3, max_expand=2, log_fn=self._log)
                    except Exception as _e:
                        self._log(f"[GraphExpand] Failed (ignored): {_e}")

                # ── Hot-score reranking (based on OpenViking memory_lifecycle) ──
                # Re-sort with a bonus for frequently/recently referenced docs
                if results:
                    results = apply_hotness_rerank(results)
                    self._log(f"[{_elapsed()}] [HotScore] Reranking done (top: {results[0].get('title','')[:30]})")

                if progress: progress.done("search")

                # ── Read cost-control settings ───────────────────────────
                _cost_settings = get_electron_settings() or {}
                _self_review_enabled = _cost_settings.get("selfReview", True)
                _n_agents = int(_cost_settings.get("nAgents", 6))

                # ── Sub-agent document analysis ─────────────────────────
                if progress: progress.start("analyze")
                if claude and results:
                    rag_context = build_multi_agent_context(
                        claude, search_query, results, n_agents=_n_agents, log_fn=self._log
                    )
                else:
                    rag_context = build_rag_context(results, max_chars=12000)
                if progress: progress.done("analyze")

                # ── Web search: the AI decides whether it's needed ──────
                # Claude first decides whether a web search is needed (vault results insufficient or fresh info required)
                web_ctx = ""
                if progress: progress.start("webcheck")
                if claude:
                    decision_sys = 'Answer NO if the vault documents are enough to answer, YES if fresh external information is needed. Format: "NO" or "YES: <search terms>"'
                    decision_msg = (
                        f"Question: {search_query}\n\n"
                        f"Vault material (beginning):\n{rag_context[:600] if rag_context else '(none)'}\n\n"
                        "Web search needed:"
                    )
                    try:
                        decision = claude.complete(
                            decision_sys,
                            decision_msg,
                            max_tokens=30,
                        ).strip()
                        if decision.upper().startswith("YES"):
                            colon_idx = decision.find(":")
                            search_q = decision[colon_idx+1:].strip() if colon_idx >= 0 else query
                            self._log(f"[{_elapsed()}] [WebSearch] Searching \"{search_q}\"...")
                            if progress: progress.done("webcheck"); progress.start("websearch")
                            web_results = search_web(search_q or query, max_results=5)
                            if web_results:
                                web_ctx = build_web_context(web_results)
                                self._log(f"[{_elapsed()}] [WebSearch] Got {len(web_results)} results")
                            else:
                                self._log("[WebSearch] No results")
                        else:
                            self._log(f"[{_elapsed()}] [WebSearch] Vault info sufficient → skipping")
                            if progress: progress.done("webcheck")
                    except Exception as e:
                        self._log(f"[WebSearch decision] Error: {e} → skipping")
                        if progress: progress.done("webcheck")

                # ── 3. LLM generation ───────────────────────────────────────
                if progress:
                    if progress._current_key == "websearch":
                        progress.done("websearch")
                    progress.start("answer")
                if claude:
                    today_str = datetime.now().strftime("%Y-%m-%d (%a) %H:%M")
                    # Structured reasoning prompt (same as STRUCTURED_REASONING_PROMPT in llmClient.ts)
                    structured_reasoning = (
                        "\n\n[Structured reasoning] For analysis, comparison, design, and decision-making questions, answer in this structure:\n"
                        "**[Observation]** Key facts and data found in the retrieved documents\n"
                        "**[Connections]** Patterns across documents, causal links, contradictions, hidden relationships\n"
                        "**[Analysis]** Meaning, background context, and implications of the patterns found\n"
                        "**[Conclusion/Proposal]** Key insights and actionable next steps\n"
                        "For simple lookups, summaries, greetings, or fact checks, skip this structure and answer concisely."
                    )
                    combined = f"Current date/time: {today_str}\n\n" + persona["system"] + structured_reasoning
                    # Intent tag injection: request verbs like "organize/analyze/compare" were stripped for search,
                    # but they drive the final response style, so state them explicitly.
                    if intent_tag:
                        _intent_hints = {
                            '정리': 'The user wants the retrieved content **organized/summarized**. Remove duplicates and deliver only the essentials, structured.',
                            '분석': 'The user wants **analysis/interpretation**. Derive and deliver patterns, causes, and implications.',
                            '요약': 'The user wants a **short summary**. Essentials only, 5 sentences or fewer.',
                            '검토': 'The user wants a **review/evaluation**. State pros and cons, risks, and improvements explicitly.',
                            '설명': 'The user wants a **contextual explanation**. Structure as background → process → outcome.',
                            '비교': 'The user wants a **comparison**. Present subjects, criteria, and differences in a table or item by item.',
                            '제안': 'The user wants **actionable proposals**. Include rationale and priorities.',
                            '추천': 'The user wants **recommendations**. Include rationale and conditions for applying them.',
                            '작성': 'The user wants a **document written**. Use structure, headings, and lists.',
                            '소개': 'The user wants an **overview introduction**. Key features, uses, and examples.',
                            '추출': 'The user wants **specific items extracted**. Return as a list.',
                        }
                        combined += f"\n\n[User intent: {intent_tag}] {_intent_hints.get(intent_tag, '')}"
                    # Inject user memory
                    if user_id and _mem_store.get(user_id):
                        combined += f"\n\n---\n## 📌 Memory of previous conversations with this user\n{_mem_store.get(user_id)}\n---"
                    if rag_context:
                        combined += f"\n\n{rag_context}"
                    if web_ctx:
                        combined += f"\n\n{web_ctx}"
                    # Per-persona analysis frames
                    _PERSONA_ANALYSIS_FRAMES = {
                        "chief": (
                            "[PM analysis lens] ① Alignment with project direction and goals "
                            "② Feasibility in terms of resources, schedule, and priorities ③ Key risks and mitigations"
                        ),
                        "art": (
                            "[Art analysis lens] ① Impact on style, visual consistency, and tone & manner "
                            "② Visual messaging and emotional impact for players ③ Balance between technical feasibility and quality"
                        ),
                        "spec": (
                            "[Design analysis lens] ① Impact on balance, player experience, and fun factors "
                            "② Linkage and dependencies with existing systems ③ Intuitiveness and plausibility for users"
                        ),
                        "tech": (
                            "[Tech analysis lens] ① Impact on tech debt, performance, and scalability "
                            "② Implementation complexity and testability ③ Compatibility with the existing codebase"
                        ),
                    }
                    if tag in _PERSONA_ANALYSIS_FRAMES:
                        combined += f"\n\n{_PERSONA_ANALYSIS_FRAMES[tag]}"
                    combined += (
                        "\n\n[Answer guidelines]\n"
                        "• Thinking order: identify core intent → check document evidence → derive insights → clearly separate uncertain content\n"
                        "• When documents conflict: point it out explicitly and recommend checking the latest version\n"
                        "• Tone: always professional, formal polite Korean (hapnida/seupnida register)\n"
                        "• Stick to facts: base everything only on vault documents, web results, and what the user said. Mark unverified content explicitly as 'not confirmed in the retrieved documents'. Refer to sources as 'vault documents' or 'retrieved documents'."
                    )
                    try:
                        answer = claude.complete(combined, query, max_tokens=2000, cache_system=True)
                        # ── 2-pass self-review (toggled by the selfReview setting) ──
                        if _self_review_enabled:
                            _review_sys = (
                                "Review whether [ANSWER] sufficiently addresses [QUESTION].\n"
                                "If a key perspective is missing, add it under [SUPPLEMENT]. If sufficient, output only [FINAL ANSWER].\n"
                                "Format: [FINAL ANSWER]\\n(content)\\n\\n[SUPPLEMENT]\\n(content, omit if none)"
                            )
                            _reviewed = claude.complete(
                                _review_sys,
                                f"[QUESTION]\n{query}\n\n[ANSWER]\n{answer}",
                                max_tokens=2500,
                            ).strip()
                            if "[FINAL ANSWER]" in _reviewed:
                                _main = _reviewed.split("[FINAL ANSWER]", 1)[1]
                                _supplement = ""
                                if "[SUPPLEMENT]" in _main:
                                    _main, _supplement = _main.split("[SUPPLEMENT]", 1)
                                _main = _main.strip()
                                _supplement = _supplement.strip()
                                if _main:
                                    answer = _main
                                    if _supplement:
                                        answer += f"\n\n---\n*💡 Additional perspective*\n{_supplement}"
                                    self._log(f"[{_elapsed()}] [2-pass] Self-review applied")
                    except Exception as e:
                        _err_str = str(e)
                        if "529" in _err_str or "overloaded" in _err_str.lower():
                            answer = "❌ *Claude API is overloaded.* Please try again shortly."
                        elif "401" in _err_str or "authentication" in _err_str.lower():
                            answer = "❌ *Claude API key authentication failed.* Please check the API key in settings."
                        elif "402" in _err_str or "credit" in _err_str.lower() or "insufficient" in _err_str.lower():
                            answer = "❌ *Insufficient Claude API credits.* Please top up your balance."
                        elif "timeout" in _err_str.lower():
                            answer = "❌ *Response timed out.* Please shorten your question and try again."
                        else:
                            answer = f"❌ *An error occurred while generating the AI response.*\n_(Error code: {type(e).__name__})_\nPlease try again shortly."
                        self._log(f"[Claude] Response error: {e}")
                elif rag_context:
                    answer = (
                        "_(No Claude API key configured, so only the raw text is shown without AI analysis.)_\n\n"
                        + rag_context
                    )
                else:
                    answer = (
                        "_No related documents found in the vault._\n\n"
                        "• Try asking again with different keywords\n"
                        "• Check that vault sync has finished\n"
                        "• Use `!help` to see usage"
                    )

                if progress: progress.done("answer")
                # Record access to referenced docs → hot-score learning
                if results and not answer.startswith("❌"):
                    record_doc_access([r.get("stem", "") for r in results[:5]])
                sources = ""
                if results:
                    lines = []
                    for r in results[:3]:
                        display = r.get('title') or r.get('stem', '')
                        date_str = r.get('date', '')
                        snippet = (r.get('body') or '')[:80].replace('\n', ' ').strip()
                        snippet_str = f"\n  _↳ {snippet}..._" if snippet else ""
                        date_part = f"  _{date_str}_" if date_str else ""
                        lines.append(f"• `{display}`{date_part}{snippet_str}")
                    sources = "\n\n_───────────────────_\n📂 *Referenced documents*\n" + "\n".join(lines)
                final = f"{answer}{sources}"

            # ── 4. Post to Slack ────────────────────────────────────────────
            # Update history (keep at most 20 turns = 40 messages)
            # Do the read-modify-write inside a single lock. Using the history snapshot taken
            # at the start of processing would drop concurrent DM turns that completed in between.
            with _conv_history_lock:
                _stored = _conv_history.get(hist_key)
                _base = _stored if _stored is not None and len(_stored) >= len(history) else history
                updated_history = (list(_base) + [
                    {"role": "user", "content": query},
                    {"role": "assistant", "content": answer or ""},
                ])[-40:]
                _conv_history[hist_key] = updated_history
                # LRU: move the latest write to the newest position
                try:
                    _conv_history.move_to_end(hist_key)
                except AttributeError:
                    pass  # dict fallback
                # Evict old keys (prevents memory leak) — OrderedDict keeps the oldest at the front
                if len(_conv_history) > _MAX_HISTORY_KEYS:
                    for old_key in list(_conv_history)[:len(_conv_history) - _MAX_HISTORY_KEYS]:
                        del _conv_history[old_key]
            # Auto-update user memory (every 5 turns)
            if user_id:
                _mem_store.auto_update(user_id, updated_history, claude, api_key=api_key)

            # Markdown → Slack mrkdwn conversion
            from modules.slack_formatter import md_to_slack
            final = md_to_slack(final)

            self._log(f"[{_elapsed()}] [Done] Sent answer ({len(final)} chars)")

            ts = (thinking or {}).get("ts")
            _say_long(final, say, thread_ts, update_ts=ts, channel=channel)

            # Upload images (explicit search results first, otherwise auto-collected images)
            all_image_paths = vault_image_paths or auto_image_paths
            if all_image_paths and self.cfg.get("sendImages", True):
                _img_handler.upload_images_to_slack(all_image_paths, channel, thread_ts)

            # ── Report intent → async PDF generation + Slack upload ────────────
            if REPORT_INTENT_RE.search(query) and answer and not answer.startswith("❌"):
                def _async_report_pdf():
                    try:
                        title_m = _re.search(r'["\u300c\u300e\u201c](.+?)["\u300d\u300f\u201d]', query)
                        report_title = title_m.group(1) if title_m else (query[:40].strip() or "Report")
                        html_path = _generate_report_html(report_title, answer)
                        try:
                            import pdfkit as _pdfkit
                            _WKHTMLTOPDF = cfg.get("wkhtmltopdf_path", r"C:\Program Files (x86)\wkhtmltopdf\bin\wkhtmltopdf.exe")
                            pdf_path = html_path.with_suffix(".pdf")
                            _pdfkit.from_file(
                                str(html_path), str(pdf_path),
                                configuration=_pdfkit.configuration(wkhtmltopdf=_WKHTMLTOPDF),
                                options={"encoding": "UTF-8", "quiet": ""},
                            )
                            self._log(f"[Report] PDF conversion done: {pdf_path.name}")
                            upload_path = pdf_path
                        except Exception as _pdf_e:
                            self._log(f"[Report] PDF conversion failed ({type(_pdf_e).__name__}: {_pdf_e}) → uploading HTML")
                            upload_path = html_path
                        _upload_file_to_slack(upload_path, channel, thread_ts, title=f"📄 {report_title}")
                    except Exception as _e:
                        self._log(f"[Report] PDF generation failed: {_e}")
                threading.Thread(target=_async_report_pdf, daemon=True).start()

        self._register_handlers(
            app,
            respond_fn=respond,
            extract_slack_files=extract_slack_files,
            _conv_history=_conv_history,
            _conv_history_lock=_conv_history_lock,
            _mem_store=_mem_store,
            api_key=api_key,
            vault_path=vault_path,
            is_electron_alive=is_electron_alive,
            get_electron_settings=get_electron_settings,
            get_model_for_tag=get_model_for_tag,
        )

        self._handler = SocketModeHandler(app, app_token)
        _scheduler.set_handler(self._handler)

        def _notify_disconnect():
            """Send an 'updating' message to active channels when the bot shuts down."""
            with _active_channels_lock:
                _snapshot = list(_active_channels)
            for ch in _snapshot:
                try:
                    web.chat_postMessage(channel=ch, text="🔄 _The bot is being updated. Please try again shortly._")
                except Exception as e:
                    self._log(f"[disconnect] Failed to notify channel {ch}: {str(e)[:200]}")

        def _run():
            _RECONNECT_DELAYS = [5, 10, 20, 40, 60]  # seconds, increasing in order then fixed at 60s
            attempt = 0

            while self._running:
                try:
                    # Create a new SocketModeHandler on reconnect (the previous one is already dead)
                    self._handler = SocketModeHandler(app, app_token)
                    self._handler.connect()   # connect the WebSocket only, without registering signals
                    _scheduler.set_handler(self._handler)

                    # Background service threads — started on every connect
                    # (previous threads exit on their own once they detect is_connected() == False)
                    _scheduler.start_schedule_checker()
                    _scheduler.start_vault_tag_scanner()

                    if attempt > 0:
                        self._log("🟢 Slack reconnected")
                    attempt = 0  # reset retry counter on successful connect

                    while self._handler.client and self._handler.client.is_connected():
                        time.sleep(1)

                    if not self._running:
                        break  # normal shutdown via stop()

                    self._log("⚠️ Slack connection lost — waiting to reconnect...")

                except Exception as e:
                    if not self._running:
                        break
                    self._log(f"⚠️ Slack connection error: {e}")

                # If not an intentional shutdown, reconnect after exponential backoff
                delay = _RECONNECT_DELAYS[min(attempt, len(_RECONNECT_DELAYS) - 1)]
                attempt += 1
                self._log(f"🔄 Retrying connection in {delay}s... (#{attempt})")
                for _ in range(delay):
                    if not self._running:
                        break
                    time.sleep(1)

            _notify_disconnect()
            self._on_status(False)

        self._running = True
        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()
        self._log("🟢 Slack bot started — model: follows Strata Sync persona settings")
        return True

    def stop(self):
        self._running = False  # stop the reconnect loop
        if self._handler:
            try:
                self._handler.close()
            except Exception as e:
                self._log(f"[stop] handler.close() failed: {e}")
        self._handler = None
        self._log("🔴 Slack bot stopped")

    def _register_handlers(self, app, *, respond_fn, extract_slack_files,
                            _conv_history, _conv_history_lock, _mem_store,
                            api_key, vault_path,
                            is_electron_alive, get_electron_settings,
                            get_model_for_tag) -> None:
        """Register Slack event/command/shortcut/modal handlers."""

        @app.event("app_home_opened")
        def handle_home(event, client, logger):
            user_id = event.get("user")
            try:
                client.views_publish(
                    user_id=user_id,
                    view={
                        "type": "home",
                        "blocks": [
                            {
                                "type": "header",
                                "text": {"type": "plain_text", "text": "🗺️  Strata Sync Bot", "emoji": True},
                            },
                            {
                                "type": "section",
                                "text": {
                                    "type": "mrkdwn",
                                    "text": "A vault-based RAG assistant.\nMention *@Sandbox* in a channel, or ask directly in the *Messages tab*.",
                                },
                            },
                            {"type": "divider"},
                            {
                                "type": "section",
                                "fields": [
                                    {
                                        "type": "mrkdwn",
                                        "text": "*💬  Ask a question*\n`question` — Chief Director answers\n`[art] question` — pick a persona\nAttach an image — Vision analysis supported",
                                    },
                                    {
                                        "type": "mrkdwn",
                                        "text": "*⌨️  Commands*\n`/ask question`\n`/remember`\n`/status`\n`/help`",
                                    },
                                ],
                            },
                            {"type": "divider"},
                            {
                                "type": "context",
                                "elements": [
                                    {"type": "mrkdwn", "text": "*Persona tags*  `[chief]`  `[art]`  `[spec]`  `[tech]`   •   ⚡ ask from anywhere with the `ask_sandbox` shortcut"},
                                ],
                            },
                        ],
                    },
                )
            except Exception as e:
                logger.error(f"[Home] views.publish failed: {e}")

        @app.event("app_mention")
        def handle_mention(event, say, logger):
            files = extract_slack_files(event)
            logger.debug(f"[mention] subtype={event.get('subtype')!r} files={bool(files)} text={event.get('text','')[:40]!r}")
            respond_fn(
                text=event.get("text", ""),
                say=say,
                channel=event["channel"],
                thread_ts=event.get("thread_ts") or event.get("ts"),
                files=files,
                user_id=event.get("user"),
            )

        @app.event("message")
        def handle_dm(event, say, logger):
            # Only handle DMs (im) or group DMs (mpim); ignore the bot's own messages
            if event.get("channel_type") not in ("im", "mpim"):
                return
            subtype = event.get("subtype")
            if event.get("bot_id") or (subtype and subtype != "file_share"):
                return
            files = extract_slack_files(event)
            logger.debug(f"[dm] subtype={subtype!r} files={bool(files)} text={event.get('text','')[:40]!r}")
            respond_fn(
                text=event.get("text", ""),
                say=say,
                channel=event["channel"],
                thread_ts=None,  # DMs are answered directly, without a thread
                files=files,
                user_id=event.get("user"),
            )

        # ── Slash commands ──────────────────────────────────────────────────
        HELP_BLOCKS = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": "🗺️  Strata Sync Bot usage", "emoji": True},
            },
            {
                "type": "section",
                "fields": [
                    {
                        "type": "mrkdwn",
                        "text": "*Channel mention*\n`@Sandbox question` — answers in a thread\n`@Sandbox [art] question` — pick a persona",
                    },
                    {
                        "type": "mrkdwn",
                        "text": "*DM / Messages tab*\nType directly — Chief Director answers\nAttach an image — Vision analysis supported",
                    },
                ],
            },
            {"type": "divider"},
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        "*⌨️  Slash commands*\n"
                        "`/ask question`  — RAG-based answer\n"
                        "`/remember`  — save the conversation to memory\n"
                        "`/status`  — bot status and vault info\n"
                        "`/help`  — this help\n\n"
                        "*⚡  Global shortcut*\n"
                        "`ask_sandbox`  — ask via popup from any channel"
                    ),
                },
            },
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": "*Persona tags*  `[chief]`  `[art]`  `[spec]`  `[tech]`"}],
            },
        ]
        HELP_TEXT = "*🗺️ Strata Sync Bot usage*\n`/ask question`  `/remember`  `/status`  `/help`"

        @app.command("/help")
        def handle_slash_help(ack, respond, logger):
            ack()
            try:
                respond(blocks=HELP_BLOCKS, text=HELP_TEXT)
            except Exception as e:
                logger.error(f"[/help] Response failed: {e}")

        @app.command("/ask")
        def handle_slash_ask(ack, respond, command, logger):
            ack()
            text = command.get("text", "").strip()
            if not text:
                respond(text="Please enter a question.\nUsage: `/ask your question`")
                return
            user_id = command.get("user_id")
            channel_id = command.get("channel_id")
            try:
                # respond() is ephemeral, so notify that it's processing and send the actual answer via say
                respond(text=f"Processing _{text}_…")
                def _async_ask():
                    class _FakeSay:
                        def __call__(self, text="", blocks=None, thread_ts=None, **kw):
                            try:
                                kargs = {"channel": channel_id, "text": text}
                                if blocks:
                                    kargs["blocks"] = blocks
                                if thread_ts:
                                    kargs["thread_ts"] = thread_ts
                                app.client.chat_postMessage(**kargs)
                            except Exception as _e:
                                logger.error(f"[/ask say] {_e}")
                    respond_fn(
                        text=text,
                        say=_FakeSay(),
                        channel=channel_id,
                        thread_ts=None,
                        files=[],
                        user_id=user_id,
                    )
                threading.Thread(target=_async_ask, daemon=True).start()
            except Exception as e:
                logger.error(f"[/ask] Processing failed: {e}")
                respond(text=f"An error occurred while processing: {e}")

        @app.command("/remember")
        def handle_slash_remember(ack, respond, command, logger):
            """Save the current DM/thread conversation to user memory."""
            ack()
            user_id = command.get("user_id")
            channel_id = command.get("channel_id")
            hist_key = f"{channel_id}:dm"
            with _conv_history_lock:
                history = list(_conv_history.get(hist_key, []))
            if len(history) < 4:
                respond(text="💭 Not enough conversation to save yet. Ask a few questions first!")
                return
            try:
                respond(text="💭 Saving the conversation to memory...")
                live_key = get_anthropic_key(self.cfg) or api_key
                if not live_key:
                    respond(text="❌ No API key configured, so memory cannot be saved.")
                    return
                model = get_model_for_tag("chief")
                claude_mem = ClaudeClient(live_key, model)
                existing = _mem_store.get(user_id)
                hist_text = "\n".join(
                    f"{'👤' if m['role'] == 'user' else '🤖'} {m['content'][:200]}"
                    for m in history[-10:]
                )
                summary_prompt = "Summarize the conversation below in 300 characters or fewer, focusing on key decisions, agreements, and important context. Output only the summary."
                if existing:
                    summary_prompt += f"\n\nExisting memory:\n{existing}"
                summary = claude_mem.complete(summary_prompt, f"Conversation:\n{hist_text}", max_tokens=400).strip()
                if summary:
                    _mem_store.update(user_id, summary)
                    _mem_store.save()
                    respond(text=f"✅ *Conversation remembered!*\n\n_{summary}_")
                else:
                    respond(text="⚠️ Failed to create memory. Please try again shortly.")
            except Exception as e:
                logger.error(f"[/remember] Failed: {e}")
                respond(text=f"❌ Error while saving memory: {e}")

        @app.command("/propose")
        def handle_slash_propose(ack, respond, command, logger):
            """/propose <title> | <body> — record a proposal in the vault's _agent/ folder."""
            ack()
            text = (command.get("text") or "").strip()
            if "|" in text:
                title, body = [part.strip() for part in text.split("|", 1)]
            else:
                title, body = text[:60].strip(), text
            if not title or not body:
                respond(text="Usage: `/propose <title> | <body>` — records a proposal the team can promote in Strata Sync.")
                return
            user_name = command.get("user_name") or command.get("user_id") or "slack"
            try:
                result = propose_via_electron(title, body, source=f"slack:{user_name}")
            except Exception as e:  # HTTP error with detail
                respond(text=f"❌ Could not record the proposal: {e}")
                return
            if not result or not result.get("ok"):
                respond(text="❌ Strata Sync is not running, so the proposal could not be recorded.")
                return
            respond(text=f"📝 Proposal recorded as `{result.get('path')}` — promote it in Strata Sync when you agree with it.")

        @app.command("/status")
        def handle_slash_status(ack, respond, logger):
            """Show bot status and vault info."""
            ack()
            try:
                electron_str = "🟢 Online" if is_electron_alive() else "🔴 Offline"
                settings_data = get_electron_settings() or {}
                chief_model = settings_data.get("personaModels", {}).get("chief_director", "—")
                vault_name = Path(vault_path).name if vault_path else "—"
                doc_count = "—"
                try:
                    doc_count = str(len(scan_vault(vault_path)))
                except Exception as e:
                    self._log(f"[/status] Vault scan failed: {e}")
                with _conv_history_lock:
                    active_threads = len(_conv_history)
                mem_users = len(_mem_store)
                respond(
                    blocks=[
                        {
                            "type": "header",
                            "text": {"type": "plain_text", "text": "🗺️  Strata Sync Bot status", "emoji": True},
                        },
                        {
                            "type": "section",
                            "fields": [
                                {"type": "mrkdwn", "text": f"*App connection*\n{electron_str}"},
                                {"type": "mrkdwn", "text": f"*AI model*\n`{chief_model}`"},
                                {"type": "mrkdwn", "text": f"*Vault*\n`{vault_name}`  _{doc_count} documents_"},
                                {"type": "mrkdwn", "text": f"*Active conversations*\n{active_threads} threads"},
                            ],
                        },
                        {
                            "type": "context",
                            "elements": [{"type": "mrkdwn", "text": f"Memory saved for {mem_users} users"}],
                        },
                    ],
                    text=f"App: {electron_str} | Vault: {vault_name} ({doc_count} documents) | Model: {chief_model}",
                )
            except Exception as e:
                logger.error(f"[/status] Failed: {e}")
                respond(text=f"❌ Error while fetching status: {e}")

        # ── Global shortcut ────────────────────────────────────────────────
        # Must be registered with callback_id "ask_sandbox" under Slack app settings > Interactivity & Shortcuts
        @app.shortcut("ask_sandbox")
        def handle_shortcut_ask(ack, shortcut, client, logger):
            """⚡ Global shortcut — modal popup for asking the bot from any channel."""
            ack()
            try:
                client.views_open(
                    trigger_id=shortcut["trigger_id"],
                    view={
                        "type": "modal",
                        "callback_id": "sandbox_ask_modal",
                        "title": {"type": "plain_text", "text": "Ask Strata Sync"},
                        "submit": {"type": "plain_text", "text": "Ask"},
                        "close":  {"type": "plain_text", "text": "Cancel"},
                        "blocks": [
                            {
                                "type": "input",
                                "block_id": "persona_block",
                                "optional": True,
                                "label": {"type": "plain_text", "text": "Persona"},
                                "element": {
                                    "type": "static_select",
                                    "action_id": "persona_select",
                                    "placeholder": {"type": "plain_text", "text": "Select (default: Chief PM)"},
                                    "initial_option": {"text": {"type": "plain_text", "text": "🎯 Chief (PM)"}, "value": "chief"},
                                    "options": [
                                        {"text": {"type": "plain_text", "text": "🎯 Chief (PM)"},       "value": "chief"},
                                        {"text": {"type": "plain_text", "text": "🎨 Art Director"},     "value": "art"},
                                        {"text": {"type": "plain_text", "text": "📋 Game Designer"},           "value": "spec"},
                                        {"text": {"type": "plain_text", "text": "💻 Tech Director"},     "value": "tech"},
                                    ],
                                },
                            },
                            {
                                "type": "input",
                                "block_id": "question_block",
                                "label": {"type": "plain_text", "text": "Question"},
                                "element": {
                                    "type": "plain_text_input",
                                    "action_id": "question_input",
                                    "multiline": True,
                                    "placeholder": {"type": "plain_text", "text": "Enter your question…"},
                                },
                            },
                        ],
                    },
                )
            except Exception as e:
                logger.error(f"[shortcut/ask_sandbox] views_open failed: {e}")

        @app.view("sandbox_ask_modal")
        def handle_modal_submit(ack, body, client, logger):
            """Modal submit → handle the question via the DM channel."""
            ack()
            values  = body["view"]["state"]["values"]
            user_id = body["user"]["id"]
            persona_opt = (
                values.get("persona_block", {})
                      .get("persona_select", {})
                      .get("selected_option") or {}
            )
            persona_val = persona_opt.get("value", "chief")
            question = (
                values.get("question_block", {})
                      .get("question_input", {})
                      .get("value", "")
                      .strip()
            )
            if not question:
                return
            tag_map = {"chief": "[감독]", "art": "[아트]", "spec": "[기획]", "tech": "[기술]"}
            full_text = f"{tag_map.get(persona_val, '')} {question}".strip()
            try:
                dm_resp    = client.conversations_open(users=user_id)
                dm_channel = dm_resp["channel"]["id"]

                class _FakeSay:
                    def __call__(self_, text="", blocks=None, thread_ts=None, **kw):  # noqa: N805
                        try:
                            kargs: dict = {"channel": dm_channel, "text": text}
                            if blocks:    kargs["blocks"]    = blocks
                            if thread_ts: kargs["thread_ts"] = thread_ts
                            app.client.chat_postMessage(**kargs)
                        except Exception as _e:
                            logger.error(f"[modal/say] {_e}")

                threading.Thread(
                    target=respond_fn,
                    kwargs=dict(text=full_text, say=_FakeSay(), channel=dm_channel,
                                thread_ts=None, files=[], user_id=user_id),
                    daemon=True,
                ).start()
            except Exception as e:
                logger.error(f"[modal/submit] Processing failed: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Tkinter GUI
# ─────────────────────────────────────────────────────────────────────────────

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Strata Sync Source Management Bot")
        self.geometry("720x640")
        self.resizable(True, True)
        self.cfg = load_config()
        self.bot: VaultBot | None = None
        self.timer_running = False
        self._next_run_time: datetime | None = None
        self._slack_runner: SlackBotRunner | None = None
        self._build_ui()
        self._load_cfg_to_ui()
        self._tick()  # timer countdown update

    # ── UI build ─────────────────────────────────────────────────────────────

    def _build_ui(self):
        pad = {"padx": 8, "pady": 4}

        # ── Top: settings panel ─────────────────────────────────────────────
        frame_cfg = ttk.LabelFrame(self, text="Settings", padding=8)
        frame_cfg.pack(fill="x", padx=10, pady=(10, 4))

        # Vault path
        ttk.Label(frame_cfg, text="Vault path:").grid(row=0, column=0, sticky="w", **pad)
        self.var_vault = tk.StringVar()
        ttk.Entry(frame_cfg, textvariable=self.var_vault, width=52).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(frame_cfg, text="Browse", command=self._browse_vault, width=6).grid(row=0, column=2, padx=4)

        # API Key
        ttk.Label(frame_cfg, text="Claude API Key:").grid(row=1, column=0, sticky="w", **pad)
        self.var_key = tk.StringVar()
        ttk.Entry(frame_cfg, textvariable=self.var_key, show="*", width=52).grid(row=1, column=1, sticky="ew", padx=4)

        # Run interval
        ttk.Label(frame_cfg, text="Run interval:").grid(row=2, column=0, sticky="w", **pad)
        interval_frame = ttk.Frame(frame_cfg)
        interval_frame.grid(row=2, column=1, sticky="w")
        self.var_interval = tk.IntVar(value=1)
        for label, val in [("1 hour", 1), ("5 hours", 5), ("Manual", 0)]:
            ttk.Radiobutton(
                interval_frame, text=label, variable=self.var_interval, value=val
            ).pack(side="left", padx=6)

        ttk.Button(frame_cfg, text="Save", command=self._save_cfg, width=6).grid(row=2, column=2, padx=4)
        frame_cfg.columnconfigure(1, weight=1)

        # ── Middle: run controls ────────────────────────────────────────────
        frame_ctrl = ttk.Frame(self)
        frame_ctrl.pack(fill="x", padx=10, pady=4)

        self.btn_run = ttk.Button(frame_ctrl, text="▶ Run now", command=self._run_now, width=14)
        self.btn_run.pack(side="left", padx=4)

        self.btn_timer = ttk.Button(frame_ctrl, text="⏱ Start timer", command=self._toggle_timer, width=14)
        self.btn_timer.pack(side="left", padx=4)

        self.lbl_status = ttk.Label(frame_ctrl, text="Status: idle", foreground="gray")
        self.lbl_status.pack(side="left", padx=12)

        self.lbl_next = ttk.Label(frame_ctrl, text="", foreground="steelblue")
        self.lbl_next.pack(side="right", padx=8)

        # ── Tabs: log / keywords ────────────────────────────────────────────
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True, padx=10, pady=(4, 10))

        # Log tab
        tab_log = ttk.Frame(self.notebook)
        self.notebook.add(tab_log, text="📋 Run log")
        self.txt_log = scrolledtext.ScrolledText(tab_log, wrap="word", state="disabled",
                                                  font=("Consolas", 9), bg="#1e1e1e", fg="#d4d4d4")
        self.txt_log.pack(fill="both", expand=True)
        btn_clear = ttk.Button(tab_log, text="Clear log", command=self._clear_log)
        btn_clear.pack(anchor="e", padx=4, pady=2)

        # Keyword tab
        tab_kw = ttk.Frame(self.notebook)
        self.notebook.add(tab_kw, text="🔑 Keyword index")

        kw_top = ttk.Frame(tab_kw)
        kw_top.pack(fill="x", padx=4, pady=4)
        self.lbl_kw_count = ttk.Label(kw_top, text="Keywords: 0")
        self.lbl_kw_count.pack(side="left")
        ttk.Button(kw_top, text="Refresh", command=self._refresh_keywords).pack(side="left", padx=8)
        ttk.Button(kw_top, text="+ Add keyword", command=self._add_keyword_dialog).pack(side="left", padx=4)

        cols = ("keyword", "hub_stem", "display", "added", "hits")
        self.kw_tree = ttk.Treeview(tab_kw, columns=cols, show="headings", height=16)
        for col, label, width in [
            ("keyword", "Keyword", 120),
            ("hub_stem", "Hub document stem", 280),
            ("display", "Display name", 100),
            ("added", "Added", 90),
            ("hits", "Hits", 50),
        ]:
            self.kw_tree.heading(col, text=label)
            self.kw_tree.column(col, width=width, minwidth=40)
        self.kw_tree.pack(fill="both", expand=True, padx=4, pady=4)

        kw_scroll = ttk.Scrollbar(tab_kw, orient="vertical", command=self.kw_tree.yview)
        self.kw_tree.configure(yscrollcommand=kw_scroll.set)
        kw_scroll.pack(side="right", fill="y")

        # Right-click menu
        self.kw_menu = tk.Menu(self, tearoff=0)
        self.kw_menu.add_command(label="Delete", command=self._delete_keyword)
        self.kw_tree.bind("<Button-3>", self._show_kw_menu)

        # ── Index file tab ───────────────────────────────────────────────────
        tab_idx = ttk.Frame(self.notebook)
        self.notebook.add(tab_idx, text="📄 Index files")

        idx_top = ttk.Frame(tab_idx)
        idx_top.pack(fill="x", padx=6, pady=4)
        self.lbl_idx_count = ttk.Label(idx_top, text="Index files: 0")
        self.lbl_idx_count.pack(side="left")
        ttk.Button(idx_top, text="Refresh", command=self._refresh_index_list).pack(side="left", padx=8)

        idx_pane = tk.PanedWindow(tab_idx, orient="horizontal", sashwidth=5, relief="flat")
        idx_pane.pack(fill="both", expand=True, padx=6, pady=(0, 6))

        # Left: file list
        list_frame = ttk.Frame(idx_pane)
        self.idx_listbox = tk.Listbox(list_frame, width=30, selectmode="single",
                                      font=("Consolas", 9), bg="#1e1e1e", fg="#d4d4d4",
                                      selectbackground="#264f78", activestyle="none")
        self.idx_listbox.pack(fill="both", expand=True, side="left")
        lbscroll = ttk.Scrollbar(list_frame, orient="vertical", command=self.idx_listbox.yview)
        self.idx_listbox.configure(yscrollcommand=lbscroll.set)
        lbscroll.pack(side="right", fill="y")
        self.idx_listbox.bind("<<ListboxSelect>>", self._on_index_select)
        idx_pane.add(list_frame, minsize=160)

        # Right: file content
        content_frame = ttk.Frame(idx_pane)
        self.idx_content = scrolledtext.ScrolledText(
            content_frame, wrap="word", state="disabled",
            font=("Consolas", 9), bg="#1e1e1e", fg="#d4d4d4")
        self.idx_content.pack(fill="both", expand=True)
        idx_pane.add(content_frame, minsize=300)

        # Stores file paths
        self._idx_paths: list[str] = []

        # ── Slack bot tab ───────────────────────────────────────────────────
        tab_slack = ttk.Frame(self.notebook)
        self.notebook.add(tab_slack, text="💬 Slack bot")

        # Settings area
        slack_cfg = ttk.LabelFrame(tab_slack, text="Slack settings", padding=8)
        slack_cfg.pack(fill="x", padx=8, pady=(8, 4))

        def slack_row(row, label, var, show=""):
            ttk.Label(slack_cfg, text=label).grid(row=row, column=0, sticky="w", padx=6, pady=3)
            e = ttk.Entry(slack_cfg, textvariable=var, show=show, width=50)
            e.grid(row=row, column=1, sticky="ew", padx=4)

        self.var_slack_bot_token    = tk.StringVar()
        self.var_slack_app_token    = tk.StringVar()
        self.var_slack_top_n        = tk.IntVar(value=5)
        self.var_slack_notify_ch    = tk.StringVar()
        self.var_wkhtmltopdf_path   = tk.StringVar()

        slack_row(0, "Bot Token (xoxb-...):  ", self.var_slack_bot_token, show="*")
        slack_row(1, "App Token (xapp-...):  ", self.var_slack_app_token, show="*")

        ttk.Label(slack_cfg, text="RAG top-N:").grid(row=2, column=0, sticky="w", padx=6, pady=3)
        ttk.Spinbox(slack_cfg, textvariable=self.var_slack_top_n,
                    from_=1, to=20, width=5).grid(row=2, column=1, sticky="w", padx=4)
        ttk.Label(slack_cfg, text="Notification channel (schedule/tags):").grid(row=3, column=0, sticky="w", padx=6, pady=3)
        ttk.Entry(slack_cfg, textvariable=self.var_slack_notify_ch, width=22).grid(
            row=3, column=1, sticky="ew", padx=4)
        ttk.Label(slack_cfg, text="e.g. #general or C0123ABCD",
                  foreground="gray").grid(row=4, column=0, columnspan=2, sticky="w", padx=6)
        ttk.Label(slack_cfg, text="wkhtmltopdf path:").grid(row=5, column=0, sticky="w", padx=6, pady=3)
        ttk.Entry(slack_cfg, textvariable=self.var_wkhtmltopdf_path, width=50).grid(
            row=5, column=1, sticky="ew", padx=4)
        slack_cfg.columnconfigure(1, weight=1)

        # Save button
        ttk.Button(slack_cfg, text="Save", command=self._save_cfg, width=6).grid(
            row=3, column=1, sticky="e", padx=4)

        # Control area
        slack_ctrl = ttk.Frame(tab_slack)
        slack_ctrl.pack(fill="x", padx=8, pady=4)

        self.btn_slack = ttk.Button(slack_ctrl, text="▶ Start Slack bot",
                                     command=self._toggle_slack, width=16)
        self.btn_slack.pack(side="left", padx=4)

        self.lbl_slack_status = ttk.Label(slack_ctrl, text="Status: stopped", foreground="gray")
        self.lbl_slack_status.pack(side="left", padx=10)

        # Slack-only log
        self.txt_slack_log = scrolledtext.ScrolledText(
            tab_slack, wrap="word", state="disabled",
            font=("Consolas", 9), bg="#0d1117", fg="#7ee787", height=16)
        self.txt_slack_log.pack(fill="both", expand=True, padx=8, pady=(0, 4))
        ttk.Button(tab_slack, text="Clear log",
                   command=self._clear_slack_log).pack(anchor="e", padx=8, pady=2)

        # ── Multi-vault tab ─────────────────────────────────────────────────
        tab_multi = ttk.Frame(self.notebook)
        self.notebook.add(tab_multi, text="🗂️ Multi-vault bots")

        mv_desc = ttk.LabelFrame(tab_multi, text="Per-vault Slack bot instances", padding=8)
        mv_desc.pack(fill="x", padx=8, pady=(8, 4))
        ttk.Label(
            mv_desc,
            text=(
                "Create a separate config file per vault and run each bot independently with the command below.\n"
                "e.g.  python bot.py --headless --config config_vault2.json"
            ),
            justify="left", foreground="#555",
        ).pack(anchor="w", padx=4, pady=4)

        mv_frame = ttk.LabelFrame(tab_multi, text="Instance config files", padding=8)
        mv_frame.pack(fill="both", expand=True, padx=8, pady=4)

        mv_top = ttk.Frame(mv_frame)
        mv_top.pack(fill="x", pady=(0, 4))
        ttk.Button(mv_top, text="Create new instance config", command=self._mv_create_config).pack(side="left", padx=4)
        ttk.Button(mv_top, text="Refresh", command=self._mv_refresh).pack(side="left", padx=4)
        ttk.Button(mv_top, text="Open selected file", command=self._mv_open_config).pack(side="left", padx=4)

        self.mv_listbox = tk.Listbox(mv_frame, height=8, font=("Consolas", 9),
                                     bg="#1e1e1e", fg="#d4d4d4",
                                     selectbackground="#264f78", activestyle="none")
        self.mv_listbox.pack(fill="both", expand=True, padx=4, pady=4)

        mv_cmd_frame = ttk.LabelFrame(tab_multi, text="Run command", padding=8)
        mv_cmd_frame.pack(fill="x", padx=8, pady=(0, 8))
        self.mv_cmd_var = tk.StringVar()
        mv_cmd_entry = ttk.Entry(mv_cmd_frame, textvariable=self.mv_cmd_var, state="readonly", width=70)
        mv_cmd_entry.pack(fill="x", padx=4, pady=4)
        ttk.Button(mv_cmd_frame, text="Copy to clipboard", command=self._mv_copy_cmd).pack(anchor="e", padx=4, pady=2)
        self.mv_listbox.bind("<<ListboxSelect>>", self._mv_on_select)

        self._mv_refresh()

    def _mv_refresh(self):
        """Refresh the list of config_*.json files in the bot folder."""
        self.mv_listbox.delete(0, "end")
        bot_dir = Path(__file__).parent
        configs = sorted(bot_dir.glob("config*.json"))
        for c in configs:
            self.mv_listbox.insert("end", c.name)

    def _mv_on_select(self, _event=None):
        sel = self.mv_listbox.curselection()
        if not sel:
            return
        name = self.mv_listbox.get(sel[0])
        bot_dir = Path(__file__).parent
        cmd = f"python \"{bot_dir / 'bot.py'}\" --headless --config \"{bot_dir / name}\""
        self.mv_cmd_var.set(cmd)

    def _mv_copy_cmd(self):
        cmd = self.mv_cmd_var.get()
        if cmd:
            self.clipboard_clear()
            self.clipboard_append(cmd)
            messagebox.showinfo("Copied", "Command copied to clipboard.")

    def _mv_create_config(self):
        """Create a new config file based on the current settings."""
        from tkinter.simpledialog import askstring
        name = askstring("New instance", "New config file name (e.g. config_vault2.json):", parent=self)
        if not name:
            return
        if not name.endswith(".json"):
            name += ".json"
        bot_dir = Path(__file__).parent
        dest = bot_dir / name
        if dest.exists():
            if not messagebox.askyesno("Overwrite", f"{name} already exists. Overwrite it?"):
                return
        import copy
        new_cfg = copy.deepcopy(self.cfg)
        dest.write_text(json.dumps(new_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        self._log(f"💾 Created new instance config: {name}")
        self._mv_refresh()

    def _mv_open_config(self):
        sel = self.mv_listbox.curselection()
        if not sel:
            messagebox.showinfo("Notice", "Select a file from the list.")
            return
        name = self.mv_listbox.get(sel[0])
        bot_dir = Path(__file__).parent
        path = bot_dir / name
        try:
            os.startfile(str(path))
        except Exception as e:
            messagebox.showerror("Error", f"Failed to open file: {e}")

    # ── Config UI binding ────────────────────────────────────────────────────

    def _load_cfg_to_ui(self):
        self.var_vault.set(self.cfg.get("vault_path", ""))
        self.var_key.set(self.cfg.get("claude_api_key", ""))
        self.var_interval.set(self.cfg.get("interval_hours", 1))
        self.var_slack_bot_token.set(self.cfg.get("slack_bot_token", ""))
        self.var_slack_app_token.set(self.cfg.get("slack_app_token", ""))
        self.var_slack_top_n.set(self.cfg.get("slack_rag_top_n", 5))
        self.var_slack_notify_ch.set(self.cfg.get("slack_notify_channel", ""))
        self.var_wkhtmltopdf_path.set(self.cfg.get("wkhtmltopdf_path", r"C:\Program Files (x86)\wkhtmltopdf\bin\wkhtmltopdf.exe"))
        self.after(100, self._refresh_index_list)  # load index list after UI init

    def _save_cfg(self):
        self.cfg["vault_path"]       = self.var_vault.get().strip()
        self.cfg["claude_api_key"]   = self.var_key.get().strip()
        self.cfg["interval_hours"]   = self.var_interval.get()
        self.cfg["slack_bot_token"]      = self.var_slack_bot_token.get().strip()
        self.cfg["slack_app_token"]      = self.var_slack_app_token.get().strip()
        self.cfg["slack_rag_top_n"]      = self.var_slack_top_n.get()
        self.cfg["slack_notify_channel"] = self.var_slack_notify_ch.get().strip()
        self.cfg["wkhtmltopdf_path"]     = self.var_wkhtmltopdf_path.get().strip()
        save_config(self.cfg)
        self._log("💾 Settings saved")

    def _browse_vault(self):
        folder = filedialog.askdirectory(title="Select vault folder")
        if folder:
            self.var_vault.set(folder)

    # ── Log ─────────────────────────────────────────────────────────────────

    def _log_threadsafe(self, msg: str):
        """Safe to call from background threads — delegates to the main thread via after()."""
        self.after(0, lambda m=msg: self._log_direct(m))

    def _log_direct(self, msg: str):
        """Main thread only. Modifies Tkinter widgets directly."""
        self.txt_log.configure(state="normal")
        ts = datetime.now().strftime("%H:%M:%S")
        self.txt_log.insert("end", f"[{ts}] {msg}\n")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    def _log(self, msg: str):
        """Called from the main thread (button clicks, saving settings, etc.)."""
        self._log_direct(msg)

    def _clear_log(self):
        self.txt_log.configure(state="normal")
        self.txt_log.delete("1.0", "end")
        self.txt_log.configure(state="disabled")

    # ── Run controls ─────────────────────────────────────────────────────────

    def _make_bot(self) -> VaultBot:
        self._save_cfg()
        return VaultBot(self.cfg, log_fn=self._log_threadsafe, on_done_fn=self._on_cycle_done)

    def _set_running(self, running: bool):
        self.lbl_status.config(
            text="Status: running..." if running else "Status: idle",
            foreground="orange" if running else "gray",
        )
        self.btn_run.config(state="disabled" if running else "normal")

    def _run_now(self):
        self._set_running(True)
        bot = self._make_bot()
        bot.run_once()

    def _on_cycle_done(self):
        """Called from a background thread — all UI work is delegated via after()."""
        def _main():
            self._set_running(False)
            self._refresh_keywords()
            self._refresh_index_list()
            if self.timer_running and self.cfg["interval_hours"] > 0:
                h = self.cfg["interval_hours"]
                self._next_run_time = datetime.now() + timedelta(hours=h)
        self.after(0, _main)

    def _toggle_timer(self):
        if self.timer_running:
            # Stop timer
            if self.bot:
                self.bot.stop_timer()
            self.timer_running = False
            self._next_run_time = None
            self.btn_timer.config(text="⏱ Start timer")
            self.lbl_status.config(text="Status: idle", foreground="gray")
            self._log("⏹ Timer stopped")
        else:
            h = self.var_interval.get()
            if h == 0:
                messagebox.showinfo("Notice", "The timer cannot be used in manual mode.")
                return
            self.bot = self._make_bot()
            self.bot.start_timer(h)
            self.timer_running = True
            self._next_run_time = datetime.now() + timedelta(hours=h)
            self.btn_timer.config(text="⏹ Stop timer")
            self.lbl_status.config(text=f"Status: timer running ({h}h)", foreground="green")
            self._log(f"⏱ Timer started — every {h} hour(s)")

    def _tick(self):
        """Update the countdown every second"""
        if self._next_run_time:
            remaining = self._next_run_time - datetime.now()
            if remaining.total_seconds() > 0:
                h, rem = divmod(int(remaining.total_seconds()), 3600)
                m, s = divmod(rem, 60)
                self.lbl_next.config(text=f"Next run in {h:02d}:{m:02d}:{s:02d}")
            else:
                self.lbl_next.config(text="")
        else:
            self.lbl_next.config(text="")
        self.after(1000, self._tick)

    # ── Keyword tab ──────────────────────────────────────────────────────────

    def _refresh_keywords(self):
        vault = self.var_vault.get().strip()
        if not vault:
            return
        store = KeywordStore(vault, self.cfg.get("keyword_index_path", KEYWORD_INDEX_REL_PATH))
        try:
            store.load()
        except KeywordStoreError as e:
            self.lbl_kw_count.config(text="Keywords: load failed")
            self._log(f"❌ Keyword index load failed: {e}")
            return
        kws = store.get_keywords()
        self.lbl_kw_count.config(text=f"Keywords: {len(kws)}")

        # Refresh treeview
        for row in self.kw_tree.get_children():
            self.kw_tree.delete(row)
        for kw, info in sorted(kws.items()):
            self.kw_tree.insert("", "end", values=(
                kw,
                info.get("hub_stem", ""),
                info.get("display", kw),
                info.get("added", ""),
                info.get("hit_count", 0),
            ))

    def _show_kw_menu(self, event):
        item = self.kw_tree.identify_row(event.y)
        if item:
            self.kw_tree.selection_set(item)
            self.kw_menu.post(event.x_root, event.y_root)

    def _delete_keyword(self):
        selected = self.kw_tree.selection()
        if not selected:
            return
        kw = self.kw_tree.item(selected[0])["values"][0]
        if not messagebox.askyesno("Confirm", f"Delete keyword '{kw}'?"):
            return
        vault = self.var_vault.get().strip()
        store = KeywordStore(vault, self.cfg.get("keyword_index_path", KEYWORD_INDEX_REL_PATH))
        try:
            store.load()
            store.remove(kw)
            store.save()
        except KeywordStoreError as e:
            messagebox.showerror("Keyword index error", str(e))
            self._log(f"❌ Keyword deletion aborted (protecting index): {e}")
            return
        self._refresh_keywords()
        self._log(f"🗑 Keyword deleted: {kw}")

    def _add_keyword_dialog(self):
        dialog = tk.Toplevel(self)
        dialog.title("Add keyword")
        dialog.geometry("440x160")
        dialog.resizable(False, False)
        dialog.grab_set()

        frm = ttk.Frame(dialog, padding=12)
        frm.pack(fill="both", expand=True)

        ttk.Label(frm, text="Keyword:").grid(row=0, column=0, sticky="w", pady=4)
        var_kw = tk.StringVar()
        ttk.Entry(frm, textvariable=var_kw, width=35).grid(row=0, column=1, sticky="ew", padx=4)

        ttk.Label(frm, text="Hub document stem:").grid(row=1, column=0, sticky="w", pady=4)
        var_hub = tk.StringVar()
        ttk.Entry(frm, textvariable=var_hub, width=35).grid(row=1, column=1, sticky="ew", padx=4)

        ttk.Label(frm, text="Display name (optional):").grid(row=2, column=0, sticky="w", pady=4)
        var_disp = tk.StringVar()
        ttk.Entry(frm, textvariable=var_disp, width=35).grid(row=2, column=1, sticky="ew", padx=4)

        def on_ok():
            kw = var_kw.get().strip()
            hub = var_hub.get().strip()
            if not kw or not hub:
                messagebox.showwarning("Input error", "Enter both a keyword and a hub stem.", parent=dialog)
                return
            vault = self.var_vault.get().strip()
            store = KeywordStore(vault, self.cfg.get("keyword_index_path", KEYWORD_INDEX_REL_PATH))
            try:
                store.load()
                store.upsert(kw, hub, var_disp.get().strip() or kw)
                store.save()
            except KeywordStoreError as e:
                messagebox.showerror("Keyword index error", str(e), parent=dialog)
                self._log(f"❌ Keyword addition aborted (protecting index): {e}")
                return
            dialog.destroy()
            self._refresh_keywords()
            self._log(f"➕ Keyword added: {kw} → {hub}")

        btn_frm = ttk.Frame(frm)
        btn_frm.grid(row=3, column=0, columnspan=2, pady=8)
        ttk.Button(btn_frm, text="Add", command=on_ok, width=10).pack(side="left", padx=4)
        ttk.Button(btn_frm, text="Cancel", command=dialog.destroy, width=10).pack(side="left", padx=4)
        frm.columnconfigure(1, weight=1)

    # ── Index file tab ───────────────────────────────────────────────────────

    def _refresh_index_list(self):
        vault = self.var_vault.get().strip()
        if not vault or not Path(vault).exists():
            return
        # Collect index_*.md files across the whole vault
        paths = sorted(
            Path(vault).rglob("index_*.md"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        self._idx_paths = [str(p) for p in paths]
        self.lbl_idx_count.config(text=f"Index files: {len(paths)}")
        self.idx_listbox.delete(0, "end")
        for p in paths:
            # Show as relative path
            try:
                rel = p.relative_to(vault)
            except ValueError:
                rel = p
            self.idx_listbox.insert("end", str(rel))

    def _on_index_select(self, event=None):
        sel = self.idx_listbox.curselection()
        if not sel:
            return
        idx = sel[0]
        if idx >= len(self._idx_paths):
            return
        path = Path(self._idx_paths[idx])
        try:
            content = path.read_text(encoding="utf-8")
        except Exception as e:
            content = f"❌ Failed to read file: {e}"
        self.idx_content.configure(state="normal")
        self.idx_content.delete("1.0", "end")
        self.idx_content.insert("end", content)
        self.idx_content.configure(state="disabled")

    # ── Slack tab ───────────────────────────────────────────────────────────

    def _slack_log(self, msg: str):
        """Main thread only — writes directly to the Slack log widget."""
        self.txt_slack_log.configure(state="normal")
        ts = datetime.now().strftime("%H:%M:%S")
        self.txt_slack_log.insert("end", f"[{ts}] {msg}\n")
        self.txt_slack_log.see("end")
        self.txt_slack_log.configure(state="disabled")

    def _slack_log_threadsafe(self, msg: str):
        """Called from background threads — delegates via after()."""
        self.after(0, lambda m=msg: self._slack_log(m))

    def _clear_slack_log(self):
        self.txt_slack_log.configure(state="normal")
        self.txt_slack_log.delete("1.0", "end")
        self.txt_slack_log.configure(state="disabled")

    def _set_slack_status(self, running: bool):
        if running:
            self.btn_slack.config(text="⏹ Stop Slack bot")
            self.lbl_slack_status.config(text="Status: running", foreground="green")
        else:
            self.btn_slack.config(text="▶ Start Slack bot")
            self.lbl_slack_status.config(text="Status: stopped", foreground="gray")

    def _on_slack_stopped(self, running: bool):
        """Called by SlackBotRunner on shutdown (from a background thread)."""
        self.after(0, lambda: self._set_slack_status(running))

    def _toggle_slack(self):
        if self._slack_runner and self._slack_runner.is_running():
            self._slack_runner.stop()
            self._slack_runner = None
            self._set_slack_status(False)
        else:
            self._save_cfg()
            runner = SlackBotRunner(
                self.cfg,
                log_fn=self._slack_log_threadsafe,
                on_status_fn=self._on_slack_stopped,
            )
            ok = runner.start()
            if ok:
                self._slack_runner = runner
                self._set_slack_status(True)


# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--headless", action="store_true", help="Run only the Slack bot, without Tkinter")
    parser.add_argument("--config", default=None, help="Path to the config file to use (default: config.json)")
    args = parser.parse_args()

    # Override CONFIG_PATH via the --config argument (supports per-vault bot instances)
    if args.config:
        CONFIG_PATH = Path(args.config).resolve()

    if args.headless:
        import signal
        import io
        import traceback as _traceback
        import threading as _threading
        import datetime as _datetime
        # Replace stdout with UTF-8 so emoji can be printed in Windows cp949 environments
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

        # ── Crash hook: record unhandled/thread exceptions to crash.log with stack traces ──
        # Prevents lost stack traces when the Electron wrapper silently swallows stderr write failures.
        _CRASH_LOG = Path(__file__).parent / "slackbot_logs" / "crash.log"

        def _write_crash(kind: str, exc_type, exc_value, exc_tb, thread_name: str = ""):
            ts = _datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            tb_text = "".join(_traceback.format_exception(exc_type, exc_value, exc_tb))
            header = f"\n===== [{ts}] {kind}"
            if thread_name:
                header += f" (thread={thread_name})"
            header += " =====\n"
            body = header + tb_text
            try:
                _CRASH_LOG.parent.mkdir(parents=True, exist_ok=True)
                with _CRASH_LOG.open("a", encoding="utf-8") as f:
                    f.write(body)
            except Exception:
                pass
            # Also emit to stderr so it shows up as [ERR] in the Electron log stream (ignore failures)
            try:
                sys.stderr.write(body)
                sys.stderr.flush()
            except Exception:
                # Last-resort fallback: write directly to raw fd 2 if the TextIOWrapper is broken
                try:
                    os.write(2, body.encode("utf-8", "replace"))
                except Exception:
                    pass

        def _excepthook(exc_type, exc_value, exc_tb):
            _write_crash("UNHANDLED", exc_type, exc_value, exc_tb)

        def _thread_excepthook(args):
            _write_crash(
                "THREAD UNHANDLED",
                args.exc_type, args.exc_value, args.exc_traceback,
                thread_name=getattr(args.thread, "name", "?"),
            )

        sys.excepthook = _excepthook
        if hasattr(_threading, "excepthook"):
            _threading.excepthook = _thread_excepthook
        else:
            _log("[ERR] Python<3.8 — threading.excepthook unsupported, thread crashes may be lost")

        cfg = load_config()

        def _log(msg: str):
            print(msg, flush=True)

        def _on_status(running: bool):
            print(f"[STATUS] {'running' if running else 'stopped'}", flush=True)

        try:
            runner = SlackBotRunner(cfg, _log, _on_status)
            ok = runner.start()
        except Exception:
            _excepthook(*sys.exc_info())
            print("[ERROR] Exception while starting bot", flush=True)
            sys.exit(1)
        if not ok:
            print("[ERROR] Bot failed to start", flush=True)
            sys.exit(1)

        print("[READY] Slack bot started", flush=True)

        def _shutdown(sig, frame):
            print("[STOP] Shutting down bot...", flush=True)
            runner.stop()
            sys.exit(0)

        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)

        while runner.is_running():
            time.sleep(1)
        print("[STOP] Bot exited unexpectedly", flush=True)
    else:
        app = App()
        app.mainloop()
