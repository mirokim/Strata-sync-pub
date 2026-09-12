"""
slack_formatter.py — Standard Markdown → Slack mrkdwn conversion

Converts LLM output (standard MD) into mrkdwn that renders correctly in Slack.

Slack mrkdwn support:
  *bold*  _italic_  ~strikethrough~  `code`  ```codeblock```
  > blockquote   • bullet   <url|text> link
"""

import re


def md_to_slack(text: str) -> str:
    """Convert standard Markdown → Slack mrkdwn."""
    if not text:
        return text

    lines = text.split('\n')
    result: list[str] = []

    for line in lines:
        line = _convert_line(line)
        result.append(line)

    text = '\n'.join(result)

    # Inline conversion (whole text, not line by line)
    text = _convert_inline(text)

    return text.strip()


def _convert_line(line: str) -> str:
    """Line-level conversion: headings, horizontal rules, lists."""
    stripped = line.strip()

    # Horizontal rule: --- or *** or ___ → visual divider
    if re.match(r'^[-*_]{3,}\s*$', stripped):
        return '───────────────────'

    # Heading: ## Title → *Title*  (Slack has no headings, so use bold)
    heading_match = re.match(r'^(#{1,6})\s+(.+)$', stripped)
    if heading_match:
        level = len(heading_match.group(1))
        title = heading_match.group(2).strip()
        # H1/H2: bold + line break, H3+: bold only
        if level <= 2:
            return f'\n*{title}*'
        return f'*{title}*'

    # Bullet list: - item → • item
    bullet_match = re.match(r'^(\s*)[-*]\s+(.+)$', line)
    if bullet_match:
        indent = bullet_match.group(1)
        content = bullet_match.group(2)
        # Change the bullet symbol by indentation level
        depth = len(indent) // 2
        marker = '◦' if depth >= 1 else '•'
        return f'{"  " * depth}{marker} {content}'

    # Numbered lists are kept as-is (Slack renders them fine)

    return line


def _convert_inline(text: str) -> str:
    """Inline conversion: bold, italic, links, images."""
    # **bold** → *bold*  (Slack uses a single *)
    # But leave text that is already Slack bold (*text*) untouched
    text = re.sub(r'\*\*(.+?)\*\*', r'*\1*', text)

    # __bold__ → *bold*
    text = re.sub(r'__(.+?)__', r'*\1*', text)

    # ![alt](URL) → <URL|alt> (<URL> when there is no alt)
    # Must run before link conversion. If placed after, the link rule only replaces the inner
    # [alt](URL), leaving a stray '!' that renders as the broken form `!<URL|alt>`.
    text = re.sub(
        r'!\[([^\]]*)\]\(([^)]+)\)',
        lambda m: f'<{m.group(2)}|{m.group(1)}>' if m.group(1).strip() else f'<{m.group(2)}>',
        text,
    )

    # [link text](URL) → <URL|link text>
    text = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<\2|\1>', text)

    # **(inference)** → _(inference)_  (marker emitted by the citation-mode persona prompt)
    text = text.replace('*(inference)*', '_(inference)_')

    return text
