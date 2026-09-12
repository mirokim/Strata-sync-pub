"""
rag_electron.py — Strata Sync Electron RAG API Client

When the Electron app is running, uses TF-IDF + wiki-link graph BFS search
on localhost:7331.
Returns None when not running, so the caller falls back to rag_simple.
"""
import json
import logging
import socket
import threading as _threading
import time as _time
import urllib.error
import urllib.parse
import urllib.request

from .constants import DEFAULT_HAIKU_MODEL, DEFAULT_SONNET_MODEL

logger = logging.getLogger(__name__)

# ── RAG HTTP auth token (injected by the Electron side via config.json) ───────
_rag_auth_token: str | None = None


def set_auth_token(token: str | None) -> None:
    """Called at bot.py startup — afterwards sent as the X-RAG-Auth header on every HTTP request."""
    global _rag_auth_token
    _rag_auth_token = token or None


def _auth_headers(extra: dict | None = None) -> dict:
    """Omit the header when no token is set (backward compatible). Returns merged with extra headers."""
    headers = dict(extra) if extra else {}
    if _rag_auth_token:
        headers["X-RAG-Auth"] = _rag_auth_token
    return headers

RAG_API_BASE      = "http://127.0.0.1:7331"
RAG_API_URL       = RAG_API_BASE + "/search"
RAG_ASK_URL       = RAG_API_BASE + "/ask"
RAG_SETTINGS_URL  = RAG_API_BASE + "/settings"
RAG_IMAGES_URL    = RAG_API_BASE + "/images"
RAG_MIROFISH_URL  = RAG_API_BASE + "/mirofish"
_CONNECT_TIMEOUT  = 1.5    # Connection check (fast fallback)
_PING_TIMEOUT     = 2.0    # is_electron_alive() TCP connection check
_SEARCH_TIMEOUT   = 25.0   # Actual search (including vector embedding query API)
_ASK_TIMEOUT      = 120.0  # Full RAG + LLM generation wait (synced with Electron IPC 120s)
_ASK_VISION_TIMEOUT = 150.0 # Vision + RAG + LLM generation wait (with images)
_MIROFISH_TIMEOUT = 300.0  # MiroFish simulation (N personas x M rounds)

# Slack tag → settingsStore DirectorId mapping
TAG_TO_DIRECTOR: dict[str, str] = {
    "chief": "chief_director",
    "art":   "art_director",
    "spec":  "plan_director",
    "tech":  "prog_director",
}

_settings_lock = _threading.Lock()
_cached_settings: dict | None = None
_settings_fetched_at: float = 0.0
_SETTINGS_TTL = 300.0  # 5-minute TTL — auto-reflects settings changes from Electron


def is_electron_alive(timeout: float = _PING_TIMEOUT) -> bool:
    """
    Check if the Electron app is ready to handle HTTP requests.
    Must receive an actual HTTP response from /settings to return True.
    Returns False if only TCP is open but HTTP is not responding (during restart) — prevents 65s wait.
    """
    try:
        req = urllib.request.Request(RAG_SETTINGS_URL, headers=_auth_headers())
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except Exception:
        return False


def get_electron_settings(timeout: float = 3.0) -> dict | None:
    """
    Return the current Electron app settings.
    {personaModels: {chief_director: 'model-id', ...}}
    Uses 5-minute TTL cache. Returns None on failure.
    """
    global _cached_settings, _settings_fetched_at
    now = _time.monotonic()
    with _settings_lock:
        if _cached_settings is not None and (now - _settings_fetched_at) < _SETTINGS_TTL:
            return _cached_settings
    try:
        req = urllib.request.Request(RAG_SETTINGS_URL, headers=_auth_headers())
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            with _settings_lock:
                _cached_settings = data
                _settings_fetched_at = now
            return data
    except urllib.error.HTTPError as e:
        if e.code == 401:
            logger.warning("[rag_electron] /settings 401 — X-RAG-Auth mismatch")
        with _settings_lock:
            return _cached_settings
    except Exception:
        with _settings_lock:
            return _cached_settings  # Return stale cache on failure


_PERSONA_FALLBACK: dict[str, dict] = {
    "chief": {"name": "PM",               "emoji": "🎯"},
    "art":   {"name": "Art Director",         "emoji": "🎨"},
    "spec":  {"name": "Design Director",      "emoji": "📐"},
    "tech":  {"name": "Programming Director", "emoji": "⚙️"},
}


