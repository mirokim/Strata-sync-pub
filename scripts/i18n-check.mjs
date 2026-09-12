#!/usr/bin/env node
/**
 * i18n consistency check.
 *   node scripts/i18n-check.mjs
 * - the same English key translated differently in two dictionary files (the merge would pick one silently)
 * - t('…') keys used in src/ that no dictionary translates
 * - dictionary entries that no t('…') call uses any more
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const DICT_DIR = 'src/i18n/ko'
const ENTRY = /^\s*'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm
const unescape = s => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\')

const seen = new Map()
const conflicts = []
let entries = 0
for (const f of readdirSync(DICT_DIR)) {
  if (f === 'index.ts') continue
  const s = readFileSync(join(DICT_DIR, f), 'utf8')
  for (const m of s.matchAll(ENTRY)) {
    entries++
    const k = unescape(m[1]), v = unescape(m[2])
    const prev = seen.get(k)
    if (prev && prev.v !== v) conflicts.push({ k, a: `${prev.f}: ${prev.v}`, b: `${f}: ${v}` })
    else if (!prev) seen.set(k, { v, f })
  }
}

const used = new Map()
const walk = d => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'i18n') walk(p) } else if (/\.tsx?$/.test(e.name)) scan(p) } }
const CALL = /\bt\(\s*'((?:[^'\\]|\\.)*)'/g
const scan = p => { const s = readFileSync(p, 'utf8'); for (const m of s.matchAll(CALL)) { const k = unescape(m[1]); if (!used.has(k)) used.set(k, p) } }
walk('src')

const missing = [...used].filter(([k]) => !seen.has(k))
const unused = [...seen.keys()].filter(k => !used.has(k))
console.log(`dictionary entries ${entries} (unique keys ${seen.size}) · t() keys used ${used.size}`)
console.log(`conflicting translations: ${conflicts.length}`)
for (const c of conflicts) console.log(`  ${JSON.stringify(c.k)}\n     ${c.a}\n     ${c.b}`)
console.log(`used but untranslated: ${missing.length}`)
for (const [k, p] of missing) console.log(`  ${JSON.stringify(k)}  ← ${p}`)
console.log(`translated but unused: ${unused.length}`)
if (process.argv.includes('--unused')) for (const k of unused) console.log(`  ${JSON.stringify(k)}`)
process.exit(conflicts.length || missing.length ? 1 : 0)
