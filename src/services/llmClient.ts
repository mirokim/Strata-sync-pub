import type { ChatMessage, SpeakerId, DirectorId, Attachment, LoadedDocument, ProviderId } from '@/types'
import { sanitize } from '@/lib/stringUtils'
import type { AnthropicTool, AgentLoopOpts, AgentMsg } from '@/services/agentLoop'
import { runAgentLoop } from '@/services/agentLoop'
import type { ConversionMeta } from '@/lib/mdConverter'
import { logger } from '@/lib/logger'
import { MODEL_OPTIONS, getProviderForModel, WORKER_MODEL_IDS } from '@/lib/modelConfig'
import { PERSONA_PROMPTS, buildProjectContext } from '@/lib/personaPrompts'
import { selectMockResponse } from '@/data/mockResponses'
import { useSettingsStore, getApiKey } from '@/stores/settingsStore'
import { useUsageStore } from '@/stores/usageStore'
import {
  rerankResults,
  frontendKeywordSearch,
  buildDeepGraphContext,
  buildGlobalGraphContext,
  getGlobalContextDocIds,
  tokenizeQuery,
  directVaultSearch,
  getStrippedBody,
  deduplicateVersions,
} from '@/lib/graphRAG'
import { useGraphStore } from '@/stores/graphStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useMemoryStore } from '@/stores/memoryStore'
import { vectorEmbedIndex, isEmbeddingReady, rrfScore } from '@/lib/vectorEmbedIndex'
import { tfidfIndex, getContentDate } from '@/lib/graphAnalysis'

// ── 공통 상수 ─────────────────────────────────────────────────────────────────

/** 텍스트 첨부 파일당 최대 글자수 (~3K 토큰) — streamMessage/streamMessageWithTools 공통 */
const TEXT_ATTACH_MAX = 12000

// ── 대화 히스토리 기반 맥락 보강 ─────────────────────────────────────────────

/** 대명사/지시어 패턴 — 이전 대화 맥락 참조를 나타내는 표현 */
const DEICTIC_RE = /그거|그것|아까|위에서\s*말한|방금|이전에|앞서|아까\s*그|그\s*게임|그\s*문서|그\s*캐릭터|그\s*내용|더\s*자세히|좀\s*더|계속|이어서/

/** 한국어 불용어 — 키워드 추출 시 제외 */
const HISTORY_STOPWORDS = new Set([
  '은', '는', '이', '가', '을', '를', '의', '에', '에서', '로', '으로', '와', '과', '도', '만',
  '좀', '더', '그', '저', '이', '것', '거', '수', '때', '중', '등', '및',
  '해줘', '알려줘', '설명해줘', '말해줘', '뭐야', '뭐', '어떤', '어떻게', '왜', '무엇',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'why', 'and', 'or', 'but',
  '네', '예', '아니', '응', '그래', '좋아', '알겠어',
])

/**
 * 직전 N턴의 user 메시지에서 핵심 명사/키워드를 추출합니다.
 * 현재 메시지에 지시어(그거, 아까, 방금 등)가 포함된 경우에만 호출됩니다.
 */
export function extractContextTerms(history: ChatMessage[], maxTurns = 3): string[] {
  const userMessages = history
    .filter(m => m.role === 'user')
    .slice(-(maxTurns + 1), -1)

  if (userMessages.length === 0) return []

  const terms: string[] = []
  const seen = new Set<string>()

  for (const msg of userMessages) {
    const words = msg.content
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !HISTORY_STOPWORDS.has(w.toLowerCase()))

    for (const w of words) {
      const lower = w.toLowerCase()
      if (!seen.has(lower)) {
        seen.add(lower)
        terms.push(lower)
      }
    }
  }

  return terms
}

function getLastUserIdx(history: ChatMessage[]): number {
  const idxs = history.map((m, i) => m.role === 'user' ? i : -1).filter(i => i >= 0)
  return idxs.length === 0 ? -1 : idxs[idxs.length - 1]
}

/** 사실 준수 지침 블록 — streamMessage/streamMessageWithTools/generateSlackAnswer 공통
 *  citationMode=true  → 볼트 인용 표기 포함
 *  citationMode=false → 검색된 문서 표현만
 */
const FACT_BLOCK_CITATION = '\n\n[사실 준수] 아래 지침을 반드시 따르세요:\n1. 답변은 오직 볼트에서 검색된 문서, 웹 검색 결과, 또는 사용자가 직접 말한 내용만을 근거로 합니다.\n2. 문서에 명시되지 않은 사실은 절대 추측하거나 만들어내지 마세요. 불확실하면 "해당 내용은 검색된 문서에서 확인되지 않습니다"라고 명시하세요.\n3. 볼트 문서를 언급할 때는 "검색된 문서" 또는 "볼트 문서"라고 표현하세요.\n4. 볼트 인용문 외 내용을 추론할 때는 반드시 문장 끝에 **(추론)** 을 표시하세요.'
const FACT_BLOCK_NO_CITATION = '\n\n[사실 준수] 아래 지침을 반드시 따르세요:\n1. 답변은 오직 볼트에서 검색된 문서, 웹 검색 결과, 또는 사용자가 직접 말한 내용만을 근거로 합니다.\n2. 문서에 명시되지 않은 사실은 절대 추측하거나 만들어내지 마세요. 불확실하면 "해당 내용은 검색된 문서에서 확인되지 않습니다"라고 명시하세요.\n3. RAG로 자동 검색된 볼트 문서를 언급할 때는 "제공해주신 문서"가 아닌 "검색된 문서" 또는 "볼트 문서"라고 표현하세요.'

// ── Obsidian MD conversion (MD 변환 에디터 파이프라인) ─────────────────────────

/**
 * Convert raw text to an Obsidian-compatible Markdown document using Claude.
 *
 * Output format:
 *   KEYWORDS: kw1, kw2, ...
 *   (blank line)
 *   ---
 *   (frontmatter + body)
 *
 * Falls back to a simple template if no API key is configured.
 *
 * @param rawContent  The raw text to convert
 * @param meta        Document metadata (title, speaker, date, type)
 * @param onChunk     Called with each streamed token
 */
export async function convertToObsidianMD(
  rawContent: string,
  meta: ConversionMeta,
  onChunk: (chunk: string) => void
): Promise<void> {
  const { personaModels } = useSettingsStore.getState()
  const mainModelId = personaModels['chief_director']
  const { modelId, provider } = getWorkerModelId(mainModelId)

  const fallbackOutput = [
    `KEYWORDS: ${meta.title}, ${meta.type}`,
    '',
    '---',
    `speaker: ${meta.speaker}`,
    `date: ${meta.date}`,
    `tags: [${meta.type}]`,
    `type: ${meta.type}`,
    `---`,
    '',
    `## ${meta.title}`,
    '',
    rawContent,
  ].join('\n')

  if (!provider) {
    onChunk(fallbackOutput)
    return
  }

  const apiKey = getApiKey(provider)

  if (!apiKey) {
    onChunk(fallbackOutput)
    return
  }

  const systemPrompt =
    '당신은 게임 개발 스튜디오의 지식 관리 전문가입니다. ' +
    '원문 텍스트를 분석하고 Obsidian 마크다운 형식으로 구조화합니다.'

  const userMessage =
    `다음 텍스트를 Obsidian 마크다운으로 변환해주세요.\n\n` +
    `반드시 아래 형식을 정확히 따르세요:\n` +
    `1. 첫 줄: KEYWORDS: 키워드1, 키워드2, 키워드3 (핵심 키워드 5~10개, 쉼표 구분)\n` +
    `2. 빈 줄\n` +
    `3. 구분선: ---\n` +
    `4. Obsidian frontmatter:\n` +
    `---\n` +
    `speaker: ${meta.speaker}\n` +
    `date: ${meta.date}\n` +
    `tags: [${meta.type}, 키워드1, 키워드2]\n` +
    `type: ${meta.type}\n` +
    `---\n` +
    `5. ## ${meta.title}\n` +
    `6. 각 핵심 키워드를 ## 소제목으로 사용하여 관련 내용 정리\n\n` +
    `제목: ${meta.title}\n유형: ${meta.type}\n\n원문:\n${rawContent}`

  const messages = [{ role: 'user' as const, content: sanitize(userMessage) }]

  try {
    const { streamCompletion } = await importProvider(provider)
    await streamCompletion(apiKey, modelId, sanitize(systemPrompt), messages, onChunk)
  } catch (e) {
    console.warn('[llmClient] convertToObsidianMD API 호출 실패 — 폴백 사용:', e)
    onChunk(fallbackOutput)
  }
}

// ── Provider dispatch helper ───────────────────────────────────────────────────

/**
 * 프로바이더 모듈을 동적 import합니다.
 * 템플릿 리터럴 대신 switch로 분기하여 Vite 번들러가 청크를 정적 분석할 수 있도록 합니다.
 */
async function importProvider(provider: string) {
  switch (provider) {
    case 'anthropic': return import('./providers/anthropic')
    case 'openai':    return import('./providers/openai')
    case 'gemini':    return import('./providers/gemini')
    case 'grok':      return import('./providers/grok')
    default: throw new Error(`Unknown provider: ${provider}`)
  }
}

// ── Message history conversion ─────────────────────────────────────────────────

function toHistoryMessages(
  history: ChatMessage[]
): { role: 'user' | 'assistant'; content: string }[] {
  return history
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
}

// ── Fallback mock stream ───────────────────────────────────────────────────────

/** Emit the mock response character-by-character with a small delay to simulate streaming */
async function streamMockResponse(
  persona: SpeakerId,
  userMessage: string,
  onChunk: (chunk: string) => void
): Promise<void> {
  const mock = selectMockResponse(persona, userMessage)
  const prefix = '[Mock] '
  const fullText = prefix + mock

  // Emit in small word-sized chunks to feel like streaming
  const words = fullText.split(' ')
  for (let i = 0; i < words.length; i++) {
    const chunk = (i === 0 ? '' : ' ') + words[i]
    onChunk(chunk)
    await new Promise<void>((r) => setTimeout(r, 30 + Math.random() * 20))
  }
}

// ── Graph-Augmented RAG context fetcher ──────────────────────────────────────

/**
 * Fetch relevant document chunks from ChromaDB and enhance with graph context.
 *
 * Pipeline:
 *   1. Fetch top-8 candidates from ChromaDB (over-fetch for reranking headroom)
 *   2. Filter by minimum similarity score (> 0.3)
 *   3. Rerank by keyword overlap + speaker affinity → top 3
 *   4. Expand with graph-connected neighbor sections (wiki-link traversal)
 *   5. Format into compressed, token-efficient context string
 *
 * Failure is always non-fatal — the LLM call continues without RAG context.
 *
 * @param userMessage    The user's query text
 * @param currentSpeaker Optional current persona for speaker affinity boost
 */
/**
 * 전체 탐색 인텐트를 감지하는 패턴.
 * 이 패턴이 매칭되면 허브 노드 기반 전체 그래프 탐색으로 전환.
 */
const GLOBAL_INTENT_RE = /(?:^|\s)(전체적인|전반적|총체적|프로젝트\s*전체|전체\s*인사이트|전체\s*피드백|모든\s*문서|big.?picture|overview)(?:\s|[?.!,]|$)|^전체\s*$|^전반\s*$/i

/** 웹 검색 인텐트 패턴 — "인터넷 검색"이라고 명시적으로 요청할 때만 */
const WEB_SEARCH_INTENT_RE = /인터넷\s*검색/i

/**
 * 최신 정보 요청 인텐트 패턴.
 * 매칭 시 TF-IDF 시드를 날짜 역순으로 재정렬하고 컨텍스트에 날짜 경고 주입.
 */
