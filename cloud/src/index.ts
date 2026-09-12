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

export interface Env {
  VAULT: R2Bucket
  DB: D1Database
  TEAM_TOKEN: string
  MAX_FILE_BYTES?: string
}

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
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)

    if (url.pathname === '/health') return json(200, { ok: true, service: 'strata-sync-cloud' })
    if (!url.pathname.startsWith('/v1/')) return json(404, { error: 'not found' })

    if (!env.TEAM_TOKEN) return json(503, { error: 'TEAM_TOKEN secret not configured' })
    if (!tokenMatches(bearer(req), env.TEAM_TOKEN)) return json(401, { error: 'unauthorized' })

    const deps: SyncDeps = {
      meta: new D1MetaStore(env.DB),
      blobs: new R2BlobStore(env.VAULT),
      maxFileBytes: Number(env.MAX_FILE_BYTES ?? 10 * 1024 * 1024),
    }

    try {
      if (url.pathname === '/v1/manifest' && req.method === 'GET') {
        const since = Number(url.searchParams.get('since') ?? '0')
        return toResponse(await getManifest(deps, since))
      }
      if (url.pathname === '/v1/file') {
        const path = url.searchParams.get('path')
        const author = req.headers.get('x-author') ?? ''
        if (req.method === 'GET') return toResponse(await getFile(deps, path))
        if (req.method === 'PUT') {
          const body = new Uint8Array(await req.arrayBuffer())
          return toResponse(await putFile(deps, {
            path, body,
            ifMatch: parseIfMatch(req.headers.get('if-match')),
            createOnly: req.headers.get('if-none-match') === '*',
            mtime: Number(req.headers.get('x-mtime')),
            author,
          }))
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
} satisfies ExportedHandler<Env>

function toResponse(r: Awaited<ReturnType<typeof getFile>>): Response {
  if ('bytes' in r && r.bytes) {
    return new Response(r.bytes as BodyInit, { status: r.status, headers: { 'content-type': 'application/octet-stream', ...(r.headers ?? {}) } })
  }
  if (r.status === 204) return new Response(null, { status: 204, headers: r.headers ?? {} })
  return json(r.status, r.body ?? {}, 'headers' in r ? (r.headers ?? {}) : {})
}
