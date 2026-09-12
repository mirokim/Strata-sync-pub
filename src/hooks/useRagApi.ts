/**
 * useRagApi.ts — Slack bot의 HTTP RAG 요청을 처리하는 훅
 *
 * Electron main.cjs의 HTTP 서버(7331)가 rag:search IPC를 보내면
 * fullVectorSearch (Gemini 임베딩) → BM25 fallback 으로 검색하여 결과를 돌려줍니다.
 */
import { useEffect, useRef } from 'react'
import { useVaultStore } from '@/stores/vaultStore'
import { useSettingsStore, getApiKey } from '@/stores/settingsStore'
import { frontendKeywordSearch, getStrippedBody } from '@/lib/graphRAG'
import { vectorEmbedIndex, rrfScore, isEmbeddingReady } from '@/lib/vectorEmbedIndex'
import { generateSlackAnswer, expandQueryWithLLM, llmRerankCandidates, applyMetadataFilter } from '@/services/llmClient'
import { PERSONA_PROMPTS } from '@/lib/personaPrompts'
import type { RagDocResult } from '@/vite-env'
import { runSimulation } from '@/services/mirofish/simulationEngine'
import { generateReport } from '@/services/mirofish/reportGenerator'
import { generatePersonas } from '@/services/mirofish/personaGenerator'
import { useMiroStore } from '@/stores/miroStore'
import type { MirofishPost } from '@/services/mirofish/types'
import { cleanSearchQuery } from '@/lib/stringUtils'

const QUERY_EXPAND_TIMEOUT_MS = 5000;
const RERANK_TIMEOUT_MS = 8000;
const RAG_BODY_TRUNCATE_LENGTH = 4000;
// BM25 점수가 상대(1위=항상 1.0)에서 절대 스케일로 바뀌었다(TFIDF_SCHEMA_VERSION 8).
// 실측 분포: 관련 쿼리 1위 0.57~0.83, 완전 무관 쿼리 최고 0.18.
const BM25_SCORE_THRESHOLD = 0.2;
const MAX_IMAGE_RESULTS = 5;

