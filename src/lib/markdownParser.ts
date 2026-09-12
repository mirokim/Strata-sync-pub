/**
 * markdownParser.ts — Phase 6
 *
 * Pure functions that convert VaultFile → LoadedDocument.
 * No side effects, fully testable without Electron.
 */

import matter from 'gray-matter'
import type { VaultFile, LoadedDocument, DocSection, SpeakerId } from '@/types'
import { logger } from '@/lib/logger'
import { slugify, extractWikiLinks, extractImageRefs, normalizePath } from '@/lib/utils'

// ── Valid speaker IDs for validation ──────────────────────────────────────────

const VALID_SPEAKERS: Set<string> = new Set([
  'chief_director',
  'art_director',
  'plan_director',
  'level_director',
  'prog_director',
])

/** Short-form aliases → canonical speaker ID */
const SPEAKER_ALIASES: Record<string, string> = {
  chief:  'chief_director',
  art:    'art_director',
  plan:   'plan_director',
  design: 'plan_director',
  level:  'level_director',
  prog:   'prog_director',
  tech:   'prog_director',
}

// ── filePathToDocId ────────────────────────────────────────────────────────────

/**
 * Convert a vault-relative file path to a stable document ID.
 *
 * "subdir/my note.md" → "subdir_my_note"
 * "README.md"         → "readme"
 */
export function filePathToDocId(relativePath: string): string {
  return relativePath
    .replace(/\.md$/i, '')  // strip .md extension
    .replace(/[\\/]/g, '_') // path separators → _
    .replace(/\s+/g, '_')   // spaces → _
    .replace(/[^a-z0-9_가-힣]/gi, '')  // remove special chars (keep Korean)
    .toLowerCase()
    .replace(/^_+|_+$/g, '') // trim leading/trailing _
    || 'unnamed'
}

// ── parseSections ─────────────────────────────────────────────────────────────

/** Semantic chunking parameters — reflected in the embedding fingerprint, so changing them invalidates the cache */
// v3: De-duplicate section IDs (_uniquifyIds) — the previous version had overlapping IDs within a
//     document, losing about 2/3 of sections from the embedding index.
// v4: (1) Backward merge of the last section — the merge pass was forward-only, so the last section
//     stayed as-is even under 300 chars (5.7% of section chunks were under 150 chars).
//     (2) When merging an intro, only the heading took the next section's value while the id stayed `_intro`,
//     mismatching graphRAG's `heading === '(intro)'` special case → the id is now changed too.
//     (3) Strip boilerplate prefix from embedding text (vectorEmbedIndex.ts)
export const CHUNKER_VERSION = 5
const CHUNK_MIN_CHARS = 300   // merge with the next section if at or below this
const CHUNK_MAX_CHARS = 2000  // split at paragraph boundaries if above this

interface ParseOptions {
  /** Maximum heading depth. 1 = H1 only, 2 = H1/H2, 3 = H1/H2/H3 (default). 0 = no splitting. */
  maxDepth?: 0 | 1 | 2 | 3
}

/**
 * Split markdown body into DocSection[] with semantic chunking (v2).
 *
 * Changes (v2):
 *  - H1/H2/H3 are all recognized as section boundaries (previously: H2 only)
 *  - Sections that are too small (< 300 chars) are merged with the next section
 *  - Sections that are too large (> 2000 chars) are split at paragraph boundaries (blank lines)
 *  - Slug collision: append `_2`, `_3`, ...
 */
