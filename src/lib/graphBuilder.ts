/**
 * graphBuilder.ts — Phase 7
 *
 * Generic graph construction from LoadedDocument arrays.
 *
 * Key change from Phase 6: ONE node per DOCUMENT (matching Obsidian's graph).
 * Previously created one node per section, which produced many unwanted "(intro)" nodes.
 *
 * Supports Obsidian-style "phantom nodes": wiki link targets that don't have
 * a corresponding .md file still appear as nodes in the graph.
 */

import type { GraphNode, GraphLink, LoadedDocument, SpeakerId } from '@/types'
import { DEFAULT_LINK_STRENGTH } from '@/lib/constants'
import { slugify, truncate } from '@/lib/utils'
import { SPEAKER_CONFIG } from '@/lib/speakerConfig'
import { logger } from '@/lib/logger'

const VALID_SPEAKER_IDS = new Set<string>(Object.keys(SPEAKER_CONFIG))
function toSpeakerId(raw: string | undefined): SpeakerId {
  return (raw && VALID_SPEAKER_IDS.has(raw)) ? raw as SpeakerId : 'unknown'
}

type AnyDocument = LoadedDocument

// ── buildGraphNodes ───────────────────────────────────────────────────────────

/**
 * Derive GraphNode[] from a document array.
 * One node per DOCUMENT (not per section). Node id === doc.id.
 */
export function buildGraphNodes(documents: AnyDocument[]): GraphNode[] {
  return documents.map((doc) => ({
    id: doc.id,
    docId: doc.id,
    speaker: toSpeakerId(doc.speaker),
    label: truncate(doc.filename.replace(/\.md$/i, ''), 36),
    folderPath: (doc as LoadedDocument).folderPath,
    tags: doc.tags?.length ? doc.tags : undefined,
  }))
}

// ── buildGraphLinks ───────────────────────────────────────────────────────────

/**
 * Derive GraphLink[] by resolving wikiLinks to document-level graph nodes.
 *
 * Resolution strategies (in order):
 *   1. Direct doc ID match: wiki link matches an existing doc node ID
 *   2. Section ID → parent doc: wiki link matches a section ID (mock data style)
 *   3. Filename match: wiki link matches a document filename (Obsidian style)
 *   4. Phantom node: create a ghost node for unresolved wiki links
 *
 * Deduplicates bidirectional pairs (A→B same as B→A).
 */