export function useRagApi() {
  const mirofishInFlightRef = useRef(false)

  // ── 1. 검색 관련: onSearch, onGetSettings ────────────────────────────────
  useEffect(() => {
    if (!window.ragAPI) return

    const cleanupSearch = window.ragAPI.onSearch(async ({ requestId, query, topN }) => {
      try {
        const api = window.ragAPI
        if (!api) return
        const docs = useVaultStore.getState().loadedDocuments
        if (!docs || !docs.length) {
          api.sendResult(requestId, [])
          return
        }

        // 검색 전 메타 지시 표현 제거 (BM25/벡터 오염 방지)
        const cleanedQuery = cleanSearchQuery(query)
        const sc = useSettingsStore.getState().searchConfig

        // ── 메타데이터 필터 ───────────────────────────────────────────────
        const searchDocs = sc.metadataFilter ? applyMetadataFilter(cleanedQuery, docs) : docs

        // ── 쿼리 확장 ─────────────────────────────────────────────────────
        const anthropicKey = getApiKey('anthropic')
        let searchQuery = cleanedQuery
        if (sc.queryExpansion && anthropicKey) {
          try {
            const expanded = await Promise.race([
              expandQueryWithLLM(cleanedQuery, anthropicKey),
              new Promise<string>(r => setTimeout(() => r(cleanedQuery), QUERY_EXPAND_TIMEOUT_MS)),
            ])
            if (expanded && expanded !== cleanedQuery) searchQuery = expanded
          } catch { /* fallback to original */ }
        }

        // 공유 docMap — 이후 결과 조합에서도 재사용
        const docMap = new Map(docs.map(d => [d.id, d]))

        // 1순위: fullVectorSearch — 듀얼 트랙 (내부 문서 80% + 게임 레퍼런스 20%)
        let searchResults: { doc_id: string; score: number; filename?: string; rawContent?: string }[] = []
        const geminiKey = getApiKey('gemini')
        if (vectorEmbedIndex.isBuilt && await isEmbeddingReady(geminiKey)) {
          // 트랙 분리: 내부 문서 vs 게임 레퍼런스 (external-reference)
          const internalDocs = searchDocs.filter(d => d.type !== 'external-reference')
          const gameRefDocs  = docs.filter(d => d.type === 'external-reference') // 메타 필터 우회 — 항상 포함
          const internalTopN = Math.max(1, Math.round(topN * 0.8))
          const gameRefTopN  = Math.max(2, Math.round(topN * 0.2))

          const [internalHits, gameRefHits] = await Promise.all([
            internalDocs.length > 0
              ? vectorEmbedIndex.fullVectorSearch(searchQuery, (geminiKey ?? ''), internalTopN * 2, internalDocs)
              : Promise.resolve(null),
            gameRefDocs.length > 0
              ? vectorEmbedIndex.fullVectorSearch(searchQuery, (geminiKey ?? ''), gameRefTopN, gameRefDocs)
              : Promise.resolve(null),
          ])

          // 리랭커에 넘길 본문 — 프론트매터를 제거한 getStrippedBody 사용.
          // rawContent 원본은 이 볼트 문서의 74.9%에서 스니펫이 YAML 헤더만으로 채워진다.
          const bodyOf = (docId: string) => {
            const d = docMap.get(docId)
            return d ? getStrippedBody(d) : undefined
          }

          const combined: typeof searchResults = []
          if (internalHits && internalHits.length > 0) {
            combined.push(...internalHits.map(r => ({
              doc_id: r.doc_id, score: r.score, filename: r.filename,
              rawContent: bodyOf(r.doc_id),
            })))
          }
          // 게임 레퍼런스: 중복 제거 후 항상 추가
          if (gameRefHits && gameRefHits.length > 0) {
            const seen = new Set(combined.map(r => r.doc_id))
            for (const r of gameRefHits) {
              if (!seen.has(r.doc_id)) combined.push({
                doc_id: r.doc_id, score: r.score, filename: r.filename,
                rawContent: bodyOf(r.doc_id),
              })
            }
          }

          if (combined.length > 0) {
            searchResults = combined

            // RRF 합산: 벡터 순위 + BM25 순위를 Reciprocal Rank Fusion으로 통합.
            // BM25 깊이를 벡터 후보 수에 맞춘다 — 한쪽만 얕으면 융합이 한쪽으로 기운다.
            const fusionDepth = Math.max(topN, combined.length)
            const bm25Hits = frontendKeywordSearch(cleanedQuery, fusionDepth)
              .filter(r => r.score > BM25_SCORE_THRESHOLD)
            const bm25RankMap = new Map<string, number>()
            for (let i = 0; i < bm25Hits.length; i++) bm25RankMap.set(bm25Hits[i].doc_id, i + 1)

            // 벡터 순위: 두 트랙(내부/게임 레퍼런스)을 cosine 기준으로 다시 합쳐 단일 순위 부여.
            // 트랙별 독립 순위는 나무위키 외부 레퍼런스 1위가 내부 문서 1위와 같은 vecRank=1을
            // 받아 RRF 점수가 동률이 되는 문제가 있었다 (내부 질문에도 외부 자료가 최상위에 노출).
            const vecRankMap = new Map<string, number>()
            const rankedByCosine = [...combined].sort((a, b) => b.score - a.score)
            for (let i = 0; i < rankedByCosine.length; i++) {
              vecRankMap.set(rankedByCosine[i].doc_id, i + 1)
            }

            // BM25에만 있는 내부 문서 추가
            const vecIds = new Set(searchResults.map(r => r.doc_id))
            for (const r of bm25Hits) {
              const doc = docMap.get(r.doc_id)
              if (!vecIds.has(r.doc_id) && doc?.type !== 'external-reference') {
                searchResults.push({
                  doc_id: r.doc_id, score: 0, filename: r.filename,
                  rawContent: bodyOf(r.doc_id),
                })
              }
            }

            // 전체 문서에 RRF 스코어 부여
            const missRank = rankedByCosine.length + bm25Hits.length + 1
            const fused = searchResults.map(r => {
              const vecRank = vecRankMap.get(r.doc_id) ?? missRank
              const bm25Rank = bm25RankMap.get(r.doc_id) ?? missRank
              return { ...r, score: rrfScore([vecRank, bm25Rank]) }
            }).sort((a, b) => b.score - a.score)

            // RRF 원점수(≈0.03)를 그대로 llmRerankCandidates에 넘기면 score*0.4 항이 사라져
            // LLM 점수가 사실상 100% 가중치를 갖는다 → 상위 1.0 기준 max 정규화.
            const topRrf = fused[0]?.score || 1
            searchResults = fused.map(r => ({ ...r, score: r.score / topRrf }))

            // ── LLM 리랭킹 ───────────────────────────────────────────────
            if (sc.llmRerank && anthropicKey && searchResults.length > 0) {
              try {
                searchResults = await Promise.race([
                  llmRerankCandidates(cleanedQuery, searchResults, anthropicKey, topN * 2),
                  new Promise<typeof searchResults>(r => setTimeout(() => r(searchResults), RERANK_TIMEOUT_MS)),
                ])
              } catch { /* keep original order */ }
            }
          }
        }

        // 2순위: BM25 fallback (벡터 인덱스 없거나 API 실패 시)
        if (searchResults.length === 0) {
          searchResults = frontendKeywordSearch(cleanedQuery, topN).map(r => ({ doc_id: r.doc_id, score: r.score }))
        }

        const sorted = searchResults
          .sort((a, b) => b.score - a.score)
          .slice(0, topN)

        const results: RagDocResult[] = []

        for (const { doc_id: docId, score } of sorted) {
          const doc = docMap.get(docId)
          if (!doc) continue
          const isExtRef = doc.type === 'external-reference'
          const rawBody  = getStrippedBody(doc).slice(0, RAG_BODY_TRUNCATE_LENGTH)
          const refGame  = (doc.frontmatter?.ref_game as string | undefined)
            ?? doc.filename.replace(/^\[게임\]\s*/, '').replace(/\.md$/i, '')
          const refDate  = (doc.frontmatter?.ref_collected as string | undefined) ?? doc.date ?? ''
          const body = isExtRef
            ? `[외부게임 레퍼런스 — ${refGame} / 나무위키 / ${refDate}]\n${rawBody}\n[끝 — 위는 외부 게임 데이터이며 프로젝트A 내부 문서가 아님]`
            : rawBody
          results.push({
            doc_id:   docId,
            filename: doc.filename,
            stem:     doc.filename.replace(/\.md$/i, ''),
            title:    doc.title || doc.filename,
            date:     doc.date  || '',
            tags:     doc.tags  || [],
            body,
            score,
          })
        }

        // 쿼리에 "최신/최근/올해 연도" 가 있으면 날짜 부스팅
        const curYear  = String(new Date().getFullYear())
        const prevYear = String(new Date().getFullYear() - 1)
        if (/최신|최근/.test(query) || query.includes(curYear)) {
          results.sort((a, b) => {
            const ba = a.date.includes(curYear) ? 2 : a.date.includes(prevYear) ? 1 : 0
            const bb = b.date.includes(curYear) ? 2 : b.date.includes(prevYear) ? 1 : 0
            return bb !== ba ? bb - ba : b.score - a.score
          })
        }

        api.sendResult(requestId, results)
      } catch (err) {
        console.error('[useRagApi] search error:', err)
        window.ragAPI?.sendResult(requestId, [])
      }
    })

    // Handle settings requests
    const cleanupSettings = window.ragAPI.onGetSettings(({ requestId }) => {
      const { personaModels, personaPromptOverrides, selfReview, nAgents, apiKeys, slackBotConfig } = useSettingsStore.getState()
      const s = (id: keyof typeof PERSONA_PROMPTS) =>
        personaPromptOverrides[id] || PERSONA_PROMPTS[id]
      const personas = {
        chief: { name: 'PM',             emoji: '🎯', system: s('chief_director') },
        art:   { name: '아트 디렉터',    emoji: '🎨', system: s('art_director')   },
        spec:  { name: '기획 디렉터',    emoji: '📐', system: s('plan_director')  },
        tech:  { name: '프로그래밍 디렉터', emoji: '⚙️', system: s('prog_director') },
      }
      const { imageDirectPass } = useMiroStore.getState().config
      const { scheduledTopics, presets } = useMiroStore.getState()
      // SEC-2: Slack 봇은 Anthropic 키만 필요 — 전체 apiKeys 노출 방지
      const safeApiKeys = { anthropic: apiKeys['anthropic'] ?? '' }
      const slackModel = slackBotConfig?.model || null
      window.ragAPI?.sendResult(requestId, { personaModels, personas, imageDirectPass, scheduledTopics, presets, selfReview, nAgents, apiKeys: safeApiKeys, slackModel })
    })

    return () => { cleanupSearch(); cleanupSettings() }
  }, [])

  // ── 2. 채팅/이미지 관련: onAsk, onGetImages ──────────────────────────────
  useEffect(() => {
    if (!window.ragAPI) return

    // Handle full answer generation (Slack /ask endpoint)
    const cleanupAsk = window.ragAPI.onAsk(async ({ requestId, query, directorId, history, images }) => {
      try {
        const result = await generateSlackAnswer(query, directorId, history ?? [], images)
        window.ragAPI?.sendResult(requestId, result)
      } catch (err) {
        console.error('[useRagApi] ask error:', err)
        window.ragAPI?.sendResult(requestId, { answer: '', imagePaths: [] })
      }
    })

    // Handle explicit image search (Slack /images endpoint)
    const cleanupImages = window.ragAPI.onGetImages?.(({ requestId, query }) => {
      const { imagePathRegistry, loadedDocuments } = useVaultStore.getState()
      if (!imagePathRegistry) {
        window.ragAPI?.sendResult(requestId, { paths: [] })
        return
      }
      const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 1)
      const seen = new Set<string>()
      const paths: string[] = []

      // 1순위: 쿼리 단어가 포함된 문서의 imageRefs 중 파일명도 일치하는 것만
      if (loadedDocuments) {
        const matchingDocs = loadedDocuments.filter(doc => {
          const text = (doc.filename + ' ' + (doc.rawContent ?? '')).toLowerCase()
          return words.some(w => text.includes(w))
        })
        for (const doc of matchingDocs) {
          for (const ref of doc.imageRefs ?? []) {
            const basename = ref.split(/[/\\]/).pop() ?? ref
            // 파일명이 쿼리 단어와 매칭될 때만 포함 (문서만 관련 있고 이미지는 무관한 경우 제외)
            if (!words.some(w => basename.toLowerCase().includes(w))) continue
            const entry = imagePathRegistry[ref] ?? imagePathRegistry[basename]
            if (entry?.absolutePath && !seen.has(entry.absolutePath)) {
              seen.add(entry.absolutePath)
              paths.push(entry.absolutePath)
              if (paths.length >= MAX_IMAGE_RESULTS) break
            }
          }
          if (paths.length >= MAX_IMAGE_RESULTS) break
        }
      }

      // 2순위: imageRegistry 파일명에서 단어 매칭
      if (paths.length < MAX_IMAGE_RESULTS) {
        for (const [name, entry] of Object.entries(imagePathRegistry)) {
          if (!entry || typeof entry.absolutePath !== 'string') continue
          const n = name.toLowerCase()
          if (words.some(w => n.includes(w)) && !seen.has(entry.absolutePath)) {
            seen.add(entry.absolutePath)
            paths.push(entry.absolutePath)
            if (paths.length >= MAX_IMAGE_RESULTS) break
          }
        }
      }

      window.ragAPI?.sendResult(requestId, { paths })
    })

    return () => { cleanupAsk(); cleanupImages?.() }
  }, [])

  // ── 3. MiroFish/볼트 관련: onMirofish, onGetVaultPath ───────────────────
  useEffect(() => {
    if (!window.ragAPI) return

    // Handle MiroFish simulation requests (Slack /mirofish endpoint)
    const cleanupMirofish = window.ragAPI.onMirofish?.(async ({ requestId, topic, numPersonas, numRounds, modelId, context, segment, presetPersonas, images }) => {
      if (mirofishInFlightRef.current) {
        console.warn('[useRagApi] mirofish 이미 실행 중 — 중복 요청 무시')
        window.ragAPI?.sendResult(requestId, { feed: [], report: '시뮬레이션이 이미 실행 중입니다. 잠시 후 다시 시도하세요.' })
        return
      }
      mirofishInFlightRef.current = true
      try {
        // presetPersonas가 전달되면 LLM 생성 없이 그대로 사용
        const personas = presetPersonas?.length
          ? presetPersonas
          : await generatePersonas(topic, numPersonas, modelId, context, segment)
        if (!personas.length) throw new Error('페르소나 생성 결과가 없습니다')
        const feed: MirofishPost[] = []
        const abort = new AbortController()
        let currentRound = 0

        // 시뮬레이션 시작 알림
        window.electronAPI?.ipcSend?.('rag:mirofish:progress', { running: true, feed: [], round: 0, totalRounds: numRounds })

        await runSimulation(
          { topic, numPersonas, numRounds, modelId, autoGeneratePersonas: false, imageDirectPass: !!images?.length, personas, context, images },
          (event) => {
            if (event.type === 'post-done' && event.post) {
              feed.push(event.post)
              // 실시간 진행 상태 전송 (Slack 봇 폴링용)
              window.electronAPI?.ipcSend?.('rag:mirofish:progress', {
                running: true, feed: [...feed], round: event.post.round, totalRounds: numRounds,
              })
            } else if (event.type === 'round-done' && event.round != null) {
              currentRound = event.round
            }
          },
          abort.signal,
        )

        // 완료 알림
        window.electronAPI?.ipcSend?.('rag:mirofish:progress', { running: false, feed: [...feed], round: currentRound, totalRounds: numRounds })

        const report = await generateReport(topic, feed, modelId)
        window.ragAPI?.sendResult(requestId, { feed, report })
      } catch (err) {
        console.error('[useRagApi] mirofish error:', err)
        window.ragAPI?.sendResult(requestId, { feed: [], report: `오류: ${err instanceof Error ? err.message : String(err)}` })
      } finally {
        mirofishInFlightRef.current = false
      }
    })

    // Handle vault path requests (/mirofish-save 폴백용)
    const cleanupVaultPath = window.ragAPI.onGetVaultPath?.(({ requestId }: { requestId: string }) => {
      const vaultPath = useVaultStore.getState().vaultPath ?? null
      window.ragAPI?.sendResult(requestId, vaultPath)
    })

    return () => { mirofishInFlightRef.current = false; cleanupMirofish?.(); cleanupVaultPath?.() }
  }, [])
}
