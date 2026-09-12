/**
 * dump_embed_items.ts — extract embedding targets using exactly the same chunking/ID scheme as the app
 *
 * Calls the app's parseVaultFiles (markdownParser) directly, so sectionId/docId match.
 * The private functions of vectorEmbedIndex.ts (sectionText/docText/extractEmbedItems) and
 * constants (SECTION_EMBED_THRESHOLD/EMBED_TEXT_MAX_CHARS) are replicated here with identical logic
 * — whenever the original changes, this file must be updated as well.
 *
 * Run: npx vite-node scripts/dump_embed_items.ts -- <vaultPath> <out.jsonl>
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseVaultFiles } from '@/lib/markdownParser'
import type { VaultFile, LoadedDocument, DocSection } from '@/types'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i
// ↓ keep identical to vectorEmbedIndex.ts
const SECTION_EMBED_THRESHOLD = 1
const EMBED_TEXT_MAX_CHARS = 4500

// ── Vault enumeration (same rules as electron/main.cjs collectVaultContents) ────
function collect(vaultPath: string, dir: string, depth = 0): string[] {
  if (depth > 10) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue // skip hidden (.archive, .obsidian ...)
    const full = path.join(dir, e.name)
    if (e.name.toLowerCase().endsWith('.md')) {
      files.push(full)
      continue
    }
    if (IMAGE_RE.test(e.name)) continue
    let isDir = false
    try { isDir = e.isDirectory() } catch { /* noop */ }
    if (!isDir && /\.\w{1,10}$/.test(e.name)) continue
    if (isDir) files.push(...collect(vaultPath, full, depth + 1))
  }
  return files
}

// ── Replicated from vectorEmbedIndex.ts ───────────────────────────────────────
// The boilerplate prefix (docTypePrefix) was removed — 45% of the vault started with the same
// string, so sections were indistinguishable under per-document max-pooling. tags/speaker were
// also dropped from the embedding text since they are already used in search filters/boosts.
function sectionText(section: DocSection, doc: LoadedDocument): string {
  const title = doc.filename.replace(/\.md$/i, '')
  return `${title}\n${section.heading}\n${section.body}`.slice(0, EMBED_TEXT_MAX_CHARS)
}

function docText(doc: LoadedDocument): string {
  const title = doc.filename.replace(/\.md$/i, '')
  const body = doc.sections.map(s => `${s.heading}\n${s.body}`).join('\n\n')
  return `${title}\n${body}`.slice(0, EMBED_TEXT_MAX_CHARS)
}

// ── main ──────────────────────────────────────────────────────────────────────
const vaultPath = process.argv[2]
const outPath = process.argv[3]
if (!vaultPath || !outPath) {
  console.error('usage: vite-node scripts/dump_embed_items.ts -- <vaultPath> <out.jsonl>')
  process.exit(1)
}

const absFiles = collect(vaultPath, vaultPath)
console.log(`[dump] Found ${absFiles.length} .md files`)

const vaultFiles: VaultFile[] = absFiles.map(abs => {
  const stat = fs.statSync(abs)
  return {
    relativePath: path.relative(vaultPath, abs).replace(/\\/g, '/'),
    absolutePath: abs,
    content: fs.readFileSync(abs, 'utf-8'),
    mtime: stat.mtimeMs,
  }
})

const docs = parseVaultFiles(vaultFiles)
console.log(`[dump] Parsed ${docs.length} documents`)

const out = fs.createWriteStream(outPath, { encoding: 'utf-8' })
let nSection = 0, nDoc = 0
const mtimes: Record<string, number> = {}

for (const doc of docs) {
  mtimes[doc.id] = doc.mtime ?? 0
  if (doc.sections.length > SECTION_EMBED_THRESHOLD) {
    for (const sec of doc.sections) {
      out.write(JSON.stringify({ id: sec.id, docId: doc.id, mtime: doc.mtime ?? 0, text: sectionText(sec, doc) }) + '\n')
      nSection++
    }
  } else {
    out.write(JSON.stringify({ id: doc.id, docId: doc.id, mtime: doc.mtime ?? 0, text: docText(doc) }) + '\n')
    nDoc++
  }
}
out.end()

fs.writeFileSync(outPath.replace(/\.jsonl$/, '_mtimes.json'), JSON.stringify(mtimes), 'utf-8')
console.log(`[dump] ${nSection + nDoc} embedding items (${nSection} section-level / ${nDoc} document-level)`)
console.log(`[dump] Saved: ${outPath}`)
