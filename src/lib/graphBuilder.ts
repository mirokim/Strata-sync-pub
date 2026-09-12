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

  // Lookup: normalised filename (without .md) → candidate document list
  // The same basename can exist in multiple folders (measured: 18 duplicate basenames / 36 files,
  // 238 wikilinks pointing at them). Overwriting in a single Map<string,string> would let the
  // **last document** in scan order monopolize every link and orphan the rest in the graph.
  const filenameToDocs = new Map<string, AnyDocument[]>()
  for (const doc of documents) {
    const filename = doc.filename.replace(/\.md$/i, '').toLowerCase()
    const bucket = filenameToDocs.get(filename)
    if (bucket) bucket.push(doc)
    else filenameToDocs.set(filename, [doc])
  }

  /** Normalize a folder path into a segment array (handles both Windows/POSIX separators) */
  const segsOf = (p: string | undefined): string[] =>
    (p ?? '').toLowerCase().split(/[/\\]+/).filter(Boolean)

  /** Number of leading segments shared by two paths */
  const commonPrefixLen = (a: string[], b: string[]): number => {
    const n = Math.min(a.length, b.length)
    let i = 0
    while (i < n && a[i] === b[i]) i++
    return i
  }

  // Warn only once per document for an ambiguous basename (avoids 238 links × N warnings)
  const warnedAmbiguous = new Set<string>()

  /**
   * Picks one of the candidates sharing the same filename.
   * Priority: (1) same folder as the link source → (2) longest common path prefix
   *          → (3) shallowest folder depth → (4) lexicographic path order (deterministic)
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
      // [[Folder/Note]] form — top priority when the folder given in the link is a suffix of the candidate path
      const dirMatch = linkDirSegs?.length
        ? cSegs.slice(-linkDirSegs.length).join('/') === linkDirSegs.join('/')
        : false
      // Explicit folder match (5000) > same folder (1000) > common prefix length > shallower depth
      const score = (dirMatch ? 5000 : 0) + (same ? 1000 : 0)
        + commonPrefixLen(cSegs, fromSegs) * 10 - cSegs.length
      if (score > bestScore || (score === bestScore &&
        `${(c as LoadedDocument).folderPath}/${c.filename}` < `${(best as LoadedDocument).folderPath}/${best.filename}`)) {
        bestScore = score
        best = c
      }
    }

    // Not a same-folder match means genuinely ambiguous — warn once per link source
    if (bestScore < 1000) {
      const warnKey = `${fromDoc.id}|${name}`
      if (!warnedAmbiguous.has(warnKey)) {
        warnedAmbiguous.add(warnKey)
        const paths = candidates.map(c => `${(c as LoadedDocument).folderPath || '(root)'}/${c.filename}`)
        logger.warn(
          `[graphBuilder] Ambiguous wikilink [[${name}]] (from: ${fromDoc.filename}) — ${candidates.length} candidates: ${paths.join(', ')} → picked "${(best as LoadedDocument).folderPath || '(root)'}/${best.filename}"`,
        )
      }
    }
    return best.id
  }

  // linkCounts: reference counts before normalization (per bidirectional pair)
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
        // If the same filename exists in multiple folders, resolve by same folder → path similarity
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

  // Normalize strength by the max reference count: range [0.15, 1.0]
  // Uses a loop — Math.max(...spread) throws RangeError past V8's argument limit (~65k),
  // and the caller's catch swallows it, leaving the graph silently empty (currently 26,622 unique link pairs).
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
 * - One gallery node per document (a single node even when there are multiple images)
 * - Clicking a gallery node shows all of the document's images as a gallery
 * - ID format: `gallery:{doc.id}` (e.g. "gallery:my-note.md")
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
    // Label: filename for a single image, "filename +N" for multiple
    const firstName = (refs[0].split(/[/\\]/).pop() ?? refs[0]).replace(/\.[^.]+$/, '')
    const label = count === 1
      ? truncate(firstName, 36)
      : truncate(`${firstName} +${count - 1}`, 36)

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
