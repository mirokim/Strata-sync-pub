/**
 * Cloudflare Worker entry — HTTP surface over the sync protocol in sync.ts.
 *
 *   GET    /health
 *   GET    /v1/manifest?since=<seq>      changes after <seq> (paged, see `next`)
 *   GET    /v1/file?path=<vault path>    bytes + ETag / X-Mtime / X-Author / X-Seq
 *   PUT    /v1/file?path=<vault path>    body = bytes; headers If-Match | If-None-Match: *, X-Mtime, X-Author
 *   DELETE /v1/file?path=<vault path>    headers If-Match (optional), X-Author
 *
 * Every /v1 route requires `Authorization: Bearer <TEAM_TOKEN>`.
 */
import { D1MetaStore, R2BlobStore } from './stores.js'
import { getManifest, getFile, putFile, deleteFile, parseIfMatch, normalizeVaultPath, type FileRow, type SyncDeps } from './sync.js'
import { runNightly, batchStatus, semanticSearch, type NightlyDeps, type VectorStore, type VectorQuery } from './nightly.js'
import { applyR2Events, type R2EventMessage } from './r2events.js'
import { reactToSave, shouldEnqueueReaction, type ReactionJob, type LlmCall } from './reactions.js'
import Anthropic from '@anthropic-ai/sdk'
import { preflight, withCors } from './cors.js'
import { handleMcpRequest } from './mcp.js'
import { invalidateVaultView, loadVaultView } from './vaultIndex.js'
import { meOverview } from './me.js'
import { buildProposal } from '../../mcp/src/proposals.js'
import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { handleAuth, SCOPE, type AuthEnv, type Identity } from './auth.js'
import { readMembers, saveMemberDefinitions, validateMembers, TEMPLATES, type MembersConfig } from './members.js'
import { listVersions, readVersion, diffLines } from './history.js'
import { ensureImageDoc, isImagePath } from './images.js'
import { canSee, isPersonalPath, visibleRows, setVisibility, type Viewer } from './personal.js'

export interface Env extends AuthEnv {
  VAULT: R2Bucket
  DB: D1Database
  TEAM_TOKEN: string
  MAX_FILE_BYTES?: string
  /** Optional — set by the [ai] and [[vectorize]] bindings; embeddings are skipped without them. */
  AI?: Ai
  VECTORS?: VectorizeIndex
  /** IANA zone for report file names (default Asia/Seoul). */
  REPORT_TIMEZONE?: string
  /** Optional — AI members react to saves in their scope. Needs the queue producer binding and the API key secret. */
  REACTION_QUEUE?: Queue<ReactionJob>
  ANTHROPIC_API_KEY?: string
  /** Model for member reactions (default claude-opus-5). */
  REACTION_MODEL?: string
  /** Comma-separated vault folders eligible for reactions; empty = every non-underscore folder. */
  REACTION_FOLDERS?: string
  /** Documents (re)embedded per nightly run; the rest wait for the next run (default 150). */
  EMBED_MAX_DOCS?: string
  /** Browser origins allowed to call the API (comma-separated, or `*`). Empty = no browser access. */
  ALLOWED_ORIGINS?: string
}

const DEFAULT_REACTION_MODEL = 'claude-opus-5'

const EMBED_MODEL = '@cf/baai/bge-m3'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } })
}

/** Constant-time comparison so a token cannot be guessed byte by byte from response timing. */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (!presented || !expected) return false
  const a = new TextEncoder().encode(presented)
  const b = new TextEncoder().encode(expected)
  if (a.byteLength !== b.byteLength) return false
  let diff = 0
  for (let i = 0; i < a.byteLength; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null
}

/**
 * Authorization server + resource server. `/v1/*` and `/mcp` accept either an access token issued
 * after a Google sign-in (browser app, MCP clients) or the shared TEAM_TOKEN (desktop engine,
 * bots, scripts). Everything else — /authorize, /callback, /token, /register, the OAuth metadata
 * documents, /health — is unauthenticated.
 */
