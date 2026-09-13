/**
 * Live preview for the CodeMirror 6 markdown editor — Obsidian-style.
 *
 * Markdown syntax is rendered in place and its markers hidden, except on the lines the selection
 * touches, where the raw source shows for editing. In locked (read-only) mode nothing is "active",
 * so the whole document renders — that is the reading view.
 *
 *   livePreview({ isLockedRef, onOpenUrl, labels })
 *
 * Two extensions cooperate:
 *   - a StateField for block-level replacements that change vertical layout (frontmatter →
 *     properties table, GFM tables → HTML table, horizontal rules, code-fence lines) — block
 *     widgets must come from a state field, not a view plugin, so the viewport is measured right;
 *   - a ViewPlugin for inline decorations inside the viewport (heading sizes, hidden `#`/`**`/`~~`/
 *     backtick/link markers, list bullets, task checkboxes, blockquote bars, callouts, #tags).
 *
 * Wikilinks, ==highlights== and %%comments%% keep their own plugins (wikiLinkPlugin.ts).
 */
import { EditorView, Decoration, WidgetType, ViewPlugin } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import { StateField, RangeSet } from '@codemirror/state'
import type { EditorState, Range, Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { findFrontmatter, propLine } from './frontmatterProps'
import type { FrontmatterBlock, FrontmatterProp } from './frontmatterProps'

export interface LivePreviewLabels {
  properties: string
  editSource: string
  multiline: string
  addProperty: string
  key: string
}

export interface LivePreviewOptions {
  /** When true nothing is editable and every element renders (reading view) */
  isLockedRef?: { current: boolean }
  /** External link clicked in the rendered text */
  onOpenUrl?: (url: string) => void
  labels?: Partial<LivePreviewLabels>
}

const DEFAULT_LABELS: LivePreviewLabels = { properties: 'Properties', editSource: 'Edit source', multiline: 'multi-line value — edit in source', addProperty: 'Add property', key: 'key' }

// ── Selection helpers ────────────────────────────────────────────────────────

/** True when any selection range touches [from, to]. */
function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const r of state.selection.ranges) if (r.from <= to && r.to >= from) return true
  return false
}

/** Inline elements reveal their source when the selection is on any of their lines. */
function lineActive(state: EditorState, from: number, to: number, locked: boolean): boolean {
  if (locked) return false
  return selectionTouches(state, state.doc.lineAt(from).from, state.doc.lineAt(to).to)
}

const hide = Decoration.replace({})

// ── Widgets ──────────────────────────────────────────────────────────────────

class HrWidget extends WidgetType {
  toDOM() { const el = document.createElement('div'); el.className = 'cm-lp-hr'; return el }
  eq() { return true }
  ignoreEvent() { return false }
}

