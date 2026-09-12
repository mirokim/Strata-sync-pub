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

// ── Shared constants ─────────────────────────────────────────────────────────

/** Max characters per text attachment (~3K tokens) — shared by streamMessage/streamMessageWithTools */
const TEXT_ATTACH_MAX = 12000

// ── Context enrichment from conversation history ─────────────────────────────

/** Pronoun/deictic patterns — expressions that refer back to earlier conversation context */
const DEICTIC_RE = /그거|그것|아까|위에서\s*말한|방금|이전에|앞서|아까\s*그|그\s*게임|그\s*문서|그\s*캐릭터|그\s*내용|더\s*자세히|좀\s*더|계속|이어서/

/** Korean stopwords — excluded during keyword extraction */
const HISTORY_STOPWORDS = new Set([
  '은', '는', '이', '가', '을', '를', '의', '에', '에서', '로', '으로', '와', '과', '도', '만',
  '좀', '더', '그', '저', '이', '것', '거', '수', '때', '중', '등', '및',
  '해줘', '알려줘', '설명해줘', '말해줘', '뭐야', '뭐', '어떤', '어떻게', '왜', '무엇',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'why', 'and', 'or', 'but',
  '네', '예', '아니', '응', '그래', '좋아', '알겠어',
])

/**
 * Extracts key nouns/keywords from the user messages of the previous N turns.
 * Called only when the current message contains a deictic expression ("that", "earlier", "just now", etc.).
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

/**
 * Index of the history entry that duplicates the current turn, or -1.
 *
 * chatStore appends the user's message to `messages` before snapshotting `history`, so the
 * current turn is normally the last user entry and must not be sent twice. Callers that pass a
 * history *without* the current turn (Slack bot, tests) must keep their last user message, so
 * only drop it when its content actually matches the message being sent.
 */
function currentTurnIdx(history: { role: string; content: string }[], userMessage: string): number {
  const idx = getLastUserIdx(history as ChatMessage[])
  if (idx < 0) return -1
  return history[idx].content.trim() === userMessage.trim() ? idx : -1
}

/** Factual compliance guideline block — shared by streamMessage/streamMessageWithTools/generateSlackAnswer
 *  citationMode=true  → includes vault citation markers
 *  citationMode=false → "retrieved documents" wording only
 */
const FACT_BLOCK_CITATION = '\n\n[Factual compliance] You must follow these guidelines:\n1. Answers must be based solely on documents retrieved from the vault, web search results, or content directly stated by the user.\n2. Never speculate or fabricate facts not explicitly stated in documents. If uncertain, state "This content could not be confirmed in the retrieved documents."\n3. When referencing vault documents, use "retrieved documents" or "vault documents".\n4. When making inferences beyond vault quotes, you must mark the end of the sentence with **(inference)**.'
const FACT_BLOCK_NO_CITATION = '\n\n[Factual compliance] You must follow these guidelines:\n1. Answers must be based solely on documents retrieved from the vault, web search results, or content directly stated by the user.\n2. Never speculate or fabricate facts not explicitly stated in documents. If uncertain, state "This content could not be confirmed in the retrieved documents."\n3. When referencing vault documents auto-retrieved via RAG, use "retrieved documents" or "vault documents" instead of "documents you provided".'

// ── Obsidian MD conversion (MD conversion editor pipeline) ────────────────────

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
    'You are a knowledge management expert at a game development studio. ' +
    'You analyze raw text and structure it into Obsidian markdown format.'

  const userMessage =
    `Please convert the following text to Obsidian markdown.\n\n` +
    `You must follow this exact format:\n` +
    `1. First line: KEYWORDS: keyword1, keyword2, keyword3 (5-10 key terms, comma separated)\n` +
    `2. Blank line\n` +
    `3. Separator: ---\n` +
    `4. Obsidian frontmatter:\n` +
    `---\n` +
    `speaker: ${meta.speaker}\n` +
    `date: ${meta.date}\n` +
    `tags: [${meta.type}, keyword1, keyword2]\n` +
    `type: ${meta.type}\n` +
    `---\n` +
    `5. ## ${meta.title}\n` +
    `6. Use each key term as a ## subheading to organize related content\n\n` +
    `Title: ${meta.title}\nType: ${meta.type}\n\nOriginal text:\n${rawContent}`

  const messages = [{ role: 'user' as const, content: sanitize(userMessage) }]

  try {
    const { streamCompletion } = await importProvider(provider)
    await streamCompletion(apiKey, modelId, sanitize(systemPrompt), messages, onChunk)
  } catch (e) {
    console.warn('[llmClient] convertToObsidianMD API call failed — using fallback:', e)
    onChunk(fallbackOutput)
  }
}

// ── Provider dispatch helper ───────────────────────────────────────────────────

/**
 * Dynamically imports the provider module.
 * Uses a switch instead of a template literal so the Vite bundler can statically analyze the chunks.
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
 * Pattern that detects a global-exploration intent.
 * When matched, switches to hub-node-based full graph traversal.
 */
const GLOBAL_INTENT_RE = /(?:^|\s)(전체적인|전반적|총체적|프로젝트\s*전체|전체\s*인사이트|전체\s*피드백|모든\s*문서|big.?picture|overview)(?:\s|[?.!,]|$)|^전체\s*$|^전반\s*$/i

/** Web search intent pattern — only when the user explicitly asks for "인터넷 검색" (internet search) */
const WEB_SEARCH_INTENT_RE = /인터넷\s*검색/i

/**
 * Recency-request intent pattern.
 * When matched, re-sorts TF-IDF seeds by date descending and injects a date warning into the context.
 */
const RECENCY_INTENT_RE = /최신|최근|요즘|이번\s*달|이번\s*주|오늘|지금|현재|방금|가장\s*새|latest|recent|진행\s*방향|진행\s*상황|진행\s*현황|현재\s*상태|현황|어떻게\s*됐|어떻게\s*되고|어디까지|어떤\s*상태|업데이트|최신화/i

// ── Domain classification for 2-team sub-agent architecture ──────────────────

/** Narrative/character domain keywords */
const NARRATIVE_DOMAIN_RE = /캐릭터|스토리|세계관|나레이션|설정|배경|인물|페르소나|persona|character|story|world|narrative|lore|plot|캐릭터설정|케릭터/i
/** System/gameplay domain keywords */
const SYSTEM_DOMAIN_RE = /게임플레이|시스템|메카닉|스펙|밸런스|UI|UX|기술|아트|사운드|gameplay|mechanic|spec|balance|tech|art|sound|data|점령전|난투전|전투|combat|level|레벨|버그|패치|수치|공식|계산/i

function classifyDocDomain(doc: LoadedDocument): 'narrative' | 'system' | 'general' {
  const text = [doc.filename, doc.tags?.join(' ') ?? '', doc.speaker ?? ''].join(' ')
  if (NARRATIVE_DOMAIN_RE.test(text)) return 'narrative'
  if (SYSTEM_DOMAIN_RE.test(text)) return 'system'
  return 'general'
}

