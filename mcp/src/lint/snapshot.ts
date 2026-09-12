/**
 * Persistence for the lint snapshot (`<vault>/.strata-sync/lint-snapshot.json`).
 *
 * Kept out of index.ts so the runner stays free of filesystem access; the MCP tool, the CLI
 * and the nightly batch each decide where the snapshot lives.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { LintSnapshot } from './types.js'

export const SNAPSHOT_REL_PATH = join('.strata-sync', 'lint-snapshot.json')

export function readSnapshot(vaultPath: string): LintSnapshot | undefined {
  const file = join(vaultPath, SNAPSHOT_REL_PATH)
  if (!existsSync(file)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<LintSnapshot>
    if (parsed.version !== 1 || !Array.isArray(parsed.communities) || typeof parsed.generatedAt !== 'string') return undefined
    return parsed as LintSnapshot
  } catch {
    // A corrupt snapshot only costs one drift comparison; it is overwritten by this run.
    return undefined
  }
}

export function writeSnapshot(vaultPath: string, snapshot: LintSnapshot): void {
  const dir = join(vaultPath, '.strata-sync')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(vaultPath, SNAPSHOT_REL_PATH), JSON.stringify(snapshot), 'utf-8')
}
