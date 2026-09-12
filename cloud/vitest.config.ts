import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Protocol tests run in plain Node against in-memory stores (`npm run test:cloud` from the root).
// The Cloudflare adapter (index.ts/stores.ts) is exercised by `wrangler dev`.
export default defineConfig({
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./test/stubs/cloudflare-workers.ts', import.meta.url)) } },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Inline the provider so the alias above rewrites its `cloudflare:workers` import
    server: { deps: { inline: ['@cloudflare/workers-oauth-provider'] } },
  },
})