const provider = new OAuthProvider<Env>({
  apiRoute: ['/v1/', '/mcp'],
  apiHandler: {
    fetch: (req, env, ctx) => route(req, env, ctx, undefined, identityFromProps((ctx as ExecutionContext & { props?: unknown }).props, req)),
  },
  defaultHandler: {
    fetch: (req, env) => {
      if (new URL(req.url).pathname === '/health') return Promise.resolve(json(200, { ok: true, service: 'strata-sync-cloud', signIn: Boolean(env.GOOGLE_CLIENT_ID) ? 'google' : 'token' }))
      return handleAuth(req, env)
    },
  },
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  scopesSupported: [SCOPE],
  // The team token is not in KV: validate it here and hand the handler a service identity
  resolveExternalToken: async ({ token, request, env }) => {
    if (!env.TEAM_TOKEN || !tokenMatches(token, env.TEAM_TOKEN)) return null
    const name = decodeHeader(request.headers.get('x-author'))
    return { props: { sub: 'service', email: '', name, service: true } satisfies Identity }
  },
})

/** Props travel inside the access token; anything malformed is treated as no identity. */
function identityFromProps(props: unknown, req: Request): Identity | undefined {
  if (!props || typeof props !== 'object') return undefined
  const p = props as Partial<Identity>
  if (typeof p.sub !== 'string') return undefined
  const name = typeof p.name === 'string' ? p.name : ''
  return {
    sub: p.sub, email: typeof p.email === 'string' ? p.email : '', picture: typeof p.picture === 'string' ? p.picture : undefined,
    service: p.service === true,
    // Service callers name themselves per request (the desktop engine sends the user's name)
    name: p.service ? (decodeHeader(req.headers.get('x-author')) || name || 'service') : name,
  }
}

export default {
  /** CORS wrapper — the web app on Vercel calls this API from the browser. */
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method === 'OPTIONS') return preflight(req, env.ALLOWED_ORIGINS)
    const res = await provider.fetch(req, env, ctx)
    return withCors(res, req, env.ALLOWED_ORIGINS)
  },

  /** Cron trigger (wrangler.toml [triggers]) — the nightly lint + embedding batch. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runNightly(nightlyDeps(env)).then(
      r => console.log('[nightly] done', JSON.stringify(r)),
      e => console.error('[nightly] failed', e),
    ))
  },

  /**
   * Queue consumer. Two queues share this Worker:
   *   strata-vault-events  — R2 event notifications: index files written outside the API
   *   strata-reactions     — AI member reactions to freshly saved documents
   */
  async queue(batch: MessageBatch<R2EventMessage | ReactionJob>, env: Env): Promise<void> {
    if (batch.queue.includes('reaction')) {
      const llm = anthropicLlm(env)
      const deps = { ...baseDeps(env), log: (msg: string) => console.log(msg), reactFolders: reactionFolders(env) }
      for (const m of batch.messages) {
        if (!llm) { console.warn('[reactions] ANTHROPIC_API_KEY not set — dropping reaction job'); m.ack(); continue }
        try {
          const outcome = await reactToSave({ ...deps, llm }, m.body as ReactionJob)
          console.log('[reactions]', (m.body as ReactionJob).path, JSON.stringify(outcome))
          if (outcome.status === 'deferred') {
            // Inside the cooldown: come back when it ends (Queues cap a retry delay at 12 hours)
            m.retry({ delaySeconds: Math.min(Math.ceil(outcome.retryAfterMs / 1000) + 5, 12 * 3600) })
          } else {
            m.ack()
          }
        } catch (e) {
          console.error('[reactions] failed', (m.body as ReactionJob).path, e)
          m.retry({ delaySeconds: 300 })
        }
      }
      return
    }
    const events = batch.messages.map(m => m.body as R2EventMessage)
    const result = await applyR2Events(baseDeps(env), events, msg => console.log(msg))
    console.log('[r2events]', JSON.stringify(result))
    // Images uploaded outside the API (Obsidian) get their image document too
    for (const ev of events) {
      const key = ev.object?.key ?? ''
      if (ev.action !== 'DeleteObject' && ev.action !== 'LifecycleDeletion' && isImagePath(key)) {
        await ensureImageDoc(baseDeps(env), key).catch(e => console.error('[images] image document failed', key, e))
      }
    }
    // External writes get reactions too — the bridge indexed them under author 'external'
    if (env.REACTION_QUEUE) {
      for (const ev of events) {
        if (ev.action === 'DeleteObject' || ev.action === 'LifecycleDeletion') continue
        const key = ev.object?.key ?? ''
        if (env.ANTHROPIC_API_KEY && shouldEnqueueReaction({ path: key, deleted: false, size: ev.object?.size ?? 0, author: 'external' }, reactionFolders(env))) {
          await env.REACTION_QUEUE.send({ path: key }).catch(e => console.error('[reactions] enqueue failed', e))
        }
      }
    }
    for (const m of batch.messages) m.ack()
  },
} satisfies ExportedHandler<Env, R2EventMessage | ReactionJob>

