/**
 * Thin fetch wrapper over the Strata Sync Worker's HTTP API (cloud/src/sync.ts protocol).
 * No caching or policy here — that lives in remoteVault.ts.
 */
import type { WebConfig } from './config'

export interface RemoteRow {
  path: string
  etag: string
  size: number
  mtime: number
  author: string
  deleted: boolean
  seq: number
  updatedAt: number
}

export interface DocsPage {
  head: number
  /** Server instance identity; a different value than last time means the vault was re-created. */
  generation?: number
  next: number | null
  docs: RemoteDoc[]
}

export interface RemoteDoc extends RemoteRow {
  /** Markdown content; null for tombstones and binaries. */
  content: string | null
}

export class RemoteError extends Error {
  constructor(public status: number, message: string, public current?: RemoteRow) {
    super(message)
    this.name = 'RemoteError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class RemoteClient {
  constructor(private readonly config: WebConfig, private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init)) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.token}`,
      // Header values are Latin-1; a Korean author name must be percent-encoded (decoded server-side)
      'x-author': encodeURIComponent(this.config.author || ''),
      ...extra,
    }
  }

  private async request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.config.url}${path}`, { ...init, headers: this.headers(init.headers) })
    if (res.status === 401) throw new RemoteError(401, 'team token rejected')
    if (res.status === 503) {
      const body = await res.clone().json().catch(() => ({})) as { error?: string }
      throw new RemoteError(503, body.error || 'server unavailable')
    }
    return res
  }

  async health(): Promise<boolean> {
    const res = await this.fetchImpl(`${this.config.url}/health`)
    return res.ok
  }

  /** Documents changed after `after`, oldest first. */
  async docs(after: number, limit = 500): Promise<DocsPage> {
    const res = await this.request(`/v1/docs?after=${after}&limit=${limit}`)
    if (!res.ok) throw new RemoteError(res.status, `docs failed (${res.status})`)
    return res.json()
  }

  async manifest(since = 0): Promise<{ head: number; next: number | null; files: RemoteRow[] }> {
    const res = await this.request(`/v1/manifest?since=${since}`)
    if (!res.ok) throw new RemoteError(res.status, `manifest failed (${res.status})`)
    return res.json()
  }

  /** Raw bytes of a live file, with its etag/mtime; null when it does not exist. */
  async getFile(path: string): Promise<{ bytes: Uint8Array; etag: string; mtime: number; contentType: string } | null> {
    const res = await this.request(`/v1/file?path=${encodeURIComponent(path)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new RemoteError(res.status, `read failed (${res.status})`)
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      etag: (res.headers.get('etag') ?? '').replace(/^"|"$/g, ''),
      mtime: Number(res.headers.get('x-mtime')) || 0,
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  /**
   * Write a file. `ifMatch` = etag we last saw (optimistic lock); `createOnly` = must not exist.
   * Resolves with the new row (or the unchanged etag on 204); rejects with RemoteError(409, …, current) on a lost race.
   */
  async putFile(path: string, bytes: Uint8Array, opts: { ifMatch?: string; createOnly?: boolean; mtime?: number } = {}): Promise<{ status: number; etag: string; row: RemoteRow | null }> {
    const headers: Record<string, string> = { 'content-type': 'application/octet-stream', 'x-mtime': String(opts.mtime ?? Date.now()) }
    if (opts.ifMatch) headers['if-match'] = `"${opts.ifMatch}"`
    else if (opts.createOnly) headers['if-none-match'] = '*'
    const res = await this.request(`/v1/file?path=${encodeURIComponent(path)}`, { method: 'PUT', headers, body: bytes as unknown as BodyInit })
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { current?: RemoteRow }
      throw new RemoteError(409, 'conflict', body.current)
    }
    if (!res.ok && res.status !== 204) throw new RemoteError(res.status, `write failed (${res.status})`)
    const etag = (res.headers.get('etag') ?? '').replace(/^"|"$/g, '')
    const row = res.status === 204 ? null : await res.json() as RemoteRow
    return { status: res.status, etag: row?.etag ?? etag, row }
  }

  async deleteFile(path: string, ifMatch?: string): Promise<void> {
    const headers: Record<string, string> = {}
    if (ifMatch) headers['if-match'] = `"${ifMatch}"`
    const res = await this.request(`/v1/file?path=${encodeURIComponent(path)}`, { method: 'DELETE', headers })
    if (res.status === 409) {
      const body = await res.json().catch(() => ({})) as { current?: RemoteRow }
      throw new RemoteError(409, 'conflict', body.current)
    }
    if (!res.ok && res.status !== 204 && res.status !== 404) throw new RemoteError(res.status, `delete failed (${res.status})`)
  }

  async search(query: string, topK = 10): Promise<{ path: string; docId: string; heading: string; score: number }[]> {
    const res = await this.request('/v1/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, topK }) })
    if (!res.ok) throw new RemoteError(res.status, `search failed (${res.status})`)
    const body = await res.json() as { hits: { path: string; docId: string; heading: string; score: number }[] }
    return body.hits
  }

  async propose(input: { title: string; body: string; tags?: string[]; links?: string[]; source?: string }): Promise<{ path: string; title: string }> {
    const res = await this.request('/v1/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    if (!res.ok) throw new RemoteError(res.status, `propose failed (${res.status})`)
    return res.json()
  }
}
