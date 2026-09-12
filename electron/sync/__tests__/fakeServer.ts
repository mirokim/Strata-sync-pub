/**
 * In-process stand-in for the cloud Worker: routes fetch() calls to the real protocol code in
 * cloud/src/sync.ts over in-memory stores. Lets two engines "share" a server in one test.
 */
import { getManifest, getFile, putFile, deleteFile, parseIfMatch, type SyncDeps } from '../../../cloud/src/sync.js'
import { MemoryMeta, MemoryBlobs } from '../../../cloud/test/fakes.js'

export class FakeServer {
  meta = new MemoryMeta()
  blobs = new MemoryBlobs()
  deps: SyncDeps
  calls: string[] = []
  /** Set to make every request fail (simulates the network being down). */
  offline = false

  constructor(public token = 'tok') {
    this.deps = { meta: this.meta, blobs: this.blobs, maxFileBytes: 1024 * 1024, now: () => 1_800_000_000_000 }
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (this.offline) throw new TypeError('fetch failed')
    const url = new URL(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers as HeadersInit)
    this.calls.push(`${method} ${url.pathname}${url.search}`)
    if (url.pathname === '/health') return json(200, { ok: true })
    if (headers.get('authorization') !== `Bearer ${this.token}`) return json(401, { error: 'unauthorized' })

    const author = headers.get('x-author') ?? ''
    const path = url.searchParams.get('path')
    let r
    if (url.pathname === '/v1/manifest') r = await getManifest(this.deps, Number(url.searchParams.get('since') ?? '0'))
    else if (url.pathname === '/v1/file' && method === 'GET') r = await getFile(this.deps, path)
    else if (url.pathname === '/v1/file' && method === 'PUT') {
      const body = toBytes(init.body)
      r = await putFile(this.deps, {
        path, body, author,
        ifMatch: parseIfMatch(headers.get('if-match')),
        createOnly: headers.get('if-none-match') === '*',
        mtime: Number(headers.get('x-mtime')),
      })
    } else if (url.pathname === '/v1/file' && method === 'DELETE') r = await deleteFile(this.deps, path, parseIfMatch(headers.get('if-match')), author)
    else return json(404, { error: 'not found' })

    if ('bytes' in r && r.bytes) return new Response(r.bytes as BodyInit, { status: r.status, headers: r.headers })
    if (r.status === 204) return new Response(null, { status: 204, headers: r.headers })
    return json(r.status, r.body ?? {}, 'headers' in r ? r.headers : undefined)
  }

  text(path: string): string | null {
    const b = this.blobs.objects.get(path)
    return b ? new TextDecoder().decode(b) : null
  }
}

function toBytes(body: BodyInit | null | undefined): Uint8Array {
  if (!body) return new Uint8Array()
  if (body instanceof Uint8Array) return body
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  throw new Error('unsupported body in fake server')
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...(headers ?? {}) } })
}