def get_persona_for_tag(tag: str) -> dict:
    """
    Return the persona for the given tag (chief/art/spec/tech) from Electron settings.
    Returns a {name, emoji, system} dict.
    Returns minimal fallback (name, emoji only) when Electron is not running.
    """
    settings = get_electron_settings()
    if settings:
        persona = settings.get("personas", {}).get(tag)
        if persona:
            return persona
    return dict(_PERSONA_FALLBACK.get(tag, {"name": tag, "emoji": "🤖"}))


def get_api_key_from_settings(provider: str = "anthropic") -> str | None:
    """
    Return the API key for a specific provider from Electron Settings.
    Returns None if not found → caller falls back to config.json key.
    """
    settings = get_electron_settings()
    if settings:
        return settings.get("apiKeys", {}).get(provider) or None
    return None


def get_model_for_tag(tag: str, fallback: str = DEFAULT_SONNET_MODEL) -> str:
    """Return the Electron settings model for the given tag (chief/art/spec/tech).

    Priority: slackModel global setting > personaModels per-tag setting > fallback
    """
    settings = get_electron_settings()
    if settings:
        # A global Slack model setting takes precedence regardless of tag
        slack_model = settings.get("slackModel")
        if slack_model:
            return slack_model
        director_id = TAG_TO_DIRECTOR.get(tag, "chief_director")
        model = settings.get("personaModels", {}).get(director_id)
        if model:
            return model
    return fallback


