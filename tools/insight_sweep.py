"""
insight_sweep.py — 볼트 내부 문서를 분석해 인사이트 리포트 생성

Claude API를 직접 호출해 패턴·모순·반복 신호·설계 공백을 탐지합니다.
external-reference 문서는 자동 제외 (내부 문서만 분석).

사용법:
  python insight_sweep.py --vault /path/to/vault/active --api-key sk-ant-xxx
  python insight_sweep.py --vault /path/to/vault/active --api-key sk-ant-xxx --model claude-sonnet-4-6
  python insight_sweep.py --vault /path/to/vault/active --api-key sk-ant-xxx --date-from 2024-01-01
  python insight_sweep.py --vault /path/to/vault/active --api-key sk-ant-xxx --top-n 15 --compare-refs

Edit Agent가 run_python_tool로 직접 호출 가능.
결과: {vault}/_insights/sweep-YYYY-MM-DD.md
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import date, datetime
from pathlib import Path
from typing import Optional

# ── 설정 ──────────────────────────────────────────────────────────────────────

DEFAULT_MODEL    = "claude-sonnet-4-6"
MAX_TOKENS       = 4096
MAX_DOC_CHARS    = 2000   # 문서 하나당 최대 문자 수 (컨텍스트 절약)
MAX_TOTAL_CHARS  = 80000  # 전체 컨텍스트 상한

SYSTEM_PROMPT = """당신은 게임 개발 프로젝트 볼트를 분석하는 인사이트 에이전트입니다.

분석 원칙:
1. 형식·문법 교정은 하지 않습니다. 오직 **의미·패턴·구조**만 분석합니다.
2. 여러 문서에서 반복되는 신호는 횟수와 함께 명시합니다.
3. 문서들 사이의 **모순이나 긴장 관계**를 명시적으로 찾아냅니다.
4. **"말해지지 않은 것"** — 피드백에 없지만 있어야 할 것을 지적합니다.
5. **설계 공백** — 있어야 할 문서나 결정이 없는 것을 탐지합니다.
6. 외부 레퍼런스 문서([외부 레퍼런스] 마커 포함)는 비교 컨텍스트로만 활용하고,
   프로젝트 내부 패턴처럼 서술하지 않습니다.

