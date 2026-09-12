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
import { getManifest, getFile, putFile, deleteFile, parseIfMatch, type SyncDeps } from './sync.js'
import { runNightly, semanticSearch, type NightlyDeps, type VectorStore, type VectorQuery } from './nightly.js'
import { applyR2Events, type R2EventMessage } from './r2events.js'
import { reviewDocument, shouldEnqueueReview, type ReviewJob, type LlmCall } from './review.js'
import Anthropic from '@anthropic-ai/sdk'

export interface Env {
  VAULT: R2Bucket
  DB: D1Database
  TEAM_TOKEN: string
  MAX_FILE_BYTES?: string
  /** Optional — set by the [ai] and [[vectorize]] bindings; embeddings are skipped without them. */
  AI?: Ai
  VECTORS?: VectorizeIndex
  /** IANA zone for report file names (default Asia/Seoul). */
  REPORT_TIMEZONE?: string
  /** Optional — save-triggered director reviews. Needs the queue producer binding and the API key secret. */
  REVIEW_QUEUE?: Queue<ReviewJob>
  ANTHROPIC_API_KEY?: string
  /** Model for director reviews (default claude-opus-5). */
  REVIEW_MODEL?: string
  /** Comma-separated vault folders eligible for review; empty = every non-underscore folder. */
  REVIEW_FOLDERS?: string
}

const DEFAULT_REVIEW_MODEL = 'claude-opus-5'

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

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/health') return json(200, { ok: true, service: 'strata-sync-cloud' })
    if (!url.pathname.startsWith('/v1/')) return json(404, { error: 'not found' })

    if (!env.TEAM_TOKEN) return json(503, { error: 'TEAM_TOKEN secret not configured' })
    if (!tokenMatches(bearer(req), env.TEAM_TOKEN)) return json(401, { error: 'unauthorized' })

    const deps = baseDeps(env)

    try {
      if (url.pathname === '/v1/search' && req.method === 'POST') {
        if (!env.AI || !env.VECTORS) return json(503, { error: 'semantic search not configured (AI / Vectorize bindings missing)' })
        const body = await req.json().catch(() => ({})) as { query?: unknown; topK?: unknown }
        if (typeof body.query !== 'string') return json(400, { error: 'query (string) required' })
        const hits = await semanticSearch(embedder(env.AI), vectorQuery(env.VECTORS), body.query, Number(body.topK ?? 10))
        return json(200, { hits })
      }
      if (url.pathname === '/v1/lint/run' && req.method === 'POST') {
        // Manual trigger of the nightly batch (same code the cron runs)
        const result = await runNightly(nightlyDeps(env))
        return json(200, result)
      }
      if (url.pathname === '/v1/manifest' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0')
        return toResponse(await getManifest(deps, since))
      }
      if (url.pathname === '/v1/file') {
        const path = url.searchParams.get('path')
        const author = decodeHeader(req.headers.get('x-author'))
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
            author,
          })
          // A new version of a design document → queue a director review (fire-and-forget)
          if ((result.status === 200 || result.status === 201) && env.REVIEW_QUEUE && result.body) {
            const row = result.body as { path: string; etag: string; deleted: boolean; size: number; author: string }
            if (shouldEnqueueReview(row, reviewFolders(env))) {
              ctx.waitUntil(env.REVIEW_QUEUE.send({ path: row.path, etag: row.etag }).catch(e => console.error('[review] enqueue failed', e)))
            }
          }
          return toResponse(result)
        }
        if (req.method === 'DELETE') return toResponse(await deleteFile(deps, path, parseIfMatch(req.headers.get('if-match')), author))
        return json(405, { error: 'method not allowed' })
      }
      return json(404, { error: 'not found' })
    } catch (e) {
      console.error('[sync] unhandled', e)
      return json(500, { error: 'internal error' })
    }
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
   *   strata-review-jobs   — director reviews for freshly saved documents
   */
  async queue(batch: MessageBatch<R2EventMessage | ReviewJob>, env: Env): Promise<void> {
    if (batch.queue.includes('review')) {
      const llm = anthropicLlm(env)
      if (!llm) { console.warn('[review] ANTHROPIC_API_KEY not set — dropping review jobs'); for (const m of batch.messages) m.ack(); return }
      const deps = { ...baseDeps(env), llm, log: (msg: string) => console.log(msg), reviewFolders: reviewFolders(env) }
      for (const m of batch.messages) {
        try {
          const outcome = await reviewDocument(deps, m.body as ReviewJob)
          console.log('[review]', (m.body as ReviewJob).path, JSON.stringify(outcome))
          m.ack()
        } catch (e) {
          console.error('[review] failed', (m.body as ReviewJob).path, e)
          m.retry({ delaySeconds: 300 })
        }
      }
      return
    }
    const events = batch.messages.map(m => m.body as R2EventMessage)
    const result = await applyR2Events(baseDeps(env), events, msg => console.log(msg))
    console.log('[r2events]', JSON.stringify(result))
    // External writes are reviewed too — the bridge indexed them under author 'external'
    if (env.REVIEW_QUEUE) {
      for (const ev of events) {
        if (ev.action === 'DeleteObject' || ev.action === 'LifecycleDeletion') continue
        const key = ev.object?.key ?? ''
        if (shouldEnqueueReview({ path: key, deleted: false, size: ev.object?.size ?? 0, author: 'external' }, reviewFolders(env))) {
          await env.REVIEW_QUEUE.send({ path: key }).catch(e => console.error('[review] enqueue failed', e))
        }
      }
    }
    for (const m of batch.messages) m.ack()
  },
} satisfies ExportedHandler<Env, R2EventMessage | ReviewJob>

function reviewFolders(env: Env): string[] {
  return (env.REVIEW_FOLDERS ?? '').split(',').map(s => s.trim()).filter(Boolean)
}

/** Director-review LLM via the Anthropic SDK; null when the key secret is missing. */
function anthropicLlm(env: Env): LlmCall | null {
  if (!env.ANTHROPIC_API_KEY) return null
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2 })
  const model = env.REVIEW_MODEL || DEFAULT_REVIEW_MODEL
  return async ({ system, user, maxTokens, effort }) => {
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      output_config: { effort },
      messages: [{ role: 'user', content: user }],
    })
    if (res.stop_reason === 'refusal') return '_(the model declined to review this section)_'
    return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  }
}

function baseDeps(env: Env): SyncDeps {
  return {
    meta: new D1MetaStore(env.DB),
    blobs: new R2BlobStore(env.VAULT),
    maxFileBytes: Number(env.MAX_FILE_BYTES ?? 10 * 1024 * 1024),
  }
}

function nightlyDeps(env: Env): NightlyDeps {
  const deps: NightlyDeps = { ...baseDeps(env), log: msg => console.log(msg), timeZone: env.REPORT_TIMEZONE || 'Asia/Seoul' }
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
