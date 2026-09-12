/**
 * Debate engine — orchestrates multi-AI discussions.
 * Adapted from Onion_flow's debateEngine.ts for Sandbox MAP's provider system.
 *
 * Key difference: uses Sandbox MAP's streaming providers (providers/*.ts)
 * with env API keys, rather than Onion_flow's callWithTools/aiStore approach.
 */
import type {
  DiscussionConfig,
  DiscussionMessage,
  DebateCallbacks,
  ReferenceFile,
} from '@/types'
import { DEBATE_PROVIDER_LABELS, ROLE_OPTIONS, ROLE_DESCRIPTIONS } from './debateRoles'
import { generateId } from '@/lib/utils'
import { getApiKey, useSettingsStore } from '@/stores/settingsStore'
import { getProviderForModel, DEFAULT_MODELS_BY_PROVIDER } from '@/lib/modelConfig'
import type { ProviderId, DirectorId, DiscussionParticipantId } from '@/types'


// ── Content block types for multimodal messages ──────────────────────────────

interface TextContent { type: 'text'; text: string }
interface ImageContent { type: 'image_url'; image_url: { url: string } }
type ContentPart = TextContent | ImageContent

type ApiMessage = { role: string; content: string | ContentPart[] }

// ── System Prompt Builders ───────────────────────────────────────────────────

function buildSystemPrompt(
  config: DiscussionConfig,
  currentProvider: string,
): string {
  const label = DEBATE_PROVIDER_LABELS[currentProvider] || currentProvider
  const participantList = config.selectedProviders
    .map((p) => DEBATE_PROVIDER_LABELS[p] || p)
    .join(', ')

  const labelList = config.selectedProviders
    .map((p) => `"[${DEBATE_PROVIDER_LABELS[p] || p}]:"`)
    .join(', ')

  const base = `당신은 "${label}"입니다. 여러 AI가 참여하는 토론에 참가하고 있습니다.
토론 주제: "${config.topic}"
참여자: ${participantList}

규칙:
- 한국어로 답변하세요.
- 간결하고 핵심적으로 답변하세요 (200~400자).
- 다른 참여자의 의견을 구체적으로 언급하며 발전시키세요.
- ${labelList} 형식의 라벨은 다른 참여자의 발언입니다.
- "[User]:" 라벨은 토론을 지켜보는 사용자의 개입입니다. 사용자의 질문이나 요청에 우선적으로 응답하세요.

정확성 및 신뢰성 원칙 (반드시 준수):
- 사실 관계를 언급할 때는 반드시 출처를 밝히거나 링크를 제공하세요.
- 사실, 이름, 도구, 기능, 날짜, 통계, 인용구, 출처 또는 예시를 절대 지어내지 마세요.
- 모르는 정보에 대해서는 "확인이 필요합니다"라고 답하세요.
- 확신도가 95% 미만인 정보는 불확실성을 명확히 밝히세요.`

  let prompt: string

  switch (config.mode) {
    case 'roundRobin':
      prompt = `${base}\n\n토론 방식: 라운드 로빈 (순서대로 발언)\n이전 발언자의 의견을 참고하여 동의/반박/보완하며 자신의 의견을 제시하세요.`
      break

    case 'freeDiscussion':
      prompt = `${base}\n\n토론 방식: 자유 토론\n다른 참여자의 의견에 자유롭게 반박, 동의, 질문, 보완을 하세요.\n때로는 완전히 새로운 관점을 제시해도 좋습니다.`
      break

    case 'roleAssignment': {
      const roleConfig = config.roles.find((r) => r.provider === currentProvider)
      const roleLabel = roleConfig?.role || '중립'
      const roleOption = ROLE_OPTIONS.find((r) => r.label === roleLabel)
      const roleDescription = roleOption ? ROLE_DESCRIPTIONS[roleOption.value] || '' : ''

      prompt = `${base}\n\n토론 방식: 역할 배정\n당신에게 배정된 역할: **${roleLabel}**\n${roleDescription}\n이 역할의 관점과 말투를 일관되게 유지하며 논의하세요.`
      break
    }

    case 'battle': {
      const isJudge = config.judgeProvider === currentProvider
      if (isJudge) {
        const debaters = config.selectedProviders
          .filter((p) => p !== config.judgeProvider)
          .map((p) => DEBATE_PROVIDER_LABELS[p] || p)
          .join(' vs ')
        prompt = `${base}\n\n토론 방식: 결전모드 (심판)\n당신은 이 토론의 **심판**입니다. 토론에 직접 참여하지 않습니다.\n대결 구도: ${debaters}\n\n각 라운드가 끝나면 다음 형식으로 평가하세요:\n\n📊 **라운드 [N] 평가**\n\n| 참여자 | 점수 (10점 만점) | 평가 |\n|--------|-----------------|------|\n| [AI이름] | X점 | 한줄 평가 |\n\n💬 **심판 코멘트**: 이번 라운드의 핵심 쟁점과 각 참여자의 강점/약점을 분석하세요.\n🏆 **라운드 승자**: [AI이름]\n\n채점 기준: 논리성(3점), 근거의 질(3점), 반박력(2점), 설득력(2점)\n\n최종 라운드에서는 추가로:\n🏅 **최종 승자**: [AI이름]\n📝 **종합 평가**: 전체 토론을 종합적으로 평가하세요.`
      } else {
        const debaters = config.selectedProviders
          .filter((p) => p !== config.judgeProvider)
          .map((p) => DEBATE_PROVIDER_LABELS[p] || p)
        const opponents = debaters.filter((n) => n !== label).join(', ')
        const judgeName = config.judgeProvider
          ? (DEBATE_PROVIDER_LABELS[config.judgeProvider] || config.judgeProvider)
          : '심판'

        const roleConfig = config.roles.find((r) => r.provider === currentProvider)
        const roleLabel = roleConfig?.role
        const roleOption = roleLabel ? ROLE_OPTIONS.find((r) => r.label === roleLabel) : null
        const roleDescription = roleOption ? ROLE_DESCRIPTIONS[roleOption.value] || '' : ''
        const roleSection = roleLabel && roleLabel !== '중립'
          ? `\n\n당신의 캐릭터: **${roleLabel}**\n${roleDescription}\n이 캐릭터의 말투와 성격을 유지하면서 토론하세요.`
          : ''

        prompt = `${base}\n\n토론 방식: 결전모드 (토론자)\n이것은 경쟁 토론입니다. 상대방: ${opponents}\n심판: ${judgeName} (매 라운드 채점)\n\n목표: 심판에게 높은 점수를 받아 승리하세요.\n- 강력한 논거와 구체적 근거를 제시하세요.\n- 상대방의 약점을 정확히 지적하고 반박하세요.\n- 논리성, 근거의 질, 반박력, 설득력이 채점 기준입니다.${roleSection}`
      }
      break
    }

    default:
      prompt = base
  }

  if (config.useReference && config.referenceText.trim()) {
    prompt += `\n\n참고 자료:\n"""\n${config.referenceText.trim()}\n"""\n\n위 참고 자료를 바탕으로 토론하세요.`
  }

  if (config.referenceFiles.length > 0) {
    prompt += `\n\n첨부된 이미지/문서 파일이 참고 자료로 제공됩니다. 해당 자료를 분석하고 토론에 활용하세요.`
  }

  return prompt
}