/**
 * Sub-agent: synthesizes per-domain worker summaries into a single perspective insight.
 * Streams in real time when onChunk is provided.
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
  const domainName = domain === 'narrative' ? 'Narrative/Character' : 'System/Gameplay'
  const sysPrompt =
    `You are a sub-agent specializing in ${domainName}. ` +
    `Based on the worker summaries below, synthesize the key insights from the "${domainName}" perspective in 200 characters or less. ` +
    `Prioritize connections or implications that people tend to miss. Output only the insight text.`
  const content = `Question: ${query}\n\nWorker summaries:\n${workerSummaries.join('\n---\n').slice(0, 4000)}`
  let result = ''
  try {
    const { streamCompletion } = await importProvider(provider)
    await streamCompletion(
      apiKey, workerModelId, sysPrompt,
      [{ role: 'user' as const, content: sanitize(content) }],
      (c: string) => { result += c; onChunk?.(c) },
    )
  } catch (e) {
    console.warn('[llmClient] agentSynthesizeDomain API call failed — returning empty result:', e)
    result = ''
  }
  return result.trim()
}

// ── Search Quality Helpers ────────────────────────────────────────────────────

/**
 * Query Expansion: semantically expands the search query with an LLM (Haiku).
 * Supplements short or ambiguous Korean queries with related keywords to improve vector search accuracy.
 * Returns the original query on API error.
 */
export async function expandQueryWithLLM(query: string, apiKey: string): Promise<string> {
  let result = ''
  try {
    const { streamCompletion } = await import('./providers/anthropic')
    await streamCompletion(
      apiKey, WORKER_MODEL_IDS.anthropic,
      'You are a search query expansion expert. Add 2-3 key terms semantically related to the input query and form a single natural sentence. Keep the core meaning of the original query while including synonyms and related concepts. Output only the text.',
      [{ role: 'user' as const, content: query }],
      (c: string) => { result += c },
    )
  } catch (e) {
    console.warn('[llmClient] expandQueryWithLLM API call failed — using original query:', e)
    return query
  }
  return result.trim() || query
}

/**
 * Candidate snippet length passed to the reranker.
 * In this vault the median YAML frontmatter is 239 chars and 74.9% exceed 200 chars —
 * a 200-char snippet contained not a single character of body text for most documents.
 */
const RERANK_SNIPPET_CHARS = 600

/**
 * Defensive frontmatter removal.
 * Callers inject only the body via getStrippedBody(), but external callers may pass the raw text,
 * so the reranker strips the YAML header once more. (indexOf-based — avoids ReDoS)
 */
function stripYamlFrontmatter(text: string): string {
  const t = text.trimStart()
  if (!t.startsWith('---')) return text
  const closeIdx = t.indexOf('\n---', 3)
  if (closeIdx < 0) return text
  return t.slice(closeIdx + 4).trimStart()
}

/**
 * LLM Re-ranking: re-evaluates the query relevance of vector search candidates with Haiku.
 * Scores each candidate 0–10 and blends the vector score (40%) with the LLM score (60%).
 * Keeps the original order on API error.
 *
 * ※ For the blend ratio to be meaningful, c.score must be on a 0~1 scale.
 *   Passing raw RRF scores (≈0.03) as-is erases the vector contribution, so callers must max-normalize.
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
      'Rate each document\'s relevance to the query from 0–10. You must output "index:score" pairs separated by commas. Example: 0:8,1:3,2:9. Output only this format with no other text.',
      [{ role: 'user' as const, content: `Query: ${query}\n\nDocument list:\n${list}` }],
      (c: string) => { result += c },
    )
  } catch (e) {
    console.warn('[llmClient] rerankWithLLM API call failed — keeping original order:', e)
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
 * Overly generic tags excluded from tag matching.
 * They appear across the vault (hundreds of documents), so the signal is too weak to justify a hard filter.
 */
const GENERIC_FILTER_TAGS = new Set([
  '작업', '작업관리', '문서', '회의', '기타', '일반', '내용', '정리', '기록', '메모', '자료', '설정', '배경',
  'doc', 'docs', 'note', 'notes', 'misc', 'general', 'etc',
  'spec', 'type', 'game', 'art', 'world', 'data', 'jira', 'epic', 'tech', 'chief', 'guide',
])

/** Minimum tag length allowed for the tag hard filter — blocks broad tags like "작업" (2 chars) */
const MIN_FILTER_TAG_LEN = 3

/** Korean particles — for token stem extraction */
const KO_PARTICLE_RE = /(을|를|이|가|은|는|의|에서|에게|에|으로|로|와|과|도|만|랑|이랑|처럼|보다)$/u

/**
 * Splits the query at token boundaries.
 * Substring matching (q.includes(tag)) catches unrelated tags, e.g. "개발실" inside "개발실무",
 * so only word-boundary tokens plus particle-stripped stems are used for matching.
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
 * speaker id → titles that would actually appear in a query (reverse of PERSONA_TAG_MAP).
 * The old code was q.includes('chief_director'), dead code that could never match a user query.
 * Whitespace is stripped from the query before comparison, so both "아트 디렉터" and "아트디렉터" match.
 */
const SPEAKER_QUERY_ALIASES: Record<string, string[]> = {
  chief_director: ['총괄디렉터', '총괄디렉타', 'pm', '총괄'],
  art_director:   ['아트디렉터', '아트디렉타', 'artdirector'],
  plan_director:  ['기획디렉터', '기획디렉타', '기획총괄'],
  level_director: ['레벨디렉터', '레벨디렉타'],
  prog_director:  ['프로그래밍디렉터', '개발디렉터', '테크디렉터', '프로그래밍디렉타'],
}

/**
 * Metadata Filter: detects speaker/tags in the query and pre-filters docs.
 *
 * This filter trims the candidate pool of the subsequent vector search itself, so false positives are very costly.
 * Three safeguards:
 *   1) Token-boundary matching (no substrings)
 *   2) Tags must be at least 3 chars, generic tags excluded
 *   3) Filter result floor = max(50, 5% of total) — falls back to all docs when below
 */
export function applyMetadataFilter<T extends { speaker?: string; tags?: string[] }>(
  query: string,
  docs: T[],
): T[] {
  if (docs.length === 0) return docs

  const qTokens = queryTokenSet(query)
  const qCompact = query.toLowerCase().replace(/\s+/g, '')

  // ── Speaker detection (reverse title alias mapping + token match for name-style speakers) ──
  const speakerSet = new Set(docs.map(d => d.speaker).filter(Boolean) as string[])
  const matchedSpeakers = new Set(
    [...speakerSet].filter(s => {
      const lower = s.toLowerCase()
      if (lower === 'unknown') return false
      if (qTokens.has(lower)) return true
      return SPEAKER_QUERY_ALIASES[lower]?.some(a => qCompact.includes(a)) ?? false
    })
  )

  // ── Tag detection (token boundary + minimum length + generic tags excluded) ──
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

  // Floor: set high so a single short tag cannot slice the vault.
  // (2,635-document vault → below 132 the filter is abandoned and all docs are passed through)
  const floor = Math.max(50, Math.ceil(docs.length * 0.05))
  if (filtered.length < floor) return docs

  logger.debug(`[RAG] Metadata filter: ${docs.length} → ${filtered.length} (tags: ${[...matchedTags].join(', ') || '-'}, speakers: ${[...matchedSpeakers].join(', ') || '-'})`)
  return filtered
}

