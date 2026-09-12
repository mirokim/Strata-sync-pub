import { defineConfig } from 'vitest/config'

// Run from the repo root: `npm run test:mcp` (uses the root vitest install).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
