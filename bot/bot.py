"""
Strata Sync Source Management Bot — 볼트 관리 + Slack 봇 통합 GUI
──────────────────────────────────────────────────────────────────
기능:
  - vault MD 파일 스캔 + keyword_index.json 자동 관리
  - wikilink 주입 + 클러스터 링크 강화
  - index_YYYYMMDD.md 자동 갱신 (타이머 1h / 5h)
  - index MD 파일 브라우저 (생성된 인덱스 열람)
  - Slack 봇 (Socket Mode, 페르소나 + RAG)

실행:
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

# .env 파일 로드 (시크릿 우선순위: .env > config.json > UI 입력)
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass  # python-dotenv 없으면 env vars만 사용

# 모듈 경로 추가
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

CONFIG_PATH = Path(__file__).parent / "config.json"  # --config 인자로 오버라이드 가능

# 공유 상태 동기화 락 (봇 전역에서 단일 인스턴스 사용)
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
    """쿼리 말미의 의도 동사(정리/분석/비교 등)를 태그로 추출. 없으면 None."""
    m = _INTENT_VERB_RE.search(q.strip())
    if not m:
        return None
    return _INTENT_LABELS.get(m.group(1))


def _clean_search_query(q: str) -> str:
    """
    검색용 쿼리에서 메타 지시 표현을 제거합니다.
    BM25/TF-IDF가 "보고서", "분석", "방향" 같은 볼트 공통 단어에 오염되지 않도록 보정.

    적용 순서:
      1. 복합 메타동사: "분석해줘", "정리해줘", "제안해줘" 등
      2. 메타명사+동작: "보고서 써줘", "리포트 만들어줘"
      3. 순수 요청 어미: "알려줘", "찾아줘", "해줘", "줘" 등
    원본이 전부 제거되면 원본 그대로 반환.
    원본의 의도 동사는 호출자 측 `_extract_intent()` 로 별도 보존 가능.
    """
    out = q.strip()
    # 1. 복합 메타동사 (동사 자체가 메타 의미 + 요청 어미)
    out = _INTENT_VERB_RE.sub('', out)
    # 2. 메타명사 + 동작동사: "보고서 써줘", "리포트 만들어줘"
    out = re.sub(
        r'\s*(보고서|리포트|report)\s*[\w가-힣]*(써|만들|작성|export|pdf)[\w가-힣\s]*$',
        '', out, flags=re.IGNORECASE,
    )
    # 3. 순수 요청 어미
    out = re.sub(
        r'\s*(알려줘|알려주세요|찾아줘|찾아주세요|말해줘|말해주세요|해줘|해주세요|줘|주세요|부탁해|부탁합니다)\s*$',
        '', out, flags=re.IGNORECASE,
    )
    out = out.strip()
    return out if out else q.strip()


def _classify_query(q: str) -> str:
    """'simple' (BM25 만으로 충분) 또는 'complex' (rewrite/decompose 가치 있음) 판정.

    Complex 조건 (하나라도 충족):
      - 의도 동사(정리/분석/비교 등) 포함 — 응답 스타일 판별용이라 rewrite 가치 있음
      - 정제 후 길이 > 15자 OR 공백 > 2 OR 문장 부호 포함
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
    """간단한 LRU + TTL 캐시. 쓰레드 안전은 부족하지만 슬랙봇 단일 인터프리터 환경에서 충분."""
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


# LLM이 검색 키워드 대신 대화형 응답을 돌려줄 때 걸러내기 위한 가드
# (예: "좀 더 구체적인 내용을 알려주시면 도움이 될 것 같습니다 😊")
_CHAT_RESPONSE_PATTERNS = re.compile(
    r"(?:"
    # 이모지 — VS16 및 확장 픽토그램 포함 (Extended-A/B, Symbols & Pictographs, Dingbats 등)
    r"[\U0001F300-\U0001FAFF\u2600-\u27BF\U0001F000-\U0001F1FF]"
    r"|\u2705|\U0001F389|\U0001F680|\U0001F4A1|\u2728|\U0001F525|\U0001F44D|\U0001F64C|\U0001F64F"  # ✅🎉🚀💡✨🔥👍🙌🙏 백업 직접 매칭
    r"|\*\*"                                 # 마크다운 볼드
    r"|[.!?？。！]\s|[.!?？。！]$"            # 종결부호(문장)
    r"|(?:습니다|하세요|주세요|세요|십시오|네요|까요|죠|드려요|에요|예요|이에요)(?:[\s.?!]|$)"
    r"|(?:죄송|제공해|알려주시|알려드|도움|필요하시|내용이\s*없)"
    r")"
)


# 한글 음절 (가~힣)
_HANGUL_SYLLABLE_RE = re.compile(r"[가-힣]")


