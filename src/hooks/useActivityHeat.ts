/**
 * useActivityHeat — 0..1 attention score per document for the graph's "Activity" colour mode.
 * Recomputed when the loaded documents change; empty (all cold) in any other colour mode so the
 * scan is not paid for nothing.
 */
import { useMemo } from 'react'
import { useVaultStore } from '@/stores/vaultStore'
import { useUIStore } from '@/stores/uiStore'
import { activityHeat } from '@/lib/brain'

const NONE = new Map<string, number>()

export function useActivityHeat(): Map<string, number> {
  const loadedDocuments = useVaultStore(s => s.loadedDocuments)
  const active = useUIStore(s => s.nodeColorMode === 'heat')
  return useMemo(() => (active && loadedDocuments ? activityHeat(loadedDocuments) : NONE), [active, loadedDocuments])
}
