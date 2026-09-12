/**
 * Edit Agent runtime state + persisted config.
 *
 * Runtime state (not persisted): isRunning, lastWakeAt, logs, pendingQueue, processingFile
 * Persisted: messages (localStorage, max 200 entries)
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// Log types

export type EditAgentLogAction =
  | 'wake'
  | 'diff_check'
  | 'file_edit'
  | 'file_skip'
  | 'error'
  | 'chat'
  | 'done'

export interface EditAgentLogEntry {
  id: string
  timestamp: number
  action: EditAgentLogAction
  /** Vault-relative file path (if applicable) */
  file?: string
  detail: string
  tokensUsed?: number
}

// Chat message types

export type AgentChatRole = 'user' | 'agent' | 'system' | 'tool'

export interface ToolCallItem {
  name: string
  input: unknown
  result: string
}

export interface AgentChatMessage {
  id: string
  role: AgentChatRole
  content: string
  timestamp: number
  /** For role='tool': the tool name (e.g. 'run_python_tool') */
  toolName?: string
  /** For role='tool' with multiple calls in one turn */
  toolGroup?: ToolCallItem[]
  /** For role='tool': collapsed by default, expanded on click */
  collapsed?: boolean
}

// Store state

export interface EditAgentState {
  /** Whether the autonomous wake cycle is active */
  isRunning: boolean
  /** Timestamp of the last wake cycle (null = never ran) */
  lastWakeAt: number | null
  /** In-memory log entries for this session */
  logs: EditAgentLogEntry[]
  /** Chat messages between user and edit agent (persisted to localStorage) */
  messages: AgentChatMessage[]
  /** Last streamed token being appended to the current agent response */
  streamingMessageId: string | null
  /** Files queued for refinement in the current cycle (filenames) */
  pendingQueue: string[]
  /** Filename currently being processed */
  processingFile: string | null
  /**
   * Countdown in seconds until automatic vault refresh after edits (null = not scheduled).
   * Managed by EditAgentPanel which ticks it every second and triggers reload at 0.
   */
  vaultRefreshCountdown: number | null
  /** Increments each time countdown is armed — used to detect re-arm in EditAgentPanel */
  vaultRefreshSession: number

  // Actions
  setIsRunning: (running: boolean) => void
  setLastWakeAt: (ts: number) => void
  setPendingQueue: (files: string[]) => void
  removeFromQueue: (filename: string) => void
  setProcessingFile: (file: string | null) => void

  /** Prepend a log entry (shown newest-first in UI) */
  addLog: (entry: Omit<EditAgentLogEntry, 'id' | 'timestamp'>) => void
  clearLogs: () => void

  /** Add a complete chat message */
  addMessage: (msg: Omit<AgentChatMessage, 'id' | 'timestamp'>) => string
  /** Add a single tool-call bubble (collapsed by default) */
  addToolCall: (toolName: string, input: unknown, result: string) => void
  /** Add multiple tool calls as one grouped summary bubble */
  addToolCallGroup: (items: ToolCallItem[]) => void
  /** Toggle the collapsed state of a tool-call bubble */
  toggleToolCollapsed: (id: string) => void
  /** Start streaming an agent response — returns the new message id */
  beginAgentStream: () => string
  /** Append chunk to the streaming message */
  appendStreamChunk: (id: string, chunk: string) => void
  /** Mark streaming complete */
  endAgentStream: (id: string) => void
  clearMessages: () => void

  /** Schedule a vault auto-refresh countdown (seconds) */
  startVaultRefreshCountdown: (seconds: number) => void
  /** Decrement countdown by 1; set to null when it reaches 1 (fires vault reload at countdown=1) */
  tickVaultRefreshCountdown: () => void
  /** Cancel a scheduled vault refresh */
  cancelVaultRefreshCountdown: () => void
}

let _logSeq = 0
let _msgSeq = 0

const MAX_PERSISTED_MESSAGES = 200