// ── Multi-Agent RAG helpers ───────────────────────────────────────────────────

/** Sub-agent synthesis timeout utility — module-level singleton (avoids recreating per fetchRAGContext call) */
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>(r => setTimeout(() => r(fallback), ms))])

/**
 * Returns the cheapest Worker model for the current model's provider.
 * Workers are used for repetitive lightweight tasks such as document summarization.
 */
export function getWorkerModelId(currentModelId: string): { modelId: string; provider: ProviderId } {
  const provider: ProviderId = getProviderForModel(currentModelId) ?? 'anthropic'
  return { modelId: WORKER_MODEL_IDS[provider as keyof typeof WORKER_MODEL_IDS] ?? currentModelId, provider }
}

/**
 * Summarizes a single document from the query's perspective using a Worker LLM.
 * Falls back to the first 300 chars of the body on API error or missing key.
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
    ? 'Quote up to 3 sentences from the document that directly relate to the question, verbatim. Output only the quotes; if there are none, reply only "No relevant content".'
    : 'Summarize the document from the question\'s perspective, key points only, in 500 characters or less. Output only the summary.'
  const userMsg = `Question: ${query}\n\nDocument (${doc.filename}):\n${content}`
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
    logger.warn(`[Worker] agentSummarizeDoc failed (${doc.filename}):`, err instanceof Error ? err.message : String(err))
    result = ''
  }
  return result.trim() || body.slice(0, 300)
}

/**
 * The main agent looks at the vault context directly and decides whether a web search is needed.
 * The main model, not a Worker, decides, so it accurately grasps the relationship between internal materials and the question.
 *
 * Response format: "NO" or "YES: <search terms>"
 * max_tokens is kept short to minimize cost (only the decision is requested; the answer is a separate call)
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
      'Review the question and the vault materials and decide whether a web search is needed.\n' +
      'If internal project documents are sufficient to answer, NO.\n' +
      'If the latest industry trends, official announcements, or external technical information are needed, YES.\n' +
      'Format: "NO" or "YES: <search terms (English/Korean, 10 words or fewer)>"'

    // Only the beginning of the vault materials is included to reduce decision cost
    const ctxPreview = ragContext
      ? `\nVault materials (excerpt):\n${ragContext.slice(0, 600)}`
      : '\nVault materials: none'
    const decisionMsg = `Question: ${query}${ctxPreview}\n\nWeb search needed?:`

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
    logger.debug(`[WebSearch] Main agent decision: "${searchQuery}" → ${results.length} results`)
    return buildWebContext(results, 2000)
  } catch (e) {
    console.warn('[llmClient] mainAgentWebSearch failed — proceeding without web context:', e)
    return ''
  }
}

/**
 * Summarizes recent conversation using LLM.
 * Called from ChatPanel's "Save summary" button → stored via memoryStore.appendToMemory().
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
  const sysPrompt = 'Summarize the conversation in 500 characters or less, focusing on key decisions/insights/agreed-upon items.'
  const userMsg = `Please summarize the following conversation:\n\n${histText}`

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
    // ── Global exploration intent: hub-node-based full graph traversal ───────
    // Skip keyword search and go straight to hub-centered BFS to collect broad context
    if (GLOBAL_INTENT_RE.test(userMessage)) {
      useGraphStore.getState().setAiHighlightNodes(getGlobalContextDocIds(35, 4))
      return await buildGlobalGraphContext(35, 4)
    }

    // ── Shared docMap: reused throughout this function — avoids building duplicate Maps ──
    const vaultDocs = useVaultStore.getState().loadedDocuments
    const docMap = new Map(vaultDocs?.map(d => [d.id, d]) ?? [])
    const now = Date.now()
    const sc = useSettingsStore.getState().searchConfig

    // ── Small vault full injection mode ────────────────────────────────────────
    // If the total rawContent of the vault is at or below fullVaultThreshold, inject everything without RAG.
    // Same approach as Claude Cowork — the LLM references every document directly, with no retrieval misses.
    if (sc.fullVaultThreshold > 0 && vaultDocs?.length) {
      const totalChars = vaultDocs.reduce((sum, d) => sum + (d.rawContent?.length ?? 0), 0)
      if (totalChars <= sc.fullVaultThreshold) {
        logger.debug(`[RAG] Small vault full injection: ${vaultDocs.length} documents, ${totalChars} chars`)
        // BM25 ordering: if tfidfIndex is built, sort by query relevance
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
            const tagLine = d.tags?.length ? ` [tags: ${d.tags.join(', ')}]` : ''
            const dateLine = d.date ? ` [date: ${d.date}]` : ''
            const header = `## [Document] ${d.filename.replace(/\.md$/i, '')}${tagLine}${dateLine}\n`
            return header + getStrippedBody(d)
          })
          .join('\n\n---\n\n')
        return fullCtx
      }
    }

    // ── Stage 1: direct string search (tried first) ──────────────────────────
    const _today = new Date()
    const _dateTokens = [
      String(_today.getFullYear()),
      String(_today.getMonth() + 1).padStart(2, '0'),
      String(_today.getDate()).padStart(2, '0'),
    ]

    // Detect "latest/recent/these days" intent — decides the Stage 1 recency strategy
    const isRecencyQueryS1 = RECENCY_INTENT_RE.test(userMessage)

    // Date tokens are added only to recency-intent queries.
    // Adding "2026", "03", etc. to ordinary queries gives date-named documents a high filename score,
    // pushing genuinely relevant documents (body matches) out of the top seeds — a false positive.
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
        // getContentDate: falls back filename date → frontmatter date → mtime.
        // This vault is dominated by documents with dates in the filename, and 27.6% have no date field.
        const ms = getContentDate(d)
        if (isNaN(ms) || ms <= 0 || ms > now) return 0
        return RECENCY_COEFF * Math.exp(-(now - ms) / HALF_LIFE_MS)
      }
      directHitsCandidates.sort((a, b) => (b.score + recBoost(b.doc_id)) - (a.score + recBoost(a.doc_id)))
    }
    const directHits = directHitsCandidates.slice(0, sc.directHitSeeds)

    const hasStrongDirectHit = directHits.some(r => r.score >= sc.minDirectHitScore)

    // ── Strong filename match (score >= 0.4): inject full body directly + supplement with BFS related docs ──
    // score >= 0.4 = raw >= 4 = two or more query words matched in the filename
    // score >= 0.2 single matches (generic words like "meeting", "document") are used only as BFS seeds to avoid false positives
    const strongPinnedHits = directHits.filter(r => r.score >= sc.minPinnedScore)
    if (strongPinnedHits.length > 0) {
      const { multiAgentRAG, personaModels } = useSettingsStore.getState()

      // Top-1: the chief reads the full body directly (limited by maxDocChars)
      const topDoc = docMap.get(strongPinnedHits[0].doc_id)
      const pinnedParts: string[] = ['## Directly Referenced Documents (full content)\n']
      let hasPinnedContent = false
      // Track only doc IDs actually included in pinnedParts (failed worker docs go to BFS)
      const includedDocIds = new Set<string>()
      const MIN_PINNED_BODY = 100  // threshold to block stub documents (frontmatter only)
      if (topDoc) {
        const body = getStrippedBody(topDoc)
        if (body.trim().length >= MIN_PINNED_BODY) {
          const truncated = body.length > maxDocChars ? body.slice(0, maxDocChars).trimEnd() + '…' : body
          pinnedParts.push(`[Document] ${topDoc.filename.replace(/\.md$/i, '')}\n${truncated}\n\n`)
          hasPinnedContent = true
          includedDocIds.add(strongPinnedHits[0].doc_id)
        }
        // else: stub document — not pinned, falls through to BFS seeds
      }

      // Docs 2~N: branch strategy by hit count (capped at 5 to limit RPM)
      const secondaryHits = strongPinnedHits.slice(1, 6)
      if (secondaryHits.length > 0) {
        if (multiAgentRAG && !skipWorkers && secondaryHits.length >= 3) {
          // 3 or more: parallel Worker LLM summaries (compressed to 500 chars, max 5)
          const currentModelId = personaModels[currentSpeaker as DirectorId] ?? personaModels['chief_director']
          const { modelId: workerModelId, provider: workerProvider } = getWorkerModelId(currentModelId)
          const workerApiKey = getApiKey(workerProvider)
          if (workerApiKey) {
            onThinkingChunk?.(`📚 **Processing ${secondaryHits.length} Worker agents in parallel...**\n\n`)

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
                .map(({ doc, summary }) => `[Worker summary] ${doc.filename.replace(/\.md$/i, '')}\n${summary}\n`)
                .join('\n')
              pinnedParts.push('\n## Related document summaries (Worker)\n' + summarySection)
              hasPinnedContent = true

              // ── 2-team sub-agent synthesis ─────────────────────────────────────
              const narrativeSummaries: string[] = []
              const systemSummaries: string[] = []
              for (const { doc, summary } of validResults) {
                const domain = classifyDocDomain(doc)
                const entry = `[${doc.filename.replace(/\.md$/i, '')}]\n${summary}`
                if (domain === 'narrative') narrativeSummaries.push(entry)
                else systemSummaries.push(entry)
              }

              let subAgentSection = ''

              // Sub-agent synthesis — 8 second timeout (reusing module-level withTimeout)
              if (narrativeSummaries.length >= 1) {
                onThinkingChunk?.('\n\n**[Sub-agent A — Narrative/Character perspective]**\n')
                const synthesis = await withTimeout(
                  agentSynthesizeDomain(narrativeSummaries, userMessage, 'narrative', workerApiKey, workerProvider, workerModelId, onThinkingChunk),
                  8000, '',
                )
                if (synthesis) subAgentSection += `\n### Narrative/Character perspective\n${synthesis}`
              }

              if (systemSummaries.length >= 1) {
                onThinkingChunk?.('\n\n**[Sub-agent B — System/Gameplay perspective]**\n')
                const synthesis = await withTimeout(
                  agentSynthesizeDomain(systemSummaries, userMessage, 'system', workerApiKey, workerProvider, workerModelId, onThinkingChunk),
                  8000, '',
                )
                if (synthesis) subAgentSection += `\n### System/Gameplay perspective\n${synthesis}`
              }

              if (subAgentSection) {
                pinnedParts.push('\n## Sub-agent insights\n' + subAgentSection)
                onThinkingChunk?.('\n\n---\n')
              }
            }
          }
        } else {
          // 2~3: inject the first 1500 chars directly without Workers
          const directSections = secondaryHits
            .map(hit => {
              const doc = docMap.get(hit.doc_id)
              if (!doc) return ''
              const body = getStrippedBody(doc)
              const content = body.length > 1500 ? body.slice(0, 1500).trimEnd() + '…' : body
              return `[Document] ${doc.filename.replace(/\.md$/i, '')}\n${content}\n`
            })
            .filter(Boolean)
            .join('\n')
          if (directSections) {
            pinnedParts.push('\n## Related documents\n' + directSections)
            hasPinnedContent = true
            secondaryHits.forEach(hit => { if (docMap.has(hit.doc_id)) includedDocIds.add(hit.doc_id) })
          }
        }
      }

      if (hasPinnedContent) {
        const pinnedCtx = pinnedParts.join('')
        // Exclude only the documents actually included from the BFS seeds (failed worker docs are restored as BFS seeds)
        const bfsSeeds = directHits.filter(r => !includedDocIds.has(r.doc_id))
        const bfsCtx = await buildDeepGraphContext(bfsSeeds, 2, 10, tokenizeQuery(userMessage), currentSpeaker)
        logger.debug(`[RAG] Multi-agent: pinned=${pinnedCtx.length} chars, BFS=${bfsCtx.length} chars`)
        useGraphStore.getState().setAiHighlightNodes(directHits.map(r => r.doc_id))
        return pinnedCtx + (bfsCtx ? '\n' + bfsCtx : '')
      }
    }

    let seeds: import('@/types').SearchResult[]

    if (hasStrongDirectHit) {
      // Direct search results are sufficient → use them as primary seeds (fallback path)
      seeds = directHits
      logger.debug(`[RAG] Direct search first: ${seeds.map(r => r.filename).join(', ')}`)
    } else {
      // Direct matches insufficient → full vector search first, BM25 as supplement
      let candidates: import('@/types').SearchResult[] = []
      let searchMode = 'BM25'

      const anthropicKey = getApiKey('anthropic')

      // ── Metadata filter (detect speaker/tags, then pre-filter docs) ─────────
      const searchDocs = (sc.metadataFilter && vaultDocs)
        ? applyMetadataFilter(userMessage, vaultDocs)
        : (vaultDocs ?? [])

      // ── Query expansion (enrich search terms with LLM) ─────────────────────
      let searchQuery = userMessage
      if (sc.queryExpansion && anthropicKey) {
        searchQuery = await withTimeout(
          expandQueryWithLLM(userMessage, anthropicKey),
          5000, userMessage,
        )
        if (searchQuery !== userMessage) logger.debug(`[RAG] Query expansion: "${userMessage.slice(0, 30)}" → "${searchQuery.slice(0, 50)}"`)
      }

      const geminiKey = getApiKey('gemini')
      if (vectorEmbedIndex.isBuilt && await isEmbeddingReady(geminiKey)) {
        // ── Priority 1: full vector search (pure semantic similarity) ──────────
        try {
          const vecResults = await vectorEmbedIndex.fullVectorSearch(
            searchQuery, (geminiKey ?? ''), sc.bm25Candidates * 2, searchDocs,
          )
          if (vecResults && vecResults.length > 0) {
            // ── Vector threshold: use a relative value ──────────────────────
            // fullVectorSearch returns raw, un-normalized cosine. With BGE-M3 (L2-normalized),
            // cosine between Korean documents clusters in the narrow 0.4~0.75 band, so the absolute 0.1 threshold was a no-op.
            const vecTop = vecResults[0].score
            const vecMin = Math.max(0.35, vecTop * 0.6)
            const vecKept = vecResults.filter(r => r.score >= vecMin)
            const vecList = vecKept.length > 0 ? vecKept : vecResults.slice(0, sc.rerankSeeds)

            // BM25 supplement — match the fusion depth of the vector list
            const bm25Results = frontendKeywordSearch(
              userMessage, Math.max(sc.bm25Candidates, vecList.length), currentSpeaker, contextTerms,
            ).filter(r => r.score > sc.minBm25Score)

            // ── RRF fusion ─────────────────────────────────────────────────
            // Vector is raw cosine, BM25 is max-normalized → mixing both scores in one array
            // means a BM25 supplement doc (0.95) always beats the vector #1 (0.72).
            // Fuse via rank-based RRF to remove the dependence on score scales.
            // (This code is unaffected even if graphAnalysis changes its BM25 normalization)
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

            // Raw RRF scores are on a ≈0.03 scale, mismatched with downstream (rerankResults' weighted sum, llmRerank's 0.4/0.6 blend,
            // the _index.md seed at 0.15) → max-normalize with the top at 1.0 to restore a 0~1 scale.
            const topRrf = fused[0]?.score || 1
            candidates = fused.map(r => ({ ...r, score: r.score / topRrf }))
            // Set the mode only after candidates are final — if an exception occurs midway, the BM25 fallback below uses its own mode
            searchMode = 'vector'

            logger.debug(`[RAG] RRF fusion: vector ${vecList.length} (threshold ${vecMin.toFixed(2)}, top ${vecTop.toFixed(3)}) + BM25 ${bm25Results.length} → ${candidates.length}`)
          }
        } catch (e: unknown) {
          logger.warn('[vector] fullVectorSearch failed, falling back to BM25:', e instanceof Error ? e.message : String(e))
        }
      }

      if (candidates.length === 0) {
        // ── Priority 2: ChromaDB backend ───────────────────────────────────────
        if (typeof window !== 'undefined' && window.backendAPI) {
          try {
            const response = await window.backendAPI.search(userMessage, sc.bm25Candidates)
            candidates = response.results ?? []
            if (candidates.length > 0) searchMode = 'chromadb'
          } catch { /* backend not running */ }
        }
        // ── Priority 3: frontend BM25 ──────────────────────────────────────────
        if (candidates.length === 0) {
          candidates = frontendKeywordSearch(userMessage, sc.bm25Candidates * 4, currentSpeaker, contextTerms)
        }
      }

      logger.debug(`[RAG] ${searchMode} candidates: ${candidates.length} (query: "${searchQuery.slice(0, 40)}")`)

      // Vector-mode candidates were already filtered by the relative threshold before RRF fusion and their scores are rank-based,
      // so no absolute threshold is applied again here (the old `> 0.1` was a no-op on raw cosine and,
      // conversely, would cut most results on RRF-normalized scores).
      const relevant = searchMode === 'vector'
        ? candidates
        : candidates.filter(r => r.score > sc.minBm25Score)

      // ── LLM re-ranking ─────────────────────────────────────────────────────
      if (sc.llmRerank && anthropicKey && relevant.length > 0 && searchMode === 'vector') {
        const docMapLocal = new Map((vaultDocs ?? []).map(d => [d.id, d]))
        // Pass the frontmatter-stripped body to the reranker —
        // with raw rawContent, the snippet is filled entirely by the YAML header in 74.9% of documents.
        const augmented = relevant.map(r => {
          const d = docMapLocal.get(r.doc_id)
          return { ...r, rawContent: d ? getStrippedBody(d) : undefined }
        })
        const reranked = await withTimeout(
          llmRerankCandidates(userMessage, augmented, anthropicKey, sc.rerankSeeds),
          8000, relevant.slice(0, sc.rerankSeeds),
        )
        seeds = reranked
        logger.debug(`[RAG] LLM re-ranking complete: ${seeds.map(r => r.filename).join(', ')}`)
      } else {
        seeds = relevant.length > 0 ? rerankResults(relevant, userMessage, sc.rerankSeeds, currentSpeaker) : []
      }

      // Supplement documents missed by direct search
      const seedIds = new Set(seeds.map(r => r.doc_id))
      for (const hit of directHits) {
        if (!seedIds.has(hit.doc_id)) seeds.push(hit)
      }
    }

    // Always include _index.md
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
        score: 0.15,  // prevents PPR dominance — included as a seed but does not take the top score
        tags: indexDoc.tags ?? [],
      })
    }

    // ── related: auto-add frontmatter links to BFS seeds ─────────────────────
    // Include documents listed in the top seed documents' related: field as seeds to widen the BFS range
    {
      const existingSeedIds = new Set(seeds.map(r => r.doc_id))
      const relatedSeeds: import('@/types').SearchResult[] = []
      // Check only the top 5 seeds (prevents excessive expansion)
      for (const seed of seeds.slice(0, 5)) {
        const seedDoc = docMap.get(seed.doc_id)
        if (!seedDoc?.related?.length) continue
        for (const relLink of seedDoc.related) {
          // related values are in "[[filename]]" or "filename" form — normalize
          const cleanName = relLink.replace(/^\[\[|\]\]$/g, '').trim()
          if (!cleanName) continue
          // Match filename in docMap (try with and without extension)
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
              score: seed.score * 0.7,  // lower than the original seed — adjusts BFS priority
              tags: relDoc.tags ?? [],
            })
          }
        }
      }
      if (relatedSeeds.length > 0) {
        seeds.push(...relatedSeeds)
        logger.debug(`[RAG] related: seeds added: ${relatedSeeds.map(r => r.filename).join(', ')}`)
      }
    }

    // Version dedup: keep only the latest of v2/v3/v4 for the same document
    seeds = deduplicateVersions(seeds, docMap)

    // Recency intent detected: re-sort seeds by date descending so the newest documents lead the BFS
    // _index.md / currentSituation.md always stay at the top (they contain date info)
    const isRecencyQuery = RECENCY_INTENT_RE.test(userMessage)
    if (isRecencyQuery && seeds.length > 0) {
      const PINNED_HUB = /^(_index|currentSituation|chief[\s_]persona)/i
      const pinned = seeds.filter(r => PINNED_HUB.test(r.filename))
      const rest = seeds.filter(r => !PINNED_HUB.test(r.filename))
      rest.sort((a, b) => {
        // Filename date first — 27.6% of the vault's documents have no date frontmatter
        const da = docMap.get(a.doc_id), db = docMap.get(b.doc_id)
        const ra = da ? getContentDate(da) : 0
        const rb = db ? getContentDate(db) : 0
        return rb - ra
      })
      seeds = [...pinned, ...rest]
      logger.debug(`[RAG] Recency intent detected — seeds re-sorted by date: ${seeds.slice(0, 3).map(r => r.filename).join(', ')}`)
    }

    // Stage 2: BFS graph traversal — collect connected documents up to 3 hops from the seeds
    if (seeds.length > 0) {
      useGraphStore.getState().setAiHighlightNodes(seeds.map(r => r.doc_id))
    }
    const ctx = await buildDeepGraphContext(seeds, sc.bfsMaxHops, sc.bfsMaxDocs, tokenizeQuery(userMessage), currentSpeaker)
    logger.debug(`[RAG] Context built: ${ctx.length} chars`)

    // On recency intent, inject the date reference + vault data gap notice for the LLM
    if (isRecencyQuery) {
      const today = new Date().toISOString().slice(0, 10)
      // Compute the most recent document date in the vault (for the data gap warning)
      // Includes filename dates — mtime alone always yields "today" in a bulk-resynced vault
      const latestMs = vaultDocs
        ? Math.max(0, ...vaultDocs.map(d => getContentDate(d)).filter(ms => ms > 0 && ms <= Date.now()))
        : 0
      const latestDate = latestMs > 0 ? new Date(latestMs).toISOString().slice(0, 10) : null
      const gapWarning = latestDate && latestDate < today
        ? ` The most recent document in the vault is only up to **${latestDate}**. State that anything after that date is not recorded in the vault and is unknown.`
        : ''
      const preamble = `> ⚠️ **Date reference**: Today is ${today}.${gapWarning} Date fields are shown in the documents below. **For the latest information, prioritize documents with the most recent date.**\n\n`
      return preamble + ctx
    }
    return ctx
  } catch (err) {
    // RAG failure is non-fatal — continue without context
    logger.error('[RAG] fetchRAGContext error:', err)
    return ''
  }
}

