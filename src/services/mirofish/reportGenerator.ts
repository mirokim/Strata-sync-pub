/**
 * reportGenerator.ts — 시뮬레이션 피드를 분석해 마크다운 보고서 생성
 */

import { getProviderForModel, MODEL_OPTIONS } from '@/lib/modelConfig'
import { getApiKey } from '@/stores/settingsStore'
import type { MirofishPost } from './types'

const SYSTEM_PROMPT = `
당신은 시장 조사 및 여론 분석 전문가입니다.
시뮬레이션 피드를 분석하여 통찰력 있는 보고서를 작성합니다.
마크다운 형식으로 체계적으로 작성하세요.
`.trim()

function buildReportPrompt(topic: string, feed: MirofishPost[]): string {
  const feedText = feed
    .map(p => {
      const action = p.actionType === 'repost' ? ' ↩️' : ''
      const shift  = p.stanceShifted ? ` 🔄${p.prevStance}→${p.stance}` : ''
      return `[R${p.round}] [${p.personaName}/${p.stance}${shift}]${action} ${p.content}`
    })
    .join('\n')

  // 라운드별 stance 분포 집계
  const rounds = [...new Set(feed.map(p => p.round))].sort((a, b) => a - b)
  const roundTrend = rounds.map(r => {
    const posts = feed.filter(p => p.round === r)
    const cnt = (s: string) => posts.filter(p => p.stance === s).length
    const total = posts.length
    const pct = (n: number) => total ? Math.round(n / total * 100) : 0
    const sp = cnt('supportive'), op = cnt('opposing'), ne = cnt('neutral'), ob = cnt('observer')
    const shifts = posts.filter(p => p.stanceShifted).length
    return `R${r}: 지지 ${sp}(${pct(sp)}%) / 반대 ${op}(${pct(op)}%) / 중립 ${ne}(${pct(ne)}%) / 관찰 ${ob}(${pct(ob)}%)${shifts ? ` | 입장변화 ${shifts}건` : ''}`
  }).join('\n')

  // 참여 지표 집계
  const engagementMap = new Map<string, { likes: number; reposts: number }>()
  for (const p of feed) {
    if (!engagementMap.has(p.personaName)) {
      engagementMap.set(p.personaName, { likes: 0, reposts: 0 })
    }
    const e = engagementMap.get(p.personaName)!
    e.likes   += p.likes   ?? 0
    e.reposts += p.reposts ?? 0
  }
  const topEngaged = [...engagementMap.entries()]
    .sort((a, b) => (b[1].likes + b[1].reposts) - (a[1].likes + a[1].reposts))
    .slice(0, 10)
    .map(([name, s]) => `- ${name}: 좋아요 ${s.likes}, 리포스트 ${s.reposts}`)
    .join('\n') || '(집계 없음)'

  // 입장 변화 페르소나 목록
  const stanceShifts = feed.filter(p => p.stanceShifted)
    .map(p => `- R${p.round} ${p.personaName}: ${p.prevStance} → ${p.stance}`)
    .join('\n') || '(없음)'

  // 감정 강도 분포
  const intensityPosts = feed.filter(p => p.intensity !== undefined)
  const avgIntensity = intensityPosts.length
    ? (intensityPosts.reduce((s, p) => s + p.intensity!, 0) / intensityPosts.length).toFixed(1)
    : 'N/A'
  const highIntensity = intensityPosts.filter(p => (p.intensity ?? 0) >= 4)
    .map(p => `- [R${p.round}] ${p.personaName}(강도${p.intensity}): ${p.content.slice(0, 60)}…`)
    .slice(0, 5).join('\n') || '(없음)'

  return `
다음 OASIS 소셜 시뮬레이션 결과를 분석하여 보고서를 작성하세요.

주제: "${topic}"

[라운드별 여론 흐름]
${roundTrend}

[입장 변화]
${stanceShifts}

[감정 강도]
평균 강도: ${avgIntensity}/5
강도 4-5 반응:
${highIntensity}

[참여 지표 (상위 10)]
${topEngaged}

[시뮬레이션 피드]
${feedText}

아래 섹션을 포함한 마크다운 보고서를 작성하세요:

## 시뮬레이션 요약
(주제, 참여 페르소나, 총 라운드, 총 게시물 수 등 기본 정보)

## 여론 흐름 분석
(라운드별 지지/반대 비율 변화, 분위기가 어떻게 전개됐는지)

## 주요 합의점
(여러 페르소나가 공통적으로 동의한 내용)

## 핵심 반대 의견
(가장 강하게 제기된 비판이나 우려)

## 주목할 입장 변화
(시뮬레이션 중 입장이 바뀐 페르소나와 그 이유 — 없으면 생략)

## 결론 및 시사점
(이 시뮬레이션 결과가 실제 출시/의사결정에 시사하는 점)
`.trim()
}

export async function generateReport(
  topic: string,
  feed: MirofishPost[],
  modelId: string,
): Promise<string> {
  if (feed.length === 0) return '시뮬레이션 결과가 없습니다.'

  const provider = getProviderForModel(modelId)
  if (!provider) return fallbackReport(topic, feed)

  const apiKey = getApiKey(provider)
  if (!apiKey) return fallbackReport(topic, feed)

  const model = MODEL_OPTIONS.find(m => m.id === modelId)
  if (!model) return fallbackReport(topic, feed)

  const messages = [{ role: 'user' as const, content: buildReportPrompt(topic, feed) }]
  let report = ''

  try {
    switch (model.provider) {
      case 'anthropic': {
        const { streamCompletion } = await import('../providers/anthropic')
        await streamCompletion(apiKey, modelId, SYSTEM_PROMPT, messages, c => { report += c })
        break
      }
      case 'openai': {
        const { streamCompletion } = await import('../providers/openai')
        await streamCompletion(apiKey, modelId, SYSTEM_PROMPT, messages, c => { report += c })
        break
      }
      case 'gemini': {
        const { streamCompletion } = await import('../providers/gemini')
        await streamCompletion(apiKey, modelId, SYSTEM_PROMPT, messages, c => { report += c })
        break
      }
      default:
        return fallbackReport(topic, feed)
    }
    return report || fallbackReport(topic, feed)
  } catch (err) {
    console.error('[reportGenerator] 보고서 생성 실패:', err)
    return fallbackReport(topic, feed)
  }
}

function fallbackReport(topic: string, feed: MirofishPost[]): string {
  const byStance = feed.reduce<Record<string, number>>((acc, p) => {
    acc[p.stance] = (acc[p.stance] ?? 0) + 1
    return acc
  }, {})

  const lines = Object.entries(byStance).map(([s, n]) => `- ${s}: ${n}개`)

  return `## 시뮬레이션 보고서\n\n**주제**: ${topic}\n\n**총 반응 수**: ${feed.length}개\n\n**입장 분포**:\n${lines.join('\n')}`
}