class BulletWidget extends WidgetType {
  constructor(readonly depth: number) { super() }
  toDOM() { const el = document.createElement('span'); el.className = 'cm-lp-bullet'; el.textContent = this.depth % 2 ? '◦' : '•'; return el }
  eq(o: BulletWidget) { return o.depth === this.depth }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly from: number, readonly to: number, readonly locked: boolean) { super() }
  toDOM(view: EditorView) {
    const el = document.createElement('input')
    el.type = 'checkbox'
    el.className = 'cm-lp-checkbox'
    el.checked = this.checked
    el.disabled = this.locked
    el.addEventListener('mousedown', e => e.preventDefault())   // keep the editor selection where it is
    el.addEventListener('click', e => {
      e.preventDefault()
      if (this.locked) return
      view.dispatch({ changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' } })
    })
    return el
  }
  eq(o: CheckboxWidget) { return o.checked === this.checked && o.from === this.from && o.locked === this.locked }
  // The editor must not act on the click: it would move the selection onto the line, reveal the
  // source and drop this widget before the click lands
  ignoreEvent() { return true }
}

class CalloutMarkWidget extends WidgetType {
  constructor(readonly kind: string) { super() }
  toDOM() { const el = document.createElement('span'); el.className = `cm-lp-callout-icon cm-lp-callout-icon-${this.kind}`; el.textContent = CALLOUT_ICONS[this.kind] ?? 'ℹ'; return el }
  eq(o: CalloutMarkWidget) { return o.kind === this.kind }
}
const CALLOUT_ICONS: Record<string, string> = { note: 'ℹ', info: 'ℹ', tip: '💡', hint: '💡', warning: '⚠', caution: '⚠', danger: '⛔', error: '⛔', bug: '🐞', example: '📋', quote: '❝', question: '❓', success: '✅', todo: '☑', abstract: '📄', summary: '📄' }

class CodeFenceWidget extends WidgetType {
  constructor(readonly lang: string, readonly closing: boolean) { super() }
  toDOM() {
    const el = document.createElement('div')
    el.className = this.closing ? 'cm-lp-codefence cm-lp-codefence-end' : 'cm-lp-codefence'
    if (!this.closing) el.textContent = this.lang
    return el
  }
  eq(o: CodeFenceWidget) { return o.lang === this.lang && o.closing === this.closing }
  ignoreEvent() { return false }
}

class TableWidget extends WidgetType {
  constructor(readonly text: string, readonly from: number) { super() }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-table'
    const rows = this.text.split('\n').map(splitTableRow)
    const align = rows[1]?.map(cell => /^:-+:$/.test(cell) ? 'center' : /^-+:$/.test(cell) ? 'right' : 'left') ?? []
    const table = document.createElement('table')
    rows.forEach((cells, i) => {
      if (i === 1) return
      const tr = document.createElement('tr')
      cells.forEach((cell, c) => {
        const td = document.createElement(i === 0 ? 'th' : 'td')
        td.textContent = cell
        td.style.textAlign = align[c] ?? 'left'
        tr.appendChild(td)
      })
      table.appendChild(tr)
    })
    wrap.appendChild(table)
    wrap.addEventListener('mousedown', e => { e.preventDefault(); view.dispatch({ selection: { anchor: this.from } }); view.focus() })
    return wrap
  }
  eq(o: TableWidget) { return o.text === this.text && o.from === this.from }
  ignoreEvent() { return true }   // the mousedown handler above places the cursor itself
}

function splitTableRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue }
    if (t[i] === '|') { out.push(cur.trim()); cur = ''; continue }
    cur += t[i]
  }
  out.push(cur.trim())
  return out
}

class FrontmatterWidget extends WidgetType {
  constructor(readonly block: FrontmatterBlock, readonly locked: boolean, readonly labels: LivePreviewLabels, readonly signature: string) { super() }
  toDOM(view: EditorView) {
    const wrap = document.createElement('div')
    wrap.className = 'cm-lp-props'
    const head = document.createElement('div')
    head.className = 'cm-lp-props-head'
    const title = document.createElement('span')
    title.textContent = this.labels.properties
    head.appendChild(title)
    if (!this.locked) {
      const edit = document.createElement('button')
      edit.type = 'button'
      edit.className = 'cm-lp-props-edit'
      edit.textContent = this.labels.editSource
      edit.addEventListener('mousedown', e => e.preventDefault())
      edit.addEventListener('click', () => {
        const line = view.state.doc.line(Math.min(this.block.openLine + 1, view.state.doc.lines))
        view.dispatch({ selection: { anchor: line.from } })
        view.focus()
      })
      head.appendChild(edit)
    }
    wrap.appendChild(head)
    const table = document.createElement('div')
    table.className = 'cm-lp-props-table'
    for (const prop of this.block.props) table.appendChild(this.row(view, prop))
    wrap.appendChild(table)
    if (!this.locked) {
      const add = document.createElement('button')
      add.type = 'button'
      add.className = 'cm-lp-props-add'
      add.textContent = `+ ${this.labels.addProperty}`
      add.addEventListener('mousedown', e => e.preventDefault())
      add.addEventListener('click', () => {
        const closing = view.state.doc.line(this.block.closeLine)
        view.dispatch({ changes: { from: closing.from, insert: `${this.labels.key}: \n` }, selection: { anchor: closing.from } })
        view.focus()
      })
      wrap.appendChild(add)
    }
    return wrap
  }