// ── Shared system-prompt assembly ──────────────────────────────────────────────

/**
 * Structured reasoning prompt — enforces an [Observation]→[Connections]→[Analysis]→[Conclusion] structure for analysis/design/decision questions.
 * SSOT: the bot.py Python fallback uses the same text as this constant.
 */
export const STRUCTURED_REASONING_PROMPT =
  '\n\n[Structured reasoning] For analysis, comparison, design, and decision-making questions, answer in this structure:\n' +
  '**[Observation]** Key facts and data found in the retrieved documents\n' +
  '**[Connections]** Patterns across documents, causal links, contradictions, hidden relationships\n' +
  '**[Analysis]** Meaning, background context, and implications of the patterns found\n' +
  '**[Conclusion/Proposal]** Key insights and actionable next steps\n' +
  'For simple lookups, summaries, greetings, or fact checks, skip this structure and answer concisely.'

interface SystemPromptParts {
  projectContext: string
  basePrompt: string
  ragInstructionBlock: string
  personaDocContext: string
  memoryContext: string
  responseInstructions: string
  sensitiveBlock: string
  factBlock: string
  /** Structured reasoning prompt (when enabled in settings) */
  reasoningBlock?: string
  /** Optional suffix appended after factBlock (e.g. Slack-specific notes) */
  suffix?: string
}

