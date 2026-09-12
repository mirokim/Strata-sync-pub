#!/usr/bin/env node
/**
 * `lint:vault` — run the vault lint from a shell or CI.
 *
 *   node mcp/dist/src/cli/lint.js --vault <path> [--format json|md] [--out <file>]
 *        [--rules phantom-hot,orphan] [--min-severity warn] [--fail-on error|warn]
 *        [--no-snapshot] [--phantom-min-refs 3] [--stale-days 90]
 *
 * Exit code is 0 unless --fail-on is given and a finding of that severity (or worse) exists,
 * so a CI job can gate on errors while still publishing the full report.
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { reloadVault, getDocuments, findImplicitLinks } from '../state.js'
import { getConfig } from '../config.js'
import { runLint, reportToMarkdown, ALL_RULES, type LintRuleId, type LintSeverity } from '../lint/index.js'
import { readSnapshot, writeSnapshot } from '../lint/snapshot.js'
import { SEVERITY_ORDER } from '../lint/types.js'

interface CliArgs {
  vault?: string
  format: 'json' | 'md'
  out?: string
  rules?: LintRuleId[]
  minSeverity?: LintSeverity
  failOn?: LintSeverity
  snapshot: boolean
  phantomMinRefs?: number
  staleDays?: number
  help: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { format: 'json', snapshot: true, help: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v }
    switch (a) {
      case '--vault': args.vault = next(); break
      case '--format': { const f = next(); if (f !== 'json' && f !== 'md') throw new Error('--format must be json or md'); args.format = f; break }
      case '--out': args.out = next(); break
      case '--rules': {
        const list = next().split(',').map(s => s.trim()).filter(Boolean)
        const bad = list.filter(r => !(ALL_RULES as readonly string[]).includes(r))
        if (bad.length) throw new Error(`unknown rule(s): ${bad.join(', ')} (known: ${ALL_RULES.join(', ')})`)
        args.rules = list as LintRuleId[]; break
      }
      case '--min-severity': args.minSeverity = severity(next()); break
      case '--fail-on': args.failOn = severity(next()); break
      case '--no-snapshot': args.snapshot = false; break
      case '--phantom-min-refs': args.phantomMinRefs = Number(next()); break
      case '--stale-days': args.staleDays = Number(next()); break
      case '-h': case '--help': args.help = true; break
      default: throw new Error(`unknown argument: ${a}`)
    }
  }
  return args
}

function severity(v: string): LintSeverity {
  if (v === 'error' || v === 'warn' || v === 'info') return v
  throw new Error(`severity must be error, warn or info (got ${v})`)
}

const USAGE = `Usage: lint --vault <path> [--format json|md] [--out <file>] [--rules a,b] [--min-severity warn]
             [--fail-on error|warn] [--no-snapshot] [--phantom-min-refs N] [--stale-days N]`

async function main(): Promise<number> {
  let args: CliArgs
  try { args = parseArgs(process.argv.slice(2)) } catch (e) { console.error((e as Error).message); console.error(USAGE); return 2 }
  if (args.help) { console.log(USAGE); return 0 }

  const vaultPath = resolve(args.vault ?? getConfig().vaultPath)
  if (!vaultPath) { console.error('no vault: pass --vault or set vaultPath in mcp-config.json'); return 2 }

  const stats = await reloadVault(vaultPath)
  const docs = getDocuments()
  if (docs.length === 0) { console.error(`no markdown documents found under ${vaultPath}`); return 2 }
  console.error(`[lint] ${stats.docCount} documents, ${stats.linkCount} links`)

  const wantsDuplicates = !args.rules || args.rules.includes('near-duplicate')
  const similarPairs = wantsDuplicates ? findImplicitLinks(0.5, 2000) : undefined

  const report = runLint(
    { docs, similarPairs, previousSnapshot: readSnapshot(vaultPath) },
    { rules: args.rules, minSeverity: args.minSeverity, phantomMinRefs: args.phantomMinRefs, staleDays: args.staleDays },
  )
  if (args.snapshot) writeSnapshot(vaultPath, report.snapshot)

  const { snapshot: _snapshot, ...printable } = report
  const text = args.format === 'md' ? reportToMarkdown(report) : JSON.stringify(printable, null, 2)
  if (args.out) { writeFileSync(args.out, text, 'utf-8'); console.error(`[lint] wrote ${args.out}`) }
  else console.log(text)

  const { error, warn, info } = report.summary.bySeverity
  console.error(`[lint] ${error} errors, ${warn} warnings, ${info} notes`)

  if (args.failOn && report.findings.some(f => SEVERITY_ORDER[f.severity] <= SEVERITY_ORDER[args.failOn!])) return 1
  return 0
}

main().then(code => process.exit(code), e => { console.error(e); process.exit(2) })
