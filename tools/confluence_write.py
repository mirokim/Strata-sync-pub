#!/usr/bin/env python3
"""
confluence_write.py — Confluence page create/update (Markdown → Storage XML)

Usage:
  # Create a new page
  python confluence_write.py create "Page title" content.md
  python confluence_write.py create "Page title" content.md --space SGEPJA --parent 123456

  # Update an existing page
  python confluence_write.py update "New title" content.md --page-id 686860837

  # Read from stdin
  echo "# Title\nBody" | python confluence_write.py create "Page title" -

Config:
  Reads the confluence section of mcp-config.json.
  spaceKey and targetFolder (parentId) are used as defaults.
"""

import io
import re
import sys
import json
import argparse
import urllib.request
import urllib.error
import base64
import ssl
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

# ── Configuration loading ─────────────────────────────────────────────────────────────
ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / 'mcp-config.json'

def load_config() -> dict:
    with open(CONFIG_PATH, encoding='utf-8') as f:
        cfg = json.load(f)
    return cfg.get('confluence', {})

# ── HTTP helpers ────────────────────────────────────────────────────────────────
def make_ssl_ctx(cfg: dict) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if cfg.get('bypassSSL', False):
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx

def make_auth(cfg: dict) -> str:
    auth_type = cfg.get('authType', 'cloud')
    if auth_type == 'server_pat':
        return f"Bearer {cfg['apiToken']}"
    cred = base64.b64encode(f"{cfg['email']}:{cfg['apiToken']}".encode()).decode()
    return f"Basic {cred}"

def cf_request(cfg: dict, path: str, method: str = 'GET', body: dict | None = None) -> dict | None:
    base = cfg['baseUrl'].rstrip('/')
    url = f"{base}{path}"
    auth = make_auth(cfg)
    headers = {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    data = json.dumps(body).encode('utf-8') if body else None
    ctx = make_ssl_ctx(cfg)
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=ctx) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode('utf-8', errors='replace')
        print(f'[ERROR] {method} {path} → {e.code}: {body_text}', file=sys.stderr)
        return None

# ── Markdown → Confluence Storage XML ───────────────────────────────────────
def _escape(text: str) -> str:
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')

def md_to_storage(md: str) -> str:
    """Markdown → Confluence Storage Format XML (simplified conversion)"""
    lines = md.split('\n')
    out: list[str] = []
    in_code = False
    code_lang = ''
    code_buf: list[str] = []

    for line in lines:
        # Code block start/end
        if line.startswith('```'):
            if not in_code:
                in_code = True
                code_lang = line[3:].strip() or 'none'
                code_buf = []
            else:
                in_code = False
                body = _escape('\n'.join(code_buf))
                out.append(
                    f'<ac:structured-macro ac:name="code">'
                    f'<ac:parameter ac:name="language">{code_lang}</ac:parameter>'
                    f'<ac:plain-text-body><![CDATA[{chr(10).join(code_buf)}]]></ac:plain-text-body>'
                    f'</ac:structured-macro>'
                )
            continue

        if in_code:
            code_buf.append(line)
            continue

        # Heading
        m = re.match(r'^(#{1,6})\s+(.*)', line)
        if m:
            level = len(m.group(1))
            text = _escape(m.group(2))
            out.append(f'<h{level}>{text}</h{level}>')
            continue

        # Unordered list
        m = re.match(r'^(\s*)[-*]\s+(.*)', line)
        if m:
            text = _escape(m.group(2))
            out.append(f'<ul><li>{text}</li></ul>')
            continue

        # Ordered list
        m = re.match(r'^(\s*)\d+\.\s+(.*)', line)
        if m:
            text = _escape(m.group(2))
            out.append(f'<ol><li>{text}</li></ol>')
            continue

        # Horizontal rule
        if re.match(r'^---+$', line.strip()):
            out.append('<hr />')
            continue

        # Blank line
        if not line.strip():
            out.append('')
            continue

        # Regular paragraph
        text = _escape(line)
        # Inline bold
        text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
        text = re.sub(r'__(.+?)__', r'<strong>\1</strong>', text)
        # Inline italic
        text = re.sub(r'\*(.+?)\*', r'<em>\1</em>', text)
        # Inline code
        text = re.sub(r'`(.+?)`', r'<code>\1</code>', text)
        out.append(f'<p>{text}</p>')

    return '\n'.join(out)

