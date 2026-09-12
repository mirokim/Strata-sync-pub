#!/usr/bin/env node
/**
 * Write the lint test fixture vault (mcp/src/lint/__tests__/fixtureVault.ts) to a real folder so the
 * CLI can be exercised end to end in CI: `node mcp/scripts/fixture-vault.mjs <dir>`.
 *
 * Parses the SPECS table with a regex rather than importing the TypeScript, so it needs no build.
 */
import { readFileSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]
if (!target) { console.error('usage: fixture-vault.mjs <dir>'); process.exit(2) }

const src = readFileSync(join(here, '..', 'src', 'lint', '__tests__', 'fixtureVault.ts'), 'utf-8')
const spec = /\{ name: '([^']+)'(?:, folder: '([^']+)')?(?:, ageDays: (\d+))?, body: '((?:[^'\\]|\\.)*)' \}/g
let count = 0
for (const m of src.matchAll(spec)) {
  const [, name, folder, ageDays, rawBody] = m
  const dir = folder ? join(target, folder) : target
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${name}.md`)
  writeFileSync(file, `---\ntags: [test]\n---\n\n# ${name}\n\n${rawBody.replace(/\\'/g, "'")}\n`, 'utf-8')
  if (ageDays) { const t = new Date(Date.now() - Number(ageDays) * 86_400_000); utimesSync(file, t, t) }
  count++
}
console.log(`${count} fixture documents written to ${target}`)
