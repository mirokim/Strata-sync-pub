"""
Team server (Cloudflare Worker) client for the bots.

The bots normally talk to the desktop app's local RAG API (modules.rag_electron). When nobody
has Strata Sync open — or the team runs the web build — the vault still lives on the Worker,
so proposals can go there directly:

    STRATA_SERVER_URL=https://strata-sync.<account>.workers.dev
    STRATA_TEAM_TOKEN=<team token>
    STRATA_BOT_AUTHOR=slack-bot          # optional, recorded as the file author

`record_proposal()` is the one entry point the bots use: Electron first, then the server.
"""
from __future__ import annotations

import json
import logging
import os
import socket
import urllib.error
import urllib.parse
import urllib.request

from .rag_electron import propose_via_electron

logger = logging.getLogger(__name__)

TIMEOUT_S = 15.0


def team_server_config() -> dict | None:
    """{url, token, author} from the environment, or None when no server is configured."""
    url = (os.environ.get("STRATA_SERVER_URL") or "").strip().rstrip("/")
    token = (os.environ.get("STRATA_TEAM_TOKEN") or "").strip()
    if not url or not token:
        return None
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return {"url": url, "token": token, "author": (os.environ.get("STRATA_BOT_AUTHOR") or "bot").strip()}


def propose_via_server(title: str, body: str, source: str = "bot", tags: list[str] | None = None,
                       config: dict | None = None) -> dict | None:
    """
    POST /v1/propose on the Worker. Returns {ok, path, title}; None when no server is configured
    or it cannot be reached; raises RuntimeError with the server's message on an HTTP error.
    """
    cfg = config or team_server_config()
    if not cfg:
        return None
    payload = {"title": title, "body": body, "source": source, "tags": tags or []}
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        f"{cfg['url']}/v1/propose",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {cfg['token']}",
            # Header values are Latin-1: percent-encode so a Korean author name survives
            "X-Author": urllib.parse.quote(cfg["author"], safe=""),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result if isinstance(result, dict) else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {detail[:200]}")
    except (socket.timeout, urllib.error.URLError) as e:
        logger.warning("[team_server] /v1/propose unavailable: %s", getattr(e, "reason", e))
        return None


def record_proposal(title: str, body: str, source: str = "bot", tags: list[str] | None = None) -> dict | None:
    """
    Record a proposal wherever the vault is reachable: the running desktop app first (it writes
    to the local vault, which syncs), otherwise the team server. None when neither is available.
    """
    result = propose_via_electron(title, body, source=source, tags=tags)
    if result:
        return result
    return propose_via_server(title, body, source=source, tags=tags)


def unavailable_message() -> str:
    """User-facing reason when record_proposal() returned None."""
    if team_server_config():
        return "Neither Strata Sync nor the team server could be reached, so the proposal was not recorded."
    return "Strata Sync is not running and no team server is configured (STRATA_SERVER_URL / STRATA_TEAM_TOKEN), so the proposal could not be recorded."