export function buildGraphLinks(
  documents: AnyDocument[],
  nodes: GraphNode[]
): { links: GraphLink[]; phantomNodes: GraphNode[] } {
  const nodeIds = new Set(nodes.map((n) => n.id))

  // Lookup: section.id → parent doc.id (for mock data where wiki links = section IDs)
  const sectionIdToDocId = new Map<string, string>()
  for (const doc of documents) {
    for (const section of doc.sections) {
      sectionIdToDocId.set(section.id, doc.id)
    }
  }

  // Lookup: normalised filename (without .md) → 후보 문서 목록
  // 같은 basename이 여러 폴더에 존재할 수 있으므로(실측: 중복 basename 18개/파일 36개,
  // 이를 가리키는 위키링크 238개) 단일 Map<string,string>으로 덮어쓰면
  // 스캔 순서상 **마지막 문서**가 모든 링크를 독점하고 나머지는 그래프에서 고아가 된다.
  const filenameToDocs = new Map<string, AnyDocument[]>()
  for (const doc of documents) {
    const filename = doc.filename.replace(/\.md$/i, '').toLowerCase()
    const bucket = filenameToDocs.get(filename)
    if (bucket) bucket.push(doc)
    else filenameToDocs.set(filename, [doc])
  }

  /** 폴더 경로를 세그먼트 배열로 정규화 (Windows/POSIX 구분자 모두 처리) */
  const segsOf = (p: string | undefined): string[] =>
    (p ?? '').toLowerCase().split(/[/\\]+/).filter(Boolean)

  /** 두 경로의 선행 공통 세그먼트 개수 */
  const commonPrefixLen = (a: string[], b: string[]): number => {
    const n = Math.min(a.length, b.length)
    let i = 0
    while (i < n && a[i] === b[i]) i++
    return i
  }

  // 모호한 basename에 대해 문서당 한 번만 경고 (238개 링크 × N 경고 방지)
  const warnedAmbiguous = new Set<string>()

  /**
   * 동일 파일명 후보 중 하나를 선택한다.
   * 우선순위: (1) 링크 출처와 같은 폴더 → (2) 공통 경로 접두사가 긴 순
   *          → (3) 폴더 깊이가 얕은 순 → (4) 경로 사전순 (결정적)
   */
  function resolveFilename(name: string, fromDoc: AnyDocument, linkDirSegs?: string[]): string | undefined {
    const candidates = filenameToDocs.get(name)
    if (!candidates || candidates.length === 0) return undefined
    if (candidates.length === 1) return candidates[0].id

    const fromSegs = segsOf((fromDoc as LoadedDocument).folderPath)
    let best = candidates[0]
    let bestScore = -1
    for (const c of candidates) {
      const cSegs = segsOf((c as LoadedDocument).folderPath)
      const same = cSegs.length === fromSegs.length && commonPrefixLen(cSegs, fromSegs) === cSegs.length
      // [[Folder/Note]] 형태 — 링크에 명시된 폴더가 후보 경로의 접미사면 최우선
      const dirMatch = linkDirSegs?.length
        ? cSegs.slice(-linkDirSegs.length).join('/') === linkDirSegs.join('/')
        : false
      // 명시 폴더 일치(5000) > 같은 폴더(1000) > 공통 접두사 길이 > 얕은 깊이
      const score = (dirMatch ? 5000 : 0) + (same ? 1000 : 0)
        + commonPrefixLen(cSegs, fromSegs) * 10 - cSegs.length
      if (score > bestScore || (score === bestScore &&
        `${(c as LoadedDocument).folderPath}/${c.filename}` < `${(best as LoadedDocument).folderPath}/${best.filename}`)) {
        bestScore = score
        best = c
      }
    }

    // 같은 폴더 매치가 아니면 진짜 모호한 상황 — 링크 출처 기준 1회만 경고
    if (bestScore < 1000) {
      const warnKey = `${fromDoc.id}|${name}`
      if (!warnedAmbiguous.has(warnKey)) {
        warnedAmbiguous.add(warnKey)
        const paths = candidates.map(c => `${(c as LoadedDocument).folderPath || '(root)'}/${c.filename}`)
        logger.warn(
          `[graphBuilder] 모호한 위키링크 [[${name}]] (출처: ${fromDoc.filename}) — 후보 ${candidates.length}개: ${paths.join(', ')} → "${(best as LoadedDocument).folderPath || '(root)'}/${best.filename}" 선택`,
        )
      }
    }
    return best.id
  }

  // linkCounts: 정규화 전 참조 횟수 (bidirectional pair 기준)
  const linkCounts = new Map<string, number>()
  const phantomNodes = new Map<string, GraphNode>() // id → node

  for (const doc of documents) {
    for (const section of doc.sections) {
      for (const rawLink of section.wikiLinks) {
        // Handle [[target|display]] alias syntax and [[target#heading]] anchors
        // Also strip trailing path separators: Windows wiki links like [[Note\]] are common
        const target = rawLink.split('|')[0].split('#')[0].trim().replace(/[/\\]+$/, '').trim()
        if (!target) continue

        let targetDocId: string | undefined

        // Strategy 1: direct doc ID match
        if (nodeIds.has(target)) {
          targetDocId = target
        }

        // Strategy 2: section ID → parent document (mock data style)
        if (!targetDocId) {
          targetDocId = sectionIdToDocId.get(target)
        }

        // Strategy 3: filename match (Obsidian [[note name]] style)
        // 동일 파일명이 여러 폴더에 있으면 같은 폴더 → 경로 유사도 순으로 해소
        if (!targetDocId) {
          targetDocId = resolveFilename(target.toLowerCase(), doc)
        }

        // Strategy 3b: subpath wiki link [[Folder/Note]] or [[Folder\Note]] → try basename only
        if (!targetDocId && (target.includes('/') || target.includes('\\'))) {
          const parts = target.split(/[/\\]/).map(p => p.trim()).filter(Boolean)
          const basename = parts.pop() ?? ''
          const dirSegs = parts.map(p => p.toLowerCase())
          if (basename) targetDocId = resolveFilename(basename.toLowerCase(), doc, dirSegs)
        }

        // Strategy 4: create phantom node for unresolved wiki links
        if (!targetDocId) {
          const phantomId = `_phantom_${slugify(target)}`
          if (!phantomNodes.has(phantomId)) {
            phantomNodes.set(phantomId, {
              id: phantomId,
              docId: phantomId,
              speaker: 'unknown' as SpeakerId,
              label: truncate(target, 36),
            })
            nodeIds.add(phantomId)
          }
          targetDocId = phantomId
        }

        // Skip self-links (section linking to its own document)
        if (targetDocId === doc.id) continue

        const key = [doc.id, targetDocId].sort().join('→')
        linkCounts.set(key, (linkCounts.get(key) ?? 0) + 1)
      }
    }
  }

  // 최대 참조 횟수로 strength 정규화: [0.15, 1.0] 범위
  // 루프 사용 — Math.max(...spread)는 V8 인자 한계(~65k)를 넘으면 RangeError를 던지고
  // 호출부 catch가 이를 삼켜 그래프가 조용히 비어버린다 (현재 고유 링크 쌍 26,622개).
  let maxCount = 1
  for (const c of linkCounts.values()) { if (c > maxCount) maxCount = c }
  const links: GraphLink[] = []
  for (const [key, count] of linkCounts) {
    const [srcId, tgtId] = key.split('→')
    const strength = 0.15 + (count / maxCount) * 0.85
    links.push({ source: srcId, target: tgtId, strength })
  }

  return { links, phantomNodes: Array.from(phantomNodes.values()) }
}

