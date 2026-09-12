/**
 * useRagApi.ts — Hook that handles HTTP RAG requests from the Slack bot
 *
 * When the HTTP server (7331) in Electron's main.cjs sends a rag:search IPC,
 * searches via fullVectorSearch (Gemini embeddings) → BM25 fallback and returns the results.
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
// BM25 scores changed from relative (top hit = always 1.0) to an absolute scale (TFIDF_SCHEMA_VERSION 8).
// Measured distribution: top hit for relevant queries 0.57–0.83, best for completely unrelated queries 0.18.
const BM25_SCORE_THRESHOLD = 0.2;
const MAX_IMAGE_RESULTS = 5;

export function useRagApi() {
  const mirofishInFlightRef = useRef(false)

  // ── 1. Search: onSearch, onGetSettings ───────────────────────────────────
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

        // Strip meta-instruction phrases before searching (avoids polluting BM25/vector search)
        const cleanedQuery = cleanSearchQuery(query)
        const sc = useSettingsStore.getState().searchConfig

        // ── Metadata filter ───────────────────────────────────────────────
        const searchDocs = sc.metadataFilter ? applyMetadataFilter(cleanedQuery, docs) : docs

        // ── Query expansion ───────────────────────────────────────────────
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

        // Shared docMap — reused when assembling results later
        const docMap = new Map(docs.map(d => [d.id, d]))

        // 1st choice: fullVectorSearch — dual track (internal docs 80% + game references 20%)
        let searchResults: { doc_id: string; score: number; filename?: string; rawContent?: string }[] = []
        const geminiKey = getApiKey('gemini')
        if (vectorEmbedIndex.isBuilt && await isEmbeddingReady(geminiKey)) {
          // Track split: internal docs vs game references (external-reference)
          const internalDocs = searchDocs.filter(d => d.type !== 'external-reference')
          const gameRefDocs  = docs.filter(d => d.type === 'external-reference') // Bypasses the metadata filter — always included
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

          // Body passed to the reranker — uses getStrippedBody with frontmatter removed.
          // With raw rawContent, 74.9% of this vault's documents get a snippet consisting solely of the YAML header.
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
          // Game references: always appended after deduplication
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

            // RRF merge: combines vector rank + BM25 rank via Reciprocal Rank Fusion.
            // Match the BM25 depth to the vector candidate count — if one side is shallow the fusion tilts toward the other.
            const fusionDepth = Math.max(topN, combined.length)
            const bm25Hits = frontendKeywordSearch(cleanedQuery, fusionDepth)
              .filter(r => r.score > BM25_SCORE_THRESHOLD)
            const bm25RankMap = new Map<string, number>()
            for (let i = 0; i < bm25Hits.length; i++) bm25RankMap.set(bm25Hits[i].doc_id, i + 1)

            // Vector rank: re-merge both tracks (internal/game reference) by cosine into a single ranking.
            // Independent per-track ranking gave the top Namuwiki external reference the same vecRank=1 as the top
            // internal document, tying their RRF scores (external material surfaced at the top even for internal questions).
            const vecRankMap = new Map<string, number>()
            const rankedByCosine = [...combined].sort((a, b) => b.score - a.score)
            for (let i = 0; i < rankedByCosine.length; i++) {
              vecRankMap.set(rankedByCosine[i].doc_id, i + 1)
            }

            // Add internal documents present only in BM25
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

            // Assign RRF scores to all documents
            const missRank = rankedByCosine.length + bm25Hits.length + 1
            const fused = searchResults.map(r => {
              const vecRank = vecRankMap.get(r.doc_id) ?? missRank
              const bm25Rank = bm25RankMap.get(r.doc_id) ?? missRank
              return { ...r, score: rrfScore([vecRank, bm25Rank]) }
            }).sort((a, b) => b.score - a.score)

            // Passing raw RRF scores (≈0.03) straight to llmRerankCandidates makes the score*0.4 term vanish,
            // giving the LLM score effectively 100% weight → max-normalize so the top hit is 1.0.
            const topRrf = fused[0]?.score || 1
            searchResults = fused.map(r => ({ ...r, score: r.score / topRrf }))

            // ── LLM reranking ─────────────────────────────────────────────
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

        // 2nd choice: BM25 fallback (no vector index or API failure)
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
            ? `[External game reference — ${refGame} / Namuwiki / ${refDate}]\n${rawBody}\n[End — the above is external game data, not a Project A internal document]`
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

        // Date boost when the query contains "latest/recent/this year" (최신/최근)
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
        chief: { name: 'PM',                  emoji: '🎯', system: s('chief_director') },
        art:   { name: 'Art Director',         emoji: '🎨', system: s('art_director')   },
        spec:  { name: 'Planning Director',    emoji: '📐', system: s('plan_director')  },
        tech:  { name: 'Programming Director', emoji: '⚙️', system: s('prog_director') },
      }
      const { imageDirectPass } = useMiroStore.getState().config
      const { scheduledTopics, presets } = useMiroStore.getState()
      // SEC-2: the Slack bot only needs the Anthropic key — avoid exposing all apiKeys
      const safeApiKeys = { anthropic: apiKeys['anthropic'] ?? '' }
      const slackModel = slackBotConfig?.model || null
      window.ragAPI?.sendResult(requestId, { personaModels, personas, imageDirectPass, scheduledTopics, presets, selfReview, nAgents, apiKeys: safeApiKeys, slackModel })
    })

    return () => { cleanupSearch(); cleanupSettings() }
  }, [])

  // ── 2. Chat/images: onAsk, onGetImages ───────────────────────────────────
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

      // 1st: imageRefs of documents containing query words, only where the filename also matches
      if (loadedDocuments) {
        const matchingDocs = loadedDocuments.filter(doc => {
          const text = (doc.filename + ' ' + (doc.rawContent ?? '')).toLowerCase()
          return words.some(w => text.includes(w))
        })
        for (const doc of matchingDocs) {
          for (const ref of doc.imageRefs ?? []) {
            const basename = ref.split(/[/\\]/).pop() ?? ref
            // Include only when the filename matches a query word (excludes images unrelated to a relevant document)
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

      // 2nd: word match on imageRegistry filenames
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

  // ── 3. MiroFish/vault: onMirofish, onGetVaultPath ────────────────────────
  useEffect(() => {
    if (!window.ragAPI) return

    // Handle MiroFish simulation requests (Slack /mirofish endpoint)
    const cleanupMirofish = window.ragAPI.onMirofish?.(async ({ requestId, topic, numPersonas, numRounds, modelId, context, segment, presetPersonas, images }) => {
      if (mirofishInFlightRef.current) {
        console.warn('[useRagApi] mirofish already running — ignoring duplicate request')
        window.ragAPI?.sendResult(requestId, { feed: [], report: 'A simulation is already running. Please try again later.' })
        return
      }
      mirofishInFlightRef.current = true
      try {
        // If presetPersonas are provided, use them as-is without LLM generation
        const personas = presetPersonas?.length
          ? presetPersonas
          : await generatePersonas(topic, numPersonas, modelId, context, segment)
        if (!personas.length) throw new Error('Persona generation returned no results')
        const feed: MirofishPost[] = []
        const abort = new AbortController()
        let currentRound = 0

        // Simulation start notification
        window.electronAPI?.ipcSend?.('rag:mirofish:progress', { running: true, feed: [], round: 0, totalRounds: numRounds })

        await runSimulation(
          { topic, numPersonas, numRounds, modelId, autoGeneratePersonas: false, imageDirectPass: !!images?.length, personas, context, images },
          (event) => {
            if (event.type === 'post-done' && event.post) {
              feed.push(event.post)
              // Send real-time progress (for Slack bot polling)
              window.electronAPI?.ipcSend?.('rag:mirofish:progress', {
                running: true, feed: [...feed], round: event.post.round, totalRounds: numRounds,
              })
            } else if (event.type === 'round-done' && event.round != null) {
              currentRound = event.round
            }
          },
          abort.signal,
        )

        // Completion notification
        window.electronAPI?.ipcSend?.('rag:mirofish:progress', { running: false, feed: [...feed], round: currentRound, totalRounds: numRounds })

        const report = await generateReport(topic, feed, modelId)
        window.ragAPI?.sendResult(requestId, { feed, report })
      } catch (err) {
        console.error('[useRagApi] mirofish error:', err)
        window.ragAPI?.sendResult(requestId, { feed: [], report: `Error: ${err instanceof Error ? err.message : String(err)}` })
      } finally {
        mirofishInFlightRef.current = false
      }
    })

    // Handle vault path requests (fallback for /mirofish-save)
    const cleanupVaultPath = window.ragAPI.onGetVaultPath?.(({ requestId }: { requestId: string }) => {
      const vaultPath = useVaultStore.getState().vaultPath ?? null
      window.ragAPI?.sendResult(requestId, vaultPath)
    })

    return () => { mirofishInFlightRef.current = false; cleanupMirofish?.(); cleanupVaultPath?.() }
  }, [])
}
