/** Original Strata Sync geometry. Rebuild with node scripts/build-brand.mjs.
 * All lettering is vector geometry, not text: no installed fonts or remote assets needed.
 */
import { writeFile, readFile } from 'node:fs/promises'
const out = new URL('../public/', import.meta.url)
// An angular S divided by two horizontal seams: three layers, one continuous idea.
const silhouette = 'M64 8H24L8 24V32L44 48H8V64H48L64 48V40L28 24H64Z'
const proposal01 = `<defs><clipPath id="strata-cut"><path d="${silhouette}"/></clipPath></defs><g clip-path="url(#strata-cut)" fill="#6489ff"><path d="M0 0H72V29H0Z"/><path d="M0 32H72V43H0Z"/><path d="M0 46H72V72H0Z"/></g>`
// Refine the original four strata: preserve its palette, rounded tile and slight tilt.
const layers = mono => `<g transform="translate(0 7.652) skewY(-12)">${['#38bdf8', '#22d3ee', '#34d399', '#60a5fa'].map((color, i) => `<rect x="11" y="${16 + i * 11}" width="50" height="7" rx="1.5" fill="${mono || color}"/>`).join('')}</g>`
const symbol = `<rect width="72" height="72" rx="16" fill="#152033"/>${layers()}`
const glyphs = {
  S: 'M26 0H6L0 6V10L6 16H20L26 22V26L20 32H0',
  T: 'M0 0H28M14 0V32',
  R: 'M0 32V0H19L26 7V12L19 19H0M14 19L28 32',
  A: 'M0 32L14 0L28 32M5 22H23',
  Y: 'M0 0L14 16L28 0M14 16V32',
  N: 'M0 32V0L28 32V0',
  C: 'M27 0H7L0 7V25L7 32H27',
}
let x = 3
const letters = [...'STRATA SYNC'].map(char => {
  if (char === ' ') { x += 16; return '' }
  const path = `<path transform="translate(${x} 4)" d="${glyphs[char]}"/>`
  x += 38
  return path
}).join('')
const wordWidth = x - 7
const word = `<g fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="bevel" stroke-linecap="square">${letters}</g>`
const svg = (box, body, extra = '') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" role="img" aria-label="Strata Sync" ${extra}>${body}</svg>\n`
await writeFile(new URL('strata-sync-original.svg', out), await readFile(new URL('../strata-sync-icon.svg', import.meta.url)))
await writeFile(new URL('strata-sync-symbol-01.svg', out), svg('0 0 72 72', proposal01))
for (const [theme, color] of [['light', '#172033'], ['dark', '#eef2fa']]) {
  await writeFile(new URL(`strata-sync-logo-01-${theme}.svg`, out), svg(`0 0 ${wordWidth + 96} 72`, `${proposal01}<g transform="translate(96 16)" style="color:${color}">${word}</g>`))
}
await writeFile(new URL('strata-sync-symbol-mono.svg', out), svg('0 0 72 72', layers('#172033')))
await writeFile(new URL('strata-sync-icon.svg', out), svg('0 0 72 72', symbol))
await writeFile(new URL('strata-sync-wordmark.svg', out), svg(`0 0 ${wordWidth} 40`, word))
const lockup = color => svg(`0 0 ${wordWidth + 96} 72`, `${symbol}<g transform="translate(96 16)" style="color:${color}">${word}</g>`)
await writeFile(new URL('strata-sync-logo-light.svg', out), lockup('#172033'))
await writeFile(new URL('strata-sync-logo-dark.svg', out), lockup('#eef2fa'))
// Manual stays standalone, including when served from docs/ or shared as a single HTML file.
const manualUrl = new URL('../docs/manual.html', import.meta.url)
let manual = await readFile(manualUrl, 'utf8')
const inline = `<!-- brand:start -->${lockup('var(--ink)').replace('<svg ', '<svg class="brand-signature" ')}<!-- brand:end -->`
if (manual.includes('<!-- brand:start -->')) manual = manual.replace(/<!-- brand:start -->[\s\S]*?<!-- brand:end -->/, inline)
else manual = manual.replace('<header class="masthead">', `<header class="masthead">\n    ${inline}`)
await writeFile(manualUrl, manual)
console.log('Built symbol, vector wordmark, light/dark lockups and inline manual logo.')

