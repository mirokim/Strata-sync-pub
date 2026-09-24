import { cp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
// Windows fallback when `vercel build` cannot spawn cmd.exe. Run build:web first.
const output = new URL('../.vercel/output/', import.meta.url)
const project = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'))
await mkdir(output, { recursive: true })
await cp(new URL('../dist/', import.meta.url), new URL('static/', output), { recursive: true })
await writeFile(new URL('config.json', output), JSON.stringify({
  version: 3,
  routes: [
    ...project.headers.map(rule => ({ src: rule.source, headers: Object.fromEntries(rule.headers.map(h => [h.key, h.value])), continue: true })),
    { handle: 'filesystem' },
    { src: '/(.*)', dest: '/index.html' },
  ],
}, null, 2))
await rm(new URL('builds.json', output), { force: true })
console.log('Prepared static Build Output API deployment from dist/.')
