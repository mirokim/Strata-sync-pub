/**
 * socialGraph.ts — OASIS 소셜 네트워크 그래프
 *
 * Barabási-Albert 선호적 연결 모델로 현실적인 팔로우 네트워크를 생성합니다.
 * OASIS social_graph.py를 TypeScript로 재현합니다.
 */

export class SocialGraph {
  private following = new Map<string, Set<string>>()  // agentId → 팔로우하는 ID 집합
  private followers = new Map<string, Set<string>>()  // agentId → 팔로워 ID 집합

  constructor(agentIds: string[]) {
    for (const id of agentIds) {
      this.following.set(id, new Set())
      this.followers.set(id, new Set())
    }
  }

  /**
   * Barabási-Albert 모델로 소셜 그래프 생성.
   * m: 신규 노드가 연결할 기존 노드 수 (기본 2).
   * 팔로워가 많은 노드일수록 새 팔로우를 받을 확률이 높음.
   */
  static generate(agentIds: string[], m = 2): SocialGraph {
    const graph = new SocialGraph(agentIds)
    if (agentIds.length < 2) return graph

    const initial = agentIds.slice(0, Math.min(m + 1, agentIds.length))
    for (const a of initial) {
      for (const b of initial) {
        if (a !== b) graph.follow(a, b)
      }
    }

    for (const newNode of agentIds.slice(initial.length)) {
      for (const target of graph._preferentialAttachment(newNode, m)) {
        graph.follow(newNode, target)
      }
    }

    return graph
  }

  private _preferentialAttachment(exclude: string, m: number): string[] {
    const pool: string[] = []
    for (const [id, fset] of this.followers) {
      if (id === exclude) continue
      const weight = fset.size + 1
      for (let i = 0; i < weight; i++) pool.push(id)
    }
    // Fisher-Yates 셔플 (Math.random().sort() 는 분포 편향 있음)
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    const targets = new Set<string>()
    for (const c of pool) {
      if (targets.size >= m) break
      targets.add(c)
    }
    return [...targets]
  }

  follow(from: string, to: string): void {
    this.following.get(from)?.add(to)
    this.followers.get(to)?.add(from)
  }

  unfollow(from: string, to: string): void {
    this.following.get(from)?.delete(to)
    this.followers.get(to)?.delete(from)
  }

  getFollowing(agentId: string): string[] {
    return [...(this.following.get(agentId) ?? [])]
  }

  getFollowers(agentId: string): string[] {
    return [...(this.followers.get(agentId) ?? [])]
  }

  followerCount(agentId: string): number {
    return this.followers.get(agentId)?.size ?? 0
  }

  allAgentIds(): string[] {
    return [...this.following.keys()]
  }
}
