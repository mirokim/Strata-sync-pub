/**
 * Louvain community detection (Blondel et al. 2008) for the vault link graph.
 *
 * Why not connected components: a wiki with a hub page is one giant component, so components
 * say nothing about topic structure and "bridge between clusters" is impossible by definition.
 * Louvain maximises modularity, which splits that component into densely linked groups —
 * combat docs, narrative docs, pipeline docs — and lets the lint talk about documents that sit
 * between such groups.
 *
 * Deterministic: nodes are visited in sorted-id order and ties are broken by community id, so
 * the same vault always produces the same partition (needed for snapshot comparison).
 */

export interface CommunityResult {
  /** docId → community index (0 = largest community) */
  membership: Map<string, number>
  /** communities[i] = sorted docIds, sorted by size descending */
  communities: string[][]
  modularity: number
}

interface Graph {
  n: number
  ids: string[]
  /** adjacency as parallel arrays: neighbours[i] = [nodeIndex...], weights[i] = [w...] */
  neighbours: number[][]
  weights: number[][]
  degree: number[]
  totalWeight: number  // sum of all edge weights (each undirected edge counted once)
}

/**
 * @param adjacency undirected neighbour sets
 * @param weight    optional edge weight lookup (defaults to 1). Symmetric weights expected.
 * @param resolution >1 favours smaller communities, <1 larger. Default 1.
 */
export function detectCommunities(
  adjacency: Map<string, Set<string>>,
  weight: (a: string, b: string) => number = () => 1,
  resolution = 1,
): CommunityResult {
  const ids = [...adjacency.keys()].sort()
  const index = new Map(ids.map((id, i) => [id, i]))
  let graph = toGraph(ids, index, adjacency, weight)

  // membershipOf[level] maps node index at that level → community index at that level
  let nodeToCommunity: number[] = graph.ids.map((_, i) => i)
  let improved = true
  let passes = 0

  while (improved && passes < 50) {
    passes++
    const { assignment, changed } = localMoving(graph, resolution)
    improved = changed
    // Compose: original node → current community
    const renumber = compact(assignment)
    nodeToCommunity = nodeToCommunity.map(c => renumber[c])
    if (!changed) break
    graph = aggregate(graph, renumber)
    if (graph.n === 1) break
  }

  // Group and order by size desc, then by smallest id for determinism
  const groups = new Map<number, string[]>()
  ids.forEach((id, i) => {
    const c = nodeToCommunity[i]
    if (!groups.has(c)) groups.set(c, [])
    groups.get(c)!.push(id)
  })
  const communities = [...groups.values()]
    .map(g => g.sort())
    .sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1))
  const membership = new Map<string, number>()
  communities.forEach((g, i) => g.forEach(id => membership.set(id, i)))

  return { membership, communities, modularity: modularity(ids, index, adjacency, weight, membership, resolution) }
}

function toGraph(ids: string[], index: Map<string, number>, adjacency: Map<string, Set<string>>, weight: (a: string, b: string) => number): Graph {
  const n = ids.length
  const neighbours: number[][] = Array.from({ length: n }, () => [])
  const weights: number[][] = Array.from({ length: n }, () => [])
  const degree = new Array<number>(n).fill(0)
  let totalWeight = 0
  for (let i = 0; i < n; i++) {
    for (const nbId of [...adjacency.get(ids[i])!].sort()) {
      const j = index.get(nbId)!
      const w = weight(ids[i], nbId)
      neighbours[i].push(j); weights[i].push(w)
      degree[i] += w
    }
  }
  // Every undirected edge contributes to two degrees, so m = Σdeg / 2 (self-loops included).
  for (const d of degree) totalWeight += d / 2
  return { n, ids, neighbours, weights, degree, totalWeight }
}

