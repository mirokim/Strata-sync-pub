/**
 * Direct filesystem vault access — replaces window.vaultAPI for MCP server.
 */
import { readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, promises as fsp } from 'fs'
import { join, relative, basename, dirname, extname } from 'path'
import { getConfig } from './config.js'
import type { LoadedDocument } from './parser.js'

export interface VaultFileInfo {
  relativePath: string
  absolutePath: string
  mtime: number
}

/** Recursively list all files in vaultPath */
export function listFiles(vaultPath?: string, folder?: string): { files: VaultFileInfo[]; folders: string[] } {
  const root = vaultPath ?? getConfig().vaultPath
  if (!root || !existsSync(root)) return { files: [], folders: [] }

  const target = folder ? join(root, folder) : root
  const files: VaultFileInfo[] = []
  const folders: string[] = []

  function walk(dir: string) {
    let entries: ReturnType<typeof readdirSync>
    // Use withFileTypes to detect directories — avoids calling statSync per entry
    try { entries = readdirSync(dir, { withFileTypes: true }) as unknown as ReturnType<typeof readdirSync> } catch { return }
    for (const e of entries as unknown as { name: string; isDirectory(): boolean }[]) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        folders.push(relative(root, abs).replace(/\\/g, '/'))
        walk(abs)
      } else {
        let mtime = 0
        try { mtime = statSync(abs).mtimeMs } catch { continue }
        files.push({
          relativePath: relative(root, abs).replace(/\\/g, '/'),
          absolutePath: abs,
          mtime,
        })
      }
    }
  }

  walk(target)
  return { files, folders }
}

/** Async recursive traversal — reads directories in parallel and skips stat (mtime is obtained when reading) */
async function walkAsync(
  root: string, dir: string,
  files: { relativePath: string; absolutePath: string }[],
  folders: string[],
  depth = 0,
): Promise<void> {
  let entries: { name: string; isDirectory(): boolean }[]
  try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }

  const subdirs: string[] = []
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) {
      folders.push(relative(root, abs).replace(/\\/g, '/'))
      subdirs.push(abs)
    } else {
      files.push({ relativePath: relative(root, abs).replace(/\\/g, '/'), absolutePath: abs })
    }
  }

  const DIR_CONCURRENCY = 8
  for (let i = 0; i < subdirs.length; i += DIR_CONCURRENCY) {
    await Promise.all(subdirs.slice(i, i + DIR_CONCURRENCY).map(d => walkAsync(root, d, files, folders, depth + 1)))
  }
}

export function readFile(filePath: string): string | null {
  try { return readFileSync(filePath, 'utf-8') } catch { return null }
}

export function saveFile(filePath: string, content: string): { success: boolean; path: string } {
  try {
    const dir = dirname(filePath)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, content, 'utf-8')
    return { success: true, path: filePath }
  } catch { return { success: false, path: filePath } }
}

export function deleteFile(filePath: string): { success: boolean } {
  try { unlinkSync(filePath); return { success: true } } catch { return { success: false } }
}

export function renameFile(absPath: string, newName: string): { success: boolean; newPath: string } {
  try {
    const dir = dirname(absPath)
    const newPath = join(dir, newName)
    renameSync(absPath, newPath)
    return { success: true, newPath }
  } catch { return { success: false, newPath: '' } }
}

export function createFolder(folderPath: string): { success: boolean; path: string } {
  try {
    mkdirSync(folderPath, { recursive: true })
    return { success: true, path: folderPath }
  } catch { return { success: false, path: folderPath } }
}

export function moveFile(absPath: string, destFolder: string): { success: boolean; newPath: string } {
  try {
    if (!existsSync(destFolder)) mkdirSync(destFolder, { recursive: true })
    const newPath = join(destFolder, basename(absPath))
    copyFileSync(absPath, newPath)
    unlinkSync(absPath)
    return { success: true, newPath }
  } catch { return { success: false, newPath: '' } }
}

/**
 * Load and parse all .md files into LoadedDocument[].
 * Batched parallel async I/O + per-file try/catch — a single document with broken frontmatter
 * must not fail the whole vault load (gray-matter throws on `title: "a"b"`).
 */
export async function loadVaultDocuments(vaultPath?: string): Promise<LoadedDocument[]> {
  const root = vaultPath ?? getConfig().vaultPath
  if (!root || !existsSync(root)) return []

  const files: { relativePath: string; absolutePath: string }[] = []
  const folders: string[] = []
  await walkAsync(root, root, files, folders)

  // Parallel traversal makes the order non-deterministic — sort to stabilize document order (= fingerprint)
  const mdFiles = files
    .filter(f => extname(f.relativePath).toLowerCase() === '.md')
    .sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0))

  const { parseVaultFile } = await import('./parser.js')

  const docs: LoadedDocument[] = []
  let readFailed = 0
  const parseFailed: string[] = []
  const BATCH = 64

  for (let i = 0; i < mdFiles.length; i += BATCH) {
    const batch = mdFiles.slice(i, i + BATCH)
    const loaded = await Promise.all(batch.map(async f => {
      try {
        const [content, st] = await Promise.all([
          fsp.readFile(f.absolutePath, 'utf-8'),
          fsp.stat(f.absolutePath),
        ])
        return { f, content, mtime: st.mtimeMs }
      } catch {
        return null
      }
    }))

    for (const item of loaded) {
      if (!item) { readFailed++; continue }
      try {
        const doc = parseVaultFile({
          relativePath: item.f.relativePath,
          absolutePath: item.f.absolutePath,
          content: item.content,
          mtime: item.mtime,
        })
        if (doc) docs.push(doc)
      } catch (e) {
        parseFailed.push(item.f.relativePath)
        console.error(`[vault] Parse failed (skipped): ${item.f.relativePath} — ${e instanceof Error ? e.message : e}`)
      }
    }
  }

  if (readFailed > 0 || parseFailed.length > 0) {
    console.error(`[vault] ${readFailed} of ${mdFiles.length} failed to read, ${parseFailed.length} failed to parse — the rest loaded normally`)
  }
  return docs
}