  private row(view: EditorView, prop: FrontmatterProp): HTMLElement {
    const row = document.createElement('div')
    row.className = `cm-lp-prop cm-lp-prop-${prop.kind}`
    const key = document.createElement('div')
    key.className = 'cm-lp-prop-key'
    key.textContent = prop.key
    row.appendChild(key)
    const val = document.createElement('div')
    val.className = 'cm-lp-prop-value'
    // Deferred: a blur can fire while CodeMirror is already updating (the widget being replaced),
    // and dispatching inside an update throws. After the task the editor is idle again.
    const commit = (text: string) => setTimeout(() => {
      if (prop.line > view.state.doc.lines) return
      const line = view.state.doc.line(prop.line)
      if (line.text === text || !/^[A-Za-z0-9_][\w.\- ]*?\s*:/.test(line.text)) return   // the document moved under us
      view.dispatch({ changes: { from: line.from, to: line.to, insert: text } })
    }, 0)
    if (prop.kind === 'block') {
      const note = document.createElement('span')
      note.className = 'cm-lp-prop-note'
      note.textContent = this.labels.multiline
      val.appendChild(note)
    } else if (prop.kind === 'boolean') {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = prop.value === 'true'
      box.disabled = this.locked
      box.addEventListener('change', () => commit(propLine(prop.key, 'boolean', box.checked ? 'true' : 'false')))
      val.appendChild(box)
    } else if (prop.kind === 'list') {
      const items = prop.value as string[]
      if (prop.lineCount > 1 || this.locked) {
        for (const item of items) { const chip = document.createElement('span'); chip.className = 'cm-lp-chip'; chip.textContent = item; val.appendChild(chip) }
      } else {
        const input = document.createElement('input')
        input.className = 'cm-lp-prop-input'
        input.value = items.join(', ')
        input.addEventListener('change', () => commit(propLine(prop.key, 'list', input.value.split(',').map(s => s.trim()).filter(Boolean))))
        input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); e.stopPropagation() })
        val.appendChild(input)
      }
    } else {
      const input = document.createElement('input')
      input.className = 'cm-lp-prop-input'
      input.value = prop.value as string
      input.readOnly = this.locked
      input.type = prop.kind === 'number' ? 'number' : 'text'
      input.addEventListener('change', () => commit(propLine(prop.key, prop.kind === 'number' && !/^-?\d+(\.\d+)?$/.test(input.value) ? 'text' : prop.kind, input.value)))
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); e.stopPropagation() })
      val.appendChild(input)
    }
    row.appendChild(val)
    return row
  }

  eq(o: FrontmatterWidget) { return o.signature === this.signature && o.locked === this.locked }
  // Inputs and buttons inside the properties table handle their own events; if the editor saw the
  // mousedown it would move the cursor into the YAML, which swaps the widget for the source
  ignoreEvent() { return true }
}

// ── Block-level state field ──────────────────────────────────────────────────