// ── buildImageNodes ───────────────────────────────────────────────────────────

/**
 * Create image gallery nodes from ![[image.png]] refs found in LoadedDocument.imageRefs.
 * - 문서 하나당 갤러리 노드 1개 생성 (이미지가 여러 개여도 노드는 1개)
 * - 갤러리 노드 클릭 시 문서의 모든 이미지를 갤러리로 표시
 * - ID 형식: `gallery:{doc.id}` (e.g. "gallery:my-note.md")
 */
function buildImageNodes(
  documents: AnyDocument[],
): { imageNodes: GraphNode[]; imageLinks: GraphLink[] } {
  const imageNodes: GraphNode[] = []
  const imageLinks: GraphLink[] = []

  for (const doc of documents) {
    const refs = (doc as LoadedDocument).imageRefs
    if (!refs?.length) continue

    const galleryId = `gallery:${doc.id}`
    const count = refs.length
    // Label: 이미지 1장이면 파일명, 여러 장이면 "파일명 외 N장"
    const firstName = (refs[0].split(/[/\\]/).pop() ?? refs[0]).replace(/\.[^.]+$/, '')
    const label = count === 1
      ? truncate(firstName, 36)
      : truncate(`${firstName} 외 ${count - 1}장`, 36)

    imageNodes.push({
      id: galleryId,
      docId: galleryId,
      speaker: 'unknown' as SpeakerId,
      label,
      isImage: true,
    })

    imageLinks.push({ source: doc.id, target: galleryId, strength: 0.3 })
  }

  return { imageNodes, imageLinks }
}

// ── buildGraph ────────────────────────────────────────────────────────────────

/** Convenience: build both nodes and links in one call */
export function buildGraph(
  documents: AnyDocument[]
): { nodes: GraphNode[]; links: GraphLink[] } {
  const docNodes = buildGraphNodes(documents)
  const { links, phantomNodes } = buildGraphLinks(documents, docNodes)
  const { imageNodes, imageLinks } = buildImageNodes(documents)
  return {
    nodes: [...docNodes, ...phantomNodes, ...imageNodes],
    links: [...links, ...imageLinks],
  }
}
