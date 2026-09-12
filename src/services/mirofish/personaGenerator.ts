/**
 * personaGenerator.ts — LLM으로 시뮬레이션 페르소나 자동 생성
 *
 * 주제(topic)를 받아 다양한 관점의 페르소나 배열을 JSON으로 반환합니다.
 */

import { getProviderForModel, MODEL_OPTIONS } from '@/lib/modelConfig'
import { getApiKey } from '@/stores/settingsStore'
import type { MirofishPersona } from './types'

const SYSTEM_PROMPT = `
당신은 게임 개발사의 유저 리서치 전문가입니다.
주어진 게임 콘텐츠/기능 주제에 대해 실제 게임 유저 관점의 페르소나를 생성합니다.
반드시 아래 JSON 배열 형식만 출력하세요. 다른 텍스트는 포함하지 마세요.
`.trim()

function buildUserPrompt(topic: string, count: number, context?: string, segment?: string): string {
  const contextBlock = context
    ? `\n\n[참고 문서 — 페르소나 설계 시 이 내용을 반영하세요]\n${context.slice(0, 2000)}`
    : ''
  const segmentBlock = segment
    ? `\n\n타겟 세그먼트: "${segment}" — 이 세그먼트 유저 유형으로만 페르소나를 구성하세요.`
    : ''
  return `
다음 게임 관련 주제에 반응할 유저 페르소나 ${count}개를 JSON 배열로 생성하세요.

주제: "${topic}"${contextBlock}${segmentBlock}

페르소나는 실제 게임 유저여야 합니다. 예시 역할:
코어 게이머, 하드코어 레이더, MMO 장기 유저, PvP 경쟁 유저, 모바일 캐주얼 유저,
스토리 중심 유저, 소셜 길드 유저, F2P 유저, 헤비 과금 유저, 복귀 유저,
스트리머/콘텐츠 크리에이터, 게임 커뮤니티 운영자, 부모(자녀 게이머 대리), 게임 저널리스트

JSON 형식:
[
  {
    "id": "고유ID (영문 snake_case)",
    "name": "페르소나 이름 (한국어, 닉네임 형식)",
    "role": "유저 유형 (영문, 위 예시 참고)",
    "stance": "supportive | opposing | neutral | observer 중 하나",
    "activityLevel": 1.0,
    "influenceWeight": 0.1~1.0 (커뮤니티 영향력 — 스트리머/운영자는 높게, 일반 유저는 낮게),
    "systemPrompt": "이 유저의 게임 플레이 스타일, 주요 관심사, 말투를 3-4문장으로 (한국어). 구체적인 플레이 습관과 불만 포인트 포함."
  }
]

조건:
- stance 분포: supportive 30-40%, opposing 30-40%, neutral/observer 나머지
- 주제와 직접 연관된 유저 유형 우선 선택
- systemPrompt는 실제 커뮤니티 반응처럼 구체적으로
`.trim()
}

/** 한 번의 LLM 호출로 생성할 최대 페르소나 수 (토큰 잘림 방지) */
const BATCH_SIZE = 10

async function generateBatch(
  topic: string,
  batchCount: number,
  modelId: string,
  provider: string,
  apiKey: string,
  existingCount: number,
  context?: string,
  segment?: string,
): Promise<MirofishPersona[]> {
  let fullText = ''
  const messages = [{ role: 'user' as const, content: buildUserPrompt(topic, batchCount, context, segment) }]

  switch (provider) {
    case 'anthropic': {
      const { streamCompletion } = await import('../providers/anthropic')
      await streamCompletion(apiKey, modelId, SYSTEM_PROMPT, messages, c => { fullText += c })
      break
    }
    case 'openai': {
      const { streamCompletion } = await import('../providers/openai')
      await streamCompletion(apiKey, modelId, SYSTEM_PROMPT, messages, c => { fullText += c })
      break
    }
    case 'gemini': {
      const { streamCompletion } = await import('../providers/gemini')
      await streamCompletion(apiKey, modelId, SYSTEM_PROMPT, messages, c => { fullText += c })
      break
    }
    default:
      return []
  }

  const match = fullText.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('JSON 배열 없음')
  const parsed = JSON.parse(match[0]) as MirofishPersona[]
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('빈 배열')

  // 배치 내 ID 중복 방지
  return parsed.map((p, i) => ({ ...p, id: p.id || `persona_${existingCount + i + 1}` }))
}

export async function generatePersonas(
  topic: string,
  count: number,
  modelId: string,
  context?: string,
  segment?: string,
): Promise<MirofishPersona[]> {
  const provider = getProviderForModel(modelId)
  if (!provider) throw new Error(`모델 "${modelId}"에 대한 프로바이더를 찾을 수 없습니다`)

  const apiKey = getApiKey(provider)
  if (!apiKey) throw new Error(`${provider} API 키가 설정되지 않았습니다`)

  const model = MODEL_OPTIONS.find(m => m.id === modelId)
  if (!model) throw new Error(`모델 "${modelId}"을 찾을 수 없습니다`)

  const results: MirofishPersona[] = []
  const seenIds = new Set<string>()
  const MAX_ITERATIONS = 5  // 무한루프 방지

  // count > BATCH_SIZE면 BATCH_SIZE씩 나눠서 생성
  let iterations = 0
  while (results.length < count && iterations < MAX_ITERATIONS) {
    iterations++
    const batchCount = Math.min(BATCH_SIZE, count - results.length)
    const batch = await generateBatch(topic, batchCount, modelId, model.provider, apiKey, results.length, context, segment)

    // 배치 간 ID 중복 제거
    for (const p of batch) {
      if (seenIds.has(p.id)) {
        p.id = `${p.id}_${results.length}`
      }
      seenIds.add(p.id)
      results.push(p)
      if (results.length >= count) break
    }

    if (batch.length < batchCount) break
  }

  if (results.length === 0) throw new Error('페르소나 생성 실패: LLM이 빈 배열을 반환했습니다')
  return results.slice(0, count)
}
