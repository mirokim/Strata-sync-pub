import { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import { useGraphStore } from '@/stores/graphStore'
import { useUIStore } from '@/stores/uiStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useVaultStore } from '@/stores/vaultStore'
import { parseVaultFiles } from '@/lib/markdownParser'
import { buildGraph } from '@/lib/graphBuilder'
import type { LoadedDocument } from '@/types'
import { useGraphSimulation3D, type SimNode3D, type SimLink3D } from '@/hooks/useGraphSimulation3D'
import { graphCallbacks } from '@/lib/graphEvents'
import { SPEAKER_CONFIG } from '@/lib/speakerConfig'
import { buildNodeColorMap, getNodeColor, lightenColor, degreeScaleFactor, degreeSize, DEGREE_LIGHT_MAX } from '@/lib/nodeColors'
import { useActivityHeat } from '@/hooks/useActivityHeat'
import type { GraphLink } from '@/types'
import NodeTooltip from './NodeTooltip'
import { sphereSegmentsFor, chooseLabelledNodes, nextQualityLevel, strongestEdgeMask, edgeSubsetIndex, QUALITY_MAX } from '@/lib/graph3dQuality'
import { useT } from '@/i18n'

interface Props {
  width: number
  height: number
}

const NODE_RADIUS = 4
const RING_SEGMENTS = 32
const EDGE_DEF_R = 0x44 / 0xff
const EDGE_DEF_G = 0x44 / 0xff
const EDGE_DEF_B = 0x44 / 0xff
// Labels are DOM elements (CSS2D). One per node was fine for a few hundred documents, but a
// 5,000-node vault meant 5,000 text-shadowed divs repositioned every frame — the graph crawled.
// Now a fixed pool is shared: on a big graph the labels go to the hubs and the nodes nearest the
// camera, reassigned a few times a second; a small graph still labels every node.
const LABEL_POOL_MAX = 160
const LABEL_REASSIGN_MS = 120
// Above this size the scene is updated on every second simulation tick (the layout still runs at
// full speed, the GPU upload and render just happen at ~30 fps) and spheres use fewer segments.
const BIG_GRAPH_NODES = 2000
// Adaptive quality (see nextQualityLevel): the loop measures the interval between consecutively
// rendered frames; a slow median steps the level down. Big graphs start one step down (pixel ratio 1).
const QUALITY_WINDOW_FRAMES = 60
const QUALITY_SLOW_MS = 24
const EDGE_FRACTION_REDUCED = 0.5
// Opt-in timing (perf/graph3d.html sets window.__graph3dPerf): performance.measure entries
// 'graph3d.tick' / 'graph3d.render' / 'graph3d.labels' so a profiler-less run can still be read.
const perfOn = () => (globalThis as { __graph3dPerf?: boolean }).__graph3dPerf === true
const perfMeasure = (name: string, start: number) => { if (perfOn()) performance.measure(name, { start, end: performance.now() }) }

interface NodeInstanceData {
  iMesh: THREE.InstancedMesh
  idx: number
  scaledRadius: number
  degreeScale: number
  baseColor: THREE.Color
  docId: string
  pos: THREE.Vector3
  deg: number
}

interface PooledLabel {
  obj: CSS2DObject
  div: HTMLElement
  nodeId: string | null
}

export default function Graph3D({ width, height }: Props) {
  const t = useT()
  const mountRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const css2dRendererRef = useRef<CSS2DRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)

  // InstancedMesh: 500+ draw calls → 2 draw calls
  const sphereInstancedRef = useRef<THREE.InstancedMesh | null>(null)
  const octaInstancedRef = useRef<THREE.InstancedMesh | null>(null)
  const sphereNodeIds = useRef<string[]>([])  // instance index → nodeId
  const octaNodeIds = useRef<string[]>([])
  const nodeDataRef = useRef<Map<string, NodeInstanceData>>(new Map())
  const dummyRef = useRef(new THREE.Object3D())
  // Raycasting array: 2 InstancedMesh objects instead of 500+ Mesh objects
  const instancedMeshArrayRef = useRef<THREE.InstancedMesh[]>([])

  const lineGeoRef = useRef<THREE.BufferGeometry | null>(null)
  const linePosRef = useRef<Float32Array | null>(null)
  const lineColorArrayRef = useRef<Float32Array | null>(null)
  const lineColorAttrRef = useRef<THREE.BufferAttribute | null>(null)
  const lineMatRef = useRef<THREE.LineBasicMaterial | null>(null)
  const rafRef = useRef<number>(0)
  const selRingRef = useRef<THREE.Line | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const particlePosRef = useRef<Float32Array | null>(null)
  const particleOffsets = useRef<Float32Array | null>(null)
  const tickRef = useRef(0)
  const raycasterRef = useRef(new THREE.Raycaster())
  const aiHighlightRef = useRef<Set<string>>(new Set())
  const prevAiHighlightRef = useRef<Set<string>>(new Set())
  const labelPoolRef = useRef<PooledLabel[]>([])
  const labelByNodeRef = useRef<Map<string, PooledLabel>>(new Map())
  const labelGroupRef = useRef<THREE.Group | null>(null)
  const labelAssignDueRef = useRef(true)
  const lastLabelAssignRef = useRef(0)
  const maxDegRef = useRef(0)
  const simTickCountRef = useRef(0)
  const qualityRef = useRef(0)
  const frameIntervalsRef = useRef<number[]>([])
  const lastRenderTsRef = useRef(0)
  const applyEdgeBudgetRef = useRef<(() => void) | null>(null)
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const renderBudgetRef = useRef(0)
  const prevNodeCountRef = useRef(0)
  const prevLinkCountRef = useRef(0)

  const draggingNodeIdRef = useRef<string | null>(null)
  const draggingSimNodeRef = useRef<SimNode3D | null>(null)  // cached ref avoids O(n) find per drag frame
  const dragPlaneRef = useRef<THREE.Plane>(new THREE.Plane())
  const isDraggingRef = useRef(false)
  const mouseDownPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  // click event guard: prevent selection when a node was dragged
  const nodeWasDraggedRef = useRef(false)  // set when isDragging crosses threshold, cleared by click handler
  const lastHoveredRef = useRef<string | null>(null)
  const adjacencyRef = useRef<Map<string, Set<number>>>(new Map())
  const rafScheduledRef = useRef(false)
  const pendingMousePosRef = useRef<{ x: number; y: number } | null>(null)
  interface HoverState { neighborIds: Set<string>; neighborLinkIdxs: Set<number> }
  const prevHoverStateRef = useRef<HoverState | null>(null)
  const showNodeLabelsRef = useRef(false)

  const { nodes, links, selectedNodeId, hoveredNodeId, focusNodeId, setFocusNode, setSelectedNode, setHoveredNode, setNodes, setLinks, physics, aiHighlightNodeIds, setGraphLayoutReady, setSimPositions } = useGraphStore(
    useShallow(s => ({
      nodes: s.nodes,
      links: s.links,
      selectedNodeId: s.selectedNodeId,
      hoveredNodeId: s.hoveredNodeId,
      focusNodeId: s.focusNodeId,
      setFocusNode: s.setFocusNode,
      setSelectedNode: s.setSelectedNode,
      setHoveredNode: s.setHoveredNode,
      setNodes: s.setNodes,
      setLinks: s.setLinks,
      physics: s.physics,
      aiHighlightNodeIds: s.aiHighlightNodeIds,
      setGraphLayoutReady: s.setGraphLayoutReady,
      setSimPositions: s.setSimPositions,
    }))
  )
  const simPosThrottleRef = useRef(0)
  const { setSelectedDoc, setCenterTab, centerTab, nodeColorMode, openInEditor } = useUIStore()
  const { vaultPath, loadedDocuments, setLoadedDocuments } = useVaultStore()
  const showNodeLabels = useSettingsStore(s => s.showNodeLabels)
  const isFast = useSettingsStore(s => s.paragraphRenderQuality === 'fast')
  const isFastRef = useRef(isFast)
  isFastRef.current = isFast
  showNodeLabelsRef.current = showNodeLabels
  const tagColors = useSettingsStore(s => s.tagColors)
  const folderColors = useSettingsStore(s => s.folderColors)

  const heat = useActivityHeat()
  const nodeColorMap = useMemo(
    () => buildNodeColorMap(nodes, nodeColorMode, tagColors, folderColors, heat),
    [nodes, nodeColorMode, tagColors, folderColors, heat]
  )
  const selectedNodeIdRef = useRef(selectedNodeId)
  selectedNodeIdRef.current = selectedNodeId
  const nodeRadiusRef = useRef(physics.nodeRadius)
  nodeRadiusRef.current = physics.nodeRadius

  const [tooltip, setTooltip] = useState<{ nodeId: string; x: number; y: number } | null>(null)

  // ── Update node colors when color mode changes ────────────────────────────
  useEffect(() => {
    const dataMap = nodeDataRef.current
    let sphereDirty = false, octaDirty = false
    nodes.forEach(node => {
      const data = dataMap.get(node.id)
      if (!data) return
      const baseColor = getNodeColor(node, nodeColorMode, nodeColorMap)
      const lightFactor = nodeColorMode === 'heat' ? 0 : (1 - data.degreeScale) * DEGREE_LIGHT_MAX
      data.baseColor.set(lightFactor > 0.01 ? lightenColor(baseColor, lightFactor) : baseColor)
      data.iMesh.setColorAt(data.idx, data.baseColor)
      if (data.iMesh === sphereInstancedRef.current) sphereDirty = true
      else octaDirty = true
    })
    if (sphereDirty && sphereInstancedRef.current?.instanceColor) sphereInstancedRef.current.instanceColor.needsUpdate = true
    if (octaDirty && octaInstancedRef.current?.instanceColor) octaInstancedRef.current.instanceColor.needsUpdate = true
    renderBudgetRef.current = Math.max(renderBudgetRef.current, 3)
  }, [nodes, nodeColorMode, nodeColorMap])

  // ── Sync adjacencyRef from store ──────────────────────────────────────────
  const adjacencyByIndex = useGraphStore(s => s.adjacencyByIndex)
  useEffect(() => { adjacencyRef.current = adjacencyByIndex }, [adjacencyByIndex])

  // ── Tick: update instance matrices + edge lines ───────────────────────────
  const handleTick = useCallback((simNodes: SimNode3D[], simLinks: SimLink3D[]) => {
    const dataMap = nodeDataRef.current
    const dummy = dummyRef.current
    let sphereDirty = false, octaDirty = false

    // Big graph: upload positions to the GPU every other tick — the simulation keeps its pace,
    // the render loop just sees ~30 updates a second instead of 60
    simTickCountRef.current++
    if (simNodes.length > BIG_GRAPH_NODES && simTickCountRef.current % 2 === 1) return
    labelAssignDueRef.current = true
    const tickStart = perfOn() ? performance.now() : 0

    // Throttle simPositions updates to ~2s to avoid store churn
    const now = Date.now()
    if (now - simPosThrottleRef.current > 2000) {
      simPosThrottleRef.current = now
      const pos: Record<string, { x: number; y: number }> = {}
      for (const n of simNodes) pos[n.id] = { x: n.x ?? 0, y: n.y ?? 0 }
      setSimPositions(pos)
    }

    for (const n of simNodes) {
      const data = dataMap.get(n.id)
      if (!data) continue
      const x = n.x ?? 0, y = n.y ?? 0, z = n.z ?? 0
      data.pos.set(x, y, z)
      dummy.position.set(x, y, z)
      dummy.scale.setScalar(data.scaledRadius)
      dummy.updateMatrix()
      data.iMesh.setMatrixAt(data.idx, dummy.matrix)
      if (data.iMesh === sphereInstancedRef.current) sphereDirty = true
      else octaDirty = true
    }
    // Only the labelled nodes have a DOM element to move
    for (const label of labelPoolRef.current) {
      if (!label.nodeId) continue
      const data = dataMap.get(label.nodeId)
      if (data) label.obj.position.set(data.pos.x, data.pos.y - NODE_RADIUS - 6, data.pos.z)
    }
    if (sphereDirty && sphereInstancedRef.current) {
      sphereInstancedRef.current.instanceMatrix.needsUpdate = true
      sphereInstancedRef.current.boundingSphere = null  // Invalidate cached boundingSphere → ensures raycast accuracy
    }
    if (octaDirty && octaInstancedRef.current) {
      octaInstancedRef.current.instanceMatrix.needsUpdate = true
      octaInstancedRef.current.boundingSphere = null
    }

    const pos = linePosRef.current
    if (pos) {
      simLinks.forEach((link, i) => {
        const src = link.source as SimNode3D
        const tgt = link.target as SimNode3D
        const base = i * 6
        pos[base + 0] = src.x ?? 0; pos[base + 1] = src.y ?? 0; pos[base + 2] = src.z ?? 0
        pos[base + 3] = tgt.x ?? 0; pos[base + 4] = tgt.y ?? 0; pos[base + 5] = tgt.z ?? 0
      })
      if (lineGeoRef.current) {
        const attr = lineGeoRef.current.getAttribute('position') as THREE.BufferAttribute
        attr.needsUpdate = true
      }
    }

    const selId = selectedNodeIdRef.current
    if (selId && selRingRef.current) {
      const data = dataMap.get(selId)
      if (data) {
        selRingRef.current.position.copy(data.pos)
        if (particlesRef.current) particlesRef.current.position.copy(data.pos)
      }
    }
    renderBudgetRef.current = Math.max(renderBudgetRef.current, 3)
    perfMeasure('graph3d.tick', tickStart)
  }, [])

  const { simRef, simNodesRef } = useGraphSimulation3D({ onTick: handleTick })

  // ── Three.js scene setup ───────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const dpr = window.devicePixelRatio
    const renderer = new THREE.WebGLRenderer({ antialias: dpr <= 1, alpha: true })
    // A big graph starts at quality level 1 (pixel ratio 1): on a HiDPI laptop the 1.5× buffer alone
    // more than doubles the fragments spent on tens of thousands of edges
    qualityRef.current = nodes.length > BIG_GRAPH_NODES ? 1 : 0
    frameIntervalsRef.current = []
    lastRenderTsRef.current = 0
    renderer.setPixelRatio(Math.min(dpr, qualityRef.current >= 1 ? 1 : 1.5))
    renderer.setSize(width, height)
    renderer.setClearColor(0x000000, 0)
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // WebGL context loss recovery: stop RAF, then reload to reinitialize GPU state
    const onContextLost = (e: Event) => {
      e.preventDefault()
      cancelAnimationFrame(rafRef.current)
      console.warn('[Graph3D] WebGL context lost — stopping render loop')
    }
    const onContextRestored = () => {
      console.log('[Graph3D] WebGL context restored — reloading')
      window.location.reload()
    }
    renderer.domElement.addEventListener('webglcontextlost', onContextLost)
    renderer.domElement.addEventListener('webglcontextrestored', onContextRestored)

    const css2dRenderer = new CSS2DRenderer()
    css2dRenderer.setSize(width, height)
    css2dRenderer.domElement.style.position = 'absolute'
    css2dRenderer.domElement.style.top = '0'
    css2dRenderer.domElement.style.left = '0'
    css2dRenderer.domElement.style.pointerEvents = 'none'
    mount.appendChild(css2dRenderer.domElement)
    css2dRendererRef.current = css2dRenderer

    const scene = new THREE.Scene()
    sceneRef.current = scene
    // Lit scene: a hemisphere fill plus a key light so the instanced spheres shade like spheres
    // instead of flat discs; light fog pushes far clusters back so the layout reads in depth.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a35, 1.15))
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4)
    keyLight.position.set(1, 1.2, 1.6)
    scene.add(keyLight)
    scene.fog = new THREE.Fog(0x000000, 700, 2600)

    const camera = new THREE.PerspectiveCamera(60, width / height, 1, 5000)
    camera.position.set(0, 0, Math.max(300, Math.sqrt(nodes.length) * 30))
    cameraRef.current = camera

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.autoRotate = true
    controls.autoRotateSpeed = 0.4
    const onInteractStart = () => {
      controls.autoRotate = false
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    }
    const onInteractEnd = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = setTimeout(() => { controls.autoRotate = true }, 10_000)
    }
    controls.addEventListener('start', onInteractStart)
    controls.addEventListener('end', onInteractEnd)
    const onControlsChange = () => {
      renderBudgetRef.current = Math.max(renderBudgetRef.current, 10)
      labelAssignDueRef.current = true   // a moved camera changes which nodes are nearest
    }
    controls.addEventListener('change', onControlsChange)
    controlsRef.current = controls

    const fitCameraToNodes = () => {
      const dataMap = nodeDataRef.current
      if (dataMap.size === 0) return
      let minX = Infinity, maxX = -Infinity
      let minY = Infinity, maxY = -Infinity
      let minZ = Infinity, maxZ = -Infinity
      dataMap.forEach(data => {
        minX = Math.min(minX, data.pos.x); maxX = Math.max(maxX, data.pos.x)
        minY = Math.min(minY, data.pos.y); maxY = Math.max(maxY, data.pos.y)
        minZ = Math.min(minZ, data.pos.z); maxZ = Math.max(maxZ, data.pos.z)
      })
      const cx = (minX + maxX) / 2
      const cy = (minY + maxY) / 2
      const cz = (minZ + maxZ) / 2
      const spread = Math.max(maxX - minX, maxY - minY, maxZ - minZ)
      const fovRad = (camera.fov * Math.PI) / 180
      const dist = Math.max(70, (spread * 0.45) / Math.tan(fovRad / 2))
      controls.target.set(cx, cy, cz)
      camera.position.set(cx, cy, cz + dist)
      controls.update()
    }
    graphCallbacks.resetCamera = fitCameraToNodes

    const { degreeMap: degMap, maxDegree: maxDeg3D } = useGraphStore.getState()
    maxDegRef.current = maxDeg3D

    // ── Shared geometries ────────────────────────────────────────────────────
    // One shared geometry for every instance; the tessellation drops as the graph grows so a
    // 5,000-node vault does not push millions of triangles per frame
    const [sphereW, sphereH] = sphereSegmentsFor(nodes.length)
    const sphereGeo = new THREE.SphereGeometry(NODE_RADIUS, sphereW, sphereH)
    const octaGeo = new THREE.OctahedronGeometry(NODE_RADIUS * 1.25)

    const sphereNodes = nodes.filter(n => !n.isImage)
    const octaNodes = nodes.filter(n => !!n.isImage)

    // ── InstancedMesh: one draw call per geometry type ───────────────────────
    // Lambert responds to the lights above and still takes per-instance colours (instanceColor)
    const sphereMat = new THREE.MeshLambertMaterial({ emissive: 0xffffff, emissiveIntensity: 0.12 })
    const octaMat = new THREE.MeshLambertMaterial({ emissive: 0xffffff, emissiveIntensity: 0.12 })
    const sphereInstanced = new THREE.InstancedMesh(sphereGeo, sphereMat, Math.max(1, sphereNodes.length))
    const octaInstanced = new THREE.InstancedMesh(octaGeo, octaMat, Math.max(1, octaNodes.length))
    sphereInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    octaInstanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    sphereInstanced.frustumCulled = false
    octaInstanced.frustumCulled = false
    scene.add(sphereInstanced)
    if (octaNodes.length > 0) scene.add(octaInstanced)
    sphereInstancedRef.current = sphereInstanced
    octaInstancedRef.current = octaInstanced
    sphereNodeIds.current = sphereNodes.map(n => n.id)
    octaNodeIds.current = octaNodes.map(n => n.id)

    // ── Per-node setup: matrix, color, label ─────────────────────────────────
    const dummy = dummyRef.current
    const newDataMap = new Map<string, NodeInstanceData>()

    const setupNode = (node: (typeof nodes)[0], iMesh: THREE.InstancedMesh, idx: number) => {
      const color = getNodeColor(node, nodeColorMode, nodeColorMap)
      const deg = degMap.get(node.id) ?? 0
      const sf = degreeScaleFactor(deg, maxDeg3D)
      const baseScale = nodeRadiusRef.current / 7
      const scaledRadius = baseScale * degreeSize(sf)
      const lightFactor = nodeColorMode === 'heat' ? 0 : (1 - sf) * DEGREE_LIGHT_MAX
      const baseColor = new THREE.Color(lightFactor > 0.01 ? lightenColor(color, lightFactor) : color)

      dummy.position.set(0, 0, 0)
      dummy.scale.setScalar(scaledRadius)
      dummy.updateMatrix()
      iMesh.setMatrixAt(idx, dummy.matrix)
      iMesh.setColorAt(idx, baseColor)

      newDataMap.set(node.id, {
        iMesh,
        idx,
        scaledRadius,
        degreeScale: sf,
        baseColor,
        docId: node.docId ?? node.id,
        pos: new THREE.Vector3(0, 0, 0),
        deg,
      })
    }

    // ── Label pool: a bounded set of DOM labels shared by all nodes ──────────
    // Assigned in assignLabels() (animation loop) — every node when the graph is small, otherwise
    // hubs and the nodes in front of the camera. Hidden pool entries cost nothing to render.
    const labelGroup = new THREE.Group()
    const poolSize = Math.min(nodes.length, LABEL_POOL_MAX)
    const pool: PooledLabel[] = []
    for (let i = 0; i < poolSize; i++) {
      const div = document.createElement('div')
      div.style.color = '#e3e2de'
      div.style.pointerEvents = 'none'
      div.style.whiteSpace = 'nowrap'
      div.style.textShadow = '0 0 6px #000, 0 0 4px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000'
      div.style.userSelect = 'none'
      div.style.letterSpacing = '0.01em'
      const obj = new CSS2DObject(div)
      obj.visible = false
      labelGroup.add(obj)
      pool.push({ obj, div, nodeId: null })
    }
    scene.add(labelGroup)
    labelGroupRef.current = labelGroup
    labelPoolRef.current = pool
    labelByNodeRef.current = new Map()
    labelAssignDueRef.current = true

    sphereNodes.forEach((node, idx) => setupNode(node, sphereInstanced, idx))
    octaNodes.forEach((node, idx) => setupNode(node, octaInstanced, idx))

    sphereInstanced.instanceMatrix.needsUpdate = true
    if (sphereInstanced.instanceColor) sphereInstanced.instanceColor.needsUpdate = true
    if (octaNodes.length > 0) {
      octaInstanced.instanceMatrix.needsUpdate = true
      if (octaInstanced.instanceColor) octaInstanced.instanceColor.needsUpdate = true
    }
    nodeDataRef.current = newDataMap
    instancedMeshArrayRef.current = octaNodes.length > 0
      ? [sphereInstanced, octaInstanced]
      : [sphereInstanced]

    // ── Edges ────────────────────────────────────────────────────────────────
    const posArray = new Float32Array(links.length * 6)
    linePosRef.current = posArray
    const colorArray = new Float32Array(links.length * 6)
    for (let i = 0; i < links.length; i++) {
      // strength [0.15, 1.0] → brightness: weak links darker, strong links brighter
      const s = (links[i] as GraphLink).strength ?? 0.5
      const brightness = EDGE_DEF_R * (0.5 + s * 2.0)
      for (let v = 0; v < 2; v++) {
        const base = i * 6 + v * 3
        colorArray[base + 0] = brightness
        colorArray[base + 1] = brightness
        colorArray[base + 2] = brightness
      }
    }
    lineColorArrayRef.current = colorArray
    const lineGeo = new THREE.BufferGeometry()
    lineGeo.setAttribute('position', new THREE.BufferAttribute(posArray, 3))
    const colorAttr = new THREE.BufferAttribute(colorArray, 3)
    lineGeo.setAttribute('color', colorAttr)
    lineColorAttrRef.current = colorAttr
    lineGeoRef.current = lineGeo
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: physics.linkOpacity })
    lineMatRef.current = lineMat
    const lineSegments = new THREE.LineSegments(lineGeo, lineMat)
    lineSegments.frustumCulled = false
    scene.add(lineSegments)

    // ── Edge budget (quality level ≥ 2): draw the strongest half of the edges plus the hovered
    // node's neighbourhood. Positions are still updated for every link; only the index changes.
    let edgeMask: Uint8Array | null = null      // built on first use (an 80k-link sort, once)
    let edgeIndexApplied = false
    const applyEdgeBudget = () => {
      if (qualityRef.current < 2) {
        if (edgeIndexApplied) { lineGeo.setIndex(null); edgeIndexApplied = false }
        return
      }
      edgeMask ??= strongestEdgeMask(Float32Array.from(links, l => (l as GraphLink).strength ?? 0.5), EDGE_FRACTION_REDUCED)
      const hovered = lastHoveredRef.current
      const keep = hovered ? adjacencyRef.current.get(hovered) : undefined
      lineGeo.setIndex(new THREE.BufferAttribute(edgeSubsetIndex(edgeMask, keep), 1))
      edgeIndexApplied = true
      renderBudgetRef.current = Math.max(renderBudgetRef.current, 2)
    }
    applyEdgeBudgetRef.current = applyEdgeBudget

    // perf/graph3d.html can pin a starting level (window.__graph3dQualityStart) to inspect each one
    const startLevel = perfOn() ? Number((globalThis as { __graph3dQualityStart?: number }).__graph3dQualityStart) : NaN
    if (Number.isInteger(startLevel) && startLevel >= 0 && startLevel <= QUALITY_MAX) {
      qualityRef.current = startLevel
      renderer.setPixelRatio(Math.min(dpr, startLevel >= 1 ? 1 : 1.5))
      applyEdgeBudget()
    }

    const stepDownQuality = () => {
      if (qualityRef.current >= QUALITY_MAX) return
      qualityRef.current++
      if (qualityRef.current === 1) renderer.setPixelRatio(1)
      if (qualityRef.current === 2) applyEdgeBudget()
      console.info(`[Graph3D] frame time high — quality level ${qualityRef.current} (${['full', 'pixel ratio 1', 'half the edges', 'auto-rotate at half rate'][qualityRef.current]})`)
    }

    // ── Selection ring ────────────────────────────────────────────────────────
    const ringPoints: THREE.Vector3[] = []
    for (let i = 0; i <= RING_SEGMENTS; i++) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2
      ringPoints.push(new THREE.Vector3(Math.cos(angle) * 12, Math.sin(angle) * 12, 0))
    }
    const ringGeo = new THREE.BufferGeometry().setFromPoints(ringPoints)
    const ringMat = new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 3, gapSize: 2 })
    const ring = new THREE.Line(ringGeo, ringMat)
    ring.computeLineDistances()
    ring.visible = false
    scene.add(ring)
    selRingRef.current = ring

    // ── Particles ─────────────────────────────────────────────────────────────
    const PARTICLE_COUNT = 20
    const pPos = new Float32Array(PARTICLE_COUNT * 3)
    const offsets = new Float32Array(PARTICLE_COUNT * 3)
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const theta = Math.random() * Math.PI * 2
      const phi = Math.random() * Math.PI
      const r = 12 + Math.random() * 8
      offsets[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta)
      offsets[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta)
      offsets[i * 3 + 2] = r * Math.cos(phi)
    }
    particlePosRef.current = pPos
    particleOffsets.current = offsets
    const pGeo = new THREE.BufferGeometry()
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3))
    const pMat = new THREE.PointsMaterial({ color: 0xffffff, size: 2 })
    const pts = new THREE.Points(pGeo, pMat)
    pts.visible = false
    scene.add(pts)
    particlesRef.current = pts

    // ── Label assignment ──────────────────────────────────────────────────────
    const labelTextById = new Map(nodes.map(n => [n.id, n.label]))
    const camForward = new THREE.Vector3()
    const assignLabels = () => {
      labelAssignDueRef.current = false
      lastLabelAssignRef.current = performance.now()
      const dataMap = nodeDataRef.current
      const byNode = labelByNodeRef.current
      const pool = labelPoolRef.current
      if (pool.length === 0) return

      // Hovered, selected and AI-highlighted nodes are always labelled (when they are in the graph)
      const pinned = [lastHoveredRef.current, selectedNodeIdRef.current, ...aiHighlightRef.current].filter((id): id is string => !!id && dataMap.has(id))
      let chosen: string[]
      if (showNodeLabelsRef.current) {
        camera.getWorldDirection(camForward)
        const candidates: { id: string; deg: number; x: number; y: number; z: number }[] = []
        dataMap.forEach((d, id) => candidates.push({ id, deg: d.deg, x: d.pos.x, y: d.pos.y, z: d.pos.z }))
        chosen = chooseLabelledNodes(candidates, pool.length, { position: camera.position, forward: camForward }, pinned)
      } else {
        chosen = pinned.slice(0, pool.length)
      }
      const chosenSet = new Set(chosen)

      // Keep labels that stay chosen where they are; free the rest, then hand free entries out
      const free: PooledLabel[] = []
      for (const label of pool) {
        if (label.nodeId && chosenSet.has(label.nodeId)) continue
        if (label.nodeId) byNode.delete(label.nodeId)
        label.nodeId = null
        label.obj.visible = false
        free.push(label)
      }
      const maxDeg = maxDegRef.current
      for (const id of chosen) {
        if (byNode.has(id)) continue
        const data = dataMap.get(id)
        if (!data) continue                 // e.g. an AI-highlighted document that is not in the graph
        const label = free.pop()
        if (!label) break
        const text = labelTextById.get(id) ?? id
        label.nodeId = id
        label.div.textContent = text.length > 28 ? text.slice(0, 27) + '…' : text
        label.div.title = text
        // Hubs get slightly larger type so the important documents stand out at a glance
        const hub = data.deg >= Math.max(3, maxDeg * 0.5)
        label.div.style.fontSize = hub ? '13px' : data.deg >= 2 ? '11.5px' : '10.5px'
        label.div.style.fontWeight = hub ? '600' : 'normal'
        label.obj.position.set(data.pos.x, data.pos.y - NODE_RADIUS - 6, data.pos.z)
        label.obj.visible = true
        byNode.set(id, label)
      }
    }

    // ── Animation loop (dirty-render) ─────────────────────────────────────────
    function animate() {
      rafRef.current = requestAnimationFrame(animate)
      try { animateFrame() } catch (e) { console.error('[Graph3D] animate error:', e) }
    }
    function animateFrame() {
      tickRef.current++

      const selId = selectedNodeIdRef.current
      if (selId) {
        const data = nodeDataRef.current.get(selId)
        if (data) controls.target.lerp(data.pos, 0.04)
      }
      controls.update()

      const aiSet = aiHighlightRef.current
      const ringVisible = selRingRef.current?.visible ?? false
      const particlesVisible = particlesRef.current?.visible ?? false

      if (controls.autoRotate || aiSet.size > 0 || ringVisible || particlesVisible) {
        renderBudgetRef.current = Math.max(renderBudgetRef.current, 2)
      }
      // Lowest quality level: when the idle auto-rotation is the only reason to draw, draw every
      // other frame (the rotation itself keeps its speed — controls.update() ran above)
      const onlyAutoRotate = controls.autoRotate && aiSet.size === 0 && !ringVisible && !particlesVisible && renderBudgetRef.current <= 2
      if (qualityRef.current >= 3 && onlyAutoRotate && tickRef.current % 2 === 1) return

      if (renderBudgetRef.current > 0) {
        if (ringVisible) {
          selRingRef.current!.rotation.z += 0.008
        }

        // AI highlight pulse — delta-only instance matrix updates
        const prevAiSet = prevAiHighlightRef.current
        if (aiSet.size > 0) {
          const pulseBase = 1 + Math.sin(tickRef.current * 0.06) * 0.3
          let dirty = false
          aiSet.forEach(nodeId => {
            const data = nodeDataRef.current.get(nodeId)
            if (!data) return
            dummy.position.copy(data.pos)
            dummy.scale.setScalar(data.scaledRadius * pulseBase)
            dummy.updateMatrix()
            data.iMesh.setMatrixAt(data.idx, dummy.matrix)
            dirty = true
          })
          prevAiSet.forEach(nodeId => {
            if (!aiSet.has(nodeId)) {
              const data = nodeDataRef.current.get(nodeId)
              if (!data) return
              dummy.position.copy(data.pos)
              dummy.scale.setScalar(data.scaledRadius)
              dummy.updateMatrix()
              data.iMesh.setMatrixAt(data.idx, dummy.matrix)
              dirty = true
            }
          })
          if (dirty) {
            if (sphereInstancedRef.current) sphereInstancedRef.current.instanceMatrix.needsUpdate = true
            if (octaInstancedRef.current) octaInstancedRef.current.instanceMatrix.needsUpdate = true
          }
        }

        if (particlesVisible && particlePosRef.current && particleOffsets.current) {
          const t = tickRef.current * 0.01
          for (let i = 0; i < PARTICLE_COUNT; i++) {
            const drift = Math.sin(t + i) * 0.5
            pPos[i * 3 + 0] = offsets[i * 3 + 0] + drift
            pPos[i * 3 + 1] = offsets[i * 3 + 1] + drift
            pPos[i * 3 + 2] = offsets[i * 3 + 2]
          }
          ;(pGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true
        }

        const renderStart = perfOn() ? performance.now() : 0
        renderer.render(scene, camera)
        perfMeasure('graph3d.render', renderStart)
        // Labels are DOM elements positioned per frame; also needed for the hover label
        if (showNodeLabelsRef.current || lastHoveredRef.current || labelByNodeRef.current.size > 0) {
          const labelStart = perfOn() ? performance.now() : 0
          if (labelAssignDueRef.current && performance.now() - lastLabelAssignRef.current >= LABEL_REASSIGN_MS) assignLabels()
          css2dRenderer.render(scene, camera)
          perfMeasure('graph3d.labels', labelStart)
        }
        renderBudgetRef.current--

        // Frame pacing: intervals between back-to-back rendered frames feed the quality controller
        const ts = performance.now()
        if (lastRenderTsRef.current && ts - lastRenderTsRef.current < 200) {
          const intervals = frameIntervalsRef.current
          intervals.push(ts - lastRenderTsRef.current)
          if (intervals.length >= QUALITY_WINDOW_FRAMES) {
            const next = nextQualityLevel(qualityRef.current, intervals, QUALITY_SLOW_MS)
            intervals.length = 0
            if (next !== qualityRef.current) stepDownQuality()
          }
        }
        lastRenderTsRef.current = ts
      }
      // Always track previous AI highlight set — must be outside renderBudget guard
      // so delta comparisons stay accurate even when rendering is paused.
      // Clear old reference first so GC can collect the previous Set immediately.
      prevAiHighlightRef.current = null as unknown as Set<string>
      prevAiHighlightRef.current = new Set(aiSet)
    }
    animate()
    setGraphLayoutReady(true)

    // The force layout keeps spreading for several seconds on a large vault: re-fit the camera a
    // few times while the user has not taken control (autoRotate is switched off on interaction).
    const autoFitTimers = [1500, 5000, 12000].map(ms => setTimeout(() => { if (controls.autoRotate) fitCameraToNodes() }, ms))

    // ── Canvas-direct pointer listeners ─────────────────────────────────────
    // Attaching directly to the WebGL canvas element guarantees events fire
    // even when OrbitControls holds pointer capture on the same canvas.
    // Wrapper functions delegate to handler refs so they always call the
    // latest version without needing to re-attach on every closure change.
    const onDown   = (e: PointerEvent) => handleMouseDownRef.current(e)
    const onMove   = (e: PointerEvent) => handleMouseMoveRef.current(e)
    const onUp     = (e: PointerEvent) => handleMouseUpRef.current(e)
    const onLeave  = () => handleMouseLeaveRef.current()
    const onClick  = (e: MouseEvent)  => handleCanvasClickRef.current(e)
    renderer.domElement.addEventListener('pointerdown',  onDown)
    renderer.domElement.addEventListener('pointermove',  onMove)
    renderer.domElement.addEventListener('pointerup',    onUp)
    renderer.domElement.addEventListener('pointerleave', onLeave)
    renderer.domElement.addEventListener('click',        onClick)

    return () => {
      renderer.domElement.removeEventListener('pointerdown',  onDown)
      renderer.domElement.removeEventListener('pointermove',  onMove)
      renderer.domElement.removeEventListener('pointerup',    onUp)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      renderer.domElement.removeEventListener('click',        onClick)

      graphCallbacks.resetCamera = null
      autoFitTimers.forEach(clearTimeout)
      cancelAnimationFrame(rafRef.current)
      prevHoverStateRef.current = null
      controls.removeEventListener('start', onInteractStart)
      controls.removeEventListener('end', onInteractEnd)
      controls.removeEventListener('change', onControlsChange)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      controls.dispose()

      // Remove the label pool (and its DOM elements) so nothing accumulates across rebuilds
      scene.remove(labelGroup)
      for (const label of pool) label.div.remove()
      labelPoolRef.current = []
      labelByNodeRef.current = new Map()
      labelGroupRef.current = null
      // Dispose InstancedMeshes before scene.clear()
      scene.remove(sphereInstanced)
      scene.remove(octaInstanced)
      sphereInstanced.dispose()
      octaInstanced.dispose()
      // Clear remaining scene objects (lineSegments, ring, particles, etc.)
      scene.clear()

      applyEdgeBudgetRef.current = null
      renderer.domElement.removeEventListener('webglcontextlost', onContextLost)
      renderer.domElement.removeEventListener('webglcontextrestored', onContextRestored)
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      if (css2dRenderer.domElement.parentNode) {
        mount.removeChild(css2dRenderer.domElement)
      }
      css2dRendererRef.current = null
      sphereGeo.dispose()
      octaGeo.dispose()
      sphereMat.dispose()
      octaMat.dispose()
      lineGeo.dispose()
      lineMat.dispose()
      ringGeo.dispose()
      ringMat.dispose()
      pGeo.dispose()
      pMat.dispose()
      nodeDataRef.current.clear()
      linePosRef.current = null
      lineColorArrayRef.current = null
      lineColorAttrRef.current = null
      lineMatRef.current = null
      rendererRef.current = null
      sceneRef.current = null
      cameraRef.current = null
      controlsRef.current = null
      selRingRef.current = null
      particlesRef.current = null
      sphereInstancedRef.current = null
      octaInstancedRef.current = null
      instancedMeshArrayRef.current = []
    }
    prevNodeCountRef.current = nodes.length
    prevLinkCountRef.current = links.length
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, links.length, setGraphLayoutReady])

  // ── Focus node: animate camera to target node position ────────────────────
  useEffect(() => {
    if (!focusNodeId) return
    const nodeData = nodeDataRef.current.get(focusNodeId)
    if (!nodeData) return
    const camera = cameraRef.current
    const controls = controlsRef.current
    if (!camera || !controls) return

    const { x, y, z } = nodeData.pos
    // Target: controls.target → node position, camera → 120 units away from node
    const from = camera.position.clone()
    const toTarget = new THREE.Vector3(x, y, z)
    const toPos = toTarget.clone().add(new THREE.Vector3(0, 0, 120))

    let rafId: number | null = null
    let t = 0
    const step = () => {
      t = Math.min(t + 0.05, 1)
      const ease = 1 - Math.pow(1 - t, 3)  // ease-out cubic
      camera.position.lerpVectors(from, toPos, ease)
      controls.target.lerp(toTarget, ease)
      controls.update()
      renderBudgetRef.current = Math.max(renderBudgetRef.current, 2)
      if (t < 1) rafId = requestAnimationFrame(step)
      else rafId = null
    }
    rafId = requestAnimationFrame(step)
    setFocusNode(null)
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusNodeId])

  // ── Resize ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const renderer = rendererRef.current
    const camera = cameraRef.current
    if (!renderer || !camera) return
    renderer.setSize(width, height)
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    css2dRendererRef.current?.setSize(width, height)
  }, [width, height])

  // ── Selection ring visibility + stop auto-rotate ──────────────────────────
  useEffect(() => {
    if (!selRingRef.current || !particlesRef.current) return
    const visible = !!selectedNodeId

    if (visible && controlsRef.current) {
      controlsRef.current.autoRotate = false
    }

    selRingRef.current.visible = visible
    particlesRef.current.visible = visible

    if (visible && selectedNodeId) {
      const data = nodeDataRef.current.get(selectedNodeId)
      if (data) {
        selRingRef.current.position.copy(data.pos)
        particlesRef.current.position.copy(data.pos)

        const node = nodes.find(n => n.id === selectedNodeId)
        if (node) {
          const hex = SPEAKER_CONFIG[node.speaker].hex
          ;(selRingRef.current.material as THREE.LineDashedMaterial).color.setHex(hex)
          ;(particlesRef.current.material as THREE.PointsMaterial).color.setHex(hex)
        }
      }
    }
    renderBudgetRef.current = Math.max(renderBudgetRef.current, 5)
  }, [selectedNodeId, nodes])

  // ── Wire opacity real-time sync ──────────────────────────────────────────────
  useEffect(() => {
    if (lineMatRef.current) {
      lineMatRef.current.opacity = physics.linkOpacity
      lineMatRef.current.needsUpdate = true
      renderBudgetRef.current = Math.max(renderBudgetRef.current, 3)
    }
  }, [physics.linkOpacity])

  // ── Node size real-time sync ─────────────────────────────────────────────────
  useEffect(() => {
    const baseScale = physics.nodeRadius / 7
    const dummy = dummyRef.current
    let sphereDirty = false, octaDirty = false
    nodeDataRef.current.forEach(data => {
      const scaledRadius = baseScale * degreeSize(data.degreeScale)
      data.scaledRadius = scaledRadius
      dummy.position.copy(data.pos)
      dummy.scale.setScalar(scaledRadius)
      dummy.updateMatrix()
      data.iMesh.setMatrixAt(data.idx, dummy.matrix)
      if (data.iMesh === sphereInstancedRef.current) sphereDirty = true
      else octaDirty = true
    })
    if (sphereDirty && sphereInstancedRef.current) sphereInstancedRef.current.instanceMatrix.needsUpdate = true
    if (octaDirty && octaInstancedRef.current) octaInstancedRef.current.instanceMatrix.needsUpdate = true
    renderBudgetRef.current = Math.max(renderBudgetRef.current, 3)
  }, [physics.nodeRadius])

  // ── CSS2DRenderer labels: hide only when overlay panel is active ──────────
  useEffect(() => {
    const css2d = css2dRendererRef.current
    if (!css2d) return
    css2d.domElement.style.display = centerTab === 'graph' ? '' : 'none'
  }, [centerTab])

  // ── Label pool reassignment: the label toggle, hover, selection and AI highlight change who
  // gets a label; the animation loop does the actual assignment on its next rendered frame
  useEffect(() => {
    labelAssignDueRef.current = true
    lastLabelAssignRef.current = 0
    renderBudgetRef.current = Math.max(renderBudgetRef.current, 3)
  }, [showNodeLabels, hoveredNodeId, selectedNodeId, aiHighlightNodeIds])

  // ── AI highlight: sync aiHighlightNodeIds → ref for animation loop ────────
  useEffect(() => {
    aiHighlightRef.current = new Set(aiHighlightNodeIds)
    if (aiHighlightNodeIds.length === 0) {
      const dummy = dummyRef.current
      let sphereDirty = false, octaDirty = false
      nodeDataRef.current.forEach(data => {
        dummy.position.copy(data.pos)
        dummy.scale.setScalar(data.scaledRadius)
        dummy.updateMatrix()
        data.iMesh.setMatrixAt(data.idx, dummy.matrix)
        if (data.iMesh === sphereInstancedRef.current) sphereDirty = true
        else octaDirty = true
      })
      if (sphereDirty && sphereInstancedRef.current) sphereInstancedRef.current.instanceMatrix.needsUpdate = true
      if (octaDirty && octaInstancedRef.current) octaInstancedRef.current.instanceMatrix.needsUpdate = true
    }
    renderBudgetRef.current = Math.max(renderBudgetRef.current, 3)
  }, [aiHighlightNodeIds])

  // ── Neighbor highlight — color-dim approach (InstancedMesh compatible) ──────────
  useEffect(() => {
    const dataMap = nodeDataRef.current
    const colorArray = lineColorArrayRef.current
    const colorAttr = lineColorAttrRef.current
    const tmpColor = new THREE.Color()
    // With the edge budget on, the hovered node's own edges must be drawn even when they are weak
    applyEdgeBudgetRef.current?.()

    if (!hoveredNodeId) {
      const prev = prevHoverStateRef.current
      if (prev) {
        // Restore all nodes to baseColor
        let sphereDirty = false, octaDirty = false
        dataMap.forEach(data => {
          data.iMesh.setColorAt(data.idx, data.baseColor)
          if (data.iMesh === sphereInstancedRef.current) sphereDirty = true
          else octaDirty = true
        })
        if (sphereDirty && sphereInstancedRef.current?.instanceColor) sphereInstancedRef.current.instanceColor.needsUpdate = true
        if (octaDirty && octaInstancedRef.current?.instanceColor) octaInstancedRef.current.instanceColor.needsUpdate = true

        if (colorArray && colorAttr) {
          prev.neighborLinkIdxs.forEach(i => {
            const s = (links[i] as GraphLink).strength ?? 0.5
            const brightness = EDGE_DEF_R * (0.5 + s * 2.0)
            for (let v = 0; v < 2; v++) {
              const base = i * 6 + v * 3
              colorArray[base] = brightness; colorArray[base + 1] = brightness; colorArray[base + 2] = brightness
            }
          })
          colorAttr.needsUpdate = true
        }
      }
      prevHoverStateRef.current = null
      renderBudgetRef.current = Math.max(renderBudgetRef.current, 3)
      return
    }

    const neighborLinkIdxs = adjacencyRef.current.get(hoveredNodeId) ?? new Set<number>()
    const neighborIds = new Set<string>([hoveredNodeId])
    neighborLinkIdxs.forEach(i => {
      const link = links[i] as GraphLink | undefined
      if (!link) return
      neighborIds.add(typeof link.source === 'string' ? link.source : (link.source as { id: string }).id)
      neighborIds.add(typeof link.target === 'string' ? link.target : (link.target as { id: string }).id)
    })

    const hovNode = nodes.find(n => n.id === hoveredNodeId)
    const accentHex = hovNode ? SPEAKER_CONFIG[hovNode.speaker].hex : 0xffffff
    const accentR = ((accentHex >> 16) & 0xff) / 0xff
    const accentG = ((accentHex >> 8) & 0xff) / 0xff
    const accentB = (accentHex & 0xff) / 0xff

    let sphereDirty = false, octaDirty = false

    const prev = prevHoverStateRef.current
    if (prev) {
      // Delta: only update changed nodes (O(prevK + newK))
      prev.neighborIds.forEach(nodeId => {
        if (!neighborIds.has(nodeId)) {
          const data = dataMap.get(nodeId)
          if (!data) return
          tmpColor.copy(data.baseColor).multiplyScalar(0.08)
          data.iMesh.setColorAt(data.idx, tmpColor)
          if (data.iMesh === sphereInstancedRef.current) sphereDirty = true
          else octaDirty = true
        }
      })
      neighborIds.forEach(nodeId => {
        if (!prev.neighborIds.has(nodeId)) {
          const data = dataMap.get(nodeId)
          if (!data) return
          data.iMesh.setColorAt(data.idx, data.baseColor)
          if (data.iMesh === sphereInstancedRef.current) sphereDirty = true
          else octaDirty = true
        }
      })
      if (colorArray && colorAttr) {
        prev.neighborLinkIdxs.forEach(i => {
          if (!neighborLinkIdxs.has(i)) {
            for (let v = 0; v < 2; v++) {
              const base = i * 6 + v * 3
              colorArray[base] = 0.04; colorArray[base + 1] = 0.04; colorArray[base + 2] = 0.04
            }
          }
        })
        neighborLinkIdxs.forEach(i => {
          if (!prev.neighborLinkIdxs.has(i)) {
            for (let v = 0; v < 2; v++) {
              const base = i * 6 + v * 3
              colorArray[base] = accentR; colorArray[base + 1] = accentG; colorArray[base + 2] = accentB
            }
          }
        })
        colorAttr.needsUpdate = true
      }
    } else {
      // Initial hover: full pass O(n)
      dataMap.forEach((data, nodeId) => {
        if (neighborIds.has(nodeId)) {
          data.iMesh.setColorAt(data.idx, data.baseColor)
        } else {
          tmpColor.copy(data.baseColor).multiplyScalar(0.08)
          data.iMesh.setColorAt(data.idx, tmpColor)
        }
        if (data.iMesh === sphereInstancedRef.current) sphereDirty = true
        else octaDirty = true
      })
      if (colorArray && colorAttr) {
        links.forEach((_: GraphLink, i: number) => {
          const isNeighbor = neighborLinkIdxs.has(i)
          for (let v = 0; v < 2; v++) {
            const base = i * 6 + v * 3
            if (isNeighbor) { colorArray[base] = accentR; colorArray[base + 1] = accentG; colorArray[base + 2] = accentB }
            else { colorArray[base] = 0.04; colorArray[base + 1] = 0.04; colorArray[base + 2] = 0.04 }
          }
        })
        colorAttr.needsUpdate = true
      }
    }

    if (sphereDirty && sphereInstancedRef.current?.instanceColor) sphereInstancedRef.current.instanceColor.needsUpdate = true
    if (octaDirty && octaInstancedRef.current?.instanceColor) octaInstancedRef.current.instanceColor.needsUpdate = true

    prevHoverStateRef.current = { neighborIds, neighborLinkIdxs }
    renderBudgetRef.current = Math.max(renderBudgetRef.current, 3)
  }, [hoveredNodeId, nodes, links])

  // ── Helper: screen coords → NDC ───────────────────────────────────────────
  const getNDC = useCallback((clientX: number, clientY: number): THREE.Vector2 => {
    const renderer = rendererRef.current
    if (!renderer) return new THREE.Vector2(0, 0)
    const rect = renderer.domElement.getBoundingClientRect()
    return new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
  }, [])

  // ── Helper: resolve nodeId from raycast hit ───────────────────────────────
  const nodeIdFromHit = useCallback((hit: THREE.Intersection): string | null => {
    const instanceId = hit.instanceId
    if (instanceId == null) return null
    const mesh = hit.object as THREE.InstancedMesh
    const ids = mesh === sphereInstancedRef.current ? sphereNodeIds.current : octaNodeIds.current
    return ids[instanceId] ?? null
  }, [])

  // ── Global mouseup ────────────────────────────────────────────────────────
  useEffect(() => {
    const handleGlobalMouseUp = () => {
      if (!draggingNodeIdRef.current) return
      const simNode = draggingSimNodeRef.current  // O(1) cached ref
      if (simNode) {
        simNode.fx = null
        simNode.fy = null
        simNode.fz = null
      }
      draggingSimNodeRef.current = null
      ;(simRef.current as any)?.alphaTarget(0)
      if (controlsRef.current) controlsRef.current.enabled = true
      draggingNodeIdRef.current = null
      isDraggingRef.current = false
      setHoveredNode(null)
      lastHoveredRef.current = null
      setTooltip(null)
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
      idleTimerRef.current = setTimeout(() => {
        if (controlsRef.current) controlsRef.current.autoRotate = true
      }, 10_000)
    }
    window.addEventListener('pointerup', handleGlobalMouseUp)
    return () => window.removeEventListener('pointerup', handleGlobalMouseUp)
  }, [simNodesRef, simRef, setHoveredNode])

  // ── Mouse down ────────────────────────────────────────────────────────────
  const handleMouseDown = useCallback((e: PointerEvent) => {
    // Reset click guard for the new press
    nodeWasDraggedRef.current = false
    const renderer = rendererRef.current
    const camera = cameraRef.current
    if (!renderer || !camera) return

    const ndc = getNDC(e.clientX, e.clientY)
    raycasterRef.current.setFromCamera(ndc, camera)
    const hits = raycasterRef.current.intersectObjects(instancedMeshArrayRef.current)
    if (hits.length === 0) return

    const nodeId = nodeIdFromHit(hits[0])
    if (!nodeId) return

    const camDir = camera.getWorldDirection(new THREE.Vector3())
    dragPlaneRef.current.setFromNormalAndCoplanarPoint(camDir, hits[0].point)

    const simNode = simNodesRef.current.find(n => n.id === nodeId) ?? null
    draggingSimNodeRef.current = simNode
    if (simNode) {
      simNode.fx = simNode.x
      simNode.fy = simNode.y
      simNode.fz = simNode.z
      ;(simRef.current as any)?.alphaTarget(0.3).restart()
    }

    if (controlsRef.current) {
      controlsRef.current.enabled = false
      controlsRef.current.autoRotate = false
    }
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)

    draggingNodeIdRef.current = nodeId
    isDraggingRef.current = false
    mouseDownPosRef.current = { x: e.clientX, y: e.clientY }

    if (nodeId !== lastHoveredRef.current) {
      lastHoveredRef.current = nodeId
      setHoveredNode(nodeId)
    }
  }, [getNDC, nodeIdFromHit, simNodesRef, simRef, setHoveredNode])

  // ── Mouse move ────────────────────────────────────────────────────────────
  const handleMouseMove = useCallback((e: PointerEvent) => {
    const renderer = rendererRef.current
    const camera = cameraRef.current
    if (!renderer || !camera) return

    if (draggingNodeIdRef.current) {
      // Only classify as drag when moved 4px+ (prevent false click detection)
      if (!isDraggingRef.current) {
        const dx = e.clientX - mouseDownPosRef.current.x
        const dy = e.clientY - mouseDownPosRef.current.y
        if (dx * dx + dy * dy > 16) { isDraggingRef.current = true; nodeWasDraggedRef.current = true }
      }
      if (!isDraggingRef.current) return  // Still below threshold — treat as click
      const ndc = getNDC(e.clientX, e.clientY)
      raycasterRef.current.setFromCamera(ndc, camera)
      const intersection = new THREE.Vector3()
      if (raycasterRef.current.ray.intersectPlane(dragPlaneRef.current, intersection)) {
        const simNode = draggingSimNodeRef.current  // O(1) cached ref
        if (simNode) {
          simNode.fx = intersection.x; simNode.fy = intersection.y; simNode.fz = intersection.z
          ;(simRef.current as any)?.alphaTarget(0.3).restart()
        }
      }
      setTooltip(null)
      return
    }

    pendingMousePosRef.current = { x: e.clientX, y: e.clientY }
    if (!rafScheduledRef.current) {
      rafScheduledRef.current = true
      requestAnimationFrame(() => {
        rafScheduledRef.current = false
        const pos = pendingMousePosRef.current
        if (!pos || !rendererRef.current || !cameraRef.current) return
        const ndc = getNDC(pos.x, pos.y)
        raycasterRef.current.setFromCamera(ndc, cameraRef.current)
        const hits = raycasterRef.current.intersectObjects(instancedMeshArrayRef.current)
        const newHoverId = hits.length > 0 ? nodeIdFromHit(hits[0]) : null
        if (newHoverId !== lastHoveredRef.current) {
          lastHoveredRef.current = newHoverId
          if (!isFastRef.current) setHoveredNode(newHoverId)
        }
      })
    }
  }, [getNDC, nodeIdFromHit, simNodesRef, simRef, setHoveredNode])

  // ── Mouse up ──────────────────────────────────────────────────────────────
  // ── Mouse up — release drag only (selection handled by handleCanvasClick) ──
  const handleMouseUp = useCallback((_e: PointerEvent) => {
    const draggedNodeId = draggingNodeIdRef.current

    if (draggedNodeId) {
      const simNode = draggingSimNodeRef.current  // O(1) cached ref
      if (simNode) {
        simNode.fx = null
        simNode.fy = null
        simNode.fz = null
      }
      draggingSimNodeRef.current = null
      ;(simRef.current as any)?.alphaTarget(0)
      if (controlsRef.current) controlsRef.current.enabled = true
      draggingNodeIdRef.current = null
      isDraggingRef.current = false
      // nodeWasDraggedRef is intentionally NOT reset here — handleCanvasClick reads it
    }

    setHoveredNode(null)
    lastHoveredRef.current = null

    if (idleTimerRef.current) clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => {
      if (controlsRef.current) controlsRef.current.autoRotate = true
    }, 10_000)
  }, [simRef, setHoveredNode])

  // ── Mouse leave ───────────────────────────────────────────────────────────
  const handleMouseLeave = useCallback(() => {
    if (draggingNodeIdRef.current) return
    if (lastHoveredRef.current !== null) {
      lastHoveredRef.current = null
      setHoveredNode(null)
      // Tooltip pinned by click persists when mouse leaves
    }
  }, [setHoveredNode])

  // ── Canvas click — primary node selection (reliable alternative to pointerup) ──
  // The native `click` event fires after any pointer-down + pointer-up that didn't
  // involve significant pointer movement (browser's own threshold).
  // `nodeWasDraggedRef` guard prevents selection when a node was dragged.
  const handleCanvasClick = useCallback((e: MouseEvent) => {
    // Guard: a node was dragged → not a selection click
    if (nodeWasDraggedRef.current) { nodeWasDraggedRef.current = false; return }

    const renderer = rendererRef.current
    const camera   = cameraRef.current
    if (!renderer || !camera) return

    const ndc  = getNDC(e.clientX, e.clientY)
    raycasterRef.current.setFromCamera(ndc, camera)
    const hits = raycasterRef.current.intersectObjects(instancedMeshArrayRef.current)

    if (hits.length === 0) {
      // Empty space click: close tooltip
      if (clickTimerRef.current) { clearTimeout(clickTimerRef.current); clickTimerRef.current = null }
      setTooltip(null)
      return
    }

    const nodeId = nodeIdFromHit(hits[0])
    if (!nodeId) return

    const data = nodeDataRef.current.get(nodeId)
    if (!data) return
    const docId = data.docId

    setSelectedNode(nodeId)
    setSelectedDoc(docId)

    // Show tooltip immediately on click — project node's 3D position to screen coordinates
    let tooltipX = e.clientX
    let tooltipY = e.clientY
    const nodeData = nodeDataRef.current.get(nodeId)
    if (nodeData && rendererRef.current) {
      const projected = nodeData.pos.clone().project(camera)
      const rect = rendererRef.current.domElement.getBoundingClientRect()
      tooltipX = rect.left + (projected.x + 1) / 2 * rect.width
      tooltipY = rect.top  + (-projected.y + 1) / 2 * rect.height
    }
    setTooltip({ nodeId, x: tooltipX, y: tooltipY })

    if (clickTimerRef.current) {
      // ── Double-click: cancel timer → open editor ────────────────────────────────
      clearTimeout(clickTimerRef.current)
      clickTimerRef.current = null
      setTooltip(null)
      if (docId.startsWith('_phantom_')) {
        const node = nodes.find(n => n.id === nodeId)
        const label = node?.label ?? nodeId.replace('_phantom_', '')
        if (vaultPath && window.vaultAPI) {
          const sep = vaultPath.includes('\\') ? '\\' : '/'
          const newPath = `${vaultPath}${sep}${label}.md`
          window.vaultAPI.saveFile(newPath, `# ${label}\n\n`).then(() => {
            return window.vaultAPI!.loadFiles(vaultPath)
          }).then(({ files }) => {
            if (!files) return
            const docs = parseVaultFiles(files) as LoadedDocument[]
            setLoadedDocuments(docs)
            const { nodes: newNodes, links: newLinks } = buildGraph(docs)
            setNodes(newNodes)
            setLinks(newLinks)
            const newDoc = docs.find(d =>
              d.absolutePath.replace(/\\/g, '/') === newPath.replace(/\\/g, '/')
            )
            if (newDoc) openInEditor(newDoc.id)
          }).catch((err: unknown) => {
            console.error('[Graph3D] phantom node file creation failed:', err)
          })
        }
      } else {
        openInEditor(docId)
      }
    } else {
      // ── Single-click: keep tooltip, wait 300ms for re-click ──────────────────────────
      clickTimerRef.current = setTimeout(() => { clickTimerRef.current = null }, 300)
    }
  }, [getNDC, nodeIdFromHit, setSelectedNode, setSelectedDoc, setHoveredNode,
      openInEditor, nodes, vaultPath, loadedDocuments, setLoadedDocuments, setNodes, setLinks])

  // ── Handler refs — always point to the latest callback ───────────────────
  // Used by canvas-direct listeners in the scene setup effect so they don't
  // need to re-attach every time a callback's closure dependencies change.
  const handleMouseDownRef    = useRef(handleMouseDown)
  const handleMouseMoveRef    = useRef(handleMouseMove)
  const handleMouseUpRef      = useRef(handleMouseUp)
  const handleMouseLeaveRef   = useRef(handleMouseLeave)
  const handleCanvasClickRef  = useRef(handleCanvasClick)
  useEffect(() => { handleMouseDownRef.current   = handleMouseDown   }, [handleMouseDown])
  useEffect(() => { handleMouseMoveRef.current   = handleMouseMove   }, [handleMouseMove])
  useEffect(() => { handleMouseUpRef.current     = handleMouseUp     }, [handleMouseUp])
  useEffect(() => { handleMouseLeaveRef.current  = handleMouseLeave  }, [handleMouseLeave])
  useEffect(() => { handleCanvasClickRef.current = handleCanvasClick }, [handleCanvasClick])

  return (
    <div
      ref={mountRef}
      style={{
        width,
        height,
        overflow: 'hidden',
        cursor: 'grab',
        position: 'relative',
      }}
      data-testid="graph-3d"
    >
      <div
        role="img"
        aria-label={t('Knowledge graph: {nodes} nodes, {links} links', { nodes: nodes.length, links: links.length })}
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
          borderWidth: 0,
        }}
      />
      {tooltip && <NodeTooltip nodeId={tooltip.nodeId} x={tooltip.x} y={tooltip.y} onOpen={() => setTooltip(null)} />}
    </div>
  )
}
