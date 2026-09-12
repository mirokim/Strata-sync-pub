import { defineConfig } from 'vitest/config'

// Electron main-process modules (.cjs) tested in plain Node (`npm run test:electron` from the root).
export default defineConfig({
  test: { environment: 'node', include: ['**/__tests__/**/*.test.ts'] },
})
