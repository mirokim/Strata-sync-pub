import { Buffer } from 'buffer'
// gray-matter uses Buffer.from() internally — polyfill for Vite browser bundle
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = Buffer
}

import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import ErrorBoundary from '@/components/shared/ErrorBoundary'
import './index.css'

// Prevent unhandled promise rejections from crashing the renderer process
window.addEventListener('unhandledrejection', (event) => {
  console.error('[renderer] Unhandled promise rejection:', event.reason)
  event.preventDefault()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