export function parseSections(
  content: string,
  docId: string,
  opts: ParseOptions = {},
): DocSection[] {
  const maxDepth = opts.maxDepth ?? 3
  if (maxDepth === 0) {
    // No splitting at all (for debugging / special use)
    const body = content.trim()
    return [{
      id: `${docId}_intro`,
      heading: '(intro)',
      body,
      wikiLinks: extractWikiLinks(body),
    }]
  }

  // Build the H1~maxDepth pattern dynamically
  const hashes = '#'.repeat(maxDepth)
  const headingRe = new RegExp(`^(#{1,${maxDepth}})\\s+(.+)$`, 'm')
  const splitRe = new RegExp(`^(?=#{1,${maxDepth}}\\s)`, 'm')
  const parts = content.split(splitRe)

  if (parts.length === 1 || !headingRe.test(content)) {
    // No headings → single intro section (may still be split by size afterwards)
    return _enforceSizePolicy(
      [{
        id: `${docId}_intro`,
        heading: '(intro)',
        body: content.trim(),
        wikiLinks: extractWikiLinks(content),
      }],
      docId,
    )
  }

  void hashes // avoid lint warning

  const raw: DocSection[] = []
  const usedSlugs = new Map<string, number>()

  for (const part of parts) {
    const lines = part.split('\n')
    const headingLine = lines[0] ?? ''
    const headingMatch = headingLine.match(new RegExp(`^(#{1,${maxDepth}})\\s+(.+)$`))

    if (!headingMatch) {
      // Text before the first heading → intro
      const body = part.trim()
      if (body) {
        raw.push({
          id: `${docId}_intro`,
          heading: '(intro)',
          body,
          wikiLinks: extractWikiLinks(body),
        })
      }
      continue
    }

    const headingText = headingMatch[2].trim()
    const baseSlug = `${docId}_${slugify(headingText)}` || `${docId}_section`
    const count = usedSlugs.get(baseSlug) ?? 0
    usedSlugs.set(baseSlug, count + 1)
    const id = count === 0 ? baseSlug : `${baseSlug}_${count + 1}`

    const body = lines.slice(1).join('\n').trim()
    raw.push({
      id,
      heading: headingText,
      body,
      wikiLinks: extractWikiLinks(body),
    })
  }

  const sections = _enforceSizePolicy(raw, docId)
  return _uniquifyIds(sections.length > 0 ? sections : [{
    id: `${docId}_intro`,
    heading: '(intro)',
    body: content.trim(),
    wikiLinks: extractWikiLinks(content),
  }])
}

/**
 * De-duplicate section IDs — appends `_2`, `_3` … when IDs collide within the same document.
 *
 * Fragments not recognized as headings (e.g. a line like "### " with no title text) all fall
 * through to `${docId}_intro`, so a single document can produce dozens of identical IDs.
 * The embedding index stores sections in a Map keyed by ID, so with duplicates only the last one
 * survives and the remaining sections are silently lost. (Same rule as slug collision handling)
 */
function _uniquifyIds(sections: DocSection[]): DocSection[] {
  const used = new Map<string, number>()
  return sections.map(s => {
    const n = used.get(s.id) ?? 0
    used.set(s.id, n + 1)
    return n === 0 ? s : { ...s, id: `${s.id}_${n + 1}` }
  })
}

/**
 * Apply the min/max size policy:
 *   1. Sections that are too small are merged into the next one (sequential accumulation)
 *   1-b. The last section has no successor, so it is merged into the previous one (backward)
 *   2. Sections that are too large are split at blank-line (\n\n+) boundaries
 *       — if the final piece is under CHUNK_MIN_CHARS it is absorbed into the preceding piece
 */
