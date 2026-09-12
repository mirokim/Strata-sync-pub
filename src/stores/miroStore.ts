/**
 * miroStore.ts — MiroFish 시뮬레이터 상태 관리
 *
 * config: persist (IndexedDB)
 * simState: 런타임 전용 (재시작 시 초기화)
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { generatePersonas } from '@/services/mirofish/personaGenerator'
import { runSimulation } from '@/services/mirofish/simulationEngine'
import { generateReport } from '@/services/mirofish/reportGenerator'
import {
  DEFAULT_CONFIG,
  DEFAULT_PERSONAS,
  type MirofishSimulationConfig,
  type MirofishSimulationState,
  type MirofishPersona,
  type MirofishPost,
  type MirofishPersonaPreset,
  type MirofishScheduledTopic,
  type MirofishHistoryEntry,
} from '@/services/mirofish/types'

// ── 초기 상태 ─────────────────────────────────────────────────────────────────

const INITIAL_SIM_STATE: MirofishSimulationState = {
  status: 'idle',
  currentRound: 0,
  totalRounds: 0,
  feed: [],
  streamingPost: null,
  report: '',
}

// ── Store 타입 ────────────────────────────────────────────────────────────────

interface MiroState {
  config: MirofishSimulationConfig
  simState: MirofishSimulationState
  _abortController: AbortController | null
  presets: MirofishPersonaPreset[]
  scheduledTopics: MirofishScheduledTopic[]
  /** 완료된 시뮬레이션 이력 (최근 20개 유지) */
  simulationHistory: MirofishHistoryEntry[]

  // config 액션
  setConfig: (partial: Partial<MirofishSimulationConfig>) => void
  setPersonas: (personas: MirofishPersona[]) => void
  addPersona: () => void
  removePersona: (id: string) => void
  updatePersona: (id: string, partial: Partial<MirofishPersona>) => void

  // 프리셋 액션
  savePreset: (name: string) => void
  loadPreset: (id: string) => void
  deletePreset: (id: string) => void

  // 스케줄 액션
  addScheduledTopic: (topic: Omit<MirofishScheduledTopic, 'id'>) => void
  updateScheduledTopic: (id: string, partial: Partial<MirofishScheduledTopic>) => void
  deleteScheduledTopic: (id: string) => void

  // 히스토리 액션
  deleteHistoryEntry: (id: string) => void
  clearHistory: () => void

  // 시뮬레이션 액션
  startSimulation: () => Promise<void>
  stopSimulation: () => void
  resetSimulation: () => void
}

// ── Store ─────────────────────────────────────────────────────────────────────

