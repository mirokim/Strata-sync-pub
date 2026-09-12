/**
 * stringUtils.ts — Shared string utilities
 */

/**
 * Removes lone Unicode surrogates that make JSON.stringify fail.
 * Valid surrogate pairs (emoji, etc.) are preserved as-is.
 */
export function sanitize(str: string | null | undefined): string {
  if (str == null) return '';
  return str.replace(
    /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,
    m => m.length === 2 ? m : ''
  )
}

/**
 * Strips meta-instruction phrases from a search query.
 * Prevents BM25/TF-IDF from being polluted by vault-common words like "보고서" (report), "분석" (analysis), "방향" (direction).
 * Same logic as _clean_search_query in bot.py.
 */
export function cleanSearchQuery(query: string): string {
  let q = query.trim()
  // 1. Compound meta-verbs: "분석해줘" (analyze), "정리해줘" (organize), "제안해줘" (suggest), etc.
  q = q.replace(/\s*(분석|정리|요약|검토|설명|비교|제안|작성|소개|추천|추출|뽑아)(해줘|해주세요|해봐줘|해봐|줘|주세요|해)\s*$/i, '')
  // 2. Meta-noun + action verb: "보고서 써줘" (write a report), "리포트 만들어줘" (make a report)
  q = q.replace(/\s*(보고서|리포트|report)\s*\S*(써|만들|작성)[가-힣\s]*$/i, '')
  // 3. Pure request endings: "알려줘" (tell me), "찾아줘" (find), "해줘" (do), "줘" (give), etc.
  q = q.replace(/\s*(알려줘|알려주세요|찾아줘|찾아주세요|말해줘|말해주세요|해줘|해주세요|줘|주세요|부탁해|부탁합니다)\s*$/i, '')
  return q.trim() || query.trim()
}
