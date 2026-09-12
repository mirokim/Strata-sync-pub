import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  assetsInclude: ['**/*.wasm'],
  base: './',
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
      // 볼트 폴더 변경 시 Vite HMR 리로드 방지 (personas.md 저장 → 무한 재로드 루프 차단)
      ignored: [
        '**/refined_vault/**',   // 볼트 — vault watcher가 별도 처리
        '**/node_modules/**',
        '**/__pycache__/**',     // Python 컴파일 캐시 (tools 실행 시 생성)
        '**/*.pyc',
        '**/*.txt',              // 스크립트 결과 파일 (audit_result.txt 등)
        '**/logs/**',            // 세션 로그 (Edit Agent 작성)
        '**/cache/**',           // 봇 캐시
        '**/mcp-config.json',    // MCP 설정 파일 — GUI 저장 시 HMR 리로드 방지
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
})
