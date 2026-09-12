"""Slack bot scheduler module"""
from __future__ import annotations
import threading
from datetime import datetime
from pathlib import Path
from typing import Callable, Any


class SlackScheduler:
    def __init__(self, web_client, cfg: dict, bot_context,
                 miro_handler, log_fn: Callable[[str], None]):
        self._web = web_client
        self._cfg = cfg
        self._ctx = bot_context
        self._miro = miro_handler
        self._log = log_fn
        self._handler_ref = None  # SocketModeHandler reference (for shutdown detection)

        self._sched_fired: set[str] = set()        # "YYYY-MM-DD HH:MM<topic>" prevents duplicate runs
        self._sim_needed_notified: set[str] = set()  # filenames already notified
        self._sets_lock = threading.Lock()           # protects _sched_fired / _sim_needed_notified
        self._stop_event = threading.Event()         # stop signal
        self._thread: threading.Thread | None = None  # scheduler thread (prevents duplicate runs)

    def set_handler(self, handler) -> None:
        self._handler_ref = handler

    def stop(self) -> None:
        """Send the scheduler stop signal."""
        self._stop_event.set()

    def _interruptible_sleep(self, seconds: int) -> bool:
        """Sleep interruptibly; returns True if stop was requested."""
        return self._stop_event.wait(timeout=seconds)

    # ── Schedule check ───────────────────────────────────────────────────────

    def start_schedule_checker(self) -> threading.Thread:
        if self._thread is not None and self._thread.is_alive():
            self._log("[Schedule] Scheduler thread is already running. Skipping restart.")
            return self._thread
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._schedule_checker, daemon=True)
        self._thread.start()
        return self._thread

    def _schedule_checker(self) -> None:
        """Check scheduledTopics every 30 seconds. Auto-run the simulation when the current time matches."""
        from modules.rag_electron import (
            get_electron_settings, search_via_electron, is_electron_alive,
            mirofish_via_electron, ask_via_electron, save_mirofish_to_vault,
            get_model_for_tag,
        )
        from modules.api_keys import get_anthropic_key
        from modules.claude_client import ClaudeClient
        from modules.mirofish_runner import run_simulation as mirofish_run_python

        cfg = self._cfg
        web = self._web

        notify_channel = cfg.get("slack_notify_channel", "").strip()
        if not notify_channel:
            return  # skip when no notification channel is configured

        while (
            not self._stop_event.is_set()
            and self._handler_ref
            and self._handler_ref.client
            and self._handler_ref.client.is_connected()
        ):
            try:
                settings = get_electron_settings(timeout=2.0) or {}
                topics = settings.get("scheduledTopics", [])
                now = datetime.now()
                now_hm = now.strftime("%H:%M")
                fire_key_prefix = now.strftime("%Y-%m-%d ")

                for sched in topics:
                    if not sched.get("enabled"):
                        continue
                    sched_time = sched.get("time", "")
                    if sched_time != now_hm:
                        continue
                    fire_key = fire_key_prefix + sched_time + sched.get("topic", "")
                    with self._sets_lock:
                        if fire_key in self._sched_fired:
                            continue
                        self._sched_fired.add(fire_key)
                        # Clean up stale keys
                        if len(self._sched_fired) > 200:
                            oldest = sorted(self._sched_fired)[:100]
                            for k in oldest:
                                self._sched_fired.discard(k)

                    sched_topic = sched.get("topic", "").strip()
                    sched_np    = max(3, min(50, int(sched.get("numPersonas", 5))))
                    sched_nr    = max(2, min(10, int(sched.get("numRounds", 3))))
                    self._log(f"[Schedule] Auto-run: '{sched_topic}' {sched_np} personas, {sched_nr} rounds")

                    def _run_sched(t=sched_topic, np=sched_np, nr=sched_nr):
                        try:
                            thinking = web.chat_postMessage(
                                channel=notify_channel,
                                text=f"🐟 *[Auto schedule] MiroFish simulation started*\nTopic: _{t}_\nPersonas: {np} | Rounds: {nr}\n\n_⏳ Running..._",
                            )
                            think_ts = (thinking or {}).get("ts")
                            context_s: str | None = None
                            rag_docs_s = search_via_electron(t, top_n=3)
                            if rag_docs_s:
                                ctx_parts_s = [
                                    f"### {d.get('title') or d.get('filename','')}\n{(d.get('body',''))[:600]}"
                                    for d in rag_docs_s if d.get("body")
                                ]
                                if ctx_parts_s:
                                    context_s = "\n\n".join(ctx_parts_s)
                            result_s = self._miro.run_single(
                                t, np, nr, context_s, None, None, notify_channel, think_ts,
                                is_electron_alive_fn=is_electron_alive,
                                mirofish_via_electron_fn=mirofish_via_electron,
                                get_anthropic_key_fn=get_anthropic_key,
                                get_model_for_tag_fn=get_model_for_tag,
                                mirofish_run_python_fn=mirofish_run_python,
                                claude_client_cls=ClaudeClient,
                            )
                            if result_s:
                                self._miro.format_and_post(
                                    result_s, t, np, nr,
                                    lambda **kw: web.chat_postMessage(channel=notify_channel, **kw),
                                    notify_channel, None, think_ts, False, pm_brief=context_s,
                                    ask_via_electron_fn=ask_via_electron,
                                    save_mirofish_to_vault_fn=save_mirofish_to_vault,
                                )
                            else:
                                if think_ts:
                                    try:
                                        web.chat_update(channel=notify_channel, ts=think_ts,
                                                        text=f"🐟 [Auto schedule] Simulation failed: _{t}_")
                                    except Exception as _ue:
                                        self._log(f"[Schedule] chat_update failed (ignored): {_ue}")
                        except Exception as e:
                            self._log(f"[Schedule] Run error: {e}")

                    threading.Thread(target=_run_sched, daemon=True).start()

            except Exception as e:
                self._log(f"[Schedule] Check error: {e}")
            if self._interruptible_sleep(30):
                break

    # ── Vault tag scanner ────────────────────────────────────────────────────

    def start_vault_tag_scanner(self) -> threading.Thread:
        t = threading.Thread(target=self._vault_tag_scanner, daemon=True)
        t.start()
        return t

    def _vault_tag_scanner(self) -> None:
        """Every 20 minutes, scan the vault for files containing the #시뮬레이션필요 tag and notify Slack."""
        cfg = self._cfg
        web = self._web

        notify_channel = cfg.get("slack_notify_channel", "").strip()
        if not notify_channel:
            return
        vault_path_str = cfg.get("vault_path", "").strip()
        if not vault_path_str:
            self._log("[TagScan] vault_path is not configured; skipping scan.")
            return
        scan_vault_path = Path(vault_path_str)
        if self._interruptible_sleep(60):  # start scanning 1 minute after bot startup
            return
        while (
            not self._stop_event.is_set()
            and self._handler_ref
            and self._handler_ref.client
            and self._handler_ref.client.is_connected()
        ):
            try:
                found = []
                for md_file in scan_vault_path.rglob("*.md"):
                    try:
                        text = md_file.read_text(encoding="utf-8", errors="ignore")
                        should_notify = False
                        with self._sets_lock:
                            if "#시뮬레이션필요" in text and md_file.name not in self._sim_needed_notified:
                                self._sim_needed_notified.add(md_file.name)
                                should_notify = True
                        if should_notify:
                            found.append(md_file.name)
                    except Exception:
                        pass
                if found:
                    items = "\n".join(f"• `{f}`" for f in found[:10])
                    web.chat_postMessage(
                        channel=notify_channel,
                        text=(
                            f"🔖 *#시뮬레이션필요 tag detected*\n"
                            f"The following documents are tagged for simulation review:\n{items}\n\n"
                            f"💡 Start a simulation with `🐟 <topic>`."
                        ),
                    )
                    self._log(f"[TagScan] #시뮬레이션필요 detected in {len(found)} file(s)")
            except Exception as e:
                self._log(f"[TagScan] Error: {e}")
            if self._interruptible_sleep(1200):  # 20-minute interval
                break
