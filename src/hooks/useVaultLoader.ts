/**
 * useVaultLoader — Shared vault loading logic.
 *
 * Extracted so it can be used by both:
 *   - App.tsx (auto-load on startup when vaultPath is persisted)
 *   - VaultSelector.tsx (manual load/reload from settings UI)
 */

import { useCallback } from 'react'
import { PERSONA_CONFIG_PATH } from '@/lib/constants'
import { logger } from '@/lib/logger'
import { isEmbeddingReady } from '@/lib/vectorEmbedIndex'
import { useVaultStore } from '@/stores/vaultStore'
import { useGraphStore } from '@/stores/graphStore'
import { useBackendStore } from '@/stores/backendStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { parseVaultFilesAsync } from '@/lib/markdownParser'
import { buildGraph } from '@/lib/graphBuilder'
import { vaultDocsToChunks } from '@/lib/vaultToChunks'
import { parsePersonaConfig } from '@/lib/personaVaultConfig'
import { tfidfIndex, clearMetricsCache } from '@/lib/graphAnalysis'
import { buildAdjacencyMap } from '@/lib/graphRAG'
import { buildAndFindLinks, findLinksFromCache, extractSynonymsInWorker } from '@/lib/bm25WorkerClient'
import { addDynamicSynonym, clearDynamicSynonyms } from '@/lib/synonyms'
import { buildFingerprint, loadTfIdfCache, saveTfIdfCache } from '@/lib/tfidfCache'
import { buildDocsFingerprint, loadDocsCache, saveDocsCache } from '@/lib/docsCache'
import { vectorEmbedIndex } from '@/lib/vectorEmbedIndex'
import { buildStatsSnapshot, saveStatsSnapshot } from '@/lib/vaultStatsLog'
import type { VaultFile, LoadedDocument } from '@/types'

/**
 * Co-occurrence 기반 동적 동의어 등록 — 워커에서 실행.
 *
 * 이전에는 메인 스레드에서 `extractCoOccurrenceSynonyms(docs)` 를 직접 호출해
 * 13초를 블로킹한 뒤 `RangeError: Map maximum size exceeded` 로 끝났고,
 * 호출부 try/catch 가 그 예외를 조용히 삼켜 **동의어는 하나도 등록되지 않으면서
 * 비용만 전부 지불**했다. 이제 워커에서 돌리고 실패는 로그로 남긴다.
 */
async function registerDynamicSynonyms(docs: LoadedDocument[]): Promise<void> {
  const sectionTexts: string[] = []
  for (const doc of docs) {
    for (const s of doc.sections) sectionTexts.push(`${s.heading} ${s.body}`)
  }
  if (sectionTexts.length < 3) return
  const t0 = Date.now()
  const entries = await extractSynonymsInWorker(sectionTexts)
  for (const [term, synonyms] of entries) {
    for (const syn of synonyms) addDynamicSynonym(term, syn)
  }
  logger.debug(`[vault] 동적 동의어 ${entries.length}개 용어 등록 완료 (워커 ${Date.now() - t0}ms)`)
}