def ask_via_electron(
    query: str,
    tag: str = "chief",
    history: list[dict] | None = None,
    images: list[dict] | None = None,
) -> tuple[str | None, list[str]]:
    """
    Send a question to the Electron app and receive a completed AI answer.
    Uses Strata Sync's BFS RAG + persona LLM pipeline directly.
    history: [{"role": "user"|"assistant", "content": "..."}] previous conversation history.
    images: [{"data": "<base64>", "mediaType": "image/png"}] attached images.
    Returns None on failure/not running → caller handles fallback.
    """
    director_id = TAG_TO_DIRECTOR.get(tag, "chief_director")
    payload: dict = {"q": query, "director": director_id}
    if history:
        payload["history"] = history
    if images:
        payload["images"] = images
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    timeout = _ASK_VISION_TIMEOUT if images else _ASK_TIMEOUT
    try:
        req = urllib.request.Request(
            RAG_ASK_URL,
            data=data,
            headers=_auth_headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            answer = result.get("answer") if isinstance(result, dict) else None
            # Treat an empty string ("") the same as None — the caller's fallback branch
            #   then takes the "Electron /ask empty response → sub-agent RAG" log path
            if not answer:
                return None, []
            image_paths = result.get("imagePaths", []) if isinstance(result, dict) else []
            return answer, image_paths
    except socket.timeout:
        logger.warning("[rag_electron] /ask timeout (%.1fs)", timeout)
        return None, []
    except urllib.error.URLError as e:
        # If URLError.reason is socket.timeout it's a timeout, otherwise a connection error
        reason = getattr(e, "reason", None)
        if isinstance(reason, socket.timeout):
            logger.warning("[rag_electron] /ask timeout (URLError): %s", reason)
        else:
            logger.warning("[rag_electron] /ask connection error: %s", reason or e)
        return None, []
    except Exception as e:
        logger.warning("[rag_electron] /ask exception: %s", e)
        return None, []


def get_images_via_electron(query: str) -> list[str]:
    """
    Search for image absolute paths by filename in the Electron vault.
    Returns empty list on failure/not running.
    """
    params = urllib.parse.urlencode({"q": query})
    url = f"{RAG_IMAGES_URL}?{params}"
    try:
        req = urllib.request.Request(url, headers=_auth_headers())
        with urllib.request.urlopen(req, timeout=5.0) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("paths", []) if isinstance(data, dict) else []
    except Exception:
        return []


def mirofish_via_electron(
    topic: str,
    num_personas: int = 5,
    num_rounds: int = 3,
    model_id: str = DEFAULT_HAIKU_MODEL,
    context: str | None = None,
    images: list[dict] | None = None,
    segment: str | None = None,
    preset_personas: list[dict] | None = None,
) -> dict | None:
    """
    Request a MiroFish simulation from the Electron app.
    Returns {feed: [...], report: "..."} on success, None on failure/not running.
    context: Background info found via vault RAG search (injected into persona prompts if present).
    images: [{"data": "<base64>", "mediaType": "image/png"}] directly provided images.
    segment: Target segment hint (e.g. "core gamers") — reflected in persona generation.
    preset_personas: Preset persona array — used as-is without LLM auto-generation when provided.
    """
    payload: dict = {
        "topic": topic,
        "numPersonas": num_personas,
        "numRounds": num_rounds,
        "modelId": model_id,
    }
    if context:
        payload["context"] = context
    if images:
        payload["images"] = images
    if segment:
        payload["segment"] = segment
    if preset_personas:
        payload["presetPersonas"] = preset_personas
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        req = urllib.request.Request(
            RAG_MIROFISH_URL,
            data=data,
            headers=_auth_headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=_MIROFISH_TIMEOUT) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result if isinstance(result, dict) else None
    except socket.timeout:
        logger.warning("[rag_electron] /mirofish timeout (%.1fs)", _MIROFISH_TIMEOUT)
        return None
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", None)
        if isinstance(reason, socket.timeout):
            logger.warning("[rag_electron] /mirofish timeout (URLError): %s", reason)
        else:
            logger.warning("[rag_electron] /mirofish connection error: %s", reason or e)
        return None
    except Exception as e:
        logger.warning("[rag_electron] /mirofish exception: %s", e)
        return None


RAG_MIROFISH_SAVE_URL = RAG_API_BASE + "/mirofish-save"


def propose_via_electron(title: str, body: str, source: str = "slack", tags: list[str] | None = None) -> dict | None:
    """
    Record an idea or decision as an agent PROPOSAL in the vault's _agent/ folder via the
    Electron RAG API. Proposals rank low in search and wait for a person to promote them.
    Returns {ok, path, title} on success, None when Electron is not running.
    """
    payload = {"title": title, "body": body, "source": source, "tags": tags or []}
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        req = urllib.request.Request(
            f"{RAG_API_BASE}/propose",
            data=data,
            headers=_auth_headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result if isinstance(result, dict) else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {detail[:200]}")
    except (socket.timeout, urllib.error.URLError) as e:
        logger.warning("[rag_electron] /propose unavailable: %s", getattr(e, "reason", e))
        return None


def save_mirofish_to_vault(
    topic: str,
    report: str,
    feed: list[dict],
    brief: str | None = None,
) -> dict | None:
    """
    Save MiroFish simulation results as an MD file in the Electron vault.
    Returns {ok, path, filename} on success, None on failure/not running.
    """
    payload: dict = {"topic": topic, "report": report, "feed": feed}
    if brief:
        payload["brief"] = brief
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    try:
        req = urllib.request.Request(
            RAG_MIROFISH_SAVE_URL,
            data=data,
            headers=_auth_headers({"Content-Type": "application/json"}),
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            result = json.loads(resp.read().decode("utf-8"))
            return result if isinstance(result, dict) else None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body[:200]}")
    except socket.timeout:
        logger.warning("[rag_electron] /mirofish-save timeout")
        return None
    except urllib.error.URLError as e:
        logger.warning("[rag_electron] /mirofish-save connection error: %s", getattr(e, "reason", e))
        return None
    except Exception as e:
        logger.warning("[rag_electron] /mirofish-save exception: %s", e)
        return None


def search_via_electron(
    query: str,
    top_n: int = 5,
) -> list[dict] | None:
    """
    Send a search request to the Electron RAG API.
    Returns a result list on success, None on failure/not running.

    Result dict format:
      {doc_id, filename, stem, title, date, tags, body, score}
    """
    params = urllib.parse.urlencode({"q": query, "n": top_n})
    url = f"{RAG_API_URL}?{params}"
    try:
        req = urllib.request.Request(url, headers=_auth_headers())
        with urllib.request.urlopen(req, timeout=_SEARCH_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data if isinstance(data, list) else None
    except socket.timeout:
        logger.warning("[rag_electron] /search timeout (%.1fs)", _SEARCH_TIMEOUT)
        return None
    except urllib.error.URLError as e:
        reason = getattr(e, "reason", None)
        if isinstance(reason, socket.timeout):
            logger.warning("[rag_electron] /search timeout (URLError): %s", reason)
        else:
            logger.warning("[rag_electron] /search connection error: %s", reason or e)
        return None
    except Exception as e:
        logger.warning("[rag_electron] /search exception: %s", e)
        return None