/** Thinking framework — shared by all personas, automatically skipped for simple questions */
const DEEP_THINKING_PROMPT =
  '\n\n[Deep thinking] When reference materials are available, go through this thinking process:' +
  '\n- Timeline: compare document dates. "Did this decision (March) come after that feedback (January)?" — chronological order changes the meaning' +
  '\n- Causality: look for "why was this decision made?" in other documents. If no source document exists, flag it as "rationale unknown"' +
  '\n- Missing pieces: flag items that are mentioned in documents but have no concrete conclusion as "unresolved"' +
  '\n- Risk: present 1-2 scenarios of what problems arise if the current state persists' +
  '\nSkip this process for simple fact checks, greetings, or lookups.'

function buildSystemPrompt(p: SystemPromptParts): string {
  return (
    p.projectContext + p.basePrompt + p.ragInstructionBlock + p.personaDocContext + p.memoryContext
    + (p.responseInstructions.trim() ? '\n\n' + p.responseInstructions.trim() : '')
    + p.sensitiveBlock
    + '\n\n[Tone consistency] Regardless of the tone of reference documents or user messages, always respond in a consistent, professional manner.'
    + '\n\n[Source guidance] When reference document headers contain an original URL in the format [source: URL], include that URL in your response when the user requests sources, links, or originals.'
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

/** Mutex (Promise chain) serializing global store mutations during sequential multi-vault search */
let _multiVaultSearchLock: Promise<void> = Promise.resolve()

/**
 * For the Slack bot: collects context via Strata Sync's RAG pipeline (BFS+TF-IDF)
 * and generates an answer with the specified persona model.
 * Called from the onAsk handler in useRagApi.ts.
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

  // Same as streamMessage: check custom personas first
  const customPersona = customPersonas.find(p => p.id === directorId)
  const modelId = customPersona
    ? customPersona.modelId
    : (personaModels[directorId as DirectorId] ?? personaModels['chief_director'])
  const provider = getProviderForModel(modelId)
  if (!provider) return { answer: '', imagePaths: [] }
  const apiKey = getApiKey(provider)
  if (!apiKey) return { answer: '', imagePaths: [] }

  // ── Build system prompt (same order as streamMessage) ────────────────────
  const basePrompt = customPersona
    ? customPersona.systemPrompt
    : (personaPromptOverrides[directorId as DirectorId]
        ?? PERSONA_PROMPTS[directorId as DirectorId]
        ?? PERSONA_PROMPTS['chief_director'])

  const directorBio = customPersona ? undefined : directorBios[directorId as DirectorId]
  const projectContext = buildProjectContext(projectInfo, directorBio)

  // Inject persona document
  const personaDocId = personaDocumentIds[directorId]
  let personaDocContext = ''
  if (personaDocId) {
    const doc = useVaultStore.getState().loadedDocuments?.find(d => d.id === personaDocId)
    if (doc) {
      personaDocContext = `\n\n---\nBelow is persona reference material from the "${doc.filename}" document. Use this content to reference the person's perspective and tone:\n\n${doc.rawContent.slice(0, 4000)}`
    }
  }

  // Inject long-term memory
  const { memoryText } = useMemoryStore.getState()
  const memoryContext = memoryText.trim()
    ? `\n\n---\n## 📌 Previous conversation memory\n${memoryText.trim()}\n---`
    : ''

  const ragInstructionBlock = ragInstruction.trim() ? '\n\n' + ragInstruction.trim() : ''
  const factBlock_slack = _citationModeSlack ? FACT_BLOCK_CITATION : FACT_BLOCK_NO_CITATION
  // Inject priority-handling instruction when sensitive keywords match
  const matchedKeywords = sensitiveKeywords
    ? sensitiveKeywords.split(/[\n,]+/).map(k => k.trim()).filter(Boolean)
        .filter(k => query.toLowerCase().includes(k.toLowerCase()))
    : []
  const sensitiveBlock = matchedKeywords.length > 0
    ? `\n\n[Priority topic] This question contains the following key terms: ${matchedKeywords.map(k => `"${k}"`).join(', ')}. Search for information on this topic with the highest priority and answer comprehensively with all relevant details.`
    : ''

  const reasoningBlock = reasoningConfig.structuredReasoning ? STRUCTURED_REASONING_PROMPT : ''

  const systemPrompt = buildSystemPrompt({
    projectContext, basePrompt, ragInstructionBlock, personaDocContext, memoryContext,
    responseInstructions, sensitiveBlock, factBlock: factBlock_slack,
    reasoningBlock,
    suffix: '\n\n[Slack images] This conversation takes place via a Slack bot. When relevant images are found in the vault, the bot system attaches them automatically. Never use expressions like "I cannot show images" or "I don\'t have image capabilities". For image requests, describe the relevant content in text and inform that images are automatically handled by the system.',
  })

  // ── RAG context → prepended to the user message (Slack: skip workers, keep BFS) ──
  // Skip RAG for short greetings/interjections (avoids injecting unrelated project context)
  const isSmallTalk = /^(안녕|ㅎㅇ|hi|hello|hey|반가워|고마워|감사합니다|감사해|수고|고생|화이팅|파이팅|ㅋ+|ㄱ+|ㅇㅇ|ㅇㅋ|오케|굿|좋아|ㅇㄱ|ㄴㄴ|ㅠ+|ㅜ+)\s*[~!?♡]*$/i.test(query.trim())

  // Slack: search each vault in parallel, then merge contexts (reuses TF-IDF cache, inserts [source: vault name] headers)
  let _ragRaw = ''
  if (!isSmallTalk) {
    const vaultStoreState = useVaultStore.getState()
    const { vaultDocsCache, vaults, loadedDocuments } = vaultStoreState
    const activeVaultId = vaultStoreState.activeVaultId
    const vaultEntries = Object.entries(vaultDocsCache)
    if (vaultEntries.length <= 1) {
      // Single vault → existing approach
      _ragRaw = await fetchRAGContext(query, directorId, 8000, true)
    } else {
      // Multiple vaults → full RAG for the active vault, score-based keyword search for the others
      // ※ No longer swaps store.loadedDocuments — avoids React re-renders + OOM crashes
      const perVaultLimit = Math.floor(6000 / vaultEntries.length)
      const parts: string[] = []

      // Active vault: full RAG (graph + vector + BM25)
      const activeLabel = vaults[activeVaultId]?.label ?? activeVaultId
      const activeCtx = await fetchRAGContext(query, directorId, perVaultLimit, true)
      if (activeCtx.trim()) parts.push(`\n# [source: ${activeLabel}]\n${activeCtx}`)

      // 2-gram Korean auxiliary tokenizer — recovers matching for short queries + Korean text
      const grams = (s: string): string[] =>
        s.length < 2 ? [s] : Array.from({ length: s.length - 1 }, (_, i) => s.slice(i, i + 2))

      // Query tokens: whitespace-separated words + Korean 2-grams
      const qRaw = query.toLowerCase().trim()
      const qWords = qRaw.split(/\s+/).filter(w => w.length > 1)
      const qGrams: string[] = []
      for (const w of qWords) {
        if (/[\uac00-\ud7a3]/.test(w)) qGrams.push(...grams(w))
      }
      const qTerms = Array.from(new Set([...qWords, ...qGrams]))

      // Additional vault fallback: use loadedDocuments when activeVaultId is not in the cache
      const cacheMap = new Map(vaultEntries)
      if (activeVaultId && !cacheMap.has(activeVaultId) && loadedDocuments?.length) {
        cacheMap.set(activeVaultId, loadedDocuments)
      }

      for (const [vaultId, docs] of cacheMap) {
        if (vaultId === activeVaultId || !docs?.length) continue
        const label = vaults[vaultId]?.label ?? vaultId

        // Score-based ranking: (word match count / log(document length))
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
          parts.push(`\n# [source: ${label}]\n${ctx.slice(0, perVaultLimit)}`)
        }
      }
      _ragRaw = parts.join('\n')
    }
  }

  // In small-vault full injection mode allow up to fullVaultThreshold; regular RAG is capped at 10K (for the 30K TPM limit)
  const _fvt = useSettingsStore.getState().searchConfig.fullVaultThreshold
  const _isFullVault = _fvt > 0 && _ragRaw.length > 0 && _ragRaw.length <= _fvt
  const _ragCap = _isFullVault ? _fvt : 10000
  const ragContext = _ragRaw.length > _ragCap ? _ragRaw.slice(0, _ragCap).trimEnd() + '\n…(context truncated)' : _ragRaw

  // Slack: skip web search (saves the ~5s LLM decision call)
  let fullUserMessage = query
  if (ragContext) {
    fullUserMessage = `${ragContext}The above materials were collected via the vault WikiLink graph.\nDo not simply list these materials; cross-analyze document dates and context to point out connections and risks the user may not be aware of.\n\n---\n\n${query}`
  }

  // Previous conversation history (Slack: max 6 messages = 3 turns, saves TPM)
  const historyMessages = history.slice(-6)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: sanitize(m.content),
    }))

  // Drop the history entry that is the current turn (it is added separately below, avoids duplication)
  const _lastUserIdxSlack = currentTurnIdx(historyMessages, query)
  const filteredHistory = historyMessages.filter((_, i) => i !== _lastUserIdxSlack)

  // Convert image attachments to an Attachment array (the format shared by providers)
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

  // Collect related image paths from the top RAG result documents (for auto-attaching vault images)
  // ※ Include only when the image filename matches a query word — exclude cases where only the document is relevant and the image is not
  const { imagePathRegistry, loadedDocuments: allDocs } = useVaultStore.getState()
  const imagePaths: string[] = []
  if (imagePathRegistry && allDocs) {
    const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
    const seen = new Set<string>()

    // Helper that checks whether a filename matches a query word
    const filenameMatches = (ref: string) => {
      if (qWords.length === 0) return false
      const base = (ref.split(/[/\\]/).pop() ?? ref).toLowerCase()
      return qWords.some(w => base.includes(w))
    }

    // Priority 1: only imageRefs from matched documents whose filename relates to the query
    const topHits = directVaultSearch(query, 5)
    const docMap = new Map(allDocs.map(d => [d.id, d]))
    for (const hit of topHits) {
      const doc = docMap.get(hit.doc_id)
      if (!doc?.imageRefs?.length) continue
      for (const ref of doc.imageRefs) {
        if (!filenameMatches(ref)) continue  // filename relevance filter
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

    // Priority 2: match query words against imageRegistry filenames (standalone image files with no embeds)
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
  overrideRagContext?: string,   // bypasses keyword search — used for node-selection AI analysis, etc.
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
  if (!model) { logger.error(`[LLM] Unknown model ID: ${modelId}`); onChunk('Model configuration error: unknown model.'); return }

  // Resolve system prompt: custom persona > built-in override > built-in default
  const basePrompt = customPersona
    ? customPersona.systemPrompt
    : (personaPromptOverrides[persona] ?? PERSONA_PROMPTS[persona as DirectorId] ?? '')

  // Director bio only applies to built-in personas
  const directorBio = customPersona ? undefined : directorBios[persona as DirectorId]
  const projectContext = buildProjectContext(projectInfo, directorBio)

  // ── Persona document injection ──────────────────────────────────────────────
  // If a vault document is linked to this persona in settings, inject it into the system prompt
  const personaDocId = personaDocumentIds[persona]
  let personaDocContext = ''
  if (personaDocId) {
    const doc = useVaultStore.getState().loadedDocuments?.find(d => d.id === personaDocId)
    if (doc) {
      personaDocContext = `\n\n---\nBelow is persona reference material from the "${doc.filename}" document. Use this content to reference the person's perspective and tone:\n\n${doc.rawContent.slice(0, 4000)}`
    }
  }

  // ── AI long-term memory injection ──────────────────────────────────────────
  const { memoryText } = useMemoryStore.getState()
  const memoryContext = memoryText.trim()
    ? `\n\n---\n## 📌 Previous conversation memory\n${memoryText.trim()}\n---`
    : ''

  // ── Conversation history context analysis ──────────────────────────────────
  const contextTerms = DEICTIC_RE.test(userMessage)
    ? extractContextTerms(history)
    : undefined
  if (contextTerms?.length) {
    logger.debug(`[RAG] History context enrichment: ${contextTerms.slice(0, 6).join(', ')}`)
  }

  // ── Graph-Augmented RAG context injection ──────────────────────────────────
  // If overrideRagContext is provided, use it as-is without keyword search (direct node-selection analysis, etc.)
  const ragContext = overrideRagContext !== undefined
    ? overrideRagContext
    : await fetchRAGContext(userMessage, persona, 20000, false, onThinkingChunk, contextTerms)

  // ── Web search (runs only when the "internet search" intent is detected) ──
  let webCtx = ''
  if (overrideRagContext === undefined && webSearchEnabled && WEB_SEARCH_INTENT_RE.test(userMessage)
      && typeof window !== 'undefined' && (window as any).webSearchAPI) {
    webCtx = await mainAgentWebSearch(userMessage, ragContext, modelId, provider, apiKey)
  }

  const ragInstructionBlock = ragInstruction.trim() ? '\n\n' + ragInstruction.trim() : ''
  const factBlock = citationMode ? FACT_BLOCK_CITATION : FACT_BLOCK_NO_CITATION
  // Inject priority-handling instruction when sensitive keywords match
  const _matchedKw = sensitiveKeywords
    ? sensitiveKeywords.split(/[\n,]+/).map(k => k.trim()).filter(Boolean)
        .filter(k => userMessage.toLowerCase().includes(k.toLowerCase()))
    : []
  const _sensitiveBlock = _matchedKw.length > 0
    ? `\n\n[Priority topic] This question contains the following key terms: ${_matchedKw.map(k => `"${k}"`).join(', ')}. Search for information on this topic with the highest priority and answer comprehensively with all relevant details.`
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
          ? a.dataUrl.slice(0, TEXT_ATTACH_MAX) + '\n…(content truncated)'
          : a.dataUrl
        return `\n\n[Attached file: ${a.name}]\n${content}`
      })
      .join('')
    fullUserMessage = userMessage + textContext
  }

  // Prepend RAG context + web search results to the user message
  const combinedCtx = [ragContext, webCtx].filter(Boolean).join('\n')
  if (combinedCtx) {
    const srcLabel = ragContext && webCtx
      ? 'the vault WikiLink graph and web search'
      : ragContext ? 'the vault WikiLink graph' : 'web search'
    fullUserMessage = `${combinedCtx}The above materials were collected via ${srcLabel}.\nDo not simply list these materials; cross-analyze document dates and context to point out connections and risks the user may not be aware of.\n\n---\n\n${fullUserMessage}`
  }

  // Build message history, excluding the entry that is the current turn being sent
  const _lastUserIdx = currentTurnIdx(history, userMessage)
  let historyMessages = toHistoryMessages(
    history.filter((_, i) => i !== _lastUserIdx)
  )

  // ── Context compaction: if the history is too long, summarize older messages and inject into the system prompt ──
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
          'Summarize the conversation in 300 characters.',
          [{ role: 'user' as const, content: sanitize(oldText) }],
          (c: string) => { compactSummary += c },
        )
        if (compactSummary.trim()) {
          finalSystemPrompt += `\n\n## Previous conversation summary (auto-compaction)\n${compactSummary.trim()}`
          historyMessages = recentMessages
          // Also auto-save the compaction summary to AI long-term memory
          const timestamp = new Date().toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
          useMemoryStore.getState().appendToMemory(`[${timestamp} auto summary]\n${compactSummary.trim()}`)
          logger.debug(`[Compaction] ${histChars} chars → last 8 messages + summary injected + memory saved`)
        }
      }
    } catch (e) {
      logger.warn('[Compaction] failed — using full history:', e)
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
        onChunk('[Grok does not support image analysis. Only text will be processed.]\n\n')
      }
      await streamCompletion(apiKey, modelId, cleanSystemPrompt, allMessages, onChunk, [], onUsage, signal)
      break
    }
    default: {
      await streamMockResponse(persona, userMessage, onChunk)
    }
  }

  // Clear chat RAG highlights (GraphPanel analysis manages its own)
  if (overrideRagContext === undefined) {
    useGraphStore.getState().setAiHighlightNodes([])
  }
}

// ── Raw LLM stream (for the Edit Agent) ──────────────────────────────────────

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
  // Every provider's streamCompletion accepts a `signal?: AbortSignal` parameter.
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
      personaDocContext = `\n\n---\nBelow is persona reference material from the "${doc.filename}" document. Use this content to reference the person's perspective and tone:\n\n${doc.rawContent.slice(0, 4000)}`
    }
  }

  const { memoryText } = useMemoryStore.getState()
  const memoryContext = memoryText.trim()
    ? `\n\n---\n## 📌 Previous conversation memory\n${memoryText.trim()}\n---`
    : ''

  // ── Conversation history context analysis (same as streamMessage) ──────────
  const contextTerms = DEICTIC_RE.test(userMessage)
    ? extractContextTerms(history)
    : undefined
  if (contextTerms?.length) {
    logger.debug(`[RAG/tools] History context enrichment: ${contextTerms.slice(0, 6).join(', ')}`)
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
    ? `\n\n[Priority topic] This question contains the following key terms: ${_matchedKw.map(k => `"${k}"`).join(', ')}. Search for information on this topic with the highest priority and answer comprehensively with all relevant details.`
    : ''

  const { vaultPath } = useVaultStore.getState()

  // Tool capability notice in system prompt — include vault path so LLM uses correct absolute paths
  const vaultPathHint = vaultPath
    ? `\nVault path: ${vaultPath} — the path for file tools must be an absolute path starting with this path. e.g. ${vaultPath}/active/filename.md`
    : ''
  const toolNotice = `\n\n[Tools available] You can directly use vault tools such as file read/write, Jira issue management, and Confluence page creation/editing. When the user asks to write documents, create issues, or modify files, make active use of the tools.${vaultPathHint}`

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
          ? a.dataUrl.slice(0, TEXT_ATTACH_MAX) + '\n…(content truncated)'
          : a.dataUrl
        return `\n\n[Attached file: ${a.name}]\n${content}`
      })
      .join('')
    fullUserMessage = userMessage + textContext
  }

  const combinedCtx = [ragContext, webCtx].filter(Boolean).join('\n')
  if (combinedCtx) {
    const srcLabel = ragContext && webCtx
      ? 'the vault WikiLink graph and web search'
      : ragContext ? 'the vault WikiLink graph' : 'web search'
    fullUserMessage = `${combinedCtx}The above materials were collected via ${srcLabel}.\nDo not simply list these materials; cross-analyze document dates and context to point out connections and risks the user may not be aware of.\n\n---\n\n${fullUserMessage}`
  }

  // Exclude the history entry that is the current turn being sent
  const _lastUserIdxTools = currentTurnIdx(history, userMessage)
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