export function useVaultLoader() {
  const { vaultPath, setLoadedDocuments, setVaultFolders, setImagePathRegistry, clearImageDataCache, setIsLoading, setVaultReady, setLoadingProgress, setError, setPendingFileCount, cacheVaultDocs, setBgLoadingInfo } =
    useVaultStore()
  const { setGraph, resetToMock, setGraphLayoutReady } = useGraphStore()
  const { setIndexing, setChunkCount, setError: setBackendError } = useBackendStore()
  const { loadVaultPersonas, resetVaultPersonas } = useSettingsStore()

  const loadVault = useCallback(
    async (dirPath: string) => {
      if (!window.vaultAPI) {
        setError('Electron 환경이 아닙니다. 브라우저에서는 볼트를 로드할 수 없습니다.')
        return
      }
      setIsLoading(true)
      setVaultReady(false)
      setLoadingProgress(0, '볼트 초기화 중...')
      setError(null)
      try {
        // ── 1단계: scanMetadata (mtime만, 파일 내용 없음) → 캐시 지문 확인 ──
        let docs = null
        let folders: string[] = []
        let imageRegistry: Record<string, { relativePath: string; absolutePath: string }> | null = null

        if (window.vaultAPI.scanMetadata) {
          try {
            setLoadingProgress(2, '메타데이터 스캔 중...')
            const meta = await window.vaultAPI.scanMetadata(dirPath)
            if (meta && meta.length > 0) {
              const docsFingerprint = buildDocsFingerprint(
                meta.map(m => ({ relativePath: m.relativePath, mtime: m.mtime }))
              )
              const hit = await loadDocsCache(dirPath, docsFingerprint)
              if (hit) {
                logger.debug(`[vault] 캐시 히트 — loadFiles·파싱 모두 건너뜀 (${hit.docs.length}개 문서)`)
                setLoadingProgress(90, '캐시에서 복원 중...')
                docs = hit.docs
                folders = hit.folders
                imageRegistry = hit.imageRegistry
                setPendingFileCount(hit.docs.length)
                setVaultFolders(folders)
                setImagePathRegistry(imageRegistry)
              }
            }
          } catch { /* scanMetadata 실패 → loadFiles fallback */ }
        }

        // ── 2단계: 캐시 미스 시 loadFiles (파일 내용 포함) ─────────────────
        let files: VaultFile[] | null = null
        if (!docs) {
          const loaded = await window.vaultAPI.loadFiles(dirPath)
          files = loaded.files
          folders = loaded.folders ?? []
          imageRegistry = loaded.imageRegistry ?? null
          logger.debug(`[vault] ${files?.length ?? 0}개 파일, ${folders.length}개 폴더, ${Object.keys(imageRegistry ?? {}).length}개 이미지 로드됨 (${dirPath})`)
          setVaultFolders(folders)
          setImagePathRegistry(imageRegistry)
          setPendingFileCount(files?.length ?? 0)
          setLoadingProgress(5, '파일 목록 로드 완료')

          if (!files || files.length === 0) {
            setLoadedDocuments(null)
            resetToMock()
            setIsLoading(false)
            return
          }
        }

        // ── 3단계: 캐시 미스 시 전체 파싱 ──────────────────────────────────
        if (!docs) {
          const total = files!.length
          docs = await parseVaultFilesAsync(files!, (parsed) => {
            const pct = 5 + Math.round((parsed / total) * 80)
            setLoadingProgress(pct, `문서 파싱 중... (${parsed}/${total})`)
          })
          logger.debug(`[vault] ${docs.length}/${files!.length}개 문서 파싱 성공`)

          // 파싱 완료 후 캐시 저장 (백그라운드, folders+imageRegistry 포함)
          const metaForCache = files!.map(f => ({ relativePath: f.relativePath, mtime: f.mtime ?? 0 }))
          const fp = buildDocsFingerprint(metaForCache)
          saveDocsCache(dirPath, fp, docs, folders, imageRegistry)
            .catch((e: unknown) => logger.warn('[docsCache] 저장 실패:', e))
        }
        setLoadedDocuments(docs)

        // Load vault-scoped persona config (.strata-sync/personas.md)
        try {
          const configPath = `${dirPath}/${PERSONA_CONFIG_PATH}`
          const configContent = await window.vaultAPI!.readFile(configPath)
          if (configContent) {
            const config = parsePersonaConfig(configContent)
            if (config) {
              loadVaultPersonas(config)
              logger.debug('[vault] 페르소나 설정 로드됨')
            } else {
              resetVaultPersonas()
            }
          } else {
            resetVaultPersonas()
          }
        } catch {
          resetVaultPersonas()
        }

        // 동적 동의어 초기화 (이전 볼트 데이터 제거) + 새 볼트 co-occurrence 분석
        clearDynamicSynonyms()

        // Update graph (clear stale metrics cache from previous vault)
        clearMetricsCache()
        setLoadingProgress(95, '완료 중...')

        // 그래프 빌드: finally(setVaultReady) 전에 동기 실행하여
        // setGraph → graphLayoutReady=false → 오버레이 재활성화 레이스 방지
        try {
          const { nodes, links } = buildGraph(docs)
          logger.debug(`[vault] 그래프: ${nodes.length}개 노드, ${links.length}개 링크`)
          setGraph(nodes, links)
        } catch (e: unknown) {
          logger.warn('[vault] 그래프 빌드 실패:', e instanceof Error ? e.message : String(e))
        }
        // D3 시뮬레이션 수렴을 기다리지 않고 즉시 오버레이 해제
        // (시뮬레이션은 백그라운드에서 계속 실행되며 fitView가 나중에 호출됨)
        setGraphLayoutReady(true)

        // BM25 인덱스 + 후속 작업: requestIdleCallback으로 UI 프레임 양보
        // BM25 build/findImplicitLinks은 Web Worker에서 실행 (O(N²) 메인 스레드 블로킹 제거)
        const fingerprint = buildFingerprint(docs)
        const startVaultId = useVaultStore.getState().activeVaultId  // 캡처: 비동기 완료 시 vault가 바뀌었는지 확인용
        const deferToIdle = () => new Promise<void>(r => {
          (window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 16)))((() => r()) as IdleRequestCallback)
        })
        setTimeout(async () => {
          // BM25 인덱스: 캐시 히트 → 복원(빠름) + 워커에서 묵시적 링크 계산
          //              캐시 미스 → 워커에서 빌드 + 묵시적 링크 계산 (메인 스레드 비블로킹)
          const { links: currentLinks } = useGraphStore.getState()
          const adj = buildAdjacencyMap(currentLinks)
          try {
            const cached = await loadTfIdfCache(dirPath, fingerprint)
            // 비동기 완료 후 vault가 바뀌었으면 stale 결과를 tfidfIndex에 적용하지 않음
            if (useVaultStore.getState().activeVaultId !== startVaultId) return
            if (cached) {
              tfidfIndex.restore(cached)
              if (cached.implicitLinks) {
                // 캐시에 사전 계산된 묵시적 링크가 있으면 O(N²) 재계산을 완전히 생략
                tfidfIndex.setImplicitLinks(cached.implicitLinks, adj)
              } else if (currentLinks.length > 0) {
                // 구버전 캐시 — 한 번만 계산해 캐시에 채워 넣는다
                findLinksFromCache(cached, adj)
                  .then(links => {
                    tfidfIndex.setImplicitLinks(links, adj)
                    return saveTfIdfCache(dirPath, { ...cached, implicitLinks: links })
                  })
                  .catch((e: unknown) => logger.warn('[BM25] 묵시적 링크 계산 실패:', e instanceof Error ? e.message : String(e)))
              }
            } else {
              try {
                const { serialized, implicitLinks } = await buildAndFindLinks(docs, adj, fingerprint)
                if (useVaultStore.getState().activeVaultId !== startVaultId) return
                tfidfIndex.restore(serialized)
                tfidfIndex.setImplicitLinks(implicitLinks, adj)
                saveTfIdfCache(dirPath, serialized)
                  .catch((e: unknown) => logger.warn('[BM25] 캐시 저장 실패:', e instanceof Error ? e.message : String(e)))
              } catch (e: unknown) {
                logger.warn('[BM25] 워커 빌드 실패, 메인 스레드 폴백:', e instanceof Error ? e.message : String(e))
                if (useVaultStore.getState().activeVaultId === startVaultId) {
                  try { tfidfIndex.build(docs) } catch { /* 재빌드도 실패 시 무음 */ }
                }
              }
            }
          } catch (e: unknown) {
            logger.warn('[BM25] 인덱스 초기화 실패, 재빌드 시도:', e instanceof Error ? e.message : String(e))
            if (useVaultStore.getState().activeVaultId === startVaultId) {
              try { tfidfIndex.build(docs) } catch { /* 재빌드도 실패 시 무음 */ }
            }
          }

          await deferToIdle() // BM25 완료 후 UI 프레임 양보

          // 벡터 임베딩 증분 빌드 (로컬 임베딩 서버 또는 Gemini 키가 있을 때)
          const geminiKey = useSettingsStore.getState().apiKeys['gemini']?.trim()
          const canEmbed = await isEmbeddingReady(geminiKey)
          if (canEmbed && docs.length > 0 && useVaultStore.getState().activeVaultId === startVaultId) {
            vectorEmbedIndex.buildIncremental(docs, geminiKey ?? '', dirPath)
              .catch((e: unknown) => logger.warn('[vector] 임베딩 빌드 실패:', e instanceof Error ? e.message : String(e)))
          }

          // Co-occurrence 기반 동적 동의어 추출 (워커, 백그라운드)
          if (docs.length > 0 && useVaultStore.getState().activeVaultId === startVaultId) {
            registerDynamicSynonyms(docs).catch((e: unknown) =>
              logger.warn('[vault] co-occurrence 동의어 추출 실패:', e instanceof Error ? e.message : String(e)))
          }
        }, 0)

        // Index into backend if available (check readiness first to avoid noisy errors)
        if (window.backendAPI && docs.length > 0) {
          try {
            const status = await window.backendAPI.getStatus()
            if (status?.ready) {
              const chunks = vaultDocsToChunks(docs)
              setIndexing(true)
              window.backendAPI
                .indexDocuments(chunks)
                .then(({ indexed }) => setChunkCount(indexed))
                .catch((err: unknown) =>
                  setBackendError(err instanceof Error ? err.message : String(err))
                )
                .finally(() => setIndexing(false))
            }
          } catch {
            // Backend not running — silently skip indexing
          }
        }
        // 이미지는 on-demand로 로드 (ChatInput.tsx readImage IPC fallback)
        // 볼트 로드 시 전체 사전 인덱싱을 하지 않아 메모리를 절약
        clearImageDataCache()

        // 볼트 통계 스냅샷 기록 (백그라운드)
        if (docs && docs.length > 0) {
          const snapshot = buildStatsSnapshot(docs)
          saveStatsSnapshot(dirPath, snapshot).catch(() => {})
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : '파일 로드 실패'
        logger.error('[vault] 로드 실패:', msg)
        setError(msg)
        setLoadedDocuments(null)
        resetToMock()
      } finally {
        setLoadingProgress(100, '')
        setVaultReady(true)
        setIsLoading(false)
        setPendingFileCount(null)
      }
    },
    [setLoadedDocuments, setVaultFolders, setImagePathRegistry, clearImageDataCache,
     setIsLoading, setVaultReady, setLoadingProgress, setError, setPendingFileCount,
     setGraph, resetToMock, setIndexing, setChunkCount, setBackendError,
     loadVaultPersonas, resetVaultPersonas]
  )

  const loadVaultCached = useCallback(
    async (dirPath: string) => {
      const { activeVaultId: startVaultId, vaultDocsCache, vaultMetaCache } = useVaultStore.getState()
      const cachedDocs = startVaultId ? vaultDocsCache[startVaultId] : null
      const cachedMeta = startVaultId ? vaultMetaCache[startVaultId] : null

      if (!cachedDocs?.length) {
        // Cache miss → full load
        return loadVault(dirPath)
      }

      if (!window.vaultAPI) return
      // currentVaultPath를 선제 갱신 — usePersonaVaultSaver의 vault:save-file 보안 검사 통과용
      try { await window.vaultAPI.setActivePath?.(dirPath) } catch { /* 실패해도 캐시 복원은 계속 */ }
      setIsLoading(true)
      setVaultReady(false)
      setError(null)
      // 캐시 복원 시엔 pendingFileCount 미설정 → 품질 선택 화면 재표시 방지
      try {
        // Restore image registry + folders from cache (or empty defaults)
        setImagePathRegistry(cachedMeta?.imageRegistry ?? null)
        setVaultFolders(cachedMeta?.folders ?? [])

        // Persona config (quick single file read)
        try {
          const configContent = await window.vaultAPI.readFile(`${dirPath}/${PERSONA_CONFIG_PATH}`)
          if (configContent) {
            const config = parsePersonaConfig(configContent)
            config ? loadVaultPersonas(config) : resetVaultPersonas()
          } else {
            resetVaultPersonas()
          }
        } catch { resetVaultPersonas() }

        setLoadedDocuments(cachedDocs)
        clearDynamicSynonyms()
        clearMetricsCache()

        // buildGraph: 한 틱 후로 이동 — 메인 스레드 블로킹 방지
        await new Promise<void>(r => setTimeout(r, 0))
        if (useVaultStore.getState().activeVaultId !== startVaultId) return
        try {
          const { nodes, links } = buildGraph(cachedDocs)
          setGraph(nodes, links)
        } catch (e: unknown) {
          logger.warn('[vault] 그래프 빌드 실패:', e instanceof Error ? e.message : String(e))
        }
        setGraphLayoutReady(true)

        const fingerprint = buildFingerprint(cachedDocs)
        setTimeout(async () => {
          // 비동기 콜백 실행 전에 다른 볼트로 전환됐으면 중단 (stale index 방지)
          if (useVaultStore.getState().activeVaultId !== startVaultId) return
          const { links: currentLinks } = useGraphStore.getState()
          const adj = buildAdjacencyMap(currentLinks)
          try {
            const cached = await loadTfIdfCache(dirPath, fingerprint)
            if (useVaultStore.getState().activeVaultId !== startVaultId) return
            if (cached) {
              tfidfIndex.restore(cached)
              if (cached.implicitLinks) {
                tfidfIndex.setImplicitLinks(cached.implicitLinks, adj)
              } else if (currentLinks.length > 0) {
                findLinksFromCache(cached, adj)
                  .then(links => {
                    tfidfIndex.setImplicitLinks(links, adj)
                    return saveTfIdfCache(dirPath, { ...cached, implicitLinks: links })
                  })
                  .catch((e: unknown) => logger.warn('[BM25] 묵시적 링크 계산 실패:', e instanceof Error ? e.message : String(e)))
              }
            } else {
              try {
                const { serialized, implicitLinks } = await buildAndFindLinks(cachedDocs, adj, fingerprint)
                tfidfIndex.restore(serialized)
                tfidfIndex.setImplicitLinks(implicitLinks, adj)
                saveTfIdfCache(dirPath, serialized)
                  .catch((e: unknown) => logger.warn('[BM25] 캐시 저장 실패:', e instanceof Error ? e.message : String(e)))
              } catch (e: unknown) {
                logger.warn('[BM25] 워커 빌드 실패, 메인 스레드 폴백:', e instanceof Error ? e.message : String(e))
                try { tfidfIndex.build(cachedDocs) } catch { /* 재빌드도 실패 시 무음 */ }
              }
            }
          } catch (e: unknown) {
            logger.warn('[BM25] 인덱스 초기화 실패, 재빌드 시도:', e instanceof Error ? e.message : String(e))
            try { tfidfIndex.build(cachedDocs) } catch { /* 재빌드도 실패 시 무음 */ }
          }

          if (useVaultStore.getState().activeVaultId !== startVaultId) return

          // ── 벡터 인덱스 리셋 + 재빌드 ────────────────────────────────────
          // 볼트를 탭으로 전환하면 이전 볼트의 임베딩이 그대로 남아 다른 볼트
          // 문서에 점수를 매긴다. loadVault() 와 동일하게 리셋 후 증분 재빌드.
          vectorEmbedIndex.reset()
          const geminiKey = useSettingsStore.getState().apiKeys['gemini']?.trim()
          const canEmbed = await isEmbeddingReady(geminiKey)
          if (canEmbed && cachedDocs.length > 0 && useVaultStore.getState().activeVaultId === startVaultId) {
            vectorEmbedIndex.buildIncremental(cachedDocs, geminiKey ?? '', dirPath)
              .catch((e: unknown) => logger.warn('[vector] 임베딩 빌드 실패:', e instanceof Error ? e.message : String(e)))
          }

          // Co-occurrence 기반 동적 동의어 추출 (워커, 백그라운드)
          if (cachedDocs.length > 0 && useVaultStore.getState().activeVaultId === startVaultId) {
            registerDynamicSynonyms(cachedDocs).catch((e: unknown) =>
              logger.warn('[vault] co-occurrence 동의어 추출 실패:', e instanceof Error ? e.message : String(e)))
          }
        }, 0)

        clearImageDataCache()
      } catch (err) {
        const msg = err instanceof Error ? err.message : '복원 실패'
        setError(msg)
        setLoadedDocuments(null)
        resetToMock()
      } finally {
        setVaultReady(true)
        setIsLoading(false)
        setPendingFileCount(null)
      }
    },
    [loadVault, setLoadedDocuments, setImagePathRegistry, setVaultFolders, clearImageDataCache,
     setIsLoading, setVaultReady, setError, setPendingFileCount,
     setGraph, setGraphLayoutReady, resetToMock, loadVaultPersonas, resetVaultPersonas]
  )

  const loadVaultBackground = useCallback(
    async (vaultId: string, dirPath: string) => {
      if (!window.vaultAPI) return
      const { vaultDocsCache } = useVaultStore.getState()
      if (vaultDocsCache[vaultId]?.length) return  // already in-memory
      try {
        // ── docsCache 히트 시 파일 읽기·파싱 전체 생략 ──────────────────────
        if (window.vaultAPI.scanMetadata) {
          try {
            const meta = await window.vaultAPI.scanMetadata(dirPath)
            if (meta?.length) {
              const fp = buildDocsFingerprint(meta.map(m => ({ relativePath: m.relativePath, mtime: m.mtime })))
              const hit = await loadDocsCache(dirPath, fp)
              if (hit) {
                useVaultStore.getState().cacheVaultDocs(vaultId, hit.docs)
                useVaultStore.setState((s) => ({
                  vaultMetaCache: {
                    ...s.vaultMetaCache,
                    [vaultId]: { imageRegistry: hit.imageRegistry ?? null, folders: hit.folders ?? [] }
                  }
                }))
                return
              }
            }
          } catch { /* docsCache miss → fall through to loadFiles */ }
        }

        // ── 캐시 미스: 파일 읽기 + 파싱 후 저장 ────────────────────────────
        const { files, folders, imageRegistry } = await window.vaultAPI.loadFiles(dirPath)
        if (!files?.length) return
        const docs = await parseVaultFilesAsync(files)
        useVaultStore.getState().cacheVaultDocs(vaultId, docs)
        useVaultStore.setState((s) => ({
          vaultMetaCache: {
            ...s.vaultMetaCache,
            [vaultId]: { imageRegistry: imageRegistry ?? null, folders: folders ?? [] }
          }
        }))
        // 다음 재시작에서 캐시 히트되도록 저장
        const metaForFp = files.map(f => ({ relativePath: f.relativePath, mtime: f.mtime ?? 0 }))
        saveDocsCache(dirPath, buildDocsFingerprint(metaForFp), docs, folders ?? [], imageRegistry ?? null)
          .catch(() => { /* 백그라운드 저장 실패는 무음 처리 */ })
      } catch {
        // Silent failure
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  )

  // Expose cacheVaultDocs and setBgLoadingInfo via closure (used in App.tsx)
  void cacheVaultDocs
  void setBgLoadingInfo

  return { vaultPath, loadVault, loadVaultCached, loadVaultBackground }
}