function reactionFolders(env: Env): string[] {
  return (env.REACTION_FOLDERS ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

/** Member-reaction LLM via the Anthropic SDK; null when the key secret is missing. */
function anthropicLlm(env: Env): LlmCall | null {
  if (!env.ANTHROPIC_API_KEY) return null
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 })
  const model = env.REACTION_MODEL || DEFAULT_REACTION_MODEL
  return async ({ system, user, maxTokens, effort }) => {
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      output_config: { effort },
      messages: [{ role: 'user', content: user }],
    })
    if (res.stop_reason === 'refusal') return '_(the model declined to comment on this document)_'
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  }
}

/**
 * All HTTP routing behind authentication. In production the OAuth provider has already validated
 * the bearer token and passes `identity`; without one (tests, direct use) the team token is checked
 * here. Exported so tests can drive the routes with in-memory stores (`deps`).
 */
export async function route(req: Request, env: Env, ctx: ExecutionContext, deps?: SyncDeps, identity?: Identity): Promise<Response> {
  const url = new URL(req.url)

  if (url.pathname === '/health') return json(200, { ok: true, service: 'strata-sync-cloud' })
  if (!url.pathname.startsWith('/v1/') && url.pathname !== '/mcp') return json(404, { error: 'not found' })

  if (!identity) {
    if (!env.TEAM_TOKEN) return json(503, { error: 'TEAM_TOKEN secret not configured' })
    if (!tokenMatches(bearer(req), env.TEAM_TOKEN)) return json(401, { error: 'unauthorized' })
    identity = { sub: 'service', email: '', name: decodeHeader(req.headers.get('x-author')), service: true }
  }
  // Who gets recorded as the author of writes: the signed-in person, or whatever a service caller says
  const author = identity.service ? (identity.name || 'service') : (identity.name || identity.email)
  const viewer: Viewer = { sub: identity.sub, service: identity.service }

  deps ??= baseDeps(env)

  try {
    if (url.pathname === '/v1/me' && req.method === 'GET') {
      return json(200, { sub: identity.sub, email: identity.email, name: identity.name, picture: identity.picture ?? null, service: Boolean(identity.service), author })
    }
    // My desk: this person's documents, remarks on them, proposals citing them, what others changed
    if (url.pathname === '/v1/me/overview' && req.method === 'GET') {
      const [rows, view] = await Promise.all([deps.meta.listSince(0, 100_000), loadVaultView(deps)])
      return json(200, meOverview({ rows, view, viewer, author, webOrigin: env.ALLOWED_ORIGINS }))
    }

    // ── Remote MCP (Claude Code / Cursor over Streamable HTTP) ────────────────
    if (url.pathname === '/mcp') {
      const semantic = env.AI && env.VECTORS
        ? (q: string, k: number) => semanticSearch(embedder(env.AI!), vectorQuery(env.VECTORS!), q, k)
        : undefined
      return handleMcpRequest(req, {
        ...deps, semanticSearch: semantic,
        author: author || 'mcp',
        viewer,
        webOrigin: env.ALLOWED_ORIGINS,
        onWrite: row => enqueueReaction(env, ctx, deps, row),
      })
    }

    // ── Web client: documents with content, paged by sequence ─────────────────
    if (url.pathname === '/v1/docs' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? '0')
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 500)
      if (!Number.isFinite(after) || after < 0) return json(400, { error: 'after must be a non-negative integer' })
      const rows = await deps.meta.listSince(Math.floor(after), limit)
      const head = await deps.meta.head()
      const generation = await deps.meta.generation()
      // Markdown content is inlined; tombstones and binaries (images) carry `content: null`.
      // Other people's personal documents are not part of this viewer's vault at all.
      const docs: (FileRow & { content: string | null })[] = []
      const BATCH = 25
      const mine = visibleRows(rows, viewer)
      for (let i = 0; i < mine.length; i += BATCH) {
        const part = await Promise.all(mine.slice(i, i + BATCH).map(async row => {
          if (row.deleted || !row.path.toLowerCase().endsWith('.md')) return { ...row, content: null }
          const bytes = await deps.blobs.get(row.path)
          return { ...row, content: bytes ? new TextDecoder().decode(bytes) : null }
        }))
        docs.push(...part)
      }
      const next = rows.length === limit ? rows[rows.length - 1].seq : null
      return json(200, { head, generation, next, docs })
    }

    // ── Bots / scripts: record an agent proposal ───────────────────────────────
    if (url.pathname === '/v1/propose' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as { title?: unknown; body?: unknown; tags?: unknown; links?: unknown; source?: unknown }
      const title = typeof body.title === 'string' ? body.title.trim() : ''
      const text = typeof body.body === 'string' ? body.body.trim() : ''
      if (!title || !text) return json(400, { error: 'title and body required' })
      const proposal = buildProposal({
        title, body: text,
        tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
        links: Array.isArray(body.links) ? body.links.map(String) : [],
        source: typeof body.source === 'string' ? body.source.slice(0, 80) : 'bot',
      })
      let rel = proposal.relPath
      for (let n = 2; (await deps.meta.get(rel))?.deleted === false; n++) rel = proposal.relPath.replace(/\.md$/, `-${n}.md`)
      const r = await putFile(deps, { path: rel, body: new TextEncoder().encode(proposal.content), mtime: Date.now(), author: author || 'bot', authorSub: identity.sub, createOnly: true })
      if (r.status >= 400) return toResponse(r)
      invalidateVaultView()
      return json(200, { ok: true, path: rel, title: proposal.title })
    }

    if (url.pathname === '/v1/search' && req.method === 'POST') {
      if (!env.AI || !env.VECTORS) return json(503, { error: 'semantic search not configured (AI / Vectorize bindings missing)' })
      const body = await req.json().catch(() => ({})) as { query?: unknown; topK?: unknown }
      if (typeof body.query !== 'string') return json(400, { error: 'query (string) required' })
      const hits = await semanticSearch(embedder(env.AI), vectorQuery(env.VECTORS), body.query, Number(body.topK ?? 10))
      const live = await Promise.all(visibleRows(hits, viewer).map(async h => ((await deps.meta.get(h.path))?.deleted === false ? h : null)))
      return json(200, { hits: live.filter((h): h is NonNullable<typeof h> => h !== null) })
    }
    if (url.pathname === '/v1/lint/run' && req.method === 'POST') {
      // Manual trigger of the nightly batch (same code the cron runs)
      const result = await runNightly(nightlyDeps(env), 'manual')
      return json(200, result)
    }
    if (url.pathname === '/v1/batch' && req.method === 'GET') {
      return json(200, await batchStatus(deps))
    }
    if (url.pathname === '/v1/history' && req.method === 'GET') {
      const path = normalizeVaultPath(url.searchParams.get('path'))
      if (!path || !/\.md$/i.test(path)) return json(400, { error: 'path of a document required' })
      if (!canSee(path, viewer)) return json(404, { error: 'not found' })
      // A deleted team document's past is not public reading matter — only its owner (personal) still sees it
      const liveRow = await deps.meta.get(path)
      if ((!liveRow || liveRow.deleted) && !isPersonalPath(path)) return json(404, { error: 'not found' })
      const etag = url.searchParams.get('etag')
      if (!etag) {
        const row = liveRow
        const versions = (await listVersions(deps.blobs, path)).map(v => ({ etag: v.etag, at: v.at, author: v.author, size: v.size }))
        return json(200, { path, current: row && !row.deleted ? { etag: row.etag, at: row.updatedAt, author: row.author, size: row.size } : null, versions })
      }
      const older = await readVersion(deps.blobs, path, etag)
      if (!older) return json(404, { error: 'version not found' })
      if (url.searchParams.get('diff') !== '1') {
        return new Response(older.bytes as BodyInit, { status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8', 'ETag': `"${older.version.etag}"`, 'X-Author': encodeURIComponent(older.version.author), 'X-At': String(older.version.at) } })
      }
      const nowBytes = await deps.blobs.get(path)
      const { text, stats } = diffLines(new TextDecoder().decode(older.bytes), nowBytes ? new TextDecoder().decode(nowBytes) : '')
      return json(200, { path, from: { etag: older.version.etag, at: older.version.at, author: older.version.author }, text, stats })
    }
    if (url.pathname === '/v1/members' && req.method === 'GET') {
      return json(200, { config: await readMembers(deps), templates: TEMPLATES, reactionsEnabled: Boolean(env.REACTION_QUEUE && env.ANTHROPIC_API_KEY) })
    }
    if (url.pathname === '/v1/members' && req.method === 'PUT') {
      // Routine instructions run inside every teammate's agent with that teammate's identity —
      // only a person can change them, and their identity is on record as the author
      if (identity.service) return json(403, { error: 'sign in to edit the AI members (the team token cannot)' })
      const body = await req.json().catch(() => null)
      const error = validateMembers(body)
      if (error) return json(400, { error })
      return json(200, { config: await saveMemberDefinitions(deps, body as MembersConfig) })
    }
    if (url.pathname === '/v1/manifest' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? '0')
      const result = await getManifest(deps, since)
      if (result.status === 200) {
        const body = result.body as { files: FileRow[] }
        return toResponse({ ...result, body: { ...body, files: visibleRows(body.files, viewer) } })
      }
      return toResponse(result)
    }
    if (url.pathname === '/v1/visibility' && req.method === 'POST') {
      const body = await req.json().catch(() => ({})) as { path?: unknown; personal?: unknown }
      if (typeof body.path !== 'string' || typeof body.personal !== 'boolean') return json(400, { error: 'path (string) and personal (boolean) required' })
      const result = await setVisibility(deps, { path: body.path, personal: body.personal, viewer, author })
      if (result.status === 200 && result.body) { const moved = (result.body as { row: FileRow }).row; enqueueReaction(env, ctx, deps, moved) }
      return toResponse(result)
    }
    if (url.pathname === '/v1/file') {
      const path = url.searchParams.get('path')
      if (path && !canSee(path.replace(/\\/g, '/').replace(/^\/+/, ''), viewer)) return json(req.method === 'GET' ? 404 : 403, { error: req.method === 'GET' ? 'not found' : 'not your personal space' })
      if (req.method === 'GET') return toResponse(await getFile(deps, path))
      if (req.method === 'PUT') {
        const declared = Number(req.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > deps.maxFileBytes) return json(413, { error: `file larger than ${deps.maxFileBytes} bytes` })
        const body = new Uint8Array(await req.arrayBuffer())
        const result = await putFile(deps, {
          path, body,
          ifMatch: parseIfMatch(req.headers.get('if-match')),
          createOnly: req.headers.get('if-none-match') === '*',
          mtime: Number(req.headers.get('x-mtime')),
          author, authorSub: identity.sub,
        })
        // A new version of a document → queue member reactions (fire-and-forget)
        if ((result.status === 200 || result.status === 201) && result.body) enqueueReaction(env, ctx, deps, result.body as FileRow)
        return toResponse(result)
      }
      if (req.method === 'DELETE') return toResponse(await deleteFile(deps, path, parseIfMatch(req.headers.get('if-match')), author, identity.sub))
      return json(405, { error: 'method not allowed' })
    }
    return json(404, { error: 'not found' })
  } catch (e) {
    console.error('[sync] unhandled', e)
    return json(500, { error: 'internal error' })
  }
}