export const useMiroStore = create<MiroState>()(
  persist(
    (set, get) => ({
      config:   DEFAULT_CONFIG,
      simState: INITIAL_SIM_STATE,
      _abortController: null,
      presets: [],
      scheduledTopics: [],
      simulationHistory: [],

      // ── config 액션 ────────────────────────────────────────────────────────

      setConfig: (partial) =>
        set(s => ({ config: { ...s.config, ...partial } })),

      setPersonas: (personas) =>
        set(s => ({ config: { ...s.config, personas } })),

      addPersona: () => {
        const id = `persona_${Date.now()}`
        const newPersona: MirofishPersona = {
          id,
          name: '새 페르소나',
          role: 'new role',
          stance: 'neutral',
          activityLevel: 0.7,
          influenceWeight: 0.5,
          systemPrompt: '당신의 관점과 말투를 여기에 작성하세요.',
        }
        set(s => ({ config: { ...s.config, personas: s.config.personas.length < 50 ? [...s.config.personas, newPersona] : s.config.personas } }))
      },

      removePersona: (id) =>
        set(s => ({
          config: { ...s.config, personas: s.config.personas.filter(p => p.id !== id) },
        })),

      updatePersona: (id, partial) =>
        set(s => ({
          config: {
            ...s.config,
            personas: s.config.personas.map(p => p.id === id ? { ...p, ...partial } : p),
          },
        })),

      // ── 프리셋 액션 ────────────────────────────────────────────────────
      savePreset: (name) =>
        set(s => ({
          presets: [
            ...s.presets,
            { id: `preset_${Date.now()}`, name, personas: s.config.personas.slice(0, s.config.numPersonas) },
          ],
        })),

      loadPreset: (id) =>
        set(s => {
          const preset = s.presets.find(p => p.id === id)
          if (!preset) return s
          return { config: { ...s.config, personas: preset.personas, numPersonas: preset.personas.length, autoGeneratePersonas: false } }
        }),

      deletePreset: (id) =>
        set(s => ({ presets: s.presets.filter(p => p.id !== id) })),

      // ── 스케줄 액션 ────────────────────────────────────────────────────
      addScheduledTopic: (topic) =>
        set(s => ({
          scheduledTopics: [...s.scheduledTopics, { ...topic, id: `sched_${Date.now()}` }],
        })),

      updateScheduledTopic: (id, partial) =>
        set(s => ({
          scheduledTopics: s.scheduledTopics.map(t => t.id === id ? { ...t, ...partial } : t),
        })),

      deleteScheduledTopic: (id) =>
        set(s => ({ scheduledTopics: s.scheduledTopics.filter(t => t.id !== id) })),

      // ── 히스토리 액션 ──────────────────────────────────────────────────
      deleteHistoryEntry: (id) =>
        set(s => ({ simulationHistory: s.simulationHistory.filter(h => h.id !== id) })),

      clearHistory: () => set({ simulationHistory: [] }),

      // ── 시뮬레이션 액션 ───────────────────────────────────────────────────

      startSimulation: async () => {
        const { config } = get()
        if (!config.topic.trim()) return

        const abort = new AbortController()
        set({ _abortController: abort, simState: { ...INITIAL_SIM_STATE, totalRounds: config.numRounds } })

        try {
          // 1. 페르소나 자동 생성
          let personas = config.personas
          if (config.autoGeneratePersonas) {
            set(s => ({ simState: { ...s.simState, status: 'generating-personas' } }))
            personas = await generatePersonas(config.topic, config.numPersonas, config.modelId, config.context)
            if (abort.signal.aborted) return
            set(s => ({ config: { ...s.config, personas } }))
          }

          // 2. 시뮬레이션 실행
          set(s => ({ simState: { ...s.simState, status: 'running' } }))

          const feed: MirofishPost[] = []

          await runSimulation(
            { ...config, personas },
            (event) => {
              if (abort.signal.aborted) return

              if (event.type === 'post-start') {
                set(s => ({
                  simState: {
                    ...s.simState,
                    streamingPost: { personaId: event.personaId!, content: '' },
                  },
                }))
              } else if (event.type === 'post-chunk') {
                set(s => {
                  const sp = s.simState.streamingPost
                  if (!sp || sp.personaId !== event.personaId) return s
                  return {
                    simState: {
                      ...s.simState,
                      streamingPost: { ...sp, content: sp.content + (event.chunk ?? '') },
                    },
                  }
                })
              } else if (event.type === 'post-done' && event.post) {
                feed.push(event.post)
                set(s => ({
                  simState: {
                    ...s.simState,
                    streamingPost: null,
                    feed: [...feed],
                  },
                }))
              } else if (event.type === 'round-done') {
                set(s => ({
                  simState: { ...s.simState, currentRound: event.round! },
                }))
              }
            },
            abort.signal,
          )

          if (abort.signal.aborted) return

          // 3. 보고서 생성
          set(s => ({ simState: { ...s.simState, status: 'generating-report', streamingPost: null } }))
          let report = ''
          try {
            report = await generateReport(config.topic, feed, config.modelId)
          } catch (reportErr) {
            console.error('[miroStore] 보고서 생성 오류:', reportErr)
            report = `## 보고서 생성 실패\n\n오류: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`
          }

          if (abort.signal.aborted) return

          const historyEntry: MirofishHistoryEntry = {
            id: `hist_${Date.now()}`,
            topic: config.topic,
            numPersonas: config.numPersonas,
            numRounds: config.numRounds,
            feed: [...feed],
            report,
            createdAt: Date.now(),
          }
          set(s => ({
            simState: { ...s.simState, status: 'done', report, feed: [...feed] },
            simulationHistory: [historyEntry, ...s.simulationHistory].slice(0, 20),
          }))
        } catch (err) {
          if (!abort.signal.aborted) {
            set(s => ({
              simState: {
                ...s.simState,
                status: 'error',
                errorMessage: err instanceof Error ? err.message : '알 수 없는 오류',
              },
            }))
          }
        } finally {
          set({ _abortController: null })
        }
      },

      stopSimulation: () => {
        get()._abortController?.abort()
        set(s => ({
          _abortController: null,
          simState: { ...s.simState, status: 'idle', streamingPost: null },
        }))
      },

      resetSimulation: () =>
        set({ simState: INITIAL_SIM_STATE }),
    }),
    {
      name: 'sandbox-miro',
      partialize: (s) => ({
        config: s.config,
        presets: s.presets,
        scheduledTopics: s.scheduledTopics,
        simulationHistory: s.simulationHistory,
      }),
      merge: (persisted: unknown, current) => {
        const p = persisted as Partial<MiroState>
        return {
          ...current,
          config: {
            ...DEFAULT_CONFIG,
            ...(p.config ?? {}),
            personas: p.config?.personas?.length ? p.config.personas : DEFAULT_PERSONAS,
          },
          presets: p.presets ?? [],
          scheduledTopics: p.scheduledTopics ?? [],
          simulationHistory: p.simulationHistory ?? [],
        }
      },
    },
  ),
)
