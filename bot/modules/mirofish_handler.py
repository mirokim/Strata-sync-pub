"""
MiroFish handler module
─────────────────────────────────────────────────────────────────────────────
MiroFish-related functions extracted from bot.py start():
  - MiroFishHandler.run_single()       → single simulation (cache → Electron → Python fallback)
  - MiroFishHandler.handle()           → request parsing + branching (single / A-vs-B)
  - MiroFishHandler.format_and_post()  → post results to Slack + save to vault

Shared state is injected via the BotContext dataclass.
"""

import re as _re
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from modules.constants import DEFAULT_HAIKU_MODEL
from modules.mirofish_runner import STANCE_KO
from modules.rag_electron import RAG_API_BASE


# ── Regex patterns ───────────────────────────────────────────────────────────
MIROFISH_RE = _re.compile(r"시뮬레이션|시뮬", _re.IGNORECASE)
MIRO_PERSONAS_RE = _re.compile(r"(\d{1,2})\s{0,3}명")
MIRO_ROUNDS_RE   = _re.compile(r"(\d{1,2})\s{0,3}라운드로?")
MIRO_SEGMENT_RE  = _re.compile(
    r"(코어\s*게이머|캐주얼\s*게이머|하드코어\s*게이머|라이트\s*유저|신규\s*유저|복귀\s*유저|"
    r"코어\s*유저|캐주얼\s*유저|하드코어\s*유저|[가-힣a-zA-Z]+\s*세그먼트)",
    _re.IGNORECASE,
)
# A vs B comparison — only matches when both operands are present.
# The previous pattern filled different groups per branch, so group(2) was None on a `vs` match,
# and the caller's .strip() raised AttributeError → bolt swallowed it and the "preparing..." message hung forever.
MIRO_VS_RE = _re.compile(r"(?P<a>\S.*?)\s+vs\.?\s+(?P<b>\S.*)", _re.IGNORECASE)
MIRO_COMPARE_RE = _re.compile(r"(?P<a>\S.*?)\s*(?:와|과)\s+(?P<b>\S.*?)\s*비교")
# '대비' also appears in ordinary Korean ("비용 대비 효과"), so be stricter:
# treat as A/B mode only when both operands (2+ chars) and a comparison-intent cue are present.
MIRO_DAEBI_RE = _re.compile(r"(?P<a>\S.*?)\s+대비\s+(?P<b>\S.*)")
MIRO_COMPARE_CUE_RE = _re.compile(r"비교|어느\s*(?:쪽|것)|둘\s*중|더\s*나은|우세")


def match_vs_topics(query: str) -> tuple[str, str] | None:
    """Parse 'A vs B' / 'A 와 B 비교' / 'A 대비 B' and return (topic_a, topic_b)."""
    for rx in (MIRO_VS_RE, MIRO_COMPARE_RE):
        m = rx.search(query)
        if m:
            a = (m.group("a") or "").strip()
            b = (m.group("b") or "").strip()
            if len(a) >= 2 and len(b) >= 2:
                return a, b
    m = MIRO_DAEBI_RE.search(query)
    if m and MIRO_COMPARE_CUE_RE.search(query):
        a = (m.group("a") or "").strip()
        # A trailing '비교/비교해줘' on the second operand is not part of the topic — strip it
        b = _re.sub(r"\s*비교[가-힣]*\s*$", "", (m.group("b") or "")).strip()
        if len(a) >= 2 and len(b) >= 2:
            return a, b
    return None
MIRO_PRESET_RE = _re.compile(r"\[(?:프리셋|preset)\s*:\s*([^\]]+)\]", _re.IGNORECASE)

_MIRO_CACHE_TTL = 1800   # 30 minutes
_MIRO_CACHE_MAX = 200    # Max cache entries


# ── Shared state container ────────────────────────────────────────────────────
@dataclass
class BotContext:
    """State shared between components"""
    # conv_history: OrderedDict — kept LRU via move_to_end on access/update
    conv_history: "OrderedDict" = field(default_factory=OrderedDict)
    conv_history_lock: threading.Lock = field(default_factory=threading.Lock)
    active_channels: set = field(default_factory=set)


