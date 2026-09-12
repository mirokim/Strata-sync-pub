/**
 * Graph3D perf harness — mounts the 3D graph alone with a synthetic vault-sized graph, no server.
 *
 *   npx vite --port 4189           then open  http://localhost:4189/perf/graph3d.html?n=5600&m=80000
 *
 * ?n   node count (default 5600)      ?m   link count (default 80000)
 * ?labels=0  start with labels hidden ?seed  PRNG seed
 * The HUD (and window.__perf) reports frames per second, averaged every second.
 */
import { Buffer } from 'buffer'
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = Buffer

import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import Graph3D from '@/components/graph/Graph3D'
import { useGraphStore } from '@/stores/graphStore'
import { useSettingsStore } from '@/stores/settingsStore'
import type { GraphLink, GraphNode } from '@/types'
import { SPEAKER_CONFIG } from '@/lib/speakerConfig'
import '@/index.css'

const q = new URLSearchParams(location.search)
const N = Number(q.get('n') ?? 5600)
const M = Number(q.get('m') ?? 80000)
let seed = Number(q.get('seed') ?? 7) >>> 0
const rng = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }

const SPEAKERS = Object.keys(SPEAKER_CONFIG) as GraphNode['speaker'][]
const FOLDERS = ['결정 기록', '회의록', '이슈', '제품', '테스트', '사용자 리서치']

// Preferential attachment: a few hubs with thousands of links, a long tail of leaves — like a real vault
const nodes: GraphNode[] = Array.from({ length: N }, (_, i) => ({
  id: `doc-${i}`, docId: `doc-${i}`, speaker: SPEAKERS[i % SPEAKERS.length],
  label: `${FOLDERS[i % FOLDERS.length]} 문서 ${i}`, folderPath: FOLDERS[i % FOLDERS.length], tags: [FOLDERS[i % FOLDERS.length]],
}))
const links: GraphLink[] = []
const seen = new Set<string>()
const targets: number[] = [0]
while (links.length < M && N > 1) {
  const a = Math.floor(rng() * N)
  const b = rng() < 0.7 ? targets[Math.floor(rng() * targets.length)] : Math.floor(rng() * N)
  if (a === b) continue
  const k = a < b ? `${a}|${b}` : `${b}|${a}`
  if (seen.has(k)) continue
  seen.add(k); targets.push(a, b)
  links.push({ source: `doc-${a}`, target: `doc-${b}`, strength: 0.3 + rng() * 0.7 })
}
useGraphStore.getState().setGraph(nodes, links)
if (q.get('labels') === '0') useSettingsStore.setState({ showNodeLabels: false })

declare global { interface Window { __graph3dPerf?: boolean; __graphStore: typeof useGraphStore; __perf: { fps: number; frames: number; nodes: number; links: number; labels: number } } }
window.__graph3dPerf = true
window.__graphStore = useGraphStore
window.__perf = { fps: 0, frames: 0, nodes: N, links: links.length, labels: 0 }

function Harness() {
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight })
    window.addEventListener('resize', onResize)
    let frames = 0, last = performance.now(), raf = 0
    const hud = document.getElementById('hud')!
    const loop = (t: number) => {
      frames++
      if (t - last >= 1000) {
        window.__perf.fps = Math.round(frames * 1000 / (t - last)); window.__perf.frames += frames
        window.__perf.labels = document.querySelectorAll('#root div[style*="translate"]').length
        hud.textContent = `nodes ${N} · links ${links.length}\nfps ${window.__perf.fps} · visible labels ${window.__perf.labels}`
        frames = 0; last = t
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => { window.removeEventListener('resize', onResize); cancelAnimationFrame(raf) }
  }, [])
  return <Graph3D width={size.w} height={size.h} />
}

ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />)
