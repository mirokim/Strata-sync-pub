import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface MemoryState {
  memoryText: string
  setMemoryText: (text: string) => void
  appendToMemory: (text: string) => void
  clearMemory: () => void
}

/**
 * AI 장기 기억 스토어.
 * localStorage에 영구 저장되며, 모든 대화 세션에서 시스템 프롬프트에 주입됩니다.
 */
export const useMemoryStore = create<MemoryState>()(
  persist(
    (set) => ({
      memoryText: '',
      setMemoryText: (text) => set({ memoryText: text }),
      appendToMemory: (text) => set(s => {
        const combined = s.memoryText ? s.memoryText + '\n\n' + text : text
        if (combined.length > 10000) {
          // Keep most recent 10,000 chars; trim to a clean line boundary where possible
          const tail = combined.slice(combined.length - 10000)
          const firstNewline = tail.indexOf('\n')
          console.warn('[memoryStore] Memory cap reached — trimming oldest content')
          return { memoryText: firstNewline > 0 ? tail.slice(firstNewline + 1) : tail }
        }
        return { memoryText: combined }
      }),
      clearMemory: () => set({ memoryText: '' }),
    }),
    { name: 'rembrandt-ai-memory' }
  )
)
