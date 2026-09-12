"""
slack_formatter.py — 표준 Markdown → Slack mrkdwn 변환

LLM 출력(표준 MD)을 Slack에서 올바르게 렌더링되는 mrkdwn으로 변환합니다.

Slack mrkdwn 지원:
  *bold*  _italic_  ~strikethrough~  `code`  ```codeblock```
  > blockquote   • bullet   <url|text> link
"""

import re


def md_to_slack(text: str) -> str:
    """표준 Markdown → Slack mrkdwn 변환."""
    if not text:
        return text

    lines = text.split('\n')
    result: list[str] = []

    for line in lines:
        line = _convert_line(line)
        result.append(line)

    text = '\n'.join(result)

    # 인라인 변환 (줄 단위가 아닌 전체 텍스트)
    text = _convert_inline(text)

    return text.strip()


def _convert_line(line: str) -> str:
    """줄 단위 변환: 헤딩, 수평선, 리스트."""
    stripped = line.strip()

    # 수평선: --- or *** or ___ → 시각적 구분선
    if re.match(r'^[-*_]{3,}\s*$', stripped):
        return '───────────────────'

    # 헤딩: ## 제목 → *제목*  (Slack에는 헤딩이 없으므로 볼드로)
    heading_match = re.match(r'^(#{1,6})\s+(.+)$', stripped)
    if heading_match:
        level = len(heading_match.group(1))
        title = heading_match.group(2).strip()
        # H1/H2: 볼드 + 줄바꿈, H3+: 볼드만
        if level <= 2:
            return f'\n*{title}*'
        return f'*{title}*'

    # 불릿 리스트: - 항목 → • 항목
    bullet_match = re.match(r'^(\s*)[-*]\s+(.+)$', line)
    if bullet_match:
        indent = bullet_match.group(1)
        content = bullet_match.group(2)
        # 들여쓰기 레벨에 따라 기호 변경
        depth = len(indent) // 2
        marker = '◦' if depth >= 1 else '•'
        return f'{"  " * depth}{marker} {content}'

    # 번호 리스트는 그대로 유지 (Slack에서 잘 표시됨)

    return line


def _convert_inline(text: str) -> str:
    """인라인 변환: 볼드, 이탤릭, 링크, 이미지."""
    # **볼드** → *볼드*  (Slack은 단일 * 사용)
    # 단, 이미 Slack 볼드(*text*)인 것은 건드리지 않음
    text = re.sub(r'\*\*(.+?)\*\*', r'*\1*', text)

    # __볼드__ → *볼드*
    text = re.sub(r'__(.+?)__', r'*\1*', text)

    # ![alt](URL) → <URL|alt> (alt 없으면 <URL>)
    # 링크 변환보다 먼저 처리해야 한다. 뒤에 두면 링크 규칙이 안쪽 [alt](URL) 만
    # 바꿔치기해 '!' 가 남고 `!<URL|alt>` 라는 깨진 형태로 렌더된다.
    text = re.sub(
        r'!\[([^\]]*)\]\(([^)]+)\)',
        lambda m: f'<{m.group(2)}|{m.group(1)}>' if m.group(1).strip() else f'<{m.group(2)}>',
        text,
    )

    # [링크텍스트](URL) → <URL|링크텍스트>
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<\2|\1>', text)

    # **(추론)** → _(추론)_
    text = text.replace('*(추론)*', '_(추론)_')

    return text