function _enforceSizePolicy(sections: DocSection[], docId: string): DocSection[] {
  // 1) Merge pass (small → combined with the next)
  const merged: DocSection[] = []
  for (const s of sections) {
    const prev = merged[merged.length - 1]
    if (prev && prev.body.length < CHUNK_MIN_CHARS) {
      // If the previous one is too small, attach it to the current one.
      // If the previous one is an intro, promote the heading to the current one's — and change the id along with it.
      // (Previously the id stayed `${docId}_intro`, mismatching the heading, so
      //  graphRAG's `heading === '(intro)'` special case did not apply to this section.)
      const adoptNext = prev.heading === '(intro)'
      const combinedBody = (prev.body + '\n\n' + (s.heading !== '(intro)' ? `## ${s.heading}\n` : '') + s.body).trim()
      merged[merged.length - 1] = {
        id: adoptNext ? s.id : prev.id,
        heading: adoptNext ? s.heading : prev.heading,
        body: combinedBody,
        wikiLinks: extractWikiLinks(combinedBody),
      }
    } else {
      merged.push(s)
    }
  }

  // 1-b) Backward merge — the pass above is forward-only, so the last section has nothing to
  //      attach to and stays as-is even under 300 chars. Absorb it into the previous section.
  //      (After the forward pass every section except the last is at least CHUNK_MIN_CHARS,
  //       so a single pass is sufficient.)
  if (merged.length >= 2 && merged[merged.length - 1].body.length < CHUNK_MIN_CHARS) {
    const last = merged.pop() as DocSection
    const prev = merged[merged.length - 1]
    const combinedBody = (prev.body + '\n\n' + (last.heading !== '(intro)' ? `## ${last.heading}\n` : '') + last.body).trim()
    merged[merged.length - 1] = {
      id: prev.id,
      heading: prev.heading,
      body: combinedBody,
      wikiLinks: extractWikiLinks(combinedBody),
    }
  }

  // 2) Split pass (large sections → split by paragraph)
  const split: DocSection[] = []
  for (const s of merged) {
    if (s.body.length <= CHUNK_MAX_CHARS) {
      split.push(s)
      continue
    }
    const paragraphs = s.body.split(/\n\s*\n+/)
    let buf = ''
    let partIdx = 0
    for (const para of paragraphs) {
      if (!para.trim()) continue
      if (buf.length + para.length + 2 > CHUNK_MAX_CHARS && buf) {
        partIdx += 1
        const id = partIdx === 1 ? s.id : `${s.id}_part${partIdx}`
        split.push({
          id,
          heading: partIdx === 1 ? s.heading : `${s.heading} (part ${partIdx})`,
          body: buf.trim(),
          wikiLinks: extractWikiLinks(buf),
        })
        buf = para
      } else {
        buf = buf ? buf + '\n\n' + para : para
      }
    }
    if (buf.trim()) {
      const tail = buf.trim()
      const lastPart = split[split.length - 1]
      // If the remaining tail is too small, attach it to the preceding piece of the same section instead of making a new chunk.
      // (When partIdx > 0, lastPart is guaranteed to be a piece from this section.)
      if (partIdx > 0 && lastPart && tail.length < CHUNK_MIN_CHARS) {
        const combinedBody = lastPart.body + '\n\n' + tail
        split[split.length - 1] = {
          ...lastPart,
          body: combinedBody,
          wikiLinks: extractWikiLinks(combinedBody),
        }
      } else {
        partIdx += 1
        const id = partIdx === 1 ? s.id : `${s.id}_part${partIdx}`
        split.push({
          id,
          heading: partIdx === 1 ? s.heading : `${s.heading} (part ${partIdx})`,
          body: tail,
          wikiLinks: extractWikiLinks(tail),
        })
      }
    }
  }

  // With only one section there is nothing to merge with, so leave it as-is regardless of size (preserves meaning)
  // The docId parameter is kept for future fallback section id generation
  void docId
  return split
}

// ── parseMarkdownFile ─────────────────────────────────────────────────────────

/**
 * Convert a single VaultFile to a LoadedDocument.
 *
 * Frontmatter fields:
 *   speaker: string  → validated against VALID_SPEAKERS; fallback 'unknown'
 *   date:    any     → normalised to "YYYY-MM-DD"; fallback ""
 *   tags:    string[] → default []
 *   links:   string[] → default []
 */
