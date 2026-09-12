/**
 * localZep.ts — Zep Cloud 로컬 대체 구현 (SQLite 기반)
 *
 * sql.js (WASM SQLite)를 사용하여 Zep Cloud의 에이전트 메모리 API를 재현합니다.
 * 단일 시뮬레이션 세션 내 에이전트별 기억을 in-memory SQLite DB로 관리합니다.
 *
 * Zep Cloud API 대응:
 *   client.memory.add(sessionId, messages)       → LocalZepClient.add()
 *   client.memory.get(sessionId)                 → LocalZepClient.get()
 *   client.memory.search(sessionId, text, limit) → LocalZepClient.search()
 */

import initSqlJs from 'sql.js'
// @ts-ignore — Vite ?url import
import sqlWasmUrl from 'sql.js/dist/sql-wasm.wasm?url'

export interface ZepMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: Record<string, unknown>
}

export interface ZepMemory {
  messages: ZepMessage[]
  /** Zep의 auto-summary 대응 — 최근 10개 메시지 컨텍스트 */
  context: string
}

export interface ZepSearchResult {
  message: ZepMessage
  score: number
}

// sql.js DB 인스턴스 (시뮬레이션 전체에서 공유)
let _db: import('sql.js').Database | null = null

async function getDb(): Promise<import('sql.js').Database> {
  if (_db) return _db
  const SQL = await initSqlJs({ locateFile: () => sqlWasmUrl })
  _db = new SQL.Database()
  _db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      session   TEXT    NOT NULL,
      role      TEXT    NOT NULL,
      content   TEXT    NOT NULL,
      metadata  TEXT    DEFAULT '{}',
      created   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session ON messages(session);
  `)
  return _db
}

export class LocalZepClient {
  private dbPromise = getDb()

  /** Zep Cloud: client.memory.add() */
  async add(sessionId: string, messages: ZepMessage[]): Promise<void> {
    const db = await this.dbPromise
    const stmt = db.prepare(
      'INSERT INTO messages (session, role, content, metadata, created) VALUES (?,?,?,?,?)'
    )
    for (const m of messages) {
      stmt.run([sessionId, m.role, m.content, JSON.stringify(m.metadata ?? {}), Date.now()])
    }
    stmt.free()
  }

  /** Zep Cloud: client.memory.get() — 최근 30개만 가져와 메모리 과부하 방지 */
  async get(sessionId: string): Promise<ZepMemory> {
    const db = await this.dbPromise
    const res = db.exec(
      'SELECT role, content, metadata FROM messages WHERE session=? ORDER BY id DESC LIMIT 30',
      [sessionId]
    )
    const messages: ZepMessage[] = (res[0]?.values ?? [])
      .reverse()
      .map((row: (string | number | null | Uint8Array)[]) => {
        let metadata: Record<string, unknown> = {}
        try { metadata = JSON.parse((row[2] as string) ?? '{}') } catch { /* 손상된 메타데이터 무시 */ }
        return {
          role:     row[0] as ZepMessage['role'],
          content:  row[1] as string,
          metadata,
        }
      })

    const context = messages
      .slice(-10)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n')

    return { messages, context }
  }

  /** Zep Cloud: client.memory.search() — 키워드 빈도 기반 관련도 점수 */
  async search(sessionId: string, text: string, limit = 5): Promise<ZepSearchResult[]> {
    const { messages } = await this.get(sessionId)
    const words = text.toLowerCase().split(/\s+/).filter(Boolean)
    if (!words.length) return []

    return messages
      .map(message => {
        const low = message.content.toLowerCase()
        const score = words.reduce((acc, w) => acc + (low.includes(w) ? 1 : 0), 0) / words.length
        return { message, score }
      })
      .filter(r => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /** 세션 메시지 삭제 */
  async delete(sessionId: string): Promise<void> {
    const db = await this.dbPromise
    db.run('DELETE FROM messages WHERE session=?', [sessionId])
  }

  /** DB 전체 초기화 (시뮬레이션 종료 후 메모리 해제) */
  static reset(): void {
    _db?.close()
    _db = null
  }
}
