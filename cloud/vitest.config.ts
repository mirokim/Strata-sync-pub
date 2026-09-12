import { defineConfig } from 'vitest/config'

// Protocol tests run in plain Node against in-memory stores (`npm run test:cloud` from the root).
// The Cloudflare adapter (index.ts/stores.ts) is exercised by `wrangler dev`.
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
