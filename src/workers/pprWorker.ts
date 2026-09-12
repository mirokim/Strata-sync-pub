/**
 * pprWorker.ts — Personalized PageRank (PPR) 계산을 메인 스레드 밖에서 실행
 *
 * 메시지 프로토콜:
 *   IN  { type: 'ppr', requestId, seeds, links, alpha, iterations }
 *         → Power Iteration → { type: 'done', requestId, scores: [string, number][] }
 *   OUT { type: 'error', requestId, message }
 *
 * seeds 는 `{ id, weight }[]` — weight 는 검색 점수. 개인화 벡터를 weight 비율로
 * 구성하므로 벡터 1위 문서와 보완 시드가 동일 취급되지 않습니다.
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

  // 가중치 인접 리스트 구축 (무방향 그래프)
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

  // 점수 가중 개인화 벡터 — 합이 1이 되도록 정규화.
  // 균등 1/N 이면 벡터 1위 문서와 20번째 보완 시드가 동일 취급되어
  // 검색 랭킹이 PPR 단계에서 완전히 소실된다.
  const seedW = new Map<string, number>()
  let totalW = 0
  for (const s of seeds) {
    const w = s.weight > 0 ? s.weight : 0
    seedW.set(s.id, (seedW.get(s.id) ?? 0) + w)
    totalW += w
  }
  if (totalW <= 0) {
    // 모든 weight가 0/음수 — 균등 분포로 폴백
    const uniform = 1 / seedW.size
    for (const id of seedW.keys()) seedW.set(id, uniform)
  } else {
    for (const [id, w] of seedW) seedW.set(id, w / totalW)
  }

  // 이중 버퍼 — 매 이터레이션마다 new Map 대신 두 Map을 교체 사용
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
    // 버퍼 스왑
    const tmp = scores; scores = next; next = tmp
  }

  return scores
}