const RECENCY_INTENT_RE = /최신|최근|요즘|이번\s*달|이번\s*주|오늘|지금|현재|방금|가장\s*새|latest|recent|진행\s*방향|진행\s*상황|진행\s*현황|현재\s*상태|현황|어떻게\s*됐|어떻게\s*되고|어디까지|어떤\s*상태|업데이트|최신화/i

// ── Domain classification for 2-team sub-agent architecture ──────────────────

/** 내러티브/캐릭터 도메인 키워드 */
const NARRATIVE_DOMAIN_RE = /캐릭터|스토리|세계관|나레이션|설정|배경|인물|페르소나|persona|character|story|world|narrative|lore|plot|캐릭터설정|케릭터/i
/** 시스템/게임플레이 도메인 키워드 */
const SYSTEM_DOMAIN_RE = /게임플레이|시스템|메카닉|스펙|밸런스|UI|UX|기술|아트|사운드|gameplay|mechanic|spec|balance|tech|art|sound|data|점령전|난투전|전투|combat|level|레벨|버그|패치|수치|공식|계산/i

function classifyDocDomain(doc: LoadedDocument): 'narrative' | 'system' | 'general' {
  const text = [doc.filename, doc.tags?.join(' ') ?? '', doc.speaker ?? ''].join(' ')
  if (NARRATIVE_DOMAIN_RE.test(text)) return 'narrative'
  if (SYSTEM_DOMAIN_RE.test(text)) return 'system'
  return 'general'
}

/**
 * 서브 에이전트: 도메인별 워커 요약본들을 하나의 관점 인사이트로 합성합니다.
 * onChunk가 제공되면 실시간 스트리밍.
 */
async function agentSynthesizeDomain(
  workerSummaries: string[],
  query: string,
  domain: 'narrative' | 'system',
  apiKey: string,
  provider: string,
  workerModelId: string,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  if (workerSummaries.length === 0) return ''
  const domainName = domain === 'narrative' ? '내러티브/캐릭터' : '시스템/게임플레이'
  const sysPrompt =
    `당신은 ${domainName} 전문 서브 에이전트입니다. ` +
    `아래 워커 요약들을 바탕으로 "${domainName}" 관점의 핵심 인사이트를 200자 이내로 합성하세요. ` +
    `사람이 놓치기 쉬운 연결고리나 함의를 우선 포함하세요. 인사이트 텍스트만 출력하세요.`
  const content = `질문: ${query}\n\n워커 요약:\n${workerSummaries.join('\n---\n').slice(0, 4000)}`
  let result = ''
  try {
    const { streamCompletion } = await importProvider(provider)
    await streamCompletion(
      apiKey, workerModelId, sysPrompt,
      [{ role: 'user' as const, content: sanitize(content) }],
      (c: string) => { result += c; onChunk?.(c) },
    )
  } catch (e) {
    console.warn('[llmClient] agentSynthesizeDomain API 호출 실패 — 빈 결과 반환:', e)
    result = ''
  }
  return result.trim()
}

// ── Search Quality Helpers ────────────────────────────────────────────────────

/**
 * Query Expansion: LLM(Haiku)으로 검색 쿼리를 의미적으로 확장합니다.
 * 짧거나 모호한 한국어 쿼리에 관련 키워드를 보완해 벡터 검색 정확도를 높입니다.
 * API 오류 시 원본 쿼리 반환.
 */
export async function expandQueryWithLLM(query: string, apiKey: string): Promise<string> {
  let result = ''
  try {
    const { streamCompletion } = await import('./providers/anthropic')
    await streamCompletion(
      apiKey, WORKER_MODEL_IDS.anthropic,
      '검색 쿼리 확장 전문가입니다. 입력 쿼리와 의미적으로 관련된 핵심 키워드를 2~3개 추가해 하나의 자연스러운 문장으로 만드세요. 원본 쿼리의 핵심 의미를 유지하면서 동의어, 관련 개념을 포함하세요. 텍스트만 출력하세요.',
      [{ role: 'user' as const, content: query }],
      (c: string) => { result += c },
    )
  } catch (e) {
    console.warn('[llmClient] expandQueryWithLLM API 호출 실패 — 원본 쿼리 사용:', e)
    return query
  }
  return result.trim() || query
}

/**
 * 리랭커에 넘길 후보 스니펫 길이.
 * 이 볼트의 YAML 프론트매터 중앙값이 239자, 74.9%가 200자를 넘는다 —
 * 200자 스니펫은 대다수 문서에서 본문을 한 글자도 담지 못했다.
 */
const RERANK_SNIPPET_CHARS = 600

/**
 * 방어적 프론트매터 제거.
 * 호출부는 getStrippedBody()로 본문만 주입하지만, 외부 호출자가 원본을 넘길 수 있으므로
 * 리랭커 안에서도 YAML 헤더를 한 번 더 걷어낸다. (indexOf 기반 — ReDoS 방지)
 */
function stripYamlFrontmatter(text: string): string {
  const t = text.trimStart()
  if (!t.startsWith('---')) return text
  const closeIdx = t.indexOf('\n---', 3)
  if (closeIdx < 0) return text
  return t.slice(closeIdx + 4).trimStart()
}

/**
 * LLM Re-ranking: Haiku로 벡터 검색 후보들의 쿼리 관련성을 재평가합니다.
 * 각 후보를 0–10으로 채점하고, 벡터 점수(40%)와 LLM 점수(60%)를 혼합합니다.
 * API 오류 시 원본 순서 유지.
 *
 * ※ 혼합 비율상 c.score는 0~1 스케일이어야 의미가 있습니다.
 *   RRF 원점수(≈0.03)를 그대로 넘기면 벡터 기여가 사라지므로 호출부에서 max 정규화할 것.
 */
export async function llmRerankCandidates<T extends { doc_id: string; score: number; filename?: string; rawContent?: string; content?: string }>(
  query: string,
  candidates: T[],
  apiKey: string,
  topN: number,
): Promise<T[]> {
  if (candidates.length === 0) return candidates
  const pool = candidates.slice(0, 20)
  const list = pool.map((c, i) => {
    const body = stripYamlFrontmatter((c.rawContent ?? c.content) || '').trim()
    return `[${i}] ${c.filename ?? c.doc_id}: ${body.slice(0, RERANK_SNIPPET_CHARS)}`
  }).join('\n')
  let result = ''
  try {
    const { streamCompletion } = await import('./providers/anthropic')
    await streamCompletion(
      apiKey, WORKER_MODEL_IDS.anthropic,
      '각 문서의 쿼리 관련성을 0–10으로 평가하세요. 반드시 "인덱스:점수" 쌍을 쉼표로 구분해 출력하세요. 예: 0:8,1:3,2:9. 다른 텍스트 없이 이 형식만 출력하세요.',
      [{ role: 'user' as const, content: `쿼리: ${query}\n\n문서 목록:\n${list}` }],
      (c: string) => { result += c },
    )
  } catch (e) {
    console.warn('[llmClient] rerankWithLLM API 호출 실패 — 원본 순서 유지:', e)
    return candidates.slice(0, topN)
  }
  const scores = new Map<number, number>()
  for (const part of result.split(',')) {
    const [a, b] = part.trim().split(':')
    const idx = parseInt(a, 10); const score = parseFloat(b)
    if (!isNaN(idx) && !isNaN(score)) scores.set(idx, score / 10)
  }
  const reranked = pool.map((c, i) => ({
    ...c,
    score: c.score * 0.4 + (scores.get(i) ?? 0.5) * 0.6,
  }))
  reranked.sort((a, b) => b.score - a.score)
  return [...reranked, ...candidates.slice(20)].sort((a, b) => b.score - a.score).slice(0, topN) as T[]
}

/**
 * 태그 매칭에서 제외할 과도하게 일반적인 태그.
 * 볼트 전반(수백 문서)에 붙어 있어 하드 필터의 근거가 되기엔 신호가 너무 약하다.
 */
const GENERIC_FILTER_TAGS = new Set([
  '작업', '작업관리', '문서', '회의', '기타', '일반', '내용', '정리', '기록', '메모', '자료', '설정', '배경',
  'doc', 'docs', 'note', 'notes', 'misc', 'general', 'etc',
  'spec', 'type', 'game', 'art', 'world', 'data', 'jira', 'epic', 'tech', 'chief', 'guide',
])

/** 태그 하드 필터를 허용할 최소 태그 길이 — "작업"(2자) 같은 광범위 태그 차단 */
const MIN_FILTER_TAG_LEN = 3

/** 한국어 조사 — 토큰 어간 추출용 */
const KO_PARTICLE_RE = /(을|를|이|가|은|는|의|에서|에게|에|으로|로|와|과|도|만|랑|이랑|처럼|보다)$/u

/**
 * 쿼리를 토큰 경계 단위로 분해합니다.
 * 부분문자열 매칭(q.includes(tag))은 "개발실무" 안의 "개발실"처럼 엉뚱한 태그를 잡아내므로,
 * 단어 경계로 자른 토큰 + 조사 제거 어간만 매칭 대상으로 씁니다.
 */
function queryTokenSet(query: string): Set<string> {
  const words = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean)
  const out = new Set<string>(words)
  for (const w of words) {
    const stem = w.replace(KO_PARTICLE_RE, '')
    if (stem.length >= 2) out.add(stem)
  }
  return out
}

/**
 * speaker id → 쿼리에 실제로 등장할 법한 호칭 (PERSONA_TAG_MAP 역방향).
 * 기존 코드는 q.includes('chief_director') 형태라 사용자 쿼리에 절대 매칭되지 않는 죽은 코드였다.
 * 비교 시 쿼리의 공백을 제거하므로 "아트 디렉터" / "아트디렉터" 모두 매칭된다.
 */
const SPEAKER_QUERY_ALIASES: Record<string, string[]> = {
  chief_director: ['총괄디렉터', '총괄디렉타', 'pm', '총괄'],
  art_director:   ['아트디렉터', '아트디렉타', 'artdirector'],
  plan_director:  ['기획디렉터', '기획디렉타', '기획총괄'],
  level_director: ['레벨디렉터', '레벨디렉타'],
  prog_director:  ['프로그래밍디렉터', '개발디렉터', '테크디렉터', '프로그래밍디렉타'],
}

/**
 * Metadata Filter: 쿼리에서 화자(speaker)/태그를 감지해 docs를 사전 필터링합니다.
 *
 * 이 필터는 이후 벡터 검색의 후보 풀 자체를 잘라내므로 오탐지 비용이 매우 큽니다.
 * 안전장치 3중:
 *   1) 토큰 경계 매칭 (부분문자열 금지)
 *   2) 태그 최소 3자 + 일반 태그 제외
 *   3) 필터 결과 하한 = max(50, 전체의 5%) — 미달 시 전체 docs로 폴백
 */
export function applyMetadataFilter<T extends { speaker?: string; tags?: string[] }>(
  query: string,
  docs: T[],
): T[] {
  if (docs.length === 0) return docs

  const qTokens = queryTokenSet(query)
  const qCompact = query.toLowerCase().replace(/\s+/g, '')

  // ── 화자 감지 (호칭 별칭 역매핑 + 이름형 화자는 토큰 일치) ──────────────
  const speakerSet = new Set(docs.map(d => d.speaker).filter(Boolean) as string[])
  const matchedSpeakers = new Set(
    [...speakerSet].filter(s => {
      const lower = s.toLowerCase()
      if (lower === 'unknown') return false
      if (qTokens.has(lower)) return true
      return SPEAKER_QUERY_ALIASES[lower]?.some(a => qCompact.includes(a)) ?? false
    })
  )

  // ── 태그 감지 (토큰 경계 + 최소 길이 + 일반 태그 제외) ─────────────────
  const tagSet = new Set(docs.flatMap(d => d.tags ?? []).map(t => t.toLowerCase()))
  const matchedTags = new Set(
    [...tagSet].filter(t =>
      t.length >= MIN_FILTER_TAG_LEN && !GENERIC_FILTER_TAGS.has(t) && qTokens.has(t)
    )
  )

  if (matchedSpeakers.size === 0 && matchedTags.size === 0) return docs

  const filtered = docs.filter(d => {
    if (d.speaker && matchedSpeakers.has(d.speaker)) return true
    if (d.tags?.some(t => matchedTags.has(t.toLowerCase()))) return true
    return false
  })

  // 하한: 짧은 태그 하나로 볼트를 잘라내지 않도록 크게 잡는다.
  // (2,635문서 볼트 → 132개 미만이면 필터를 포기하고 전체를 넘김)
  const floor = Math.max(50, Math.ceil(docs.length * 0.05))
  if (filtered.length < floor) return docs

  logger.debug(`[RAG] 메타데이터 필터: ${docs.length} → ${filtered.length}개 (태그: ${[...matchedTags].join(', ') || '-'}, 화자: ${[...matchedSpeakers].join(', ') || '-'})`)
  return filtered
}