// Alternative directions are presentation assets only; the applied identity refines the original.
function lineOf(text, alphabet, advance, weight, round = false) {
  let offset = 4
  const paths = [...text].map(char => {
    if (char === ' ') { offset += advance * 0.55; return '' }
    const node = `<path transform="translate(${offset} 5)" d="${alphabet[char]}"/>`
    offset += advance
    return node
  }).join('')
  return `<g fill="none" stroke="currentColor" stroke-width="${weight}" stroke-linecap="${round ? 'round' : 'square'}" stroke-linejoin="${round ? 'round' : 'bevel'}">${paths}</g>`
}
const strataMark = '<g fill="#ec916f"><path d="M4 24L40 4H76L40 24Z"/><path d="M4 46L40 26H76L40 46Z"/><path d="M4 68L40 48H76L40 68Z"/></g>'
const strataType = `<g transform="translate(108 1) scale(.94 .84)">${lineOf('STRATA', glyphs, 37, 7)}</g><g transform="translate(108 40) scale(.94 .84)">${lineOf('SYNC', glyphs, 60, 7)}</g>`
const dialogueMark = '<g fill="none" stroke="#5fd5b5" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"><path d="M42 10H25C13 10 6 18 6 30V46H23L36 59V46H43"/><path d="M38 70H55C67 70 74 62 74 50V34H57L44 21V34H37"/></g>'
const lower = {
  s: 'M24 12H9Q2 12 2 18Q2 24 12 24H15Q24 24 24 30Q24 36 17 36H2',
  t: 'M10 2V28Q10 36 18 36H24M2 12H24',
  r: 'M3 36V12M3 23Q3 12 15 12H23',
  a: 'M25 36V12H13Q2 12 2 24Q2 36 13 36H25',
  y: 'M2 12V23Q2 32 12 32H24M24 12V35Q24 44 14 44H6',
  n: 'M2 36V12M2 22Q2 12 13 12Q24 12 24 23V36',
  c: 'M25 12H14Q2 12 2 24Q2 36 14 36H25',
}
const dialogueType = `<g transform="translate(103 10) scale(1.12)">${lineOf('strata sync', lower, 33, 4.6, true)}</g>`
const orbitMark = '<g fill="none" stroke="#b6a4ff" stroke-width="7" stroke-linecap="butt"><path d="M65 18A32 32 0 1 0 65 62"/><path d="M58 26A22 22 0 1 0 58 54"/><path d="M50 34A12 12 0 1 0 50 46"/></g><path d="M37 36H77V44H37Z" fill="#b6a4ff"/>'
const orbitType = `<g transform="translate(102 19) scale(.9)">${lineOf('STRATA SYNC', glyphs, 43, 3.2)}</g>`
for (const [id, box, mark, type] of [
  ['02', '0 0 338 80', strataMark, strataType],
  ['03', '0 0 498 80', dialogueMark, dialogueType],
  ['04', '0 0 513 80', orbitMark, orbitType],
]) {
  await writeFile(new URL(`strata-sync-symbol-${id}.svg`, out), svg('0 0 80 80', mark))
  for (const [theme, ink] of [['light', '#172033'], ['dark', '#eef2fa']]) {
    await writeFile(new URL(`strata-sync-logo-${id}-${theme}.svg`, out), svg(box, `${mark}<g style="color:${ink}">${type}</g>`))
  }
}
console.log('Built three additional logo and type directions (02 / 03 / 04).')

// Round three: four distinct metaphors and lettering treatments.
const weaveMark = '<g fill="none" stroke="#55bed9" stroke-width="9" stroke-linecap="square" stroke-linejoin="miter"><path d="M50 23V10H10V50H23M39 50H50V39"/><path d="M30 41V30H70V70H30V57"/></g>'
const weaveType = `<g transform="translate(104 0) scale(1.24 .98)">${lineOf('strata', lower, 33, 6.8, true)}</g><g transform="translate(108 54) scale(.44)">${lineOf('SYNC', glyphs, 132, 4.8)}</g>`
const mergeMark = '<g fill="none" stroke="#f27d96" stroke-width="9" stroke-linecap="round"><path d="M8 12H16C36 12 28 40 48 40H70M8 40H70M8 68H16C36 68 28 40 48 40"/></g><path d="M61 27L75 40L61 53Z" fill="#f27d96"/>'
const mergeType = `<g transform="translate(114 18) skewX(-12) scale(.9 1.04)">${lineOf('STRATA SYNC', glyphs, 37, 6)}</g>`
const bookMark = '<g fill="#d5ad62"><path d="M6 17L25 7V62L6 72Z"/><path d="M31 7L50 17V72L31 62Z"/><path d="M56 17L75 7V62L56 72Z"/></g>'
const serif = {
  S: 'M27 2Q15 -4 4 3Q-3 10 7 16L21 21Q32 28 22 33Q11 37 0 31M27 0V8M0 25V34',
  T: 'M0 6V0H28V6M14 0V34M8 34H20',
  R: 'M0 0H18Q29 0 28 9Q27 18 6 18M6 0V34M1 34H11M16 18L27 34H31',
  A: 'M0 34L14 0L28 34M5 22H23M0 34H7M22 34H30',
  Y: 'M0 0L14 18L28 0M14 18V34M8 34H20M-2 0H7M23 0H30',
  N: 'M3 34V0L27 34V0M-1 34H8M22 0H31',
  C: 'M28 7V0M28 3Q5 -5 2 12Q-3 38 27 31M27 26V34',
}
const bookType = `<g transform="translate(102 16) scale(.91 1.12)">${lineOf('STRATA SYNC', serif, 38, 2.8)}</g>`
const constellationMark = '<g stroke="#8fbd79" stroke-width="5" fill="none" stroke-linejoin="round"><path d="M14 17L63 12L42 40L14 17L18 66L42 40L68 63L18 66M63 12L68 63"/></g><g fill="#8fbd79"><circle cx="14" cy="17" r="7"/><circle cx="63" cy="12" r="7"/><circle cx="18" cy="66" r="7"/><circle cx="68" cy="63" r="7"/><path d="M42 28L54 40L42 52L30 40Z"/></g>'
const constellationType = `<g transform="translate(104 0) scale(.95)">${lineOf('STRATA', glyphs, 39, 4)}</g><g transform="translate(104 42) scale(.95)">${lineOf('SYNC', glyphs, 65, 4)}</g>`
for (const [id, box, mark, type] of [
  ['05', '0 0 366 80', weaveMark, weaveType],
  ['06', '0 0 478 80', mergeMark, mergeType],
  ['07', '0 0 478 80', bookMark, bookType],
  ['08', '0 0 338 80', constellationMark, constellationType],
]) {
  await writeFile(new URL(`strata-sync-symbol-${id}.svg`, out), svg('0 0 80 80', mark))
  for (const [theme, ink] of [['light', '#172033'], ['dark', '#eef2fa']]) {
    await writeFile(new URL(`strata-sync-logo-${id}-${theme}.svg`, out), svg(box, `${mark}<g style="color:${ink}">${type}</g>`))
  }
}
console.log('Built four additional directions (05 WEAVE / 06 MERGE / 07 FOLIO / 08 NEXUS).')