# ── MiroFish handler ──────────────────────────────────────────────────────────
class MiroFishHandler:
    def __init__(
        self,
        web_client,
        api_key: str,
        cfg: dict,
        bot_context: BotContext,
        report_builder,
        img_handler,
        say_fn: Callable,
        log_fn: Callable,
    ):
        self._web = web_client
        self._api_key = api_key
        self._cfg = cfg
        self._ctx = bot_context
        self._report = report_builder
        self._img = img_handler
        self._say = say_fn
        self._log = log_fn
        self._cache: dict[tuple, tuple] = {}
        self._cache_lock = threading.Lock()

    # ── Internal utilities ───────────────────────────────────────────────────
    def _update_msg(self, channel: str, think_ts: str | None, msg: str, blocks: list | None = None):
        """Update the think_ts message."""
        if think_ts:
            try:
                kw: dict = {"channel": channel, "ts": think_ts, "text": msg}
                if blocks:
                    kw["blocks"] = blocks
                self._web.chat_update(**kw)
            except Exception as _ue:
                self._log(f"[MiroFish] chat_update failed (ignored): {_ue}")

    def _generate_mirofish_html(
        self, topic: str, report: str, feed: list,
        num_personas: int, num_rounds: int,
        pm_brief: str | None = None,
    ) -> Path:
        return self._report.generate_mirofish_html(
            topic, report, feed, num_personas, num_rounds, pm_brief=pm_brief
        )

    def _upload_file_to_slack(self, filepath: Path, channel: str, thread_ts: str | None, title: str = "") -> bool:
        return self._report.upload_file_to_slack(filepath, channel, thread_ts, title)

    # ── Public methods ───────────────────────────────────────────────────────
    def run_single(
        self,
        topic: str,
        num_personas: int,
        num_rounds: int,
        context: str | None,
        sim_images: list | None,
        segment: str | None,
        channel: str,
        think_ts: str | None,
        preset_personas: list[dict] | None = None,
        # Runtime dependency injection (provided by the start() closure)
        is_electron_alive_fn: Callable | None = None,
        mirofish_via_electron_fn: Callable | None = None,
        get_anthropic_key_fn: Callable | None = None,
        get_model_for_tag_fn: Callable | None = None,
        mirofish_run_python_fn: Callable | None = None,
        claude_client_cls=None,
    ) -> dict | None:
        """Run a single MiroFish simulation (cache → Electron → Python fallback). Returns the result dict."""

        def update(msg: str):
            self._update_msg(channel, think_ts, msg)

        # Cache check
        _ctx_hash = hash(context) if context else 0
        _img_flag = bool(sim_images)
        cache_key = (topic, num_personas, num_rounds, _ctx_hash, _img_flag)
        now_ts = time.time()
        with self._cache_lock:
            _cached = self._cache.get(cache_key)
        if _cached:
            cached_result, cached_at = _cached
            if now_ts - cached_at < _MIRO_CACHE_TTL:
                age_min = int((now_ts - cached_at) / 60)
                update(f"🐟 *Using cached result* ({age_min} min ago)\nTopic: *{topic}*\n_(type '새로 시뮬레이션' for a fresh result)_")
                self._log(f"[MiroFish] Cache hit: {topic!r} ({age_min} min old)")
                return cached_result

        # Delegate to Electron + heartbeat thread
        if is_electron_alive_fn and not is_electron_alive_fn():
            self._log("[MiroFish] Electron offline → cannot run simulation")
            update(
                f"🐟 *MiroFish simulation unavailable*\nTopic: *{topic}*\n\n"
                f"🔴 *The Sandbox Map app is not responding.*\n\n"
                f"*Please check:*\n"
                f"• Make sure the Sandbox Map app is running\n"
                f"• If the app was just launched, wait about 30 seconds and try again"
            )
            return None

        _result_holder: list[dict | None] = [None]
        _done_event = threading.Event()

        def _electron_call():
            try:
                if mirofish_via_electron_fn:
                    _result_holder[0] = mirofish_via_electron_fn(
                        topic, num_personas, num_rounds, context=context, images=sim_images,
                        segment=segment, preset_personas=preset_personas,
                    )
            finally:
                _done_event.set()

        electron_thread = threading.Thread(target=_electron_call, daemon=True)
        electron_thread.start()

        # Heartbeat: poll /mirofish-progress every 20 seconds
        elapsed = 0
        _shown_post_count = 0
        while not _done_event.wait(timeout=20):
            elapsed += 20
            try:
                import urllib.request as _ureq, json as _json
                with _ureq.urlopen(RAG_API_BASE + "/mirofish-progress", timeout=3) as _r:
                    _prog = _json.loads(_r.read().decode("utf-8"))
                partial_feed = _prog.get("feed", [])
                cur_round = _prog.get("round", 0)
                new_posts = partial_feed[_shown_post_count:]
                if new_posts:
                    _shown_post_count = len(partial_feed)
                    lines = []
                    for p in new_posts[-5:]:
                        st = STANCE_KO.get(p.get("stance", ""), p.get("stance", ""))
                        lines.append(f"*[R{p['round']}] {p['personaName']}* ({st})\n> {p['content']}")
                    feed_preview = "\n\n".join(lines)
                    update(
                        f"🐟 *MiroFish in progress* (R{cur_round}/{num_rounds})\n"
                        f"Topic: *{topic}* | ⏱️ {elapsed}s\n\n"
                        f"{feed_preview}\n\n_...still running..._"
                    )
                else:
                    update(
                        f"🐟 *MiroFish simulation in progress...*\n"
                        f"Topic: *{topic}* | Personas: {num_personas} | Rounds: {num_rounds}\n"
                        f"_(⏱️ {elapsed}s elapsed)_"
                    )
            except Exception:
                update(
                    f"🐟 *MiroFish simulation in progress...*\n"
                    f"Topic: *{topic}* | Personas: {num_personas} | Rounds: {num_rounds}\n"
                    f"_(⏱️ {elapsed}s elapsed)_"
                )

        result = _result_holder[0]

        # Error response handling (Korean markers are produced by the Electron app)
        _report_str = result.get("report", "") if isinstance(result, dict) else ""
        if isinstance(result, dict) and not result.get("feed") and isinstance(_report_str, str) and (
            _report_str.startswith("Error:") or "already running" in _report_str
        ):
            self._log(f"[MiroFish] Electron error response: {result.get('report', '')[:100]}")
            result = None

        # Python fallback
        if result is None:
            self._log("[MiroFish] Electron not running → Python fallback")
            live_key = get_anthropic_key_fn(self._cfg) if get_anthropic_key_fn else self._api_key
            if not live_key:
                return None
            model = get_model_for_tag_fn("chief") if get_model_for_tag_fn else DEFAULT_HAIKU_MODEL
            claude_cli = claude_client_cls(live_key, model) if claude_client_cls else None
            round_count = [0]

            def progress_log(msg: str):
                self._log(msg)
                if "[MiroFish] Round" in msg:
                    round_count[0] += 1
                    update(
                        f"🐟 *MiroFish simulation*\nTopic: *{topic}*\n"
                        f"Round {round_count[0]}/{num_rounds} in progress..."
                    )

            if mirofish_run_python_fn and claude_cli:
                result = mirofish_run_python_fn(
                    topic, num_personas, num_rounds, claude_cli,
                    log_fn=progress_log, context=context,
                )

        if result:
            with self._cache_lock:
                self._cache[cache_key] = (result, time.time())
                if len(self._cache) > _MIRO_CACHE_MAX:
                    oldest_keys = sorted(self._cache, key=lambda k: self._cache[k][1])
                    for _k in oldest_keys[:len(self._cache) - _MIRO_CACHE_MAX]:
                        del self._cache[_k]

        return result

    def invalidate_cache(self, topic: str):
        """Remove all cache entries for the given topic."""
        with self._cache_lock:
            keys_to_del = [k for k in self._cache if k[0] == topic]
            for k in keys_to_del:
                self._cache.pop(k, None)

    def format_and_post(
        self,
        result: dict,
        topic: str,
        num_personas: int,
        num_rounds: int,
        say,
        channel: str,
        thread_ts: str | None,
        think_ts: str | None,
        report_only: bool,
        label: str = "",
        pm_brief: str | None = None,
        # Runtime dependency injection
        ask_via_electron_fn: Callable | None = None,
        save_mirofish_to_vault_fn: Callable | None = None,
    ):
        """Post MiroFish results to Slack + auto-save to the vault."""
        def update(msg: str, blocks: list | None = None):
            self._update_msg(channel, think_ts, msg, blocks)

        feed   = result.get("feed", [])
        report = result.get("report", "")

        # ── Slack summary message ────────────────────────────────────────────
        prefix = f"*{label}* " if label else ""
        stance_counts: dict[str, int] = {}
        for p in feed:
            s = p.get("stance", "neutral")
            stance_counts[s] = stance_counts.get(s, 0) + 1

        stance_summary = "  ".join(
            f"{STANCE_KO.get(s, s)} {c}"
            for s, c in sorted(stance_counts.items(), key=lambda x: -x[1])
        ) or "—"

        report_preview = ""
        for line in report.splitlines():
            stripped = line.strip().lstrip("#").strip()
            if len(stripped) > 30:
                report_preview = stripped[:400]
                break

        title_prefix = f"{label}  " if label else ""
        summary_blocks = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": f"🐟  {title_prefix}MiroFish Simulation Complete", "emoji": True},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*{topic}*"},
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*Personas*\n{num_personas}"},
                    {"type": "mrkdwn", "text": f"*Rounds*\n{num_rounds}"},
                    {"type": "mrkdwn", "text": f"*Posts*\n{len(feed)}"},
                    {"type": "mrkdwn", "text": f"*Stance breakdown*\n{stance_summary}"},
                ],
            },
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": "📄 Generating result report..."}],
            },
        ]
        slack_summary = f"🐟 MiroFish complete: {topic} ({len(feed)} reactions · {stance_summary})"
        update(slack_summary, blocks=summary_blocks)

        # ── HTML report generation + Slack upload (async) ────────────────────
        def _async_post():
            try:
                _is_fallback = "without API key" in report or not report.strip()
                _report_summary = "" if _is_fallback else report[:800]
                followup_prompt = (
                    f"The following MiroFish user reaction simulation has completed:\n"
                    f"Topic: {topic}\n"
                    + (f"Report summary: {_report_summary}\n\n" if _report_summary else "\n")
                    + f"Based on these results, briefly suggest 2-3 follow-up simulation topics "
                    f"that a game designer could explore in more depth.\n"
                    f"One line per suggestion, formatted as a 🐟 command that can actually be typed."
                )
                if ask_via_electron_fn:
                    followup, _ = ask_via_electron_fn(followup_prompt, tag="chief")
                    if followup:
                        say(
                            blocks=[
                                {
                                    "type": "section",
                                    "text": {
                                        "type": "mrkdwn",
                                        "text": f"*💡  Follow-up simulation suggestions*\n\n{followup.strip()}",
                                    },
                                },
                            ],
                            text=f"💡 Follow-up simulation suggestions\n\n{followup.strip()}",
                            thread_ts=thread_ts,
                        )
            except Exception as _e:
                self._log(f"[MiroFish] Follow-up suggestions failed: {_e}")

            try:
                html_path = self._generate_mirofish_html(
                    topic, report, feed, num_personas, num_rounds, pm_brief=pm_brief
                )
                try:
                    import pdfkit as _pdfkit
                    _WKHTMLTOPDF = self._cfg.get("wkhtmltopdf_path", r"C:\Program Files (x86)\wkhtmltopdf\bin\wkhtmltopdf.exe")
                    pdf_path = html_path.with_suffix(".pdf")
                    _pdfkit.from_file(
                        str(html_path), str(pdf_path),
                        configuration=_pdfkit.configuration(wkhtmltopdf=_WKHTMLTOPDF),
                        options={"encoding": "UTF-8", "quiet": ""},
                    )
                    self._log(f"[MiroFish] PDF conversion complete: {pdf_path.name}")
                    upload_path = pdf_path
                except Exception as _pdf_e:
                    self._log(f"[MiroFish] PDF conversion failed ({type(_pdf_e).__name__}: {_pdf_e}) → uploading HTML")
                    upload_path = html_path
                self._upload_file_to_slack(
                    upload_path, channel, thread_ts,
                    title=f"MiroFish — {topic}"
                )
                ext = upload_path.suffix.upper().lstrip(".")
                done_blocks = [
                    {
                        "type": "header",
                        "text": {"type": "plain_text", "text": f"🐟  {title_prefix}MiroFish Simulation Complete", "emoji": True},
                    },
                    {
                        "type": "section",
                        "text": {"type": "mrkdwn", "text": f"*{topic}*"},
                    },
                    {
                        "type": "section",
                        "fields": [
                            {"type": "mrkdwn", "text": f"*Personas*\n{num_personas}"},
                            {"type": "mrkdwn", "text": f"*Rounds*\n{num_rounds}"},
                            {"type": "mrkdwn", "text": f"*Posts*\n{len(feed)}"},
                            {"type": "mrkdwn", "text": f"*Stance breakdown*\n{stance_summary}"},
                        ],
                    },
                    {
                        "type": "context",
                        "elements": [{"type": "mrkdwn", "text": f"📎 The {ext} report is attached below."}],
                    },
                ]
                update(
                    f"🐟 MiroFish complete: {topic} · {ext} report attached",
                    blocks=done_blocks,
                )
            except Exception as _e:
                self._log(f"[MiroFish] Report generation failed: {_e}")

            try:
                if save_mirofish_to_vault_fn:
                    saved = save_mirofish_to_vault_fn(topic, report, feed, brief=pm_brief)
                    if saved and saved.get("ok"):
                        fname = saved.get("filename", "")
                        self._log(f"[MiroFish] Saved to vault: {fname}")
                    elif saved:
                        self._log(f"[MiroFish] Vault save failed: {saved}")
                    else:
                        self._log("[MiroFish] Vault save failed — Electron not running or no response")
            except Exception as _e:
                self._log(f"[MiroFish] Vault save exception: {_e}")

        threading.Thread(target=_async_post, daemon=True).start()

        # Store the simulation result in the thread history
        hist_key = f"{channel}:{thread_ts or 'dm'}"
        summary_for_hist = report[:1500] if len(report) > 1500 else report
        with self._ctx.conv_history_lock:
            prior = self._ctx.conv_history.get(hist_key, [])
            self._ctx.conv_history[hist_key] = (prior + [
                {"role": "user",      "content": f"[MiroFish simulation] Topic: {topic}"},
                {"role": "assistant", "content": f"[Simulation complete] Report:\n{summary_for_hist}"},
            ])[-40:]

    def handle(self, **kwargs):
        """Handle a MiroFish request (exception-guarding wrapper).

        If an exception escapes, bolt swallows it silently and the 'preparing...' message hangs forever.
        Catch it here and update the progress message to a failure.
        """
        think_holder: list[str | None] = [None]
        try:
            return self._handle(think_holder=think_holder, **kwargs)
        except Exception as e:
            self._log(f"[MiroFish] Exception while handling: {type(e).__name__}: {e}")
            msg = (
                f"🐟 *An error occurred while processing MiroFish*\n"
                f"_{type(e).__name__}: {str(e)[:150]}_\n\nPlease try again."
            )
            channel = kwargs.get("channel", "")
            if think_holder[0]:
                self._update_msg(channel, think_holder[0], msg)
            else:
                try:
                    kwargs["say"](text=msg, thread_ts=kwargs.get("thread_ts"))
                except Exception:
                    pass
            return None

    def _handle(
        self,
        query: str,
        say,
        channel: str,
        thread_ts: str | None,
        image_files: list | None = None,
        think_holder: list | None = None,
        # Runtime dependency injection
        search_via_electron_fn: Callable | None = None,
        ask_via_electron_fn: Callable | None = None,
        mirofish_via_electron_fn: Callable | None = None,
        get_electron_settings_fn: Callable | None = None,
        save_mirofish_to_vault_fn: Callable | None = None,
        is_electron_alive_fn: Callable | None = None,
        get_anthropic_key_fn: Callable | None = None,
        get_model_for_tag_fn: Callable | None = None,
        mirofish_run_python_fn: Callable | None = None,
        download_slack_file_fn: Callable | None = None,
        claude_client_cls=None,
    ):
        """Handle a MiroFish simulation request."""
        # Parameter parsing
        personas_m = MIRO_PERSONAS_RE.search(query)
        rounds_m   = MIRO_ROUNDS_RE.search(query)
        num_personas = int(personas_m.group(1)) if personas_m else 5
        num_rounds   = int(rounds_m.group(1))   if rounds_m   else 3
        num_personas = max(3, min(50, num_personas))
        num_rounds   = max(2, min(10, num_rounds))

        report_only = bool(_re.search(r"시뮬레이션?\s*보고서|시뮬\s*보고서", query))

        seg_m = MIRO_SEGMENT_RE.search(query)
        segment: str | None = seg_m.group(0).strip() if seg_m else None

        preset_m = MIRO_PRESET_RE.search(query)
        preset_personas: list[dict] | None = None
        preset_label = ""
        if preset_m:
            preset_name_raw = preset_m.group(1).strip()
            settings_data = (get_electron_settings_fn() if get_electron_settings_fn else None) or {}
            saved_presets = settings_data.get("presets", [])
            matched = next(
                (p for p in saved_presets if preset_name_raw.lower() in p.get("name", "").lower()),
                None,
            )
            if matched:
                preset_personas = matched.get("personas", []) or None
                preset_label = f" | Preset: {matched['name']}"
                if preset_personas:
                    num_personas = len(preset_personas)
                self._log(f"[MiroFish] Preset '{matched['name']}' applied ({num_personas} personas)")
            else:
                preset_list = ", ".join(f"'{p.get('name','')}'" for p in saved_presets[:5])
                say(text=f"🐟 Preset `{preset_name_raw}` not found.\nSaved presets: {preset_list or 'none'}",
                    thread_ts=thread_ts)
                return

        # Detect A vs B comparison mode
        vs_topics = match_vs_topics(query)
        is_vs_mode = vs_topics is not None

        # Topic extraction
        topic = MIROFISH_RE.sub("", query)
        topic = MIRO_PERSONAS_RE.sub("", topic)
        topic = MIRO_ROUNDS_RE.sub("", topic)
        if preset_m:
            topic = MIRO_PRESET_RE.sub("", topic)
        topic = _re.sub(r"\s*보고서\s*", " ", topic)
        topic = _re.sub(r"\s*새로\s*시뮬레이션\s*", " ", topic)
        topic = topic.strip(",:. ~\t\n").strip()
        topic = _re.sub(
            r"\s*(?:해\s*주세요|해\s*줘|해\s*봐요?|해요|해|주세요|줘"
            r"|부탁\s*(?:해요?|드려요?)"
            r"|돌려\s*줘?|실행해\s*줘?|시작해\s*줘?)\s*$",
            "", topic,
        ).strip()
        if not topic:
            say(text="🐟 Please include a topic to simulate.\ne.g. `🐟 새 캐릭터 출시 반응 5명 3라운드`", thread_ts=thread_ts)
            return

        # "새로 시뮬레이션" (re-simulate) → invalidate cache
        if _re.search(r"새로\s*시뮬레이션", query):
            self.invalidate_cache(topic)

        seg_label = f" | Segment: {segment}" if segment else ""
        thinking = say(
            text=f"🐟  *MiroFish*  {topic}  —  {num_personas} personas · {num_rounds} rounds{seg_label}{preset_label}\n_⏳ Preparing simulation..._",
            thread_ts=thread_ts,
        )
        think_ts = (thinking or {}).get("ts")
        if think_holder is not None:
            think_holder[0] = think_ts

        self._log(f"[MiroFish] topic='{topic}' personas={num_personas} rounds={num_rounds} segment={segment!r} preset={bool(preset_personas)} vs={is_vs_mode}")

        # Gather background context via vault RAG search
        context: str | None = None
        if search_via_electron_fn:
            rag_docs = search_via_electron_fn(topic, top_n=3)
            if rag_docs:
                ctx_parts = []
                for doc in rag_docs:
                    title = doc.get("title") or doc.get("filename", "")
                    body  = (doc.get("body") or "")[:600]
                    if body:
                        ctx_parts.append(f"### {title}\n{body}")
                if ctx_parts:
                    context = "\n\n".join(ctx_parts)
                    self._log(f"[MiroFish] RAG context: {len(ctx_parts)} documents injected")

        # Image handling
        sim_images: list[dict] | None = None
        if image_files:
            self._update_msg(channel, think_ts, f"🐟  *MiroFish*  {topic}\n_🖼️ Processing images..._")
            images_payload = self._img.download_images(image_files, download_slack_file_fn) if download_slack_file_fn else None
            if images_payload:
                image_direct = (get_electron_settings_fn() if get_electron_settings_fn else None) or {}
                if image_direct.get("imageDirectPass", True):
                    sim_images = images_payload
                    self._log(f"[MiroFish] Direct pass-through mode for {len(sim_images)} images")
                elif ask_via_electron_fn:
                    desc_answer, _ = ask_via_electron_fn(
                        "Describe the attached image objectively so that simulation participants can refer to it. "
                        "Describe the design, mood, and notable features in 3-5 sentences.",
                        tag="chief",
                        images=images_payload,
                    )
                    if desc_answer:
                        img_ctx = f"### Attached image description\n{desc_answer.strip()}"
                        context = f"{img_ctx}\n\n{context}" if context else img_ctx
                        self._log(f"[MiroFish] Image-to-text context injected ({len(desc_answer)} chars)")

        # ── PM AI brief generation ────────────────────────────────────────────
        self._update_msg(channel, think_ts, f"🐟  *MiroFish*  {topic}\n_🧠 Writing brief..._")

        brief_prompt_parts = [
            "Write a brief for a MiroFish simulation (virtual user reactions). Under 600 characters, no preamble.\n\n",
            f"[Request]\n{query}\n",
        ]
        if context:
            brief_prompt_parts.append(f"\n[Vault reference documents]\n{context}\n")
        brief_prompt_parts.append(
            "\nFormat:\n"
            "**Key background**: background the participants need to know (3-5 lines)\n"
            "**Observation points**: 2-3 reaction types or issues to watch\n\n"
            "Note: keep the topic exactly as in the original request. If there are no vault documents, write from the request context alone."
        )

        _brief_result: list[str | None] = [None]
        _brief_done = threading.Event()
        _brief_api_key = (get_anthropic_key_fn(self._cfg) if get_anthropic_key_fn else None) or self._api_key
        _BRIEF_MODEL = DEFAULT_HAIKU_MODEL

        def _run_brief():
            if not _brief_api_key:
                self._log("[MiroFish] No API key → skipping PM brief generation")
                _brief_done.set()
                return
            try:
                if claude_client_cls:
                    _brief_cli = claude_client_cls(_brief_api_key, _BRIEF_MODEL)
                    _brief_system = "User research expert. Writes structured briefs for MiroFish simulations."
                    _brief_result[0] = _brief_cli.complete(_brief_system, "".join(brief_prompt_parts), max_tokens=700)
                    self._log(f"[MiroFish] PM brief generated: {len(_brief_result[0] or '')} chars")
            except Exception as _e:
                self._log(f"[MiroFish] PM brief generation exception: {_e}")
            finally:
                _brief_done.set()

        threading.Thread(target=_run_brief, daemon=True).start()
        _brief_elapsed = 0
        _BRIEF_TIMEOUT = 50
        while not _brief_done.wait(timeout=10):
            _brief_elapsed += 10
            self._update_msg(
                channel, think_ts,
                f"🐟  *MiroFish*  {topic}\n_🧠 Writing brief... ⏱ {_brief_elapsed}s_"
            )
            if _brief_elapsed >= _BRIEF_TIMEOUT:
                self._log("[MiroFish] PM brief timed out → keeping raw context")
                break

        brief_answer = _brief_result[0]
        if brief_answer and brief_answer.strip():
            context = f"[Original simulation topic: {topic}]\n\n" + brief_answer.strip()[:1150]
            self._log(f"[MiroFish] PM brief → context replaced ({len(context)} chars)")
        else:
            self._log("[MiroFish] No PM brief → keeping raw RAG context")

        self._update_msg(channel, think_ts, f"🐟  *MiroFish*  {topic}\n_⚙️ Generating personas..._")

        # ── A vs B comparison mode ────────────────────────────────────────────
        if vs_topics:
            topic_a, topic_b = vs_topics
            for pat in (MIROFISH_RE, MIRO_PERSONAS_RE, MIRO_ROUNDS_RE):
                topic_a = pat.sub("", topic_a).strip()
                topic_b = pat.sub("", topic_b).strip()
            topic_a = topic_a.strip(",:. ~\t\n").strip()
            topic_b = topic_b.strip(",:. ~\t\n").strip()

            self._update_msg(
                channel, think_ts,
                f"🐟  *A vs B comparison simulation*\n🅰️ {topic_a}\n🅱️ {topic_b}\n_⏳ Running both scenarios simultaneously..._"
            )

            result_a: list[dict | None] = [None]
            result_b: list[dict | None] = [None]
            err_a: list[str] = []
            err_b: list[str] = []

            def run_a():
                try:
                    if mirofish_via_electron_fn:
                        result_a[0] = mirofish_via_electron_fn(topic_a, num_personas, num_rounds, context=context, segment=segment)
                except Exception as _e:
                    err_a.append(str(_e))
                    self._log(f"[MiroFish A] Failed: {_e}")

            def run_b():
                try:
                    if mirofish_via_electron_fn:
                        result_b[0] = mirofish_via_electron_fn(topic_b, num_personas, num_rounds, context=context, segment=segment)
                except Exception as _e:
                    err_b.append(str(_e))
                    self._log(f"[MiroFish B] Failed: {_e}")

            _AB_TIMEOUT = 720
            _HEARTBEAT_INTERVAL = 30
            t_a = threading.Thread(target=run_a, daemon=True)
            t_b = threading.Thread(target=run_b, daemon=True)
            t_a.start(); t_b.start()
            _ab_start = time.time()
            while t_a.is_alive() or t_b.is_alive():
                _ab_elapsed = time.time() - _ab_start
                if _ab_elapsed >= _AB_TIMEOUT:
                    break
                t_a.join(timeout=_HEARTBEAT_INTERVAL)
                t_b.join(timeout=_HEARTBEAT_INTERVAL)
                if t_a.is_alive() or t_b.is_alive():
                    _ab_elapsed = time.time() - _ab_start
                    if _ab_elapsed < _AB_TIMEOUT:
                        try:
                            self._web.chat_postMessage(
                                channel=channel,
                                thread_ts=thread_ts,
                                text=f"⏳ A vs B analysis in progress... ({int(_ab_elapsed) // 60} min elapsed)",
                            )
                        except Exception:
                            pass

            if not result_a[0] and not result_b[0]:
                _err_hint = ""
                if err_a: _err_hint += f"\nA error: _{err_a[0][:80]}_"
                if err_b: _err_hint += f"\nB error: _{err_b[0][:80]}_"
                say(text=(
                    f"🐟 *A vs B simulation — both failed*\n\n"
                    f"A: _{topic_a}_\nB: _{topic_b}_\n{_err_hint}\n\n"
                    f"*Please check:*\n"
                    f"• Is the Sandbox Map app running?\n"
                    f"• If another simulation is already running, retry after it finishes\n"
                    f"• Test a single simulation first with `시뮬 {topic_a}`"
                ), thread_ts=thread_ts)
                return
            if not result_a[0]:
                _hint = f"\n_(error: {err_a[0][:60]})_" if err_a else ""
                say(text=(
                    f"⚠️ *Simulation A failed — showing B results only*{_hint}\n\n"
                    f"*🅱️ {topic_b}*\n{result_b[0].get('report', '')}"
                ), thread_ts=thread_ts)
                return
            if not result_b[0]:
                _hint = f"\n_(error: {err_b[0][:60]})_" if err_b else ""
                say(text=(
                    f"⚠️ *Simulation B failed — showing A results only*{_hint}\n\n"
                    f"*🅰️ {topic_a}*\n{result_a[0].get('report', '')}"
                ), thread_ts=thread_ts)
                return

            rep_a = result_a[0].get("report", "")
            rep_b = result_b[0].get("report", "")

            matrix_answer = None
            if ask_via_electron_fn:
                matrix_prompt = (
                    f"Below are MiroFish user reaction simulation results for two scenarios.\n\n"
                    f"**Scenario A: {topic_a}**\n{rep_a[:2000]}\n\n"
                    f"**Scenario B: {topic_b}**\n{rep_b[:2000]}\n\n"
                    f"Write a concise matrix comparing the two scenarios:\n"
                    f"- 3 key differences (table format)\n"
                    f"- Which scenario received more positive reactions, and why\n"
                    f"- Final recommendation (A/B or a compromise)\n"
                    f"Keep it concise, 2-3 paragraphs."
                )
                matrix_answer, _ = ask_via_electron_fn(matrix_prompt, tag="chief")

            vs_blocks = [
                {
                    "type": "header",
                    "text": {"type": "plain_text", "text": "🐟  A vs B Comparison Simulation Results", "emoji": True},
                },
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": f"*🅰️  {topic_a}*\n{rep_a}"},
                },
                {"type": "divider"},
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": f"*🅱️  {topic_b}*\n{rep_b}"},
                },
            ]
            if matrix_answer:
                vs_blocks += [
                    {"type": "divider"},
                    {
                        "type": "section",
                        "text": {"type": "mrkdwn", "text": f"*🔍  PM Comparison Analysis*\n{matrix_answer.strip()}"},
                    },
                ]
            comparison_fallback = f"🐟 A vs B comparison results\n🅰️ {topic_a}\n🅱️ {topic_b}"
            if think_ts:
                try:
                    self._web.chat_update(channel=channel, ts=think_ts, blocks=vs_blocks, text=comparison_fallback)
                except Exception:
                    say(blocks=vs_blocks, text=comparison_fallback, thread_ts=thread_ts)
            else:
                say(blocks=vs_blocks, text=comparison_fallback, thread_ts=thread_ts)
            return

        # ── Single simulation ─────────────────────────────────────────────────
        result = self.run_single(
            topic, num_personas, num_rounds, context, sim_images, segment, channel, think_ts,
            preset_personas=preset_personas,
            is_electron_alive_fn=is_electron_alive_fn,
            mirofish_via_electron_fn=mirofish_via_electron_fn,
            get_anthropic_key_fn=get_anthropic_key_fn,
            get_model_for_tag_fn=get_model_for_tag_fn,
            mirofish_run_python_fn=mirofish_run_python_fn,
            claude_client_cls=claude_client_cls,
        )

        if result and think_ts:
            try:
                self._web.chat_update(
                    channel=channel, ts=think_ts,
                    text=f"🐟  *MiroFish*  {topic}  —  {len(result.get('feed', []))} reactions collected\n_📝 Writing report..._",
                )
            except Exception:
                pass

        if not result:
            self._log("[MiroFish] No simulation result → failure notice")
            fail_msg = (
                f"🐟 *MiroFish simulation failed*\nTopic: _{topic}_\n\n"
                f"*Possible causes:*\n"
                f"• The Sandbox Map app is off or the vault is not loaded\n"
                f"• Another simulation is already running (retry after it finishes)\n"
                f"• Simulation timed out (complex topics can take longer)\n\n"
                f"Try again with `시뮬 {topic}`, or check the app status."
            )
            if think_ts:
                try:
                    self._web.chat_update(channel=channel, ts=think_ts, text=fail_msg)
                except Exception:
                    say(text=fail_msg, thread_ts=thread_ts)
            else:
                say(text=fail_msg, thread_ts=thread_ts)
            return

        self.format_and_post(
            result, topic, num_personas, num_rounds, say, channel, thread_ts, think_ts, report_only,
            pm_brief=context,
            ask_via_electron_fn=ask_via_electron_fn,
            save_mirofish_to_vault_fn=save_mirofish_to_vault_fn,
        )