// ── Multi-Agent RAG helpers ───────────────────────────────────────────────────

/** 서브에이전트 합성 타임아웃 유틸 — 모듈 레벨 싱글톤 (fetchRAGContext 매 호출마다 재생성 방지) */
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>(r => setTimeout(() => r(fallback), ms))])

/**
 * 현재 모델의 프로바이더에서 가장 저렴한 Worker 모델을 반환합니다.
 * Worker는 문서 요약 등 반복적인 경량 작업에 사용됩니다.
 */
export function getWorkerModelId(currentModelId: string): { modelId: string; provider: ProviderId } {
  const provider: ProviderId = getProviderForModel(currentModelId) ?? 'anthropic'
  return { modelId: WORKER_MODEL_IDS[provider as keyof typeof WORKER_MODEL_IDS] ?? currentModelId, provider }
}

/**
 * Worker LLM으로 단일 문서를 쿼리 관점에서 요약합니다.
 * API 오류나 키 없을 때는 본문 앞 300자로 폴백합니다.
 */
async function agentSummarizeDoc(
  doc: LoadedDocument,
  query: string,
  apiKey: string,
  provider: string,
  workerModelId: string,
): Promise<string> {
  const body = getStrippedBody(doc)
  const content = body.length > 8000 ? body.slice(0, 8000) : body
  const { citationMode } = useSettingsStore.getState()
  const sysPrompt = citationMode
    ? '문서에서 질문과 직접 관련된 문장을 원문 그대로 최대 3문장 인용하세요. 인용문만 출력하고, 없으면 "관련 내용 없음"이라고만 답하세요.'
    : '문서를 질문 관점에서 핵심만 500자 이내로 요약하세요. 요약만 출력하세요.'
  const userMsg = `질문: ${query}\n\n문서(${doc.filename}):\n${content}`
  let result = ''
  try {
    const { streamCompletion } = await importProvider(provider)
    await streamCompletion(
      apiKey,
      workerModelId,
      sysPrompt,
      [{ role: 'user' as const, content: sanitize(userMsg) }],
      (c: string) => { result += c },
    )
  } catch (err) {
    logger.warn(`[Worker] agentSummarizeDoc 실패 (${doc.filename}):`, err instanceof Error ? err.message : String(err))
    result = ''
  }
  return result.trim() || body.slice(0, 300)
}

/**
 * 메인 에이전트가 vault context를 직접 보고 웹 검색 필요 여부를 판단.
 * Worker가 아닌 메인 모델이 결정하므로 내부 자료와 질문의 관계를 정확히 파악.
 *
 * 응답 형식: "NO" 또는 "YES: <검색어>"
 * max_tokens를 짧게 제한해 비용 최소화 (결정만 받고 답변은 별도 호출)
 */
