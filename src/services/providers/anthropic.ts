import { parseSSEStream } from '@/services/sseParser'
import type { Attachment } from '@/types'
import { sanitize } from '@/lib/stringUtils'

const API_URL = 'https://api.anthropic.com/v1/messages'
const API_VERSION = '2023-06-01'

function getMaxTokens(model: string): number {
  // Models that support Extended Thinking have a larger output ceiling
  if (model.includes('claude-3-7') || model.includes('opus-4') || model.includes('sonnet-4')) return 16000
  if (model.includes('opus')) return 8192
  if (model.includes('sonnet')) return 8192
  return 4096 // haiku and others
}

/** Extended Thinking is not supported on the Haiku family */
function supportsThinking(model: string): boolean {
  return !model.includes('haiku')
}

// ── Content types ──────────────────────────────────────────────────────────────

type AnthropicTextPart = { type: 'text'; text: string }
type AnthropicImagePart = {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}
type AnthropicContentPart = AnthropicTextPart | AnthropicImagePart
type AnthropicContent = string | AnthropicContentPart[]

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContent
}

// sanitize imported from @/lib/stringUtils — keeps valid surrogate pairs, removes lone ones

/** Extract base64 data from a data URL like "data:image/png;base64,XXXX" */
function dataUrlToBase64(dataUrl: string): { mimeType: string; data: string } {
  const [header, data] = dataUrl.split(',')
  const mimeType = header.replace('data:', '').replace(';base64', '')
  return { mimeType, data }
}

/** Build the content for the last user message when image attachments are present */
function buildVisionContent(
  text: string,
  images: Attachment[]
): AnthropicContentPart[] {
  const parts: AnthropicContentPart[] = []
  // Images first (Anthropic recommends this order)
  for (const img of images) {
    const { mimeType, data } = dataUrlToBase64(img.dataUrl)
    parts.push({
      type: 'image',
      source: { type: 'base64', media_type: mimeType, data },
    })
  }
  if (text) parts.push({ type: 'text', text })
  return parts
}

/**
 * Stream a completion from Anthropic Claude.
 * Supports vision (image attachments) for multimodal prompts.
 */
export async function streamCompletion(
  apiKey: string,
  model: string,
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  onChunk: (chunk: string) => void,
  imageAttachments: Attachment[] = [],
  onUsage?: (inputTokens: number, outputTokens: number) => void,
  signal?: AbortSignal,
  thinkingOptions?: { enabled: boolean; budgetTokens: number },
): Promise<void> {
  const useThinking = thinkingOptions?.enabled && supportsThinking(model)
  const budgetTokens = thinkingOptions?.budgetTokens ?? 8000

  // Build Anthropic messages array; upgrade the last user message if images present
  const anthropicMessages: AnthropicMessage[] = messages.map((m, idx) => {
    const isLastUser = m.role === 'user' && idx === messages.length - 1
    if (isLastUser && imageAttachments.length > 0) {
      return { role: 'user', content: buildVisionContent(sanitize(m.content), imageAttachments) }
    }
    return { role: m.role, content: sanitize(m.content) }
  })

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
  }
  if (useThinking) {
    headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: useThinking ? budgetTokens + getMaxTokens(model) : getMaxTokens(model),
    system: sanitize(systemPrompt),
    messages: anthropicMessages,
    stream: true,
  }
  if (useThinking) {
    body['thinking'] = { type: 'enabled', budget_tokens: budgetTokens }
    body['temperature'] = 1  // Extended Thinking requires temperature = 1
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const errText = await response.text()
    let errMsg = errText
    try { errMsg = JSON.parse(errText)?.error?.message ?? errText } catch {}
    throw new Error(`Anthropic API error ${response.status}: ${errMsg}`)
  }

  /**
   * Anthropic streaming event types:
   * - content_block_delta: { type, index, delta: { type: 'text_delta', text: '...' } }
   * - message_delta: { type, delta: { stop_reason }, usage: { output_tokens } }
   * - message_start: { type, message: { usage: { input_tokens, output_tokens } } }
   * - message_stop: stream end
   */
  let inputTokens = 0
  let outputTokens = 0
  let inThinkingBlock = false  // whether an Extended Thinking block is in progress

  function extractChunk(data: string): string | null {
    const parsed = JSON.parse(data) as {
      type: string
      content_block?: { type: string }
      delta?: { type: string; text?: string; thinking?: string }
      usage?: { output_tokens?: number }
      message?: { usage?: { input_tokens?: number; output_tokens?: number } }
    }
    if (parsed.type === 'message_start' && parsed.message?.usage) {
      inputTokens = parsed.message.usage.input_tokens ?? 0
      outputTokens = parsed.message.usage.output_tokens ?? 0
    } else if (parsed.type === 'message_delta' && parsed.usage) {
      outputTokens = parsed.usage.output_tokens ?? outputTokens
    } else if (parsed.type === 'content_block_start') {
      inThinkingBlock = parsed.content_block?.type === 'thinking'
    } else if (parsed.type === 'content_block_stop') {
      inThinkingBlock = false
    } else if (parsed.type === 'content_block_delta') {
      if (inThinkingBlock) return null  // thinking block content is not exposed to the user
      if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
        return parsed.delta.text
      }
    }
    return null
  }

  for await (const chunk of parseSSEStream(response, extractChunk, signal)) {
    onChunk(chunk)
  }

  if (onUsage && (inputTokens > 0 || outputTokens > 0)) {
    onUsage(inputTokens, outputTokens)
  }
}
