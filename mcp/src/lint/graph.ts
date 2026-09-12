/**
 * Link graph used by the lint rules.
 *
 * Built straight from documents rather than from the MCP state's `_links`, because the rules
 * need what that deduplicated, undirected list throws away: link direction, reference counts
 * and — most importantly — links whose target does not exist (phantoms).
 */
import type { LintDocument } from './document.js'

export interface LintNode {
  id: string
  filename: string
  /** filename without .md */
  title: string
  folderPath: string
  mtime: number
  tags: string[]
  graphWeight?: 'normal' | 'low' | 'skip'
}

export interface LintGraph {
  nodes: LintNode[]
  nodeById: Map<string, LintNode>
  /** Undirected neighbours (resolved links only, no self-links). */
  adjacency: Map<string, Set<string>>
  /** Directed reference count: `outRefs.get(a).get(b)` = how many times a links to b. */
  outRefs: Map<string, Map<string, number>>
  /** Number of distinct documents linking *to* a document. */
  inDegree: Map<string, number>
  /** Number of distinct documents a document links *to*. */
  outDegree: Map<string, number>
  /** Unresolved link text (normalised) → set of docIds that reference it. */
  phantoms: Map<string, Set<string>>
  /** Normalised phantom key → the link text as first written (for display and for creating the file). */
  phantomLabels: Map<string, string>
  /** Unique undirected resolved links. */
  linkCount: number
}

/**
 * `[[Folder/Doc Name|alias#Heading^block]]` → `doc name`
 *
 * Obsidian resolves a wikilink by the basename only (folders are hints for disambiguation),
 * case-insensitively, ignoring alias, heading and block-reference suffixes.
 */
export function normalizeWikiLink(raw: string): string {
  let s = raw.trim().replace(/\\$/, '')  // `[[Doc\|alias]]` inside tables escapes the pipe
  const pipe = s.indexOf('|'); if (pipe >= 0) s = s.slice(0, pipe)
  const hash = s.indexOf('#'); if (hash >= 0) s = s.slice(0, hash)
  const caret = s.indexOf('^'); if (caret >= 0) s = s.slice(0, caret)
  const slash = s.lastIndexOf('/'); if (slash >= 0) s = s.slice(slash + 1)
  return s.replace(/\.md$/i, '').trim().toLowerCase()
}

/** Display form of a wikilink target: alias/heading/block/folder stripped, original casing kept. */
export function wikiLinkLabel(raw: string): string {
  let s = raw.trim().replace(/\\$/, '')
  const pipe = s.indexOf('|'); if (pipe >= 0) s = s.slice(0, pipe)
  const hash = s.indexOf('#'); if (hash >= 0) s = s.slice(0, hash)
  const caret = s.indexOf('^'); if (caret >= 0) s = s.slice(0, caret)
  const slash = s.lastIndexOf('/'); if (slash >= 0) s = s.slice(slash + 1)
  return s.replace(/\.md$/i, '').trim()
}

/** Everything a document links to (frontmatter `links:` plus body wikilinks), normalised, with counts and a display label. */
export function collectLinkTargets(doc: LintDocument): Map<string, { count: number; label: string }> {
  const counts = new Map<string, { count: number; label: string }>()
  const raw = [...doc.links, ...doc.sections.flatMap(s => s.wikiLinks)]
  for (const r of raw) {
    // Frontmatter `links:` may hold URLs; those are not documents
    if (r.includes('://')) continue
    const key = normalizeWikiLink(r)
    if (!key) continue
    const entry = counts.get(key)
    if (entry) entry.count++
    else counts.set(key, { count: 1, label: wikiLinkLabel(r) })
  }
  return counts
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|pdf|mp4|mp3|wav)$/i

