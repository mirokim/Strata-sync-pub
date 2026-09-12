/**
 * Live preview decorations — computed on a bare EditorState (no DOM), so the tests read which
 * ranges are hidden/replaced and which lines get classes, exactly what the editor would render.
 */
import { describe, it, expect } from 'vitest'
import { EditorState, EditorSelection } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { ensureSyntaxTree } from '@codemirror/language'
import type { Decoration } from '@codemirror/view'
import { blockDecorations, splitTableRow } from '@/lib/editor/livePreview'
import { findFrontmatter, propLine, yamlScalar } from '@/lib/editor/frontmatterProps'

function state(doc: string, cursor = doc.length) {
  const s = EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })], selection: EditorSelection.cursor(Math.min(cursor, doc.length)) })
  ensureSyntaxTree(s, doc.length, 5000)
  return s
}

function list(set: ReturnType<typeof blockDecorations>) {
  const out: { from: number; to: number; kind: string; cls?: string }[] = []
  const it = set.iter()
  while (it.value) {
    const spec = (it.value as Decoration).spec as { widget?: object; class?: string; block?: boolean }
    out.push({ from: it.from, to: it.to, kind: spec.widget ? spec.widget.constructor.name : spec.class ? 'line' : 'replace', cls: spec.class })
    it.next()
  }
  return out
}

const DOC = `---
title: "Hello"
tags: [a, b]
draft: true
---

# Heading

| a | b |
|---|---|
| 1 | 2 |

---

\`\`\`ts
const x = 1
\`\`\`
`

describe('frontmatterProps', () => {
  it('finds the block and types the properties', () => {
    const fm = findFrontmatter(DOC)!
    expect(fm.openLine).toBe(1)
    expect(fm.closeLine).toBe(5)
    expect(fm.props.map(p => [p.key, p.kind, p.value])).toEqual([
      ['title', 'text', 'Hello'], ['tags', 'list', ['a', 'b']], ['draft', 'boolean', 'true'],
    ])
    expect(DOC.slice(fm.from, fm.to).endsWith('---')).toBe(true)
  })

  it('reads block lists and multi-line values', () => {
    const fm = findFrontmatter('---\nauthors:\n  - kim\n  - lee\nnotes:\n  line one\n  line two\n---\nbody')!
    expect(fm.props[0]).toMatchObject({ key: 'authors', kind: 'list', value: ['kim', 'lee'], line: 2, lineCount: 3 })
    expect(fm.props[1]).toMatchObject({ key: 'notes', kind: 'block', line: 5, lineCount: 3 })
  })

  it('returns null without a closed fence', () => {
    expect(findFrontmatter('---\ntitle: x\nbody')).toBeNull()
    expect(findFrontmatter('body\n---\n')).toBeNull()
  })

  it('writes YAML lines that round-trip', () => {
    expect(propLine('tags', 'list', ['a', 'b c', 'x, y'])).toBe('tags: [a, b c, "x, y"]')
    expect(propLine('draft', 'boolean', 'false')).toBe('draft: false')
    expect(propLine('title', 'text', 'Plain title')).toBe('title: Plain title')
    expect(propLine('title', 'text', 'Colon: here')).toBe('title: "Colon: here"')
    expect(yamlScalar('')).toBe('""')
    expect(yamlScalar('true')).toBe('"true"')
  })
})

