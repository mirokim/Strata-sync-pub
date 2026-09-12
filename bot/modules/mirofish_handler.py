"""
MiroFish 핸들러 모듈
─────────────────────────────────────────────────────────────────────────────
bot.py start() 에서 추출된 MiroFish 관련 함수들:
  - MiroFishHandler.run_single()       → 단일 시뮬레이션 (캐시 → Electron → Python 폴백)
  - MiroFishHandler.handle()           → 요청 파싱 + 분기 (단일/A-vs-B)
  - MiroFishHandler.format_and_post()  → 결과 Slack 게시 + 볼트 저장

공유 상태는 BotContext 데이터클래스를 통해 주입됩니다.
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


# ── 정규식 패턴 ──────────────────────────────────────────────────────────────
MIROFISH_RE = _re.compile(r"시뮬레이션|시뮬", _re.IGNORECASE)
MIRO_PERSONAS_RE = _re.compile(r"(\d{1,2})\s{0,3}명")
MIRO_ROUNDS_RE   = _re.compile(r"(\d{1,2})\s{0,3}라운드로?")
MIRO_SEGMENT_RE  = _re.compile(
    r"(코어\s*게이머|캐주얼\s*게이머|하드코어\s*게이머|라이트\s*유저|신규\s*유저|복귀\s*유저|"
    r"코어\s*유저|캐주얼\s*유저|하드코어\s*유저|[가-힣a-zA-Z]+\s*세그먼트)",
    _re.IGNORECASE,
)
# A vs B 비교 — 반드시 양쪽에 피연산자가 있어야 매칭된다.
# 이전 패턴은 분기마다 서로 다른 그룹을 채워서 `vs` 매칭 시 group(2)가 None 이었고,
# 호출부의 .strip() 에서 AttributeError → bolt 가 삼켜 "준비 중..." 영구 정지.
MIRO_VS_RE = _re.compile(r"(?P<a>\S.*?)\s+vs\.?\s+(?P<b>\S.*)", _re.IGNORECASE)
MIRO_COMPARE_RE = _re.compile(r"(?P<a>\S.*?)\s*(?:와|과)\s+(?P<b>\S.*?)\s*비교")
# '대비' 는 평범한 한국어("비용 대비 효과")에도 쓰이므로 더 엄격하게:
# 양쪽 피연산자(2자 이상) + 비교 의도 어휘가 함께 있을 때만 A/B 모드로 본다.
MIRO_DAEBI_RE = _re.compile(r"(?P<a>\S.*?)\s+대비\s+(?P<b>\S.*)")
MIRO_COMPARE_CUE_RE = _re.compile(r"비교|어느\s*(?:쪽|것)|둘\s*중|더\s*나은|우세")


def match_vs_topics(query: str) -> tuple[str, str] | None:
    """'A vs B' / 'A 와 B 비교' / 'A 대비 B' 를 파싱해 (topic_a, topic_b) 반환."""
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
        # 뒤쪽 피연산자에 붙은 '비교/비교해줘' 는 주제가 아니므로 제거
        b = _re.sub(r"\s*비교[가-힣]*\s*$", "", (m.group("b") or "")).strip()
        if len(a) >= 2 and len(b) >= 2:
            return a, b
    return None
MIRO_PRESET_RE = _re.compile(r"\[(?:프리셋|preset)\s*:\s*([^\]]+)\]", _re.IGNORECASE)

_MIRO_CACHE_TTL = 1800   # 30분
_MIRO_CACHE_MAX = 200    # 캐시 최대 항목 수


# ── 공유 상태 컨테이너 ────────────────────────────────────────────────────────
@dataclass
class BotContext:
    """컴포넌트 간 공유 상태"""
    # conv_history: OrderedDict — 접근/갱신 시 move_to_end 로 LRU 유지
    conv_history: "OrderedDict" = field(default_factory=OrderedDict)
    conv_history_lock: threading.Lock = field(default_factory=threading.Lock)
    active_channels: set = field(default_factory=set)


# ── MiroFish 핸들러 ───────────────────────────────────────────────────────────
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

    # ── 내부 유틸 ────────────────────────────────────────────────────────────
    def _update_msg(self, channel: str, think_ts: str | None, msg: str, blocks: list | None = None):
        """think_ts 메시지를 업데이트."""
        if think_ts:
            try:
                kw: dict = {"channel": channel, "ts": think_ts, "text": msg}
                if blocks:
                    kw["blocks"] = blocks
                self._web.chat_update(**kw)
            except Exception as _ue:
                self._log(f"[MiroFish] chat_update 실패 (무시): {_ue}")

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

    # ── 공개 메서드 ──────────────────────────────────────────────────────────
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
        # 런타임 의존 주입 (start() 클로저에서 제공)
        is_electron_alive_fn: Callable | None = None,
        mirofish_via_electron_fn: Callable | None = None,
        get_anthropic_key_fn: Callable | None = None,
        get_model_for_tag_fn: Callable | None = None,
        mirofish_run_python_fn: Callable | None = None,
        claude_client_cls=None,
    ) -> dict | None:
        """단일 MiroFish 시뮬레이션 실행 (캐시 → Electron → Python 폴백). 결과 dict 반환."""

        def update(msg: str):
            self._update_msg(channel, think_ts, msg)

        # 캐시 체크
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
                update(f"🐟 *캐시 결과 사용* ({age_min}분 전)\n주제: *{topic}*\n_(새 결과를 원하면 '새로 시뮬레이션' 을 입력하세요)_")
                self._log(f"[MiroFish] 캐시 히트: {topic!r} ({age_min}분 경과)")
                return cached_result

        # Electron 위임 + 하트비트 스레드
        if is_electron_alive_fn and not is_electron_alive_fn():
            self._log("[MiroFish] Electron 오프라인 → 시뮬레이션 실행 불가")
            update(
                f"🐟 *MiroFish 시뮬레이션 불가*\n주제: *{topic}*\n\n"
                f"🔴 *샌드박스 맵 앱이 응답하지 않습니다.*\n\n"
                f"*확인해주세요:*\n"
                f"• 샌드박스 맵 앱이 실행 중인지 확인\n"
                f"• 앱 실행 직후라면 30초 정도 기다린 뒤 다시 요청"
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

        # 하트비트: 20초마다 /mirofish-progress 폴링
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
                        f"🐟 *MiroFish 진행 중* (R{cur_round}/{num_rounds})\n"
                        f"주제: *{topic}* | ⏱️ {elapsed}초\n\n"
                        f"{feed_preview}\n\n_...계속 실행 중..._"
                    )
                else:
                    update(
                        f"🐟 *MiroFish 시뮬레이션 진행 중...*\n"
                        f"주제: *{topic}* | 페르소나: {num_personas}명 | 라운드: {num_rounds}회\n"
                        f"_(⏱️ {elapsed}초 경과)_"
                    )
            except Exception:
                update(
                    f"🐟 *MiroFish 시뮬레이션 진행 중...*\n"
                    f"주제: *{topic}* | 페르소나: {num_personas}명 | 라운드: {num_rounds}회\n"
                    f"_(⏱️ {elapsed}초 경과)_"
                )

        result = _result_holder[0]

        # 에러 응답 처리
        _report_str = result.get("report", "") if isinstance(result, dict) else ""
        if isinstance(result, dict) and not result.get("feed") and isinstance(_report_str, str) and (
            _report_str.startswith("오류:") or "이미 실행 중" in _report_str
        ):
            self._log(f"[MiroFish] Electron 오류 응답: {result.get('report', '')[:100]}")
            result = None

        # Python 폴백
        if result is None:
            self._log("[MiroFish] Electron 미실행 → Python 폴백")
            live_key = get_anthropic_key_fn(self._cfg) if get_anthropic_key_fn else self._api_key
            if not live_key:
                return None
            model = get_model_for_tag_fn("chief") if get_model_for_tag_fn else DEFAULT_HAIKU_MODEL
            claude_cli = claude_client_cls(live_key, model) if claude_client_cls else None
            round_count = [0]

            def progress_log(msg: str):
                self._log(msg)
                if "[MiroFish] 라운드" in msg:
                    round_count[0] += 1
                    update(
                        f"🐟 *MiroFish 시뮬레이션*\n주제: *{topic}*\n"
                        f"라운드 {round_count[0]}/{num_rounds} 진행 중..."
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
        """특정 토픽의 캐시 항목을 모두 제거."""
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
        # 런타임 의존 주입
        ask_via_electron_fn: Callable | None = None,
        save_mirofish_to_vault_fn: Callable | None = None,
    ):
        """MiroFish 결과를 Slack에 게시 + 볼트 자동 저장."""
        def update(msg: str, blocks: list | None = None):
            self._update_msg(channel, think_ts, msg, blocks)

        feed   = result.get("feed", [])
        report = result.get("report", "")

        # ── Slack 요약 메시지 ────────────────────────────────────────────────
        prefix = f"*{label}* " if label else ""
        stance_counts: dict[str, int] = {}
        for p in feed:
            s = p.get("stance", "neutral")
            stance_counts[s] = stance_counts.get(s, 0) + 1

        stance_summary = "  ".join(
            f"{STANCE_KO.get(s, s)} {c}건"
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
                "text": {"type": "plain_text", "text": f"🐟  {title_prefix}MiroFish 시뮬레이션 완료", "emoji": True},
            },
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": f"*{topic}*"},
            },
            {
                "type": "section",
                "fields": [
                    {"type": "mrkdwn", "text": f"*페르소나*\n{num_personas}명"},
                    {"type": "mrkdwn", "text": f"*라운드*\n{num_rounds}회"},
                    {"type": "mrkdwn", "text": f"*게시물*\n{len(feed)}개"},
                    {"type": "mrkdwn", "text": f"*반응 분포*\n{stance_summary}"},
                ],
            },
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": "📄 결과 보고서 생성 중..."}],
            },
        ]
        slack_summary = f"🐟 MiroFish 완료: {topic} ({len(feed)}개 반응 · {stance_summary})"
        update(slack_summary, blocks=summary_blocks)

        # ── HTML 보고서 생성 + Slack 업로드 (비동기) ────────────────────────
        def _async_post():
            try:
                _is_fallback = "API 키가 없어" in report or not report.strip()
                _report_summary = "" if _is_fallback else report[:800]
                followup_prompt = (
                    f"다음 MiroFish 유저 반응 시뮬레이션이 완료됐어:\n"
                    f"주제: {topic}\n"
                    + (f"보고서 요약: {_report_summary}\n\n" if _report_summary else "\n")
                    + f"이 결과를 바탕으로 게임 기획자가 더 깊이 탐구할 수 있는 "
                    f"파생 시뮬레이션 주제 2-3개를 짧게 제안해줘.\n"
                    f"각 제안은 한 줄로, 실제로 입력할 수 있는 🐟 명령어 형식으로."
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
                                        "text": f"*💡  후속 시뮬레이션 제안*\n\n{followup.strip()}",
                                    },
                                },
                            ],
                            text=f"💡 후속 시뮬레이션 제안\n\n{followup.strip()}",
                            thread_ts=thread_ts,
                        )
            except Exception as _e:
                self._log(f"[MiroFish] 후속 제안 실패: {_e}")

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
                    self._log(f"[MiroFish] PDF 변환 완료: {pdf_path.name}")
                    upload_path = pdf_path
                except Exception as _pdf_e:
                    self._log(f"[MiroFish] PDF 변환 실패 ({type(_pdf_e).__name__}: {_pdf_e}) → HTML 업로드")
                    upload_path = html_path
                self._upload_file_to_slack(
                    upload_path, channel, thread_ts,
                    title=f"MiroFish — {topic}"
                )
                ext = upload_path.suffix.upper().lstrip(".")
                done_blocks = [
                    {
                        "type": "header",
                        "text": {"type": "plain_text", "text": f"🐟  {title_prefix}MiroFish 시뮬레이션 완료", "emoji": True},
                    },
                    {
                        "type": "section",
                        "text": {"type": "mrkdwn", "text": f"*{topic}*"},
                    },
                    {
                        "type": "section",
                        "fields": [
                            {"type": "mrkdwn", "text": f"*페르소나*\n{num_personas}명"},
                            {"type": "mrkdwn", "text": f"*라운드*\n{num_rounds}회"},
                            {"type": "mrkdwn", "text": f"*게시물*\n{len(feed)}개"},
                            {"type": "mrkdwn", "text": f"*반응 분포*\n{stance_summary}"},
                        ],
                    },
                    {
                        "type": "context",
                        "elements": [{"type": "mrkdwn", "text": f"📎 보고서 {ext} 파일이 아래에 첨부됐어요."}],
                    },
                ]
                update(
                    f"🐟 MiroFish 완료: {topic} · {ext} 보고서 첨부",
                    blocks=done_blocks,
                )
            except Exception as _e:
                self._log(f"[MiroFish] 보고서 생성 실패: {_e}")

            try:
                if save_mirofish_to_vault_fn:
                    saved = save_mirofish_to_vault_fn(topic, report, feed, brief=pm_brief)
                    if saved and saved.get("ok"):
                        fname = saved.get("filename", "")
                        self._log(f"[MiroFish] 볼트 저장 완료: {fname}")
                    elif saved:
                        self._log(f"[MiroFish] 볼트 저장 실패: {saved}")
                    else:
                        self._log("[MiroFish] 볼트 저장 실패 — Electron 미실행 또는 응답 없음")
            except Exception as _e:
                self._log(f"[MiroFish] 볼트 저장 예외: {_e}")

        threading.Thread(target=_async_post, daemon=True).start()

        # 시뮬레이션 결과를 스레드 히스토리에 저장
        hist_key = f"{channel}:{thread_ts or 'dm'}"
        summary_for_hist = report[:1500] if len(report) > 1500 else report
        with self._ctx.conv_history_lock:
            prior = self._ctx.conv_history.get(hist_key, [])
            self._ctx.conv_history[hist_key] = (prior + [
                {"role": "user",      "content": f"[MiroFish 시뮬레이션] 주제: {topic}"},
                {"role": "assistant", "content": f"[시뮬레이션 완료] 보고서:\n{summary_for_hist}"},
            ])[-40:]

    def handle(self, **kwargs):
        """MiroFish 요청 처리 (예외 보호 래퍼).

        내부에서 예외가 나면 bolt 가 조용히 삼켜 '준비 중...' 메시지가 영구 정지한다.
        여기서 잡아 진행 메시지를 실패로 갱신한다.
        """
        think_holder: list[str | None] = [None]
        try:
            return self._handle(think_holder=think_holder, **kwargs)
        except Exception as e:
            self._log(f"[MiroFish] 처리 중 예외: {type(e).__name__}: {e}")
            msg = (
                f"🐟 *MiroFish 처리 중 오류가 발생했어요*\n"
                f"_{type(e).__name__}: {str(e)[:150]}_\n\n다시 시도해주세요."
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
        # 런타임 의존 주입
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
        """MiroFish 시뮬레이션 요청 처리."""
        # 파라미터 파싱
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
                preset_label = f" | 프리셋: {matched['name']}"
                if preset_personas:
                    num_personas = len(preset_personas)
                self._log(f"[MiroFish] 프리셋 '{matched['name']}' 적용 ({num_personas}명)")
            else:
                preset_list = ", ".join(f"'{p.get('name','')}'" for p in saved_presets[:5])
                say(text=f"🐟 프리셋 `{preset_name_raw}`을 찾을 수 없습니다.\n저장된 프리셋: {preset_list or '없음'}",
                    thread_ts=thread_ts)
                return

        # A vs B 비교 모드 감지
        vs_topics = match_vs_topics(query)
        is_vs_mode = vs_topics is not None

        # 주제 추출
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
            say(text="🐟 시뮬레이션할 주제를 함께 입력해주세요.\n예: `🐟 새 캐릭터 출시 반응 5명 3라운드`", thread_ts=thread_ts)
            return

        # "새로 시뮬레이션" → 캐시 무효화
        if _re.search(r"새로\s*시뮬레이션", query):
            self.invalidate_cache(topic)

        seg_label = f" | 세그먼트: {segment}" if segment else ""
        thinking = say(
            text=f"🐟  *MiroFish*  {topic}  —  {num_personas}명 · {num_rounds}회{seg_label}{preset_label}\n_⏳ 시뮬레이션 준비 중..._",
            thread_ts=thread_ts,
        )
        think_ts = (thinking or {}).get("ts")
        if think_holder is not None:
            think_holder[0] = think_ts

        self._log(f"[MiroFish] 주제='{topic}' 페르소나={num_personas} 라운드={num_rounds} 세그먼트={segment!r} 프리셋={bool(preset_personas)} vs={is_vs_mode}")

        # 볼트 RAG 검색으로 배경 컨텍스트 수집
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
                    self._log(f"[MiroFish] RAG 컨텍스트 {len(ctx_parts)}개 문서 주입")

        # 이미지 처리
        sim_images: list[dict] | None = None
        if image_files:
            self._update_msg(channel, think_ts, f"🐟  *MiroFish*  {topic}\n_🖼️ 이미지 처리 중..._")
            images_payload = self._img.download_images(image_files, download_slack_file_fn) if download_slack_file_fn else None
            if images_payload:
                image_direct = (get_electron_settings_fn() if get_electron_settings_fn else None) or {}
                if image_direct.get("imageDirectPass", True):
                    sim_images = images_payload
                    self._log(f"[MiroFish] 이미지 {len(sim_images)}개 직접 전달 모드")
                elif ask_via_electron_fn:
                    desc_answer, _ = ask_via_electron_fn(
                        "첨부된 이미지를 시뮬레이션 참가자들이 참고할 수 있도록 "
                        "객관적으로 설명해주세요. 디자인, 분위기, 특징을 3-5문장으로 묘사하세요.",
                        tag="chief",
                        images=images_payload,
                    )
                    if desc_answer:
                        img_ctx = f"### 첨부 이미지 설명\n{desc_answer.strip()}"
                        context = f"{img_ctx}\n\n{context}" if context else img_ctx
                        self._log(f"[MiroFish] 이미지 텍스트 변환 컨텍스트 주입 ({len(desc_answer)}자)")

        # ── PM AI 브리프 생성 ─────────────────────────────────────────────────
        self._update_msg(channel, think_ts, f"🐟  *MiroFish*  {topic}\n_🧠 브리프 작성 중..._")

        brief_prompt_parts = [
            "MiroFish 시뮬레이션(가상 유저 반응) 브리프를 작성해줘. 600자 이내, 서론 없이.\n\n",
            f"[요청]\n{query}\n",
        ]
        if context:
            brief_prompt_parts.append(f"\n[볼트 참고 문서]\n{context}\n")
        brief_prompt_parts.append(
            "\n형식:\n"
            "**핵심 배경**: 참가자들이 알아야 할 배경 (3-5줄)\n"
            "**관찰 포인트**: 주목할 반응 유형·쟁점 2-3가지\n\n"
            "주의: 주제는 원본 요청 그대로 유지. 볼트 문서 없으면 요청 맥락만으로 작성."
        )

        _brief_result: list[str | None] = [None]
        _brief_done = threading.Event()
        _brief_api_key = (get_anthropic_key_fn(self._cfg) if get_anthropic_key_fn else None) or self._api_key
        _BRIEF_MODEL = DEFAULT_HAIKU_MODEL

        def _run_brief():
            if not _brief_api_key:
                self._log("[MiroFish] API 키 없음 → PM 브리프 생성 건너뜀")
                _brief_done.set()
                return
            try:
                if claude_client_cls:
                    _brief_cli = claude_client_cls(_brief_api_key, _BRIEF_MODEL)
                    _brief_system = "유저 리서치 전문가. MiroFish 시뮬레이션용 구조화 브리프 작성."
                    _brief_result[0] = _brief_cli.complete(_brief_system, "".join(brief_prompt_parts), max_tokens=700)
                    self._log(f"[MiroFish] PM 브리프 생성 완료: {len(_brief_result[0] or '')}자")
            except Exception as _e:
                self._log(f"[MiroFish] PM 브리프 생성 예외: {_e}")
            finally:
                _brief_done.set()

        threading.Thread(target=_run_brief, daemon=True).start()
        _brief_elapsed = 0
        _BRIEF_TIMEOUT = 50
        while not _brief_done.wait(timeout=10):
            _brief_elapsed += 10
            self._update_msg(
                channel, think_ts,
                f"🐟  *MiroFish*  {topic}\n_🧠 브리프 작성 중... ⏱ {_brief_elapsed}s_"
            )
            if _brief_elapsed >= _BRIEF_TIMEOUT:
                self._log("[MiroFish] PM 브리프 타임아웃 → raw context 유지")
                break

        brief_answer = _brief_result[0]
        if brief_answer and brief_answer.strip():
            context = f"[원본 시뮬레이션 주제: {topic}]\n\n" + brief_answer.strip()[:1150]
            self._log(f"[MiroFish] PM 브리프 → context 교체 ({len(context)}자)")
        else:
            self._log("[MiroFish] PM 브리프 없음 → raw RAG context 유지")

        self._update_msg(channel, think_ts, f"🐟  *MiroFish*  {topic}\n_⚙️ 페르소나 생성 중..._")

        # ── A vs B 비교 모드 ──────────────────────────────────────────────────
        if vs_topics:
            topic_a, topic_b = vs_topics
            for pat in (MIROFISH_RE, MIRO_PERSONAS_RE, MIRO_ROUNDS_RE):
                topic_a = pat.sub("", topic_a).strip()
                topic_b = pat.sub("", topic_b).strip()
            topic_a = topic_a.strip(",:. ~\t\n").strip()
            topic_b = topic_b.strip(",:. ~\t\n").strip()

            self._update_msg(
                channel, think_ts,
                f"🐟  *A vs B 비교 시뮬레이션*\n🅰️ {topic_a}\n🅱️ {topic_b}\n_⏳ 두 시나리오 동시 실행 중..._"
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
                    self._log(f"[MiroFish A] 실패: {_e}")

            def run_b():
                try:
                    if mirofish_via_electron_fn:
                        result_b[0] = mirofish_via_electron_fn(topic_b, num_personas, num_rounds, context=context, segment=segment)
                except Exception as _e:
                    err_b.append(str(_e))
                    self._log(f"[MiroFish B] 실패: {_e}")

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
                                text=f"⏳ A vs B 분석 진행 중... ({int(_ab_elapsed) // 60}분 경과)",
                            )
                        except Exception:
                            pass

            if not result_a[0] and not result_b[0]:
                _err_hint = ""
                if err_a: _err_hint += f"\nA 오류: _{err_a[0][:80]}_"
                if err_b: _err_hint += f"\nB 오류: _{err_b[0][:80]}_"
                say(text=(
                    f"🐟 *A vs B 시뮬레이션 — 두 건 모두 실패*\n\n"
                    f"A: _{topic_a}_\nB: _{topic_b}_\n{_err_hint}\n\n"
                    f"*확인해주세요:*\n"
                    f"• 샌드박스 맵 앱이 실행 중인지\n"
                    f"• 이미 다른 시뮬레이션이 진행 중이라면 완료 후 재시도\n"
                    f"• `시뮬 {topic_a}` 로 개별 시뮬레이션부터 테스트"
                ), thread_ts=thread_ts)
                return
            if not result_a[0]:
                _hint = f"\n_(오류: {err_a[0][:60]})_" if err_a else ""
                say(text=(
                    f"⚠️ *A 시뮬레이션 실패 — B 결과만 표시합니다*{_hint}\n\n"
                    f"*🅱️ {topic_b}*\n{result_b[0].get('report', '')}"
                ), thread_ts=thread_ts)
                return
            if not result_b[0]:
                _hint = f"\n_(오류: {err_b[0][:60]})_" if err_b else ""
                say(text=(
                    f"⚠️ *B 시뮬레이션 실패 — A 결과만 표시합니다*{_hint}\n\n"
                    f"*🅰️ {topic_a}*\n{result_a[0].get('report', '')}"
                ), thread_ts=thread_ts)
                return

            rep_a = result_a[0].get("report", "")
            rep_b = result_b[0].get("report", "")

            matrix_answer = None
            if ask_via_electron_fn:
                matrix_prompt = (
                    f"다음은 두 시나리오에 대한 MiroFish 유저 반응 시뮬레이션 결과야.\n\n"
                    f"**시나리오 A: {topic_a}**\n{rep_a[:2000]}\n\n"
                    f"**시나리오 B: {topic_b}**\n{rep_b[:2000]}\n\n"
                    f"두 시나리오를 비교하는 간결한 매트릭스를 작성해줘:\n"
                    f"- 핵심 차이점 3가지 (표 형식)\n"
                    f"- 어떤 시나리오가 더 긍정적 반응을 얻었는지와 이유\n"
                    f"- 최종 추천 (A/B 또는 절충안)\n"
                    f"2-3문단으로 간결하게."
                )
                matrix_answer, _ = ask_via_electron_fn(matrix_prompt, tag="chief")

            vs_blocks = [
                {
                    "type": "header",
                    "text": {"type": "plain_text", "text": "🐟  A vs B 비교 시뮬레이션 결과", "emoji": True},
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
                        "text": {"type": "mrkdwn", "text": f"*🔍  PM 비교 분석*\n{matrix_answer.strip()}"},
                    },
                ]
            comparison_fallback = f"🐟 A vs B 비교 결과\n🅰️ {topic_a}\n🅱️ {topic_b}"
            if think_ts:
                try:
                    self._web.chat_update(channel=channel, ts=think_ts, blocks=vs_blocks, text=comparison_fallback)
                except Exception:
                    say(blocks=vs_blocks, text=comparison_fallback, thread_ts=thread_ts)
            else:
                say(blocks=vs_blocks, text=comparison_fallback, thread_ts=thread_ts)
            return

        # ── 단일 시뮬레이션 ───────────────────────────────────────────────────
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
                    text=f"🐟  *MiroFish*  {topic}  —  {len(result.get('feed', []))}개 반응 수집\n_📝 보고서 작성 중..._",
                )
            except Exception:
                pass

        if not result:
            self._log("[MiroFish] 시뮬레이션 결과 없음 → 실패 알림")
            fail_msg = (
                f"🐟 *MiroFish 시뮬레이션 실패*\n주제: _{topic}_\n\n"
                f"*가능한 원인:*\n"
                f"• 샌드박스 맵 앱이 꺼져 있거나 볼트가 로드되지 않음\n"
                f"• 다른 시뮬레이션이 이미 진행 중 (완료 후 재시도)\n"
                f"• 시뮬레이션 타임아웃 (복잡한 주제는 시간이 더 걸릴 수 있음)\n\n"
                f"`시뮬 {topic}` 으로 다시 요청하거나, 앱 상태를 확인해주세요."
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
