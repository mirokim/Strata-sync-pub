"""Slack 봇 스케줄러 모듈"""
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
        self._handler_ref = None  # SocketModeHandler 참조 (종료 감지용)

        self._sched_fired: set[str] = set()        # "YYYY-MM-DD HH:MM<topic>" 중복 실행 방지
        self._sim_needed_notified: set[str] = set()  # 이미 알림 보낸 파일명
        self._sets_lock = threading.Lock()           # _sched_fired / _sim_needed_notified 보호
        self._stop_event = threading.Event()         # 중단 신호
        self._thread: threading.Thread | None = None  # 스케줄러 스레드 (중복 실행 방지용)

    def set_handler(self, handler) -> None:
        self._handler_ref = handler

    def stop(self) -> None:
        """스케줄러 중단 신호 전송."""
        self._stop_event.set()

    def _interruptible_sleep(self, seconds: int) -> bool:
        """Sleep interruptibly; returns True if stop was requested."""
        return self._stop_event.wait(timeout=seconds)

    # ── 스케줄 체크 ──────────────────────────────────────────────────────────

    def start_schedule_checker(self) -> threading.Thread:
        if self._thread is not None and self._thread.is_alive():
            self._log("[스케줄] 스케줄러 스레드가 이미 실행 중입니다. 재시작 생략.")
            return self._thread
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._schedule_checker, daemon=True)
        self._thread.start()
        return self._thread

    def _schedule_checker(self) -> None:
        """매 30초마다 scheduledTopics 체크. 현재 시각과 일치하면 시뮬레이션 자동 실행."""
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
            return  # 알림 채널 미설정 시 스킵

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
                        # 오래된 키 정리
                        if len(self._sched_fired) > 200:
                            oldest = sorted(self._sched_fired)[:100]
                            for k in oldest:
                                self._sched_fired.discard(k)

                    sched_topic = sched.get("topic", "").strip()
                    sched_np    = max(3, min(50, int(sched.get("numPersonas", 5))))
                    sched_nr    = max(2, min(10, int(sched.get("numRounds", 3))))
                    self._log(f"[스케줄] 자동 실행: '{sched_topic}' {sched_np}명 {sched_nr}라운드")

                    def _run_sched(t=sched_topic, np=sched_np, nr=sched_nr):
                        try:
                            thinking = web.chat_postMessage(
                                channel=notify_channel,
                                text=f"🐟 *[자동 스케줄] MiroFish 시뮬레이션 시작*\n주제: _{t}_\n페르소나: {np}명 | 라운드: {nr}회\n\n_⏳ 실행 중..._",
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
                                                        text=f"🐟 [자동 스케줄] 시뮬레이션 실패: _{t}_")
                                    except Exception as _ue:
                                        self._log(f"[스케줄] chat_update 실패 (무시): {_ue}")
                        except Exception as e:
                            self._log(f"[스케줄] 실행 오류: {e}")

                    threading.Thread(target=_run_sched, daemon=True).start()

            except Exception as e:
                self._log(f"[스케줄] 체크 오류: {e}")
            if self._interruptible_sleep(30):
                break

    # ── 볼트 태그 스캐너 ──────────────────────────────────────────────────────

    def start_vault_tag_scanner(self) -> threading.Thread:
        t = threading.Thread(target=self._vault_tag_scanner, daemon=True)
        t.start()
        return t

    def _vault_tag_scanner(self) -> None:
        """20분마다 볼트에서 #시뮬레이션필요 태그 포함 파일 스캔 후 Slack 알림."""
        cfg = self._cfg
        web = self._web

        notify_channel = cfg.get("slack_notify_channel", "").strip()
        if not notify_channel:
            return
        vault_path_str = cfg.get("vault_path", "").strip()
        if not vault_path_str:
            self._log("[태그스캔] vault_path가 설정되지 않아 스캔을 건너뜁니다.")
            return
        scan_vault_path = Path(vault_path_str)
        if self._interruptible_sleep(60):  # 봇 시작 1분 후부터 스캔
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
                            f"🔖 *#시뮬레이션필요 태그 감지*\n"
                            f"아래 문서에 시뮬레이션 검토 태그가 붙어 있습니다:\n{items}\n\n"
                            f"💡 `🐟 <주제>` 로 시뮬레이션을 시작하세요."
                        ),
                    )
                    self._log(f"[태그스캔] #시뮬레이션필요 {len(found)}건 감지")
            except Exception as e:
                self._log(f"[태그스캔] 오류: {e}")
            if self._interruptible_sleep(1200):  # 20분 주기
                break
