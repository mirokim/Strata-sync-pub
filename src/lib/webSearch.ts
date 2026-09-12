/**
 * webSearch.ts — DuckDuckGo HTML 검색 (Electron IPC 경유)
 *
 * API 키 불필요. 검색은 main 프로세스에서 Node.js https 모듈로 실행.
 * 비 Electron 환경(브라우저 빌드)에서는 자동으로 [] 반환.
 */

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

const decodeHtml = (s: string) =>
  s.replace(/<[^>]+>/g, '')
   .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
   .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
   .trim()

/** DuckDuckGo HTML 응답을 파싱하여 검색 결과 배열 반환.
 * result 블록 단위로 파싱하여 title/snippet 인덱스 불일치 방지. */
function parseDDGHtml(html: string, maxResults: number): WebSearchResult[] {
  if (!html) return []
  const results: WebSearchResult[] = []

  // 각 result 블록을 추출한 뒤 블록 안에서 title + snippet을 함께 찾음
  const blockRe = /<div[^>]+class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g
  const titleUrlRe = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/
  const snippetRe  = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/

  let block: RegExpExecArray | null
  while ((block = blockRe.exec(html)) !== null && results.length < maxResults) {
    const content = block[1]
    const tm = content.match(titleUrlRe)
    if (!tm) continue
    let url = tm[1]
    const title = decodeHtml(tm[2])
    if (!title) continue

    const sm = content.match(snippetRe)
    const snippet = sm ? decodeHtml(sm[1]) : ''

    // DuckDuckGo redirect URL 정리
    if (url.includes('duckduckgo.com/l/?')) {
      const uddg = url.match(/uddg=([^&]+)/)
      if (uddg) url = decodeURIComponent(uddg[1])
    }

    results.push({ title, url, snippet })
  }

  // 블록 파싱 실패 시 (HTML 구조 변경) — 기존 두 배열 방식으로 폴백
  if (results.length === 0) {
    const titleUrlRe2 = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g
    const snippetRe2  = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    const titleUrls: { url: string; rawTitle: string }[] = []
    const snippets: string[] = []
    let m: RegExpExecArray | null
    while ((m = titleUrlRe2.exec(html)) !== null && titleUrls.length < maxResults) titleUrls.push({ url: m[1], rawTitle: m[2] })
    while ((m = snippetRe2.exec(html)) !== null && snippets.length < maxResults) snippets.push(m[1])
    for (let i = 0; i < titleUrls.length && i < maxResults; i++) {
      let { url, rawTitle } = titleUrls[i]
      const title = decodeHtml(rawTitle)
      const snippet = decodeHtml(snippets[i] ?? '')
      if (url.includes('duckduckgo.com/l/?')) { const uddg = url.match(/uddg=([^&]+)/); if (uddg) url = decodeURIComponent(uddg[1]) }
      if (title) results.push({ title, url, snippet })
    }
  }

  return results
}

/** 검색 결과를 RAG 컨텍스트 문자열로 변환 */
export function buildWebContext(results: WebSearchResult[], maxChars = 2000): string {
  if (!results.length) return ''
  const parts = ['## 웹 검색 결과\n']
  let total = parts[0].length
  for (const r of results) {
    const chunk = `- **${r.title}**\n  ${r.snippet}\n  출처: ${r.url}\n\n`
    if (total + chunk.length > maxChars) break
    parts.push(chunk)
    total += chunk.length
  }
  return parts.length <= 1 ? '' : parts.join('')
}

/**
 * DuckDuckGo로 웹 검색합니다.
 * Electron 환경 전용 (window.webSearchAPI IPC 경유).
 * 실패 시 [] 반환.
 */
export async function searchWeb(query: string, maxResults = 5): Promise<WebSearchResult[]> {
  try {
    const api = (window as any).webSearchAPI
    if (!api) return []
    const html: string = await api.search(query)
    return parseDDGHtml(html, maxResults)
  } catch {
    return []
  }
}
