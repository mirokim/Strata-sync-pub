import { create } from 'zustand'
import type { ChatMessage, SpeakerId, Attachment } from '@/types'
import { generateId } from '@/lib/utils'
import { STREAM_STAGGER_MS } from '@/lib/constants'
import { streamMessage, streamMessageWithTools } from '@/services/llmClient'
import { EDIT_AGENT_TOOLS, executeAgentTool } from '@/services/editAgentRunner'
import { getApiKey } from '@/stores/settingsStore'
import { getProviderForModel } from '@/lib/modelConfig'
import { useSettingsStore } from '@/stores/settingsStore'
import { generateReportHtmlFromContent } from '@/lib/chatReportExporter'
import { saveChatSession, loadChatSession, clearChatSession } from '@/lib/chatSessionDb'
import { SPEAKER_IDS } from '@/lib/speakerConfig'

const DEFAULT_PERSONA = SPEAKER_IDS[0]

/** Trims the oldest messages when the array exceeds 200 entries */
const MAX_MESSAGES = 200
function capMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.length > MAX_MESSAGES ? msgs.slice(-MAX_MESSAGES) : msgs
}

// Module-level abort controller — replaced each sendMessage, aborted by stopStreaming
let _activeAbortController: AbortController | null = null

// Chunk batch buffer — one setState every 50ms to reduce React re-renders
const _pendingChunks = new Map<string, string>()
const _pendingThinkingChunks = new Map<string, string>()
let _flushTimer: ReturnType<typeof setTimeout> | null = null
let _flushSet: ((fn: (s: ChatState) => Partial<ChatState> | ChatState) => void) | null = null

function _scheduleFlush() {
  if (_flushTimer !== null) return
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    if ((_pendingChunks.size === 0 && _pendingThinkingChunks.size === 0) || !_flushSet) return
    const snapshot = new Map(_pendingChunks)
    const snapshotThinking = new Map(_pendingThinkingChunks)
    _pendingChunks.clear()
    _pendingThinkingChunks.clear()
    _flushSet((state) => {
      const messages = state.messages.slice()
      let changed = false
      for (const [id, chunk] of snapshot) {
        const idx = messages.findIndex((m) => m.id === id)
        if (idx === -1) continue
        messages[idx] = { ...messages[idx], content: messages[idx].content + chunk }
        changed = true
      }
      for (const [id, chunk] of snapshotThinking) {
        const idx = messages.findIndex((m) => m.id === id)
        if (idx === -1) continue
        messages[idx] = { ...messages[idx], thinking: (messages[idx].thinking ?? '') + chunk }
        changed = true
      }
      return changed ? { messages } : state
    })
  }, 50)
}

// Report generation intent (Korean user input):
//   enters the PDF flow only when "보고서" (report) is followed by a creation verb
//   (써/만들/작성/정리 = write/make/compose/organize), or on an explicit export request
//   such as "대화/채팅 보고서" (chat report) or "PDF 만들어" (make a PDF)
const REPORT_INTENT_RE = /보고서.{0,20}(써|만들|작성|뽑아|정리|export|pdf)|(대화|채팅).{0,20}보고서|보고서.{0,20}(대화|채팅)|(pdf|PDF).{0,20}(만들|보고서|저장|export)/i

interface ChatState {
  activePersonas: SpeakerId[]
  messages: ChatMessage[]
  isLoading: boolean

  togglePersona: (id: SpeakerId) => void
  setPersonas: (ids: SpeakerId[]) => void
  /** Append a streaming chunk to an existing assistant message */
  appendChunk: (messageId: string, chunk: string) => void
  /** Append a thinking/sub-agent chunk to an existing assistant message */
  appendThinkingChunk: (messageId: string, chunk: string) => void
  /** Mark a streaming message as finished */
  finishStreaming: (messageId: string) => void
  sendMessage: (text: string, attachments?: Attachment[]) => Promise<void>
  /** Abort any in-flight streaming requests */
  stopStreaming: () => void
  clearMessages: () => void
  /** Restore the previous session from IndexedDB */
  restoreSession: () => Promise<void>
}

