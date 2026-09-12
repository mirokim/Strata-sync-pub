/**
 * graph3dQuality.ts — pure helpers behind the 3D graph's scaling: bounded label pool, geometry LOD,
 * adaptive quality levels and the edge subset.
 * Kept free of three.js so they can be unit-tested without a WebGL mock.
 */

/** Sphere tessellation for the instanced node geometry: fewer triangles as the graph grows. */
export function sphereSegmentsFor(nodeCount: number): [number, number] {
  if (nodeCount > 4000) return [8, 6]
  if (nodeCount > 2500) return [10, 7]
  if (nodeCount > 800) return [14, 10]
  return [20, 14]
}

/**
 * Which nodes get a label when there are more nodes than labels. Hovered, selected and AI-highlighted
 * nodes always do; the rest of the pool goes to nodes in front of the camera, ranked by degree and
 * closeness (score = (degree + 1) / (distance + 50)), so hubs stay labelled from afar and the
 * neighbourhood the user is looking at gets labelled up close.
 */
export function chooseLabelledNodes(
  nodes: { id: string; deg: number; x: number; y: number; z: number }[],
  poolSize: number,
  camera: { position: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number } },
  pinned: Iterable<string>,
): string[] {
  const chosen: string[] = []
  const taken = new Set<string>()
  for (const id of pinned) { if (id && !taken.has(id) && chosen.length < poolSize) { taken.add(id); chosen.push(id) } }
  if (nodes.length <= poolSize) {
    for (const n of nodes) if (!taken.has(n.id)) chosen.push(n.id)
    return chosen
  }
  const scored: { id: string; score: number }[] = []
  const { x: cx, y: cy, z: cz } = camera.position
  const { x: fx, y: fy, z: fz } = camera.forward
  for (const n of nodes) {
    if (taken.has(n.id)) continue
    const dx = n.x - cx, dy = n.y - cy, dz = n.z - cz
    if (dx * fx + dy * fy + dz * fz <= 0) continue          // behind the camera
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    scored.push({ id: n.id, score: (n.deg + 1) / (dist + 50) })
  }
  scored.sort((a, b) => b.score - a.score)
  for (let i = 0; i < scored.length && chosen.length < poolSize; i++) chosen.push(scored[i].id)
  return chosen
}

/**
 * Adaptive render quality. The animation loop feeds in the interval between consecutively rendered
 * frames; once a window of frames has a median above `slowMs` the level steps down (never up, so the
 * picture does not oscillate). Levels: 0 full · 1 pixel ratio 1 · 2 half the edges · 3 auto-rotate
 * rendered at half rate.
 */
export const QUALITY_MAX = 3
export function nextQualityLevel(level: number, frameIntervalsMs: number[], slowMs = 24): number {
  if (level >= QUALITY_MAX || frameIntervalsMs.length === 0) return level
  const sorted = [...frameIntervalsMs].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return median > slowMs ? level + 1 : level
}

/**
 * Mask of the strongest `fraction` of links (1 = drawn). Computed once per quality change; the
 * per-hover index build below only reads it.
 */
export function strongestEdgeMask(strengths: ArrayLike<number>, fraction: number): Uint8Array {
  const n = strengths.length
  const keep = Math.max(0, Math.min(n, Math.floor(n * fraction)))
  const mask = new Uint8Array(n)
  if (keep >= n) mask.fill(1)
  else if (keep > 0) {
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => strengths[b] - strengths[a] || a - b)
    for (let k = 0; k < keep; k++) mask[order[k]] = 1
  }
  return mask
}

/**
 * Index buffer for an edge subset: every link in `mask` plus every link in `mustKeep` (the hovered
 * node's neighbourhood), in original order. Link i occupies vertices 2i, 2i+1 of the LineSegments
 * position buffer, so hiding an edge is just leaving it out of the index.
 */
export function edgeSubsetIndex(mask: Uint8Array, mustKeep?: Iterable<number>): Uint32Array {
  const n = mask.length
  const extra = new Set<number>()
  if (mustKeep) for (const i of mustKeep) if (i >= 0 && i < n && !mask[i]) extra.add(i)
  let count = extra.size
  for (let i = 0; i < n; i++) count += mask[i]
  const index = new Uint32Array(count * 2)
  let w = 0
  for (let i = 0; i < n; i++) if (mask[i] || extra.has(i)) { index[w++] = 2 * i; index[w++] = 2 * i + 1 }
  return index
}
