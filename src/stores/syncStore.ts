import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SyncNotification {
  message: string
  count: number
  at: string
}

interface SyncStore {
  lastSyncAt: string | null           // Confluence 마지막 동기화 타임스탬프
  lastJiraSyncAt: string | null       // Jira 마지막 동기화 타임스탬프
  notification: SyncNotification | null
  setLastSyncAt: (at: string) => void
  setLastJiraSyncAt: (at: string) => void
  setNotification: (n: SyncNotification | null) => void
  dismissNotification: () => void
}

export const useSyncStore = create<SyncStore>()(
  persist(
    (set) => ({
      lastSyncAt: null,
      lastJiraSyncAt: null,
      notification: null,
      setLastSyncAt: (lastSyncAt) => set({ lastSyncAt }),
      setLastJiraSyncAt: (lastJiraSyncAt) => set({ lastJiraSyncAt }),
      setNotification: (notification) => set({ notification }),
      dismissNotification: () => set({ notification: null }),
    }),
    {
      name: 'rembrandt-sync',
      partialize: (s) => ({ lastSyncAt: s.lastSyncAt, lastJiraSyncAt: s.lastJiraSyncAt }),
    }
  )
)