출력 형식:
- 마크다운, 섹션별로 구조화
- 각 발견사항마다 **근거 문서명** 명시
- 추측이 아닌 문서에서 실제로 발견한 것만 작성"""


# ── 파일 수집 ──────────────────────────────────────────────────────────────────

def is_external_reference(content: str) -> bool:
    """frontmatter에 type: external-reference가 있는지 확인."""
    if "type: external-reference" in content[:500]:
        return True
    if "[외부 레퍼런스]" in content[:300]:
        return True
    return False


def collect_docs(vault_path: str, date_from: Optional[str], top_n: int,
                 include_refs: bool) -> list[dict]:
    """
    볼트에서 분석 대상 문서를 수집합니다.
    우선순위: 피드백/회의록 > 기획서 > 레퍼런스
    external-reference는 include_refs=True일 때만 포함 (비교용으로 후미에 추가).
    """
    vault = Path(vault_path)
    md_files = list(vault.rglob("*.md"))

    # _insights/ 폴더 자체는 제외
    md_files = [f for f in md_files if "_insights" not in f.parts]

    docs = []
    ref_docs = []

    for f in md_files:
        try:
            content = f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue

        if not content.strip():
            continue

        # date_from 필터 (파일명 날짜 또는 frontmatter date)
        # 날짜를 추출할 수 없는 문서는 범위 불명이므로 제외
        if date_from:
            doc_date = _extract_date(f.name, content)
            if doc_date is None or doc_date < date_from:
                continue

        is_ext = is_external_reference(content)

        entry = {
            "filename": f.name,
            "relpath":  str(f.relative_to(vault)),
            "content":  content[:MAX_DOC_CHARS],
            "size":     len(content),
            "mtime":    f.stat().st_mtime,
            "is_ext":   is_ext,
        }

        if is_ext:
            ref_docs.append(entry)
        else:
            docs.append(entry)

    # 우선순위 정렬: 피드백/회의록 > 기획서 > 나머지 (최신순)
    def priority(d: dict) -> tuple:
        name = d["filename"].lower()
        if "피드백" in name or "feedback" in name:
            return (0, -d["mtime"])
        if "회의록" in name or "정례" in name or "meeting" in name:
            return (1, -d["mtime"])
        if "기획" in name or "제안" in name or "spec" in name:
            return (2, -d["mtime"])
        return (3, -d["mtime"])

    docs.sort(key=priority)
    selected = docs[:top_n]

    # 외부 레퍼런스는 비교 컨텍스트용으로 최대 5개만 후미 추가
    if include_refs and ref_docs:
        selected += ref_docs[:5]

    return selected


def _extract_date(filename: str, content: str) -> Optional[str]:
    """파일명 또는 frontmatter에서 날짜 추출 (YYYY-MM-DD 형식)."""
    # 파일명 패턴: [2026_03_11], 2026-03-11, 20260311
    m = re.search(r"(\d{4})[._\-](\d{2})[._\-](\d{2})", filename)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    # frontmatter date:
    m = re.search(r"^date:\s*(\d{4}-\d{2}-\d{2})", content[:300], re.MULTILINE)
    if m:
        return m.group(1)
    return None


# ── Claude API 호출 ────────────────────────────────────────────────────────────

def call_claude(api_key: str, model: str, system: str, user: str) -> str:
    payload = json.dumps({
        "model":      model,
        "max_tokens": MAX_TOKENS,
        "system":     system,
        "messages":   [{"role": "user", "content": user}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers={
            "Content-Type":      "application/json",
            "x-api-key":         api_key,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data["content"][0]["text"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Claude API 오류 {e.code}: {body[:300]}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Claude API 네트워크 오류: {e.reason}")


# ── 리포트 생성 ────────────────────────────────────────────────────────────────

def build_user_prompt(docs: list[dict], date_from: Optional[str], include_refs: bool) -> str:
    lines = []

    # 분석 지시
    lines.append("## 분석 지시")
    lines.append("")
    lines.append("아래 문서들을 분석해 다음 섹션으로 구성된 인사이트 리포트를 작성하세요:")
    lines.append("")
    lines.append("1. **반복 신호** — 여러 문서에서 반복되는 패턴, 우려, 요청 (횟수 명시)")
    lines.append("2. **모순 및 긴장 관계** — 서로 상충하는 내용이나 방향성")
    lines.append("3. **말해지지 않은 것** — 있어야 할 논의가 없는 영역")
    lines.append("4. **설계 공백** — 있어야 할 문서나 결정이 없는 것")
    lines.append("5. **핵심 인사이트 TOP 3** — 가장 주목해야 할 발견사항 요약")
    if include_refs:
        lines.append("6. **외부 게임과의 비교** — _reference/games/ 문서와 대비해 주목할 차이점 (있을 경우)")
    lines.append("")
    if date_from:
        lines.append(f"> 분석 범위: {date_from} 이후 문서만 포함 (게임 설계 변경 이전 데이터 오염 방지)")
        lines.append("")

    # 문서 목록
    internal = [d for d in docs if not d["is_ext"]]
    external = [d for d in docs if d["is_ext"]]

    lines.append(f"## 내부 문서 ({len(internal)}개)")
    lines.append("")

    total_chars = 0
    for d in internal:
        if total_chars + len(d["content"]) > MAX_TOTAL_CHARS:
            lines.append(f"_(컨텍스트 한도로 이후 문서 생략)_")
            break
        lines.append(f"### [{d['relpath']}]")
        lines.append("")
        lines.append(d["content"])
        lines.append("")
        lines.append("---")
        lines.append("")
        total_chars += len(d["content"])

    if external:
        lines.append(f"## 외부 레퍼런스 문서 ({len(external)}개) — 비교 컨텍스트 전용")
        lines.append("")
        lines.append("> ⚠️ 아래 문서들은 외부 출시 게임 데이터입니다. 내부 패턴과 혼동하지 마세요.")
        lines.append("")
        for d in external:
            ref_content = d["content"][:1000]  # 외부 레퍼런스는 짧게
            if total_chars + len(ref_content) > MAX_TOTAL_CHARS:
                lines.append(f"_(컨텍스트 한도로 이후 외부 레퍼런스 문서 생략)_")
                break
            lines.append(f"### [{d['filename']}]")
            lines.append("")
            lines.append(ref_content)
            lines.append("")
            lines.append("---")
            lines.append("")
            total_chars += len(ref_content)

    return "\n".join(lines)


def build_report(insight_text: str, docs: list[dict], args) -> str:
    today     = date.today().isoformat()
    now       = datetime.now().strftime("%Y-%m-%d %H:%M")
    n_int     = sum(1 for d in docs if not d["is_ext"])
    n_ext     = sum(1 for d in docs if d["is_ext"])

    header = [
        "---",
        "type: insight-report",
        f"date: {today}",
        f"model: {args.model}",
        f"analyzed_docs: {n_int}",
        f"ref_docs: {n_ext}",
        f"date_from: {args.date_from or 'all'}",
        "internal: true",
        "---",
        "",
        f"# 인사이트 스윕 — {today}",
        "",
        f"> 생성: {now} | 모델: {args.model} | 분석 문서: {n_int}개 내부 + {n_ext}개 외부 레퍼런스",
        f"> 분석 범위: {args.date_from + ' 이후' if args.date_from else '전체'}",
        "",
        "---",
        "",
    ]

    return "\n".join(header) + insight_text


# ── 메인 ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="볼트 인사이트 스윕 — 패턴·모순·공백 탐지")
    parser.add_argument("--vault",       required=True,                help="볼트 active 폴더 경로")
    parser.add_argument("--api-key",     default="",                   help="Anthropic API 키 (없으면 환경변수 ANTHROPIC_API_KEY 사용)")
    parser.add_argument("--model",       default=DEFAULT_MODEL,        help=f"모델 ID (기본: {DEFAULT_MODEL})")
    parser.add_argument("--top-n",       type=int, default=20,         help="분석할 내부 문서 수 (기본: 20)")
    parser.add_argument("--date-from",   default="",                   help="이 날짜 이후 문서만 분석 (YYYY-MM-DD, 기본: 전체)")
    parser.add_argument("--compare-refs", action="store_true",         help="외부 레퍼런스 문서도 비교 컨텍스트로 포함")
    parser.add_argument("--output",      default="",                   help="출력 파일 경로 (기본: vault/_insights/sweep-YYYY-MM-DD.md)")
    parser.add_argument("--verbose",     action="store_true",          help="상세 출력")
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("오류: --api-key 또는 환경변수 ANTHROPIC_API_KEY가 필요합니다.", file=sys.stderr)
        sys.exit(1)

    vault_path = os.path.abspath(args.vault)
    if not os.path.isdir(vault_path):
        print(f"오류: 볼트 경로를 찾을 수 없습니다: {vault_path}", file=sys.stderr)
        sys.exit(1)

    date_from = args.date_from.strip() or None

    print(f"[insight_sweep] 문서 수집 중... (date_from={date_from or '전체'})")
    docs = collect_docs(vault_path, date_from, args.top_n, args.compare_refs)
    n_int = sum(1 for d in docs if not d["is_ext"])
    n_ext = sum(1 for d in docs if d["is_ext"])
    print(f"  → 내부 문서 {n_int}개, 외부 레퍼런스 {n_ext}개")

    if n_int == 0:
        print("분석할 내부 문서가 없습니다.", file=sys.stderr)
        sys.exit(1)

    if args.verbose:
        for d in docs:
            tag = "[EXT]" if d["is_ext"] else "     "
            print(f"  {tag} {d['relpath']} ({d['size']:,}자)")

    print(f"[insight_sweep] Claude API 호출 중 (모델: {args.model})...")
    user_prompt = build_user_prompt(docs, date_from, args.compare_refs)

    try:
        insight_text = call_claude(api_key, args.model, SYSTEM_PROMPT, user_prompt)
    except RuntimeError as e:
        print(f"오류: {e}", file=sys.stderr)
        sys.exit(1)

    report = build_report(insight_text, docs, args)

    # 출력 경로 결정
    if args.output:
        out_path = args.output
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    else:
        insights_dir = os.path.join(vault_path, "_insights")
        os.makedirs(insights_dir, exist_ok=True)
        out_path = os.path.join(insights_dir, f"sweep-{date.today().isoformat()}.md")

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(report)

    print(f"[insight_sweep] 완료 → {out_path}")
    # Edit Agent가 결과 경로를 읽을 수 있도록 stdout에도 출력
    print(f"INSIGHT_OUTPUT={out_path}")


if __name__ == "__main__":
    main()