export function buildLintGraph(docs: LintDocument[]): LintGraph {
  const nodes: LintNode[] = []
  const nodeById = new Map<string, LintNode>()
  const titleToId = new Map<string, string>()

  for (const doc of docs) {
    const title = doc.filename.replace(/\.md$/i, '')
    const node: LintNode = {
      id: doc.id, filename: doc.filename, title, folderPath: doc.folderPath,
      mtime: doc.mtime ?? 0, tags: doc.tags, graphWeight: doc.graphWeight,
    }
    nodes.push(node)
    nodeById.set(doc.id, node)
    // First document wins on duplicate basenames, like Obsidian's "shortest path" default.
    const key = title.toLowerCase()
    if (!titleToId.has(key)) titleToId.set(key, doc.id)
  }

  const adjacency = new Map<string, Set<string>>()
  const outRefs = new Map<string, Map<string, number>>()
  const inSources = new Map<string, Set<string>>()
  const phantoms = new Map<string, Set<string>>()
  const phantomLabels = new Map<string, string>()
  for (const n of nodes) { adjacency.set(n.id, new Set()); outRefs.set(n.id, new Map()); inSources.set(n.id, new Set()) }

  const seenPairs = new Set<string>()
  let linkCount = 0

  for (const doc of docs) {
    for (const [key, { count, label }] of collectLinkTargets(doc)) {
      const targetId = titleToId.get(key)
      if (targetId === undefined) {
        // Media embeds that slipped through as plain links are not missing documents.
        if (IMAGE_EXT_RE.test(key)) continue
        if (!phantoms.has(key)) { phantoms.set(key, new Set()); phantomLabels.set(key, label) }
        phantoms.get(key)!.add(doc.id)
        continue
      }
      if (targetId === doc.id) continue
      outRefs.get(doc.id)!.set(targetId, count)
      inSources.get(targetId)!.add(doc.id)
      adjacency.get(doc.id)!.add(targetId)
      adjacency.get(targetId)!.add(doc.id)
      const pair = doc.id < targetId ? `${doc.id} ${targetId}` : `${targetId} ${doc.id}`
      if (!seenPairs.has(pair)) { seenPairs.add(pair); linkCount++ }
    }
  }

  const inDegree = new Map<string, number>()
  const outDegree = new Map<string, number>()
  for (const n of nodes) {
    inDegree.set(n.id, inSources.get(n.id)!.size)
    outDegree.set(n.id, outRefs.get(n.id)!.size)
  }

  return { nodes, nodeById, adjacency, outRefs, inDegree, outDegree, phantoms, phantomLabels, linkCount }
}

/** Top-level folder of a document ('' for vault root). */
export function topFolder(folderPath: string): string {
  return folderPath.split(/[\\/]/)[0] ?? ''
}

/**
 * Articulation points of the undirected graph (Tarjan's lowlink, iterative), each with the sizes
 * of the pieces the rest of its component falls into when the node is removed. A document is a
 * single point of failure when removing it disconnects other documents from each other.
 *
 * Piece sizes are measured with a plain BFS per articulation point. Vaults are at most a few
 * thousand documents and articulation points are rare, so the extra pass is cheap and keeps the
 * lowlink part free of size bookkeeping.
 */
export function articulationPoints(adjacency: Map<string, Set<string>>): Map<string, { pieces: number[] }> {
  const ids = [...adjacency.keys()].sort()
  const disc = new Map<string, number>()
  const low = new Map<string, number>()
  const cuts = new Set<string>()
  let time = 0

  for (const root of ids) {
    if (disc.has(root)) continue
    type Frame = { node: string; parent: string | null; iter: Iterator<string> }
    disc.set(root, time); low.set(root, time); time++
    const stack: Frame[] = [{ node: root, parent: null, iter: adjacency.get(root)!.values() }]
    let rootChildren = 0

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const next = frame.iter.next()
      if (!next.done) {
        const nb = next.value
        if (!disc.has(nb)) {
          if (frame.node === root) rootChildren++
          disc.set(nb, time); low.set(nb, time); time++
          stack.push({ node: nb, parent: frame.node, iter: adjacency.get(nb)!.values() })
        } else if (nb !== frame.parent) {
          low.set(frame.node, Math.min(low.get(frame.node)!, disc.get(nb)!))
        }
        continue
      }
      stack.pop()
      if (frame.parent === null) continue
      const parent = frame.parent
      low.set(parent, Math.min(low.get(parent)!, low.get(frame.node)!))
      // Non-root parent is a cut vertex when this child's subtree cannot reach above the parent
      if (parent !== root && low.get(frame.node)! >= disc.get(parent)!) cuts.add(parent)
    }
    // The DFS root is a cut vertex iff it has two or more DFS children
    if (rootChildren >= 2) cuts.add(root)
  }

  const result = new Map<string, { pieces: number[] }>()
  for (const cut of cuts) result.set(cut, { pieces: piecesWithout(cut, adjacency) })
  return result
}

/** Sizes of the connected pieces the neighbours of `removed` fall into once it is gone. */
function piecesWithout(removed: string, adjacency: Map<string, Set<string>>): number[] {
  const seen = new Set<string>([removed])
  const pieces: number[] = []
  for (const start of adjacency.get(removed)!) {
    if (seen.has(start)) continue
    let size = 0
    const stack = [start]
    seen.add(start)
    while (stack.length) {
      const n = stack.pop()!
      size++
      for (const nb of adjacency.get(n)!) if (!seen.has(nb)) { seen.add(nb); stack.push(nb) }
    }
    pieces.push(size)
  }
  return pieces.sort((a, b) => b - a)
}