export const useChatStore = create<ChatState>()((set, get) => {
  _flushSet = set as typeof _flushSet
  return {
  activePersonas: [DEFAULT_PERSONA],
  messages: [],
  isLoading: false,

  togglePersona: (id) =>
    set((state) => ({
      activePersonas: state.activePersonas.includes(id)
        ? state.activePersonas.filter((p) => p !== id)
        : [...state.activePersonas, id],
    })),

  setPersonas: (ids) => set({ activePersonas: ids }),

  appendChunk: (messageId, chunk) => {
    // Accumulate in the buffer and apply in batches every 50ms — avoids a setState per chunk
    _pendingChunks.set(messageId, (_pendingChunks.get(messageId) ?? '') + chunk)
    _scheduleFlush()
  },

  appendThinkingChunk: (messageId, chunk) => {
    // Accumulate in the buffer and apply in batches every 50ms — same batching pattern as appendChunk
    _pendingThinkingChunks.set(messageId, (_pendingThinkingChunks.get(messageId) ?? '') + chunk)
    _scheduleFlush()
  },

  finishStreaming: (messageId) => {
    // Flush any remaining buffered chunks immediately, then set streaming: false
    if (_flushTimer !== null) {
      clearTimeout(_flushTimer)
      _flushTimer = null
    }
    set((state) => {
      const messages = state.messages.slice()
      let changed = false
      // Flush the remaining content buffer
      const pending = _pendingChunks.get(messageId)
      if (pending) {
        _pendingChunks.delete(messageId)
        const idx = messages.findIndex((m) => m.id === messageId)
        if (idx !== -1) {
          messages[idx] = { ...messages[idx], content: messages[idx].content + pending }
          changed = true
        }
      }
      // Flush the remaining thinking buffer
      const pendingThinking = _pendingThinkingChunks.get(messageId)
      if (pendingThinking) {
        _pendingThinkingChunks.delete(messageId)
        const idx = messages.findIndex((m) => m.id === messageId)
        if (idx !== -1) {
          messages[idx] = { ...messages[idx], thinking: (messages[idx].thinking ?? '') + pendingThinking }
          changed = true
        }
      }
      const idx = messages.findIndex((m) => m.id === messageId)
      if (idx !== -1) {
        messages[idx] = { ...messages[idx], streaming: false }
        changed = true
      }
      return changed ? { messages } : state
    })
  },

  sendMessage: async (text: string, attachments?: Attachment[]) => {
    const { activePersonas } = get()
    const trimmed = text.trim()
    if (!trimmed && (!attachments || attachments.length === 0)) return

    // Create a fresh abort controller for this request
    _activeAbortController?.abort()
    const abortController = new AbortController()
    _activeAbortController = abortController
    const signal = abortController.signal

    // ── Report generation intent detection ───────────────────────────────────
    // Let the LLM write the report, then export its content to PDF once finished.
    if (REPORT_INTENT_RE.test(trimmed) && window.reportAPI) {
      const reportPersona = activePersonas[0] ?? DEFAULT_PERSONA

      // Add the user message
      const userMsg: ChatMessage = {
        id: generateId(),
        persona: reportPersona,
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      }
      // LLM streaming placeholder (shows the report being written)
      const reportMsgId = generateId()
      const reportMsg: ChatMessage = {
        id: reportMsgId,
        persona: reportPersona,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
      }
      const history = get().messages.slice()
      set((state) => ({ messages: capMessages([...state.messages, userMsg, reportMsg]), isLoading: true }))

      // LLM streaming — receives the report content as markdown
      try {
        // `history` was snapshotted before userMsg was appended — it holds previous turns only
        await streamMessage(reportPersona, trimmed, history, (chunk) => {
          get().appendChunk(reportMsgId, chunk)
        }, undefined, undefined, (chunk) => {
          get().appendThinkingChunk(reportMsgId, chunk)
        }, signal, { historyIncludesCurrentTurn: false })
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          get().appendChunk(reportMsgId, '\n\n[Stopped]')
        } else {
          const errMsg = err instanceof Error ? err.message : String(err)
          get().appendChunk(reportMsgId, `[Error] ${errMsg}`)
        }
      } finally {
        get().finishStreaming(reportMsgId)
      }

      // Completed LLM response → PDF export
      const reportContent = get().messages.find(m => m.id === reportMsgId)?.content ?? ''
      if (reportContent.trim() && !reportContent.startsWith('[Error]')) {
        // "Saving PDF..." notification message
        const notifId = generateId()
        set((state) => ({
          messages: capMessages([...state.messages, {
            id: notifId,
            persona: reportPersona,
            role: 'assistant',
            content: 'Saving as PDF...',
            timestamp: Date.now(),
            streaming: true,
          } as ChatMessage]),
        }))

        // Report title: taken from the user message, or the default
        const titleMatch = trimmed.match(/["「『](.+?)["」』]/)
        const reportTitle = titleMatch?.[1] ?? 'Chat Report'
        const html = generateReportHtmlFromContent(reportContent, reportTitle)
        const result = await window.reportAPI!.exportPdf(html, `${reportTitle}.pdf`)

        const notifContent = result.ok
          ? `📄 Report saved\n\`${result.filePath}\``
          : result.reason === 'canceled'
            ? 'Save was canceled.'
            : `Save failed: ${result.reason}`

        set((state) => ({
          isLoading: false,
          messages: state.messages.map(m =>
            m.id === notifId ? { ...m, content: notifContent, streaming: false } : m
          ),
        }))
      } else {
        set({ isLoading: false })
      }
      return
    }

    // Add user message (include attachments if provided)
    const userMsg: ChatMessage = {
      id: generateId(),
      persona: activePersonas[0] ?? DEFAULT_PERSONA,
      role: 'user',
      content: trimmed,
      timestamp: Date.now(),
      attachments: attachments?.length ? attachments : undefined,
    }
    set((state) => ({ messages: capMessages([...state.messages, userMsg]), isLoading: true }))

    const personasToRespond =
      activePersonas.length > 0 ? activePersonas : ([DEFAULT_PERSONA] as SpeakerId[])

    // Stream all personas concurrently (with small staggered start)
    const streamingPromises = personasToRespond.map(async (persona, i) => {
      // Small staggered delay so messages appear sequentially
      await new Promise<void>((r) => setTimeout(r, i * STREAM_STAGGER_MS))

      // Create placeholder message with streaming: true
      const assistantMsgId = generateId()
      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        persona,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        streaming: true,
      }
      // Snapshot the history before adding the placeholder — keeps empty placeholders out of concurrent streams
      const history = get().messages.slice()
      set((state) => ({ messages: capMessages([...state.messages, assistantMsg]) }))

      try {
        // Detect if persona model is Anthropic — if so, run tool-enabled loop
        const { personaModels, customPersonas } = useSettingsStore.getState()
        const customPersona = customPersonas.find(p => p.id === persona)
        const modelId = customPersona ? customPersona.modelId : personaModels[persona as import('@/types').DirectorId]
        const provider = getProviderForModel(modelId)
        const apiKey = provider ? getApiKey(provider) : null
        const useTools = provider === 'anthropic' && !!apiKey

        if (useTools) {
          await streamMessageWithTools(
            persona, trimmed, history,
            (chunk) => { get().appendChunk(assistantMsgId, chunk) },
            (name, input, result) => {
              set((state) => {
                const messages = state.messages.slice()
                const idx = messages.findIndex(m => m.id === assistantMsgId)
                if (idx === -1) return state
                const prev = messages[idx].toolCalls ?? []
                messages[idx] = { ...messages[idx], toolCalls: [...prev, { name, input, result }] }
                return { messages }
              })
            },
            EDIT_AGENT_TOOLS as unknown as import('@/services/agentLoop').AnthropicTool[],
            executeAgentTool,
            attachments, undefined,
            (chunk) => { get().appendThinkingChunk(assistantMsgId, chunk) },
            signal,
          )
        } else {
          await streamMessage(persona, trimmed, history, (chunk) => {
            get().appendChunk(assistantMsgId, chunk)
          }, attachments, undefined, (chunk) => {
            get().appendThinkingChunk(assistantMsgId, chunk)
          }, signal)
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          // User stopped streaming — mark message as finished without appending error
        } else {
          const errMsg = err instanceof Error ? err.message : String(err)
          const friendlyMsg = errMsg.includes('401') ? '[Error] API key is invalid. Please check your API key in settings.'
            : errMsg.includes('429') ? '[Error] API rate limit exceeded. Please try again later.'
            : errMsg.includes('network') || errMsg.includes('fetch') ? '[Error] Please check your network connection.'
            : `[Error] ${errMsg}`
          get().appendChunk(assistantMsgId, friendlyMsg)
        }
      } finally {
        get().finishStreaming(assistantMsgId)
      }
    })

    // allSettled: each persona streams to completion independently; one failure doesn't abort others
    await Promise.allSettled(streamingPromises)
    // Make sure isLoading is cleared even if stopStreaming was called first
    if (_activeAbortController === abortController) {
      _activeAbortController = null
      set({ isLoading: false })
    }
  },

  stopStreaming: () => {
    _activeAbortController?.abort()
    _activeAbortController = null
    set({ isLoading: false })
  },

  clearMessages: () => {
    set({ messages: [], isLoading: false })
    clearChatSession()
  },

  restoreSession: async () => {
    const messages = await loadChatSession()
    if (messages.length > 0) set({ messages: capMessages(messages) })
  },
} // return
}) // create

// ── Auto-persist messages to IndexedDB (debounced, skip while streaming) ───────
let _saveChatTimer: ReturnType<typeof setTimeout> | null = null
useChatStore.subscribe((state) => {
  const { messages } = state
  if (messages.some(m => m.streaming)) return
  if (_saveChatTimer) clearTimeout(_saveChatTimer)
  _saveChatTimer = setTimeout(() => saveChatSession(messages), 800)
})
