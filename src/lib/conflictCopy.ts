/**
 * Conflict copies — the one rule every client follows when two people changed the same file:
 * the other version keeps the file name, ours is saved next to it as
 * `<name> (conflict <author> <yyyy-mm-dd hhmm>).md`. Nothing is ever overwritten.
 *
 * Same naming as electron/sync/engine.cjs so copies from the desktop engine, the web adapter
 * and the editor look identical in the vault.
 */

export function conflictName(relPath: string, author: string, when: number): string {
  const slash = relPath.lastIndexOf('/')
  const dot = relPath.lastIndexOf('.')
  const ext = dot > slash ? relPath.slice(dot) : ''
  const base = relPath.slice(0, relPath.length - ext.length)
  const d = new Date(when)
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`
  const who = (author || 'local').replace(/[\\/:*?"<>|]/g, '_')
  return `${base} (conflict ${who} ${stamp})${ext}`
}

/** `name.md` → `name-2.md`; used when a copy for the same minute already exists. */
export function numberedName(relPath: string, n: number): string {
  return relPath.replace(/(\.[^./]*)?$/, `-${n}$1`)
}
