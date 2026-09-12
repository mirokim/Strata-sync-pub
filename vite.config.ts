import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

/**
 * Web build: the team server is a user-entered URL, so `connect-src` must allow any https origin
 * (plus localhost for `wrangler dev`). The Electron build keeps the strict allowlist in index.html.
 */
function webCsp() {
  return {
    name: 'strata-web-csp',
    transformIndexHtml(html: string) {
      return html.replace(/connect-src [^;]+;/, "connect-src 'self' https: http://127.0.0.1:* http://localhost:*;")
    },
  }
}

// `--mode web` (Vercel build) serves from the site root; Electron loads dist/ over file:// and needs relative URLs.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode === 'web' ? [webCsp()] : [])],
  assetsInclude: ['**/*.wasm'],
  base: mode === 'web' ? '/' : './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Code shared with the MCP server and the Cloudflare Worker (graph core in mcp/src/lint, proposals)
      '@shared': path.resolve(__dirname, './mcp/src'),
    },
  },
  server: {
    port: 5277,
    watch: {
      // Keep vault folder changes from triggering Vite HMR reloads (saving personas.md → infinite reload loop)
      ignored: [
        '**/refined_vault/**',   // the vault — handled by the vault watcher
        '**/node_modules/**',
        '**/__pycache__/**',     // Python bytecode cache (created when tools run)
        '**/*.pyc',
        '**/*.txt',              // script result files (audit_result.txt etc.)
        '**/logs/**',            // session logs (written by the Edit Agent)
        '**/cache/**',           // bot cache
        '**/mcp-config.json',    // MCP config — saving from the GUI must not reload
      ],
    },
  },
  build: {
    outDir: 'dist',
    target: 'chrome120',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-three': ['three'],
          'vendor-d3': ['d3-force', 'd3-force-3d'],
          'vendor-motion': ['framer-motion'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
}))