// ── Build file content blocks ────────────────────────────────────────────────

function buildFileBlocks(files: ReferenceFile[]): ContentPart[] {
  const blocks: ContentPart[] = []
  for (const file of files) {
    if (file.mimeType.startsWith('image/')) {
      blocks.push({ type: 'image_url', image_url: { url: file.dataUrl } })
    }
  }
  return blocks
}

// ── Message Formatting ────────────────────────────────────────────────────────

function buildApiMessages(
  allMessages: DiscussionMessage[],
  currentProvider: string,
  referenceFiles: ReferenceFile[],
  isFirstCall: boolean,
): ApiMessage[] {
  const recent = allMessages.slice(-15)
  const fileBlocks = isFirstCall && referenceFiles.length > 0
    ? buildFileBlocks(referenceFiles)
    : []

  if (recent.length === 0) {
    const text = '토론을 시작해주세요. 주제에 대한 당신의 의견을 먼저 제시하세요.'
    if (fileBlocks.length > 0) {
      return [{ role: 'user', content: [{ type: 'text', text }, ...fileBlocks] }]
    }
    return [{ role: 'user', content: text }]
  }

  return recent.map((msg, index) => {
    if (msg.provider === currentProvider) {
      return { role: 'assistant', content: msg.content }
    }

    const label = msg.provider === 'user'
      ? 'User'
      : (DEBATE_PROVIDER_LABELS[msg.provider] || msg.provider)
    const prefix = msg.provider === 'user' ? '[User]' : `[${label}]`
    const judgeTag = msg.messageType === 'judge-evaluation' ? ' (심판 평가)' : ''
    const text = `${prefix}${judgeTag}: ${msg.content}`

    const msgFileBlocks = msg.files && msg.files.length > 0
      ? buildFileBlocks(msg.files)
      : []

    const extraBlocks = index === 0 ? [...fileBlocks, ...msgFileBlocks] : msgFileBlocks

    if (extraBlocks.length > 0) {
      return { role: 'user', content: [{ type: 'text' as const, text }, ...extraBlocks] }
    }

    return { role: 'user', content: text }
  })
}