export function parseMarkdownFile(file: VaultFile): LoadedDocument {
  const { data, content: body } = matter(file.content)

  // ── speaker ────────────────────────────────────────────────────────────────
  const rawSpeaker = typeof data.speaker === 'string' ? data.speaker.trim().toLowerCase() : ''
  const speaker: SpeakerId = VALID_SPEAKERS.has(rawSpeaker)
    ? (rawSpeaker as SpeakerId)
    : rawSpeaker in SPEAKER_ALIASES
      ? (SPEAKER_ALIASES[rawSpeaker] as SpeakerId)
      : 'unknown'

  // ── date ───────────────────────────────────────────────────────────────────
  let date = ''
  if (data.date instanceof Date) {
    // gray-matter parses YAML dates as Date objects
    date = data.date.toISOString().slice(0, 10)
  } else if (typeof data.date === 'string') {
    date = data.date.trim()
  }

  // ── tags ───────────────────────────────────────────────────────────────────
  const tags: string[] = Array.isArray(data.tags)
    ? data.tags.map(String)
    : typeof data.tags === 'string'
    ? data.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
    : []

  // ── links (top-level wiki-link references) ─────────────────────────────────
  const links: string[] = Array.isArray(data.links)
    ? data.links.map(String)
    : []

  // ── source / origin / title (external import metadata) ──────────────────────
  const source = typeof data.source === 'string' ? data.source.trim() : undefined
  const origin = typeof data.origin === 'string' ? data.origin.trim() : undefined
  const title  = typeof data.title  === 'string' ? data.title.trim()  : undefined

  // ── type (document type) ───────────────────────────────────────────────────
  const type = typeof data.type === 'string' ? data.type.trim().toLowerCase() : undefined

  // ── status / superseded_by (document lifecycle) ───────────────────────────
  const status      = typeof data.status       === 'string' ? data.status.trim().toLowerCase()       : undefined
  const supersededBy = typeof data.superseded_by === 'string' ? data.superseded_by.trim()            : undefined

  // ── related (structural hub links — frontmatter) ──────────────────────────
  const related: string[] = Array.isArray(data.related)
    ? data.related.map((r: unknown) => String(r).trim()).filter(Boolean)
    : typeof data.related === 'string' ? data.related.split(',').map((s: string) => s.trim()).filter(Boolean)
    : []

  // ── graph_weight (Graph RAG link weight hint) ─────────────────────────────
  const rawGraphWeight = typeof data.graph_weight === 'string' ? data.graph_weight.trim().toLowerCase() : ''
  const graphWeight = (rawGraphWeight === 'low' || rawGraphWeight === 'skip') ? rawGraphWeight as 'low' | 'skip' : undefined

  // ── Auto-inject chief tag (filename-based — §11.3.1) ──────────────────────
  // Filenames containing 이사장/피드백/정례보고 (chairman/feedback/regular report) → auto-add 'chief' to tags
  const CHIEF_KEYWORDS = ['이사장', '피드백', '정례보고', '정례 보고', '회장님']
  const filenameForChief = normalizePath(file.relativePath)
  if (CHIEF_KEYWORDS.some(k => filenameForChief.includes(k)) && !tags.includes('chief')) {
    tags.push('chief')
  }

  const docId = filePathToDocId(file.relativePath)
  const sections = parseSections(body, docId)

  // Extract folder path from relativePath (e.g. "Onion Flow/노드 시스템.md" → "Onion Flow")
  const pathParts = file.relativePath.split(/[\\/]/)
  const folderPath = pathParts.length > 1 ? pathParts.slice(0, -1).join('/') : ''

  // Collect ![[image.png]] refs from all sections
  const allImageRefs = new Set<string>()
  for (const section of sections) {
    for (const ref of extractImageRefs(section.body)) {
      allImageRefs.add(ref)
    }
  }
  // Also check frontmatter body (before sections) in raw content
  for (const ref of extractImageRefs(body)) {
    allImageRefs.add(ref)
  }

  return {
    id: docId,
    filename: pathParts[pathParts.length - 1] ?? file.relativePath,
    folderPath,
    absolutePath: file.absolutePath,
    speaker,
    date,
    mtime: file.mtime,
    ...(file.personal ? { personal: true } : {}),
    tags,
    links,
    sections,
    rawContent: file.content,
    imageRefs: allImageRefs.size > 0 ? [...allImageRefs] : undefined,
    source,
    origin,
    title,
    type,
    status,
    supersededBy,
    related: related.length > 0 ? related : undefined,
    graphWeight,
  }
}

