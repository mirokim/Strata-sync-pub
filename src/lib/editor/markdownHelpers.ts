/**
 * Markdown editing helper functions for CodeMirror 6.
 * Obsidian-style list continuation, indentation, inline mark toggle,
 * and blockquote continuation — used as keymap handlers.
 */

import { EditorView } from '@codemirror/view'
import type { EditorState } from '@codemirror/state'

// ── List item line detection regex ───────────────────────────────────────────

/** 리스트 항목 줄 탐지 정규식 */
export const LIST_RE = /^(\s*)([-*+]|\d+\.)( \[[ xX]\])? /

/** 번호 목록: 특정 인덴트 레벨에서 바로 위의 항목 번호 반환 (없으면 0) */
export function prevNumAtIndent(state: EditorState, fromLine: number, indentLen: number): number {
  for (let n = fromLine - 1; n >= 1; n--) {
    const text = state.doc.line(n).text
    if (text.trim() === '') continue
    const m = text.match(/^(\s*)(\d+\.)/)
    if (m) {
      const d = m[1].length
      if (d === indentLen) return parseInt(m[2])
      if (d < indentLen) return 0  // 상위 레벨 — 같은 레벨 없음
    } else if (!LIST_RE.test(text)) {
      return 0  // 리스트 아닌 줄 — 탐색 중단
    }
  }
  return 0
}

/** Tab: 리스트 항목 들여쓰기 (+2 spaces), 번호 목록은 레벨별 번호 재계산 */
export function mdIndentList(view: EditorView): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  if (from !== to) return false
  const line = state.doc.lineAt(from)
  if (!LIST_RE.test(line.text)) return false

  // 번호 목록: 새 인덴트 레벨에 맞는 번호 계산
  const numM = line.text.match(/^(\s*)(\d+\.)( .*)/)
  if (numM) {
    const newIndentLen = numM[1].length + 2
    const prev = prevNumAtIndent(state, line.number, newIndentLen)
    const newNum = prev > 0 ? prev + 1 : 1
    const oldMarker = numM[2]
    const newMarker = `${newNum}.`
    const newText = `  ${numM[1]}${newMarker}${numM[3]}`
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: newText },
      selection: { anchor: from + 2 + (newMarker.length - oldMarker.length) },
      userEvent: 'input.indent',
    })
    return true
  }

  // 불릿 목록: 2 spaces 추가
  view.dispatch({
    changes: { from: line.from, insert: '  ' },
    selection: { anchor: from + 2 },
    userEvent: 'input.indent',
  })
  return true
}

/** Shift-Tab: 리스트 항목 내어쓰기 (-2 spaces) */
export function mdDedentList(view: EditorView): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  if (from !== to) return false
  const line = state.doc.lineAt(from)
  if (!LIST_RE.test(line.text)) return false
  const spaces = (line.text.match(/^( +)/) ?? ['', ''])[1].length
  if (spaces < 2) return false
  const remove = Math.min(2, spaces)
  view.dispatch({
    changes: { from: line.from, to: line.from + remove, insert: '' },
    selection: { anchor: Math.max(line.from, from - remove) },
    userEvent: 'delete.dedent',
  })
  return true
}

/** Enter: 리스트 항목 연속 생성 / 빈 항목이면 리스트 탈출 */
export function mdContinueList(view: EditorView): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  if (from !== to) return false
  const line = state.doc.lineAt(from)
  const m = line.text.match(/^(\s*)([-*+]|\d+\.)( \[[ xX]\])? (.*)$/)
  if (!m) return false
  const [, indent, marker, checkbox = '', content] = m

  // 빈 항목 + 커서가 줄 끝 → 리스트 탈출 (불릿 프리픽스 제거)
  if (!content.trim() && from === line.to) {
    const prefixLen = indent.length + marker.length + checkbox.length + 1
    view.dispatch({
      changes: { from: line.from, to: line.from + prefixLen, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'input',
    })
    return true
  }

  // 커서가 줄 중간이면 기본 Enter 처리로 위임
  if (from < line.to) return false

  // 번호 목록: 같은 인덴트 레벨의 다음 번호
  let nextMarker = marker
  const numMatch = marker.match(/^(\d+)\.$/)
  if (numMatch) {
    const prev = prevNumAtIndent(state, line.number, indent.length)
    const base = prev > 0 ? prev : parseInt(numMatch[1])
    nextMarker = `${base + 1}.`
  }

  // 체크박스: 새 항목은 미완료로
  const nextCheckbox = checkbox ? ' [ ]' : ''
  const newLine = `\n${indent}${nextMarker}${nextCheckbox} `

  view.dispatch({
    changes: { from, insert: newLine },
    selection: { anchor: from + newLine.length },
    userEvent: 'input',
  })
  return true
}

/** Ctrl+B / Ctrl+I: 인라인 마크 토글 (** 또는 *) */
export function mdToggleMark(view: EditorView, mark: string): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  const mlen = mark.length

  if (from === to) {
    // 선택 없음: 마크 쌍 삽입 후 커서를 가운데
    view.dispatch({
      changes: { from, insert: mark + mark },
      selection: { anchor: from + mlen },
      userEvent: 'input',
    })
    return true
  }

  // 이미 감싸져 있으면 제거
  const before = state.doc.sliceString(from - mlen, from)
  const after  = state.doc.sliceString(to, to + mlen)
  if (before === mark && after === mark) {
    view.dispatch({
      changes: [
        { from: from - mlen, to: from, insert: '' },
        { from: to, to: to + mlen, insert: '' },
      ],
      selection: { anchor: from - mlen, head: to - mlen },
      userEvent: 'delete',
    })
  } else {
    view.dispatch({
      changes: [{ from, insert: mark }, { from: to, insert: mark }],
      selection: { anchor: from + mlen, head: to + mlen },
      userEvent: 'input',
    })
  }
  return true
}

/** Enter: 인용구(>) 연속 생성 / 빈 항목이면 인용구 탈출 */
export function mdContinueBlockquote(view: EditorView): boolean {
  const { state } = view
  const { from, to } = state.selection.main
  if (from !== to) return false
  const line = state.doc.lineAt(from)
  // `> ` 또는 `>> ` 등 중첩 인용구 패턴
  const m = line.text.match(/^((?:> ?)+)(.*)$/)
  if (!m) return false
  const [, prefix, content] = m

  // 빈 항목 + 커서 줄 끝 → 인용구 탈출 (프리픽스 제거)
  if (!content.trim() && from === line.to) {
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '' },
      selection: { anchor: line.from },
      userEvent: 'input',
    })
    return true
  }

  // 커서가 줄 중간이면 기본 Enter 처리로 위임
  if (from < line.to) return false

  const newLine = `\n${prefix}`
  view.dispatch({
    changes: { from, insert: newLine },
    selection: { anchor: from + newLine.length },
    userEvent: 'input',
  })
  return true
}