async function mainAgentWebSearch(
  query: string,
  ragContext: string,
  modelId: string,
  provider: string,
  apiKey: string,
): Promise<string> {
  try {
    const decisionSys =
      '질문과 볼트 자료를 검토하여 웹 검색이 필요한지 판단하세요.\n' +
      '내부 프로젝트 문서로 충분히 답할 수 있으면 NO.\n' +
      '최신 업계 동향, 공식 발표, 외부 기술 정보가 필요하면 YES.\n' +
      '형식: "NO" 또는 "YES: <검색어 (영어/한국어 10단어 이내)>"'

    // 볼트 자료 앞부분만 요약해서 판단 비용 절감
    const ctxPreview = ragContext
      ? `\n볼트 자료 (앞부분):\n${ragContext.slice(0, 600)}`
      : '\n볼트 자료: 없음'
    const decisionMsg = `질문: ${query}${ctxPreview}\n\n웹 검색 필요 여부:`

    let decision = ''
    const { streamCompletion } = await importProvider(provider)
    await streamCompletion(
      apiKey, modelId, decisionSys,
      [{ role: 'user' as const, content: sanitize(decisionMsg) }],
      (c: string) => { decision += c },
    )

    const trimmed = decision.trim()
    if (!trimmed.toUpperCase().startsWith('YES')) return ''

    const colonIdx = trimmed.indexOf(':')
    const rawQuery = colonIdx >= 0 ? trimmed.slice(colonIdx + 1).trim() : query
    // Sanitize and limit search query length to prevent injection/abuse
    const searchQuery = rawQuery.replace(/[^\w\s\-'.,:]/g, '').slice(0, 150).trim() || query.slice(0, 150)

    const { searchWeb, buildWebContext } = await import('@/lib/webSearch')
    const results = await searchWeb(searchQuery, 5)
    logger.debug(`[웹검색] 메인 에이전트 결정: "${searchQuery}" → ${results.length}건`)
    return buildWebContext(results, 2000)
  } catch (e) {
    console.warn('[llmClient] mainAgentWebSearch 실패 — 웹 컨텍스트 없이 진행:', e)
    return ''
  }
}

/**
 * 최근 대화를 LLM으로 요약합니다.
 * ChatPanel의 "요약 저장" 버튼에서 호출 → memoryStore.appendToMemory()로 저장.
 */
export async function summarizeConversation(
  messages: ChatMessage[],
  onChunk: (chunk: string) => void,
): Promise<void> {
  const { personaModels } = useSettingsStore.getState()
  const mainModelId = personaModels['chief_director']
  const { modelId, provider } = getWorkerModelId(mainModelId)
  const apiKey = getApiKey(provider)
  if (!apiKey) return

  const histText = messages
    .slice(-20)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => `${m.role === 'user' ? '👤' : '🤖'} ${m.content.slice(0, 300)}`)
    .join('\n')
  const sysPrompt = '대화를 500자 이내로 핵심 결정사항/인사이트/합의된 내용 중심으로 요약하세요.'
  const userMsg = `다음 대화를 요약해주세요:\n\n${histText}`

  const { streamCompletion } = await importProvider(provider)
  await streamCompletion(
    apiKey,
    modelId,
    sysPrompt,
    [{ role: 'user' as const, content: sanitize(userMsg) }],
    onChunk,
  )
}

export async function fetchRAGContext(
  userMessage: string,
  currentSpeaker?: string,
  maxDocChars = 20000,
  skipWorkers = false,
  onThinkingChunk?: (chunk: string) => void,
  contextTerms?: string[],
): Promise<string> {
  try {
    // ── 전체 탐색 인텐트: 허브 노드 기반 전체 그래프 탐색 ──────────────────
    // 키워드 검색을 건너뛰고 바로 허브 중심 BFS로 광범위한 컨텍스트 수집
    if (GLOBAL_INTENT_RE.test(userMessage)) {
      useGraphStore.getState().setAiHighlightNodes(getGlobalContextDocIds(35, 4))
      return await buildGlobalGraphContext(35, 4)
    }

    // ── 공유 docMap: 이 함수 전체에서 재사용 — 중복 Map 생성 방지 ──────────────
    const vaultDocs = useVaultStore.getState().loadedDocuments
    const docMap = new Map(vaultDocs?.map(d => [d.id, d]) ?? [])
    const now = Date.now()
    const sc = useSettingsStore.getState().searchConfig

    // ── 소형 볼트 전체 주입 모드 ────────────────────────────────────────────────
    // 볼트 전체 rawContent 합산이 fullVaultThreshold 이하이면 RAG 없이 전부 주입.
    // Claude Cowork와 동일한 방식 — 검색 실패 없이 모든 문서를 LLM이 직접 참조.
    if (sc.fullVaultThreshold > 0 && vaultDocs?.length) {
      const totalChars = vaultDocs.reduce((sum, d) => sum + (d.rawContent?.length ?? 0), 0)
      if (totalChars <= sc.fullVaultThreshold) {
        logger.debug(`[RAG] 소형 볼트 전체 주입: ${vaultDocs.length}개 문서, ${totalChars}자`)
        // BM25 정렬: tfidfIndex가 빌드되어 있으면 쿼리 관련도순으로 정렬
        let sortedDocs = vaultDocs
        if (tfidfIndex.isBuilt) {
          const bm25Hits = tfidfIndex.search(userMessage, vaultDocs.length)
          if (bm25Hits.length > 0) {
            const scoreMap = new Map(bm25Hits.map(h => [h.docId, h.score]))
            sortedDocs = [...vaultDocs].sort((a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0))
          }
        }
        useGraphStore.getState().setAiHighlightNodes(sortedDocs.map(d => d.id))
        const fullCtx = sortedDocs
          .map(d => {
            const tagLine = d.tags?.length ? ` [태그: ${d.tags.join(', ')}]` : ''
            const dateLine = d.date ? ` [날짜: ${d.date}]` : ''
            const header = `## [문서] ${d.filename.replace(/\.md$/i, '')}${tagLine}${dateLine}\n`
            return header + getStrippedBody(d)
          })
          .join('\n\n---\n\n')
        return fullCtx
      }
    }

    // ── Stage 1: 직접 문자열 검색 (우선 시도) ─────────────────────────────────
    const _today = new Date()
    const _dateTokens = [
      String(_today.getFullYear()),
      String(_today.getMonth() + 1).padStart(2, '0'),
      String(_today.getDate()).padStart(2, '0'),
    ]

    // "최신/최근/요즘" 인텐트 감지 — Stage 1 recency 전략 결정
    const isRecencyQueryS1 = RECENCY_INTENT_RE.test(userMessage)

    // 날짜 토큰은 최신 인텐트 쿼리에만 추가.
    // 일반 쿼리에 "2026", "03" 등을 추가하면 날짜 파일명 문서들이 높은 파일명 점수를
    // 받아 실제 관련 문서(본문 매칭)를 상위 시드에서 밀어내는 오탐지 발생.
    const searchQuery = isRecencyQueryS1 ? userMessage + ' ' + _dateTokens.join(' ') : userMessage

    const directHitsCandidates = directVaultSearch(
      searchQuery,
      isRecencyQueryS1 ? sc.directCandidatesRecency : sc.directCandidatesNormal,
      contextTerms,
    )

    {
      const HALF_LIFE_MS = sc.recencyHalfLifeDays * 24 * 60 * 60 * 1000
      const RECENCY_COEFF = isRecencyQueryS1 ? sc.recencyCoeffHot : sc.recencyCoeffNormal
      const recBoost = (docId: string) => {
        const d = docMap.get(docId)
        if (!d) return 0
        // getContentDate: 파일명 날짜 → frontmatter date → mtime 순 폴백.
        // 이 볼트는 파일명에 날짜가 박힌 문서가 주력이고 date 필드가 없는 문서가 27.6%다.
        const ms = getContentDate(d)
        if (isNaN(ms) || ms <= 0 || ms > now) return 0
        return RECENCY_COEFF * Math.exp(-(now - ms) / HALF_LIFE_MS)
      }
      directHitsCandidates.sort((a, b) => (b.score + recBoost(b.doc_id)) - (a.score + recBoost(a.doc_id)))
    }
    const directHits = directHitsCandidates.slice(0, sc.directHitSeeds)

    const hasStrongDirectHit = directHits.some(r => r.score >= sc.minDirectHitScore)

    // ── 강한 파일명 매칭 (score >= 0.4): 전체 본문 직접 주입 + BFS 연관 문서 보완 ──
    // score >= 0.4 = raw >= 4 = 파일명에 쿼리 단어 2개 이상 매칭
    // score >= 0.2 단일 매칭("회의", "문서" 등 일반 단어)은 오탐지 방지를 위해 BFS 시드로만 사용
    const strongPinnedHits = directHits.filter(r => r.score >= sc.minPinnedScore)
    if (strongPinnedHits.length > 0) {
      const { multiAgentRAG, personaModels } = useSettingsStore.getState()

      // Top-1: chief가 전체 본문 직접 읽음 (maxDocChars 제한)
      const topDoc = docMap.get(strongPinnedHits[0].doc_id)
      const pinnedParts: string[] = ['## 직접 지목된 문서 (전체 내용)\n']
      let hasPinnedContent = false
      // 실제로 pinnedParts에 포함된 doc ID만 추적 (실패한 워커 doc은 BFS에 포함)
      const includedDocIds = new Set<string>()
      const MIN_PINNED_BODY = 100  // 스텁 문서(프론트매터만 있는 문서) 차단 임계값
      if (topDoc) {
        const body = getStrippedBody(topDoc)
        if (body.trim().length >= MIN_PINNED_BODY) {
          const truncated = body.length > maxDocChars ? body.slice(0, maxDocChars).trimEnd() + '…' : body
          pinnedParts.push(`[문서] ${topDoc.filename.replace(/\.md$/i, '')}\n${truncated}\n\n`)
          hasPinnedContent = true
          includedDocIds.add(strongPinnedHits[0].doc_id)
        }
        // else: 스텁 문서 — pinned 처리하지 않고 BFS 시드로 fallthrough
      }

      // Docs 2~N 처리: 히트 수에 따라 전략 분기 (최대 5개로 RPM 제한)
      const secondaryHits = strongPinnedHits.slice(1, 6)
      if (secondaryHits.length > 0) {
        if (multiAgentRAG && !skipWorkers && secondaryHits.length >= 3) {
          // 3개 이상: Worker LLM 병렬 요약 (500자 압축, max 5개)
          const currentModelId = personaModels[currentSpeaker as DirectorId] ?? personaModels['chief_director']
          const { modelId: workerModelId, provider: workerProvider } = getWorkerModelId(currentModelId)
          const workerApiKey = getApiKey(workerProvider)
          if (workerApiKey) {
            onThinkingChunk?.(`📚 **Worker 에이전트 ${secondaryHits.length}개 병렬 처리 중...**\n\n`)

            const workerResults = await Promise.all(
              secondaryHits.map(hit => {
                const doc = docMap.get(hit.doc_id)
                return doc
                  ? agentSummarizeDoc(doc, userMessage, workerApiKey, workerProvider, workerModelId)
                      .then(s => ({ doc, summary: s }))
                      .catch(() => null)
                  : Promise.resolve(null)
              })
            )

            const validResults = workerResults.filter((r): r is { doc: LoadedDocument; summary: string } => r !== null && Boolean(r.summary))
            validResults.forEach(r => includedDocIds.add(r.doc.id))

            if (validResults.length > 0) {
              const summarySection = validResults
                .map(({ doc, summary }) => `[Worker 요약] ${doc.filename.replace(/\.md$/i, '')}\n${summary}\n`)
                .join('\n')
              pinnedParts.push('\n## 연관 문서 요약 (Worker)\n' + summarySection)
              hasPinnedContent = true

              // ── 2팀 서브에이전트 합성 ────────────────────────────────────────────
              const narrativeSummaries: string[] = []
              const systemSummaries: string[] = []
              for (const { doc, summary } of validResults) {
                const domain = classifyDocDomain(doc)
                const entry = `[${doc.filename.replace(/\.md$/i, '')}]\n${summary}`
                if (domain === 'narrative') narrativeSummaries.push(entry)
                else systemSummaries.push(entry)
              }

              let subAgentSection = ''

              // 서브에이전트 합성 — 8초 타임아웃 (모듈 레벨 withTimeout 재사용)
              if (narrativeSummaries.length >= 1) {
                onThinkingChunk?.('\n\n**[서브 에이전트 A — 내러티브/캐릭터 관점]**\n')
                const synthesis = await withTimeout(
                  agentSynthesizeDomain(narrativeSummaries, userMessage, 'narrative', workerApiKey, workerProvider, workerModelId, onThinkingChunk),
                  8000, '',
                )
                if (synthesis) subAgentSection += `\n### 내러티브/캐릭터 관점\n${synthesis}`
              }

              if (systemSummaries.length >= 1) {
                onThinkingChunk?.('\n\n**[서브 에이전트 B — 시스템/게임플레이 관점]**\n')
                const synthesis = await withTimeout(
                  agentSynthesizeDomain(systemSummaries, userMessage, 'system', workerApiKey, workerProvider, workerModelId, onThinkingChunk),
                  8000, '',
                )
                if (synthesis) subAgentSection += `\n### 시스템/게임플레이 관점\n${synthesis}`
              }

              if (subAgentSection) {
                pinnedParts.push('\n## 서브 에이전트 인사이트\n' + subAgentSection)
                onThinkingChunk?.('\n\n---\n')
              }
            }
          }
        } else {
          // 2~3개: Worker 없이 앞 1500자 직접 주입
          const directSections = secondaryHits
            .map(hit => {
              const doc = docMap.get(hit.doc_id)
              if (!doc) return ''
              const body = getStrippedBody(doc)
              const content = body.length > 1500 ? body.slice(0, 1500).trimEnd() + '…' : body
              return `[문서] ${doc.filename.replace(/\.md$/i, '')}\n${content}\n`
            })
            .filter(Boolean)
            .join('\n')
          if (directSections) {
            pinnedParts.push('\n## 연관 문서\n' + directSections)
            hasPinnedContent = true
            secondaryHits.forEach(hit => { if (docMap.has(hit.doc_id)) includedDocIds.add(hit.doc_id) })
          }
        }
      }

      if (hasPinnedContent) {
        const pinnedCtx = pinnedParts.join('')
        // 실제로 포함된 문서만 BFS 시드에서 제외 (실패한 워커 문서는 BFS 시드로 복원)
        const bfsSeeds = directHits.filter(r => !includedDocIds.has(r.doc_id))
        const bfsCtx = await buildDeepGraphContext(bfsSeeds, 2, 10, tokenizeQuery(userMessage), currentSpeaker)
        logger.debug(`[RAG] Multi-agent: pinned=${pinnedCtx.length}자, BFS=${bfsCtx.length}자`)
        useGraphStore.getState().setAiHighlightNodes(directHits.map(r => r.doc_id))
        return pinnedCtx + (bfsCtx ? '\n' + bfsCtx : '')
      }
    }

    let seeds: import('@/types').SearchResult[]

    if (hasStrongDirectHit) {
      // 직접 검색 결과가 충분 → 이를 우선 시드로 사용 (폴백 경로)
      seeds = directHits
      logger.debug(`[RAG] 직접 검색 우선: ${seeds.map(r => r.filename).join(', ')}`)
    } else {
      // 직접 매칭 미흡 → 벡터 전체 검색 우선, BM25 보완
      let candidates: import('@/types').SearchResult[] = []
      let searchMode = 'BM25'

      const anthropicKey = getApiKey('anthropic')

      // ── 메타데이터 필터 (화자/태그 감지 후 docs 사전 필터링) ─────────────
      const searchDocs = (sc.metadataFilter && vaultDocs)
        ? applyMetadataFilter(userMessage, vaultDocs)
        : (vaultDocs ?? [])

      // ── 쿼리 확장 (LLM으로 검색어 보강) ─────────────────────────────────
      let searchQuery = userMessage
      if (sc.queryExpansion && anthropicKey) {
        searchQuery = await withTimeout(
          expandQueryWithLLM(userMessage, anthropicKey),
          5000, userMessage,
        )
        if (searchQuery !== userMessage) logger.debug(`[RAG] 쿼리 확장: "${userMessage.slice(0, 30)}" → "${searchQuery.slice(0, 50)}"`)
      }

      const geminiKey = getApiKey('gemini')
      if (vectorEmbedIndex.isBuilt && await isEmbeddingReady(geminiKey)) {
        // ── 1순위: 전체 벡터 검색 (순수 의미 유사도) ────────────────────────
        try {
          const vecResults = await vectorEmbedIndex.fullVectorSearch(
            searchQuery, (geminiKey ?? ''), sc.bm25Candidates * 2, searchDocs,
          )
          if (vecResults && vecResults.length > 0) {
            // ── 벡터 임계값: 상대값 사용 ────────────────────────────────────
            // fullVectorSearch는 정규화 없는 raw cosine을 반환한다. BGE-M3(L2 정규화)에서
            // 한국어 문서 간 cosine은 0.4~0.75의 좁은 대역에 몰려 절대 임계값 0.1은 no-op이었다.
            const vecTop = vecResults[0].score
            const vecMin = Math.max(0.35, vecTop * 0.6)
            const vecKept = vecResults.filter(r => r.score >= vecMin)
            const vecList = vecKept.length > 0 ? vecKept : vecResults.slice(0, sc.rerankSeeds)

            // BM25 보완 — 벡터 리스트와 융합 깊이를 맞춘다
            const bm25Results = frontendKeywordSearch(
              userMessage, Math.max(sc.bm25Candidates, vecList.length), currentSpeaker, contextTerms,
            ).filter(r => r.score > sc.minBm25Score)

            // ── RRF 융합 ────────────────────────────────────────────────────
            // 벡터는 raw cosine, BM25는 max 정규화 → 두 점수를 같은 배열에 섞으면
            // BM25 보완 문서(0.95)가 벡터 1위(0.72)를 항상 이긴다.
            // 순위 기반 RRF로 융합해 점수 스케일 의존성을 제거한다.
            // (graphAnalysis의 BM25 정규화 방식이 바뀌어도 이 코드는 영향받지 않는다)
            const vecRank = new Map(vecList.map((r, i) => [r.doc_id, i + 1]))
            const bm25Rank = new Map(bm25Results.map((r, i) => [r.doc_id, i + 1]))
            const MISS_RANK = vecList.length + bm25Results.length + 1

            const merged = new Map<string, import('@/types').SearchResult>()
            for (const r of vecList) if (!merged.has(r.doc_id)) merged.set(r.doc_id, r)
            for (const r of bm25Results) if (!merged.has(r.doc_id)) merged.set(r.doc_id, r)

            const fused = [...merged.values()]
              .map(r => ({
                ...r,
                score: rrfScore([vecRank.get(r.doc_id) ?? MISS_RANK, bm25Rank.get(r.doc_id) ?? MISS_RANK]),
              }))
              .sort((a, b) => b.score - a.score)

            // RRF 원점수는 ≈0.03 스케일이라 downstream(rerankResults의 가중합, llmRerank의 0.4/0.6 혼합,
            // _index.md 시드 0.15)과 어긋난다 → 상위 1.0 기준 max 정규화로 0~1 스케일 복원.
            const topRrf = fused[0]?.score || 1
            candidates = fused.map(r => ({ ...r, score: r.score / topRrf }))
            // candidates가 확정된 뒤에 모드를 표시 — 중간에 예외가 나면 아래 BM25 폴백이 자기 모드를 쓴다
            searchMode = 'vector'

            logger.debug(`[RAG] RRF 융합: 벡터 ${vecList.length}(임계 ${vecMin.toFixed(2)}, 상위 ${vecTop.toFixed(3)}) + BM25 ${bm25Results.length} → ${candidates.length}개`)
          }
        } catch (e: unknown) {
          logger.warn('[vector] fullVectorSearch 실패, BM25 폴백:', e instanceof Error ? e.message : String(e))
        }
      }

      if (candidates.length === 0) {
        // ── 2순위: ChromaDB 백엔드 ────────────────────────────────────────────
        if (typeof window !== 'undefined' && window.backendAPI) {
          try {
            const response = await window.backendAPI.search(userMessage, sc.bm25Candidates)
            candidates = response.results ?? []
            if (candidates.length > 0) searchMode = 'chromadb'
          } catch { /* backend not running */ }
        }
        // ── 3순위: 프론트엔드 BM25 ───────────────────────────────────────────
        if (candidates.length === 0) {
          candidates = frontendKeywordSearch(userMessage, sc.bm25Candidates * 4, currentSpeaker, contextTerms)
        }
      }

      logger.debug(`[RAG] ${searchMode} 후보: ${candidates.length}개 (쿼리: "${searchQuery.slice(0, 40)}")`)

      // vector 모드의 후보는 RRF 융합 전에 이미 상대 임계값으로 걸러졌고 점수가 순위 기반이므로
      // 여기서 다시 절대 임계값을 적용하지 않는다 (기존 `> 0.1`은 raw cosine에서 no-op이었고,
      // RRF 정규화 점수에서는 반대로 대부분을 잘라내 버린다).
      const relevant = searchMode === 'vector'
        ? candidates
        : candidates.filter(r => r.score > sc.minBm25Score)

      // ── LLM 리랭킹 ───────────────────────────────────────────────────────
      if (sc.llmRerank && anthropicKey && relevant.length > 0 && searchMode === 'vector') {
        const docMapLocal = new Map((vaultDocs ?? []).map(d => [d.id, d]))
        // 리랭커에는 프론트매터를 제거한 본문을 넘긴다 —
        // rawContent 원본은 74.9%의 문서에서 스니펫이 YAML 헤더만으로 채워진다.
        const augmented = relevant.map(r => {
          const d = docMapLocal.get(r.doc_id)
          return { ...r, rawContent: d ? getStrippedBody(d) : undefined }
        })
        const reranked = await withTimeout(
          llmRerankCandidates(userMessage, augmented, anthropicKey, sc.rerankSeeds),
          8000, relevant.slice(0, sc.rerankSeeds),
        )
        seeds = reranked
        logger.debug(`[RAG] LLM 리랭킹 완료: ${seeds.map(r => r.filename).join(', ')}`)
      } else {
        seeds = relevant.length > 0 ? rerankResults(relevant, userMessage, sc.rerankSeeds, currentSpeaker) : []
      }

      // 직접 검색에서 놓친 문서 보완
      const seedIds = new Set(seeds.map(r => r.doc_id))
      for (const hit of directHits) {
        if (!seedIds.has(hit.doc_id)) seeds.push(hit)
      }
    }

    // _index.md 항상 포함
    const indexDoc = vaultDocs?.find(d => d.filename.toLowerCase() === '_index.md')
    if (indexDoc && !seeds.some(r => r.doc_id === indexDoc.id)) {
      const firstSection = indexDoc.sections.find(s => s.body.trim())
      seeds.unshift({
        doc_id: indexDoc.id,
        filename: indexDoc.filename,
        section_id: firstSection?.id ?? '',
        heading: firstSection?.heading ?? '',
        speaker: indexDoc.speaker,
        content: firstSection
          ? (firstSection.body.length > 600 ? firstSection.body.slice(0, 600).trimEnd() + '…' : firstSection.body)
          : '',
        score: 0.15,  // PPR 지배 방지 — seed에 포함되지만 최상위 점수 차지하지 않음
        tags: indexDoc.tags ?? [],
      })
    }

    // ── related: frontmatter 링크를 BFS 시드에 자동 추가 ──────────────────────
    // 상위 시드 문서의 related: 필드에 명시된 문서를 시드에 포함하여 BFS 탐색 범위 확장
    {
      const existingSeedIds = new Set(seeds.map(r => r.doc_id))
      const relatedSeeds: import('@/types').SearchResult[] = []
      // 상위 5개 시드만 확인 (과도한 확장 방지)
      for (const seed of seeds.slice(0, 5)) {
        const seedDoc = docMap.get(seed.doc_id)
        if (!seedDoc?.related?.length) continue
        for (const relLink of seedDoc.related) {
          // related 값은 "[[filename]]" 또는 "filename" 형태 — 정규화
          const cleanName = relLink.replace(/^\[\[|\]\]$/g, '').trim()
          if (!cleanName) continue
          // docMap에서 파일명 매칭 (확장자 유무 모두 시도)
          const relDoc = vaultDocs?.find(d =>
            d.filename.replace(/\.md$/i, '').toLowerCase() === cleanName.toLowerCase() ||
            d.filename.toLowerCase() === cleanName.toLowerCase()
          )
          if (relDoc && !existingSeedIds.has(relDoc.id)) {
            existingSeedIds.add(relDoc.id)
            const firstSection = relDoc.sections.find(s => s.body.trim())
            relatedSeeds.push({
              doc_id: relDoc.id,
              filename: relDoc.filename,
              section_id: firstSection?.id ?? '',
              heading: firstSection?.heading ?? '',
              speaker: relDoc.speaker,
              content: firstSection
                ? (firstSection.body.length > 400 ? firstSection.body.slice(0, 400).trimEnd() + '…' : firstSection.body)
                : '',
              score: seed.score * 0.7,  // 원본 시드보다 낮은 점수 — BFS 우선순위 조절
              tags: relDoc.tags ?? [],
            })
          }
        }
      }
      if (relatedSeeds.length > 0) {
        seeds.push(...relatedSeeds)
        logger.debug(`[RAG] related: 시드 추가: ${relatedSeeds.map(r => r.filename).join(', ')}`)
      }
    }

    // 버전 중복 제거: 동일 문서의 v2/v3/v4 중 최신만 유지
    seeds = deduplicateVersions(seeds, docMap)

    // 최신 인텐트 감지: 시드를 날짜 역순으로 재정렬해 최신 문서가 BFS 우선 탐색에 사용되도록
    // _index.md / currentSituation.md 는 항상 상단 유지 (날짜 정보 포함)
    const isRecencyQuery = RECENCY_INTENT_RE.test(userMessage)
    if (isRecencyQuery && seeds.length > 0) {
      const PINNED_HUB = /^(_index|currentSituation|chief[\s_]persona)/i
      const pinned = seeds.filter(r => PINNED_HUB.test(r.filename))
      const rest = seeds.filter(r => !PINNED_HUB.test(r.filename))
      rest.sort((a, b) => {
        // 파일명 날짜 우선 — date frontmatter가 없는 문서가 볼트의 27.6%
        const da = docMap.get(a.doc_id), db = docMap.get(b.doc_id)
        const ra = da ? getContentDate(da) : 0
        const rb = db ? getContentDate(db) : 0
        return rb - ra
      })
      seeds = [...pinned, ...rest]
      logger.debug(`[RAG] 최신 인텐트 감지 — 시드 날짜순 재정렬: ${seeds.slice(0, 3).map(r => r.filename).join(', ')}`)
    }

    // Stage 2: BFS 그래프 탐색 — 시드에서 최대 3홉까지 연결 문서 수집
    if (seeds.length > 0) {
      useGraphStore.getState().setAiHighlightNodes(seeds.map(r => r.doc_id))
    }
    const ctx = await buildDeepGraphContext(seeds, sc.bfsMaxHops, sc.bfsMaxDocs, tokenizeQuery(userMessage), currentSpeaker)
    logger.debug(`[RAG] 컨텍스트 생성 완료: ${ctx.length}자`)

    // 최신 인텐트 시 LLM에게 날짜 기준 + 볼트 데이터 공백 안내 주입
    if (isRecencyQuery) {
      const today = new Date().toISOString().slice(0, 10)
      // 볼트에서 가장 최근 문서 날짜 계산 (데이터 공백 경고용)
      // 파일명 날짜 포함 — mtime만 보면 일괄 재동기화된 볼트에서 항상 "오늘"이 나온다
      const latestMs = vaultDocs
        ? Math.max(0, ...vaultDocs.map(d => getContentDate(d)).filter(ms => ms > 0 && ms <= Date.now()))
        : 0
      const latestDate = latestMs > 0 ? new Date(latestMs).toISOString().slice(0, 10) : null
      const gapWarning = latestDate && latestDate < today
        ? ` 볼트의 가장 최신 문서는 **${latestDate}**까지만 있습니다. 그 이후 상황은 볼트에 기록이 없으므로 알 수 없다고 명시하세요.`
        : ''
      const preamble = `> ⚠️ **날짜 기준**: 오늘은 ${today}입니다.${gapWarning} 아래 문서에 date 필드가 표시되어 있습니다. **최신 정보를 원하면 가장 최근 date를 가진 문서를 우선하세요.**\n\n`
      return preamble + ctx
    }
    return ctx
  } catch (err) {
    // RAG failure is non-fatal — continue without context
    logger.error('[RAG] fetchRAGContext 오류:', err)
    return ''
  }
}

// ── Shared system-prompt assembly ──────────────────────────────────────────────

/**
 * 구조화 추론 프롬프트 — 분석·설계·의사결정 질문에 [관찰]→[연결고리]→[분석]→[결론] 구조 강제.
 * SSOT: 이 상수를 bot.py Python 폴백에서도 동일하게 사용.
 */
export const STRUCTURED_REASONING_PROMPT =
  '\n\n[구조화 추론] 분석·비교·설계·의사결정 질문에는 다음 구조로 답변하세요:\n' +
  '**[관찰]** 검색된 문서에서 발견한 핵심 사실·데이터\n' +
  '**[연결고리]** 문서 간 패턴, 인과관계, 모순, 숨겨진 연관성\n' +
  '**[분석]** 발견된 패턴의 의미·배경 맥락·함의\n' +
  '**[결론/제안]** 핵심 인사이트와 실행 가능한 다음 단계\n' +
  '단순 검색·요약·인사·사실 확인에는 이 구조를 생략하고 간결하게 답변하세요.'

interface SystemPromptParts {
  projectContext: string
  basePrompt: string
  ragInstructionBlock: string
  personaDocContext: string
  memoryContext: string
  responseInstructions: string
  sensitiveBlock: string
  factBlock: string
  /** 구조화 추론 프롬프트 (설정에서 활성화된 경우) */
  reasoningBlock?: string
  /** Optional suffix appended after factBlock (e.g. Slack-specific notes) */
  suffix?: string
}

/** 사고 프레임워크 — 모든 페르소나 공통, 단순 질문에는 자동 생략 */
const DEEP_THINKING_PROMPT =
  '\n\n[심층 사고] 참고 자료가 있을 때 다음 사고 과정을 거치세요:' +
  '\n- 시간축: 문서 날짜를 비교하라. "이 결정(3월)은 저 피드백(1월) 이후인가?" — 시간 순서가 의미를 바꾼다' +
  '\n- 인과: "왜 이 결정을 했는가?"를 다른 문서에서 찾아라. 원인 문서가 없으면 "근거 불명"으로 지적하라' +
  '\n- 빠진 조각: 문서에 언급은 되지만 구체적 결론이 없는 항목을 "미결 상태"로 지적하라' +
  '\n- 리스크: 현재 상태가 지속되면 어떤 문제가 생기는지 1~2가지 시나리오를 제시하라' +
  '\n단순 사실 확인·인사·검색에는 이 과정을 생략하세요.'

function buildSystemPrompt(p: SystemPromptParts): string {
  return (
    p.projectContext + p.basePrompt + p.ragInstructionBlock + p.personaDocContext + p.memoryContext
    + (p.responseInstructions.trim() ? '\n\n' + p.responseInstructions.trim() : '')
    + p.sensitiveBlock
    + '\n\n[말투 고정] 참고 문서나 사용자 메시지의 문체에 관계없이 항상 전문적인 존댓말(~합니다/~습니다 체)로 일관되게 답변하세요.'
    + '\n\n[출처 안내] 참고 문서 헤더에 [출처: URL] 형태로 원본 URL이 포함된 경우, 사용자가 출처·링크·원문을 요청하면 해당 URL을 답변에 포함하세요.'
    + p.factBlock
    + DEEP_THINKING_PROMPT
    + (p.reasoningBlock ?? '')
    + (p.suffix ?? '')
  )
}

// ── Main entry point ───────────────────────────────────────────────────────────

/**
 * Route a user message to the appropriate LLM provider and stream the response.
 *
 * If no API key is configured for the selected model's provider, falls back to
 * the mock response system (with a "[Mock]" prefix so the user knows).
 *
 * If a ChromaDB backend is available, relevant document chunks are prepended
 * to the system prompt as RAG context.
 *
 * Image attachments are sent to vision-capable providers (Anthropic, OpenAI, Gemini).
 * Text file attachments are appended to the user message as quoted context.
 *
 * @param persona      The director persona responding
 * @param userMessage  The raw user message text
 * @param history      Full conversation history (for context)
 * @param onChunk      Called with each streamed text delta
 * @param attachments  Optional files attached to the current message
 */

/** 멀티볼트 순차 탐색 중 전역 store 변이를 직렬화하기 위한 뮤텍스 (Promise 체인) */
let _multiVaultSearchLock: Promise<void> = Promise.resolve()

/**
 * Slack 봇용: Strata Sync의 RAG 파이프라인(BFS+TF-IDF)으로 컨텍스트를 수집하고
 * 지정 페르소나 모델로 답변을 생성해 반환한다.
 * useRagApi.ts의 onAsk 핸들러에서 호출됨.
 */
export async function generateSlackAnswer(
  query: string,
  directorId: string,
  history: { role: 'user' | 'assistant'; content: string }[] = [],
  images?: { data: string; mediaType: string }[],
): Promise<{ answer: string; imagePaths: string[] }> {
  const {
    personaModels, projectInfo, directorBios, customPersonas,
    personaPromptOverrides, responseInstructions, ragInstruction,
    personaDocumentIds, sensitiveKeywords, citationMode: _citationModeSlack,
    reasoningConfig,
  } = useSettingsStore.getState()

  // streamMessage와 동일: 커스텀 페르소나 우선 확인
  const customPersona = customPersonas.find(p => p.id === directorId)
  const modelId = customPersona
    ? customPersona.modelId
    : (personaModels[directorId as DirectorId] ?? personaModels['chief_director'])
  const provider = getProviderForModel(modelId)
  if (!provider) return { answer: '', imagePaths: [] }
  const apiKey = getApiKey(provider)
  if (!apiKey) return { answer: '', imagePaths: [] }

  // ── 시스템 프롬프트 구성 (streamMessage와 동일 순서) ─────────────────────
  const basePrompt = customPersona
    ? customPersona.systemPrompt
    : (personaPromptOverrides[directorId as DirectorId]
        ?? PERSONA_PROMPTS[directorId as DirectorId]
        ?? PERSONA_PROMPTS['chief_director'])

  const directorBio = customPersona ? undefined : directorBios[directorId as DirectorId]
  const projectContext = buildProjectContext(projectInfo, directorBio)

  // 페르소나 문서 주입
  const personaDocId = personaDocumentIds[directorId]
  let personaDocContext = ''
  if (personaDocId) {
    const doc = useVaultStore.getState().loadedDocuments?.find(d => d.id === personaDocId)
    if (doc) {
      personaDocContext = `\n\n---\n아래는 "${doc.filename}" 문서에서 가져온 페르소나 참고 자료입니다. 이 내용을 바탕으로 해당 인물의 관점과 어투를 참고하세요:\n\n${doc.rawContent.slice(0, 4000)}`
    }
  }

  // 장기 기억 주입
  const { memoryText } = useMemoryStore.getState()
  const memoryContext = memoryText.trim()
    ? `\n\n---\n## 📌 이전 대화 기억\n${memoryText.trim()}\n---`
    : ''

  const ragInstructionBlock = ragInstruction.trim() ? '\n\n' + ragInstruction.trim() : ''
  const factBlock_slack = _citationModeSlack ? FACT_BLOCK_CITATION : FACT_BLOCK_NO_CITATION
  // 민감 키워드 매칭 시 우선 처리 지시 주입
  const matchedKeywords = sensitiveKeywords
    ? sensitiveKeywords.split(/[\n,]+/).map(k => k.trim()).filter(Boolean)
        .filter(k => query.toLowerCase().includes(k.toLowerCase()))
    : []
  const sensitiveBlock = matchedKeywords.length > 0
    ? `\n\n[우선 주제] 이 질문은 다음 핵심 키워드를 포함합니다: ${matchedKeywords.map(k => `"${k}"`).join(', ')}. 이 주제에 관한 정보를 최우선으로 검색하고, 관련 내용을 빠짐없이 상세하게 답변하세요.`
    : ''

  const reasoningBlock = reasoningConfig.structuredReasoning ? STRUCTURED_REASONING_PROMPT : ''

  const systemPrompt = buildSystemPrompt({
    projectContext, basePrompt, ragInstructionBlock, personaDocContext, memoryContext,
    responseInstructions, sensitiveBlock, factBlock: factBlock_slack,
    reasoningBlock,
    suffix: '\n\n[Slack 이미지] 이 대화는 Slack 봇을 통해 이루어집니다. 볼트에서 관련 이미지가 발견되면 봇 시스템이 자동으로 첨부합니다. "이미지를 보여줄 수 없다"거나 "이미지 기능이 없다"는 표현은 절대 사용하지 마세요. 이미지 요청에는 관련 내용을 텍스트로 설명하고, 이미지는 시스템이 자동 처리한다고 안내하세요.',
  })

  // ── RAG context → 유저 메시지 앞에 주입 (Slack: worker 생략, BFS 유지) ──────
  // 짧은 인사/감탄사는 RAG 생략 (엉뚱한 프로젝트 컨텍스트 주입 방지)
  const isSmallTalk = /^(안녕|ㅎㅇ|hi|hello|hey|반가워|고마워|감사합니다|감사해|수고|고생|화이팅|파이팅|ㅋ+|ㄱ+|ㅇㅇ|ㅇㅋ|오케|굿|좋아|ㅇㄱ|ㄴㄴ|ㅠ+|ㅜ+)\s*[~!?♡]*$/i.test(query.trim())

  // Slack: 볼트별 병렬 검색 후 컨텍스트 병합 (TF-IDF 캐시 재활용, [출처: 볼트명] 헤더 삽입)
  let _ragRaw = ''
  if (!isSmallTalk) {
    const vaultStoreState = useVaultStore.getState()
    const { vaultDocsCache, vaults, loadedDocuments } = vaultStoreState
    const activeVaultId = vaultStoreState.activeVaultId
    const vaultEntries = Object.entries(vaultDocsCache)
    if (vaultEntries.length <= 1) {
      // 볼트 1개 → 기존 방식
      _ragRaw = await fetchRAGContext(query, directorId, 8000, true)
    } else {
      // 볼트 여러 개 → 활성 볼트는 full RAG, 추가 볼트는 점수 기반 키워드 검색
      // ※ store.loadedDocuments 교체 제거 — React 리렌더 + OOM 크래시 방지
      const perVaultLimit = Math.floor(6000 / vaultEntries.length)
      const parts: string[] = []

      // 활성 볼트: 풀 RAG (그래프 + 벡터 + BM25)
      const activeLabel = vaults[activeVaultId]?.label ?? activeVaultId
      const activeCtx = await fetchRAGContext(query, directorId, perVaultLimit, true)
      if (activeCtx.trim()) parts.push(`\n# [출처: ${activeLabel}]\n${activeCtx}`)

      // 2-gram 한국어 보조 토크나이저 — 짧은 쿼리 + 한국어 매칭 회복
      const grams = (s: string): string[] =>
        s.length < 2 ? [s] : Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2))

      // 쿼리 토큰: 공백 분리 단어 + 한국어 2-gram
      const qRaw = query.toLowerCase().trim()
      const qWords = qRaw.split(/\s+/).filter(w => w.length > 1)
      const qGrams: string[] = []
      for (const w of qWords) {
        if (/[\uac00-\ud7a3]/.test(w)) qGrams.push(...grams(w))
      }
      const qTerms = Array.from(new Set([...qWords, ...qGrams]))

      // 추가 볼트 폴백: activeVaultId 가 캐시에 없을 때 loadedDocuments 를 대신 사용
      const cacheMap = new Map(vaultEntries)
      if (activeVaultId && !cacheMap.has(activeVaultId) && loadedDocuments?.length) {
        cacheMap.set(activeVaultId, loadedDocuments)
      }

      for (const [vaultId, docs] of cacheMap) {
        if (vaultId === activeVaultId || !docs?.length) continue
        const label = vaults[vaultId]?.label ?? vaultId

        // 점수 기반 랭킹: (단어 매칭 수 / log(문서 길이))
        const scored = docs
          .map(d => {
            const text = (d.filename + ' ' + (d.rawContent ?? '').slice(0, 4000)).toLowerCase()
            if (!text) return { doc: d, score: 0 }
            let hits = 0
            for (const t of qTerms) {
              if (t && text.includes(t)) hits++
            }
            if (hits === 0) return { doc: d, score: 0 }
            const lenPenalty = Math.log(Math.max(text.length, 100))
            return { doc: d, score: hits / lenPenalty }
          })
          .filter(r => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)

        if (scored.length > 0) {
          let ctx = ''
          for (const { doc } of scored) {
            const body = (doc.rawContent ?? '').slice(0, perVaultLimit / 5)
            ctx += `### ${doc.filename}\n${body}\n\n`
            if (ctx.length >= perVaultLimit) break
          }
          parts.push(`\n# [출처: ${label}]\n${ctx.slice(0, perVaultLimit)}`)
        }
      }
      _ragRaw = parts.join('\n')
    }
  }

  // 소형 볼트 전체 주입 모드에서는 fullVaultThreshold까지 허용; 일반 RAG는 10K 캡 (30K TPM 한도 대응)
  const _fvt = useSettingsStore.getState().searchConfig.fullVaultThreshold
  const _isFullVault = _fvt > 0 && _ragRaw.length > 0 && _ragRaw.length <= _fvt
  const _ragCap = _isFullVault ? _fvt : 10000
  const ragContext = _ragRaw.length > _ragCap ? _ragRaw.slice(0, _ragCap).trimEnd() + '\n…(컨텍스트 축약)' : _ragRaw

  // Slack: 웹 검색 스킵 (LLM 판단 호출 ~5초 절감)
  let fullUserMessage = query
  if (ragContext) {
    fullUserMessage = `${ragContext}위 자료는 볼트 WikiLink 그래프로 수집한 관련 자료입니다.\n이 자료를 단순 나열하지 말고, 문서 날짜·맥락을 교차 분석하여 사용자가 모르는 연결고리와 리스크를 짚어주세요.\n\n---\n\n${query}`
  }

  // 이전 대화 히스토리 (Slack: 최대 6개 메시지 = 3턴, TPM 절약)
  const historyMessages = history.slice(-6)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: sanitize(m.content),
    }))

  // 마지막 user 메시지 제거 (현재 턴이 새 메시지로 별도 추가되므로 중복 방지)
  const _lastUserIdxSlack = getLastUserIdx(historyMessages as ChatMessage[])
  const filteredHistory = historyMessages.filter((_, i) => i !== _lastUserIdxSlack)

  // 이미지 첨부 시 Attachment 배열로 변환 (providers가 공통으로 사용하는 형식)
  const attachments: import('@/types').Attachment[] = (images ?? []).map((img, i) => ({
    id: `slack-img-${i}`,
    name: `image${i}.${img.mediaType.split('/')[1] ?? 'png'}`,
    type: 'image' as const,
    mimeType: img.mediaType,
    dataUrl: `data:${img.mediaType};base64,${img.data}`,
    size: 0,
  }))

  const thinkingOpts = (provider === 'anthropic' && reasoningConfig.extendedThinking)
    ? { enabled: true, budgetTokens: reasoningConfig.thinkingBudget }
    : undefined

  let answer = ''
  if (provider === 'anthropic') {
    const { streamCompletion: scAnthropic } = await import('./providers/anthropic')
    await scAnthropic(
      apiKey, modelId,
      sanitize(systemPrompt),
      [...filteredHistory, { role: 'user' as const, content: sanitize(fullUserMessage) }],
      (c: string) => { answer += c },
      attachments,
      undefined,
      undefined,
      thinkingOpts,
    )
  } else {
    const { streamCompletion } = await importProvider(provider)
    await streamCompletion(
      apiKey, modelId,
      sanitize(systemPrompt),
      [...filteredHistory, { role: 'user' as const, content: sanitize(fullUserMessage) }],
      (c: string) => { answer += c },
      attachments,
    )
  }

  // RAG 결과 상위 문서에서 연관 이미지 경로 수집 (볼트 이미지 자동 첨부용)
  // ※ 이미지 파일명이 쿼리 단어와 매칭될 때만 포함 — 문서만 관련 있고 이미지는 무관한 경우 제외
  const { imagePathRegistry, loadedDocuments: allDocs } = useVaultStore.getState()
  const imagePaths: string[] = []
  if (imagePathRegistry && allDocs) {
    const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
    const seen = new Set<string>()

    // 파일명이 쿼리 단어와 매칭되는지 확인하는 헬퍼
    const filenameMatches = (ref: string) => {
      if (qWords.length === 0) return false
      const base = (ref.split(/[/\\]/).pop() ?? ref).toLowerCase()
      return qWords.some(w => base.includes(w))
    }

    // 1순위: 매칭된 문서의 imageRefs 중 파일명이 쿼리와 관련 있는 것만
    const topHits = directVaultSearch(query, 5)
    const docMap = new Map(allDocs.map(d => [d.id, d]))
    for (const hit of topHits) {
      const doc = docMap.get(hit.doc_id)
      if (!doc?.imageRefs?.length) continue
      for (const ref of doc.imageRefs) {
        if (!filenameMatches(ref)) continue  // 파일명 관련성 필터
        const basename = ref.split(/[/\\]/).pop() ?? ref
        const entry = imagePathRegistry[ref] ?? imagePathRegistry[basename]
        if (entry?.absolutePath && !seen.has(entry.absolutePath)) {
          seen.add(entry.absolutePath)
          imagePaths.push(entry.absolutePath)
          if (imagePaths.length >= 3) break
        }
      }
      if (imagePaths.length >= 3) break
    }

    // 2순위: imageRegistry 파일명에서 쿼리 단어 매칭 (임베드 없이 독립 이미지 파일만 있는 경우)
    if (imagePaths.length < 3) {
      for (const [name, entry] of Object.entries(imagePathRegistry)) {
        const n = name.toLowerCase()
        if (qWords.some(w => n.includes(w)) && !seen.has(entry.absolutePath)) {
          seen.add(entry.absolutePath)
          imagePaths.push(entry.absolutePath)
          if (imagePaths.length >= 3) break
        }
      }
    }
  }

  return { answer, imagePaths }
}

