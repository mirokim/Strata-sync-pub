/**
 * Thin fetch wrapper over the Strata Sync Worker's HTTP API (cloud/src/sync.ts protocol).
 * No caching or policy here — that lives in remoteVault.ts.
 */
import type { WebConfig } from './config'
import { t } from '@/i18n'

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

export interface BatchRun {
  startedAt: number
  durationMs: number
  trigger: 'cron' | 'manual'
  docs: number
  lint: { reportPath: string; errors: number; warnings: number; skipped: string[]; prunedReports: number }
  embeddings: { skipped: boolean; docsEmbedded: number; chunksUpserted: number; docsRemoved: number; chunksDeleted: number; pending: number; error?: string }
}

export interface BatchStatus {
  totalDocs: number
  embeddedDocs: number
  pendingDocs: number
  runs: BatchRun[]
}

export interface RoutineRun { at: number; by: string; summary: string; proposals: string[] }
export interface Routine { id: string; title: string; instructions: string; cadence: 'daily' | 'weekly' | 'manual'; enabled: boolean; runs: RoutineRun[] }
export interface Member {
  id: string
  name: string
  role: string
  scope: { folders: string[]; tags: string[] }
  reactsOnSave: boolean
  enabled: boolean
  routines: Routine[]
}
export interface MembersConfig { version: 1; members: Member[] }
export interface HistoryVersion { etag: string; at: number; author: string; size: number }
/** Mirrors cloud/src/me.ts MeOverview. */
export interface MeItem { path: string; title: string; author: string; at: string; personal?: true }
export interface MeRemark { member: string; path: string; title: string; at: string }
export interface MeProposal { path: string; title: string; author: string; at: string; cites: string[] }
export interface MeOverview {
  identity: { sub: string; author: string; service: boolean }
  guiUrl: string | null
  counts: { authored: number; personal: number; remarks: number; proposalsCitingMine: number; proposalsOpen: number }
  authored: MeItem[]
  personal: MeItem[]
  remarks: MeRemark[]
  proposalsCitingMine: MeProposal[]
  recentByOthers: MeItem[]
}

export interface HistoryResponse { path: string; current: HistoryVersion | null; versions: HistoryVersion[] }
export interface HistoryDiff { path: string; from: { etag: string; at: number; author: string }; text: string; stats: { added: number; removed: number; unchanged: number } }
export interface MembersResponse { config: MembersConfig; templates: Record<string, Omit<Member, 'id'>>; reactionsEnabled: boolean }

export class RemoteError extends Error {
  constructor(public status: number, message: string, public current?: RemoteRow) {
    super(message)
    this.name = 'RemoteError'
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export class RemoteClient {
  /**
   * @param onUnauthorized called once per request after a 401; return true when `config.token`
   *   was refreshed and the request should be retried (OAuth sessions).
   */
  constructor(
    private readonly config: WebConfig,
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
    private readonly onUnauthorized?: () => Promise<boolean>,
  ) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      authorization: `Bearer ${this.config.token}`,
      // Header values are Latin-1; a Korean author name must be percent-encoded (decoded server-side)
      'x-author': encodeURIComponent(this.config.author || ''),
      ...extra,
    }
  }

  private async request(path: string, init: RequestInit & { headers?: Record<string, string> } = {}, retried = false): Promise<Response> {
    const res = await this.fetchImpl(`${this.config.url}${path}`, { ...init, headers: this.headers(init.headers) })
    if (res.status === 401 && !retried && this.onUnauthorized && await this.onUnauthorized()) return this.request(path, init, true)
    if (res.status === 401) throw new RemoteError(401, this.config.auth === 'oauth' ? t('session expired — sign in again') : t('team token rejected'))
    if (res.status === 503) {
      const body = await res.clone().json().catch(() => ({})) as { error?: string }
      throw new RemoteError(503, body.error || t('server unavailable'))
    }
    return res
  }

  async health(): Promise<boolean> {
    const res = await this.fetchImpl(`${this.config.url}/health`)
    return res.ok
  }

  /** Who the server thinks we are (Google identity or the service token). */
  async me(): Promise<{ sub: string; email: string; name: string; picture: string | null; service: boolean; author: string }> {
    const res = await this.request('/v1/me')
    if (!res.ok) throw new RemoteError(res.status, `me failed (${res.status})`)
    return res.json()
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

  /** Vector-index coverage and the recent nightly/manual runs. */
  async batchStatus(): Promise<BatchStatus> {
    const res = await this.request('/v1/batch')
    if (!res.ok) throw new RemoteError(res.status, `batch status failed (${res.status})`)
    return res.json()
  }

  /** Run the lint + embedding batch now (can take a minute on a large vault). */
  async runBatch(): Promise<BatchRun> {
    const res = await this.request('/v1/lint/run', { method: 'POST' })
    if (!res.ok) throw new RemoteError(res.status, `batch run failed (${res.status})`)
    return res.json()
  }

  /** Move a document between the team space and the caller's personal space. */
  async setVisibility(path: string, personal: boolean): Promise<{ from: string; path: string; row: RemoteRow; personal: boolean }> {
    const res = await this.request('/v1/visibility', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path, personal }) })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new RemoteError(res.status, body.error || `visibility change failed (${res.status})`)
    }
    return res.json()
  }

  /** My desk: this identity's documents, remarks on them, proposals citing them, what others changed. */
  async meOverview(): Promise<MeOverview> {
    const res = await this.request('/v1/me/overview')
    if (!res.ok) throw new RemoteError(res.status, `me/overview failed (${res.status})`)
    return res.json()
  }

  async history(path: string): Promise<HistoryResponse> {
    const res = await this.request(`/v1/history?path=${encodeURIComponent(path)}`)
    if (!res.ok) throw new RemoteError(res.status, `history failed (${res.status})`)
    return res.json()
  }

  async historyDiff(path: string, etag: string): Promise<HistoryDiff> {
    const res = await this.request(`/v1/history?path=${encodeURIComponent(path)}&etag=${encodeURIComponent(etag)}&diff=1`)
    if (!res.ok) throw new RemoteError(res.status, `history diff failed (${res.status})`)
    return res.json()
  }

  async members(): Promise<MembersResponse> {
    const res = await this.request('/v1/members')
    if (!res.ok) throw new RemoteError(res.status, `members failed (${res.status})`)
    return res.json()
  }

  async saveMembers(config: MembersConfig): Promise<{ config: MembersConfig }> {
    const res = await this.request('/v1/members', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(config) })
    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as { error?: string }
      throw new RemoteError(res.status, body.error || `save failed (${res.status})`)
    }
    return res.json()
  }

  async propose(input: { title: string; body: string; tags?: string[]; links?: string[]; source?: string }): Promise<{ path: string; title: string }> {
    const res = await this.request('/v1/propose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) })
    if (!res.ok) throw new RemoteError(res.status, `propose failed (${res.status})`)
    return res.json()
  }
}
