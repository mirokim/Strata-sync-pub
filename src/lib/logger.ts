/**
 * logger.ts — 조건부 로거
 *
 * 개발 환경에서만 debug/warn 로그를 출력합니다.
 * error는 항상 출력합니다 (프로덕션 에러 추적용).
 *
 * 사용법:
 *   import { logger } from '@/lib/logger'
 *   logger.debug('[vault] 로드됨', files.length)
 *   logger.error('[vault] 실패:', err)
 */

const isDev = import.meta.env.DEV

export const logger = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  debug: (...args: any[]) => { if (isDev) console.log(...args) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  warn:  (...args: any[]) => { if (isDev) console.warn(...args) },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  error: (...args: any[]) => { console.error(...args) },
}
