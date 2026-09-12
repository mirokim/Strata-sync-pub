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

/** 메시지 배열이 200개를 초과하면 오래된 메시지부터 잘라냄 */
const MAX_MESSAGES = 200
function capMessages(msgs: ChatMessage[]): ChatMessage[] {
  return msgs.length > MAX_MESSAGES ? msgs.slice(-MAX_MESSAGES) : msgs
}

// Module-level abort controller — replaced each sendMessage, aborted by stopStreaming
let _activeAbortController: AbortController | null = null

// 청크 배치 버퍼 — 50ms마다 한 번에 setState해 React 리렌더링 횟수 감소
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

// 보고서 생성 인텐트:
//   "보고서 써줘 / 만들어줘 / 작성해줘 / 정리해줘" 등 생성 동사가 따라오거나
//   "대화/채팅 보고서", "PDF 만들어" 처럼 명시적 내보내기 요청일 때만 PDF 플로우
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
  /** IndexedDB에서 이전 세션 복원 */
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
    // 버퍼에 누적 후 50ms마다 일괄 적용 — 매 청크 setState 방지
    _pendingChunks.set(messageId, (_pendingChunks.get(messageId) ?? '') + chunk)
    _scheduleFlush()
  },

  appendThinkingChunk: (messageId, chunk) => {
    // 버퍼에 누적 후 50ms마다 일괄 적용 — appendChunk와 동일한 배치 패턴
    _pendingThinkingChunks.set(messageId, (_pendingThinkingChunks.get(messageId) ?? '') + chunk)
    _scheduleFlush()
  },

  finishStreaming: (messageId) => {
    // 버퍼에 남은 청크를 즉시 반영 후 streaming: false 처리
    if (_flushTimer !== null) {
      clearTimeout(_flushTimer)
      _flushTimer = null
    }
    set((state) => {
      const messages = state.messages.slice()
      let changed = false
      // 남은 content 버퍼 flush
      const pending = _pendingChunks.get(messageId)
      if (pending) {
        _pendingChunks.delete(messageId)
        const idx = messages.findIndex((m) => m.id === messageId)
        if (idx !== -1) {
          messages[idx] = { ...messages[idx], content: messages[idx].content + pending }
          changed = true
        }
      }
      // 남은 thinking 버퍼 flush
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

    // ── 보고서 생성 인텐트 감지 ────────────────────────────────────────────────
    // LLM에게 보고서 작성을 맡기고, 완료 후 그 내용을 PDF로 내보냅니다.
    if (REPORT_INTENT_RE.test(trimmed) && window.reportAPI) {
      const reportPersona = activePersonas[0] ?? DEFAULT_PERSONA

      // 유저 메시지 추가
      const userMsg: ChatMessage = {
        id: generateId(),
        persona: reportPersona,
        role: 'user',
        content: trimmed,
        timestamp: Date.now(),
      }
      // LLM 스트리밍 플레이스홀더 (보고서 작성중 표시)
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

      // LLM 스트리밍 — 보고서 내용을 마크다운으로 받습니다
      try {
        await streamMessage(reportPersona, trimmed, history, (chunk) => {
          get().appendChunk(reportMsgId, chunk)
        }, undefined, undefined, (chunk) => {
          get().appendThinkingChunk(reportMsgId, chunk)
        }, signal)
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
          get().appendChunk(reportMsgId, '\n\n[중단됨]')
        } else {
          const errMsg = err instanceof Error ? err.message : String(err)
          get().appendChunk(reportMsgId, `[오류] ${errMsg}`)
        }
      } finally {
        get().finishStreaming(reportMsgId)
      }

      // 완료된 LLM 응답 → PDF 내보내기
      const reportContent = get().messages.find(m => m.id === reportMsgId)?.content ?? ''
      if (reportContent.trim() && !reportContent.startsWith('[오류]')) {
        // "PDF 저장 중..." 알림 메시지
        const notifId = generateId()
        set((state) => ({
          messages: capMessages([...state.messages, {
            id: notifId,
            persona: reportPersona,
            role: 'assistant',
            content: 'PDF로 저장하는 중...',
            timestamp: Date.now(),
            streaming: true,
          } as ChatMessage]),
        }))

        // 보고서 제목: 유저 메시지에서 따거나 기본값
        const titleMatch = trimmed.match(/["「『](.+?)["」』]/)
        const reportTitle = titleMatch?.[1] ?? '대화 보고서'
        const html = generateReportHtmlFromContent(reportContent, reportTitle)
        const result = await window.reportAPI!.exportPdf(html, `${reportTitle}.pdf`)

        const notifContent = result.ok
          ? `📄 보고서 저장 완료\n\`${result.filePath}\``
          : result.reason === 'canceled'
            ? '저장이 취소됐어요.'
            : `저장 실패: ${result.reason}`

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
      // 히스토리를 플레이스홀더 추가 전에 스냅샷 — 동시 스트리밍 시 빈 플레이스홀더가 섞이지 않도록
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
          const friendlyMsg = errMsg.includes('401') ? '[오류] API 키가 유효하지 않습니다. 설정에서 API 키를 확인해주세요.'
            : errMsg.includes('429') ? '[오류] API 사용량 한도 초과. 잠시 후 다시 시도해주세요.'
            : errMsg.includes('network') || errMsg.includes('fetch') ? '[오류] 네트워크 연결을 확인해주세요.'
            : `[오류] ${errMsg}`
          get().appendChunk(assistantMsgId, friendlyMsg)
        }
      } finally {
        get().finishStreaming(assistantMsgId)
      }
    })

    // allSettled: each persona streams to completion independently; one failure doesn't abort others
    await Promise.allSettled(streamingPromises)
    // stopStreaming이 먼저 호출됐어도 확실히 isLoading 해제
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
