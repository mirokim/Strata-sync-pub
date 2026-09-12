/**
 * pprWorker.ts — Runs Personalized PageRank (PPR) computation off the main thread
 *
 * Message protocol:
 *   IN  { type: 'ppr', requestId, seeds, links, alpha, iterations }
 *         → Power Iteration → { type: 'done', requestId, scores: [string, number][] }
 *   OUT { type: 'error', requestId, message }
 *
 * seeds is `{ id, weight }[]` — weight is the search score. The personalization vector is
 * built proportionally to weight, so the top vector-search document and supplementary seeds are not treated equally.
 */

interface PPRLink {
  source: string
  target: string
  strength: number
}

interface PPRSeed {
  id: string
  weight: number
}

type InMsg = {
  type: 'ppr'
  requestId: string
  seeds: PPRSeed[]
  links: PPRLink[]
  alpha: number
  iterations: number
}

type OutMsg =
  | { type: 'done';  requestId: string; scores: [string, number][] }
  | { type: 'error'; requestId: string; message: string }

self.onmessage = (e: MessageEvent<InMsg>) => {
  const { requestId, seeds, links, alpha, iterations } = e.data
  try {
    const scores = runPPR(seeds, links, alpha, iterations)
    self.postMessage({ type: 'done', requestId, scores: [...scores.entries()] } satisfies OutMsg)
  } catch (err) {
    self.postMessage({ type: 'error', requestId, message: String(err) } satisfies OutMsg)
  }
}

function runPPR(
  seeds: PPRSeed[],
  links: PPRLink[],
  alpha: number,
  iterations: number,
): Map<string, number> {
  if (seeds.length === 0 || links.length === 0) return new Map()

  // Build weighted adjacency list (undirected graph)
  const outWeightSum = new Map<string, number>()
  const inEdges = new Map<string, { from: string; w: number }[]>()

  for (const link of links) {
    const { source: src, target: tgt, strength: w } = link

    outWeightSum.set(src, (outWeightSum.get(src) ?? 0) + w)
    outWeightSum.set(tgt, (outWeightSum.get(tgt) ?? 0) + w)

    if (!inEdges.has(tgt)) inEdges.set(tgt, [])
    if (!inEdges.has(src)) inEdges.set(src, [])
    inEdges.get(tgt)!.push({ from: src, w })
    inEdges.get(src)!.push({ from: tgt, w })
  }

  const allNodes = new Set<string>([...outWeightSum.keys(), ...inEdges.keys()])
  for (const s of seeds) allNodes.add(s.id)

  // Score-weighted personalization vector — normalized to sum to 1.
  // With uniform 1/N, the top vector-search document and the 20th supplementary seed
  // would be treated equally, and the search ranking would be completely lost at the PPR stage.
  const seedW = new Map<string, number>()
  let totalW = 0
  for (const s of seeds) {
    const w = s.weight > 0 ? s.weight : 0
    seedW.set(s.id, (seedW.get(s.id) ?? 0) + w)
    totalW += w
  }
  if (totalW <= 0) {
    // All weights are 0/negative — fall back to uniform distribution
    const uniform = 1 / seedW.size
    for (const id of seedW.keys()) seedW.set(id, uniform)
  } else {
    for (const [id, w] of seedW) seedW.set(id, w / totalW)
  }

  // Double buffer — swap two Maps instead of allocating a new Map every iteration
  let scores = new Map<string, number>()
  let next = new Map<string, number>()
  for (const id of allNodes) {
    scores.set(id, seedW.get(id) ?? 0)
    next.set(id, 0)
  }

  for (let iter = 0; iter < iterations; iter++) {
    for (const id of allNodes) {
      let s = alpha * (seedW.get(id) ?? 0)
      for (const { from, w } of inEdges.get(id) ?? []) {
        const totalW = outWeightSum.get(from) ?? 1
        s += (1 - alpha) * (scores.get(from) ?? 0) * w / totalW
      }
      next.set(id, s)
    }
    // Swap buffers
    const tmp = scores; scores = next; next = tmp
  }

  return scores
}
