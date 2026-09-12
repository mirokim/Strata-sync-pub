/**
 * oasisEnvironment.ts — OASIS 환경 (포스트 저장소 + 추천 엔진 + 행동 결정)
 *
 * OASIS environment.py + recommendation_system.py + action_space.py를
 * TypeScript로 재현합니다.
 */

import type { SocialGraph } from './socialGraph'

export interface OASISPost {
  id: string
  authorId: string
  authorName: string
  stance: string
  content: string
  round: number
  timestamp: number
  likes: Set<string>      // 좋아요 누른 에이전트 ID
  reposts: Set<string>    // 리포스트한 에이전트 ID
  originalPostId?: string // 리포스트인 경우 원본 포스트 ID
  /** 작성자의 커뮤니티 영향력 (0.1–1.0) — 추천 가중치에 반영 */
  influenceWeight: number
}

export type ActionType = 'post' | 'repost' | 'like' | 'follow' | 'do_nothing'

export interface AgentDecision {
  action: ActionType
  targetPostId?: string
  targetAgentId?: string
}

// 행동 타입별 기본 가중치 (OASIS action_space 대응)
const ACTION_WEIGHTS: Record<ActionType, number> = {
  post:       0.75,
  repost:     0.15,
  like:       0.05,
  follow:     0.03,
  do_nothing: 0.02,
}

export class OASISEnvironment {
  posts: OASISPost[] = []
  private counter = 0

  constructor(private graph: SocialGraph) {}

  // ── 포스트 관리 ─────────────────────────────────────────────────────────────

  addPost(
    authorId: string, authorName: string, stance: string,
    content: string, round: number, originalPostId?: string,
    influenceWeight = 0.5,
  ): OASISPost {
    const post: OASISPost = {
      id: `post_${++this.counter}`,
      authorId, authorName, stance, content, round,
      timestamp: Date.now(),
      likes: new Set(),
      reposts: new Set(),
      originalPostId,
      influenceWeight,
    }
    this.posts.push(post)
    return post
  }

  likePost(agentId: string, postId: string): void {
    this.posts.find(p => p.id === postId)?.likes.add(agentId)
  }

  getPost(postId: string): OASISPost | undefined {
    return this.posts.find(p => p.id === postId)
  }

  // ── 추천 엔진 (OASIS recommendation_system.py 대응) ─────────────────────────

  getRecommendedPosts(agentId: string, limit = 15): OASISPost[] {
    const following = new Set(this.graph.getFollowing(agentId))

    const fromFollowing = this.posts
      .filter(p => following.has(p.authorId) && p.authorId !== agentId)
      .slice(-20)

    // 트렌딩: 좋아요+리포스트 수 + 작성자 영향력 가중치 합산
    const trending = [...this.posts]
      .sort((a, b) => {
        const scoreA = (a.likes.size + a.reposts.size) + a.influenceWeight * 3
        const scoreB = (b.likes.size + b.reposts.size) + b.influenceWeight * 3
        return scoreB - scoreA
      })
      .slice(0, 10)

    const seen = new Set<string>()
    const merged: OASISPost[] = []
    for (const p of [...fromFollowing, ...trending]) {
      if (!seen.has(p.id)) { seen.add(p.id); merged.push(p) }
    }
    return merged.slice(0, limit)
  }

  // ── 행동 결정 (OASIS action_space.py 대응) ──────────────────────────────────

  decideAction(agentId: string): AgentDecision {
    const hasPosts = this.posts.length > 0
    const following = this.graph.getFollowing(agentId)
    const allIds = this.graph.allAgentIds()
    const notFollowing = allIds.filter(id => id !== agentId && !following.includes(id))

    const weights = { ...ACTION_WEIGHTS }
    if (!hasPosts) {
      weights.post += (weights.repost ?? 0) + (weights.like ?? 0)
      weights.repost = 0
      weights.like = 0
    }
    if (!notFollowing.length) {
      weights.post += weights.follow ?? 0
      weights.follow = 0
    }

    const entries = Object.entries(weights) as [ActionType, number][]
    const total = entries.reduce((s, [, w]) => s + w, 0)
    let rng = Math.random() * total
    let action: ActionType = 'post'
    for (const [act, w] of entries) {
      rng -= w
      if (rng <= 0) { action = act; break }
    }

    if ((action === 'repost' || action === 'like') && hasPosts) {
      const pool = [...this.posts]
        .sort((a, b) => (b.likes.size + b.reposts.size) - (a.likes.size + a.reposts.size))
        .slice(0, 5)
      if (!pool.length) return { action: 'post' }
      const target = pool[Math.floor(Math.random() * pool.length)]
      return { action, targetPostId: target.id }
    }

    if (action === 'follow' && notFollowing.length) {
      const target = notFollowing[Math.floor(Math.random() * notFollowing.length)]
      return { action, targetAgentId: target }
    }

    return { action }
  }
}
