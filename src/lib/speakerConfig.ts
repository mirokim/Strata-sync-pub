import type { SpeakerId } from '@/types'

export interface SpeakerMeta {
  label: string
  /** CSS hex color string */
  color: string
  /** Three.js hex number */
  hex: number
  /** Dark background for folder/chip */
  darkBg: string
  /** Short description */
  role: string
}

export const SPEAKER_CONFIG: Record<SpeakerId, SpeakerMeta> = {
  chief_director: {
    label: 'PM',
    color: '#3b82f6',
    hex: 0x3b82f6,
    darkBg: '#0d1f3c',
    role: '게임 프로젝트 매니저 · 일정 · 우선순위 · 리스크 관리',
  },
  art_director: {
    label: 'Art',
    color: '#00bcd4',
    hex: 0x00bcd4,
    darkBg: '#003d45',
    role: '비주얼 퀄리티 · 톤앤매너 · 컬러',
  },
  plan_director: {
    label: 'Design',
    color: '#ff9800',
    hex: 0xff9800,
    darkBg: '#3d2000',
    role: '게임플레이 · 시스템 · 일정 · 우선순위',
  },
  level_director: {
    label: 'Level',
    color: '#4caf50',
    hex: 0x4caf50,
    darkBg: '#0d2e0d',
    role: '레벨 플로우 · 시야 유도 · 기믹 · 레이아웃',
  },
  prog_director: {
    label: 'Tech',
    color: '#2196f3',
    hex: 0x2196f3,
    darkBg: '#0d1f3c',
    role: '최적화 · 퍼포먼스 · 안정성 · 기술 구조',
  },
  unknown: {
    label: '미분류',
    color: '#888888',
    hex: 0x888888,
    darkBg: '#1e1e1e',
    role: '미분류 문서',
  },
}

/** Active persona IDs shown in UI */
export const SPEAKER_IDS = [
  'chief_director',
] as const satisfies SpeakerId[]

/**
 * Compute a dark background chip color from a foreground hex color.
 * Used for both built-in personas (SPEAKER_CONFIG.darkBg) and custom personas.
 */
export function computeDarkBg(hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return '#1a1a2e'
  const r = Math.floor(parseInt(hex.slice(1, 3), 16) * 0.18)
  const g = Math.floor(parseInt(hex.slice(3, 5), 16) * 0.18)
  const b = Math.floor(parseInt(hex.slice(5, 7), 16) * 0.18)
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}
