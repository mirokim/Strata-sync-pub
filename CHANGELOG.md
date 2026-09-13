# Changelog

## Unreleased

The product is a shared brain for a team, not a wiki maintenance tool: one vault everyone writes
into, a graph over it, and AI members who read it through a role of their own.

### Added
- **Inbox — my agent asks your agent** — a question or task addressed to a teammate by name lives in
  the vault (`_inbox/<name>/…`) until that person, or their agent in its next session, answers it
  with their own context; the reply lands on the sender's desk. MCP `inbox_send` / `inbox_list` /
  `inbox_reply` (the server's instructions tell clients to check `vault_me` at session start),
  `GET/POST /v1/inbox`, `POST /v1/inbox/reply`, and the My desk panel (reply box, "Ask a teammate"
  form). Only the addressee can answer; the sender can withdraw (`cloud/src/inbox.ts`).
- **My desk** — the vault from one person's side: documents they saved last, their personal
  documents, AI-member remarks on their documents, open proposals that cite them, and what
  teammates changed recently. `GET /v1/me/overview` (viewer-scoped; "mine" = OAuth sub, or the
  X-Author name for team-token callers), the web panel (top-bar person icon, web mode) and the MCP
  tool `vault_me` (markdown or json) that also hands the user `<web origin>/?view=me`, which opens
  the panel after connecting (`cloud/src/me.ts`, `src/components/me/MyDeskPanel.tsx`).
- **Korean UI (i18n)** — every user-visible string goes through `t()` / `useT()` (`src/i18n`): the English
  text is the key, `src/i18n/ko/<area>.ts` holds the Korean, a missing entry falls back to English.
  Settings → General → Language: System (browser language) / 한국어 / English; `<html lang>` follows.
  1,350 translated strings; `node scripts/i18n-check.mjs` reports conflicting or missing translations.
  Retired tabs (AI, Personas, Search, Vector, Debate, Edit Agent) stay English.
- **Live preview editor** — Obsidian-style rendering in place (`src/lib/editor/livePreview.ts`):
  frontmatter becomes an editable Properties table (text, number, date, checkbox, list chips; each
  edit rewrites just that YAML line), headings at size with `#` hidden, `**` `*` `~~` backtick and
  link markers hidden off the cursor line, bullets, clickable task checkboxes, blockquote bars,
  callouts (`> [!warning]`), `#tags`, GFM tables rendered as tables, horizontal rules, code fences
  with a language label. The lines the selection touches show their source; a locked document
  renders everything (reading view). Toggle live preview / source in the editor toolbar
  (persisted). The editor now parses GFM (tables, task lists, strikethrough were not parsed before)
  and uses the body font in live preview. `perf/editor.html` mounts the editor on a sample document.
- **Around this document** — the editor's Brain panel: what the AI members said when it was
  saved, its version history with diffs, which documents link here and which it links to,
  proposals citing it, documents in the same neighbourhood (`src/lib/brain.ts`, `BrainPanel`).
- **Recall** — MCP `vault_recall`: matching documents, the documents linked around them, what
  members remember and what they said, in one bundle within a character budget
  (`cloud/src/recall.ts`). `vault_search` uses the same rank fusion.
- **Version history** — every replaced or deleted document version is archived under
  `_system/history/` (20 per document); `GET /v1/history`, MCP `vault_history` with a line
  diff. Member reactions now respond to the diff, not the whole document.
- **Activity heat** — graph colour mode "Activity": recent edits, remarks and proposals warm a
  document; untouched ones stay grey.
- **Personal documents** — a document can be yours alone: it stays in its folder, links and is
  searched, recalled and graphed like any other for you, and does not exist for anyone else (the
  server filters every listing, search, lint, embedding, history and file read by the signed-in
  identity; stored under `_personal/<owner>/`). Editor toggle "Only me" ↔ share with the team;
  taking a team document back is allowed only while nobody else has ever saved it. MCP:
  `vault_write` with `personal: true`, `vault_visibility`; `/v1/visibility`. Proposals and member
  memory notes refuse text copied from your personal documents. Needs Google sign-in (the team
  token has no owner). `cloud/src/personal.ts`, `src/web/personal.ts`.
- **Image documents** — paste or drop an image into the editor: it is uploaded to
  `attachments/` with a placeholder document next to it linking back (images uploaded any other
  way get one from the server). No vision model on the server: MCP `images_undescribed` lists
  the images still without words, `vault_read` on an image returns the image and its document,
  and the client (a person's Claude Code / Codex, or the Librarian's daily "images" routine)
  writes what it shows, the visible text and tags with `vault_write` — from then on the image is
  searchable, linkable and recallable (`cloud/src/images.ts`).
- Vault snapshot (`_system/vault-snapshot.json`) so a cold Worker isolate reads the vault in one
  request instead of one per document.
- **AI members** (Settings → AI Members) replace Reviewers and Jobs. A member is a role, a scope
  (folders, tags), routines on a cadence, and its own memory note `_members/<Name> (memory).md`.
  A Librarian ships by default; Designer, Editor, Researcher, Product lead and Continuity are
  templates. `GET/PUT /v1/members`; MCP prompt `member` (`name`, `all`) hands a client the role,
  the memory and the due routines; tools `members_list`, `member_remember` (append to the memory
  note — the only document a member writes directly), `member_report`.
- **Reactions on save** (`cloud/src/reactions.ts`) — one LLM call per member whose scope covers
  the saved document, remark at `_members/<Name>/<document path>` linked to the document and the
  memory note. Queue `strata-reactions`, `REACTION_MODEL` / `REACTION_FOLDERS`.
- **Product-development seed vault** (`scripts/seed-product.mjs`): an invented Korean robot-vacuum
  start-up ("온다 로보틱스", S1 → S3, 2024-06 … 2026-09). ~3,900 documents at `--scale 1`
  (~5,700 at `--scale 2`): numbered decision records (some 폐기 yet still cited), features, parts,
  ECRs, weekly meeting notes per team, gate reviews, issues, test reports, firmware/app releases,
  interviews, VOC, competitors, suppliers, certifications, people, glossary, index (MOC) notes.
  Six phantom links, five orphan memos. `--wipe` also removes the PEP/RFC and game-world seeds.
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
- **3D graph on large vaults** — node labels come from a shared pool of 160 DOM elements instead of
  one per node (a 5,000-document vault meant 5,000 text-shadowed divs laid out every frame). Hubs and
  the nodes nearest the camera get labelled, hovered/selected/AI-highlighted nodes always do, and a
  small vault still labels everything (`src/lib/graph3dQuality.ts`). Sphere tessellation drops with
  node count and the scene uploads every second simulation tick past 2,000 nodes.
- **Adaptive quality for laptops** — the render loop watches the interval between back-to-back
  frames; when the median of 60 frames is above 24 ms it steps down one level and stays there:
  1 pixel ratio 1 (big graphs start here), 2 only the strongest half of the edges (the hovered
  node's edges are always drawn), 3 idle auto-rotation drawn at half rate. `perf/graph3d.html`
  mounts the graph alone with a synthetic 5,600-node / 80,000-link graph for profiling
  (`window.__graph3dPerf` turns on `performance.measure` timings, `?quality=N` pins a level).
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