export async function streamMessage(
  persona: SpeakerId,
  userMessage: string,
  history: ChatMessage[],
  onChunk: (chunk: string) => void,
  attachments?: Attachment[],
  overrideRagContext?: string,   // 키워드 검색 우회 — 노드 선택 AI 분석 등에 사용
  onThinkingChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { personaModels, projectInfo, directorBios, customPersonas, personaPromptOverrides, responseInstructions, ragInstruction, personaDocumentIds, sensitiveKeywords, webSearch: webSearchEnabled, citationMode, reasoningConfig: _rc } = useSettingsStore.getState()

  // Resolve persona — may be a built-in director or a custom persona
  const customPersona = customPersonas.find(p => p.id === persona)
  const modelId = customPersona
    ? customPersona.modelId
    : personaModels[persona as DirectorId]
  const provider = getProviderForModel(modelId)

  if (!provider) {
    // Model not found in catalogue — use mock
    await streamMockResponse(persona, userMessage, onChunk)
    return
  }

  const apiKey = getApiKey(provider)

  if (!apiKey) {
    // No API key configured — use mock
    await streamMockResponse(persona, userMessage, onChunk)
    return
  }

  const model = MODEL_OPTIONS.find((m) => m.id === modelId)
  if (!model) { logger.error(`[LLM] 알 수 없는 모델 ID: ${modelId}`); onChunk('모델 설정 오류: 알 수 없는 모델입니다.'); return }

  // Resolve system prompt: custom persona > built-in override > built-in default
  const basePrompt = customPersona
    ? customPersona.systemPrompt
    : (personaPromptOverrides[persona] ?? PERSONA_PROMPTS[persona as DirectorId] ?? '')

  // Director bio only applies to built-in personas
  const directorBio = customPersona ? undefined : directorBios[persona as DirectorId]
  const projectContext = buildProjectContext(projectInfo, directorBio)

  // ── Persona document injection ──────────────────────────────────────────────
  // 설정에서 이 페르소나에 연결된 볼트 문서가 있으면 시스템 프롬프트에 주입
  const personaDocId = personaDocumentIds[persona]
  let personaDocContext = ''
  if (personaDocId) {
    const doc = useVaultStore.getState().loadedDocuments?.find(d => d.id === personaDocId)
    if (doc) {
      personaDocContext = `\n\n---\n아래는 "${doc.filename}" 문서에서 가져온 페르소나 참고 자료입니다. 이 내용을 바탕으로 해당 인물의 관점과 어투를 참고하세요:\n\n${doc.rawContent.slice(0, 4000)}`
    }
  }

  // ── AI 장기 기억 주입 ────────────────────────────────────────────────────────
  const { memoryText } = useMemoryStore.getState()
  const memoryContext = memoryText.trim()
    ? `\n\n---\n## 📌 이전 대화 기억\n${memoryText.trim()}\n---`
    : ''

  // ── 대화 히스토리 맥락 분석 ─────────────────────────────────────────────────
  const contextTerms = DEICTIC_RE.test(userMessage)
    ? extractContextTerms(history)
    : undefined
  if (contextTerms?.length) {
    logger.debug(`[RAG] 히스토리 맥락 보강: ${contextTerms.slice(0, 6).join(', ')}`)
  }

  // ── Graph-Augmented RAG context injection ──────────────────────────────────
  // overrideRagContext가 있으면 키워드 검색 없이 그대로 사용 (노드 직접 선택 분석 등)
  const ragContext = overrideRagContext !== undefined
    ? overrideRagContext
    : await fetchRAGContext(userMessage, persona, 20000, false, onThinkingChunk, contextTerms)

  // ── 웹 검색 ("인터넷 검색" 인텐트 감지 시에만 실행) ────────────
  let webCtx = ''
  if (overrideRagContext === undefined && webSearchEnabled && WEB_SEARCH_INTENT_RE.test(userMessage)
      && typeof window !== 'undefined' && (window as any).webSearchAPI) {
    webCtx = await mainAgentWebSearch(userMessage, ragContext, modelId, provider, apiKey)
  }

  const ragInstructionBlock = ragInstruction.trim() ? '\n\n' + ragInstruction.trim() : ''
  const factBlock = citationMode ? FACT_BLOCK_CITATION : FACT_BLOCK_NO_CITATION
  // 민감 키워드 매칭 시 우선 처리 지시 주입
  const _matchedKw = sensitiveKeywords
    ? sensitiveKeywords.split(/[\n,]+/).map(k => k.trim()).filter(Boolean)
        .filter(k => userMessage.toLowerCase().includes(k.toLowerCase()))
    : []
  const _sensitiveBlock = _matchedKw.length > 0
    ? `\n\n[우선 주제] 이 질문은 다음 핵심 키워드를 포함합니다: ${_matchedKw.map(k => `"${k}"`).join(', ')}. 이 주제에 관한 정보를 최우선으로 검색하고, 관련 내용을 빠짐없이 상세하게 답변하세요.`
    : ''

  const systemPrompt = buildSystemPrompt({
    projectContext, basePrompt, ragInstructionBlock, personaDocContext, memoryContext,
    responseInstructions, sensitiveBlock: _sensitiveBlock, factBlock,
    reasoningBlock: _rc.structuredReasoning ? STRUCTURED_REASONING_PROMPT : '',
  })

  // ── Attachment processing ───────────────────────────────────────────────────
  // Separate image attachments (→ vision API) from text attachments (→ message injection)
  const imageAttachments = attachments?.filter(a => a.type === 'image') ?? []
  const textAttachments  = attachments?.filter(a => a.type === 'text')  ?? []

  // Append text file content to user message
  let fullUserMessage = userMessage
  if (textAttachments.length > 0) {
    const textContext = textAttachments
      .map(a => {
        const content = a.dataUrl.length > TEXT_ATTACH_MAX
          ? a.dataUrl.slice(0, TEXT_ATTACH_MAX) + '\n…(내용 축약됨)'
          : a.dataUrl
        return `\n\n[첨부 파일: ${a.name}]\n${content}`
      })
      .join('')
    fullUserMessage = userMessage + textContext
  }

  // RAG 컨텍스트 + 웹 검색 결과를 사용자 메시지 앞에 주입
  const combinedCtx = [ragContext, webCtx].filter(Boolean).join('\n')
  if (combinedCtx) {
    const srcLabel = ragContext && webCtx
      ? '볼트 WikiLink 그래프와 웹 검색'
      : ragContext ? '볼트 WikiLink 그래프' : '웹 검색'
    fullUserMessage = `${combinedCtx}위 자료는 ${srcLabel}으로 수집한 관련 자료입니다.\n이 자료를 단순 나열하지 말고, 문서 날짜·맥락을 교차 분석하여 사용자가 모르는 연결고리와 리스크를 짚어주세요.\n\n---\n\n${fullUserMessage}`
  }

  // Build message history, excluding only the last user message (= current turn being sent)
  const _lastUserIdx = getLastUserIdx(history)
  let historyMessages = toHistoryMessages(
    history.filter((_, i) => i !== _lastUserIdx)
  )

  // ── Context compaction: 히스토리가 너무 길면 오래된 대화를 요약해서 시스템 프롬프트에 주입 ──
  const histChars = historyMessages.reduce((s, m) => s + m.content.length, 0)
  let finalSystemPrompt = systemPrompt
  if (histChars > 20_000 && historyMessages.length > 10) {
    try {
      const { modelId: wModelId, provider: wProvider } = getWorkerModelId(modelId)
      const wApiKey = getApiKey(wProvider as ProviderId)
      if (wApiKey) {
        const oldMessages = historyMessages.slice(0, -8)
        const recentMessages = historyMessages.slice(-8)
        const oldText = oldMessages
          .map(m => `${m.role}: ${m.content.slice(0, 200)}`)
          .join('\n')
        let compactSummary = ''
        const { streamCompletion: wComplete } = await importProvider(wProvider)
        await wComplete(
          wApiKey, wModelId,
          '대화 내용을 300자로 요약하세요.',
          [{ role: 'user' as const, content: sanitize(oldText) }],
          (c: string) => { compactSummary += c },
        )
        if (compactSummary.trim()) {
          finalSystemPrompt += `\n\n## 이전 대화 요약 (자동 컴팩션)\n${compactSummary.trim()}`
          historyMessages = recentMessages
          // 컴팩션 요약을 AI 장기 기억에도 자동 저장
          const timestamp = new Date().toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          useMemoryStore.getState().appendToMemory(`[${timestamp} 자동 요약]\n${compactSummary.trim()}`)
          logger.debug(`[컴팩션] ${histChars}자 → 최근 8개 메시지 + 요약 주입 + 기억 저장`)
        }
      }
    } catch (e) {
      logger.warn('[컴팩션] 실패 — 전체 히스토리 사용:', e)
    }
  }

  const cleanSystemPrompt = sanitize(finalSystemPrompt)
  const allMessages = [
    ...historyMessages,
    { role: 'user' as const, content: sanitize(fullUserMessage) },
  ]

  // Record token usage into the session usage store
  const onUsage = (inputTokens: number, outputTokens: number) => {
    useUsageStore.getState().recordUsage(modelId, inputTokens, outputTokens, 'chat')
  }

  const _thinkingOpts = (model.provider === 'anthropic' && _rc.extendedThinking)
    ? { enabled: true, budgetTokens: _rc.thinkingBudget }
    : undefined

  // Dynamically import the provider module to keep bundle splitting clean
  switch (model.provider) {
    case 'anthropic': {
      const { streamCompletion } = await import('./providers/anthropic')
      await streamCompletion(apiKey, modelId, cleanSystemPrompt, allMessages, onChunk, imageAttachments, onUsage, signal, _thinkingOpts)
      break
    }
    case 'openai': {
      const { streamCompletion } = await import('./providers/openai')
      await streamCompletion(apiKey, modelId, cleanSystemPrompt, allMessages, onChunk, imageAttachments, onUsage, signal)
      break
    }
    case 'gemini': {
      const { streamCompletion } = await import('./providers/gemini')
      await streamCompletion(apiKey, modelId, cleanSystemPrompt, allMessages, onChunk, imageAttachments, onUsage, signal)
      break
    }
    case 'grok': {
      const { streamCompletion } = await import('./providers/grok')
      // Grok does not support vision — notify user if images were attached
      if (imageAttachments.length > 0) {
        onChunk('[Grok은 이미지 분석을 지원하지 않습니다. 텍스트만 처리됩니다.]\n\n')
      }
      await streamCompletion(apiKey, modelId, cleanSystemPrompt, allMessages, onChunk, [], onUsage, signal)
      break
    }
    default: {
      await streamMockResponse(persona, userMessage, onChunk)
    }
  }

  // 채팅 RAG 하이라이트 클리어 (GraphPanel 분석은 자체 관리)
  if (overrideRagContext === undefined) {
    useGraphStore.getState().setAiHighlightNodes([])
  }
}