// ── parseVaultFiles ───────────────────────────────────────────────────────────

/**
 * Resolve ID collision: if doc.id already exists in seenIds, append _2, _3, …
 * Mutates `results` and `seenIds` as a side effect, returns the final doc.
 */
function pushWithUniqueId(
  doc: LoadedDocument,
  relativePath: string,
  results: LoadedDocument[],
  seenIds: Set<string>,
): void {
  if (seenIds.has(doc.id)) {
    let n = 2
    while (seenIds.has(`${doc.id}_${n}`) && n < 10000) n++
    const newId = `${doc.id}_${n}`
    logger.warn(`[markdownParser] ID collision: "${doc.id}" (${relativePath}) → "${newId}"`)
    // Section ids are built as `${docId}_${slug}`, so change the prefix along with it.
    // Otherwise, when the two colliding documents share a heading, their section ids overlap
    // globally and one of them silently disappears from the embedding index (Map).
    const oldPrefix = doc.id
    const sections = doc.sections.map(sec =>
      sec.id.startsWith(oldPrefix) ? { ...sec, id: `${newId}${sec.id.slice(oldPrefix.length)}` } : sec,
    )
    results.push({ ...doc, id: newId, sections })
    seenIds.add(newId)
  } else {
    seenIds.add(doc.id)
    results.push(doc)
  }
}

/**
 * Batch-parse an array of VaultFiles into LoadedDocuments.
 * Skips files that fail to parse (with a console.warn).
 */
export function parseVaultFiles(files: VaultFile[]): LoadedDocument[] {
  const results: LoadedDocument[] = []
  const seenIds = new Set<string>()
  for (const file of files) {
    // §3.2: files in the .archive/ folder are excluded from Graph RAG traversal
    if (normalizePath(file.relativePath).split('/').some(p => p === '.archive')) continue
    try {
      pushWithUniqueId(parseMarkdownFile(file), file.relativePath, results, seenIds)
    } catch (err) {
      logger.warn(`[markdownParser] Failed to parse ${file.relativePath}:`, err)
    }
  }
  return results
}

// ── parseVaultFilesAsync ──────────────────────────────────────────────────────

/** Number of files parsed per chunk before yielding to the event loop. */
const PARSE_CHUNK = 50

/**
 * Async version of parseVaultFiles that yields to the event loop every
 * PARSE_CHUNK files, allowing the UI (e.g. a loading progress bar) to update
 * during parsing.
 *
 * @param onProgress  Called after each chunk: (parsed, total)
 */
export async function parseVaultFilesAsync(
  files: VaultFile[],
  onProgress?: (parsed: number, total: number) => void,
): Promise<LoadedDocument[]> {
  const results: LoadedDocument[] = []
  const seenIds = new Set<string>()
  const total = files.length

  for (let i = 0; i < total; i++) {
    const file = files[i]
    // §3.2: files in the .archive/ folder are excluded from Graph RAG traversal
    if (normalizePath(file.relativePath).split('/').some(p => p === '.archive')) continue
    try {
      pushWithUniqueId(parseMarkdownFile(file), file.relativePath, results, seenIds)
    } catch (err) {
      logger.warn(`[markdownParser] Failed to parse ${file.relativePath}:`, err)
    }

    // Yield to the event loop every PARSE_CHUNK files so the UI can repaint
    if ((i + 1) % PARSE_CHUNK === 0 || i === total - 1) {
      onProgress?.(i + 1, total)
      await new Promise<void>(r => setTimeout(r, 0))
    }
  }

  return results
}
