import { useVaultStore } from '@/stores/vaultStore'

/**
 * Custom hook that provides vault API access with a ready check.
 *
 * Usage:
 *   const { api, vaultPath, ready } = useVaultAPI()
 *   if (!ready) return
 */
export function useVaultAPI() {
  const vaultPath = useVaultStore(s => s.vaultPath)
  const api = window.vaultAPI
  if (api && vaultPath) {
    return { api, vaultPath, ready: true as const }
  }
  return { api: undefined, vaultPath: null, ready: false as const }
}
