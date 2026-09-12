/**
 * vaultStatsLog.ts — Vault document statistics snapshot log
 *
 * Records per-category document counts as JSONL on every vault load.
 * Visualized as a time-series chart in StatsTab.
 */

import type { LoadedDocument } from '@/types'
import { logger } from '@/lib/logger'

const STATS_FILE = '.strata-sync/vault-stats.jsonl'
const MAX_ENTRIES = 365  // keep at most 1 year

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

/** Build a snapshot from the current document list */
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

    // d.links only holds the frontmatter `links:` field. In a real vault (2,635 docs),
    // 0 docs had frontmatter links while 1,543 had body wikilinks —
    // i.e. the old code recorded totalLinks: 0 / orphanCount: all (100% orphan rate) every day.
    // Aggregate body wikilinks after normalizing and de-duplicating them.
    const unique = new Set<string>()
    for (const s of d.sections) {
      for (const raw of s.wikiLinks) {
        // Normalize [[target|display]] / [[target#heading]]
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

/** Append a snapshot to the file (overwrites an entry with the same date) */
export async function saveStatsSnapshot(vaultPath: string, snapshot: VaultStatsSnapshot): Promise<void> {
  if (!window.vaultAPI) return
  try {
    const logPath = `${vaultPath}/${STATS_FILE}`
    const existing = (await window.vaultAPI.readFile(logPath)) ?? ''
    const lines = existing.split('\n').filter(l => l.trim())

    // Remove entries with the same date (keep only one per day)
    const filtered = lines.filter(l => {
      try { return JSON.parse(l).date !== snapshot.date } catch { return true }
    })

    filtered.push(JSON.stringify(snapshot))

    // Drop the oldest entries when exceeding MAX_ENTRIES
    while (filtered.length > MAX_ENTRIES) filtered.shift()

    await window.vaultAPI.saveFile(logPath, filtered.join('\n') + '\n')
  } catch (e) {
    logger.warn('[vaultStatsLog] Failed to save:', e)
  }
}

/** Load the entire saved snapshot log */
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