// ── Raw LLM stream (Edit Agent용) ─────────────────────────────────────────────

/**
 * Bare-metal LLM call without RAG/persona overhead.
 * Used by the Edit Agent runner for file refinement tasks.
 *
 * Automatically records token usage to usageStore.
 *
 * @param modelId      Full model ID (e.g. 'claude-sonnet-4-6')
 * @param systemPrompt System prompt string
 * @param messages     Message history
 * @param onChunk      Streaming text callback
 */
export async function streamMessageRaw(
  modelId: string,
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const provider = getProviderForModel(modelId)
  if (!provider) throw new Error(`[streamMessageRaw] Unknown model: ${modelId}`)
  const apiKey = getApiKey(provider)
  if (!apiKey) throw new Error(`[streamMessageRaw] No API key for provider: ${provider}`)

  const onUsage = (inputTokens: number, outputTokens: number) => {
    useUsageStore.getState().recordUsage(modelId, inputTokens, outputTokens, 'editAgent')
  }

  const sanitizedMessages = messages.map(m => ({ role: m.role, content: sanitize(m.content) }))
  const cleanSys = sanitize(systemPrompt)

  // Cast to a generic signature to avoid provider union type intersection issues.
  // 각 provider 의 streamCompletion 은 `signal?: AbortSignal` 파라미터를 공통으로 받습니다.
  type RawStream = (
    apiKey: string, model: string, sys: string,
    messages: { role: 'user' | 'assistant'; content: string }[],
    onChunk: (chunk: string) => void,
    imageAttachments?: Attachment[],
    onUsage?: (inputTokens: number, outputTokens: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>
  const { streamCompletion } = await importProvider(provider)
  await (streamCompletion as RawStream)(apiKey, modelId, cleanSys, sanitizedMessages, onChunk, [], onUsage, signal)
}

// ── Tool-enabled chat (Chat Agent + Edit Agent tools) ─────────────────────────

/**
 * Like streamMessage but runs an Anthropic tool-use agentic loop when tools are provided.
 * For non-Anthropic providers falls back to plain streamMessage (no tools).
 *
 * tools / executeTool are passed from the caller (chatStore) to avoid
 * a circular dependency with editAgentRunner.
 */
export async function streamMessageWithTools(
  persona: SpeakerId,
  userMessage: string,
  history: ChatMessage[],
  onChunk: (chunk: string) => void,
  onToolCall: (name: string, input: unknown, result: string) => void,
  tools: AnthropicTool[],
  executeTool: AgentLoopOpts['executeTool'],
  attachments?: Attachment[],
  overrideRagContext?: string,
  onThinkingChunk?: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const {
    personaModels, projectInfo, directorBios, customPersonas,
    personaPromptOverrides, responseInstructions, ragInstruction,
    personaDocumentIds, sensitiveKeywords, webSearch: webSearchEnabled, citationMode,
  } = useSettingsStore.getState()

  const customPersona = customPersonas.find(p => p.id === persona)
  const modelId = customPersona
    ? customPersona.modelId
    : personaModels[persona as DirectorId]
  const provider = getProviderForModel(modelId)

  if (!provider) {
    await streamMockResponse(persona, userMessage, onChunk)
    return
  }

  const apiKey = getApiKey(provider)
  if (!apiKey) {
    await streamMockResponse(persona, userMessage, onChunk)
    return
  }

  // Non-Anthropic: tools not supported — fall back to regular streaming
  if (provider !== 'anthropic') {
    await streamMessage(persona, userMessage, history, onChunk, attachments, overrideRagContext, onThinkingChunk, signal)
    return
  }

  // ── Build system prompt (identical logic to streamMessage) ──────────────────
  const basePrompt = customPersona
    ? customPersona.systemPrompt
    : (personaPromptOverrides[persona] ?? PERSONA_PROMPTS[persona as DirectorId] ?? '')

  const directorBio = customPersona ? undefined : directorBios[persona as DirectorId]
  const projectContext = buildProjectContext(projectInfo, directorBio)

  const personaDocId = personaDocumentIds[persona]
  let personaDocContext = ''
  if (personaDocId) {
    const doc = useVaultStore.getState().loadedDocuments?.find(d => d.id === personaDocId)
    if (doc) {
      personaDocContext = `\n\n---\n아래는 "${doc.filename}" 문서에서 가져온 페르소나 참고 자료입니다. 이 내용을 바탕으로 해당 인물의 관점과 어투를 참고하세요:\n\n${doc.rawContent.slice(0, 4000)}`
    }
  }

  const { memoryText } = useMemoryStore.getState()
  const memoryContext = memoryText.trim()
    ? `\n\n---\n## 📌 이전 대화 기억\n${memoryText.trim()}\n---`
    : ''

  // ── 대화 히스토리 맥락 분석 (streamMessage와 동일) ──────────────────────────
  const contextTerms = DEICTIC_RE.test(userMessage)
    ? extractContextTerms(history)
    : undefined
  if (contextTerms?.length) {
    logger.debug(`[RAG/tools] 히스토리 맥락 보강: ${contextTerms.slice(0, 6).join(', ')}`)
  }

  const ragContext = overrideRagContext !== undefined
    ? overrideRagContext
    : await fetchRAGContext(userMessage, persona, 20000, false, onThinkingChunk, contextTerms)

  let webCtx = ''
  if (overrideRagContext === undefined && webSearchEnabled && WEB_SEARCH_INTENT_RE.test(userMessage)
      && typeof window !== 'undefined' && (window as any).webSearchAPI) {
    webCtx = await mainAgentWebSearch(userMessage, ragContext, modelId, provider, apiKey)
  }

  const ragInstructionBlock = ragInstruction.trim() ? '\n\n' + ragInstruction.trim() : ''
  const factBlock = citationMode ? FACT_BLOCK_CITATION : FACT_BLOCK_NO_CITATION

  const _matchedKw = sensitiveKeywords
    ? sensitiveKeywords.split(/[\n,]+/).map(k => k.trim()).filter(Boolean)
        .filter(k => userMessage.toLowerCase().includes(k.toLowerCase()))
    : []
  const _sensitiveBlock = _matchedKw.length > 0
    ? `\n\n[우선 주제] 이 질문은 다음 핵심 키워드를 포함합니다: ${_matchedKw.map(k => `"${k}"`).join(', ')}. 이 주제에 관한 정보를 최우선으로 검색하고, 관련 내용을 빠짐없이 상세하게 답변하세요.`
    : ''

  const { vaultPath } = useVaultStore.getState()

  // Tool capability notice in system prompt — include vault path so LLM uses correct absolute paths
  const vaultPathHint = vaultPath
    ? `\n볼트 경로: ${vaultPath} — 파일 도구의 path는 반드시 이 경로로 시작하는 절대 경로를 사용하세요. 예: ${vaultPath}/active/파일명.md`
    : ''
  const toolNotice = `\n\n[도구 사용 가능] 파일 읽기/쓰기, Jira 이슈 관리, Confluence 페이지 생성·수정 등 볼트 도구를 직접 사용할 수 있습니다. 사용자가 문서 작성, 이슈 발행, 파일 수정 등을 요청하면 적극적으로 도구를 활용하세요.${vaultPathHint}`

  const systemPrompt = buildSystemPrompt({
    projectContext, basePrompt, ragInstructionBlock, personaDocContext, memoryContext,
    responseInstructions, sensitiveBlock: _sensitiveBlock, factBlock, suffix: toolNotice,
  })

  // ── Build message context with RAG ─────────────────────────────────────────
  let fullUserMessage = userMessage

  const textAttachments = attachments?.filter(a => a.type === 'text') ?? []
  if (textAttachments.length > 0) {
    const textContext = textAttachments
      .map(a => {
        const content = a.dataUrl.length > TEXT_ATTACH_MAX
          ? a.dataUrl.slice(0, TEXT_ATTACH_MAX) + '\n…(내용 축약됨)'
          : a.dataUrl
        return `\n\n[첨부 파일: ${a.name}]\n${content}`
      })
      .join('')
    fullUserMessage = userMessage + textContext
  }

  const combinedCtx = [ragContext, webCtx].filter(Boolean).join('\n')
  if (combinedCtx) {
    const srcLabel = ragContext && webCtx
      ? '볼트 WikiLink 그래프와 웹 검색'
      : ragContext ? '볼트 WikiLink 그래프' : '웹 검색'
    fullUserMessage = `${combinedCtx}위 자료는 ${srcLabel}으로 수집한 관련 자료입니다.\n이 자료를 단순 나열하지 말고, 문서 날짜·맥락을 교차 분석하여 사용자가 모르는 연결고리와 리스크를 짚어주세요.\n\n---\n\n${fullUserMessage}`
  }

  // Exclude only the last user message (= current turn being sent)
  const _lastUserIdxTools = getLastUserIdx(history)
  const historyMessages: AgentMsg[] = toHistoryMessages(
    history.filter((_, i) => i !== _lastUserIdxTools)
  ).map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }) as AgentMsg)

  await runAgentLoop({
    systemPrompt: sanitize(systemPrompt),
    messages: [...historyMessages, { role: 'user' as const, content: sanitize(fullUserMessage) }],
    tools,
    executeTool,
    modelId,
    apiKey,
    vaultPath: vaultPath ?? '',
    usageCategory: 'chat',
    onChunk,
    onToolCall,
    signal,
  })

  if (overrideRagContext === undefined) {
    useGraphStore.getState().setAiHighlightNodes([])
  }
}
