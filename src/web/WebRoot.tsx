/**
 * WebRoot — entry for the browser build. Until a server is configured it shows ConnectScreen;
 * afterwards it installs the remote vault adapter (window.vaultAPI / window.syncAPI), points the
 * vault store at the remote vault and renders the normal App, which from then on cannot tell
 * whether it runs in Electron or in a browser.
 */
import { useEffect, useMemo, useState } from 'react'
import App from '@/App'
import ConnectScreen from './ConnectScreen'
import { loadWebConfig, remoteVaultPath, type WebConfig } from './config'
import { installRemoteVault } from './remoteVault'
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

function ConnectedApp({ config }: { config: WebConfig }) {
  // Synchronous, before App's effects run: App auto-loads `vaultPath` through window.vaultAPI
  useMemo(() => {
    installRemoteVault(config, { notify: (message, kind) => showToast(message, kind, kind === 'info' ? 3000 : 6000) })
    bindVaultStore(config)
  }, [config])
  return <App />
}

export default function WebRoot() {
  const [config, setConfig] = useState<WebConfig | null>(() => loadWebConfig())
  const theme = useUIStore(s => s.theme)

  // App applies the theme itself once mounted; the connect screen needs it earlier
  useEffect(() => { document.documentElement.setAttribute('data-theme', theme) }, [theme])

  if (!config) return <ConnectScreen onConnected={setConfig} />
  return <ConnectedApp config={config} />
}
