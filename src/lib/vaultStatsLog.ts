/**
 * vaultStatsLog.ts — 볼트 문서 통계 스냅샷 로그
 *
 * 볼트 로드 시마다 항목별 문서 수를 JSONL로 기록.
 * StatsTab에서 시계열 차트로 시각화.
 */

import type { LoadedDocument } from '@/types'
import { logger } from '@/lib/logger'

const STATS_FILE = '.strata-sync/vault-stats.jsonl'
const MAX_ENTRIES = 365  // 최대 1년치 보관

export interface VaultStatsSnapshot {
  date: string           // YYYY-MM-DD
  total: number
  byOrigin: Record<string, number>   // confluence, jira, (none)
  byType: Record<string, number>     // spec, decision, meeting, ...
  byStatus: Record<string, number>   // active, outdated, deprecated
  bySpeaker: Record<string, number>  // chief_director, art_director, ...
  byFolder: Record<string, number>   // top-level folder → count
  totalChars: number
  totalLinks: number
  orphanCount: number
}

/** 현재 문서 목록에서 스냅샷 생성 */
export function buildStatsSnapshot(docs: LoadedDocument[]): VaultStatsSnapshot {
  const today = new Date()
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`

  const byOrigin: Record<string, number> = {}
  const byType: Record<string, number> = {}
  const byStatus: Record<string, number> = {}
  const bySpeaker: Record<string, number> = {}
  const byFolder: Record<string, number> = {}
  let totalChars = 0
  let totalLinks = 0
  let orphanCount = 0

  for (const d of docs) {
    const origin = d.origin || 'manual'
    byOrigin[origin] = (byOrigin[origin] ?? 0) + 1

    const type = d.type || 'unknown'
    byType[type] = (byType[type] ?? 0) + 1

    const status = d.status || 'none'
    byStatus[status] = (byStatus[status] ?? 0) + 1

    bySpeaker[d.speaker] = (bySpeaker[d.speaker] ?? 0) + 1

    const folder = d.folderPath?.split('/')[0] || '(root)'
    byFolder[folder] = (byFolder[folder] ?? 0) + 1

    totalChars += d.rawContent?.length ?? 0

    // d.links 는 frontmatter `links:` 필드만 담는다. 실측 볼트(2,635문서)에서
    // frontmatter links 보유 문서는 0개, 본문 위키링크 보유 문서는 1,543개 —
    // 즉 예전 코드는 매일 totalLinks: 0 / orphanCount: 전체(고아율 100%)를 기록했다.
    // 본문 위키링크를 정규화·중복 제거하여 집계한다.
    const unique = new Set<string>()
    for (const s of d.sections) {
      for (const raw of s.wikiLinks) {
        // [[target|display]] / [[target#heading]] 정규화
        const t = raw.split('|')[0].split('#')[0].trim().replace(/[/\\]+$/, '').trim().toLowerCase()
        if (t) unique.add(t)
      }
    }
    for (const l of d.links) {
      const t = l.trim().toLowerCase()
      if (t) unique.add(t)
    }

    totalLinks += unique.size
    if (unique.size === 0) orphanCount++
  }

  return { date, total: docs.length, byOrigin, byType, byStatus, bySpeaker, byFolder, totalChars, totalLinks, orphanCount }
}

/** 스냅샷을 파일에 추가 (같은 날짜면 덮어쓰기) */
export async function saveStatsSnapshot(vaultPath: string, snapshot: VaultStatsSnapshot): Promise<void> {
  if (!window.vaultAPI) return
  try {
    const logPath = `${vaultPath}/${STATS_FILE}`
    const existing = (await window.vaultAPI.readFile(logPath)) ?? ''
    const lines = existing.split('\n').filter(l => l.trim())

    // 같은 날짜 항목 제거 (하루 1개만 유지)
    const filtered = lines.filter(l => {
      try { return JSON.parse(l).date !== snapshot.date } catch { return true }
    })

    filtered.push(JSON.stringify(snapshot))

    // MAX_ENTRIES 초과 시 오래된 것 제거
    while (filtered.length > MAX_ENTRIES) filtered.shift()

    await window.vaultAPI.saveFile(logPath, filtered.join('\n') + '\n')
  } catch (e) {
    logger.warn('[vaultStatsLog] 저장 실패:', e)
  }
}

/** 저장된 스냅샷 로그 전체 로드 */
export async function loadStatsLog(vaultPath: string): Promise<VaultStatsSnapshot[]> {
  if (!window.vaultAPI) return []
  try {
    const logPath = `${vaultPath}/${STATS_FILE}`
    const raw = await window.vaultAPI.readFile(logPath)
    if (!raw) return []
    return raw.split('\n')
      .filter(l => l.trim())
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean) as VaultStatsSnapshot[]
  } catch {
    return []
  }
}
