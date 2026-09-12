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

/** Semantic chunking 파라미터 — 임베딩 fingerprint 에 반영되므로 변경 시 캐시 무효화 */
// v3: 섹션 ID 중복 제거(_uniquifyIds) — 이전 버전은 한 문서 안에서 ID가 겹쳐
//     임베딩 인덱스에서 섹션의 약 2/3 가 유실됐다.
// v4: (1) 마지막 섹션 backward 병합 — forward-only 병합 패스라 마지막 섹션이
//     300자 미만이어도 그대로 남았다 (섹션 청크의 5.7%가 150자 미만).
//     (2) intro 병합 시 heading 만 다음 섹션 것을 쓰고 id 는 `_intro` 로 남아
//     graphRAG 의 `heading === '(intro)'` 특수 처리와 어긋났다 → id 도 함께 바꾼다.
//     (3) 임베딩 텍스트에서 보일러플레이트 접두사 제거 (vectorEmbedIndex.ts)
export const CHUNKER_VERSION = 5
const CHUNK_MIN_CHARS = 300   // 이하이면 다음 섹션과 병합
const CHUNK_MAX_CHARS = 2000  // 초과하면 문단 경계로 분할

interface ParseOptions {
  /** 헤딩 최대 깊이. 1 = H1 만, 2 = H1/H2, 3 = H1/H2/H3 (기본). 0 이면 안 쪼갬. */
  maxDepth?: 0 | 1 | 2 | 3
}

/**
 * Split markdown body into DocSection[] with semantic chunking (v2).
 *
 * 변경점(v2):
 *  - H1/H2/H3 모두 섹션 경계로 인식 (기존: H2만)
 *  - 너무 작은 섹션(< 300자)은 다음 섹션과 병합
 *  - 너무 큰 섹션(> 2000자)은 문단 경계(빈줄)에서 분할
 *  - Slug collision: append `_2`, `_3`, ...
 */
