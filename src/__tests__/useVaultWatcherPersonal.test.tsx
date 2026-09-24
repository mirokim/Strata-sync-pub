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

const loadVault = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useVaultLoader', () => ({ useVaultLoader: () => ({ loadVault }) }))
// The worker's logic, run in place: restore, apply the batch, serialize
vi.mock('@/lib/bm25WorkerClient', async () => {
  const { TfIdfIndex } = await vi.importActual<typeof import('@/lib/graphAnalysis')>('@/lib/graphAnalysis')
  return {
    updateDocsInWorker: async (serialized: never, docs: never[], removedIds: string[], _adj: unknown, fingerprint: string) => {
      const index = new TfIdfIndex()
      index.restore(serialized)
      for (const id of removedIds) index.removeDoc(id)
      for (const doc of docs) index.updateDoc(doc)
      return { serialized: index.serialize(fingerprint), implicitLinks: [] }
    },
  }
})
vi.mock('@/lib/tfidfCache', () => ({ invalidateTfIdfCache: async () => {} }))

import { useVaultWatcher } from '@/hooks/useVaultWatcher'

const VAULT = 'C:/vault'
const team = { relativePath: 'notes/Team.md', absolutePath: `${VAULT}/notes/Team.md`, content: '# Team\n\nshared', mtime: 1 }

describe('useVaultWatcher and personal documents', () => {
  let onChanged: ((d: { vaultPath: string; changedFile?: string; changedFiles?: string[]; removedFiles?: string[] }) => void) | null = null
  const files = new Map<string, string>()
  const personal = new Set<string>()

  beforeEach(() => {
    loadVault.mockReset()
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

  it('refreshes a web snapshot without a foreground loading overlay', async () => {
    window.vaultAPI!.loadSnapshot = vi.fn()
    renderHook(() => useVaultWatcher())
    await fire('notes/New.md')
    expect(loadVault).toHaveBeenCalledWith(VAULT, true)
    expect(useVaultStore.getState().isLoading).toBe(false)
  })

  it('web: patches only the documents a pull listed — no reload, graph and search follow', async () => {
    window.vaultAPI!.loadSnapshot = vi.fn()
    renderHook(() => useVaultWatcher())
    files.set(`${VAULT}/notes/New.md`, '# New\n\nlinks [[Team]] about zebras')
    await act(async () => { onChanged!({ vaultPath: VAULT, changedFiles: ['notes/New.md'], removedFiles: [] }); await new Promise(r => setTimeout(r, 20)) })
    expect(loadVault).not.toHaveBeenCalled()
    const paths = () => useVaultStore.getState().loadedDocuments!.map(d => d.relativePath ?? d.absolutePath)
    expect(paths().some(p => p.endsWith('New.md'))).toBe(true)
    expect(useGraphStore.getState().links.length).toBeGreaterThan(0)
    expect(tfidfIndex.search('zebras').length).toBeGreaterThan(0)
    // Deletion through the same path
    await act(async () => { onChanged!({ vaultPath: VAULT, changedFiles: [], removedFiles: ['notes/Team.md'] }); await new Promise(r => setTimeout(r, 20)) })
    expect(loadVault).not.toHaveBeenCalled()
    expect(paths().some(p => p.endsWith('Team.md'))).toBe(false)
  })

  it('web: a change without a document list still reloads from the snapshot', async () => {
    window.vaultAPI!.loadSnapshot = vi.fn()
    renderHook(() => useVaultWatcher())
    await act(async () => { onChanged!({ vaultPath: VAULT }); await new Promise(r => setTimeout(r, 20)) })
    expect(loadVault).toHaveBeenCalledWith(VAULT, true)
  })

  it('coalesces web changes arriving while a snapshot is being parsed', async () => {
    window.vaultAPI!.loadSnapshot = vi.fn()
    let finish!: () => void
    loadVault.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    renderHook(() => useVaultWatcher())
    await fire('notes/First.md')
    await fire('notes/Second.md')
    await fire('notes/Third.md')
    expect(loadVault).toHaveBeenCalledTimes(1)
    await act(async () => { finish(); await Promise.resolve() })
    expect(loadVault).toHaveBeenCalledTimes(2)
  })

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
