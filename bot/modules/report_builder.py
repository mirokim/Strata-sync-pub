"""보고서 생성 모듈"""
from __future__ import annotations

import html as _html_mod
import re
from datetime import datetime
from pathlib import Path
from typing import Callable


# ── 이모지 제거 정규식 ────────────────────────────────────────────────────────
_EMOJI_RE = re.compile(
    "["
    "\U0001F000-\U0001FFFF"   # 이모지 보충 블록 전체
    "\u2600-\u27BF"           # 잡다한 기호 (☐☑☒ 등 포함)
    "\u2B00-\u2BFF"           # 보충 화살표·기하
    "\u23E9-\u23F3"           # 시계·미디어 기호
    "\uFE00-\uFE0F"           # variation selector
    "\U0001FA00-\U0001FA9F"   # 체스·기타 확장
    "]+",
    re.UNICODE,
)


def _strip_emoji(text: str) -> str:
    """이모지 및 wkhtmltopdf 비호환 특수문자 제거."""
    return _EMOJI_RE.sub("", text)


def _md_to_html(text: str) -> str:
    """마크다운 텍스트를 HTML로 변환 (chat 보고서용 — 코드블록·테이블 지원)."""
    lines, out = text.splitlines(), []
    in_code = False
    in_table = False
    table_rows: list[str] = []

    def flush_table() -> None:
        if not table_rows:
            return
        rows_html = []
        for ri, row in enumerate(table_rows):
            cells = [c.strip() for c in row.strip("|").split("|")]
            tag = "th" if ri == 0 else "td"
            rows_html.append("<tr>" + "".join(f"<{tag}>{c}</{tag}>" for c in cells) + "</tr>")
        out.append('<table border="1" cellpadding="4" cellspacing="0" style="border-collapse:collapse;margin:8px 0">')
        out.extend(rows_html)
        out.append("</table>")
        table_rows.clear()

    for line in lines:
        # 코드블록 토글
        if line.startswith("```"):
            if not in_code:
                if in_table:
                    flush_table()
                    in_table = False
                out.append('<pre style="background:#f1f5f9;padding:10px;border-radius:4px;overflow-x:auto"><code>')
                in_code = True
            else:
                out.append("</code></pre>")
                in_code = False
            continue
        if in_code:
            out.append(_html_mod.escape(line))
            continue

        # 테이블 행 감지
        if line.startswith("|") and line.endswith("|"):
            if not in_table:
                in_table = True
            # 구분선 행(|---|---| 패턴)은 건너뜀
            if re.fullmatch(r'[\|\-\s:]+', line):
                continue
            table_rows.append(line)
            continue
        else:
            if in_table:
                flush_table()
                in_table = False

        escaped = _html_mod.escape(_strip_emoji(line))
        if escaped.startswith("### "):
            out.append(f"<h3>{escaped[4:]}</h3>")
        elif escaped.startswith("## "):
            out.append(f"<h2>{escaped[3:]}</h2>")
        elif escaped.startswith("# "):
            out.append(f"<h1>{escaped[2:]}</h1>")
        elif escaped.startswith("- ") or escaped.startswith("* "):
            out.append(f"<li>{escaped[2:]}</li>")
        elif escaped.strip() in ("---", "***"):
            out.append("<hr>")
        elif escaped.strip() == "":
            out.append("<br>")
        else:
            escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
            escaped = re.sub(r"`(.+?)`", r"<code>\1</code>", escaped)
            out.append(f"<p>{escaped}</p>")

    if in_table:
        flush_table()
    if in_code:
        out.append("</code></pre>")
    return "\n".join(out)


def _md_to_html_mirofish(text: str) -> str:
    """마크다운 텍스트를 HTML로 변환 (MiroFish 보고서용 — 간결 버전)."""
    lines, out = text.splitlines(), []
    for line in lines:
        escaped = _html_mod.escape(_strip_emoji(line))
        if escaped.startswith("### "):
            out.append(f"<h4>{escaped[4:]}</h4>")
        elif escaped.startswith("## "):
            out.append(f"<h3>{escaped[3:]}</h3>")
        elif escaped.startswith("- ") or escaped.startswith("• "):
            out.append(f"<li>{escaped[2:]}</li>")
        elif escaped.startswith("**") and escaped.endswith("**"):
            out.append(f"<strong>{escaped[2:-2]}</strong>")
        elif escaped == "---" or escaped == "━" * 3:
            out.append("<hr>")
        elif escaped.strip() == "":
            out.append("<br>")
        else:
            # 인라인 볼드 **text**
            escaped = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", escaped)
            out.append(f"<p>{escaped}</p>")
    return "\n".join(out)


