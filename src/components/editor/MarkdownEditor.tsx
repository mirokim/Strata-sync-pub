/**
 * MarkdownEditor — CodeMirror 6 based vault file editor
 *
 * [[WikiLink]] WYSIWYG: shows rendered links on lines without cursor.
 * Lines with cursor show raw [[...]] syntax (Obsidian-style).
 * [[ triggers autocomplete: React portal dropdown at exact position.
 *
 * Lock = edit permission lock (read-only). Used for multi-user permission control later.
 * Auto-save 3s debounce + Ctrl+S. Rebuilds graph when wikiLinks change on save.
 */

import { useEffect, useRef, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { EditorView, keymap, drawSelection, highlightActiveLine } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import matter from 'gray-matter'
import { ArrowLeft, Save, CheckCircle, AlertCircle, X, Lock, Unlock, Pencil, Wand2, RotateCcw, Loader2, Brain, EyeOff, Users, Eye, Code2 } from 'lucide-react'
import { useUIStore } from '@/stores/uiStore'
import { useVaultStore } from '@/stores/vaultStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { makeBasicAuth, makePATAuth, updatePage } from '@/services/confluenceApi'
import { useGraphStore } from '@/stores/graphStore'
import { parseMarkdownFile, parseVaultFiles } from '@/lib/markdownParser'
import { buildGraph } from '@/lib/graphBuilder'
import { tfidfIndex } from '@/lib/graphAnalysis'
import { updateDocInWorker } from '@/lib/bm25WorkerClient'
import { buildAdjacencyMap } from '@/lib/graphRAG'
import { invalidateTfIdfCache } from '@/lib/tfidfCache'
import { MOCK_DOCUMENTS } from '@/data/mockDocuments'
import { conflictName } from '@/lib/conflictCopy'
import { loadWebConfig } from '@/web/config'
import { currentRemoteVault } from '@/web/remoteVault'
import { imageFileFrom, imageExtension } from '@/lib/imageDoc'
import { docPath } from '@/lib/brain'
import { showToast } from '@/stores/toastStore'
import { useT } from '@/i18n'
import ProposalBanner from './ProposalBanner'
import BrainPanel from './BrainPanel'
import type { LoadedDocument } from '@/types'
import { markdownHighlight, vaultTheme } from '@/lib/editor/codemirrorTheme'
import { buildWikiLinkPlugin, buildHighlightPlugin, buildCommentPlugin } from '@/lib/editor/wikiLinkPlugin'
import { livePreview } from '@/lib/editor/livePreview'
import { findFrontmatter } from '@/lib/editor/frontmatterProps'
import {
  mdIndentList,
  mdDedentList,
  mdContinueList,
  mdToggleMark,
  mdContinueBlockquote,
} from '@/lib/editor/markdownHelpers'

const AUTOSAVE_DELAY = 3000

// Returns the full string with YAML frontmatter tags field updated.
function updateFrontmatterTags(rawContent: string, newTags: string[]): string {
  const trimmed = rawContent.trimStart()
  if (!trimmed.startsWith('---')) {
    if (newTags.length === 0) return rawContent
    return `---\ntags: [${newTags.join(', ')}]\n---\n\n${rawContent}`
  }
  const parsed = matter(rawContent)
  if (newTags.length > 0) parsed.data.tags = newTags
  else delete parsed.data.tags
  return matter.stringify(parsed.content, parsed.data)
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

interface DocInfo { name: string; folder: string }

// ── WikiLink Suggest dropdown (React portal) ──────────────────────────────────

interface WikiSuggestState {
  query: string
  from: number   // Position after [[ in editor
  to: number     // Current cursor position
  rect: { top: number; bottom: number; left: number }
  selectedIdx: number
}

interface SuggestDropdownProps {
  docs: DocInfo[]
  selectedIdx: number
  rect: WikiSuggestState['rect']
  onSelect: (name: string) => void
}

function SuggestDropdown({ docs, selectedIdx, rect, onSelect }: SuggestDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null)

  // Scroll to keep selected item visible
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    const item = list.children[selectedIdx] as HTMLElement | undefined
    item?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  if (docs.length === 0) return null

  return createPortal(
    <div
      ref={listRef}
      style={{
        position: 'fixed',
        top: rect.bottom + 4,
        left: rect.left,
        zIndex: 99999,
        background: 'var(--color-bg-secondary)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 2,
        boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
        overflow: 'hidden',
        maxHeight: 220,
        overflowY: 'auto',
        minWidth: 180,
      }}
    >
      {docs.map(({ name, folder }, i) => (
        <div
          key={name}
          onMouseDown={(e) => {
            e.preventDefault() // Keep editor focus
            onSelect(name)
          }}
          style={{
            padding: '5px 12px',
            cursor: 'pointer',
            fontSize: 12,
            fontFamily: 'ui-monospace, "Cascadia Code", Consolas, monospace',
            background: i === selectedIdx ? 'rgba(255,255,255,0.09)' : 'transparent',
            color: i === selectedIdx ? 'var(--color-text-primary)' : 'var(--color-text-secondary)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </span>
          {folder && (
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', flexShrink: 0 }}>
              {folder}
            </span>
          )}
        </div>
      ))}
    </div>,
    document.body,
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function MarkdownEditor() {
  const t = useT()
  const { editingDocId, closeEditor, openInEditor, brainPanelOpen, toggleBrainPanel } = useUIStore()
  const { loadedDocuments, setLoadedDocuments, vaultPath } = useVaultStore()
  const vaultFolders = useVaultStore(s => s.vaultFolders)
  const tagPresets = useSettingsStore(s => s.tagPresets)
  const { setNodes, setLinks } = useGraphStore()

  const doc: LoadedDocument | undefined =
    loadedDocuments?.find(d => d.id === editingDocId) ??
    MOCK_DOCUMENTS.find(d => d.id === editingDocId)

  const absolutePath = doc?.absolutePath ?? ''
  const canSave = Boolean(absolutePath && window.vaultAPI)

  const [isLocked, setIsLocked] = useState(false)
  const isLockedRef = useRef(isLocked)
  isLockedRef.current = isLocked
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [localTags, setLocalTags] = useState<string[]>(doc?.tags ?? [])
  const [isAddingTag, setIsAddingTag] = useState(false)
  const [tagInput, setTagInput] = useState('')
  const [previousTags, setPreviousTags] = useState<string[] | null>(null)
  const [isSuggestingTags, setIsSuggestingTags] = useState(false)
  const [suggestedTags, setSuggestedTags] = useState<string[] | null>(null)
  const [isSuggestingSpeaker, setIsSuggestingSpeaker] = useState(false)
  const [suggestedSpeaker, setSuggestedSpeaker] = useState<string | null>(null)
  const [confluenceUploadStatus, setConfluenceUploadStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle')
  const [wikiSuggest, setWikiSuggest] = useState<WikiSuggestState | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const renameInputRef = useRef<HTMLInputElement>(null)
  const isRenamingRef = useRef(false)
  const renameValueRef = useRef('')
  renameValueRef.current = renameValue

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDirty = useRef(false)
  /** Text of the last successful save (or the last external version adopted) — our own echo. */
  const lastSavedRef = useRef<string | null>(null)

  const editorMountRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const readOnlyCompartment = useRef(new Compartment())
  const livePreviewCompartment = useRef(new Compartment())
  const editorLivePreview = useSettingsStore(s => s.editorLivePreview)
  const toggleEditorLivePreview = useSettingsStore(s => s.toggleEditorLivePreview)
  const language = useSettingsStore(s => s.language)
  // Live preview extension for the current language (labels are baked into the widgets)
  const livePreviewExtension = useCallback(() => livePreview({
    isLockedRef,
    labels: { properties: t('Properties'), editSource: t('Edit source'), multiline: t('Multi-line value — edit in source'), addProperty: t('Add property'), key: t('key') },
  }), [t])
  const livePreviewExtensionRef = useRef(livePreviewExtension)
  livePreviewExtensionRef.current = livePreviewExtension

  // Document list for autocomplete (always up to date)
  const docInfoRef = useRef<DocInfo[]>([])
  docInfoRef.current = loadedDocuments?.map(d => ({
    name: d.filename.replace(/\.md$/i, ''),
    folder: d.folderPath || '',
  })) ?? []

  // Stable mutable refs
  const loadedDocsRef = useRef(loadedDocuments)
  loadedDocsRef.current = loadedDocuments
  const docRef = useRef(doc)
  docRef.current = doc
  const canSaveRef = useRef(canSave)
  canSaveRef.current = canSave
  const absolutePathRef = useRef(absolutePath)
  absolutePathRef.current = absolutePath

  const setWikiSuggestRef = useRef(setWikiSuggest)
  setWikiSuggestRef.current = setWikiSuggest
  const wikiSuggestRef = useRef(wikiSuggest)
  wikiSuggestRef.current = wikiSuggest

  // Filtered document list based on current query (recalculated per render)
  const filteredDocs = wikiSuggest
    ? docInfoRef.current.filter(d => {
        const q = wikiSuggest.query.toLowerCase()
        return q === '' || d.name.toLowerCase().includes(q)
      })
    : []
  const clampedIdx = filteredDocs.length > 0
    ? Math.min(wikiSuggest?.selectedIdx ?? 0, filteredDocs.length - 1)
    : 0

  // ── Rename ─────────────────────────────────────────────────────────────

  const startRename = useCallback(() => {
    if (!canSave) return
    const currentDoc = docRef.current as LoadedDocument
    if (!currentDoc?.absolutePath) return
    setRenameValue(currentDoc.filename.replace(/\.md$/i, ''))
    isRenamingRef.current = true
    setIsRenaming(true)
    setTimeout(() => { renameInputRef.current?.select() }, 20)
  }, [canSave])

  const commitRename = useCallback(async () => {
    // Guard against double invocation from Enter key + onBlur
    if (!isRenamingRef.current) return
    isRenamingRef.current = false
    setIsRenaming(false)
    const value = renameValueRef.current
    const currentDoc = docRef.current as LoadedDocument
    if (!currentDoc?.absolutePath || !value.trim()) return
    const newFilename = value.trim().endsWith('.md')
      ? value.trim()
      : `${value.trim()}.md`
    if (newFilename === currentDoc.filename) return
    try {
      await window.vaultAPI!.renameFile(currentDoc.absolutePath, newFilename)
      if (vaultPath && window.vaultAPI) {
        const { files } = await window.vaultAPI.loadFiles(vaultPath)
        if (files) {
          const docs = parseVaultFiles(files) as LoadedDocument[]
          setLoadedDocuments(docs)
          const { nodes, links } = buildGraph(docs)
          setNodes(nodes)
          setLinks(links)
          const sep = currentDoc.absolutePath.includes('\\') ? '\\' : '/'
          const dir = currentDoc.absolutePath.replace(/[\\/][^\\/]+$/, '')
          const newAbsPath = `${dir}${sep}${newFilename}`
          const newDoc = docs.find(d =>
            d.absolutePath.replace(/\\/g, '/') === newAbsPath.replace(/\\/g, '/')
          )
          if (newDoc) openInEditor(newDoc.id)
        }
      }
    } catch (e) {
      console.error('[MarkdownEditor] rename failed:', e)
      showToast(t('Rename failed: {error}', { error: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }, [vaultPath, setLoadedDocuments, setNodes, setLinks, openInEditor, t])

  // ── Save ──────────────────────────────────────────────────────────────────

  const doSave = useCallback(async (text: string) => {
    if (!canSaveRef.current) return
    const path = absolutePathRef.current
    if (!path) return

    setSaveStatus('saving')
    try {
      const result = await window.vaultAPI!.saveFile(path, text)
      lastSavedRef.current = text

      // The adapter/engine lost a race and stored our text as a conflict copy: the document under
      // this name is now someone else's version. Leave the store alone — the vault watcher brings
      // the server version in and the effect below swaps it into the buffer.
      if (result?.path && result.path.replace(/\\/g, '/') !== path.replace(/\\/g, '/')) {
        setSaveStatus('saved')
        isDirty.current = false
        setTimeout(() => setSaveStatus('idle'), 2000)
        return
      }

      const currentDoc = docRef.current as LoadedDocument
      if (loadedDocsRef.current && currentDoc?.absolutePath) {
        const relativePath = currentDoc.folderPath
          ? `${currentDoc.folderPath}/${currentDoc.filename}`
          : currentDoc.filename
        const reparsed = parseMarkdownFile({
          relativePath,
          absolutePath: path,
          content: text,
          mtime: Date.now(),
        })
        // parseVaultFiles resolves docId collisions with a "_2" suffix via pushWithUniqueId.
        // A standalone parseMarkdownFile call knows nothing about that and returns the raw, non-unique id —
        // using it as-is leaves two documents with the same id in loadedDocuments, and the
        // BM25 index (rawTermFreqs.set(doc.id, ...)) overwrites one with the other, skewing N.
        // (Real vaults contain colliding pairs such as "active\3월.md" vs "active\3월..md")
        reparsed.id = currentDoc.id

        const updated = loadedDocsRef.current.map(d =>
          d.id === currentDoc.id ? reparsed : d,
        ) as LoadedDocument[]
        setLoadedDocuments(updated)

        const oldLinks = currentDoc.sections.flatMap(s => s.wikiLinks).sort().join(',')
        const newLinks = reparsed.sections.flatMap(s => s.wikiLinks).sort().join(',')
        const { nodes: graphNodes, links: graphLinks } = buildGraph(updated)
        if (oldLinks !== newLinks) {
          setNodes(graphNodes)
          setLinks(graphLinks)
        }

        // BM25 incremental update — reprocess only the saved document
        if (tfidfIndex.isBuilt) {
          try {
            // In-memory fingerprint only — not persisted to disk (see the comment below)
            const fingerprint = `edit:${Date.now()}`
            const adj = buildAdjacencyMap(graphLinks)
            const { serialized, implicitLinks } = await updateDocInWorker(
              tfidfIndex.serialize(fingerprint), reparsed, adj, fingerprint,
            )
            tfidfIndex.restore(serialized)
            tfidfIndex.setImplicitLinks(implicitLinks, adj)
            // Invalidate the cache instead of saving it.
            // loadTfIdfCache compares against buildFingerprint(docs) = a list of "id:mtime",
            // and right after a save the file's real on-disk mtime is unknown, so no matching fingerprint can be built.
            // The old code stamped String(Date.now()) as the fingerprint, overwriting a valid cache,
            // which caused a permanent cache miss + full rebuild on every subsequent startup.
            // Invalidating means one rebuild on the next vault load, then it is re-cached with the correct fingerprint.
            const vaultRoot = useVaultStore.getState().vaultPath
            if (vaultRoot) invalidateTfIdfCache(vaultRoot).catch(() => {})
          } catch {
            // BM25 update failure is silently handled (recovers on next full load)
          }
        }
      }

      setSaveStatus('saved')
      isDirty.current = false
      setTimeout(() => setSaveStatus('idle'), 2000)
    } catch (e) {
      console.error('[MarkdownEditor] save failed:', e)
      showToast(t('File save failed: {error}', { error: e instanceof Error ? e.message : String(e) }), 'error')
      setSaveStatus('error')
    }
  }, [setLoadedDocuments, setNodes, setLinks, t])

  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave

  // ── External changes to the open document ──────────────────────────────────
  // The vault watcher (fs.watch, desktop sync pull, web poll) replaces the document in the store
  // while it is open here. Adopt the new text so the next autosave does not write stale content
  // over a teammate's version. Unsaved local edits are never dropped: they go to a conflict copy.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !doc) return
    const incoming = doc.rawContent ?? ''
    const current = view.state.doc.toString()
    if (incoming === current || incoming === lastSavedRef.current) return

    const adopt = () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: incoming } })
      lastSavedRef.current = incoming
      isDirty.current = false
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
      setSaveStatus('idle')
    }

    if (!isDirty.current) { adopt(); return }

    // Dirty buffer vs external change: keep ours as a conflict copy, then show theirs
    const vaultRoot = useVaultStore.getState().vaultPath
    const rel = doc.folderPath ? `${doc.folderPath}/${doc.filename}` : doc.filename
    const copyRel = conflictName(rel, loadWebConfig()?.author || 'local', Date.now())
    const sep = doc.absolutePath.includes('\\') ? '\\' : '/'
    const copyAbs = vaultRoot ? `${vaultRoot}${sep}${copyRel.replace(/\//g, sep)}` : null
    if (copyAbs && window.vaultAPI) {
      window.vaultAPI.saveFile(copyAbs, current)
        .then(() => showToast(t('{filename} was changed elsewhere — your unsaved edits are kept as "{copyName}"', { filename: doc.filename, copyName: copyRel.split('/').pop() ?? '' }), 'warn', 6000))
        .catch(e => showToast(t('Could not keep your edits as a conflict copy: {error}', { error: e instanceof Error ? e.message : String(e) }), 'error'))
    }
    adopt()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.rawContent])

  const handleManualSave = useCallback(() => {
    if (!viewRef.current) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    doSaveRef.current(viewRef.current.state.doc.toString())
  }, [])

  const handleManualSaveRef = useRef(handleManualSave)
  handleManualSaveRef.current = handleManualSave

  // ── WikiLink click navigation ─────────────────────────────────────────────────────

  const handleLinkClick = useCallback((slug: string) => {
    const target = loadedDocsRef.current?.find(d =>
      d.filename.replace(/\.md$/i, '').toLowerCase() === slug.toLowerCase(),
    )
    if (target) openInEditor(target.id)
  }, [openInEditor])

  // ── Personal ↔ team (web build, signed in) ──────────────────────────────────────
  const remoteForPersonal = currentRemoteVault()
  const canTogglePersonal = Boolean(remoteForPersonal?.personalEnabled && doc && !doc.id.startsWith('gallery:'))
  const [togglingPersonal, setTogglingPersonal] = useState(false)
  const togglePersonal = useCallback(async () => {
    const remote = currentRemoteVault()
    if (!remote || !doc) return
    const makePersonal = !doc.personal
    if (!makePersonal && !window.confirm(t('Share "{name}" with the team? Everyone will see it from now on, members will react to it, and its history starts here.', { name: doc.filename.replace(/\.md$/i, '') }))) return
    setTogglingPersonal(true)
    try {
      if (isDirty.current && viewRef.current) await doSaveRef.current(viewRef.current.state.doc.toString())
      const r = await remote.setPersonal(doc.absolutePath, makePersonal)
      showToast(r.personal ? t('Only you can see this document now.') : t('Shared with the team.'), 'success')
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setTogglingPersonal(false)
    }
  }, [doc, t])

  // ── Image paste / drop → attachments/ + image document (web build) ──────────────
  const handleImagePaste = useCallback(async (file: File, view: EditorView) => {
    const remote = currentRemoteVault()
    const current = loadedDocsRef.current?.find(d => d.id === editingDocId)
    if (!remote || !current) { showToast(t('Pasting images needs the team server (web app).'), 'warn'); return }
    const ext = imageExtension(file.type)
    if (!ext) return
    if (file.size > 6 * 1024 * 1024) { showToast(t('Image is larger than 6 MB — resize it first.'), 'warn'); return }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const { embed } = await remote.pasteImage(bytes, ext, docPath(current))
      const pos = view.state.selection.main.head
      view.dispatch({ changes: { from: pos, insert: `${embed}
` }, selection: { anchor: pos + embed.length + 1 } })
      showToast(t('Image saved — describe it from your MCP client (images_undescribed) to make it searchable.'), 'success')
    } catch (e) {
      showToast(t('Image upload failed: {error}', { error: e instanceof Error ? e.message : String(e) }), 'error')
    }
  }, [editingDocId, t])
  const handleImagePasteRef = useRef(handleImagePaste)
  handleImagePasteRef.current = handleImagePaste

  const handleLinkClickRef = useRef(handleLinkClick)
  handleLinkClickRef.current = handleLinkClick

  // Open image gallery when clicking ![[image.png]] in locked state
  // Opens the gallery node (gallery:{docId}) of the document containing the clicked image.
  const handleImageClick = useCallback((_ref: string) => {
    if (editingDocId) openInEditor(`gallery:${editingDocId}`)
  }, [openInEditor, editingDocId])

  const handleImageClickRef = useRef(handleImageClick)
  handleImageClickRef.current = handleImageClick

  // ── WikiLink autocomplete confirm ─────────────────────────────────────────────────

  const applyWikiSuggest = useCallback((name: string) => {
    const view = viewRef.current
    const suggest = wikiSuggestRef.current
    if (!view || !suggest) return
    const textAfter = view.state.doc.sliceString(suggest.to, suggest.to + 2)
    const closeStr = textAfter === ']]' ? '' : ']]'
    const insert = name + closeStr
    view.dispatch({
      changes: { from: suggest.from, to: suggest.to, insert },
      selection: { anchor: suggest.from + insert.length },
    })
    setWikiSuggestRef.current(null)
    view.focus()
  }, [])

  const applyRef = useRef(applyWikiSuggest)
  applyRef.current = applyWikiSuggest

  // ── EditorView initialization ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!editorMountRef.current || !doc) return

    viewRef.current?.destroy()
    viewRef.current = null
    isDirty.current = false
    setSaveStatus('idle')
    setWikiSuggestRef.current(null)

    const wikiPlugin = buildWikiLinkPlugin(
      (slug) => handleLinkClickRef.current(slug),
      {
        isLockedRef,
        onImageClick: (ref) => handleImageClickRef.current(ref),
      },
    )

    // Open with the cursor below the frontmatter, so the properties render instead of raw YAML
    const raw = doc.rawContent ?? ''
    const fmEnd = findFrontmatter(raw)?.to
    const view = new EditorView({
      state: EditorState.create({
        doc: raw,
        selection: fmEnd != null ? { anchor: Math.min(raw.length, fmEnd + 1) } : undefined,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          keymap.of([
            // WikiLink autocomplete keys (registered before defaultKeymap)
            {
              key: 'ArrowDown',
              run: () => {
                if (!wikiSuggestRef.current) return false
                const docs = docInfoRef.current.filter(d => {
                  const q = wikiSuggestRef.current!.query.toLowerCase()
                  return q === '' || d.name.toLowerCase().includes(q)
                })
                setWikiSuggestRef.current(prev =>
                  prev ? { ...prev, selectedIdx: Math.min(prev.selectedIdx + 1, docs.length - 1) } : null,
                )
                return true
              },
            },
            {
              key: 'ArrowUp',
              run: () => {
                if (!wikiSuggestRef.current) return false
                setWikiSuggestRef.current(prev =>
                  prev ? { ...prev, selectedIdx: Math.max(prev.selectedIdx - 1, 0) } : null,
                )
                return true
              },
            },
            {
              key: 'Enter',
              run: () => {
                const suggest = wikiSuggestRef.current
                if (!suggest) return false
                const docs = docInfoRef.current.filter(d => {
                  const q = suggest.query.toLowerCase()
                  return q === '' || d.name.toLowerCase().includes(q)
                })
                const idx = Math.min(suggest.selectedIdx, docs.length - 1)
                const selected = docs[idx]
                if (selected) { applyRef.current(selected.name); return true }
                return false
              },
            },
            {
              key: 'Escape',
              run: () => {
                if (!wikiSuggestRef.current) return false
                setWikiSuggestRef.current(null)
                return true
              },
            },
            // ── Markdown list indentation ──
            { key: 'Tab',       run: mdIndentList },
            { key: 'Shift-Tab', run: mdDedentList },
            // ── List / blockquote continuation (only when WikiSuggest is inactive) ──
            {
              key: 'Enter',
              run: (view) => {
                if (wikiSuggestRef.current) return false
                if (mdContinueList(view)) return true
                return mdContinueBlockquote(view)
              },
            },
            // ── Inline formatting ──
            { key: 'Ctrl-b',       run: (view) => mdToggleMark(view, '**') },
            { key: 'Mod-b',        run: (view) => mdToggleMark(view, '**') },
            { key: 'Ctrl-i',       run: (view) => mdToggleMark(view, '*') },
            { key: 'Mod-i',        run: (view) => mdToggleMark(view, '*') },
            { key: 'Ctrl-Shift-s', run: (view) => mdToggleMark(view, '~~') },
            { key: 'Mod-Shift-s',  run: (view) => mdToggleMark(view, '~~') },
            { key: 'Ctrl-Shift-h', run: (view) => mdToggleMark(view, '==') },
            { key: 'Mod-Shift-h',  run: (view) => mdToggleMark(view, '==') },
            { key: 'Ctrl-Shift-c', run: (view) => mdToggleMark(view, '`') },
            { key: 'Mod-Shift-c',  run: (view) => mdToggleMark(view, '`') },
            ...defaultKeymap,
            ...historyKeymap,
            { key: 'Ctrl-s', run: () => { handleManualSaveRef.current(); return true } },
            { key: 'Mod-s', run: () => { handleManualSaveRef.current(); return true } },
          ]),
          markdown({ base: markdownLanguage }),   // GFM: tables, task lists, strikethrough
          syntaxHighlighting(markdownHighlight),
          wikiPlugin,
          buildHighlightPlugin({ isLockedRef }),
          buildCommentPlugin(),
          EditorView.domEventHandlers({
            paste: (event, view) => {
              const file = imageFileFrom(event.clipboardData)
              if (!file) return false
              event.preventDefault()
              void handleImagePasteRef.current(file, view)
              return true
            },
            drop: (event, view) => {
              const file = imageFileFrom(event.dataTransfer)
              if (!file) return false
              event.preventDefault()
              void handleImagePasteRef.current(file, view)
              return true
            },
          }),
          vaultTheme,
          EditorView.lineWrapping,
          readOnlyCompartment.current.of([]),
          livePreviewCompartment.current.of(useSettingsStore.getState().editorLivePreview ? livePreviewExtensionRef.current() : []),
          EditorView.updateListener.of((update) => {
            // Auto-save
            if (update.docChanged) {
              isDirty.current = true
              setSaveStatus('idle')
              if (saveTimer.current) clearTimeout(saveTimer.current)
              const text = update.state.doc.toString()
              saveTimer.current = setTimeout(() => doSaveRef.current(text), AUTOSAVE_DELAY)
            }

            // [[ autocomplete detection
            if (update.docChanged || update.selectionSet) {
              const { state } = update
              const cursor = state.selection.main.head
              const line = state.doc.lineAt(cursor)
              const textBefore = line.text.slice(0, cursor - line.from)
              const match = textBefore.match(/\[\[([^\]]*)$/)

              if (match) {
                const coords = update.view.coordsAtPos(cursor)
                if (coords) {
                  const from = cursor - match[1].length
                  setWikiSuggestRef.current(prev => ({
                    query: match[1],
                    from,
                    to: cursor,
                    rect: coords,
                    selectedIdx: prev?.query === match[1] ? prev.selectedIdx : 0,
                  }))
                }
              } else {
                setWikiSuggestRef.current(null)
              }
            }
          }),
        ],
      }),
      parent: editorMountRef.current,
    })

    viewRef.current = view

    return () => {
      if (isDirty.current && saveTimer.current) {
        clearTimeout(saveTimer.current)
        doSaveRef.current(view.state.doc.toString())
      }
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id])

  // Lock toggle
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        isLocked ? EditorState.readOnly.of(true) : [],
      ),
    })
  }, [isLocked])

  // Live preview ↔ source, and relabel the widgets when the UI language changes
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: livePreviewCompartment.current.reconfigure(editorLivePreview ? livePreviewExtension() : []),
    })
  }, [editorLivePreview, language, livePreviewExtension])

  // Sync localTags on document switch
  useEffect(() => {
    setLocalTags(doc?.tags ?? [])
    setIsAddingTag(false)
    setTagInput('')
    setPreviousTags(null)
    setSuggestedTags(null)
    setIsSuggestingTags(false)
    setSuggestedSpeaker(null)
    setIsSuggestingSpeaker(false)
  }, [doc?.id])

  // ── Tag editing ──────────────────────────────────────────────────────────────

  const handleTagChange = useCallback((newTags: string[], saveUndo = true) => {
    if (saveUndo) setPreviousTags(localTags)
    setLocalTags(newTags)
    const currentRaw = viewRef.current?.state.doc.toString() ?? ''
    const newRaw = updateFrontmatterTags(currentRaw, newTags)
    if (viewRef.current) {
      viewRef.current.dispatch({
        changes: { from: 0, to: viewRef.current.state.doc.length, insert: newRaw },
      })
    }
  }, [localTags])

  const commitTag = useCallback(() => {
    const trimmed = tagInput.trim()
    if (trimmed) handleTagChange([...localTags, trimmed])
    setTagInput('')
    setIsAddingTag(false)
  }, [tagInput, localTags, handleTagChange])

  const handleUndoTags = useCallback(() => {
    if (previousTags === null) return
    handleTagChange(previousTags, false)
    setPreviousTags(null)
  }, [previousTags, handleTagChange])

  const handleSuggestTags = useCallback(async () => {
    setIsSuggestingTags(true)
    setSuggestedTags(null)
    try {
      const raw = viewRef.current?.state.doc.toString() ?? docRef.current?.rawContent ?? ''
      const filename = (docRef.current as LoadedDocument)?.filename ?? ''
      const { suggestTagsForDoc } = await import('@/services/tagService')
      const tags = await suggestTagsForDoc(filename, raw)
      setSuggestedTags(tags)
    } catch {
      setSuggestedTags([])
    } finally {
      setIsSuggestingTags(false)
    }
  }, [])

  const handleSuggestSpeaker = useCallback(async () => {
    setIsSuggestingSpeaker(true)
    setSuggestedSpeaker(null)
    try {
      const raw = viewRef.current?.state.doc.toString() ?? docRef.current?.rawContent ?? ''
      const filename = (docRef.current as LoadedDocument)?.filename ?? ''
      const { suggestSpeakerForDoc } = await import('@/services/tagService')
      const speaker = await suggestSpeakerForDoc(filename, raw)
      setSuggestedSpeaker(speaker)
    } catch {
      setSuggestedSpeaker(null)
    } finally {
      setIsSuggestingSpeaker(false)
    }
  }, [])

  const handleConfluenceUpload = useCallback(async () => {
    const currentDoc = docRef.current as LoadedDocument
    if (!currentDoc) return
    const raw = viewRef.current?.state.doc.toString() ?? currentDoc.rawContent
    const parsed = matter(raw)
    const pageId = parsed.data?.confluence_page_id as string | undefined
    if (!pageId) {
      alert(t('No confluence_page_id in frontmatter.\nExample: confluence_page_id: "12345"'))
      return
    }
    const { activeVaultId } = useVaultStore.getState()
    const { confluenceConfigs } = useSettingsStore.getState()
    const cfg = confluenceConfigs[activeVaultId]
    if (!cfg?.baseUrl) {
      alert(t('Please configure Confluence integration in settings first.'))
      return
    }
    const authHeader = cfg.authType === 'cloud' || cfg.authType === 'server_basic'
      ? makeBasicAuth(cfg.email, cfg.apiToken)
      : makePATAuth(cfg.apiToken)
    const creds = { baseUrl: cfg.baseUrl, authHeader }

    // markdown body (frontmatter removed)
    const bodyMd = parsed.content.trimStart()
    const title = currentDoc.filename.replace(/\.md$/i, '')

    setConfluenceUploadStatus('uploading')
    try {
      await updatePage(creds, pageId, title, bodyMd)
      setConfluenceUploadStatus('done')
      setTimeout(() => setConfluenceUploadStatus('idle'), 3000)
    } catch (e) {
      setConfluenceUploadStatus('error')
      alert(t('Confluence upload failed: {error}', { error: e instanceof Error ? e.message : String(e) }))
      setTimeout(() => setConfluenceUploadStatus('idle'), 3000)
    }
  }, [t])

  const applySuggestedSpeaker = useCallback(() => {
    if (!suggestedSpeaker) return
    const view = viewRef.current
    if (!view) return
    const raw = view.state.doc.toString()
    const parsed = matter(raw)
    parsed.data.speaker = suggestedSpeaker
    const updated = matter.stringify(parsed.content, parsed.data)
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: updated } })
    setSuggestedSpeaker(null)
  }, [suggestedSpeaker])

  // ── No document ─────────────────────────────────────────────────────────────

  if (!doc) {
    return (
      <div
        style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', gap: 12, height: '100%',
          color: 'var(--color-text-muted)', fontSize: 13,
        }}
      >
        <span>{t('No file open')}</span>
        <button
          onClick={closeEditor}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            background: 'var(--color-bg-secondary)', border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 2, color: 'var(--color-text-secondary)', cursor: 'pointer',
            padding: '6px 14px', fontSize: 12, transition: 'color 0.15s, border-color 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--color-text-primary)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.25)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-secondary)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)' }}
        >
          <ArrowLeft size={13} />
          {t('Back to Graph')}
        </button>
      </div>
    )
  }

  const displayName = doc.filename.replace(/\.md$/i, '')

  /** After a proposal is promoted or discarded: reload the vault and follow the file (or close). */
  const handleProposalDone = useCallback(async (result: { kind: 'promoted'; newAbsolutePath: string } | { kind: 'discarded' }) => {
    if (!vaultPath || !window.vaultAPI) return
    const { files } = await window.vaultAPI.loadFiles(vaultPath)
    if (!files) return
    const docs = parseVaultFiles(files) as LoadedDocument[]
    setLoadedDocuments(docs)
    const { nodes, links } = buildGraph(docs)
    setNodes(nodes)
    setLinks(links)
    if (result.kind === 'promoted') {
      const target = result.newAbsolutePath.replace(/\\/g, '/')
      const newDoc = docs.find(d => d.absolutePath.replace(/\\/g, '/') === target)
      showToast(t('Proposal promoted into the vault'), 'success')
      if (newDoc) openInEditor(newDoc.id); else closeEditor()
    } else {
      showToast(t('Proposal discarded'), 'success')
      closeEditor()
    }
  }, [vaultPath, setLoadedDocuments, setNodes, setLinks, openInEditor, closeEditor, t])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {doc && (
        <ProposalBanner
          doc={doc}
          vaultPath={vaultPath}
          folders={vaultFolders}
          onDone={handleProposalDone}
          onError={msg => showToast(t('Proposal action failed: {message}', { message: msg }), 'error')}
        />
      )}
      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: '1px solid var(--color-border)', flexShrink: 0 }}>
        <button
          onClick={closeEditor}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: '3px 6px', borderRadius: 4, fontSize: 11, transition: 'color 0.1s' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
          title={t('Close editor')}
        >
          <ArrowLeft size={13} />
        </button>

        {isRenaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename() }
              if (e.key === 'Escape') { e.preventDefault(); isRenamingRef.current = false; setIsRenaming(false) }
            }}
            style={{
              flex: 1, fontSize: 12, fontWeight: 500,
              background: 'var(--color-bg-surface)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-accent)',
              borderRadius: 4, padding: '1px 6px', outline: 'none',
            }}
            autoFocus
          />
        ) : (
          <button
            onClick={canSave ? startRename : undefined}
            title={canSave ? t('Click to rename') : doc.filename}
            style={{
              flex: 1, fontSize: 12, fontWeight: 500,
              color: 'var(--color-text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              background: 'transparent', border: 'none',
              cursor: canSave ? 'text' : 'default',
              textAlign: 'left', padding: 0,
              display: 'flex', alignItems: 'center', gap: 4,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayName}</span>
            {canSave && <Pencil size={10} style={{ flexShrink: 0, color: 'var(--color-text-muted)', opacity: 0.5 }} />}
          </button>
        )}

        {canTogglePersonal && (
          <button
            onClick={togglePersonal}
            disabled={togglingPersonal}
            data-testid="personal-toggle"
            aria-pressed={Boolean(doc?.personal)}
            style={{ display: 'flex', alignItems: 'center', gap: 4, background: doc?.personal ? 'var(--color-bg-active)' : 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: doc?.personal ? 'var(--color-accent)' : 'var(--color-text-muted)', cursor: 'pointer', padding: '3px 7px', fontSize: 11, transition: 'color 0.15s, border-color 0.15s' }}
            title={doc?.personal ? t('Only you can see this document — click to share it with the team') : t('Keep this document to yourself (only you will see it)')}
          >
            {doc?.personal ? <EyeOff size={11} /> : <Users size={11} />}
            {doc?.personal ? t('Only me') : ''}
          </button>
        )}

        <button
          onClick={toggleEditorLivePreview}
          aria-pressed={editorLivePreview}
          data-testid="live-preview-toggle"
          style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: editorLivePreview ? 'var(--color-accent)' : 'var(--color-text-muted)', cursor: 'pointer', padding: '3px 7px', fontSize: 11, transition: 'color 0.15s, border-color 0.15s' }}
          title={editorLivePreview ? t('Live preview on — click for raw source') : t('Source mode — click for live preview')}
        >
          {editorLivePreview ? <Eye size={11} /> : <Code2 size={11} />}
        </button>

        <button
          onClick={() => setIsLocked(v => !v)}
          style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: isLocked ? 'var(--color-error)' : 'var(--color-text-muted)', cursor: 'pointer', padding: '3px 7px', fontSize: 11, transition: 'color 0.15s, border-color 0.15s' }}
          title={isLocked ? t('Unlock (allow editing)') : t('Lock (restrict editing)')}
        >
          {isLocked ? <Lock size={11} /> : <Unlock size={11} />}
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: !canSave ? 'var(--color-text-muted)' : saveStatus === 'saved' ? 'var(--color-success)' : saveStatus === 'error' ? 'var(--color-error)' : 'var(--color-text-muted)', transition: 'color 0.2s' }}>
          {!canSave && t('Read-only')}
          {canSave && saveStatus === 'saved' && <><CheckCircle size={11} />{t('Saved')}</>}
          {canSave && saveStatus === 'saving' && t('Saving...')}
          {canSave && saveStatus === 'error' && <><AlertCircle size={11} />{t('Save failed')}</>}
        </div>

        <button
          onClick={handleManualSave}
          disabled={!canSave}
          style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 4, color: 'var(--color-text-muted)', cursor: canSave ? 'pointer' : 'not-allowed', opacity: canSave ? 1 : 0.3, padding: '3px 7px', fontSize: 11, transition: 'color 0.1s, border-color 0.1s' }}
          onMouseEnter={e => { if (canSave) { e.currentTarget.style.color = 'var(--color-text-primary)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)' } }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--color-text-muted)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
          title={canSave ? t('Save (Ctrl+S)') : t('Cannot save non-vault files')}
        >
          <Save size={11} />
        </button>

        {/* Confluence reverse upload button — active when frontmatter has confluence_page_id */}
        {canSave && (() => {
          const raw = (doc as LoadedDocument)?.rawContent ?? ''
          const hasCfId = raw.includes('confluence_page_id')
          if (!hasCfId) return null
          const uploading = confluenceUploadStatus === 'uploading'
          const done = confluenceUploadStatus === 'done'
          const err = confluenceUploadStatus === 'error'
          return (
            <button
              onClick={handleConfluenceUpload}
              disabled={uploading}
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                background: done ? 'rgba(52,211,153,0.12)' : err ? 'rgba(248,113,113,0.1)' : 'transparent',
                border: `1px solid ${done ? 'rgba(52,211,153,0.3)' : err ? 'rgba(248,113,113,0.3)' : 'rgba(255,255,255,0.08)'}`,
                borderRadius: 4, fontSize: 11,
                color: done ? 'var(--color-success)' : err ? 'var(--color-error)' : 'var(--color-text-muted)',
                cursor: uploading ? 'default' : 'pointer', opacity: uploading ? 0.5 : 1,
                padding: '3px 7px', transition: 'all 0.1s',
              }}
              title={t('Upload to Confluence page')}
            >
              {uploading ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : '↑'}
              {done ? t('Uploaded') : err ? t('Failed') : 'Confluence'}
            </button>
          )
        })()}

        <button
          onClick={toggleBrainPanel}
          data-testid="brain-toggle"
          aria-pressed={brainPanelOpen}
          style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', color: brainPanelOpen ? 'var(--color-accent)' : 'var(--color-text-muted)', cursor: 'pointer', padding: '3px', borderRadius: 4, transition: 'color 0.1s' }}
          title={brainPanelOpen ? t('Hide what the vault knows around this document') : t('Show what the vault knows around this document')}
        >
          <Brain size={13} />
        </button>
        <button
          onClick={closeEditor}
          style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: '3px', borderRadius: 4, transition: 'color 0.1s' }}
          onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
          title={t('Close')}
        >
          <X size={13} />
        </button>
      </div>

      {/* ── Metadata bar (tags + folder) ── */}
      {(doc as LoadedDocument).absolutePath && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 12px', borderBottom: '1px solid var(--color-border)', flexShrink: 0, flexWrap: 'wrap', minHeight: 28 }}>
          {(doc as LoadedDocument).folderPath && (
            <span style={{ fontSize: 10, color: 'var(--color-text-muted)', marginRight: 2 }}>
              📁 {(doc as LoadedDocument).folderPath}
            </span>
          )}

          {localTags.map(tag => (
            <span
              key={tag}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: 'var(--color-accent)', background: 'var(--color-bg-active)', borderRadius: 3, padding: '1px 5px' }}
            >
              #{tag}
              {!isLocked && (
                <button
                  onClick={() => handleTagChange(localTags.filter(existing => existing !== tag))}
                  style={{ display: 'flex', alignItems: 'center', background: 'none', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: 0, fontSize: 10, lineHeight: 1 }}
                  title={t('Remove "{tag}" tag', { tag })}
                >
                  ×
                </button>
              )}
            </span>
          ))}

          {!isLocked && (
            isAddingTag
              ? <>
                  {/* Preset tag quick selection */}
                  {tagPresets.filter(p => !localTags.includes(p)).map(p => (
                    <button
                      key={p}
                      onMouseDown={e => {
                        e.preventDefault()
                        handleTagChange([...localTags, p])
                        setIsAddingTag(false)
                      }}
                      style={{ fontSize: 10, color: 'var(--color-accent)', background: 'var(--color-bg-active)', border: '1px solid rgba(96,165,250,0.3)', cursor: 'pointer', padding: '1px 5px', borderRadius: 3, transition: 'opacity 0.1s' }}
                      title={t('Add #{tag} tag', { tag: p })}
                    >
                      #{p}
                    </button>
                  ))}
                  <input
                    autoFocus
                    value={tagInput}
                    placeholder={t('Type tag...')}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); commitTag() }
                      if (e.key === 'Escape') { setTagInput(''); setIsAddingTag(false) }
                    }}
                    onBlur={commitTag}
                    style={{ fontSize: 10, background: 'transparent', border: 'none', borderBottom: '1px solid var(--color-accent)', color: 'var(--color-text-primary)', width: 72, outline: 'none', padding: '1px 0' }}
                  />
                </>
              : <button
                  onClick={() => setIsAddingTag(true)}
                  style={{ fontSize: 10, color: 'var(--color-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, transition: 'color 0.1s' }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
                  title={t('Add tag')}
                >
                  + {t('Tag')}
                </button>
          )}

          {!isLocked && previousTags !== null && (
            <button
              onClick={handleUndoTags}
              style={{ display: 'flex', alignItems: 'center', background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, transition: 'color 0.1s' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
              title={t('Undo tag changes')}
            >
              <RotateCcw size={10} />
            </button>
          )}

          {suggestedSpeaker !== null && (
            <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 5, paddingTop: 3 }}>
              <span style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>{t('Persona suggestion:')}</span>
              <span style={{ fontSize: 10, color: 'var(--color-accent)', background: 'var(--color-bg-active)', borderRadius: 3, padding: '1px 5px' }}>
                {suggestedSpeaker}
              </span>
              <button
                onClick={applySuggestedSpeaker}
                style={{ fontSize: 10, color: 'var(--color-text-muted)', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer', padding: '1px 5px', borderRadius: 3, transition: 'color 0.1s' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
              >
                {t('Apply')}
              </button>
              <button
                onClick={() => setSuggestedSpeaker(null)}
                style={{ fontSize: 10, color: 'var(--color-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, transition: 'color 0.1s' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
              >
                {t('Cancel')}
              </button>
            </div>
          )}

          {suggestedTags !== null && (
            <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 5, paddingTop: 3 }}>
              <span style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>{t('Suggestions:')}</span>
              {suggestedTags.length === 0
                ? <span style={{ fontSize: 9, color: 'var(--color-text-muted)' }}>{t('No suitable tags')}</span>
                : suggestedTags.map(kw => (
                    <span key={kw} style={{ fontSize: 10, color: 'var(--color-accent)', background: 'var(--color-bg-active)', borderRadius: 3, padding: '1px 5px' }}>#{kw}</span>
                  ))
              }
              {suggestedTags.length > 0 && (
                <button
                  onClick={() => { handleTagChange(suggestedTags); setSuggestedTags(null) }}
                  style={{ fontSize: 10, color: 'var(--color-text-muted)', background: 'transparent', border: '1px solid rgba(255,255,255,0.1)', cursor: 'pointer', padding: '1px 5px', borderRadius: 3, transition: 'color 0.1s' }}
                  onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                  onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
                >
                  {t('Apply')}
                </button>
              )}
              <button
                onClick={() => setSuggestedTags(null)}
                style={{ fontSize: 10, color: 'var(--color-text-muted)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '1px 4px', borderRadius: 3, transition: 'color 0.1s' }}
                onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-text-primary)')}
                onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-text-muted)')}
              >
                {t('Cancel')}
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── CodeMirror editor + what the vault knows around this document ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div ref={editorMountRef} style={{ flex: 1, minWidth: 0, minHeight: 0 }} />
        {brainPanelOpen && doc && <BrainPanel doc={doc} />}
      </div>

      {/* ── WikiLink autocomplete dropdown (React portal → document.body) ── */}
      {wikiSuggest && filteredDocs.length > 0 && (
        <SuggestDropdown
          docs={filteredDocs}
          selectedIdx={clampedIdx}
          rect={wikiSuggest.rect}
          onSelect={applyWikiSuggest}
        />
      )}
    </div>
  )
}