export function parseSections(
  content: string,
  docId: string,
  opts: ParseOptions = {},
): DocSection[] {
  const maxDepth = opts.maxDepth ?? 3
  if (maxDepth === 0) {
    // 전혀 쪼개지 않음 (디버깅용 / 특수 용도)
    const body = content.trim()
    return [{
      id: `${docId}_intro`,
      heading: '(intro)',
      body,
      wikiLinks: extractWikiLinks(body),
    }]
  }

  // H1~maxDepth 패턴 동적 생성
  const hashes = '#'.repeat(maxDepth)
  const headingRe = new RegExp(`^(#{1,${maxDepth}})\\s+(.+)$`, 'm')
  const splitRe = new RegExp(`^(?=#{1,${maxDepth}}\\s)`, 'm')
  const parts = content.split(splitRe)

  if (parts.length === 1 || !headingRe.test(content)) {
    // 헤딩 없음 → 단일 intro 섹션 (이후 크기 기준으로 분할될 수 있음)
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

  void hashes // lint 방지

  const raw: DocSection[] = []
  const usedSlugs = new Map<string, number>()

  for (const part of parts) {
    const lines = part.split('\n')
    const headingLine = lines[0] ?? ''
    const headingMatch = headingLine.match(new RegExp(`^(#{1,${maxDepth}})\\s+(.+)$`))

    if (!headingMatch) {
      // 첫 헤딩 이전 텍스트 → intro
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
 * 섹션 ID 중복 제거 — 같은 문서 안에서 ID가 겹치면 `_2`, `_3` … 를 붙입니다.
 *
 * 헤딩으로 인식되지 않는 조각(예: "### " 처럼 제목 텍스트가 없는 줄)은 모두
 * `${docId}_intro` 로 떨어지기 때문에 한 문서에서 같은 ID가 수십 개 나올 수 있습니다.
 * 임베딩 인덱스는 ID를 키로 Map 에 저장하므로, 중복이 있으면 마지막 것만 남고
 * 나머지 섹션이 조용히 유실됩니다. (slug 충돌 처리와 같은 규칙을 적용)
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
 * min/max 크기 정책 적용:
 *   1. 너무 작은 섹션은 다음 것과 병합 (순차 누적)
 *   1-b. 마지막 섹션은 뒤가 없으므로 앞과 병합 (backward)
 *   2. 너무 큰 섹션은 빈 줄(\n\n+) 경계로 분할
 *       — 마지막 조각이 CHUNK_MIN_CHARS 미만이면 직전 조각에 흡수
 */
function _enforceSizePolicy(sections: DocSection[], docId: string): DocSection[] {
  // 1) 병합 패스 (작은 → 다음과 합침)
  const merged: DocSection[] = []
  for (const s of sections) {
    const prev = merged[merged.length - 1]
    if (prev && prev.body.length < CHUNK_MIN_CHARS) {
      // 이전이 너무 작으면 현재에 붙임.
      // 이전이 intro 면 heading 을 현재 것으로 승격하는데, 이때 id 도 함께 바꾼다.
      // (예전에는 id 가 `${docId}_intro` 로 남아 heading 과 어긋났고,
      //  graphRAG 의 `heading === '(intro)'` 특수 처리가 이 섹션에 걸리지 않았다.)
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

  // 1-b) backward 병합 — 위 패스는 forward-only 라 마지막 섹션은 붙일 다음이 없어
  //      300자 미만이어도 그대로 남는다. 앞 섹션에 흡수시킨다.
  //      (forward 패스가 끝나면 마지막을 제외한 모든 섹션은 CHUNK_MIN_CHARS 이상이므로
  //       한 번만 돌리면 충분하다.)
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

  // 2) 분할 패스 (큰 섹션 → 문단 단위로 쪼갬)
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
      // 남은 꼬리가 너무 작으면 새 청크를 만들지 않고 같은 섹션의 직전 조각에 붙인다.
      // (partIdx > 0 이면 lastPart 는 반드시 이 섹션에서 나온 조각이다.)
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

  // 섹션이 하나뿐이면 병합할 상대가 없으므로 크기와 무관하게 그대로 둔다 (의미 유지)
  // docId 파라미터는 향후 fallback 섹션 id 생성용으로 남겨둠
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

  // ── source / origin / title (외부 임포트 메타) ──────────────────────────────
  const source = typeof data.source === 'string' ? data.source.trim() : undefined
  const origin = typeof data.origin === 'string' ? data.origin.trim() : undefined
  const title  = typeof data.title  === 'string' ? data.title.trim()  : undefined

  // ── type (문서 유형) ───────────────────────────────────────────────────────
  const type = typeof data.type === 'string' ? data.type.trim().toLowerCase() : undefined

  // ── status / superseded_by (문서 생명주기) ────────────────────────────────
  const status      = typeof data.status       === 'string' ? data.status.trim().toLowerCase()       : undefined
  const supersededBy = typeof data.superseded_by === 'string' ? data.superseded_by.trim()            : undefined

  // ── related (구조적 허브 링크 — frontmatter) ──────────────────────────────
  const related: string[] = Array.isArray(data.related)
    ? data.related.map((r: unknown) => String(r).trim()).filter(Boolean)
    : typeof data.related === 'string' ? data.related.split(',').map((s: string) => s.trim()).filter(Boolean)
    : []

  // ── graph_weight (Graph RAG 링크 가중치 힌트) ─────────────────────────────
  const rawGraphWeight = typeof data.graph_weight === 'string' ? data.graph_weight.trim().toLowerCase() : ''
  const graphWeight = (rawGraphWeight === 'low' || rawGraphWeight === 'skip') ? rawGraphWeight as 'low' | 'skip' : undefined

  // ── chief 태그 자동 주입 (파일명 기반 — §11.3.1) ──────────────────────────
  // 이사장/피드백/정례보고 포함 파일명 → tags에 'chief' 자동 추가
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
    logger.warn(`[markdownParser] ID 충돌: "${doc.id}" (${relativePath}) → "${newId}"`)
    // 섹션 id 는 `${docId}_${slug}` 로 만들어지므로 접두사도 함께 바꾼다.
    // 그러지 않으면 충돌한 두 문서가 같은 헤딩을 가질 때 섹션 id 가 전역에서 겹쳐
    // 임베딩 인덱스(Map) 에서 한쪽이 조용히 사라진다.
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
    // §3.2: .archive/ 폴더 파일은 Graph RAG 탐색에서 제외
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
    // §3.2: .archive/ 폴더 파일은 Graph RAG 탐색에서 제외
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
