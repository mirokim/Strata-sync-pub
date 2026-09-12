/**
 * CORS for the browser client (the web app is hosted on Vercel, the API on Cloudflare).
 *
 * `ALLOWED_ORIGINS` is a comma-separated allowlist; `*` allows any origin (fine while the API is
 * protected by the team token, but list the real origins once they are known). Requests without
 * an Origin header (curl, the Electron client, the MCP CLI) are untouched.
 */

const ALLOW_HEADERS = 'Authorization, Content-Type, If-Match, If-None-Match, X-Mtime, X-Author, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID'
const EXPOSE_HEADERS = 'ETag, X-Mtime, X-Author, X-Seq, Mcp-Session-Id, Content-Type'

export function allowedOrigin(origin: string | null, allowlist: string | undefined): string | null {
  if (!origin) return null
  const list = (allowlist ?? '').split(',').map(s => s.trim()).filter(Boolean)
  if (list.includes('*')) return origin
  return list.includes(origin) ? origin : null
}

export function corsHeaders(origin: string | null, allowlist: string | undefined): Record<string, string> {
  const allowed = allowedOrigin(origin, allowlist)
  if (!allowed) return {}
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  }
}

/** Answer a preflight; 403 when the origin is not allowed so misconfiguration is visible. */
export function preflight(req: Request, allowlist: string | undefined): Response {
  const headers = corsHeaders(req.headers.get('origin'), allowlist)
  if (Object.keys(headers).length === 0) return new Response(null, { status: 403 })
  return new Response(null, { status: 204, headers })
}

export function withCors(res: Response, req: Request, allowlist: string | undefined): Response {
  const headers = corsHeaders(req.headers.get('origin'), allowlist)
  if (Object.keys(headers).length === 0) return res
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v)
  return out
}
