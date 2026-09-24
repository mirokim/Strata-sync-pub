import { copyFile } from 'node:fs/promises'
// docs/ is the source; ship the standalone guide with both web and desktop builds.
await copyFile(new URL('../docs/manual.html', import.meta.url), new URL('../public/manual.html', import.meta.url))
