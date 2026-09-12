import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface SyncNotification {
  message: string
  count: number
  at: string
}

interface SyncStore {
  lastSyncAt: string | null           // Confluence last sync timestamp
  lastJiraSyncAt: string | null       // Jira last sync timestamp
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
      name: 'strata-sync-sync',
      partialize: (s) => ({ lastSyncAt: s.lastSyncAt, lastJiraSyncAt: s.lastJiraSyncAt }),
    }
  )
)
