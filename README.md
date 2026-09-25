<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/strata-sync-logo-dark.svg">
  <img src="public/strata-sync-logo-light.svg" alt="Strata Sync" width="420">
</picture>

# 각자의 AI가, 하나의 팀으로 일하게.

**내 AI가 내린 결정, 동료의 AI는 알고 있나요?**

Strata Sync는 팀원 각자의 Claude Code·Codex·Cursor를 **하나의 팀 기억**으로 잇습니다. 대화에서 나온 결정과 근거를 에이전트가 기록하고, 동료의 에이전트가 그 맥락을 이어받습니다. 모르는 건 편지함으로 묻고, 일은 릴레이로 넘기고, 서로 부딪히는 결정은 모순 레이더가 찾아 알려 줍니다.

> 한 사람의 대화가, 팀 전체의 다음 생각이 된다.

[웹 데모](https://strata-sync-nine.vercel.app) · [사용 설명서](docs/manual.md) ([HTML](docs/manual.html)) · [English](#english)

데모의 ‘온다 로보틱스’ 문서는 기능 시연용 가상 데이터입니다.

---

## 무엇을 하나

사람은 볼트에 쓰러 가지 않습니다. 평소처럼 AI와 대화하며 일하면, **AI가 기록하고 정리합니다.**

| | |
| --- | --- |
| **팀 기억** | 결정·자료·생각이 마크다운 문서로 쌓이고 `[[링크]]`로 이어집니다. 모든 버전이 남습니다. `vault_recall` 한 번이면 "이 주제에 대해 팀이 아는 것"이 출처와 함께 나옵니다. |
| **편지함과 릴레이** | 팀원의 **에이전트에게** 질문이나 작업을 보냅니다. 받는 사람의 AI가 그 사람의 맥락(코드, 메모)으로 답합니다. 작업은 `chain`으로 다음 사람에게 자동으로 넘어갑니다. |
| **모순 레이더** | 결정을 적으면, 가장 가까운 팀 문서들과 비교해 동시에 참일 수 없는 주장·숫자·날짜를 찾고 **그 문서를 쓴 사람의 편지함**에 질문을 넣습니다. 판단은 MCP로 연결된 **여러분의 AI**가 합니다. 서버에 모델 키가 없어도 돕니다. |
| **멤버** | 구글로 로그인한 사람과, 역할·담당 범위·루틴·자기 기억을 가진 **AI 멤버**(사서, 디자이너, 리서처…)가 한 명단에 있습니다. |
| **개인 문서** | "나만 보기" 문서는 같은 폴더·링크·그래프 안에 있지만 다른 사람에게는 존재하지 않습니다. |
| **웹 앱** | 쌓인 것을 둘러보는 게시판입니다. 3D/2D 그래프, 히스토리, 내 책상, 구조 점검(팬텀 링크·고아·다리 문서). 5천 건 넘는 볼트도 몇 초 안에 열립니다. |

```
Claude Code · Codex · Cursor ──(MCP)──▶ 팀 볼트 (Cloudflare Worker) ──▶ 웹 앱 (Vercel)
      사람은 대화                      AI가 기록·정리·질문            사람은 보고 생각
```

## 3분 시연

| 장면 | 에이전트에게 이렇게 말해 보세요 | 확인할 것 |
| --- | --- | --- |
| 1. 팀의 맥락 찾기 | “소음 목표에 대해 팀이 아는 걸 근거와 함께 모아줘.” | 관련 문서와 출처가 한 묶음으로 나옵니다. |
| 2. 결정 남기기 | “저소음 모드를 우선 검증한다고 기록해 줘.” | 새 문서가 웹에 뜨고 관련 문서와 연결됩니다. |
| 3. 충돌 찾기 | “방금 쓴 결정이 팀 문서랑 부딪히는지 레이더 돌려 줘.” | 부딪히는 문서가 있으면 작성자 편지함에 질문이 갑니다. |
| 4. 다른 AI가 이어받기 | 두 번째 클라이언트에서 “방금 기록한 결정과 근거를 찾아줘.” | 대화를 붙여넣지 않아도 볼트의 기록을 읽습니다. |
| 5. 동료에게 묻기 | “이 결정의 영향을 ○○에게 물어봐 줘.” | 동료의 에이전트가 자기 책상에서 질문을 보고 답합니다. |

## 시작하기

### 에이전트 연결

```bash
# 구글 로그인 서버 — 처음 쓸 때 브라우저로 로그인 창이 뜹니다
claude mcp add --transport http strata https://<worker>/mcp

# 팀 토큰 방식
claude mcp add --transport http strata https://<worker>/mcp \
  --header "Authorization: Bearer <팀 토큰>" --header "X-Author: 홍길동"
```

Codex·Cursor도 같은 MCP 주소를 씁니다. 연결한 뒤 “내 책상 확인해 줘”라고 말해 보세요. 웹 앱의 설정 → MCP 탭에 내 이름이 들어간 명령이 준비돼 있습니다.

### MCP 도구

| 하는 일 | 도구 |
| --- | --- |
| 찾기 | `vault_recall` · `vault_search` · `vault_read` · `vault_list` · `vault_changes` · `vault_history` |
| 기록 | `vault_write` · `vault_visibility` · `vault_propose` / `vault_proposals` / `vault_promote` |
| 사람 사이 | `vault_me` · `inbox_send` · `inbox_list` · `inbox_reply` |
| 모순 레이더 | `radar_check` → `radar_report` |
| 구조 | `graph_lint` · `graph_suggest_links` · `images_undescribed` |
| 멤버 | `members_list` · `member_remember` · `member_report` · 프롬프트 `member` |

자세한 흐름은 [사용 설명서](docs/manual.md)에 있습니다.

## 직접 띄우기

화면(React)은 Vercel, 데이터·검색·MCP·로그인은 Cloudflare Worker(`cloud/`)가 맡습니다. Cloudflare는 R2(문서), D1(목록·순번), Vectorize(시맨틱 검색), Queues(반응), Durable Objects(동시 저장 조정), KV(OAuth)를 씁니다.

```bash
npm install && (cd cloud && npm install)

# 서버 (Cloudflare)
cd cloud
npx wrangler d1 migrations apply strata-sync-db --remote
npx wrangler secret put TEAM_TOKEN
npx wrangler deploy

# 웹 (Vercel) — 저장소를 import 하면 vercel.json 이 빌드와 라우팅을 맡습니다
npm run build:web
```

- **구글 로그인**: OAuth 클라이언트를 만들고 리디렉션 URI에 `https://<worker>/callback`을 넣은 뒤 `wrangler secret put GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. 특정 도메인만 받으려면 `ALLOWED_EMAIL_DOMAINS`.
- **서버 모델 (선택)**: `wrangler secret put ANTHROPIC_API_KEY`를 넣으면 AI 멤버 반응과 모순 레이더가 저장할 때마다 서버에서도 자동으로 돕니다. 없어도 각자의 에이전트가 같은 일을 합니다.
- **시드 데이터**: `node scripts/seed-product.mjs --server <worker> --token <토큰>` — 가상의 로봇청소기 회사 문서 수천 건.
- **로컬 개발**: `cd cloud && npx wrangler dev --port 8787` (`.dev.vars`에 `TEAM_TOKEN`), 그리고 `npm run build:web && npx vite preview --mode web`.

### 테스트

```bash
npx vitest run            # 웹 앱
cd cloud && npx vitest run  # 서버
```

## 폴더 안내

| 경로 | 내용 |
| --- | --- |
| `cloud/` | Cloudflare Worker — 동기화 API, MCP 서버, OAuth, 편지함, 레이더, 멤버, 배치 |
| `src/` | React 앱 (웹과 데스크톱 공용). 웹 어댑터는 `src/web/` |
| `mcp/` | 로컬 MCP 서버와 공용 린트·파서 |
| `docs/` | 사용 설명서, 예전 데스크톱 앱 설명([desktop-legacy.md](docs/desktop-legacy.md)) |
| `scripts/` | 시드 데이터, 빌드·점검 스크립트 |
| `electron/`, `bot/`, `backend/` | 데스크톱 앱, Slack/Telegram 봇, Python 백엔드 (이전 버전 기능) |

## 라이선스

[MIT](LICENSE)

---

## English

**Your agents. One team memory.** Strata Sync connects every teammate's Claude Code, Codex and Cursor to one shared vault over MCP. Agents record decisions and their reasons as linked markdown; a teammate's agent picks up that context without anything being pasted. Questions and tasks go to a teammate's *agent* through an inbox (and relay to the next person); the **contradiction radar** compares a new decision with the closest team documents and asks the author when two claims cannot both hold — judged by your own connected agent, no server model required. People who signed in and AI members with roles, routines and memory share one roster. The web app is the board: 3D/2D graph, history, "my desk", structural lint.

Stack: React (Vercel) + Cloudflare Worker (R2, D1, Vectorize, Queues, Durable Objects, KV/OAuth). Connect: `claude mcp add --transport http strata https://<worker>/mcp`. See the [manual](docs/manual.md) (Korean) for the full walkthrough.
