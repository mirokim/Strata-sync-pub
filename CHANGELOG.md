# Changelog

## Unreleased

The product is a shared brain for a team, not a wiki maintenance tool: one vault everyone writes
into, a graph over it, and AI members who read it through a role of their own.

### Added
- **AI members** (Settings → AI Members) replace Reviewers and Jobs. A member is a role, a scope
  (folders, tags), routines on a cadence, and its own memory note `_members/<Name> (memory).md`.
  A Librarian ships by default; Designer, Editor, Researcher, Product lead and Continuity are
  templates. `GET/PUT /v1/members`; MCP prompt `member` (`name`, `all`) hands a client the role,
  the memory and the due routines; tools `members_list`, `member_remember` (append to the memory
  note — the only document a member writes directly), `member_report`.
- **Reactions on save** (`cloud/src/reactions.ts`) — one LLM call per member whose scope covers
  the saved document, remark at `_members/<Name>/<document path>` linked to the document and the
  memory note. Queue `strata-reactions`, `REACTION_MODEL` / `REACTION_FOLDERS`.
- Real seed data (`scripts/seed_vault.py`, stdlib only): Python PEPs + Rust RFCs as a decision
  corpus, a Korean Wikipedia crawl as an encyclopedia corpus; `wipe` clears a server.
- Settings → Server shows the nightly batch log (embedding progress per run); `GET /v1/batch`.
- Settings → MCP: connection snippets for Claude Code / Cursor / Claude Desktop and the tool list.
- 3D graph again: lit instanced spheres with a title label on every node.

### Removed
- Director reviews (`_reviews/`, five fixed personas), the Reviewers and Jobs tabs, the in-app
  STRATA BOT chat, the AI provider settings and the edit agent from the GUI — every AI client
  now talks to the vault over MCP with its own model and key.

### Changed
- Graph overlay controls (minimap, layout buttons, search) sit inside the file tree and status bar.
- Settings → About describes the product as it is now.

## 0.5.0 — 2026-09-12

The web release: the same app in a browser, hosted on Vercel, with the Cloudflare Worker as
the vault, the search index and an MCP server. Electron builds still work but are no longer the
delivery target.

### Added
- **Google sign-in** — the Worker is an OAuth 2.1 authorization server (`@cloudflare/workers-oauth-provider`,
  KV-backed) fronting Google: the browser app (PKCE, `src/web/auth.ts`) and MCP clients (Claude
  Code discovers `/.well-known/oauth-authorization-server`, registers, signs in) get their own
  tokens; `GET /v1/me`; authorship from the Google identity. The team token remains the service
  credential (`resolveExternalToken`). `ALLOWED_EMAIL_DOMAINS` optionally restricts sign-in.
- **Seed vault** — `scripts/seed-worlds.mjs` writes ~740 invented design notes about 19 game
  universes (frontmatter, dense wikilinks, cross-universe analyses, deliberate phantom links) to a
  folder or straight into a server.
- **Web build** (`npm run build:web`, `vercel.json`) — `src/web/`: connect screen (server URL,
  team token, author), `window.vaultAPI` / `window.syncAPI` implemented over the Worker
  (IndexedDB mirror advanced with `GET /v1/docs?after=<seq>`, `If-Match` saves, conflict copies,
  images as data URLs, 15 s poll), Settings → Server tab. Electron-only tabs are hidden.
- **Worker web API** — CORS (`ALLOWED_ORIGINS`), `GET /v1/docs` (paged documents with content),
  `POST /v1/propose` (bots), and a **remote MCP endpoint** at `/mcp` (Streamable HTTP, Bearer
  team token): `vault_list/read/search/write/propose/proposals/promote`, `graph_lint`,
  `graph_suggest_links`. `claude mcp add --transport http strata https://<worker>/mcp …`.
- **Deploy pipeline** — `deploy-worker` job (main push → tests → D1 migrations →
  `wrangler deploy`); Vercel deploys the web app from Git.
- Bots: `/propose` falls back to the Worker when the desktop app is not running
  (`STRATA_SERVER_URL`, `STRATA_TEAM_TOKEN`).

### Fixed
- External vault changes (fs.watch, desktop sync pulls) were only applied while Settings →
  General was open — the listener lived in that tab. It now lives in `useVaultWatcher`, mounted
  once in App.
- Documents written through MCP tools skipped the save-reaction queue.

## 0.4.0 — 2026-09-12

The team-vault release: one vault shared through Cloudflare, an agent-writing discipline, and
server-side lint, embeddings and director reviews. Full plan and rationale in
`docs/plan-team-vault-2026-09.html` (not tracked) / the linked artifact.

### Added
- **Team sync (Cloudflare)** — `cloud/` Worker (R2 + D1) with a sequence-number manifest, sha256
  ETags and `If-Match` preconditions; Electron sync engine with debounced push, 30 s pull,
  conflict copies (`<name> (conflict <author> <time>).md`), offline backoff; Settings → Vault →
  Team Sync tab. Token encrypted with the OS keychain.
- **`graph_lint`** — vault linter as an MCP tool and CLI (`npm run lint:vault`): phantom-hot,
  bridge-spof (cut vertices + thin community bridges), orphan, stale-hub, near-duplicate,
  cluster-drift. Louvain community detection shared by lint, `graph_clusters`, `graph_bridges`
  and the app's topic clusters.
- **Nightly batch** — Cron Trigger (04:00 Asia/Seoul): lint report written into the vault as
  `_reports/lint-YYYY-MM-DD.md` (30-day retention), incremental embeddings with Workers AI
  `bge-m3` → Vectorize, `POST /v1/search` used by the app as its team vector tier.
- **R2 event bridge** — files written straight into the bucket (Obsidian Remotely Save) are
  hashed and indexed, so Obsidian-only teammates share the vault.
- **Agent proposals** — agents write to `_agent/` only (`vault_propose`, `graph_suggest_links`,
  `vault_proposals`, `vault_promote`; Slack/Telegram `/propose`); half search weight; promote or
  discard from the banner in the app.
- **Director reviews on save** — five personas review a saved design document independently,
  the chief synthesises; result lands in `_reviews/<folder>/<doc>.md`. One review per content
  version, 6 h cooldown, `REVIEW_FOLDERS` / `REVIEW_MODEL` controls.
- GitHub Actions CI (type-checks, all test suites, builds, lint gate, Worker dry run, bot tests).

### Changed
- Sandbox-map (March → September 2026) merged in; Strata Sync is the main line. Everything is in
  English except domain data (synonym tables, Korean morphology, vault headings written by tools).
- `graph_clusters` / `graph_bridges` and the app's cluster metrics use Louvain communities
  instead of connected components — the old bridge detection could never return anything.
- README rewritten for local mode vs team mode; embeddings section matches the code (local
  BGE-M3 first, Gemini second, v6 incremental cache, heading-based chunking).

### Fixed
- Slack bot lost its previous user turn on every request (history/current-turn confusion).
- `convert_jira.py` matched the Jira status `Complete` instead of `완료` (blind translation).
- Korean author names broke every sync request (header values must be Latin-1).
- Wikilinks with `|alias`, `#heading` or `folder/` never resolved in the MCP graph.
- Backend port constant pointed at Electron's internal RAG API port.
- Test suite green again (626+ tests; real-vault search QA gated behind `STRATA_TEST_VAULT`).

### Security
- `mcp-config.json` (API keys, Slack tokens) had been force-tracked by the sibling repo; it is
  untracked and purged from history. **Rotate the Anthropic key and Slack tokens.**