/** One local-moving phase. Returns each node's community and whether anything moved. */
function localMoving(g: Graph, resolution: number): { assignment: number[]; changed: boolean } {
  const assignment = g.ids.map((_, i) => i)
  const communityDegree = [...g.degree]  // Σ degrees of members
  const m2 = 2 * g.totalWeight
  if (m2 === 0) return { assignment, changed: false }
  let changedOverall = false
  let moved = true
  let rounds = 0

  while (moved && rounds < 100) {
    moved = false
    rounds++
    for (let i = 0; i < g.n; i++) {
      const current = assignment[i]
      // weight from i into each neighbouring community
      const toCommunity = new Map<number, number>()
      for (let k = 0; k < g.neighbours[i].length; k++) {
        // A self-loop (aggregated internal edges) moves with the node and never counts as k_i,in
        if (g.neighbours[i][k] === i) continue
        const c = assignment[g.neighbours[i][k]]
        toCommunity.set(c, (toCommunity.get(c) ?? 0) + g.weights[i][k])
      }
      // Remove i from its community for the gain computation
      communityDegree[current] -= g.degree[i]
      const ki = g.degree[i]
      let best = current
      let bestGain = gain(toCommunity.get(current) ?? 0, communityDegree[current], ki, m2, resolution)
      const candidates = [...toCommunity.keys()].sort((a, b) => a - b)
      for (const c of candidates) {
        if (c === current) continue
        const gn = gain(toCommunity.get(c)!, communityDegree[c], ki, m2, resolution)
        if (gn > bestGain + 1e-12) { bestGain = gn; best = c }
      }
      communityDegree[best] += g.degree[i]
      if (best !== current) { assignment[i] = best; moved = true; changedOverall = true }
    }
  }
  return { assignment, changed: changedOverall }
}

/** Modularity gain of inserting an isolated node (degree ki) into community c. */
function gain(kiIn: number, sigmaTot: number, ki: number, m2: number, resolution: number): number {
  return kiIn - resolution * (sigmaTot * ki) / m2
}

/** Renumber community ids to 0..k-1 in order of first appearance. */
function compact(assignment: number[]): number[] {
  const map = new Map<number, number>()
  const out = new Array<number>(assignment.length)
  for (let i = 0; i < assignment.length; i++) {
    const c = assignment[i]
    if (!map.has(c)) map.set(c, map.size)
    out[i] = map.get(c)!
  }
  return out
}

/** Collapse each community into one node; edge weights are summed (self-loops kept as degree). */
function aggregate(g: Graph, renumber: number[]): Graph {
  const k = Math.max(...renumber) + 1
  const acc: Map<number, number>[] = Array.from({ length: k }, () => new Map())
  const degree = new Array<number>(k).fill(0)
  let totalWeight = 0
  for (let i = 0; i < g.n; i++) {
    const ci = renumber[i]
    degree[ci] += g.degree[i]
    for (let idx = 0; idx < g.neighbours[i].length; idx++) {
      const j = g.neighbours[i][idx]
      const cj = renumber[j]
      const w = g.weights[i][idx]
      // Internal edges become a self-loop; each undirected edge is visited from both endpoints,
      // so the self-loop ends up at 2w and degree stays consistent with Σdeg / 2 = m.
      acc[ci].set(cj, (acc[ci].get(cj) ?? 0) + w)
    }
  }
  for (const d of degree) totalWeight += d / 2
  const neighbours: number[][] = []
  const weights: number[][] = []
  for (let c = 0; c < k; c++) {
    const entries = [...acc[c].entries()].sort((a, b) => a[0] - b[0])
    neighbours.push(entries.map(e => e[0]))
    weights.push(entries.map(e => e[1]))
  }
  return { n: k, ids: Array.from({ length: k }, (_, c) => String(c)), neighbours, weights, degree, totalWeight }
}

function modularity(
  ids: string[], index: Map<string, number>, adjacency: Map<string, Set<string>>,
  weight: (a: string, b: string) => number, membership: Map<string, number>, resolution: number,
): number {
  let m2 = 0
  const degree = new Map<string, number>()
  for (const id of ids) {
    let d = 0
    for (const nb of adjacency.get(id)!) d += weight(id, nb)
    degree.set(id, d); m2 += d
  }
  if (m2 === 0) return 0
  let q = 0
  for (const id of ids) {
    const ci = membership.get(id)
    for (const nb of adjacency.get(id)!) {
      if (membership.get(nb) === ci) q += weight(id, nb)
    }
  }
  // subtract expected
  const sigma = new Map<number, number>()
  for (const id of ids) sigma.set(membership.get(id)!, (sigma.get(membership.get(id)!) ?? 0) + degree.get(id)!)
  let expected = 0
  for (const s of sigma.values()) expected += s * s
  return q / m2 - resolution * expected / (m2 * m2)
}
