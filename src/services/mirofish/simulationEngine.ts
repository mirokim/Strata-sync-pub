/**
 * simulationEngine.ts — OASIS 기반 MiroFish 핵심 시뮬레이션 루프
 *
 * LocalZep + SocialGraph + OASISEnvironment를 결합하여
 * OASIS 소셜 시뮬레이션 파이프라인을 순수 TypeScript로 실행합니다.
 *
 * 컴포넌트:
 *   LocalZepClient    — 에이전트 메모리 (Zep Cloud 로컬 대체)
 *   SocialGraph       — Barabási-Albert 팔로우 네트워크
 *   OASISEnvironment  — 포스트 저장소 + 추천 엔진 + 행동 결정
 */

import { getProviderForModel, MODEL_OPTIONS } from '@/lib/modelConfig'
import { getApiKey } from '@/stores/settingsStore'
import { LocalZepClient } from './localZep'
import { SocialGraph } from './socialGraph'
import { OASISEnvironment } from './oasisEnvironment'
import type { OASISPost } from './oasisEnvironment'
import type { MirofishPersona, MirofishPost, MirofishSimulationConfig } from './types'
import type { Attachment } from '@/types'

export interface SimulationProgressEvent {
  type: 'post-start' | 'post-chunk' | 'post-done' | 'round-done'
  round?: number
  personaId?: string
  personaName?: string
  stance?: MirofishPersona['stance']
  chunk?: string
  post?: MirofishPost
}

/**
 * 페르소나 수 × 라운드 수 기반 동적 딜레이 계산.
 * 예상 총 LLM 호출이 많을수록 간격을 늘려 rate limit 방지.
 * activityLevel 평균 0.65 적용, 목표 최대 40 RPM.
 */