function blockDecorations(state: EditorState, options: LivePreviewOptions, labels: LivePreviewLabels): DecorationSet {
  const locked = options.isLockedRef?.current ?? false
  const decos: Range<Decoration>[] = []
  const doc = state.doc

  // Frontmatter → properties (only ever at the top of the document)
  const fm = findFrontmatter(doc.sliceString(0, Math.min(doc.length, 20000)))
  if (fm) {
    if (!locked && selectionTouches(state, fm.from, fm.to)) {
      for (let n = fm.openLine; n <= fm.closeLine; n++) decos.push(Decoration.line({ class: 'cm-lp-frontmatter' }).range(doc.line(n).from))
    } else {
      const signature = doc.sliceString(fm.from, fm.to)
      decos.push(Decoration.replace({ widget: new FrontmatterWidget(fm, locked, labels, signature), block: true }).range(fm.from, fm.to))
    }
  }

  // The YAML fences also parse as markdown (`---` → rule, `key: value` above one → setext heading);
  // nothing inside the frontmatter is markdown, so skip every node that ends within it.
  const fmEnd = fm ? fm.to : -1
  syntaxTree(state).iterate({
    enter(node) {
      if (node.to <= fmEnd) return node.name === 'Document' ? undefined : false
      if (node.name === 'Table') {
        const active = !locked && selectionTouches(state, node.from, node.to)
        const first = doc.lineAt(node.from), last = doc.lineAt(node.to)
        if (active) {
          for (let n = first.number; n <= last.number; n++) decos.push(Decoration.line({ class: 'cm-lp-table-src' }).range(doc.line(n).from))
        } else {
          decos.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(first.from, last.to), node.from), block: true }).range(first.from, last.to))
        }
        return false
      }
      if (node.name === 'HorizontalRule') {
        const line = doc.lineAt(node.from)
        if (locked || !selectionTouches(state, line.from, line.to)) decos.push(Decoration.replace({ widget: new HrWidget(), block: true }).range(line.from, line.to))
        return false
      }
      if (node.name === 'FencedCode') {
        const first = doc.lineAt(node.from), last = doc.lineAt(node.to)
        const active = !locked && selectionTouches(state, node.from, node.to)
        const info = node.node.getChild('CodeInfo')
        const lang = info ? doc.sliceString(info.from, info.to) : ''
        for (let n = first.number; n <= last.number; n++) {
          const cls = n === first.number ? 'cm-lp-code cm-lp-code-first' : n === last.number ? 'cm-lp-code cm-lp-code-last' : 'cm-lp-code'
          decos.push(Decoration.line({ class: cls }).range(doc.line(n).from))
        }
        if (!active && last.number > first.number && /^\s*(```|~~~)/.test(last.text)) {
          decos.push(Decoration.replace({ widget: new CodeFenceWidget(lang, false), block: true }).range(first.from, first.to))
          decos.push(Decoration.replace({ widget: new CodeFenceWidget(lang, true), block: true }).range(last.from, last.to))
        }
        return false
      }
      return undefined
    },
  })
  return Decoration.set(decos, true)
}

function livePreviewBlocks(options: LivePreviewOptions, labels: LivePreviewLabels) {
  return StateField.define<DecorationSet>({
    create: state => blockDecorations(state, options, labels),
    update: (value, tr) => (tr.docChanged || tr.selection || tr.effects.length ? blockDecorations(tr.state, options, labels) : value),
    provide: f => EditorView.decorations.from(f),
  })
}

// ── Inline view plugin ───────────────────────────────────────────────────────

const HEADING_LEVEL: Record<string, number> = { ATXHeading1: 1, ATXHeading2: 2, ATXHeading3: 3, ATXHeading4: 4, ATXHeading5: 5, ATXHeading6: 6, SetextHeading1: 1, SetextHeading2: 2 }
const TAG_RE = /(^|[\s(])#((?=[^\s#]*[\p{L}_])[\p{L}\p{N}_/-]+)/gu
const CALLOUT_RE = /^(\s*>\s*)\[!([A-Za-z]+)\]([+-]?)/

function inlineDecorations(view: EditorView, options: LivePreviewOptions): DecorationSet {
  const { state } = view
  const doc = state.doc
  const locked = options.isLockedRef?.current ?? false
  const decos: Range<Decoration>[] = []
  const hideRange = (from: number, to: number) => { if (to > from) decos.push(hide.range(from, to)) }
  const hideMarks = (node: SyntaxNode, markName: string, active: boolean) => {
    if (active) return
    for (const m of node.getChildren(markName)) hideRange(m.from, m.to)
  }
  const quoteLines = new Set<number>()
  const fm = findFrontmatter(doc.sliceString(0, Math.min(doc.length, 20000)))
  const fmEnd = fm ? fm.to : -1

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(node) {
        const name = node.name
        if (node.to <= fmEnd) return name === 'Document' ? undefined : false
        if (name === 'FencedCode' || name === 'CodeBlock' || name === 'HTMLBlock' || name === 'Table') return false   // handled by the state field / left raw
        const level = HEADING_LEVEL[name]
        if (level) {
          const line = doc.lineAt(node.from)
          decos.push(Decoration.line({ class: `cm-lp-h cm-lp-h${level}` }).range(line.from))
          const active = lineActive(state, node.from, node.to, locked)
          for (const m of node.node.getChildren('HeaderMark')) {
            if (active) continue
            if (name.startsWith('Setext')) { const ml = doc.lineAt(m.from); hideRange(ml.from, ml.to) }
            else hideRange(m.from, Math.min(m.to + (doc.sliceString(m.to, m.to + 1) === ' ' ? 1 : 0), node.to))
          }
          return
        }
        switch (name) {
          case 'Emphasis':
          case 'StrongEmphasis':
            hideMarks(node.node, 'EmphasisMark', lineActive(state, node.from, node.to, locked)); return
          case 'Strikethrough':
            hideMarks(node.node, 'StrikethroughMark', lineActive(state, node.from, node.to, locked)); return
          case 'InlineCode': {
            const active = lineActive(state, node.from, node.to, locked)
            const marks = node.node.getChildren('CodeMark')
            if (marks.length === 2) {
              decos.push(Decoration.mark({ class: 'cm-lp-code-inline' }).range(marks[0].to, marks[1].from))
              if (!active) { hideRange(marks[0].from, marks[0].to); hideRange(marks[1].from, marks[1].to) }
            }
            return false
          }
          case 'Link':
          case 'Image': {
            const active = lineActive(state, node.from, node.to, locked)
            const marks = node.node.getChildren('LinkMark')
            const url = node.node.getChild('URL')
            if (marks.length < 2) return
            const textFrom = marks[0].to, textTo = marks[1].from
            const href = url ? doc.sliceString(url.from, url.to) : ''
            decos.push(Decoration.mark({ class: name === 'Image' ? 'cm-lp-image-alt' : 'cm-lp-link', attributes: { 'data-url': href, title: href } }).range(textFrom, Math.max(textFrom, textTo)))
            if (!active) { hideRange(node.from, textFrom); hideRange(textTo, node.to) }
            return
          }
          case 'ListItem': {
            const mark = node.node.getChild('ListMark')
            if (!mark) return
            const active = lineActive(state, mark.from, mark.to, locked)
            const text = doc.sliceString(mark.from, mark.to)
            // A task item shows only its checkbox — the bullet and the space before `[ ]` go away
            if (!active && node.node.getChild('Task')) { hideRange(mark.from, Math.min(mark.to + 1, doc.lineAt(mark.from).to)); return }
            if (!active && /^[-*+]$/.test(text)) {
              let depth = 0
              for (let p = node.node.parent; p; p = p.parent) if (p.name === 'ListItem') depth++
              decos.push(Decoration.replace({ widget: new BulletWidget(depth) }).range(mark.from, mark.to))
            }
            return
          }
          case 'Task': {
            const marker = node.node.getChild('TaskMarker')
            if (!marker) return
            const active = lineActive(state, marker.from, marker.to, locked)
            if (!active) {
              const checked = /x/i.test(doc.sliceString(marker.from, marker.to))
              decos.push(Decoration.replace({ widget: new CheckboxWidget(checked, marker.from, marker.to, locked) }).range(marker.from, marker.to))
              if (checked) decos.push(Decoration.mark({ class: 'cm-lp-task-done' }).range(marker.to, node.to))
            }
            return
          }
          case 'Blockquote': {
            const first = doc.lineAt(node.from), last = doc.lineAt(node.to)
            const callout = CALLOUT_RE.exec(first.text)
            const kind = callout ? callout[2].toLowerCase() : null
            for (let n = first.number; n <= last.number; n++) {
              if (quoteLines.has(n)) continue
              quoteLines.add(n)
              const cls = kind ? `cm-lp-quote cm-lp-callout cm-lp-callout-${kind}${n === first.number ? ' cm-lp-callout-title' : ''}` : 'cm-lp-quote'
              decos.push(Decoration.line({ class: cls }).range(doc.line(n).from))
            }
            if (!lineActive(state, node.from, node.to, locked) || locked) {
              for (const m of node.node.getChildren('QuoteMark')) hideRange(m.from, Math.min(m.to + (doc.sliceString(m.to, m.to + 1) === ' ' ? 1 : 0), doc.lineAt(m.from).to))
              if (callout && kind) {
                const tokFrom = first.from + callout[1].length, tokTo = tokFrom + callout[0].length - callout[1].length
                decos.push(Decoration.replace({ widget: new CalloutMarkWidget(kind) }).range(tokFrom, Math.min(tokTo + (first.text[tokTo - first.from] === ' ' ? 1 : 0), first.to)))
              }
            }
            return
          }
        }
        return undefined
      },
    })

    // #tags — not part of the markdown grammar; plain regex over the visible text outside code
    const text = doc.sliceString(from, to)
    let m: RegExpExecArray | null
    TAG_RE.lastIndex = 0
    while ((m = TAG_RE.exec(text)) !== null) {
      const start = from + m.index + m[1].length
      const inCode = syntaxTree(state).resolveInner(start, 1).name.match(/Code/)
      if (inCode) continue
      decos.push(Decoration.mark({ class: 'cm-lp-tag' }).range(start, start + 1 + m[2].length))
    }
  }
  return Decoration.set(decos, true)
}

function livePreviewInline(options: LivePreviewOptions) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) { this.decorations = inlineDecorations(view, options) }
      update(u: ViewUpdate) {
        if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some(tr => tr.effects.length > 0)) this.decorations = inlineDecorations(u.view, options)
      }
    },
    { decorations: v => v.decorations },
  )
}

// ── Clicks on rendered links ─────────────────────────────────────────────────

function linkClicks(options: LivePreviewOptions) {
  // Decided on mousedown: by the time `click` fires the editor has already moved the cursor onto
  // the line, which reveals the source — so the "is this line active?" test must run first.
  return EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
      const target = (event.target as HTMLElement | null)?.closest?.('.cm-lp-link') as HTMLElement | null
      if (!target) return false
      const url = target.dataset.url
      if (!url || !/^(https?:|mailto:)/i.test(url)) return false
      // On the source line a click is an edit, not navigation — unless the document is locked
      const locked = options.isLockedRef?.current ?? false
      const pos = view.posAtDOM(target)
      if (!locked && selectionTouches(view.state, view.state.doc.lineAt(pos).from, view.state.doc.lineAt(pos).to)) return false
      event.preventDefault()
      if (options.onOpenUrl) options.onOpenUrl(url)
      else window.open(url, '_blank', 'noopener')
      return true
    },
  })
}

// ── Theme ────────────────────────────────────────────────────────────────────

export const livePreviewTheme = EditorView.theme({
  '.cm-lp-h': { fontWeight: '700', color: 'var(--color-text-primary)', lineHeight: '1.35', marginTop: '0.6em' },
  '.cm-lp-h1': { fontSize: '1.75em' },
  '.cm-lp-h2': { fontSize: '1.45em' },
  '.cm-lp-h3': { fontSize: '1.2em' },
  '.cm-lp-h4': { fontSize: '1.05em' },
  '.cm-lp-h5, .cm-lp-h6': { fontSize: '1em', color: 'var(--color-text-secondary)' },
  '.cm-lp-code-inline': { fontFamily: 'var(--ea-font-mono)', fontSize: '0.9em', background: 'rgba(127,127,127,0.15)', borderRadius: '3px', padding: '0 3px' },
  '.cm-lp-code': { fontFamily: 'var(--ea-font-mono)', fontSize: '0.88em', background: 'rgba(127,127,127,0.10)', padding: '0 12px' },
  '.cm-lp-code-first': { borderRadius: '6px 6px 0 0' },
  '.cm-lp-code-last': { borderRadius: '0 0 6px 6px' },
  '.cm-lp-codefence': { fontFamily: 'var(--ea-font-mono)', fontSize: '0.72em', color: 'var(--color-text-muted)', background: 'rgba(127,127,127,0.10)', padding: '4px 12px 0', borderRadius: '6px 6px 0 0', textTransform: 'uppercase', letterSpacing: '0.05em', minHeight: '1em' },
  '.cm-lp-codefence-end': { padding: '0', height: '6px', borderRadius: '0 0 6px 6px' },
  '.cm-lp-hr': { borderTop: '1px solid var(--color-border)', margin: '10px 0' },
  '.cm-lp-bullet': { display: 'inline-block', width: '1ch', color: 'var(--color-text-muted)' },
  '.cm-lp-checkbox': { verticalAlign: '-2px', marginRight: '6px', accentColor: 'var(--color-accent)', cursor: 'pointer' },
  '.cm-lp-task-done': { color: 'var(--color-text-muted)', textDecoration: 'line-through' },
  '.cm-lp-quote': { borderLeft: '3px solid var(--color-border)', paddingLeft: '12px', color: 'var(--color-text-secondary)' },
  '.cm-lp-callout': { borderLeftColor: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)' },
  '.cm-lp-callout-title': { fontWeight: '600', color: 'var(--color-text-primary)', borderRadius: '6px 6px 0 0' },
  '.cm-lp-callout-warning, .cm-lp-callout-caution': { borderLeftColor: '#f59e0b', background: 'rgba(245,158,11,0.08)' },
  '.cm-lp-callout-danger, .cm-lp-callout-error': { borderLeftColor: '#ef4444', background: 'rgba(239,68,68,0.08)' },
  '.cm-lp-callout-tip, .cm-lp-callout-hint, .cm-lp-callout-success': { borderLeftColor: '#22c55e', background: 'rgba(34,197,94,0.08)' },
  '.cm-lp-callout-icon': { marginRight: '6px' },
  '.cm-lp-link': { color: 'var(--color-accent)', textDecoration: 'underline', textUnderlineOffset: '2px', cursor: 'pointer' },
  '.cm-lp-image-alt': { color: '#a78bfa', fontStyle: 'italic' },
  '.cm-lp-tag': { color: 'var(--color-accent)', background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)', borderRadius: '10px', padding: '0 6px', fontSize: '0.9em' },
  '.cm-lp-table-src': { fontFamily: 'var(--ea-font-mono)', fontSize: '0.88em' },
  '.cm-lp-table': { margin: '6px 0', overflowX: 'auto' },
  '.cm-lp-table table': { borderCollapse: 'collapse', fontSize: '0.92em', width: 'auto' },
  '.cm-lp-table th, .cm-lp-table td': { border: '1px solid var(--color-border)', padding: '4px 10px', verticalAlign: 'top' },
  '.cm-lp-table th': { background: 'rgba(127,127,127,0.10)', fontWeight: '600', color: 'var(--color-text-primary)' },
  '.cm-lp-frontmatter': { fontFamily: 'var(--ea-font-mono)', fontSize: '0.88em', color: 'var(--color-text-muted)', background: 'rgba(127,127,127,0.06)' },
  '.cm-lp-props': { border: '1px solid var(--color-border)', borderRadius: '8px', padding: '8px 12px', margin: '0 0 14px', fontSize: '0.9em', background: 'rgba(127,127,127,0.05)' },
  '.cm-lp-props-head': { display: 'flex', justifyContent: 'space-between', alignItems: 'center', color: 'var(--color-text-muted)', fontSize: '0.78em', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: '4px' },
  '.cm-lp-props-edit, .cm-lp-props-add': { background: 'transparent', border: 'none', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: '0.95em', padding: '2px 4px', borderRadius: '4px' },
  '.cm-lp-props-edit:hover, .cm-lp-props-add:hover': { color: 'var(--color-text-primary)', background: 'rgba(127,127,127,0.12)' },
  '.cm-lp-props-add': { marginTop: '4px', textTransform: 'none', letterSpacing: '0' },
  '.cm-lp-props-table': { display: 'grid', gridTemplateColumns: 'minmax(90px, max-content) 1fr', rowGap: '2px', columnGap: '12px' },
  '.cm-lp-prop': { display: 'contents' },
  '.cm-lp-prop-key': { color: 'var(--color-text-muted)', padding: '3px 0', whiteSpace: 'nowrap' },
  '.cm-lp-prop-value': { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px', minWidth: '0' },
  '.cm-lp-prop-input': { width: '100%', background: 'transparent', border: '1px solid transparent', borderRadius: '4px', color: 'var(--color-text-primary)', padding: '2px 4px', font: 'inherit' },
  '.cm-lp-prop-input:hover': { borderColor: 'var(--color-border)' },
  '.cm-lp-prop-input:focus': { outline: 'none', borderColor: 'var(--color-accent)' },
  '.cm-lp-chip': { background: 'color-mix(in srgb, var(--color-accent) 12%, transparent)', color: 'var(--color-accent)', borderRadius: '10px', padding: '1px 8px', fontSize: '0.9em' },
  '.cm-lp-prop-note': { color: 'var(--color-text-muted)', fontStyle: 'italic', fontSize: '0.9em' },
})

// ── Entry point ──────────────────────────────────────────────────────────────

/** The whole live-preview bundle: block field + inline plugin + link clicks + theme. */
export function livePreview(options: LivePreviewOptions = {}): Extension {
  const labels = { ...DEFAULT_LABELS, ...options.labels }
  return [livePreviewBlocks(options, labels), livePreviewInline(options), linkClicks(options), livePreviewTheme, EditorView.editorAttributes.of({ class: 'cm-live' })]
}

// Exported for tests
export { blockDecorations, inlineDecorations, splitTableRow }
export type { RangeSet }