/**
 * After a write: an image gets its image document (for a person or a member to describe over
 * MCP), a document gets queued for member reactions.
 */
function enqueueReaction(env: Env, ctx: ExecutionContext, deps: SyncDeps, row: FileRow): void {
  if (isImagePath(row.path) && !row.deleted) {
    ctx.waitUntil(ensureImageDoc(deps, row.path).catch(e => console.error('[images] image document failed', row.path, e)))
    return
  }
  if (!env.REACTION_QUEUE) return
  // No key on the server → the consumer would only drop the job; save the queue operation
  if (!env.ANTHROPIC_API_KEY || !shouldEnqueueReaction(row, reactionFolders(env))) return
  ctx.waitUntil(env.REACTION_QUEUE.send({ path: row.path, etag: row.etag }).catch(e => console.error('[reactions] enqueue failed', e)))
}

function baseDeps(env: Env): SyncDeps {
  return {
    meta: new D1MetaStore(env.DB),
    blobs: new R2BlobStore(env.VAULT),
    maxFileBytes: Number(env.MAX_FILE_BYTES ?? 10 * 1024 * 1024),
  }
}

function nightlyDeps(env: Env): NightlyDeps {
  const deps: NightlyDeps = { ...baseDeps(env), log: msg => console.log(msg), timeZone: env.REPORT_TIMEZONE || 'Asia/Seoul', maxEmbedDocsPerRun: Number(env.EMBED_MAX_DOCS) || undefined }
  if (env.AI && env.VECTORS) {
    deps.embed = embedder(env.AI)
    deps.vectors = vectorStore(env.VECTORS)
  }
  return deps
}