# ── Page lookup ─────────────────────────────────────────────────────────────
def get_page_info(cfg: dict, page_id: str) -> dict | None:
    result = cf_request(cfg, f'/rest/api/content/{page_id}?expand=version,space')
    if not result:
        return None
    return {
        'id': result['id'],
        'title': result['title'],
        'version': result['version']['number'],
        'spaceKey': result['space']['key'],
    }

# ── Page creation ───────────────────────────────────────────────────────────
def create_page(cfg: dict, title: str, storage_body: str,
                space_key: str, parent_id: str | None = None) -> dict | None:
    body: dict = {
        'type': 'page',
        'title': title,
        'space': {'key': space_key},
        'body': {
            'storage': {
                'value': storage_body,
                'representation': 'storage',
            }
        },
    }
    if parent_id:
        body['ancestors'] = [{'id': parent_id}]
    return cf_request(cfg, '/rest/api/content', method='POST', body=body)

# ── Page update ─────────────────────────────────────────────────────────────
def update_page(cfg: dict, page_id: str, title: str,
                storage_body: str, current_version: int) -> dict | None:
    body = {
        'version': {'number': current_version + 1},
        'type': 'page',
        'title': title,
        'body': {
            'storage': {
                'value': storage_body,
                'representation': 'storage',
            }
        },
    }
    return cf_request(cfg, f'/rest/api/content/{page_id}', method='PUT', body=body)

# ── Main ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Confluence page create/update')
    sub = parser.add_subparsers(dest='cmd', required=True)

    # create
    p_create = sub.add_parser('create', help='Create a new page')
    p_create.add_argument('title', help='Page title')
    p_create.add_argument('file', help='Markdown file path (- for stdin)')
    p_create.add_argument('--space', default=None, help='Space key (default: value from mcp-config.json)')
    p_create.add_argument('--parent', default=None, help='Parent page ID')

    # update
    p_update = sub.add_parser('update', help='Update an existing page')
    p_update.add_argument('title', help='New title')
    p_update.add_argument('file', help='Markdown file path (- for stdin)')
    p_update.add_argument('--page-id', required=True, help='ID of the page to update')

    args = parser.parse_args()
    cfg = load_config()

    # Read Markdown
    if args.file == '-':
        md = sys.stdin.read()
    else:
        md = Path(args.file).read_text(encoding='utf-8')

    storage = md_to_storage(md)

    if args.cmd == 'create':
        space_key = args.space or cfg.get('spaceKey', '')
        if not space_key:
            print('[ERROR] --space or mcp-config.json spaceKey is required', file=sys.stderr)
            sys.exit(1)
        result = create_page(cfg, args.title, storage, space_key, args.parent)
        if result:
            page_id = result.get('id', '?')
            url = cfg['baseUrl'].rstrip('/') + result.get('_links', {}).get('webui', '')
            print(f'[OK] Creation Complete — pageId={page_id}')
            if url:
                print(f'     URL: {url}')
        else:
            print('[ERROR] Creation failed', file=sys.stderr)
            sys.exit(1)

    elif args.cmd == 'update':
        info = get_page_info(cfg, args.page_id)
        if not info:
            print('[ERROR] Failed to retrieve page info', file=sys.stderr)
            sys.exit(1)
        result = update_page(cfg, args.page_id, args.title, storage, info['version'])
        if result:
            print(f'[OK] Update Complete — pageId={args.page_id}, version={info["version"] + 1}')
        else:
            print('[ERROR] Update failed', file=sys.stderr)
            sys.exit(1)

if __name__ == '__main__':
    main()
