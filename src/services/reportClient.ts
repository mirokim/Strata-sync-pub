/**
 * reportClient — AI를 사용한 대화 보고서 생성 서비스.
 * settingsStore.reportModelId 에 설정된 모델로 대화를 분석하여 마크다운 보고서를 스트리밍합니다.
 */
import type { ChatMessage } from '@/types'
import { getProviderForModel } from '@/lib/modelConfig'
import { SPEAKER_CONFIG } from '@/lib/speakerConfig'
import { useSettingsStore, getApiKey } from '@/stores/settingsStore'
import { sanitize } from '@/lib/stringUtils'

// ── Conversation → readable text ──────────────────────────────────────────────

function buildConversationText(messages: ChatMessage[]): string {
  return messages
    .filter(m => !m.streaming && m.content.trim())
    .map(m => {
      const label = m.role === 'user'
        ? '사용자'
        : (SPEAKER_CONFIG[m.persona]?.label ?? m.persona)
      const ts = new Date(m.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
      return `[${label}] ${ts}\n${sanitize(m.content).trim()}`
    })
    .join('\n\n')
}

// ── System & user prompts ─────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  '당신은 전문 회의록 및 보고서 작성 전문가입니다. ' +
  '주어진 대화를 분석하여 명확하고 구조화된 마크다운 보고서를 작성합니다. ' +
  '핵심 내용을 추출하고 실용적인 형태로 정리하세요.'

function buildUserPrompt(conversationText: string): string {
  return (
    '아래 대화를 분석하여 한국어 마크다운 보고서를 작성해주세요.\n\n' +
    '보고서 구성:\n' +
    '1. **핵심 주제** — 대화에서 다룬 주요 주제 목록\n' +
    '2. **논의 요점** — 각 주제별 핵심 내용 요약\n' +
    '3. **주요 결정·제안** — 결정된 사항이나 제안된 아이디어\n' +
    '4. **다음 단계** — 후속 조치나 액션 아이템 (없으면 생략)\n\n' +
    '---\n\n' +
    '대화 기록:\n\n' +
    conversationText
  )
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * AI를 사용하여 대화 보고서를 스트리밍합니다.
 * settingsStore.reportModelId 가 설정되어 있어야 합니다.
 *
 * @throws reportModelId 미설정, 프로바이더 미인식, API 키 없음 시 Error
 */
export async function streamAIReport(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
): Promise<void> {
  const { reportModelId } = useSettingsStore.getState()
  if (!reportModelId) throw new Error('보고서 AI 모델이 설정되지 않았습니다.')

  const provider = getProviderForModel(reportModelId)
  if (!provider) throw new Error(`알 수 없는 모델: ${reportModelId}`)

  const apiKey = getApiKey(provider)
  if (!apiKey) throw new Error(`${provider} API 키가 설정되지 않았습니다.`)

  const conversationText = buildConversationText(messages)
  if (!conversationText.trim()) {
    throw new Error('보고서를 생성할 대화 내용이 없습니다.')
  }

  const userPrompt = buildUserPrompt(conversationText)
  const systemPrompt = SYSTEM_PROMPT
  const apiMessages = [{ role: 'user' as const, content: userPrompt }]

  switch (provider) {
    case 'anthropic': {
      const { streamCompletion } = await import('./providers/anthropic')
      await streamCompletion(apiKey, reportModelId, systemPrompt, apiMessages, onChunk)
      break
    }
    case 'openai': {
      const { streamCompletion } = await import('./providers/openai')
      await streamCompletion(apiKey, reportModelId, systemPrompt, apiMessages, onChunk)
      break
    }
    case 'gemini': {
      const { streamCompletion } = await import('./providers/gemini')
      await streamCompletion(apiKey, reportModelId, systemPrompt, apiMessages, onChunk)
      break
    }
    case 'grok': {
      const { streamCompletion } = await import('./providers/grok')
      await streamCompletion(apiKey, reportModelId, systemPrompt, apiMessages, onChunk)
      break
    }
    default:
      throw new Error(`지원하지 않는 프로바이더: ${provider}`)
  }
}