function embedder(ai: Ai): (texts: string[]) => Promise<number[][]> {
  return async texts => {
    const out = await ai.run(EMBED_MODEL, { text: texts }) as { data?: number[][] }
    if (!out.data || out.data.length !== texts.length) throw new Error(`embedding returned ${out.data?.length ?? 0} vectors for ${texts.length} texts`)
    return out.data
  }
}

function vectorStore(index: VectorizeIndex): VectorStore {
  return {
    async upsert(items) { if (items.length) await index.upsert(items.map(i => ({ id: i.id, values: i.values, metadata: i.metadata }))) },
    async deleteByIds(ids) { if (ids.length) await index.deleteByIds(ids) },
  }
}

function vectorQuery(index: VectorizeIndex): VectorQuery {
  return {
    async query(values, topK) {
      const res = await index.query(values, { topK, returnMetadata: 'all' })
      return res.matches.map(m => ({ id: m.id, score: m.score, metadata: m.metadata as Record<string, unknown> | undefined }))
    },
  }
}

/** Clients send the author percent-encoded because header values must be Latin-1. */
function decodeHeader(v: string | null): string {
  if (!v) return ''
  try { return decodeURIComponent(v) } catch { return v }
}

function toResponse(r: Awaited<ReturnType<typeof getFile>>): Response {
  if ('bytes' in r && r.bytes) {
    return new Response(r.bytes as BodyInit, { status: r.status, headers: { 'content-type': 'application/octet-stream', ...(r.headers ?? {}) } })
  }
  if (r.status === 204) return new Response(null, { status: 204, headers: r.headers ?? {} })
  return json(r.status, r.body ?? {}, 'headers' in r ? (r.headers ?? {}) : {})
}
