// ── MiroFish Simulator Types ─────────────────────────────────────────────────
import { WORKER_MODELS } from '@/lib/modelConfig'

export interface MirofishPersona {
  id: string
  name: string
  role: string
  stance: 'supportive' | 'opposing' | 'neutral' | 'observer'
  /** 0.0–1.0: 매 라운드 반응할 확률 */
  activityLevel: number
  /** LLM system prompt — 이 페르소나의 관점과 말투를 정의 */
  systemPrompt: string
  /** 소셜 영향력 (0.1–1.0) — 보고서에 반영 */
  influenceWeight: number
}

export interface MirofishPost {
  round: number
  personaId: string
  personaName: string
  stance: MirofishPersona['stance']
  /** 이전 라운드 대비 입장 변화 여부 */
  stanceShifted?: boolean
  /** 입장 변화 전 stance */
  prevStance?: MirofishPersona['stance']
  content: string
  /** 감정 강도 1-5 (1=미온적, 5=매우 강렬) */
  intensity?: number
  timestamp: number
  // OASIS fields
  postId?: string
  actionType?: 'post' | 'repost' | 'like' | 'follow' | 'do_nothing'
  originalPostId?: string
  likes?: number
  reposts?: number
}

export interface MirofishSimulationConfig {
  topic: string
  numPersonas: number         // 3–50
  numRounds: number           // 2–10
  modelId: string
  autoGeneratePersonas: boolean
  /** Slack 이미지 첨부 시 이미지를 각 페르소나 LLM에 직접 전달 (true) vs 텍스트 설명으로 변환 (false) */
  imageDirectPass: boolean
  personas: MirofishPersona[]
  /** RAG로 검색한 볼트 배경 정보 — 페르소나 프롬프트에 주입 */
  context?: string
  /** 직접 전달 이미지 — 각 페르소나 LLM 호출에 첨부 */
  images?: Array<{ data: string; mediaType: string }>
}

export type SimulationStatus =
  | 'idle'
  | 'generating-personas'
  | 'running'
  | 'generating-report'
  | 'done'
  | 'error'

export interface MirofishSimulationState {
  status: SimulationStatus
  currentRound: number
  totalRounds: number
  feed: MirofishPost[]
  /** 현재 스트리밍 중인 포스트 내용 (personaId → partial content) */
  streamingPost: { personaId: string; content: string } | null
  report: string
  errorMessage?: string
}

export const DEFAULT_PERSONAS: MirofishPersona[] = [
  {
    id: 'skeptic',
    name: '회의론자',
    role: 'critical analyst',
    stance: 'opposing',
    activityLevel: 0.8,
    influenceWeight: 0.7,
    systemPrompt:
      '당신은 신중한 회의론자입니다. 새로운 아이디어나 제품에 대해 비판적으로 검토하고, ' +
      '잠재적 위험이나 단점을 지적합니다. 2-3문장으로 간결하게 의견을 표현하세요.',
  },
  {
    id: 'enthusiast',
    name: '얼리어답터',
    role: 'early adopter',
    stance: 'supportive',
    activityLevel: 0.9,
    influenceWeight: 0.6,
    systemPrompt:
      '당신은 열정적인 얼리어답터입니다. 새로운 기술과 트렌드에 빠르게 반응하고 긍정적으로 ' +
      '평가합니다. 구체적인 사용 시나리오를 언급하며 2-3문장으로 의견을 표현하세요.',
  },
  {
    id: 'pragmatist',
    name: '실용주의자',
    role: 'pragmatic evaluator',
    stance: 'neutral',
    activityLevel: 0.6,
    influenceWeight: 0.8,
    systemPrompt:
      '당신은 실용적인 평가자입니다. 비용 대비 효과, 실제 적용 가능성을 중심으로 ' +
      '균형 잡힌 의견을 제시합니다. 2-3문장으로 간결하게 의견을 표현하세요.',
  },
  {
    id: 'influencer',
    name: '인플루언서',
    role: 'social media influencer',
    stance: 'supportive',
    activityLevel: 0.7,
    influenceWeight: 0.9,
    systemPrompt:
      '당신은 소셜 미디어 인플루언서입니다. 트렌드에 민감하고 팔로워들의 반응을 의식하며 ' +
      '감성적이고 공감적인 방식으로 의견을 표현합니다. 2-3문장으로 의견을 표현하세요.',
  },
  {
    id: 'expert',
    name: '도메인 전문가',
    role: 'domain expert',
    stance: 'neutral',
    activityLevel: 0.5,
    influenceWeight: 1.0,
    systemPrompt:
      '당신은 해당 분야의 전문가입니다. 기술적 정확성과 산업 표준을 기준으로 심층적인 ' +
      '분석을 제공합니다. 전문 용어를 적절히 사용하며 2-3문장으로 의견을 표현하세요.',
  },
]

export interface MirofishPersonaPreset {
  id: string
  name: string
  personas: MirofishPersona[]
}

export interface MirofishScheduledTopic {
  id: string
  topic: string
  numPersonas: number
  numRounds: number
  /** HH:MM 형식 — 매일 이 시각에 자동 실행 */
  time: string
  enabled: boolean
}

export interface MirofishHistoryEntry {
  id: string
  topic: string
  numPersonas: number
  numRounds: number
  feed: MirofishPost[]
  report: string
  createdAt: number  // timestamp ms
}

export const DEFAULT_CONFIG: MirofishSimulationConfig = {
  topic: '',
  numPersonas: 5,
  numRounds: 5,
  modelId: WORKER_MODELS.anthropic,
  autoGeneratePersonas: true,
  imageDirectPass: true,
  personas: DEFAULT_PERSONAS,
}
