#!/usr/bin/env python3
"""
jira_sprint_move.py — Move Jira issues to active sprint

Usage:
  python jira_sprint_move.py SGEATF-12345
  python jira_sprint_move.py SGEATF-12345 --sprint-id 9999
  python jira_sprint_move.py SGEATF-12345 SGEATF-12346 ...  (batch move)

Config:
  Reads the jira section of mcp-config.json.
  If boardId is set, the active sprint of that board is used.
"""

import io
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
    return cfg.get('jira', {})

# ── HTTP helpers ────────────────────────────────────────────────────────────────
def make_auth(cfg: dict) -> str:
    auth_type = cfg.get('authType', 'cloud')
    if auth_type == 'server_pat':
        return f"Bearer {cfg['apiToken']}"
    # cloud or server_basic
    cred = base64.b64encode(f"{cfg['email']}:{cfg['apiToken']}".encode()).decode()
    return f"Basic {cred}"

def api_request(cfg: dict, path: str, method: str = 'GET', body: dict | None = None) -> dict | None:
    base = cfg['baseUrl'].rstrip('/')
    url = f"{base}{path}"
    auth = make_auth(cfg)
    headers = {
        'Authorization': auth,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
    }
    data = json.dumps(body).encode() if body else None
    # bypassSSL=false → default certificate verification, bypassSSL=true → skip verification
    ctx = ssl.create_default_context()
    if cfg.get('bypassSSL', False):
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=ctx) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode('utf-8', errors='replace')
        print(f"[ERROR] {method} {path} → {e.code}: {body_text}", file=sys.stderr)
        return None

# ── Active sprint search ───────────────────────────────────────────────────────
def get_active_sprint_id(cfg: dict) -> int | None:
    board_id = cfg.get('boardId')
    project_key = cfg.get('projectKey', '')

    # Without boardId, look up the board by project
    if not board_id:
        boards = api_request(cfg, f'/rest/agile/1.0/board?projectKeyOrId={project_key}&type=scrum')
        if not boards or not boards.get('values'):
            print('[WARN] Could not find a scrum board.', file=sys.stderr)
            return None
        board_id = boards['values'][0]['id']
        print(f'[INFO] Auto-detected board: id={board_id}')

    sprints = api_request(cfg, f'/rest/agile/1.0/board/{board_id}/sprint?state=active')
    if not sprints or not sprints.get('values'):
        print('[WARN] No active sprint found.', file=sys.stderr)
        return None

    sprint = sprints['values'][0]
    print(f'[INFO] Active sprint: {sprint["name"]} (id={sprint["id"]})')
    return sprint['id']

# ── Move issues ────────────────────────────────────────────────────────────────
def move_issues(issue_keys: list[str], sprint_id: int, cfg: dict) -> bool:
    path = f'/rest/agile/1.0/sprint/{sprint_id}/issue'
    result = api_request(cfg, path, method='POST', body={'issues': issue_keys})
    return result is not None

# ── Main ────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='Move Jira issues to the active sprint')
    parser.add_argument('issue_keys', nargs='+', help='Issue key (e.g. SGEATF-12345)')
    parser.add_argument('--sprint-id', type=int, default=None, help='Directly specify sprint ID (auto-detect if not specified)')
    args = parser.parse_args()

    cfg = load_config()

    sprint_id = args.sprint_id
    if sprint_id is None:
        sprint_id = get_active_sprint_id(cfg)
        if sprint_id is None:
            print('[ERROR] Could not determine sprint ID.', file=sys.stderr)
            sys.exit(1)

    print(f'[INFO] Issues {args.issue_keys} → sprint {sprint_id} Moving...')
    ok = move_issues(args.issue_keys, sprint_id, cfg)
    if ok:
        print(f'[OK] Move Complete: {", ".join(args.issue_keys)}')
    else:
        print('[ERROR] Move failed', file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()