// ── Judge-specific message builder ───────────────────────────────────────────

function buildJudgeApiMessages(
  allMessages: DiscussionMessage[],
  currentRound: number,
  judgeProvider: string,
): ApiMessage[] {
  const relevantMessages = allMessages.filter(
    (msg) => msg.provider !== judgeProvider || msg.messageType === 'judge-evaluation',
  )
  const recent = relevantMessages.slice(-20)

  if (recent.length === 0) {
    return [{ role: 'user', content: `라운드 ${currentRound}의 토론을 평가해주세요.` }]
  }

  const messages: ApiMessage[] = recent.map((msg) => {
    if (msg.provider === judgeProvider) {
      return { role: 'assistant', content: msg.content }
    }
    const label = msg.provider === 'user'
      ? 'User'
      : (DEBATE_PROVIDER_LABELS[msg.provider] || msg.provider)
    return {
      role: 'user',
      content: `[${label}] (라운드 ${msg.round}): ${msg.content}`,
    }
  })

  messages.push({
    role: 'user',
    content: `위 토론 내용을 바탕으로 라운드 ${currentRound}을 평가해주세요.`,
  })

  return messages
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function doPacing(
  config: DiscussionConfig,
  callbacks: DebateCallbacks,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return false

  if (config.pacingMode === 'manual') {
    callbacks.onCountdownTick(-1)
    await callbacks.waitForNextTurn()
    if (signal.aborted) return false
    if (callbacks.getStatus() !== 'running') return false
    callbacks.onCountdownTick(0)
  } else {
    const totalSeconds = config.autoDelay
    for (let s = totalSeconds; s > 0; s--) {
      if (signal.aborted) return false
      while (callbacks.getStatus() === 'paused') {
        await sleep(500)
        if (signal.aborted) return false
      }
      if (callbacks.getStatus() !== 'running') return false
      callbacks.onCountdownTick(s)
      await sleep(1000)
    }
    callbacks.onCountdownTick(0)
  }

  return true
}

async function waitWhilePaused(
  callbacks: DebateCallbacks,
  signal: AbortSignal,
): Promise<boolean> {
  while (callbacks.getStatus() === 'paused') {
    await sleep(500)
    if (signal.aborted) return false
  }
  return callbacks.getStatus() === 'running'
}

// ── Call provider via Sandbox MAP's streaming providers ────────────────────

async function callDebateProvider(
  persona: string,
  systemPrompt: string,
  apiMessages: ApiMessage[],
  signal: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  if (signal.aborted) {
    return { content: '요청이 취소되었습니다.', isError: true }
  }

  // Resolve model: persona-based lookup first, then provider-based default fallback
  const { personaModels } = useSettingsStore.getState()
  const model =
    (personaModels as Record<string, string>)[persona] ??
    DEFAULT_MODELS_BY_PROVIDER[persona]
  if (!model) {
    return { content: `모델을 찾을 수 없습니다: ${persona}`, isError: true }
  }

  // Derive provider from model ID; fall back to treating persona as a raw provider ID
  const provider: ProviderId =
    getProviderForModel(model) ?? (persona as ProviderId)

  const apiKey = getApiKey(provider)
  if (!apiKey) {
    const label = DEBATE_PROVIDER_LABELS[persona] || persona
    return { content: `[${label}] API 키가 설정되지 않았습니다.`, isError: true }
  }

  // Convert ApiMessage[] to simple {role, content: string}[] for the streaming providers
  const simpleMessages = apiMessages.map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: typeof m.content === 'string'
      ? m.content
      : (m.content as ContentPart[])
          .map((p) => p.type === 'text' ? p.text : '[이미지 첨부]')
          .join('\n'),
  }))

  let fullContent = ''

  try {
    switch (provider) {
      case 'anthropic': {
        const { streamCompletion } = await import('./providers/anthropic')
        await streamCompletion(apiKey, model, systemPrompt, simpleMessages, (chunk) => {
          if (!signal.aborted) fullContent += chunk
        })
        break
      }
      case 'openai': {
        const { streamCompletion } = await import('./providers/openai')
        await streamCompletion(apiKey, model, systemPrompt, simpleMessages, (chunk) => {
          if (!signal.aborted) fullContent += chunk
        })
        break
      }
      case 'gemini': {
        const { streamCompletion } = await import('./providers/gemini')
        await streamCompletion(apiKey, model, systemPrompt, simpleMessages, (chunk) => {
          if (!signal.aborted) fullContent += chunk
        })
        break
      }
      case 'grok': {
        const { streamCompletion } = await import('./providers/grok')
        await streamCompletion(apiKey, model, systemPrompt, simpleMessages, (chunk) => {
          if (!signal.aborted) fullContent += chunk
        })
        break
      }
      default:
        return { content: `지원하지 않는 제공자입니다: ${provider}`, isError: true }
    }

    if (signal.aborted) {
      return { content: '요청이 취소되었습니다.', isError: true }
    }

    return { content: fullContent, isError: false }
  } catch (err) {
    if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      return { content: '요청이 취소되었습니다.', isError: true }
    }
    const message = err instanceof Error ? err.message : '알 수 없는 오류가 발생했습니다.'
    return { content: message, isError: true }
  }
}

