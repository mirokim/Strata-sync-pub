import { D1MetaStore, R2BlobStore } from './stores.js'
import { putFile, deleteFile, normalizeVaultPath, serialize, type SyncDeps, type SyncResult } from './sync.js'
import { applyR2Events, type R2EventMessage, type BridgeResult } from './r2events.js'

interface WriterEnv { DB: D1Database; VAULT: R2Bucket; MAX_FILE_BYTES?: string }

/** Internal binding only: authorization happens in the HTTP/MCP caller before dispatch.
 * All API, MCP and background protocol writes for a path share this object. Its persistent
 * identity, rather than a Worker-isolate mutex, is the cross-request coordination boundary.
 * sync.ts serializes the complete precondition/history/blob/metadata operation on these stores.
 */
export class VaultWriter {
  private readonly deps: SyncDeps
  constructor(_state: DurableObjectState, env: WriterEnv) {
    this.deps = { meta: new D1MetaStore(env.DB), blobs: new R2BlobStore(env.VAULT), maxFileBytes: Number(env.MAX_FILE_BYTES ?? 10 * 1024 * 1024) }
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const path = normalizeVaultPath(url.searchParams.get('path'))
    if (!path) return Response.json({ error: 'invalid path' }, { status: 400 })
    if (req.method === 'POST') {
      const event = await req.json() as R2EventMessage
      event.object = { ...event.object, key: path }
      return Response.json(await serialize(this.deps.meta, path, () => applyR2Events(this.deps, [event])))
    }
    const author = url.searchParams.get('author') ?? ''
    const authorSub = url.searchParams.get('authorSub') ?? ''
    const ifMatch = url.searchParams.get('ifMatch') ?? undefined
    let result: SyncResult
    if (req.method === 'PUT') {
      result = await putFile(this.deps, { path, author, authorSub, ifMatch,
        createOnly: url.searchParams.get('createOnly') === 'true',
        mtime: Number(url.searchParams.get('mtime')), body: new Uint8Array(await req.arrayBuffer()) })
    } else if (req.method === 'DELETE') {
      result = await deleteFile(this.deps, path, ifMatch, author, authorSub)
    } else return new Response('method not allowed', { status: 405 })
    // Protocol status lives in the envelope, including 204 (which cannot have an HTTP body).
    return Response.json(result)
  }
}

export function coordinatedWriter(namespace: DurableObjectNamespace | undefined): NonNullable<SyncDeps['writer']> {
  async function send<T>(path: string, method: string, params: Record<string, unknown>, body?: Uint8Array): Promise<T> {
    if (!namespace) throw new Error('VAULT_WRITER binding required for safe writes')
    const url = new URL('https://writer.internal/')
    url.searchParams.set('path', path)
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value))
    const stub = namespace.get(namespace.idFromName(path))
    const res = await stub.fetch(url.toString(), { method, body: body as BodyInit | undefined })
    if (!res.ok) throw new Error(`write coordinator failed (${res.status})`)
    return res.json() as Promise<T>
  }
  return {
    put: ({ path, body, ...params }) => send<SyncResult>(path!, 'PUT', params, body),
    delete: (path, ifMatch, author, authorSub) => send<SyncResult>(path, 'DELETE', { ifMatch, author, authorSub }),
    reconcile: event => send<BridgeResult>(event.object.key, 'POST', {}, new TextEncoder().encode(JSON.stringify(event))),
  }
}