def _is_valid_search_query(s: str) -> bool:
    """LLM 출력이 대화형 응답이 아닌 '검색 키워드'로 사용 가능한지 판정.

    한글은 음절 기준으로 따로 판정한다. 이 프로젝트의 핵심 키워드가
    '밸런스', '캐릭터', '사운드', 'GDD', '루모', '에녹', '캐릭터G' 처럼 짧아서
    글자 수 3자 이하를 일괄 무효 처리하면 전부 버려진다.

    실패 조건: 빈 문자열, 80자 이상, 한글 2음절 미만(한글 없으면 2자 미만),
    이모지/마크다운/종결어미/사과·안내 어구 포함.
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
    # env vars override config.json (시크릿은 .env에서만 관리)
    if os.getenv("ANTHROPIC_API_KEY"):
        cfg["claude_api_key"] = os.environ["ANTHROPIC_API_KEY"]
    if os.getenv("SLACK_BOT_TOKEN"):
        cfg["slack_bot_token"] = os.environ["SLACK_BOT_TOKEN"]
    if os.getenv("SLACK_APP_TOKEN"):
        cfg["slack_app_token"] = os.environ["SLACK_APP_TOKEN"]
    # RAG HTTP 인증 토큰 — Electron이 bot/config.json 에 주입
    _rag_set_auth_token(cfg.get("rag_auth_token"))
    return cfg


_SECRET_KEYS = {"claude_api_key", "slack_bot_token", "slack_app_token"}

def save_config(cfg: dict):
    # 로컬 config.json에 전체 저장 (시크릿 포함).
    # env var가 있으면 load_config에서 덮어씌우므로 env 우선순위는 유지됨.
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
            self.log("❌ 볼트 경로가 없거나 존재하지 않습니다.")
            return

        self.log(f"\n{'='*50}")
        self.log(f"🚀 실행 시작: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        self.log(f"볼트: {vault_path}")

        # 1. 볼트 스캔
        self.log("\n📂 볼트 스캔 중...")
        docs = scan_vault(vault_path)
        self.log(f"  총 {len(docs)}개 MD 파일 발견")

        active_folders = find_active_folders(vault_path)
        self.log(f"  active 폴더: {len(active_folders)}개 → {[Path(f).name for f in active_folders]}")

        # 2. Keyword store 로드
        store = KeywordStore(vault_path, cfg.get("keyword_index_path", KEYWORD_INDEX_REL_PATH))
        try:
            loaded = store.load()
        except KeywordStoreError as e:
            # 로드 실패 상태로 진행하면 save() 가 기존 인덱스 전체를 덮어쓴다 → 중단
            self.log(f"\n❌ 키워드 인덱스 로드 실패 — 작업 중단 (인덱스 보호): {e}")
            raise
        self.log(f"\n🔑 키워드 인덱스: {'로드됨' if loaded else '새로 생성'} ({store.count()}개 키워드)")

        # 3. Claude로 새 키워드 발견 (API key 있을 때만)
        if api_key:
            self.log("\n🤖 Claude Haiku — 키워드 발견 중...")
            try:
                client = ClaudeClient(api_key, cfg.get("worker_model", DEFAULT_HAIKU_MODEL))
                # active 폴더의 최신 문서 샘플
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
                    self.log(f"  {added}개 키워드 발견/갱신")
                else:
                    self.log("  active 폴더에 문서 없음 — 스킵")
            except Exception as e:
                self.log(f"  ⚠️ Claude API 오류: {e}")
        else:
            self.log("\n⚠️  API 키 없음 — 키워드 발견 스킵 (기존 인덱스 사용)")

        store.save()
        self.log(f"  키워드 인덱스 저장 완료 ({store.count()}개)")

        # 4. active 폴더별 wikilink 처리
        keyword_map = store.to_inject_map()
        total_updated = 0
        total_hits: dict = {}

        for folder in active_folders:
            self.log(f"\n🔗 wikilink 처리: {Path(folder).name}")
            result = process_folder(folder, keyword_map, log_fn=self.log)
            total_updated += result["updated"]
            for kw, cnt in result["keyword_hits"].items():
                total_hits[kw] = total_hits.get(kw, 0) + cnt

        self.log(f"\n  총 {total_updated}개 파일 업데이트")
        if total_hits:
            top = sorted(total_hits.items(), key=lambda x: -x[1])[:5]
            self.log(f"  키워드 히트 TOP5: {', '.join(f'{k}({v})' for k,v in top)}")

        # 5. index 갱신 (최신 active 폴더)
        if active_folders:
            self.log(f"\n📋 인덱스 갱신: {Path(active_folders[0]).name}")
            generate_index(active_folders[0], log_fn=self.log)

        self.log(f"\n✅ 완료: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
        self.on_done()

    def run_once(self):
        def _safe():
            try:
                self._run_cycle()
            except Exception as e:
                self.log(f"❌ 치명적 오류: {e}")
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
                    self.log(f"❌ 치명적 오류: {e}")
                finally:
                    self.on_done()
                # interval 대기 (10초마다 stop 체크)
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
    """Slack SocketModeHandler를 백그라운드 스레드로 관리."""

    def __init__(self, cfg: dict, log_fn, on_status_fn):
        self.cfg = cfg
        self._log = log_fn          # thread-safe (after() 기반)
        self._on_status = on_status_fn
        self._handler = None
        self._thread: threading.Thread | None = None
        self._running = False       # stop() 호출 시 재연결 루프 중단

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> bool:
        """슬랙 봇 시작. 성공 시 True."""
        try:
            from slack_bolt import App
            from slack_bolt.adapter.socket_mode import SocketModeHandler
            from slack_sdk import WebClient
        except ImportError:
            self._log("❌ slack-bolt 패키지 필요: pip install slack-bolt")
            return False

        from modules.persona_config import resolve_persona
        from modules.rag_simple import search_vault, build_rag_context, apply_hotness_rerank, record_doc_access
        from modules.graph_expand import expand_via_wikilinks
        from modules.rag_electron import search_via_electron, get_model_for_tag, ask_via_electron, get_images_via_electron, mirofish_via_electron, get_electron_settings, get_api_key_from_settings, save_mirofish_to_vault, is_electron_alive
        from modules.slack_utils import extract_slack_files, download_slack_file
        from modules.multi_agent_rag import build_multi_agent_context
        from modules.web_search import search_web, build_web_context

        cfg = self.cfg
        bot_token  = cfg.get("slack_bot_token", "").strip()
        app_token  = cfg.get("slack_app_token", "").strip()
        vault_path = cfg.get("vault_path", "").strip()
        # api_keys 모듈이 우선순위(Electron > config > env)를 단일 관리
        api_key    = get_anthropic_key(cfg)
        top_n      = cfg.get("slack_rag_top_n", 5)

        if not bot_token or not app_token:
            self._log("❌ slack_bot_token / slack_app_token 이 설정에 없습니다.")
            return False
        if not vault_path or not Path(vault_path).exists():
            self._log(f"❌ 볼트 경로 없음: {vault_path!r}")
            return False

        _re = re  # alias for local compiled patterns (re imported at top-level)
        web = WebClient(token=bot_token)
        app    = App(token=bot_token)
        _report_builder = ReportBuilder(web, self._log)
        _img_handler = SlackImageHandler(web, bot_token, api_key, self._log)

        PERSONA_TAG_RE = _re.compile(r"\[([^\]]+)\]")
        BOT_MENTION_RE = _re.compile(r"<@[A-Z0-9]+>")
        # MiroFish 자연어 감지: 🐟 이모지, mirofish 키워드, 또는 시뮬레이션 동작어
        # 트리거: "시뮬레이션" 또는 "시뮬" (단독 키워드)
        MIROFISH_RE = _re.compile(
            r"시뮬레이션|시뮬",
            _re.IGNORECASE,
        )
        # 보고서 생성 인텐트: chatStore.ts의 REPORT_INTENT_RE와 동일
        REPORT_INTENT_RE = _re.compile(
            r"보고서.{0,20}(써|만들|작성|뽑아|정리|export|pdf)|(대화|채팅).{0,20}보고서|보고서.{0,20}(대화|채팅)|(pdf|PDF).{0,20}(만들|보고서|저장|export)",
            _re.IGNORECASE,
        )

        # 페르소나 수: "5명", "10명 으로"
        MIRO_PERSONAS_RE = _re.compile(r"(\d{1,2})\s{0,3}명")
        # 라운드 수: "3라운드", "5 라운드", "3라운드로"
        MIRO_ROUNDS_RE   = _re.compile(r"(\d{1,2})\s{0,3}라운드로?")
        # 타겟 세그먼트: "코어", "캐주얼", "하드코어", "라이트", "신규", "복귀" 유저
        MIRO_SEGMENT_RE  = _re.compile(
            r"(코어\s*게이머|캐주얼\s*게이머|하드코어\s*게이머|라이트\s*유저|신규\s*유저|복귀\s*유저|"
            r"코어\s*유저|캐주얼\s*유저|하드코어\s*유저|[가-힣a-zA-Z]+\s*세그먼트)",
            _re.IGNORECASE,
        )
        # A vs B 비교: "X vs Y", "X 대비 Y", "X 와 Y 비교"
        MIRO_VS_RE = _re.compile(
            r"(.+?)\s+(?:vs\.?|대비|와\s+(.+?)\s+비교)\s+(.+)",
            _re.IGNORECASE,
        )
        # 프리셋 참조: "[프리셋:이름]" 또는 "[preset:name]"
        MIRO_PRESET_RE = _re.compile(r"\[(?:프리셋|preset)\s*:\s*([^\]]+)\]", _re.IGNORECASE)
        # 스레드/DM별 대화 히스토리 (key: "channel:thread_ts", 최대 키 1000개)
        _MAX_HISTORY_KEYS = 1000
        # 공유 상태 컨테이너 (MiroFishHandler와 공유)
        _bot_ctx = BotContext()
        _conv_history      = _bot_ctx.conv_history
        _conv_history_lock = _bot_ctx.conv_history_lock

        # ── 슬랙 사용자별 장기 기억 ──────────────────────────────────────────
        _mem_store = UserMemoryStore(self._log)
        _mem_store.load()

        # ── MiroFish 핸들러 초기화 ────────────────────────────────────────────
        # say_fn / download_slack_file 은 런타임에 호출부에서 주입 (핸들러 생성 시점엔 미정)
        _miro_handler = MiroFishHandler(
            web_client=web,
            api_key=api_key,
            cfg=cfg,
            bot_context=_bot_ctx,
            report_builder=_report_builder,
            img_handler=_img_handler,
            say_fn=None,   # 런타임 주입
            log_fn=self._log,
        )

        # ── 스케줄러 초기화 ───────────────────────────────────────────────────
        _scheduler = SlackScheduler(web, cfg, _bot_ctx, _miro_handler, self._log)

        def parse_msg(text: str):
            text = BOT_MENTION_RE.sub("", text).strip()
            tag = "chief"
            m = PERSONA_TAG_RE.search(text)
            if m:
                tag = m.group(1).strip()
                text = text[:m.start()] + text[m.end():]
            return tag, text.strip()

        _SLACK_MAX = 3800  # Slack 블록 실질 한도 (4000자 버퍼)
        # chat.update 호출 시 blocks=[] 로 원본 block section 3000자 제한을 우회하므로
        # text 한도를 3500까지 완화 (바이트 기준도 40KB 여유).
        _SLACK_UPDATE_MAX = 3500

        def _say_long(text: str, say_fn, thread_ts: str | None, *, update_ts: str | None = None, channel: str | None = None):
            """4000자 초과 텍스트를 자동 분할하여 게시. update_ts가 있으면 첫 청크는 chat_update."""
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
            # 첫 청크가 chat.update 한도를 초과하면 update를 쓰지 않고 say로 처리.
            # (update는 "완료" 한 줄로 바꾸고, 본문은 새 메시지로 전송)
            if update_ts and channel and chunks and len(chunks[0]) > _SLACK_UPDATE_MAX:
                try:
                    web.chat_update(channel=channel, ts=update_ts, text="✅ 답변 준비 완료", blocks=[])
                except Exception as e:
                    self._log(f"[chat_update] 상태 정리 실패 (무시): {str(e)[:200]}")
                update_ts = None  # 이후 전부 say
            for i, chunk in enumerate(chunks):
                suffix = f"\n\n_({i+1}/{len(chunks)})_" if len(chunks) > 1 else ""
                msg = chunk + suffix
                if i == 0 and update_ts and channel:
                    try:
                        # blocks=[] 로 원본 section block 3000자 제한 우회
                        web.chat_update(channel=channel, ts=update_ts, text=msg, blocks=[])
                    except Exception as e:
                        self._log(f"[chat_update] 실패 ({str(e)[:200]}), say 폴백")
                        say_fn(text=msg, thread_ts=thread_ts)
                else:
                    say_fn(text=msg, thread_ts=thread_ts)

        def _generate_report_html(title: str, content: str) -> Path:
            """LLM 보고서 마크다운을 wkhtmltopdf 호환 HTML 파일로 저장. 파일 경로 반환."""
            return _report_builder.generate_report_html(title, content)

        def _upload_file_to_slack(filepath: Path, channel: str, thread_ts: str | None, title: str = "") -> bool:
            """파일을 Slack에 업로드. 성공 여부 반환."""
            return _report_builder.upload_file_to_slack(filepath, channel, thread_ts, title)

        def _handle_mirofish(query: str, say, channel: str, thread_ts: str | None, image_files: list | None = None):
            """MiroFish 시뮬레이션 요청 처리 — MiroFishHandler 위임."""
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

        # 봇이 응답한 채널 추적 — 종료 시 "업데이트중" 메시지 전송용
        _active_channels = _bot_ctx.active_channels

        def respond(text: str, say, channel: str, thread_ts: str | None = None, files: list | None = None, user_id: str | None = None):
            """채널 멘션 / DM 공통 응답 처리."""
            with _active_channels_lock:
                _active_channels.add(channel)
            tag, query = parse_msg(text)

            # ── 1. 이미지 처리 ──────────────────────────────────────────────────
            image_files = [f for f in (files or []) if f.get("mimetype", "").startswith("image/")]

            # 검색용 정제 쿼리: 메타 지시 표현 제거 → BM25/TF-IDF 오염 방지
            # ("보고서 써줘", "분석해줘", "방향 제안해줘" 같은 요청 동사구 제거)
            # 최종 LLM 생성에는 원본 query 유지 (보고서·분석 등 지시 의미가 필요)
            search_query = _clean_search_query(query)
            # 의도 태그: 정제 전 원본에서 추출 → 최종 LLM 프롬프트에 주입
            intent_tag = _extract_intent(query)
            if search_query != query:
                self._log(f"[쿼리정제] '{query[:40]}' → '{search_query[:40]}'" + (f" [intent={intent_tag}]" if intent_tag else ""))

            if not query and not image_files:
                say(text="무엇을 도와드릴까요?", thread_ts=thread_ts)
                return
            if not query:
                query = "이 이미지를 분석해주세요."

            # 도움말 명령
            if _re.search(r"^!도움말$|^!help$", query.strip(), _re.IGNORECASE):
                settings_data = get_electron_settings() or {}
                saved_presets = settings_data.get("presets", [])
                if saved_presets:
                    preset_lines = "  " + "  /  ".join(
                        f"`{p['name']}` ({len(p.get('personas', []))}명)" for p in saved_presets[:6]
                    )
                else:
                    preset_lines = "  _(아직 저장된 프리셋이 없어요. Strata Sync Settings > MiroFish 에서 만들 수 있어요)_"
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
                                "text": "볼트에 쌓인 게임 기획 문서를 기반으로 질문에 답하고, 가상의 유저 반응을 시뮬레이션해드릴 수 있어요.",
                            },
                        },
                        {"type": "divider"},
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": (
                                    "*💬  그냥 물어보세요*\n"
                                    "> _신규 던전 콘텐츠 기획 방향이 뭐야?_\n"
                                    "> _[아트] 이번 캐릭터 비주얼 컨셉 정리해줘_\n"
                                    "> _[기획] 이 이미지 기반으로 밸런스 의견 줘_  _(+ 이미지 첨부)_"
                                ),
                            },
                        },
                        {
                            "type": "context",
                            "elements": [{"type": "mrkdwn", "text": "태그 없으면 PM이 답변 — `[아트]` `[기획]` `[기술]` 태그로 담당자 지정 가능"}],
                        },
                        {"type": "divider"},
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": (
                                    "*🐟  MiroFish — 유저 반응 시뮬레이션*\n"
                                    "메시지에 `시뮬레이션` 또는 `시뮬`이 포함되면 자동 실행돼요.\n\n"
                                    "`신규 캐릭터 출시 시뮬레이션`  — 기본 (5명, 3라운드)\n"
                                    "`가격 인상 발표 시뮬레이션 10명 5라운드`  — 인원/라운드 지정\n"
                                    "`PvP 업데이트 시뮬 보고서`  — 피드 없이 보고서만\n"
                                    "`신규 던전 코어 게이머 시뮬레이션`  — 타겟 세그먼트 지정\n"
                                    "`A vs B 시뮬레이션`  — 두 시나리오 동시 비교\n"
                                    "`... 새로 시뮬레이션`  — 30분 캐시 무시하고 새로 실행"
                                ),
                            },
                        },
                        {
                            "type": "context",
                            "elements": [{"type": "mrkdwn", "text": f"*저장된 프리셋*  {preset_lines}"}],
                        },
                        {"type": "divider"},
                        {
                            "type": "section",
                            "text": {
                                "type": "mrkdwn",
                                "text": (
                                    "*⌨️  슬래시 커맨드*\n"
                                    "`/ask 질문`  `/remember`  `/status`  `/help`\n\n"
                                    "*⚡  글로벌 단축키*\n"
                                    "`ask_sandbox`  — 어느 채널에서든 팝업으로 질문 입력"
                                ),
                            },
                        },
                        {
                            "type": "context",
                            "elements": [{"type": "mrkdwn", "text": "🔖 볼트 문서에 `#시뮬레이션필요` 태그 → 자동 알림   •   ⏰ 스케줄 자동 실행: Settings > MiroFish"}],
                        },
                    ],
                    text="🗺️ Strata Sync Bot 사용법",
                    thread_ts=thread_ts,
                )
                return

            # MiroFish 시뮬레이션 요청 감지 → 별도 핸들러로 분기
            if MIROFISH_RE.search(query):
                _handle_mirofish(query, say, channel, thread_ts, image_files=image_files)
                return

            persona = resolve_persona(tag)
            emoji   = persona.get("emoji", "🤖")
            name    = persona.get("name", tag)

            # thinking 메시지 1개만 생성 — vision/RAG 모두 같은 ts로 업데이트
            status = "✦ 이미지 분석 중..." if image_files else "✦ 깊게 생각하는 중..."
            thinking = say(text=f"{status}", thread_ts=thread_ts)
            think_ts = (thinking or {}).get("ts")
            progress = ProgressUpdater(
                web, channel, think_ts, name=name, emoji=emoji,
                is_electron=True, log_fn=self._log,
            ) if think_ts else None

            # 이미지가 있으면: 다운로드 → Electron에 직접 전달 (LLM이 이미지 + RAG 문서 함께 분석)
            images_payload: list[dict] = []
            if image_files:
                self._log(f"[Vision] {name}: 이미지 {len(image_files)}개 다운로드 중...")
                images_payload = _img_handler.download_images(image_files, download_slack_file)
                if images_payload:
                    self._log(f"[Vision] {len(images_payload)}개 Electron으로 전달")
                    img_desc = _img_handler.describe_images(images_payload, query)
                    if img_desc:
                        self._log(f"[Vision] 이미지 묘사 완료 ({len(img_desc)}자) → RAG 쿼리 보강")
                        query = f"{query}\n\n[첨부 이미지 묘사]\n{img_desc}"
                else:
                    self._log("[Vision] 이미지 다운로드 0건 → 텍스트만으로 RAG 폴백")

            import time as _time
            _t0 = _time.monotonic()
            def _elapsed() -> str:
                return f"{_time.monotonic() - _t0:.1f}s"

            self._log(f"[Slack] {name}: {query[:80]}")

            # ── 2. RAG 검색 ─────────────────────────────────────────────────────
            # 명시적 이미지 요청 감지 → /images 검색
            vault_image_paths: list[str] = []
            is_img_req = any(w in query for w in _IMAGE_WORDS)
            if is_img_req:
                # 이미지/동작 단어 제거 → 주제어(캐릭터명 등)만 남김
                img_query = query
                for w in _IMAGE_WORDS + _ACTION_WORDS:
                    img_query = img_query.replace(w, " ")
                img_query = " ".join(img_query.split()).strip("~,. !?") or query
                vault_image_paths = get_images_via_electron(img_query)
                self._log(f"[Image] 명시적 검색 '{img_query[:40]}': {len(vault_image_paths)}개")

            # 스레드별 히스토리 조회 (DM은 channel을 key로 사용)
            hist_key = f"{channel}:{thread_ts or 'dm'}"
            with _conv_history_lock:
                history = list(_conv_history.get(hist_key, []))
                # LRU: 접근 시 최근 사용으로 이동 (OrderedDict)
                if hist_key in _conv_history:
                    try:
                        _conv_history.move_to_end(hist_key)
                    except AttributeError:
                        pass  # dict 폴백 (이전 상태 호환)
            if history:
                self._log(f"[Slack] 히스토리 {len(history)//2}턴 복원")

            claude = None  # 폴백에서 덮어씀, 사용자 기억 갱신에 사용
            # 1순위: Electron /ask — Strata Sync의 BFS RAG + LLM 파이프라인 그대로 사용
            if progress: progress.start("electron")

            # Electron HTTP 준비 확인 (3초 이내 /settings 응답)
            # TCP만 열려있고 HTTP 미응답 = 재시동 중 → 즉시 폴백 (65초 대기 방지)
            _electron_alive = is_electron_alive()
            _electron_timed_out = False
            if not _electron_alive:
                if progress:
                    progress.set_message("🔴 샌드박스 맵 앱이 꺼져 있거나 시작 중이에요. Python RAG로 처리 중...")
                self._log(f"[{_elapsed()}] [RAG] Electron HTTP 미응답 → 폴백")
                answer, auto_image_paths = None, []
            else:
                self._log(f"[{_elapsed()}] [RAG] Electron /ask 호출 중...")
                answer, auto_image_paths = ask_via_electron(query, tag=tag, history=history, images=images_payload or None)
                if not answer:
                    # 호출 후에도 HTTP가 살아있으면 '빈 응답', 아니면 '타임아웃/연결끊김'
                    _still_alive = is_electron_alive()
                    _electron_timed_out = not _still_alive
                    _electron_empty = _still_alive  # 서버는 살았지만 answer 가 "" 또는 None
                    if progress:
                        progress.set_message(
                            "📭 앱이 빈 응답을 반환했어요. Python RAG로 처리 중..."
                            if _electron_empty else
                            "⏱️ 앱 응답 시간 초과. Python RAG로 처리 중..."
                        )
                else:
                    _electron_empty = False

            if progress: progress.done("electron")
            if answer:
                self._log(f"[{_elapsed()}] [RAG] Electron /ask 성공 ({len(answer)}자)")
                if auto_image_paths:
                    self._log(f"[{_elapsed()}] [Image] 자동 이미지 {len(auto_image_paths)}개")
                final = answer
            else:
                auto_image_paths = []
                # 폴백: Python 자체 RAG + 서브 에이전트 10개 + Claude
                if locals().get("_electron_empty"):
                    self._log(f"[{_elapsed()}] [RAG] Electron /ask 빈 응답 → 서브 에이전트 RAG")
                elif _electron_timed_out:
                    self._log(f"[{_elapsed()}] [RAG] Electron /ask 타임아웃 → 서브 에이전트 RAG")
                else:
                    self._log(f"[{_elapsed()}] [RAG] Electron 미실행 → 서브 에이전트 RAG")
                # 폴백 경로는 세분화된 스텝으로 표시
                if progress:
                    progress._remaining = ["search", "analyze", "webcheck", "answer"]
                # Claude 클라이언트 초기화 (쿼리 리라이팅·멀티쿼리·분석에 공통 사용)
                # slack_model 설정 우선, 없으면 페르소나 태그별 모델 사용
                _slack_model = self.cfg.get("slack_model")
                model = _slack_model if _slack_model else get_model_for_tag(tag)
                live_key = get_anthropic_key(self.cfg) or api_key
                claude = ClaudeClient(live_key, model) if live_key else None
                self._log(f"[{_elapsed()}] [모델] {model}")

                # ── 쿼리 복잡도 분류 — Simple 은 rewrite/decompose 스킵 ──
                _complexity = _classify_query(search_query)
                if _complexity == 'simple':
                    self._log(f"[쿼리분류] simple → rewrite/decompose 스킵 ('{search_query[:40]}')")

                # ── 쿼리 리라이팅 (Complex 만, LRU 캐시 + few-shot + 1회 재시도) ──
                if claude and _complexity == 'complex':
                    _cached = _rewrite_cache.get(search_query)
                    if _cached is not None:
                        if _cached != search_query:
                            self._log(f"[쿼리리라이팅] 캐시 적중: '{search_query[:40]}' → '{_cached[:40]}'")
                            search_query = _cached
                    else:
                        _rewrite_sys = (
                            "입력 문장을 한국어 검색 키워드로만 변환해 OUTPUT 에 출력한다.\n\n"
                            "규칙:\n"
                            "- 동사·어미·조사 제거, 핵심 명사만\n"
                            "- 20자 이내, 공백 구분\n"
                            "- 설명·문장·이모지·마크다운 금지\n"
                            "- 변환이 어려우면 입력의 명사구만 복사\n\n"
                            "예시 1:\n"
                            "INPUT: 캐릭터E 컨셉과 관련해서 디렉터 피드백을 정리해봐\n"
                            "OUTPUT: 캐릭터E 컨셉 디렉터 피드백\n\n"
                            "예시 2:\n"
                            "INPUT: 최근 회의에서 주요한 의사결정이 뭐였지?\n"
                            "OUTPUT: 최근 회의 주요 의사결정\n\n"
                            "예시 3:\n"
                            "INPUT: 지난달 Strata Sync 성능 이슈 있었나\n"
                            "OUTPUT: Strata Sync 성능 이슈"
                        )
                        _rewrite_user = f"INPUT: {search_query}\nOUTPUT:"
                        _rewritten = None
                        for _attempt in range(2):
                            try:
                                _raw = claude.complete(_rewrite_sys, _rewrite_user, max_tokens=40).strip()
                                # "OUTPUT:" 프리픽스 제거 (모델이 따라 쓸 수도 있음)
                                if _raw.upper().startswith('OUTPUT:'):
                                    _raw = _raw[7:].strip()
                                # 따옴표 감싸기 제거
                                _raw = _raw.strip('"\'').strip()
                                if _is_valid_search_query(_raw):
                                    _rewritten = _raw
                                    break
                                else:
                                    self._log(f"[쿼리리라이팅] 무효 응답 (시도 {_attempt+1}): '{_raw[:40]}'")
                            except Exception as _e:
                                self._log(f"[쿼리리라이팅] 예외 (시도 {_attempt+1}): {_e}")
                        if _rewritten:
                            _rewrite_cache.set(search_query, _rewritten)
                            self._log(f"[쿼리리라이팅] '{search_query[:40]}' → '{_rewritten[:40]}'")
                            search_query = _rewritten
                        else:
                            # 재시도 실패 — 원본을 캐시에 기록해 재시도 비용 재발 방지 (TTL 내)
                            _rewrite_cache.set(search_query, search_query)

                # 서브 에이전트가 최대 10개 문서를 분석하므로 top_n*2 검색
                fetch_n = max(top_n * 2, 10)
                if progress: progress.start("search")
                results = search_via_electron(search_query, top_n=fetch_n)
                if results is None:
                    results = search_vault(search_query, vault_path, top_n=fetch_n)
                    self._log(f"[{_elapsed()}] [RAG] simple search ({len(results)}건)")
                else:
                    self._log(f"[{_elapsed()}] [RAG] Electron TF-IDF ({len(results)}건)")

                # 쿼리에 "최신/최근/올해 연도" 가 있으면 날짜 기준 부스팅
                # BM25는 날짜를 모르므로, 최신 문서가 내용이 짧아도 상위에 오도록 보정
                _cur_year = str(datetime.now().year)
                _prev_year = str(datetime.now().year - 1)
                if results and any(w in query for w in ["최신", "최근", _cur_year]):
                    # 부스팅은 score 에 직접 반영한다. 여기서 정렬해봐야
                    # 아래 apply_hotness_rerank 가 score 기준으로 다시 정렬해 무효화된다.
                    _boost_unit = 0.35 * (max((r.get("score", 0) for r in results), default=0.0) or 1.0)
                    _boosted = 0
                    for r in results:
                        d = r.get("date", "")
                        _b = 2 if _cur_year in d else (1 if _prev_year in d else 0)
                        r["_date_boost"] = _b
                        if _b:
                            r["score"] = r.get("score", 0) + _b * _boost_unit
                            _boosted += 1
                    self._log(f"[RAG] 최신 요청 → 날짜 부스팅 {_boosted}건 score 반영")

                # ── 멀티-쿼리 분해 (Complex + len>25, LRU 캐시 + 다양성 요구 + 1회 재시도) ──
                if claude and results and _complexity == 'complex' and len(query) > 25:
                    _sub_queries: list[str] = []
                    _decomp_cached = _decomp_cache.get(query)
                    if _decomp_cached is not None:
                        _sub_queries = list(_decomp_cached)
                        if _sub_queries:
                            self._log(f"[멀티쿼리] 캐시 적중: {_sub_queries}")
                    else:
                        _decomp_sys = (
                            "입력 질문을 검색 다양성을 위해 2개의 서로 다른 관점의 키워드로 분해한다.\n\n"
                            "규칙:\n"
                            "- 1번 줄: 핵심 명사구 (원본의 주요 키워드)\n"
                            "- 2번 줄: 동의어·상위어·구체어 중 1개 (서로 다른 단어 집합)\n"
                            "- 각 줄 10자 이내, 명사만, 공백 구분\n"
                            "- 1번과 2번이 단어 수준에서 겹치지 말 것\n"
                            "- 설명·문장·이모지·마크다운 금지\n"
                            "- 의미상 단일 주제여서 분해 어려우면 빈 응답\n\n"
                            "예시:\n"
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
                                # 가드: 유효성 + 길이 + 중복 단어 비율 (>50% 겹치면 탈락)
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
                                self._log(f"[멀티쿼리] 예외 (시도 {_attempt+1}): {_e}")
                        _decomp_cache.set(query, _sub_queries)

                    # 공통: 유효한 서브쿼리가 있으면 병합 루프 실행
                    if len(_sub_queries) >= 2:
                        self._log(f"[멀티쿼리] 분해: {_sub_queries}")
                        _seen_stems = {r.get("stem") for r in results}
                        _zero_gain_rounds = 0
                        for _sq in _sub_queries:
                            _prev_count = len(_seen_stems)
                            try:
                                _sub_res = search_via_electron(_sq, top_n=5) or search_vault(_sq, vault_path, top_n=5)
                            except Exception as _e:
                                self._log(f"[멀티쿼리] 서브검색 실패 (무시): {_e}")
                                _sub_res = []
                            for _r in (_sub_res or []):
                                if _r.get("stem") not in _seen_stems:
                                    results.append(_r)
                                    _seen_stems.add(_r.get("stem"))
                            if len(_seen_stems) == _prev_count:
                                _zero_gain_rounds += 1
                                if _zero_gain_rounds >= 2:
                                    self._log("[멀티쿼리] 수렴 감지 → 조기 종료")
                                    break
                            else:
                                _zero_gain_rounds = 0
                        self._log(f"[멀티쿼리] 병합 후 {len(results)}건")

                # ── 그래프 확장 (Phase 3): 상위 문서의 wikilink 공통 이웃 추가 ─
                # 핫스코어 재랭킹 이전에 실행해 확장 문서도 hot score 반영 받도록
                if results:
                    try:
                        results = expand_via_wikilinks(results, vault_path, top_consider=3, max_expand=2, log_fn=self._log)
                    except Exception as _e:
                        self._log(f"[그래프확장] 실패 (무시): {_e}")

                # ── 핫스코어 재랭킹 (OpenViking memory_lifecycle 기반) ──────
                # 자주/최근 참조된 문서에 보너스를 부여해 재정렬
                if results:
                    results = apply_hotness_rerank(results)
                    self._log(f"[{_elapsed()}] [핫스코어] 재랭킹 완료 (top: {results[0].get('title','')[:30]})")

                if progress: progress.done("search")

                # ── 비용 제어 설정 읽기 ──────────────────────────────────
                _cost_settings = get_electron_settings() or {}
                _self_review_enabled = _cost_settings.get("selfReview", True)
                _n_agents = int(_cost_settings.get("nAgents", 6))

                # ── 서브 에이전트 문서 분석 ──────────────────────────────
                if progress: progress.start("analyze")
                if claude and results:
                    rag_context = build_multi_agent_context(
                        claude, search_query, results, n_agents=_n_agents, log_fn=self._log
                    )
                else:
                    rag_context = build_rag_context(results, max_chars=12000)
                if progress: progress.done("analyze")

                # ── 웹 검색: AI가 스스로 필요 판단 ─────────────────────
                # Claude가 웹 검색 필요 여부를 먼저 판단 (vault 결과 부족하거나 최신 정보 필요 시)
                web_ctx = ""
                if progress: progress.start("webcheck")
                if claude:
                    decision_sys = '볼트 문서로 충분히 답할 수 있으면 NO, 외부 최신 정보가 필요하면 YES. 형식: "NO" 또는 "YES: <검색어>"'
                    decision_msg = (
                        f"질문: {search_query}\n\n"
                        f"볼트 자료 (앞부분):\n{rag_context[:600] if rag_context else '(없음)'}\n\n"
                        "웹 검색 필요 여부:"
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
                            self._log(f"[{_elapsed()}] [웹검색] \"{search_q}\" 검색 중...")
                            if progress: progress.done("webcheck"); progress.start("websearch")
                            web_results = search_web(search_q or query, max_results=5)
                            if web_results:
                                web_ctx = build_web_context(web_results)
                                self._log(f"[{_elapsed()}] [웹검색] {len(web_results)}건 확보")
                            else:
                                self._log("[웹검색] 결과 없음")
                        else:
                            self._log(f"[{_elapsed()}] [웹검색] 볼트 정보 충분 → 스킵")
                            if progress: progress.done("webcheck")
                    except Exception as e:
                        self._log(f"[웹검색 판단] 오류: {e} → 스킵")
                        if progress: progress.done("webcheck")

                # ── 3. LLM 생성 ─────────────────────────────────────────────
                if progress:
                    if progress._current_key == "websearch":
                        progress.done("websearch")
                    progress.start("answer")
                if claude:
                    today_str = datetime.now().strftime("%Y년 %m월 %d일 (%a) %H:%M")
                    # 구조화 추론 프롬프트 (llmClient.ts STRUCTURED_REASONING_PROMPT 와 동일)
                    structured_reasoning = (
                        "\n\n[구조화 추론] 분석·비교·설계·의사결정 질문에는 다음 구조로 답변하세요:\n"
                        "**[관찰]** 검색된 문서에서 발견한 핵심 사실·데이터\n"
                        "**[연결고리]** 문서 간 패턴, 인과관계, 모순, 숨겨진 연관성\n"
                        "**[분석]** 발견된 패턴의 의미·배경 맥락·함의\n"
                        "**[결론/제안]** 핵심 인사이트와 실행 가능한 다음 단계\n"
                        "단순 검색·요약·인사·사실 확인에는 이 구조를 생략하고 간결하게 답변하세요."
                    )
                    combined = f"오늘 날짜/시간: {today_str}\n\n" + persona["system"] + structured_reasoning
                    # 의도 태그 주입: "정리/분석/비교" 등 원본 쿼리의 요청 동사는 검색에서 제거됐지만
                    # 최종 응답 스타일을 좌우하므로 명시적으로 알려준다.
                    if intent_tag:
                        _intent_hints = {
                            '정리': '사용자는 검색된 내용을 **정리/요약** 하길 원합니다. 중복을 제거하고 핵심만 구조화해 전달하세요.',
                            '분석': '사용자는 **분석/해석** 을 원합니다. 패턴·원인·함의를 도출해 전달하세요.',
                            '요약': '사용자는 **짧은 요약** 을 원합니다. 5문장 이내로 핵심만.',
                            '검토': '사용자는 **검토/평가** 를 원합니다. 장단점·리스크·보완점을 명시하세요.',
                            '설명': '사용자는 **맥락 설명** 을 원합니다. 배경·과정·결과 순으로 구조화.',
                            '비교': '사용자는 **비교** 를 원합니다. 대상·기준·차이점을 표로 또는 항목별로.',
                            '제안': '사용자는 **실행 가능한 제안** 을 원합니다. 근거와 우선순위 포함.',
                            '추천': '사용자는 **추천안** 을 원합니다. 근거와 적용 조건 포함.',
                            '작성': '사용자는 **문서 작성** 을 원합니다. 구조·헤딩·목록을 활용.',
                            '소개': '사용자는 **개요 소개** 를 원합니다. 핵심 특징·용도·예시.',
                            '추출': '사용자는 **특정 항목 추출** 을 원합니다. 리스트 형태로 반환.',
                        }
                        combined += f"\n\n[사용자 의도: {intent_tag}] {_intent_hints.get(intent_tag, '')}"
                    # 사용자 기억 주입
                    if user_id and _mem_store.get(user_id):
                        combined += f"\n\n---\n## 📌 이 사용자와의 이전 대화 기억\n{_mem_store.get(user_id)}\n---"
                    if rag_context:
                        combined += f"\n\n{rag_context}"
                    if web_ctx:
                        combined += f"\n\n{web_ctx}"
                    # 페르소나별 분석 프레임
                    _PERSONA_ANALYSIS_FRAMES = {
                        "chief": (
                            "[PM 분석 관점] ① 프로젝트 방향·목표 정합성 "
                            "② 리소스·일정·우선순위 실현 가능성 ③ 주요 리스크와 완화 방안"
                        ),
                        "art": (
                            "[아트 분석 관점] ① 스타일·비주얼 일관성·톤앤매너 영향 "
                            "② 플레이어 시각 메시지와 감성 ③ 기술 구현 가능성과 퀄리티 균형"
                        ),
                        "spec": (
                            "[기획 분석 관점] ① 밸런스·플레이어 경험·재미 요소 영향 "
                            "② 기존 시스템 연계성·의존성 ③ 유저 직관성과 납득 가능성"
                        ),
                        "tech": (
                            "[기술 분석 관점] ① 기술 부채·성능·확장성 영향 "
                            "② 구현 복잡도와 테스트 가능성 ③ 기존 코드베이스 호환성"
                        ),
                    }
                    if tag in _PERSONA_ANALYSIS_FRAMES:
                        combined += f"\n\n{_PERSONA_ANALYSIS_FRAMES[tag]}"
                    combined += (
                        "\n\n[답변 지침]\n"
                        "• 사고 순서: 핵심 의도 파악 → 문서 근거 확인 → 인사이트 도출 → 불확실 내용은 명시적 구분\n"
                        "• 문서 간 상충 시: 명시적으로 지적하고 최신 확인 권고\n"
                        "• 말투: 항상 전문적인 존댓말(~합니다/~습니다 체)\n"
                        "• 사실 준수: 볼트 문서·웹 결과·사용자 발화 기반만. 미확인 내용은 '검색된 문서에서 확인되지 않습니다'로 명시. '볼트 문서' 또는 '검색된 문서'로 표현."
                    )
                    try:
                        answer = claude.complete(combined, query, max_tokens=2000, cache_system=True)
                        # ── 2-pass 자기 검토 (selfReview 설정으로 ON/OFF) ──
                        if _self_review_enabled:
                            _review_sys = (
                                "[답변]이 [질문]을 충분히 다뤘는지 검토하세요.\n"
                                "빠진 핵심 관점이 있으면 [보완]에 추가. 충분하면 [최종답변]만 출력.\n"
                                "형식: [최종답변]\\n(내용)\\n\\n[보완]\\n(내용, 없으면 생략)"
                            )
                            _reviewed = claude.complete(
                                _review_sys,
                                f"[질문]\n{query}\n\n[답변]\n{answer}",
                                max_tokens=2500,
                            ).strip()
                            if "[최종답변]" in _reviewed:
                                _main = _reviewed.split("[최종답변]", 1)[1]
                                _supplement = ""
                                if "[보완]" in _main:
                                    _main, _supplement = _main.split("[보완]", 1)
                                _main = _main.strip()
                                _supplement = _supplement.strip()
                                if _main:
                                    answer = _main
                                    if _supplement:
                                        answer += f"\n\n---\n*💡 추가 관점*\n{_supplement}"
                                    self._log(f"[{_elapsed()}] [2-pass] 자기 검토 적용")
                    except Exception as e:
                        _err_str = str(e)
                        if "529" in _err_str or "overloaded" in _err_str.lower():
                            answer = "❌ *Claude API 과부하 상태입니다.* 잠시 후 다시 시도해주세요."
                        elif "401" in _err_str or "authentication" in _err_str.lower():
                            answer = "❌ *Claude API 키 인증 실패.* 설정에서 API 키를 확인해주세요."
                        elif "402" in _err_str or "credit" in _err_str.lower() or "insufficient" in _err_str.lower():
                            answer = "❌ *Claude API 크레딧이 부족합니다.* 잔액을 충전해주세요."
                        elif "timeout" in _err_str.lower():
                            answer = "❌ *응답 시간이 초과되었습니다.* 질문을 짧게 줄여서 다시 시도해주세요."
                        else:
                            answer = f"❌ *AI 응답 중 오류가 발생했습니다.*\n_(오류 코드: {type(e).__name__})_\n잠시 후 다시 시도해주세요."
                        self._log(f"[Claude] 응답 오류: {e}")
                elif rag_context:
                    answer = (
                        "_(Claude API 키가 설정되어 있지 않아 AI 분석 없이 원문만 표시합니다.)_\n\n"
                        + rag_context
                    )
                else:
                    answer = (
                        "_볼트에서 관련 문서를 찾지 못했어요._\n\n"
                        "• 다른 키워드로 다시 질문해보세요\n"
                        "• 볼트 동기화가 완료됐는지 확인해주세요\n"
                        "• `!도움말` 로 사용법을 확인할 수 있어요"
                    )

                if progress: progress.done("answer")
                # 참조된 문서 접근 기록 → 핫스코어 학습
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
                    sources = "\n\n_───────────────────_\n📂 *참고 문서*\n" + "\n".join(lines)
                final = f"{answer}{sources}"

            # ── 4. Slack 게시 ────────────────────────────────────────────────
            # 히스토리 업데이트 (최대 20턴 = 40 메시지 보존)
            # read-modify-write 를 한 번의 락 안에서 수행한다. 처리 시작 시점에 뜬
            # history 스냅샷을 그대로 쓰면, 그 사이 완료된 동시 DM 의 대화가 사라진다.
            with _conv_history_lock:
                _stored = _conv_history.get(hist_key)
                _base = _stored if _stored is not None and len(_stored) >= len(history) else history
                updated_history = (list(_base) + [
                    {"role": "user", "content": query},
                    {"role": "assistant", "content": answer or ""},
                ])[-40:]
                _conv_history[hist_key] = updated_history
                # LRU: 최근 쓰기를 가장 새로운 항목으로 이동
                try:
                    _conv_history.move_to_end(hist_key)
                except AttributeError:
                    pass  # dict 폴백
                # 오래된 키 정리 (메모리 누수 방지) — OrderedDict 는 앞쪽이 가장 오래됨
                if len(_conv_history) > _MAX_HISTORY_KEYS:
                    for old_key in list(_conv_history)[:len(_conv_history) - _MAX_HISTORY_KEYS]:
                        del _conv_history[old_key]
            # 사용자 기억 자동 갱신 (5턴마다)
            if user_id:
                _mem_store.auto_update(user_id, updated_history, claude, api_key=api_key)

            # Markdown → Slack mrkdwn 변환
            from modules.slack_formatter import md_to_slack
            final = md_to_slack(final)

            self._log(f"[{_elapsed()}] [완료] 답변 {len(final)}자 전송")

            ts = (thinking or {}).get("ts")
            _say_long(final, say, thread_ts, update_ts=ts, channel=channel)

            # 이미지 업로드 (명시적 검색 결과 우선, 없으면 자동 수집 이미지)
            all_image_paths = vault_image_paths or auto_image_paths
            if all_image_paths and self.cfg.get("sendImages", True):
                _img_handler.upload_images_to_slack(all_image_paths, channel, thread_ts)

            # ── 보고서 인텐트 → PDF 비동기 생성 + Slack 업로드 ─────────────────
            if REPORT_INTENT_RE.search(query) and answer and not answer.startswith("❌"):
                def _async_report_pdf():
                    try:
                        title_m = _re.search(r'["\u300c\u300e\u201c](.+?)["\u300d\u300f\u201d]', query)
                        report_title = title_m.group(1) if title_m else (query[:40].strip() or "보고서")
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
                            self._log(f"[보고서] PDF 변환 완료: {pdf_path.name}")
                            upload_path = pdf_path
                        except Exception as _pdf_e:
                            self._log(f"[보고서] PDF 변환 실패 ({type(_pdf_e).__name__}: {_pdf_e}) → HTML 업로드")
                            upload_path = html_path
                        _upload_file_to_slack(upload_path, channel, thread_ts, title=f"📄 {report_title}")
                    except Exception as _e:
                        self._log(f"[보고서] PDF 생성 실패: {_e}")
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
            """봇 종료 시 활성 채널에 '업데이트중' 메시지 전송."""
            with _active_channels_lock:
                _snapshot = list(_active_channels)
            for ch in _snapshot:
                try:
                    web.chat_postMessage(channel=ch, text="🔄 _봇이 업데이트 중입니다. 잠시 후 다시 시도해주세요._")
                except Exception as e:
                    self._log(f"[disconnect] 채널 {ch} 알림 실패: {str(e)[:200]}")

        def _run():
            _RECONNECT_DELAYS = [5, 10, 20, 40, 60]  # 초, 순서대로 증가 후 60초 고정
            attempt = 0

            while self._running:
                try:
                    # 재연결 시 새 SocketModeHandler 생성 (이전 핸들러는 이미 dead)
                    self._handler = SocketModeHandler(app, app_token)
                    self._handler.connect()   # signal 등록 없이 WebSocket만 연결
                    _scheduler.set_handler(self._handler)

                    # 백그라운드 서비스 스레드 — 연결될 때마다 시작
                    # (이전 스레드는 is_connected() == False 감지 후 자동 종료됨)
                    _scheduler.start_schedule_checker()
                    _scheduler.start_vault_tag_scanner()

                    if attempt > 0:
                        self._log("🟢 Slack 재연결 성공")
                    attempt = 0  # 연결 성공 시 재시도 카운터 초기화

                    while self._handler.client and self._handler.client.is_connected():
                        time.sleep(1)

                    if not self._running:
                        break  # stop() 호출로 인한 정상 종료

                    self._log("⚠️ Slack 연결 끊김 — 재연결 대기 중...")

                except Exception as e:
                    if not self._running:
                        break
                    self._log(f"⚠️ Slack 연결 오류: {e}")

                # 의도적 종료가 아닌 경우 지수 백오프 후 재연결
                delay = _RECONNECT_DELAYS[min(attempt, len(_RECONNECT_DELAYS) - 1)]
                attempt += 1
                self._log(f"🔄 {delay}초 후 재연결 시도... (#{attempt})")
                for _ in range(delay):
                    if not self._running:
                        break
                    time.sleep(1)

            _notify_disconnect()
            self._on_status(False)

        self._running = True
        self._thread = threading.Thread(target=_run, daemon=True)
        self._thread.start()
        self._log("🟢 Slack 봇 시작 — 모델: Strata Sync 페르소나 설정 따름")
        return True

    def stop(self):
        self._running = False  # 재연결 루프 중단
        if self._handler:
            try:
                self._handler.close()
            except Exception as e:
                self._log(f"[stop] handler.close() 실패: {e}")
        self._handler = None
        self._log("🔴 Slack 봇 중지")

    def _register_handlers(self, app, *, respond_fn, extract_slack_files,
                            _conv_history, _conv_history_lock, _mem_store,
                            api_key, vault_path,
                            is_electron_alive, get_electron_settings,
                            get_model_for_tag) -> None:
        """Slack 이벤트/커맨드/단축키/모달 핸들러 등록."""

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
                                    "text": "볼트 기반 RAG 어시스턴트입니다.\n채널에서 *@Sandbox* 를 멘션하거나, *메시지 탭*에서 직접 질문하세요.",
                                },
                            },
                            {"type": "divider"},
                            {
                                "type": "section",
                                "fields": [
                                    {
                                        "type": "mrkdwn",
                                        "text": "*💬  질문하기*\n`질문` — Chief Director 답변\n`[아트] 질문` — 페르소나 지정\n이미지 첨부 — Vision 분석 지원",
                                    },
                                    {
                                        "type": "mrkdwn",
                                        "text": "*⌨️  커맨드*\n`/ask 질문`\n`/remember`\n`/status`\n`/help`",
                                    },
                                ],
                            },
                            {"type": "divider"},
                            {
                                "type": "context",
                                "elements": [
                                    {"type": "mrkdwn", "text": "*페르소나 태그*  `[감독]`  `[아트]`  `[기획]`  `[기술]`   •   ⚡ `ask_sandbox` 단축키로 어디서든 바로 질문"},
                                ],
                            },
                        ],
                    },
                )
            except Exception as e:
                logger.error(f"[Home] views.publish 실패: {e}")

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
            # DM(im) 또는 그룹 DM(mpim)만 처리, 봇 자신의 메시지 제외
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
                thread_ts=None,  # DM은 스레드 없이 바로 답변
                files=files,
                user_id=event.get("user"),
            )

        # ── 슬래시 커맨드 ────────────────────────────────────────────────────
        HELP_BLOCKS = [
            {
                "type": "header",
                "text": {"type": "plain_text", "text": "🗺️  Strata Sync Bot 사용법", "emoji": True},
            },
            {
                "type": "section",
                "fields": [
                    {
                        "type": "mrkdwn",
                        "text": "*채널 멘션*\n`@Sandbox 질문` — 스레드에 답변\n`@Sandbox [아트] 질문` — 페르소나 지정",
                    },
                    {
                        "type": "mrkdwn",
                        "text": "*DM / 메시지 탭*\n직접 입력 — Chief Director 답변\n이미지 첨부 — Vision 분석 지원",
                    },
                ],
            },
            {"type": "divider"},
            {
                "type": "section",
                "text": {
                    "type": "mrkdwn",
                    "text": (
                        "*⌨️  슬래시 커맨드*\n"
                        "`/ask 질문`  — RAG 기반 답변\n"
                        "`/remember`  — 대화 내용 기억 저장\n"
                        "`/status`  — 봇 상태·볼트 정보\n"
                        "`/help`  — 이 도움말\n\n"
                        "*⚡  글로벌 단축키*\n"
                        "`ask_sandbox`  — 어느 채널에서든 팝업으로 질문"
                    ),
                },
            },
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": "*페르소나 태그*  `[감독]`  `[아트]`  `[기획]`  `[기술]`"}],
            },
        ]
        HELP_TEXT = "*🗺️ Strata Sync Bot 사용법*\n`/ask 질문`  `/remember`  `/status`  `/help`"

        @app.command("/help")
        def handle_slash_help(ack, respond, logger):
            ack()
            try:
                respond(blocks=HELP_BLOCKS, text=HELP_TEXT)
            except Exception as e:
                logger.error(f"[/help] 응답 실패: {e}")

        @app.command("/ask")
        def handle_slash_ask(ack, respond, command, logger):
            ack()
            text = command.get("text", "").strip()
            if not text:
                respond(text="질문 내용을 입력해주세요.\n사용법: `/ask 질문 내용`")
                return
            user_id = command.get("user_id")
            channel_id = command.get("channel_id")
            try:
                # respond()는 ephemeral이므로 처리 중 알림 후 실제 답변은 say로 전송
                respond(text=f"_{text}_ 처리 중입니다…")
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
                logger.error(f"[/ask] 처리 실패: {e}")
                respond(text=f"처리 중 오류가 발생했습니다: {e}")

        @app.command("/remember")
        def handle_slash_remember(ack, respond, command, logger):
            """현재 DM/스레드 대화 내용을 사용자 기억에 저장."""
            ack()
            user_id = command.get("user_id")
            channel_id = command.get("channel_id")
            hist_key = f"{channel_id}:dm"
            with _conv_history_lock:
                history = list(_conv_history.get(hist_key, []))
            if len(history) < 4:
                respond(text="💭 저장할 대화 내용이 충분하지 않아요. 먼저 몇 가지 질문을 해주세요!")
                return
            try:
                respond(text="💭 대화 내용을 기억에 저장하는 중...")
                live_key = get_anthropic_key(self.cfg) or api_key
                if not live_key:
                    respond(text="❌ API 키가 설정되어 있지 않아 기억을 저장할 수 없어요.")
                    return
                model = get_model_for_tag("chief")
                claude_mem = ClaudeClient(live_key, model)
                existing = _mem_store.get(user_id)
                hist_text = "\n".join(
                    f"{'👤' if m['role'] == 'user' else '🤖'} {m['content'][:200]}"
                    for m in history[-10:]
                )
                summary_prompt = "아래 대화를 300자 이내로 핵심 결정사항·합의·중요 컨텍스트 중심으로 요약하세요. 요약만 출력."
                if existing:
                    summary_prompt += f"\n\n기존 기억:\n{existing}"
                summary = claude_mem.complete(summary_prompt, f"대화:\n{hist_text}", max_tokens=400).strip()
                if summary:
                    _mem_store.update(user_id, summary)
                    _mem_store.save()
                    respond(text=f"✅ *대화 내용을 기억했어요!*\n\n_{summary}_")
                else:
                    respond(text="⚠️ 기억 생성에 실패했어요. 잠시 후 다시 시도해주세요.")
            except Exception as e:
                logger.error(f"[/remember] 실패: {e}")
                respond(text=f"❌ 기억 저장 중 오류: {e}")

        @app.command("/status")
        def handle_slash_status(ack, respond, logger):
            """봇 상태 및 볼트 정보 표시."""
            ack()
            try:
                electron_str = "🟢 온라인" if is_electron_alive() else "🔴 오프라인"
                settings_data = get_electron_settings() or {}
                chief_model = settings_data.get("personaModels", {}).get("chief_director", "—")
                vault_name = Path(vault_path).name if vault_path else "—"
                doc_count = "—"
                try:
                    doc_count = str(len(scan_vault(vault_path)))
                except Exception as e:
                    self._log(f"[/status] 볼트 스캔 실패: {e}")
                with _conv_history_lock:
                    active_threads = len(_conv_history)
                mem_users = len(_mem_store)
                respond(
                    blocks=[
                        {
                            "type": "header",
                            "text": {"type": "plain_text", "text": "🗺️  Strata Sync Bot 상태", "emoji": True},
                        },
                        {
                            "type": "section",
                            "fields": [
                                {"type": "mrkdwn", "text": f"*앱 연결*\n{electron_str}"},
                                {"type": "mrkdwn", "text": f"*AI 모델*\n`{chief_model}`"},
                                {"type": "mrkdwn", "text": f"*볼트*\n`{vault_name}`  _{doc_count}개 문서_"},
                                {"type": "mrkdwn", "text": f"*활성 대화*\n{active_threads}개 스레드"},
                            ],
                        },
                        {
                            "type": "context",
                            "elements": [{"type": "mrkdwn", "text": f"기억 저장 {mem_users}명 사용자"}],
                        },
                    ],
                    text=f"앱: {electron_str} | 볼트: {vault_name} ({doc_count}개 문서) | 모델: {chief_model}",
                )
            except Exception as e:
                logger.error(f"[/status] 실패: {e}")
                respond(text=f"❌ 상태 조회 중 오류: {e}")

        # ── 글로벌 Shortcut ─────────────────────────────────────────────────
        # Slack 앱 설정 > Interactivity & Shortcuts 에서 callback_id "ask_sandbox" 로 등록 필요
        @app.shortcut("ask_sandbox")
        def handle_shortcut_ask(ack, shortcut, client, logger):
            """⚡ 글로벌 단축키 — 어느 채널에서든 봇에게 질문하는 모달 팝업."""
            ack()
            try:
                client.views_open(
                    trigger_id=shortcut["trigger_id"],
                    view={
                        "type": "modal",
                        "callback_id": "sandbox_ask_modal",
                        "title": {"type": "plain_text", "text": "Strata Sync에게 질문"},
                        "submit": {"type": "plain_text", "text": "질문하기"},
                        "close":  {"type": "plain_text", "text": "취소"},
                        "blocks": [
                            {
                                "type": "input",
                                "block_id": "persona_block",
                                "optional": True,
                                "label": {"type": "plain_text", "text": "담당 페르소나"},
                                "element": {
                                    "type": "static_select",
                                    "action_id": "persona_select",
                                    "placeholder": {"type": "plain_text", "text": "선택 (기본: 감독 PM)"},
                                    "initial_option": {"text": {"type": "plain_text", "text": "🎯 감독 (PM)"}, "value": "chief"},
                                    "options": [
                                        {"text": {"type": "plain_text", "text": "🎯 감독 (PM)"},       "value": "chief"},
                                        {"text": {"type": "plain_text", "text": "🎨 아트 디렉터"},     "value": "art"},
                                        {"text": {"type": "plain_text", "text": "📋 기획자"},           "value": "spec"},
                                        {"text": {"type": "plain_text", "text": "💻 기술 디렉터"},     "value": "tech"},
                                    ],
                                },
                            },
                            {
                                "type": "input",
                                "block_id": "question_block",
                                "label": {"type": "plain_text", "text": "질문 내용"},
                                "element": {
                                    "type": "plain_text_input",
                                    "action_id": "question_input",
                                    "multiline": True,
                                    "placeholder": {"type": "plain_text", "text": "질문을 입력하세요…"},
                                },
                            },
                        ],
                    },
                )
            except Exception as e:
                logger.error(f"[shortcut/ask_sandbox] views_open 실패: {e}")

        @app.view("sandbox_ask_modal")
        def handle_modal_submit(ack, body, client, logger):
            """모달 제출 → DM 채널로 질문 처리."""
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
                logger.error(f"[modal/submit] 처리 실패: {e}")


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
        self._tick()  # 타이머 카운트다운 업데이트

    # ── UI 빌드 ───────────────────────────────────────────────────────────────

    def _build_ui(self):
        pad = {"padx": 8, "pady": 4}

        # ── 상단: 설정 패널 ──────────────────────────────────────────────────
        frame_cfg = ttk.LabelFrame(self, text="설정", padding=8)
        frame_cfg.pack(fill="x", padx=10, pady=(10, 4))

        # 볼트 경로
        ttk.Label(frame_cfg, text="볼트 경로:").grid(row=0, column=0, sticky="w", **pad)
        self.var_vault = tk.StringVar()
        ttk.Entry(frame_cfg, textvariable=self.var_vault, width=52).grid(row=0, column=1, sticky="ew", padx=4)
        ttk.Button(frame_cfg, text="찾기", command=self._browse_vault, width=6).grid(row=0, column=2, padx=4)

        # API Key
        ttk.Label(frame_cfg, text="Claude API Key:").grid(row=1, column=0, sticky="w", **pad)
        self.var_key = tk.StringVar()
        ttk.Entry(frame_cfg, textvariable=self.var_key, show="*", width=52).grid(row=1, column=1, sticky="ew", padx=4)

        # 실행 주기
        ttk.Label(frame_cfg, text="실행 주기:").grid(row=2, column=0, sticky="w", **pad)
        interval_frame = ttk.Frame(frame_cfg)
        interval_frame.grid(row=2, column=1, sticky="w")
        self.var_interval = tk.IntVar(value=1)
        for label, val in [("1시간", 1), ("5시간", 5), ("수동", 0)]:
            ttk.Radiobutton(
                interval_frame, text=label, variable=self.var_interval, value=val
            ).pack(side="left", padx=6)

        ttk.Button(frame_cfg, text="저장", command=self._save_cfg, width=6).grid(row=2, column=2, padx=4)
        frame_cfg.columnconfigure(1, weight=1)

        # ── 중단: 실행 제어 ──────────────────────────────────────────────────
        frame_ctrl = ttk.Frame(self)
        frame_ctrl.pack(fill="x", padx=10, pady=4)

        self.btn_run = ttk.Button(frame_ctrl, text="▶ 지금 실행", command=self._run_now, width=14)
        self.btn_run.pack(side="left", padx=4)

        self.btn_timer = ttk.Button(frame_ctrl, text="⏱ 타이머 시작", command=self._toggle_timer, width=14)
        self.btn_timer.pack(side="left", padx=4)

        self.lbl_status = ttk.Label(frame_ctrl, text="상태: 대기", foreground="gray")
        self.lbl_status.pack(side="left", padx=12)

        self.lbl_next = ttk.Label(frame_ctrl, text="", foreground="steelblue")
        self.lbl_next.pack(side="right", padx=8)

        # ── 탭: 로그 / 키워드 ────────────────────────────────────────────────
        self.notebook = ttk.Notebook(self)
        self.notebook.pack(fill="both", expand=True, padx=10, pady=(4, 10))

        # 로그 탭
        tab_log = ttk.Frame(self.notebook)
        self.notebook.add(tab_log, text="📋 실행 로그")
        self.txt_log = scrolledtext.ScrolledText(tab_log, wrap="word", state="disabled",
                                                  font=("Consolas", 9), bg="#1e1e1e", fg="#d4d4d4")
        self.txt_log.pack(fill="both", expand=True)
        btn_clear = ttk.Button(tab_log, text="로그 지우기", command=self._clear_log)
        btn_clear.pack(anchor="e", padx=4, pady=2)

        # 키워드 탭
        tab_kw = ttk.Frame(self.notebook)
        self.notebook.add(tab_kw, text="🔑 키워드 인덱스")

        kw_top = ttk.Frame(tab_kw)
        kw_top.pack(fill="x", padx=4, pady=4)
        self.lbl_kw_count = ttk.Label(kw_top, text="키워드: 0개")
        self.lbl_kw_count.pack(side="left")
        ttk.Button(kw_top, text="새로고침", command=self._refresh_keywords).pack(side="left", padx=8)
        ttk.Button(kw_top, text="+ 키워드 추가", command=self._add_keyword_dialog).pack(side="left", padx=4)

        cols = ("keyword", "hub_stem", "display", "added", "hits")
        self.kw_tree = ttk.Treeview(tab_kw, columns=cols, show="headings", height=16)
        for col, label, width in [
            ("keyword", "키워드", 120),
            ("hub_stem", "허브 문서 stem", 280),
            ("display", "표시명", 100),
            ("added", "추가일", 90),
            ("hits", "히트", 50),
        ]:
            self.kw_tree.heading(col, text=label)
            self.kw_tree.column(col, width=width, minwidth=40)
        self.kw_tree.pack(fill="both", expand=True, padx=4, pady=4)

        kw_scroll = ttk.Scrollbar(tab_kw, orient="vertical", command=self.kw_tree.yview)
        self.kw_tree.configure(yscrollcommand=kw_scroll.set)
        kw_scroll.pack(side="right", fill="y")

        # 오른쪽 클릭 메뉴
        self.kw_menu = tk.Menu(self, tearoff=0)
        self.kw_menu.add_command(label="삭제", command=self._delete_keyword)
        self.kw_tree.bind("<Button-3>", self._show_kw_menu)

        # ── 인덱스 파일 탭 ────────────────────────────────────────────────────
        tab_idx = ttk.Frame(self.notebook)
        self.notebook.add(tab_idx, text="📄 인덱스 파일")

        idx_top = ttk.Frame(tab_idx)
        idx_top.pack(fill="x", padx=6, pady=4)
        self.lbl_idx_count = ttk.Label(idx_top, text="인덱스 파일: 0개")
        self.lbl_idx_count.pack(side="left")
        ttk.Button(idx_top, text="새로고침", command=self._refresh_index_list).pack(side="left", padx=8)

        idx_pane = tk.PanedWindow(tab_idx, orient="horizontal", sashwidth=5, relief="flat")
        idx_pane.pack(fill="both", expand=True, padx=6, pady=(0, 6))

        # 왼쪽: 파일 목록
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

        # 오른쪽: 파일 내용
        content_frame = ttk.Frame(idx_pane)
        self.idx_content = scrolledtext.ScrolledText(
            content_frame, wrap="word", state="disabled",
            font=("Consolas", 9), bg="#1e1e1e", fg="#d4d4d4")
        self.idx_content.pack(fill="both", expand=True)
        idx_pane.add(content_frame, minsize=300)

        # 파일 경로 저장용
        self._idx_paths: list[str] = []

        # ── Slack 봇 탭 ──────────────────────────────────────────────────────
        tab_slack = ttk.Frame(self.notebook)
        self.notebook.add(tab_slack, text="💬 Slack 봇")

        # 설정 영역
        slack_cfg = ttk.LabelFrame(tab_slack, text="Slack 설정", padding=8)
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
        ttk.Label(slack_cfg, text="알림 채널 (스케줄·태그):").grid(row=3, column=0, sticky="w", padx=6, pady=3)
        ttk.Entry(slack_cfg, textvariable=self.var_slack_notify_ch, width=22).grid(
            row=3, column=1, sticky="ew", padx=4)
        ttk.Label(slack_cfg, text="예: #general 또는 C0123ABCD",
                  foreground="gray").grid(row=4, column=0, columnspan=2, sticky="w", padx=6)
        ttk.Label(slack_cfg, text="wkhtmltopdf 경로:").grid(row=5, column=0, sticky="w", padx=6, pady=3)
        ttk.Entry(slack_cfg, textvariable=self.var_wkhtmltopdf_path, width=50).grid(
            row=5, column=1, sticky="ew", padx=4)
        slack_cfg.columnconfigure(1, weight=1)

        # 저장 버튼
        ttk.Button(slack_cfg, text="저장", command=self._save_cfg, width=6).grid(
            row=3, column=1, sticky="e", padx=4)

        # 제어 영역
        slack_ctrl = ttk.Frame(tab_slack)
        slack_ctrl.pack(fill="x", padx=8, pady=4)

        self.btn_slack = ttk.Button(slack_ctrl, text="▶ Slack 봇 시작",
                                     command=self._toggle_slack, width=16)
        self.btn_slack.pack(side="left", padx=4)

        self.lbl_slack_status = ttk.Label(slack_ctrl, text="상태: 중지", foreground="gray")
        self.lbl_slack_status.pack(side="left", padx=10)

        # Slack 전용 로그
        self.txt_slack_log = scrolledtext.ScrolledText(
            tab_slack, wrap="word", state="disabled",
            font=("Consolas", 9), bg="#0d1117", fg="#7ee787", height=16)
        self.txt_slack_log.pack(fill="both", expand=True, padx=8, pady=(0, 4))
        ttk.Button(tab_slack, text="로그 지우기",
                   command=self._clear_slack_log).pack(anchor="e", padx=8, pady=2)

        # ── 멀티볼트 탭 ──────────────────────────────────────────────────────
        tab_multi = ttk.Frame(self.notebook)
        self.notebook.add(tab_multi, text="🗂️ 멀티볼트 봇")

        mv_desc = ttk.LabelFrame(tab_multi, text="볼트별 Slack 봇 인스턴스", padding=8)
        mv_desc.pack(fill="x", padx=8, pady=(8, 4))
        ttk.Label(
            mv_desc,
            text=(
                "볼트마다 별도의 config 파일을 만들고, 아래 명령어로 각 봇을 독립 실행하세요.\n"
                "예)  python bot.py --headless --config config_vault2.json"
            ),
            justify="left", foreground="#555",
        ).pack(anchor="w", padx=4, pady=4)

        mv_frame = ttk.LabelFrame(tab_multi, text="인스턴스 설정 파일 목록", padding=8)
        mv_frame.pack(fill="both", expand=True, padx=8, pady=4)

        mv_top = ttk.Frame(mv_frame)
        mv_top.pack(fill="x", pady=(0, 4))
        ttk.Button(mv_top, text="새 인스턴스 config 만들기", command=self._mv_create_config).pack(side="left", padx=4)
        ttk.Button(mv_top, text="새로고침", command=self._mv_refresh).pack(side="left", padx=4)
        ttk.Button(mv_top, text="선택 파일 열기", command=self._mv_open_config).pack(side="left", padx=4)

        self.mv_listbox = tk.Listbox(mv_frame, height=8, font=("Consolas", 9),
                                     bg="#1e1e1e", fg="#d4d4d4",
                                     selectbackground="#264f78", activestyle="none")
        self.mv_listbox.pack(fill="both", expand=True, padx=4, pady=4)

        mv_cmd_frame = ttk.LabelFrame(tab_multi, text="실행 명령어", padding=8)
        mv_cmd_frame.pack(fill="x", padx=8, pady=(0, 8))
        self.mv_cmd_var = tk.StringVar()
        mv_cmd_entry = ttk.Entry(mv_cmd_frame, textvariable=self.mv_cmd_var, state="readonly", width=70)
        mv_cmd_entry.pack(fill="x", padx=4, pady=4)
        ttk.Button(mv_cmd_frame, text="클립보드 복사", command=self._mv_copy_cmd).pack(anchor="e", padx=4, pady=2)
        self.mv_listbox.bind("<<ListboxSelect>>", self._mv_on_select)

        self._mv_refresh()

    def _mv_refresh(self):
        """bot 폴더 내 config_*.json 파일 목록 새로고침."""
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
            messagebox.showinfo("복사 완료", "명령어가 클립보드에 복사되었습니다.")

    def _mv_create_config(self):
        """현재 설정을 기반으로 새 config 파일 생성."""
        from tkinter.simpledialog import askstring
        name = askstring("새 인스턴스", "새 config 파일 이름 (예: config_vault2.json):", parent=self)
        if not name:
            return
        if not name.endswith(".json"):
            name += ".json"
        bot_dir = Path(__file__).parent
        dest = bot_dir / name
        if dest.exists():
            if not messagebox.askyesno("덮어쓰기", f"{name} 이(가) 이미 존재합니다. 덮어쓸까요?"):
                return
        import copy
        new_cfg = copy.deepcopy(self.cfg)
        dest.write_text(json.dumps(new_cfg, ensure_ascii=False, indent=2), encoding="utf-8")
        self._log(f"💾 새 인스턴스 config 생성: {name}")
        self._mv_refresh()

    def _mv_open_config(self):
        sel = self.mv_listbox.curselection()
        if not sel:
            messagebox.showinfo("안내", "목록에서 파일을 선택하세요.")
            return
        name = self.mv_listbox.get(sel[0])
        bot_dir = Path(__file__).parent
        path = bot_dir / name
        try:
            os.startfile(str(path))
        except Exception as e:
            messagebox.showerror("오류", f"파일 열기 실패: {e}")

    # ── Config UI 연결 ────────────────────────────────────────────────────────

    def _load_cfg_to_ui(self):
        self.var_vault.set(self.cfg.get("vault_path", ""))
        self.var_key.set(self.cfg.get("claude_api_key", ""))
        self.var_interval.set(self.cfg.get("interval_hours", 1))
        self.var_slack_bot_token.set(self.cfg.get("slack_bot_token", ""))
        self.var_slack_app_token.set(self.cfg.get("slack_app_token", ""))
        self.var_slack_top_n.set(self.cfg.get("slack_rag_top_n", 5))
        self.var_slack_notify_ch.set(self.cfg.get("slack_notify_channel", ""))
        self.var_wkhtmltopdf_path.set(self.cfg.get("wkhtmltopdf_path", r"C:\Program Files (x86)\wkhtmltopdf\bin\wkhtmltopdf.exe"))
        self.after(100, self._refresh_index_list)  # UI 초기화 후 인덱스 목록 로드

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
        self._log("💾 설정 저장됨")

    def _browse_vault(self):
        folder = filedialog.askdirectory(title="볼트 폴더 선택")
        if folder:
            self.var_vault.set(folder)

    # ── 로그 ─────────────────────────────────────────────────────────────────

    def _log_threadsafe(self, msg: str):
        """백그라운드 스레드에서 안전하게 호출 가능 — after()로 메인 스레드에 위임."""
        self.after(0, lambda m=msg: self._log_direct(m))

    def _log_direct(self, msg: str):
        """메인 스레드 전용. Tkinter 위젯 직접 수정."""
        self.txt_log.configure(state="normal")
        ts = datetime.now().strftime("%H:%M:%S")
        self.txt_log.insert("end", f"[{ts}] {msg}\n")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    def _log(self, msg: str):
        """메인 스레드에서 호출 (버튼 클릭, 설정 저장 등)."""
        self._log_direct(msg)

    def _clear_log(self):
        self.txt_log.configure(state="normal")
        self.txt_log.delete("1.0", "end")
        self.txt_log.configure(state="disabled")

    # ── 실행 제어 ─────────────────────────────────────────────────────────────

    def _make_bot(self) -> VaultBot:
        self._save_cfg()
        return VaultBot(self.cfg, log_fn=self._log_threadsafe, on_done_fn=self._on_cycle_done)

    def _set_running(self, running: bool):
        self.lbl_status.config(
            text="상태: 실행 중..." if running else "상태: 대기",
            foreground="orange" if running else "gray",
        )
        self.btn_run.config(state="disabled" if running else "normal")

    def _run_now(self):
        self._set_running(True)
        bot = self._make_bot()
        bot.run_once()

    def _on_cycle_done(self):
        """백그라운드 스레드에서 호출됨 — 모든 UI 조작을 after()로 위임."""
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
            # 타이머 중지
            if self.bot:
                self.bot.stop_timer()
            self.timer_running = False
            self._next_run_time = None
            self.btn_timer.config(text="⏱ 타이머 시작")
            self.lbl_status.config(text="상태: 대기", foreground="gray")
            self._log("⏹ 타이머 중지")
        else:
            h = self.var_interval.get()
            if h == 0:
                messagebox.showinfo("알림", "수동 모드에서는 타이머를 사용할 수 없습니다.")
                return
            self.bot = self._make_bot()
            self.bot.start_timer(h)
            self.timer_running = True
            self._next_run_time = datetime.now() + timedelta(hours=h)
            self.btn_timer.config(text="⏹ 타이머 중지")
            self.lbl_status.config(text=f"상태: 타이머 실행 ({h}h)", foreground="green")
            self._log(f"⏱ 타이머 시작 — {h}시간 주기")

    def _tick(self):
        """매 초 카운트다운 업데이트"""
        if self._next_run_time:
            remaining = self._next_run_time - datetime.now()
            if remaining.total_seconds() > 0:
                h, rem = divmod(int(remaining.total_seconds()), 3600)
                m, s = divmod(rem, 60)
                self.lbl_next.config(text=f"다음 실행까지 {h:02d}:{m:02d}:{s:02d}")
            else:
                self.lbl_next.config(text="")
        else:
            self.lbl_next.config(text="")
        self.after(1000, self._tick)

    # ── 키워드 탭 ─────────────────────────────────────────────────────────────

    def _refresh_keywords(self):
        vault = self.var_vault.get().strip()
        if not vault:
            return
        store = KeywordStore(vault, self.cfg.get("keyword_index_path", KEYWORD_INDEX_REL_PATH))
        try:
            store.load()
        except KeywordStoreError as e:
            self.lbl_kw_count.config(text="키워드: 로드 실패")
            self._log(f"❌ 키워드 인덱스 로드 실패: {e}")
            return
        kws = store.get_keywords()
        self.lbl_kw_count.config(text=f"키워드: {len(kws)}개")

        # 트리뷰 갱신
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
        if not messagebox.askyesno("확인", f"'{kw}' 키워드를 삭제하시겠습니까?"):
            return
        vault = self.var_vault.get().strip()
        store = KeywordStore(vault, self.cfg.get("keyword_index_path", KEYWORD_INDEX_REL_PATH))
        try:
            store.load()
            store.remove(kw)
            store.save()
        except KeywordStoreError as e:
            messagebox.showerror("키워드 인덱스 오류", str(e))
            self._log(f"❌ 키워드 삭제 중단 (인덱스 보호): {e}")
            return
        self._refresh_keywords()
        self._log(f"🗑 키워드 삭제: {kw}")

    def _add_keyword_dialog(self):
        dialog = tk.Toplevel(self)
        dialog.title("키워드 추가")
        dialog.geometry("440x160")
        dialog.resizable(False, False)
        dialog.grab_set()

        frm = ttk.Frame(dialog, padding=12)
        frm.pack(fill="both", expand=True)

        ttk.Label(frm, text="키워드:").grid(row=0, column=0, sticky="w", pady=4)
        var_kw = tk.StringVar()
        ttk.Entry(frm, textvariable=var_kw, width=35).grid(row=0, column=1, sticky="ew", padx=4)

        ttk.Label(frm, text="허브 문서 stem:").grid(row=1, column=0, sticky="w", pady=4)
        var_hub = tk.StringVar()
        ttk.Entry(frm, textvariable=var_hub, width=35).grid(row=1, column=1, sticky="ew", padx=4)

        ttk.Label(frm, text="표시명 (선택):").grid(row=2, column=0, sticky="w", pady=4)
        var_disp = tk.StringVar()
        ttk.Entry(frm, textvariable=var_disp, width=35).grid(row=2, column=1, sticky="ew", padx=4)

        def on_ok():
            kw = var_kw.get().strip()
            hub = var_hub.get().strip()
            if not kw or not hub:
                messagebox.showwarning("입력 오류", "키워드와 허브 stem을 입력하세요.", parent=dialog)
                return
            vault = self.var_vault.get().strip()
            store = KeywordStore(vault, self.cfg.get("keyword_index_path", KEYWORD_INDEX_REL_PATH))
            try:
                store.load()
                store.upsert(kw, hub, var_disp.get().strip() or kw)
                store.save()
            except KeywordStoreError as e:
                messagebox.showerror("키워드 인덱스 오류", str(e), parent=dialog)
                self._log(f"❌ 키워드 추가 중단 (인덱스 보호): {e}")
                return
            dialog.destroy()
            self._refresh_keywords()
            self._log(f"➕ 키워드 추가: {kw} → {hub}")

        btn_frm = ttk.Frame(frm)
        btn_frm.grid(row=3, column=0, columnspan=2, pady=8)
        ttk.Button(btn_frm, text="추가", command=on_ok, width=10).pack(side="left", padx=4)
        ttk.Button(btn_frm, text="취소", command=dialog.destroy, width=10).pack(side="left", padx=4)
        frm.columnconfigure(1, weight=1)

    # ── 인덱스 파일 탭 ────────────────────────────────────────────────────────

    def _refresh_index_list(self):
        vault = self.var_vault.get().strip()
        if not vault or not Path(vault).exists():
            return
        # vault 전체에서 index_*.md 파일 수집
        paths = sorted(
            Path(vault).rglob("index_*.md"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        self._idx_paths = [str(p) for p in paths]
        self.lbl_idx_count.config(text=f"인덱스 파일: {len(paths)}개")
        self.idx_listbox.delete(0, "end")
        for p in paths:
            # 상대 경로로 표시
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
            content = f"❌ 파일 읽기 실패: {e}"
        self.idx_content.configure(state="normal")
        self.idx_content.delete("1.0", "end")
        self.idx_content.insert("end", content)
        self.idx_content.configure(state="disabled")

    # ── Slack 탭 ─────────────────────────────────────────────────────────────

    def _slack_log(self, msg: str):
        """메인 스레드 전용 — Slack 로그 위젯에 직접 출력."""
        self.txt_slack_log.configure(state="normal")
        ts = datetime.now().strftime("%H:%M:%S")
        self.txt_slack_log.insert("end", f"[{ts}] {msg}\n")
        self.txt_slack_log.see("end")
        self.txt_slack_log.configure(state="disabled")

    def _slack_log_threadsafe(self, msg: str):
        """백그라운드 스레드에서 호출 — after()로 위임."""
        self.after(0, lambda m=msg: self._slack_log(m))

    def _clear_slack_log(self):
        self.txt_slack_log.configure(state="normal")
        self.txt_slack_log.delete("1.0", "end")
        self.txt_slack_log.configure(state="disabled")

    def _set_slack_status(self, running: bool):
        if running:
            self.btn_slack.config(text="⏹ Slack 봇 중지")
            self.lbl_slack_status.config(text="상태: 실행 중", foreground="green")
        else:
            self.btn_slack.config(text="▶ Slack 봇 시작")
            self.lbl_slack_status.config(text="상태: 중지", foreground="gray")

    def _on_slack_stopped(self, running: bool):
        """SlackBotRunner가 종료 시 호출 (백그라운드 스레드에서)."""
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
    parser.add_argument("--headless", action="store_true", help="Tkinter 없이 Slack 봇만 실행")
    parser.add_argument("--config", default=None, help="사용할 config 파일 경로 (기본: config.json)")
    args = parser.parse_args()

    # --config 인자로 CONFIG_PATH 오버라이드 (볼트별 봇 인스턴스 지원)
    if args.config:
        CONFIG_PATH = Path(args.config).resolve()

    if args.headless:
        import signal
        import io
        import traceback as _traceback
        import threading as _threading
        import datetime as _datetime
        # Windows cp949 환경에서 이모지 출력 가능하도록 stdout을 UTF-8로 교체
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

        # ── 크래시 훅: 미처리 예외/스레드 예외를 crash.log 에 스택 포함으로 기록 ──
        # Electron 래퍼가 stderr 쓰기 실패를 조용히 삼켜서 스택트레이스가 유실되는 문제를 방지한다.
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
            # stderr 로도 내보내 Electron 로그 스트림에 [ERR] 로 남도록 (실패해도 무시)
            try:
                sys.stderr.write(body)
                sys.stderr.flush()
            except Exception:
                # 최종 폴백: TextIOWrapper 가 깨진 경우 raw fd 2 에 직접 쓰기
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
            _log("[ERR] Python<3.8 — threading.excepthook 미지원, 스레드 크래시 유실 가능")

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
            print("[ERROR] 봇 시작 중 예외", flush=True)
            sys.exit(1)
        if not ok:
            print("[ERROR] 봇 시작 실패", flush=True)
            sys.exit(1)

        print("[READY] Slack bot started", flush=True)

        def _shutdown(sig, frame):
            print("[STOP] 봇 종료 중...", flush=True)
            runner.stop()
            sys.exit(0)

        signal.signal(signal.SIGINT, _shutdown)
        signal.signal(signal.SIGTERM, _shutdown)

        while runner.is_running():
            time.sleep(1)
        print("[STOP] 봇이 예기치 않게 종료됨", flush=True)
    else:
        app = App()
        app.mainloop()