class ReportBuilder:
    def __init__(self, web_client, log_fn: Callable[[str], None]):
        self._web = web_client
        self._log = log_fn

    def generate_report_html(self, title: str, content: str) -> Path:
        """LLM 보고서 마크다운을 wkhtmltopdf 호환 HTML 파일로 저장. 파일 경로 반환."""
        _CHAT_REPORTS_DIR = Path(__file__).parent.parent / "reports" / "chat"
        _CHAT_REPORTS_DIR.mkdir(parents=True, exist_ok=True)

        now_str  = datetime.now().strftime("%Y%m%d_%H%M")
        date_str = datetime.now().strftime("%Y년 %m월 %d일")
        safe_title = re.sub(r'[\\/*?:"<>|]', "", title)[:40].strip()
        filename = f"{now_str}_{safe_title}.html"
        filepath = _CHAT_REPORTS_DIR / filename
        body_html = _md_to_html(content)

        html_content = f"""<!DOCTYPE html>
<html lang="ko">
<head><meta charset="UTF-8"><title>{_html_mod.escape(title)}</title>
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ font-family:'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif; font-size:13px; line-height:1.75; color:#1e293b; background:#fff; }}
.cover {{ background:#0f172a; color:#f1f5f9; padding:48px 56px 40px; }}
.cover-tag {{ font-size:10px; letter-spacing:3px; text-transform:uppercase; color:#64748b; margin-bottom:16px; }}
.cover-title {{ font-size:26px; font-weight:700; color:#f8fafc; margin-bottom:8px; line-height:1.3; }}
.cover-date {{ font-size:12px; color:#94a3b8; }}
.body {{ padding:40px 56px; max-width:900px; margin:0 auto; }}
h1 {{ font-size:20px; font-weight:700; color:#0f172a; margin:28px 0 12px; border-bottom:2px solid #3b82f6; padding-bottom:6px; }}
h2 {{ font-size:17px; font-weight:700; color:#1e3a5f; margin:24px 0 10px; }}
h3 {{ font-size:14px; font-weight:700; color:#334155; margin:18px 0 8px; }}
p {{ margin:8px 0; }}
ul, ol {{ margin:8px 0 8px 24px; }}
li {{ margin:4px 0; list-style:disc; }}
hr {{ border:none; border-top:1px solid #e2e8f0; margin:20px 0; }}
strong {{ font-weight:700; }}
code {{ background:#f1f5f9; padding:1px 4px; border-radius:3px; font-size:12px; font-family:monospace; }}
table {{ border-collapse:collapse; margin:8px 0; width:100%; }}
th, td {{ border:1px solid #cbd5e1; padding:6px 10px; text-align:left; font-size:12px; }}
th {{ background:#f8fafc; font-weight:700; }}
.footer {{ margin-top:48px; padding-top:14px; border-top:1px solid #e2e8f0; font-size:10px; color:#94a3b8; text-align:center; }}
</style>
</head><body>
<div class="cover">
  <div class="cover-tag">Strata Sync &middot; Report</div>
  <div class="cover-title">{_html_mod.escape(title)}</div>
  <div class="cover-date">{date_str}</div>
</div>
<div class="body">
{body_html}
  <div class="footer">Strata Sync &mdash; {date_str} 생성</div>
</div></body></html>"""

        filepath.write_text(html_content, encoding="utf-8")
        self._log(f"[보고서] HTML 저장: {filepath}")
        return filepath

    def generate_mirofish_html(
        self,
        topic: str,
        report: str,
        feed: list,
        num_personas: int,
        num_rounds: int,
        pm_brief: str | None = None,
    ) -> Path:
        """MiroFish 결과를 HTML 파일로 저장. 파일 경로 반환."""
        _REPORTS_DIR = Path(__file__).parent.parent / "reports" / "mirofish"
        _REPORTS_DIR.mkdir(parents=True, exist_ok=True)

        now_str    = datetime.now().strftime("%Y%m%d_%H%M")
        safe_topic = re.sub(r'[\\/*?:"<>|]', "", topic)[:40].strip()
        filename   = f"{now_str}_{safe_topic}.html"
        filepath   = _REPORTS_DIR / filename

        # 스탠스별 집계
        stance_counts: dict[str, int] = {}
        for p in feed:
            s = p.get("stance", "neutral")
            stance_counts[s] = stance_counts.get(s, 0) + 1
        total_posts = len(feed)

        STANCE_LABEL  = {"supportive": "지지", "opposing": "반대", "neutral": "중립", "observer": "관찰"}
        STANCE_COLOR  = {"supportive": "#00b894", "opposing": "#d63031", "neutral": "#636e72", "observer": "#0984e3"}
        BADGE_CLASS   = {"supportive": "badge-supportive", "opposing": "badge-opposing",
                         "neutral": "badge-neutral", "observer": "badge-observer"}
        AVATAR_INITIAL = {"supportive": "지", "opposing": "반", "neutral": "중", "observer": "관"}

        # 피드 카드
        feed_html_parts = []
        for post in feed:
            stance   = post.get("stance", "neutral")
            label_ko = STANCE_LABEL.get(stance, stance)
            badge    = BADGE_CLASS.get(stance, "badge-neutral")
            initial  = AVATAR_INITIAL.get(stance, "중")
            av_color = STANCE_COLOR.get(stance, "#888")
            content  = _html_mod.escape(_strip_emoji(post.get("content", "")))
            name     = _html_mod.escape(_strip_emoji(post.get("personaName", "")))
            rnd      = post.get("round", "?")
            likes    = post.get("likes", 0)
            reposts  = post.get("reposts", 0)
            is_repost = post.get("actionType") == "repost"
            repost_tag = '<div class="repost-label">↩ 리포스트</div>' if is_repost else ""
            feed_html_parts.append(f"""
                <div class="feed-item">
                  <div class="feed-avatar">
                    <div class="feed-avatar-inner" style="background:{av_color};color:#fff;">{initial}</div>
                  </div>
                  <div class="feed-body">
                    <div class="feed-header">
                      <span class="feed-name">{name}</span>
                      <span class="badge {badge}">{label_ko}</span>
                      <span class="feed-round">R{rnd}</span>
                      <span class="feed-engagement">좋아요 {likes} / 리포스트 {reposts}</span>
                    </div>
                    {repost_tag}
                    <div class="feed-content">{content}</div>
                  </div>
                </div>""")

        # 스탠스 분포 바
        stance_bar_parts = []
        for s, cnt in sorted(stance_counts.items(), key=lambda x: -x[1]):
            color = STANCE_COLOR.get(s, "#888")
            lbl   = STANCE_LABEL.get(s, s)
            pct   = round(cnt / total_posts * 100) if total_posts else 0
            stance_bar_parts.append(
                f'<div class="stance-count">'
                f'<div class="stance-dot" style="background:{color}"></div>'
                f'{lbl} {cnt}건 ({pct}%)</div>'
            )

        brief_section = ""
        if pm_brief:
            brief_section = f"""
            <div class="section">
              <h2>PM 브리프</h2>
              <div class="report-text">{_md_to_html_mirofish(pm_brief)}</div>
            </div>"""

        html = f"""<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MiroFish — {_html_mod.escape(topic)}</title>
<style>
* {{ margin:0; padding:0; box-sizing:border-box; }}
body {{ font-family:'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif; background:#f5f6fa; color:#2d3436; }}
/* 헤더 — wkhtmltopdf 호환: gradient 대신 단색, opacity 미사용 */
.header {{ background:#0984e3; color:#ffffff; padding:28px 36px; }}
.header h1 {{ font-size:20px; font-weight:700; margin-bottom:6px; color:#ffffff; }}
.header .meta {{ font-size:12px; color:#d0e8ff; margin-bottom:16px; }}
/* stats: inline-block으로 gap 대체 */
.stats {{ margin-top:4px; }}
.stat {{ display:inline-block; background:#1a6fba; padding:10px 18px; border-radius:6px;
         text-align:center; margin-right:10px; margin-bottom:8px; min-width:80px; }}
.stat .val {{ font-size:24px; font-weight:700; color:#ffffff; display:block; }}
.stat .lbl {{ font-size:11px; color:#b8d8f5; display:block; margin-top:2px; }}
/* 본문 */
.content {{ max-width:860px; margin:24px auto; padding:0 20px; }}
.section {{ background:#ffffff; border-radius:8px; padding:24px; margin-bottom:18px;
            border:1px solid #e0e0e0; }}
.section h2 {{ font-size:15px; font-weight:700; color:#1a1a2e; margin-bottom:16px;
               padding-bottom:8px; border-bottom:2px solid #e8ecf0; }}
.report-text p {{ line-height:1.8; color:#444; margin-bottom:8px; }}
.report-text h3 {{ color:#0984e3; font-size:14px; font-weight:700; margin:16px 0 6px; }}
.report-text h4 {{ color:#555; font-size:13px; font-weight:700; margin:10px 0 4px; }}
.report-text li {{ line-height:1.8; color:#444; margin-left:18px; margin-bottom:3px; }}
.report-text hr {{ border:none; border-top:1px solid #eee; margin:14px 0; }}
/* stance bar: inline-block */
.stance-bar {{ margin-bottom:16px; }}
.stance-count {{ display:inline-block; margin-right:14px; margin-bottom:6px;
                 font-size:12px; color:#555; vertical-align:middle; }}
.stance-dot {{ display:inline-block; width:9px; height:9px; border-radius:50%;
               margin-right:4px; vertical-align:middle; }}
/* feed: table 레이아웃으로 flex 대체 */
.feed-item {{ display:table; width:100%; margin-bottom:16px; padding-bottom:16px;
              border-bottom:1px solid #f0f0f0; }}
.feed-item:last-child {{ border-bottom:none; margin-bottom:0; padding-bottom:0; }}
.feed-avatar {{ display:table-cell; width:36px; vertical-align:top; padding-right:12px; }}
.feed-avatar-inner {{ width:34px; height:34px; border-radius:50%; background:#e8ecf0;
                       text-align:center; line-height:34px; font-size:13px; font-weight:700; color:#555; }}
.feed-body {{ display:table-cell; vertical-align:top; }}
.feed-header {{ margin-bottom:5px; }}
.feed-name {{ font-weight:700; font-size:13px; margin-right:6px; }}
.feed-round {{ font-size:11px; color:#aaa; margin-right:6px; }}
.feed-engagement {{ font-size:11px; color:#aaa; }}
.feed-content {{ font-size:13px; line-height:1.65; color:#444; background:#f8f9fa;
                 padding:9px 13px; border-radius:6px; margin-top:4px; }}
.repost-label {{ font-size:11px; color:#999; margin-bottom:3px; }}
.badge {{ padding:2px 7px; border-radius:10px; font-size:10px; font-weight:700; margin-right:4px; }}
.badge-supportive {{ background:#d4f0e0; color:#007a37; }}
.badge-opposing   {{ background:#fde8e8; color:#b52b2b; }}
.badge-neutral    {{ background:#e8eaf0; color:#555; }}
.badge-observer   {{ background:#d8ecfd; color:#0068b5; }}
footer {{ text-align:center; color:#bbb; font-size:11px; padding:20px; }}
</style>
</head>
<body>
<div class="header">
  <h1>MiroFish 시뮬레이션 보고서</h1>
  <div class="meta">주제: {_html_mod.escape(topic)} | {datetime.now().strftime("%Y-%m-%d %H:%M")}</div>
  <div class="stats">
    <div class="stat"><span class="val">{num_personas}</span><span class="lbl">페르소나</span></div>
    <div class="stat"><span class="val">{num_rounds}</span><span class="lbl">라운드</span></div>
    <div class="stat"><span class="val">{total_posts}</span><span class="lbl">총 게시물</span></div>
    <div class="stat"><span class="val">{stance_counts.get('supportive',0)}</span><span class="lbl">지지</span></div>
    <div class="stat"><span class="val">{stance_counts.get('opposing',0)}</span><span class="lbl">반대</span></div>
    <div class="stat"><span class="val">{stance_counts.get('neutral',0)}</span><span class="lbl">중립</span></div>
  </div>
</div>
<div class="content">
  {brief_section}
  <div class="section">
    <h2>분석 보고서</h2>
    <div class="report-text">{_md_to_html_mirofish(report)}</div>
  </div>
  <div class="section">
    <h2>시뮬레이션 피드 ({total_posts}개)</h2>
    <div class="stance-bar">{''.join(stance_bar_parts)}</div>
    {''.join(feed_html_parts)}
  </div>
</div>
<footer>Generated by Strata Sync Bot · MiroFish</footer>
</body>
</html>"""

        filepath.write_text(html, encoding="utf-8")
        self._log(f"[MiroFish] HTML 보고서 저장: {filepath}")
        return filepath

    def upload_file_to_slack(
        self,
        filepath: Path,
        channel: str,
        thread_ts: str | None,
        title: str = "",
    ) -> bool:
        """파일을 Slack에 업로드. 성공 여부 반환."""
        import requests as _req
        try:
            content  = filepath.read_bytes()
            filename = filepath.name
            resp     = self._web.files_getUploadURLExternal(filename=filename, length=len(content))
            upload_url = resp["upload_url"]
            file_id    = resp["file_id"]
            _req.post(upload_url, data=content, timeout=30)
            kw: dict = {
                "files": [{"id": file_id, "title": title or filename}],
                "channel_id": channel,
            }
            if thread_ts:
                kw["thread_ts"] = thread_ts
            self._web.files_completeUploadExternal(**kw)
            self._log(f"[MiroFish] HTML 업로드 완료: {filename}")
            return True
        except Exception as e:
            self._log(f"[MiroFish] HTML 업로드 실패: {e}")
            return False
