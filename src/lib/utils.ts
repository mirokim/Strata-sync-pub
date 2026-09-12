import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateId(): string {
  return crypto.randomUUID()
}

/** Slugify a heading string for wiki-link matching */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_가-힣]/g, '')
}

/** Truncate a string to a max length with ellipsis */
export function truncate(text: string, max = 40): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

/** Extract [[slug]] references from a markdown string.
 *  ![[embed]] 형식의 이미지 임베드는 제외합니다. */
export function extractWikiLinks(text: string): string[] {
  // negative lookbehind: '!' 바로 앞에 오는 [[...]] 는 이미지 임베드이므로 제외
  const matches = text.match(/(?<!!)\[\[(.*?)\]\]/gs) ?? []
  return matches.map(m => m.slice(2, -2).trim())
}

/** Extract ![[image.png]] image embed references from a markdown string. */
export function extractImageRefs(text: string): string[] {
  const matches = text.match(/!\[\[([^\]]+)\]\]/g) ?? []
  return [...new Set(matches.map(m => m.slice(3, -2).trim()))]
}

/**
 * Normalize a file path: backslashes → forward slashes.
 * Optionally strips leading slashes when `stripLeading` is true.
 */
export function normalizePath(p: string, stripLeading = false): string {
  let result = p.replace(/\\/g, '/')
  // Windows 드라이브 문자 소문자 정규화 (C:/ → c:/)
  if (/^[A-Z]:\//.test(result)) {
    result = result[0].toLowerCase() + result.slice(1)
  }
  if (stripLeading) result = result.replace(/^\/+/, '')
  return result
}

/**
 * Wrap an async file operation with error handling.
 * Returns the result on success, or `null` on failure (logging the error).
 */
export async function safeFileOp<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (e) {
    console.error(`[FileOp] ${label} 실패:`, e)
    // 동적 import로 순환 의존성 방지
    try {
      const { showToast } = await import('@/stores/toastStore')
      showToast(`${label} 실패: ${e instanceof Error ? e.message : String(e)}`, 'error')
    } catch { /* toast 실패는 무시 */ }
    return null
  }
}
