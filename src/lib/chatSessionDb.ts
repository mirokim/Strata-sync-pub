/**
 * chatSessionDb.ts — Chat 세션 IndexedDB 영속화
 *
 * DB: 'sandbox_map_chat', Store: 'sessions'
 * Key: 'default' (단일 세션. 탭별 다중 세션은 향후 확장)
 */
import type { ChatMessage } from '@/types'

const DB_NAME    = 'sandbox_map_chat'
const DB_VERSION = 1
const STORE_NAME = 'sessions'
const SESSION_KEY = 'default'
const MAX_MESSAGES = 200  // 최대 보존 메시지 수

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => reject(req.error)
  })
}

export async function saveChatSession(messages: ChatMessage[]): Promise<void> {
  try {
    // streaming 중인 메시지는 저장 시 완료 처리
    const toSave = messages
      .filter(m => m.content || m.role === 'user')
      .map(m => ({ ...m, streaming: false }))
      .slice(-MAX_MESSAGES)
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(toSave, SESSION_KEY)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror    = () => { db.close(); reject(tx.error) }
    })
  } catch {
    // 영속화 실패는 무음 처리 — 앱 동작에 영향 없음
  }
}

export async function loadChatSession(): Promise<ChatMessage[]> {
  try {
    const db = await openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(SESSION_KEY)
      req.onsuccess = () => { db.close(); resolve(Array.isArray(req.result) ? req.result : []) }
      req.onerror   = () => { db.close(); reject(req.error) }
    })
  } catch {
    return []
  }
}

export async function clearChatSession(): Promise<void> {
  try {
    const db = await openDb()
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(SESSION_KEY)
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror    = () => { db.close(); resolve() }
    })
  } catch { /* 무음 */ }
}
