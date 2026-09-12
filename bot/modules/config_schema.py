"""
config_schema.py — BotConfig TypedDict (SSOT)

Defines the schema of config.json as types.
Reference this when gradually migrating bot.py from cfg: dict → cfg: BotConfig.

total=False: every key is optional (only some may exist at load time)
"""
from typing import TypedDict

from .constants import DEFAULT_HAIKU_MODEL, KEYWORD_INDEX_REL_PATH


class BotConfig(TypedDict, total=False):
    # ── Vault ─────────────────────────────────────────────────────────────────
    vault_path:                 str    # absolute path to the Obsidian vault
    keyword_index_path:         str    # keyword index path relative to the vault (default: KEYWORD_INDEX_REL_PATH)
    max_files_per_keyword_scan: int    # max files per keyword scan (default: 20)

    # ── API keys (secrets — .env or UI input) ────────────────────────────────
    claude_api_key:   str   # Anthropic API key
    slack_bot_token:  str   # Slack Bot OAuth token
    slack_app_token:  str   # Slack App-Level token (Socket Mode)

    # ── Slack bot behaviour ───────────────────────────────────────────────────
    slack_notify_channel: str   # notification channel ID
    slack_rag_top_n:      int   # top N RAG search results (default: 5)

    # ── Scheduler ────────────────────────────────────────────────────────────
    interval_hours: int    # auto-run interval (hours)
    auto_run:       bool   # whether to auto-run on startup

    # ── Model ─────────────────────────────────────────────────────────────────
    worker_model: str   # Worker LLM model ID (default: DEFAULT_HAIKU_MODEL)

    # ── Images ────────────────────────────────────────────────────────────────
    sendImages: bool   # whether to upload vault images to Slack (default: True)

    # ── External tools ────────────────────────────────────────────────────────
    wkhtmltopdf_path: str   # PDF conversion tool path (has a Windows default)


def default_config() -> BotConfig:
    """Return the default values dict used before config.json is loaded."""
    return BotConfig(
        vault_path                 = "",
        claude_api_key             = "",
        interval_hours             = 1,
        auto_run                   = False,
        keyword_index_path         = KEYWORD_INDEX_REL_PATH,
        max_files_per_keyword_scan = 20,
        worker_model               = DEFAULT_HAIKU_MODEL,
        wkhtmltopdf_path           = r"C:\Program Files (x86)\wkhtmltopdf\bin\wkhtmltopdf.exe",
        slack_rag_top_n            = 5,
        sendImages                 = True,
        slack_notify_channel       = "",
    )