describe('blockDecorations', () => {
  it('replaces frontmatter, table, rule and code fences when the cursor is elsewhere', () => {
    const s = state(DOC, DOC.indexOf('Heading'))
    const kinds = list(blockDecorations(s, {}, { properties: 'P', editSource: 'E', multiline: 'M', addProperty: 'A', key: 'k' })).map(d => d.kind)
    expect(kinds).toContain('FrontmatterWidget')
    expect(kinds).toContain('TableWidget')
    expect(kinds).toContain('HrWidget')
    expect(kinds.filter(k => k === 'CodeFenceWidget')).toHaveLength(2)
  })

  it('shows the source of the block the cursor is in', () => {
    const inTable = state(DOC, DOC.indexOf('| 1 |'))
    const decos = list(blockDecorations(inTable, {}, { properties: 'P', editSource: 'E', multiline: 'M', addProperty: 'A', key: 'k' }))
    expect(decos.map(d => d.kind)).not.toContain('TableWidget')
    expect(decos.filter(d => d.cls === 'cm-lp-table-src')).toHaveLength(3)

    const inFm = state(DOC, DOC.indexOf('tags:'))
    const fmDecos = list(blockDecorations(inFm, {}, { properties: 'P', editSource: 'E', multiline: 'M', addProperty: 'A', key: 'k' }))
    expect(fmDecos.map(d => d.kind)).not.toContain('FrontmatterWidget')
    expect(fmDecos.filter(d => d.cls === 'cm-lp-frontmatter')).toHaveLength(5)
  })

  it('renders everything when locked, wherever the cursor is', () => {
    const s = state(DOC, DOC.indexOf('| 1 |'))
    const kinds = list(blockDecorations(s, { isLockedRef: { current: true } }, { properties: 'P', editSource: 'E', multiline: 'M', addProperty: 'A', key: 'k' })).map(d => d.kind)
    expect(kinds).toContain('TableWidget')
    expect(kinds).toContain('FrontmatterWidget')
  })
})

describe('splitTableRow', () => {
  it('handles outer pipes and escaped pipes', () => {
    expect(splitTableRow('| a | b \\| c |')).toEqual(['a', 'b | c'])
    expect(splitTableRow('a|b')).toEqual(['a', 'b'])
  })
})

describe('inlineDecorations (EditorView in jsdom)', () => {
  it('hides markers off the cursor line, shows them on it, and never decorates the frontmatter', async () => {
    const { EditorView } = await import('@codemirror/view')
    const { inlineDecorations } = await import('@/lib/editor/livePreview')
    const doc = '---\ntitle: x\n---\n\n# Head\n\nsome **bold** and `code` and [link](https://a.b)\n\n- [ ] task\n- item\n\n> [!note] Hi\n> quoted #tag'
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const view = new EditorView({ state: EditorState.create({ doc, extensions: [markdown({ base: markdownLanguage })], selection: EditorSelection.cursor(doc.indexOf('- item')) }), parent })
    ensureSyntaxTree(view.state, doc.length, 5000)
    const off = list(inlineDecorations(view, {}))
    const classes = off.map(d => d.cls).filter(Boolean)
    expect(classes).toContain('cm-lp-h cm-lp-h1')
    expect(classes).toContain('cm-lp-code-inline')
    expect(classes).toContain('cm-lp-link')
    expect(classes).toContain('cm-lp-tag')
    expect(classes.some(c => c!.includes('cm-lp-callout-note'))).toBe(true)
    expect(off.map(d => d.kind)).toContain('CheckboxWidget')
    expect(off.map(d => d.kind)).toContain('CalloutMarkWidget')
    // `#` of the heading and `**` of bold are hidden (replace decorations at those offsets)
    expect(off.some(d => d.kind === 'replace' && d.from === doc.indexOf('# Head'))).toBe(true)
    expect(off.some(d => d.kind === 'replace' && d.from === doc.indexOf('**bold**'))).toBe(true)
    // nothing inside the frontmatter
    expect(off.every(d => d.from >= doc.indexOf('# Head'))).toBe(true)
    // the cursor line ("- item") keeps its bullet source, and a task item shows a checkbox instead of a bullet
    expect(off.filter(d => d.kind === 'BulletWidget')).toEqual([])
    expect(off.some(d => d.kind === 'replace' && d.from === doc.indexOf('- [ ]'))).toBe(true)

    // move the cursor onto the bold line → its markers are visible again
    view.dispatch({ selection: EditorSelection.cursor(doc.indexOf('bold')) })
    const on = list(inlineDecorations(view, {}))
    expect(on.some(d => d.kind === 'replace' && d.from === doc.indexOf('**bold**'))).toBe(false)
    expect(on.some(d => d.kind === 'replace' && d.from === doc.indexOf('# Head'))).toBe(true)
    view.destroy()
  })
})