// ── Main Debate Engine ────────────────────────────────────────────────────────

export async function runDebate(
  config: DiscussionConfig,
  callbacks: DebateCallbacks,
  signal: AbortSignal,
): Promise<void> {
  let consecutiveErrors = 0
  const providersFirstCallDone = new Set<string>()

  const isBattleMode = config.mode === 'battle' && !!config.judgeProvider
  const turnParticipants = isBattleMode
    ? config.selectedProviders.filter((p) => p !== config.judgeProvider)
    : config.selectedProviders

  const getRoleName = (provider: string): string | undefined => {
    if (config.mode === 'battle' && config.judgeProvider === provider) return '심판'
    if (config.mode === 'roleAssignment' || config.mode === 'battle') {
      const rc = config.roles.find((r) => r.provider === provider)
      if (rc?.role && rc.role !== '중립') return rc.role
    }
    return undefined
  }

  callbacks.onStatusChange('running')

  for (let round = 1; round <= config.maxRounds; round++) {
    // ── Debater turns ──
    for (let turnIndex = 0; turnIndex < turnParticipants.length; turnIndex++) {
      if (signal.aborted) return
      if (!await waitWhilePaused(callbacks, signal)) return

      const provider = turnParticipants[turnIndex]!

      callbacks.onRoundChange(round, turnIndex)
      callbacks.onLoadingChange(provider)

      const isFirstCall = !providersFirstCallDone.has(provider)
      const systemPrompt = buildSystemPrompt(config, provider)
      const apiMessages = buildApiMessages(
        callbacks.getMessages(),
        provider,
        config.referenceFiles,
        isFirstCall,
      )

      const response = await callDebateProvider(provider, systemPrompt, apiMessages, signal)

      if (signal.aborted) return
      callbacks.onLoadingChange(null)

      const message: DiscussionMessage = {
        id: generateId(),
        provider: provider as DiscussionParticipantId,
        content: response.content,
        round,
        timestamp: Date.now(),
        error: response.isError ? response.content : undefined,
        roleName: getRoleName(provider),
      }

      callbacks.onMessage(message)

      if (!response.isError) {
        providersFirstCallDone.add(provider)
      }

      if (response.isError) {
        consecutiveErrors++
        if (consecutiveErrors >= 2) {
          callbacks.onStatusChange('paused')
          if (!await waitWhilePaused(callbacks, signal)) return
          consecutiveErrors = 0
        }
      } else {
        consecutiveErrors = 0
      }

      if (!await doPacing(config, callbacks, signal)) return
    }

    // ── Judge turn (battle mode only) ──
    if (isBattleMode && config.judgeProvider) {
      if (signal.aborted) return
      if (!await waitWhilePaused(callbacks, signal)) return

      const judgeProvider = config.judgeProvider

      callbacks.onLoadingChange(judgeProvider)

      const judgeSystemPrompt = buildSystemPrompt(config, judgeProvider)
      const judgeMessages = buildJudgeApiMessages(
        callbacks.getMessages(),
        round,
        judgeProvider,
      )

      const judgeResponse = await callDebateProvider(judgeProvider, judgeSystemPrompt, judgeMessages, signal)

      if (signal.aborted) return
      callbacks.onLoadingChange(null)

      const judgeMessage: DiscussionMessage = {
        id: generateId(),
        provider: judgeProvider as DiscussionParticipantId,
        content: judgeResponse.content,
        round,
        timestamp: Date.now(),
        error: judgeResponse.isError ? judgeResponse.content : undefined,
        messageType: 'judge-evaluation',
        roleName: '심판',
      }

      callbacks.onMessage(judgeMessage)

      if (!judgeResponse.isError) {
        providersFirstCallDone.add(judgeProvider)
      }

      if (judgeResponse.isError) {
        consecutiveErrors++
        if (consecutiveErrors >= 2) {
          callbacks.onStatusChange('paused')
          if (!await waitWhilePaused(callbacks, signal)) return
          consecutiveErrors = 0
        }
      } else {
        consecutiveErrors = 0
      }

      if (!await doPacing(config, callbacks, signal)) return
    }
  }

  callbacks.onLoadingChange(null)
  callbacks.onStatusChange('completed')
}
