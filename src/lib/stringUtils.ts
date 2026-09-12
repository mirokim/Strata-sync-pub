/**
 * stringUtils.ts — 공유 문자열 유틸리티
 */

/**
 * JSON.stringify가 실패하는 고립 유니코드 서로게이트를 제거합니다.
 * 유효한 서로게이트 쌍(이모지 등)은 그대로 유지합니다.
 */
export function sanitize(str: string | null | undefined): string {
  if (str == null) return '';
  return str.replace(
    /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,
    m => m.length === 2 ? m : ''
  )
}

/**
 * 검색용 쿼리에서 메타 지시 표현을 제거합니다.
 * BM25/TF-IDF가 "보고서", "분석", "방향" 같은 볼트 공통 단어에 오염되지 않도록 보정.
 * bot.py의 _clean_search_query 와 동일한 로직.
 */
export function cleanSearchQuery(query: string): string {
  let q = query.trim()
  // 1. 복합 메타동사: "분석해줘", "정리해줘", "제안해줘" 등
  q = q.replace(/\s*(분석|정리|요약|검토|설명|비교|제안|작성|소개|추천|추출|뽑아)(해줘|해주세요|해봐줘|해봐|줘|주세요|해)\s*$/i, '')
  // 2. 메타명사 + 동작동사: "보고서 써줘", "리포트 만들어줘"
  q = q.replace(/\s*(보고서|리포트|report)\s*\S*(써|만들|작성)[가-힣\s]*$/i, '')
  // 3. 순수 요청 어미: "알려줘", "찾아줘", "해줘", "줘" 등
  q = q.replace(/\s*(알려줘|알려주세요|찾아줘|찾아주세요|말해줘|말해주세요|해줘|해주세요|줘|주세요|부탁해|부탁합니다)\s*$/i, '')
  return q.trim() || query.trim()
}