export const useEditAgentStore = create<EditAgentState>()(
  persist(
    (set) => ({
      isRunning: false,
      lastWakeAt: null,
      logs: [],
      messages: [],
      streamingMessageId: null,
      pendingQueue: [],
      processingFile: null,
      vaultRefreshCountdown: null,
      vaultRefreshSession: 0,

      setIsRunning: (running) => set({ isRunning: running }),
      setLastWakeAt: (ts) => set({ lastWakeAt: ts }),
      setPendingQueue: (pendingQueue) => set({ pendingQueue }),
      removeFromQueue: (filename) => set(s => ({ pendingQueue: s.pendingQueue.filter(f => f !== filename) })),
      setProcessingFile: (processingFile) => set({ processingFile }),

      addLog: (entry) =>
        set((state) => ({
          logs: [
            {
              id: `log-${Date.now()}-${_logSeq++}`,
              timestamp: Date.now(),
              ...entry,
            },
            ...state.logs.slice(0, 499), // cap at 500 entries
          ],
        })),

      clearLogs: () => set({ logs: [] }),

      addToolCall: (toolName, input, result) => {
        const id = `msg-${Date.now()}-${_msgSeq++}`
        const inputStr = JSON.stringify(input, null, 2)
        const content = `${inputStr}\n\n---\n${result}`
        set((state) => ({
          messages: [
            ...state.messages,
            { id, timestamp: Date.now(), role: 'tool' as AgentChatRole, toolName, content, collapsed: true },
          ].slice(-MAX_PERSISTED_MESSAGES),
        }))
      },

      addToolCallGroup: (items) => {
        const id = `msg-${Date.now()}-${_msgSeq++}`
        const content = items.map(t =>
          `[${t.name}]\n${JSON.stringify(t.input, null, 2)}\n\n---\n${t.result}`
        ).join('\n\n===\n\n')
        set((state) => ({
          messages: [
            ...state.messages,
            { id, timestamp: Date.now(), role: 'tool' as AgentChatRole, toolGroup: items, content, collapsed: true },
          ].slice(-MAX_PERSISTED_MESSAGES),
        }))
      },

      toggleToolCollapsed: (id) =>
        set((state) => ({
          messages: state.messages.map(m =>
            m.id === id ? { ...m, collapsed: !m.collapsed } : m
          ),
        })),

      addMessage: (msg) => {
        const id = `msg-${Date.now()}-${_msgSeq++}`
        set((state) => ({
          messages: [
            ...state.messages,
            { id, timestamp: Date.now(), ...msg },
          ].slice(-MAX_PERSISTED_MESSAGES),
        }))
        return id
      },

      beginAgentStream: () => {
        const id = `msg-${Date.now()}-${_msgSeq++}`
        set((state) => ({
          streamingMessageId: id,
          messages: [
            ...state.messages,
            { id, role: 'agent' as AgentChatRole, content: '', timestamp: Date.now() },
          ].slice(-MAX_PERSISTED_MESSAGES),
        }))
        return id
      },

      appendStreamChunk: (id, chunk) =>
        set((state) => ({
          messages: state.messages.map((m) =>
            m.id === id ? { ...m, content: m.content + chunk } : m
          ),
        })),

      endAgentStream: (id) =>
        set((state) => ({
          streamingMessageId: state.streamingMessageId === id ? null : state.streamingMessageId,
        })),

      clearMessages: () => set({ messages: [], streamingMessageId: null }),

      startVaultRefreshCountdown: (seconds) => set(s => ({ vaultRefreshCountdown: seconds, vaultRefreshSession: s.vaultRefreshSession + 1 })),
      tickVaultRefreshCountdown: () =>
        set((state) => ({
          vaultRefreshCountdown: state.vaultRefreshCountdown !== null && state.vaultRefreshCountdown > 1
            ? state.vaultRefreshCountdown - 1
            : null,
        })),
      cancelVaultRefreshCountdown: () => set({ vaultRefreshCountdown: null }),
    }),
    {
      name: 'edit-agent-messages',
      // Only persist messages; runtime state resets on reload
      partialize: (state) => ({ messages: state.messages }),
      // On rehydration, clear any dangling streamingMessageId
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.streamingMessageId = null
          // Remove any empty agent messages that were streaming when app closed
          state.messages = state.messages.filter(m => !(m.role === 'agent' && m.content === ''))
        }
      },
    },
  ),
)
