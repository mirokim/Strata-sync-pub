/**
 * WebRoot — entry for the browser build. Until a server is configured it shows ConnectScreen;
 * afterwards it installs the remote vault adapter (window.vaultAPI / window.syncAPI), points the
 * vault store at the remote vault and renders the normal App, which from then on cannot tell
 * whether it runs in Electron or in a browser.
 *
 * Boot order: finish a Google sign-in if the URL carries the callback → otherwise reuse the saved
 * session (refreshing the access token) or the saved team-token config → otherwise ConnectScreen.
 */
import { useEffect, useMemo, useState } from 'react'
import App from '@/App'
import ConnectScreen from './ConnectScreen'
import { loadWebConfig, remoteVaultPath, saveWebConfig, type WebConfig } from './config'
import { installRemoteVault } from './remoteVault'
import { RemoteClient } from './remoteClient'
import { completeSignIn, freshAccessToken, refreshInto } from './auth'
import { useVaultStore } from '@/stores/vaultStore'
import { useUIStore } from '@/stores/uiStore'
import { showToast } from '@/stores/toastStore'

/** Make the remote vault the one and only vault in the store (persisted local paths are useless here). */
export function bindVaultStore(config: WebConfig): void {
  const path = remoteVaultPath(config.url)
  const store = useVaultStore.getState()
  if (store.vaultPath === path && Object.values(store.vaults).every(v => v.path === path)) return
  useVaultStore.setState({ vaults: {}, activeVaultId: '', vaultPath: null, loadedDocuments: null, vaultFolders: [], imagePathRegistry: null })
  useVaultStore.getState().setVaultPath(path)
}

/**
 * Resolve the config to boot with: the OAuth callback, a saved session, or a saved token config.
 * Returns `{ error }` when a sign-in attempt failed so the connect screen can say why.
 */
export async function resolveBootConfig(): Promise<{ config: WebConfig | null; error?: string }> {
  try {
    const session = await completeSignIn()
    if (session) {
      const config: WebConfig = { url: session.server, token: session.accessToken, author: '', auth: 'oauth' }
      try {
        const me = await new RemoteClient(config).me()
        config.author = me.author; config.email = me.email
      } catch { /* the author is refreshed on the next boot */ }
      saveWebConfig(config)
      return { config }
    }
  } catch (e) {
    return { config: null, error: e instanceof Error ? e.message : String(e) }
  }
  const saved = loadWebConfig()
  if (!saved) return { config: null }
  if (saved.auth === 'oauth') {
    const token = await freshAccessToken(saved.url)
    if (!token) return { config: null, error: 'Your session expired — sign in again.' }
    return { config: { ...saved, token } }
  }
  return { config: saved }
}

function ConnectedApp({ config }: { config: WebConfig }) {
  // Synchronous, before App's effects run: App auto-loads `vaultPath` through window.vaultAPI
  useMemo(() => {
    installRemoteVault(config, {
      notify: (message, kind) => showToast(message, kind, kind === 'info' ? 3000 : 6000),
      onUnauthorized: config.auth === 'oauth' ? () => refreshInto(config) : undefined,
    })
    bindVaultStore(config)
  }, [config])
  return <App />
}

export default function WebRoot() {
  const [state, setState] = useState<{ ready: boolean; config: WebConfig | null; error?: string }>({ ready: false, config: null })
  const theme = useUIStore(s => s.theme)

  // App applies the theme itself once mounted; the connect screen needs it earlier
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])

  useEffect(() => {
    let cancelled = false
    resolveBootConfig().then(r => { if (!cancelled) setState({ ready: true, ...r }) })
    return () => { cancelled = true }
  }, [])

  if (!state.ready) return <div style={{ minHeight: '100vh', background: 'var(--color-bg-primary)' }} />
  if (!state.config) return <ConnectScreen initialError={state.error} onConnected={config => setState({ ready: true, config })} />
  return <ConnectedApp config={state.config} />
}
