/**
 * useVaultWatcher — a personal document written from outside the app (MCP) arrives through the
 * incremental watcher path as a new document. The store cannot know it is personal; the vault
 * must be asked, or the tree shows it without its mark until the next full load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useVaultStore } from '@/stores/vaultStore'
import { useGraphStore } from '@/stores/graphStore'
import { tfidfIndex } from '@/lib/graphAnalysis'
import { parseVaultFiles } from '@/lib/markdownParser'

vi.mock('@/hooks/useVaultLoader', () => ({ useVaultLoader: () => ({ loadVault: vi.fn() }) }))
vi.mock('@/lib/bm25WorkerClient', () => ({
  updateDocInWorker: async (serialized: unknown) => ({ serialized, implicitLinks: [] }),
}))
vi.mock('@/lib/tfidfCache', () => ({ invalidateTfIdfCache: async () => {} }))

import { useVaultWatcher } from '@/hooks/useVaultWatcher'

const VAULT = 'C:/vault'
const team = { relativePath: 'notes/Team.md', absolutePath: `${VAULT}/notes/Team.md`, content: '# Team\n\nshared', mtime: 1 }

describe('useVaultWatcher and personal documents', () => {
  let onChanged: ((d: { vaultPath: string; changedFile?: string }) => void) | null = null
  const files = new Map<string, string>()
  const personal = new Set<string>()

  beforeEach(() => {
    onChanged = null
    files.clear(); files.set(team.absolutePath, team.content)
    personal.clear()
    window.vaultAPI = {
      onChanged: (cb) => { onChanged = cb; return () => { onChanged = null } },
      readFile: async (p: string) => files.get(p) ?? null,
      isPersonal: (p: string) => personal.has(p),
    } as unknown as Window['vaultAPI']
    const docs = parseVaultFiles([team])
    useVaultStore.setState({ vaultPath: VAULT, loadedDocuments: docs, isLoading: false, watchDiff: null })
    useGraphStore.setState({ graphLayoutReady: true })
    tfidfIndex.build(docs)
  })
  afterEach(() => { delete (window as { vaultAPI?: unknown }).vaultAPI })

  const fire = async (rel: string) => {
    await act(async () => { onChanged!({ vaultPath: VAULT, changedFile: rel }); await new Promise(r => setTimeout(r, 20)) })
  }

  it('a new document the vault reports as personal carries the mark; a team one does not — and the watcher stays awake in the editor', async () => {
    renderHook(() => useVaultWatcher())
    expect(onChanged).toBeTruthy()
    files.set(`${VAULT}/notes/Mine.md`, '# Mine\n\nnot yet')
    personal.add(`${VAULT}/notes/Mine.md`)
    await fire('notes/Mine.md')
    const mine = useVaultStore.getState().loadedDocuments!.find(d => d.absolutePath.endsWith('Mine.md'))
    expect(mine?.personal).toBe(true)

    files.set(`${VAULT}/notes/Team.md`, '# Team\n\nshared, edited')
    await fire('notes/Team.md')
    const t = useVaultStore.getState().loadedDocuments!.find(d => d.absolutePath.endsWith('Team.md'))
    expect(t?.rawContent).toContain('edited')
    expect(t?.personal).toBeUndefined()
    // No graph view is mounted here, so nothing else would have re-armed the guard between the two events
    expect(useGraphStore.getState().graphLayoutReady).toBe(true)
  })

  it('a publish or withdraw changes only the flag: the document is patched in place', async () => {
    renderHook(() => useVaultWatcher())
    personal.add(team.absolutePath)
    await fire('notes/Team.md')
    expect(useVaultStore.getState().loadedDocuments!.find(d => d.absolutePath === team.absolutePath)?.personal).toBe(true)
    expect(useVaultStore.getState().watchDiff).toBeNull()   // nothing to show as a text change
    personal.delete(team.absolutePath)
    await fire('notes/Team.md')
    expect(useVaultStore.getState().loadedDocuments!.find(d => d.absolutePath === team.absolutePath)?.personal).toBeUndefined()
  })

  it('without isPersonal (desktop), an edited document keeps the flag the full load gave it', async () => {
    delete (window.vaultAPI as { isPersonal?: unknown }).isPersonal
    const docs = useVaultStore.getState().loadedDocuments!
    useVaultStore.setState({ loadedDocuments: docs.map(d => ({ ...d, personal: true })) })
    renderHook(() => useVaultWatcher())
    files.set(`${VAULT}/notes/Team.md`, '# Team\n\nedited again')
    await fire('notes/Team.md')
    const t = useVaultStore.getState().loadedDocuments!.find(d => d.absolutePath.endsWith('Team.md'))
    expect(t?.rawContent).toContain('edited again')
    expect(t?.personal).toBe(true)
  })
})
