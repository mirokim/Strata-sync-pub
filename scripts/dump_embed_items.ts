/**
 * dump_embed_items.ts — 앱과 100% 동일한 청킹/ID 체계로 임베딩 대상을 추출
 *
 * 앱의 parseVaultFiles(markdownParser)를 그대로 호출하므로 sectionId/docId가 일치합니다.
 * vectorEmbedIndex.ts 의 private 함수(sectionText/docText/extractEmbedItems)와
 * 상수(SECTION_EMBED_THRESHOLD/EMBED_TEXT_MAX_CHARS)는 동일 로직으로 복제했습니다
 * — 원본 변경 시 이 파일도 반드시 함께 갱신해야 합니다.
 *
 * 실행: npx vite-node scripts/dump_embed_items.ts -- <vaultPath> <out.jsonl>
 */
import fs from 'node:fs'
import path from 'node:path'
import { parseVaultFiles } from '@/lib/markdownParser'
import type { VaultFile, LoadedDocument, DocSection } from '@/types'

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp)$/i
// ↓ vectorEmbedIndex.ts 와 동일하게 유지할 것
const SECTION_EMBED_THRESHOLD = 1
const EMBED_TEXT_MAX_CHARS = 4500

// ── 볼트 열거 (electron/main.cjs collectVaultContents 와 동일 규칙) ─────────────
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
    if (e.name.startsWith('.')) continue // hidden 제외 (.archive, .obsidian ...)
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

// ── vectorEmbedIndex.ts 복제 ──────────────────────────────────────────────────
// 보일러플레이트 접두사(docTypePrefix)는 제거됐다 — 볼트의 45%가 같은 문자열로
// 시작해 문서 단위 max-pooling 시 섹션 변별이 되지 않았다. tags/speaker 도
// 검색 필터·부스트에서 이미 쓰므로 임베딩 텍스트에서 뺐다.
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
console.log(`[dump] .md 파일 ${absFiles.length}개 발견`)

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
console.log(`[dump] 문서 파싱 ${docs.length}개`)

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
console.log(`[dump] 임베딩 항목 ${nSection + nDoc}개 (섹션 단위 ${nSection} / 문서 단위 ${nDoc})`)
console.log(`[dump] 저장: ${outPath}`)
