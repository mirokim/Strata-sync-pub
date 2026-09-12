import { Buffer } from 'buffer'
// gray-matter uses Buffer.from() internally — polyfill for Vite browser bundle
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import WebRoot from '@/web/WebRoot'
import { isWebMode } from '@/web/config'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import './index.css'

// Electron: the preload bridge provides window.vaultAPI. Browser (Vercel): WebRoot connects to the
// Cloudflare Worker and provides the same API over HTTP.
const Root = isWebMode() ? WebRoot : App

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Root />
    </ErrorBoundary>
  </React.StrictMode>
)