function calcCallDelay(numPersonas: number, numRounds: number): number {
  const total = numPersonas * numRounds * 0.65
  if (total <= 15)  return 200    // 소규모: 200ms (~18 RPM 이하)
  if (total <= 40)  return 600    // 중규모: 600ms (~6 RPM 이하)
  if (total <= 100) return 1200   // 대규모: 1.2초 (~3 RPM 이하)
  return 1500                     // 초대규모: 1.5초 (40 RPM 캡)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

// ── 프롬프트 빌더 ─────────────────────────────────────────────────────────────

function buildPersonaPrompt(
  persona: MirofishPersona,
  topic: string,
  memoryContext: string,
  recommendedPosts: OASISPost[],
  round: number,
  context?: string,
  actionType: 'post' | 'repost' = 'post',
  repostTarget?: OASISPost,
): { system: string; user: string } {
  const ctxBlock  = context       ? `\n\n[배경 정보 — 아래 문서에 명시된 내용만 언급할 것. 문서에 없는 기능·시스템을 지어내지 말 것]\n${context}` : ''
  const memBlock  = memoryContext ? `\n\n[나의 이전 발언]\n${memoryContext}` : ''

  const feedCtx = recommendedPosts.length
    ? recommendedPosts.slice(-8).map(p =>
        `[${p.authorName}${p.originalPostId ? ' ↩️' : ''}] ${p.content}`
      ).join('\n')
    : '(아직 게시물이 없습니다)'

  const actionInstruction = actionType === 'repost' && repostTarget
    ? (
        `다음 게시물을 리포스트하면서 1-2문장으로 짧게 코멘트를 추가하세요:\n` +
        `"${repostTarget.content}" — ${repostTarget.authorName}`
      )
    : (
        `위 논의를 바탕으로 당신의 관점에서 2-3문장으로 새 게시물을 작성하세요. ` +
        `피드에 특정 참여자의 의견이 있다면 "@이름" 형식으로 직접 언급하거나 인용하며 반응하세요. ` +
        `자연스럽게 논쟁하거나 공감을 표현하세요.\n\n` +
        `답변 맨 앞에 감정 강도 태그를 반드시 달아주세요: "[강도:1]"(미온적) ~ "[강도:5]"(매우 강렬).\n` +
        `만약 다른 참여자의 설득력 있는 주장으로 인해 당신의 입장이 바뀌었다면, ` +
        `강도 태그 다음에 "[입장변화:supportive]", "[입장변화:opposing]", "[입장변화:neutral]" 중 하나를 추가하세요. ` +
        `입장이 그대로라면 입장변화 태그는 달지 마세요.`
      )

  return {
    system: persona.systemPrompt,
    user:
      `주제: "${topic}"${ctxBlock}${memBlock}\n\n` +
      `현재 라운드: ${round}\n\n` +
      `[팔로잉 피드 + 트렌딩]\n${feedCtx}\n\n` +
      actionInstruction,
  }
}

// ── 메인 시뮬레이션 루프 ──────────────────────────────────────────────────────

export async function runSimulation(
  config: MirofishSimulationConfig,
  onEvent: (event: SimulationProgressEvent) => void,
  signal: AbortSignal,
): Promise<MirofishPost[]> {
  const { topic, numRounds, modelId, context } = config
  // 원본 config.personas를 변이시키지 않도록 깊은 복사
  const personas = config.personas.slice(0, config.numPersonas).map(p => ({ ...p }))

  // 직접 전달 이미지 → Attachment 배열로 변환 (streamCompletion 형식)
  const imageAttachments: Attachment[] = (config.images ?? []).map((img, i) => ({
    id: `sim-img-${i}`,
    name: `image-${i}`,
    type: 'image' as const,
    mimeType: img.mediaType,
    dataUrl: `data:${img.mediaType};base64,${img.data}`,
    size: Math.round(img.data.length * 0.75), // base64 → 바이트 근사값
  }))

  // ── OASIS 컴포넌트 초기화 ──────────────────────────────────────────────────
  const callDelayMs = calcCallDelay(personas.length, numRounds)
  const zep   = new LocalZepClient()
  const graph = SocialGraph.generate(personas.map(p => p.id))
  const env   = new OASISEnvironment(graph)

  const provider = getProviderForModel(modelId)
  const apiKey   = provider ? getApiKey(provider) : null
  const model    = MODEL_OPTIONS.find(m => m.id === modelId)

  const feed: MirofishPost[] = []

  for (let round = 1; round <= numRounds; round++) {
    if (signal.aborted) break

    // 모든 페르소나가 매 라운드 반응 — 사용자가 지정한 인원수만큼 전원 피드 생성
    const activePersonas = personas.filter(p => !signal.aborted)

    for (const persona of activePersonas) {
      if (signal.aborted) break

      // ── 행동 결정 (OASIS action_space) ──────────────────────────────────
      const decision = env.decideAction(persona.id)

      if (decision.action === 'do_nothing') continue

      if (decision.action === 'like' && decision.targetPostId) {
        env.likePost(persona.id, decision.targetPostId)
        const liked = env.getPost(decision.targetPostId)
        if (liked) {
          await zep.add(persona.id, [{
            role: 'user',
            content: `[좋아요] ${liked.authorName}: ${liked.content.slice(0, 80)}`,
          }])
        }
        continue
      }

      if (decision.action === 'follow' && decision.targetAgentId) {
        graph.follow(persona.id, decision.targetAgentId)
        continue
      }

      // ── post / repost → LLM 스트리밍 호출 ─────────────────────────────
      const memory      = await zep.get(persona.id)
      const recommended = env.getRecommendedPosts(persona.id)
      const repostTarget = decision.action === 'repost' && decision.targetPostId
        ? env.getPost(decision.targetPostId)
        : undefined

      onEvent({
        type: 'post-start', round,
        personaId: persona.id, personaName: persona.name, stance: persona.stance,
      })

      let content = ''

      if (apiKey && model && provider) {
        const { system, user } = buildPersonaPrompt(
          persona, topic, memory.context, recommended, round,
          context, decision.action as 'post' | 'repost', repostTarget,
        )
        const messages = [{ role: 'user' as const, content: user }]

        // onEvent 콜백 예외가 streamCompletion을 중단시키지 않도록 래핑
        const safeChunk = (chunk: string) => {
          content += chunk
          try { onEvent({ type: 'post-chunk', personaId: persona.id, chunk }) } catch { /* UI 콜백 오류 무시 */ }
        }

        try {
          switch (model.provider) {
            case 'anthropic': {
              const { streamCompletion } = await import('../providers/anthropic')
              await streamCompletion(apiKey, modelId, system, messages, safeChunk, imageAttachments, undefined, signal)
              break
            }
            case 'openai': {
              const { streamCompletion } = await import('../providers/openai')
              await streamCompletion(apiKey, modelId, system, messages, safeChunk, imageAttachments, undefined, signal)
              break
            }
            case 'gemini': {
              const { streamCompletion } = await import('../providers/gemini')
              await streamCompletion(apiKey, modelId, system, messages, safeChunk, imageAttachments, undefined, signal)
              break
            }
            case 'grok': {
              const { streamCompletion } = await import('../providers/grok')
              await streamCompletion(apiKey, modelId, system, messages, safeChunk, undefined, undefined, signal)
              break
            }
            default:
              content = `[${persona.name}의 시뮬레이션 반응 — API 키 필요]`
          }
        } catch (err) {
          console.error(`[simulationEngine] ${persona.name} LLM 오류:`, err)
          content = `(오류: ${err instanceof Error ? err.message : '알 수 없는 오류'})`
        }
      } else {
        content = '[API 키가 없어 시뮬레이션을 실행할 수 없습니다]'
      }

      // ── 감정 강도 파싱 ────────────────────────────────────────────────
      let intensity: number | undefined
      const intensityMatch = content.match(/\[강도:([1-5])\]/i)
      if (intensityMatch) {
        intensity = parseInt(intensityMatch[1], 10)
        content = content.replace(intensityMatch[0], '').trim()
      }

      // ── Stance evolution 감지 ─────────────────────────────────────────
      // LLM이 [입장변화:xxx] 태그를 붙인 경우 persona.stance를 갱신
      const VALID_STANCES = ['supportive', 'opposing', 'neutral', 'observer'] as const
      type StanceType = typeof VALID_STANCES[number]
      let stanceShifted = false
      let prevStance: StanceType | undefined
      const stanceTagMatch = content.match(/\[입장변화:(supportive|opposing|neutral|observer)\]/i)
      if (stanceTagMatch) {
        const newStance = stanceTagMatch[1].toLowerCase() as StanceType
        if (newStance !== persona.stance) {
          prevStance = persona.stance as StanceType
          persona.stance = newStance
          stanceShifted = true
        }
        // 태그 자체는 content에서 제거
        content = content.replace(stanceTagMatch[0], '').trim()
      }

      // ── 환경 업데이트 ──────────────────────────────────────────────────
      // 피드 항목 길이 제한: 최대 280자, 문장 경계에서 자름
      let trimmed = content.trim()
      if (trimmed.length > 280) {
        const cut = trimmed.slice(0, 280)
        const lastPunct = Math.max(cut.lastIndexOf('.'), cut.lastIndexOf('!'), cut.lastIndexOf('?'), cut.lastIndexOf('。'), cut.lastIndexOf('다'))
        trimmed = lastPunct > 100 ? cut.slice(0, lastPunct + 1) : cut.trimEnd() + '…'
      }
      const oasisPost = env.addPost(
        persona.id, persona.name, persona.stance,
        trimmed, round, repostTarget?.id,
        persona.influenceWeight ?? 0.5,
      )
      if (decision.action === 'repost' && repostTarget) {
        oasisPost.reposts.add(persona.id)
        repostTarget.reposts.add(persona.id)
      }

      // Zep 메모리 업데이트
      await zep.add(persona.id, [{ role: 'assistant', content: trimmed }])

      const post: MirofishPost = {
        round,
        personaId:      persona.id,
        personaName:    persona.name,
        stance:         persona.stance,
        ...(stanceShifted && { stanceShifted: true, prevStance }),
        content:        trimmed,
        ...(intensity !== undefined && { intensity }),
        timestamp:      oasisPost.timestamp,
        postId:         oasisPost.id,
        actionType:     decision.action,
        originalPostId: repostTarget?.id,
        likes:          0,
        reposts:        0,
      }
      feed.push(post)
      onEvent({ type: 'post-done', post })

      if (!signal.aborted) await sleep(callDelayMs)
    }

    // 라운드 끝 — 좋아요/리포스트 수 최신화
    for (const post of feed) {
      const oasisPost = post.postId ? env.getPost(post.postId) : undefined
      if (oasisPost) {
        post.likes   = oasisPost.likes.size
        post.reposts = oasisPost.reposts.size
      }
    }

    onEvent({ type: 'round-done', round })
  }

  return feed
}
