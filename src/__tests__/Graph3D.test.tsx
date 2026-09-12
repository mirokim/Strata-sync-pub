import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useUIStore } from '@/stores/uiStore'
import { useGraphStore } from '@/stores/graphStore'
import { MOCK_NODES, MOCK_LINKS } from '@/data/mockGraph'
import { DEFAULT_PHYSICS } from '@/stores/graphStore'

// ── Configurable mock state (module-level variables updated per test) ───────
// Mock factories close over these; tests mutate them directly.
let _intersectResult: { object: any; instanceId?: number; point?: any }[] = []
// InstancedMesh instances created by the component, in creation order (sphere mesh first, then octahedron)
let _instancedMeshes: any[] = []
let _numDimensionsCalled = false
let _forceSimulationCalled = false
let _webGLRendererCreated = false

// Reset all state between tests
function resetMockState() {
  _intersectResult = []
  _instancedMeshes = []
  _numDimensionsCalled = false
  _forceSimulationCalled = false
  _webGLRendererCreated = false
}

// ── Mock Three.js ──────────────────────────────────────────────────────────
vi.mock('three', () => {
  class V3 {
    x = 0; y = 0; z = 0
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z }
    clone() { return new V3(this.x, this.y, this.z) }
    add(v: any) { this.x += v.x; this.y += v.y; this.z += v.z; return this }
    sub(v: any) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this }
    multiplyScalar(k: number) { this.x *= k; this.y *= k; this.z *= k; return this }
    normalize() { return this }
    length() { return Math.hypot(this.x, this.y, this.z) }
    distanceTo(v: any) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z) }
    applyMatrix4() { return this }
    project() { return this }
    unproject() { return this }
    lerpVectors(a: any, b: any, t: number) { this.x = a.x + (b.x - a.x) * t; this.y = a.y + (b.y - a.y) * t; this.z = a.z + (b.z - a.z) * t; return this }
    setFromMatrixPosition() { return this }
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this }
    copy(v: any) { this.x = v.x; this.y = v.y; this.z = v.z; return this }
    lerp(v: any, alpha: number) { this.x += (v.x - this.x) * alpha; this.y += (v.y - this.y) * alpha; this.z += (v.z - this.z) * alpha; return this }
  }
  class BufAttr {
    needsUpdate = false
    constructor(public array: any, public itemSize: number) {}
  }
  class BufGeo {
    setAttribute() { return this }
    getAttribute() { return new BufAttr(new Float32Array(0), 3) }
    setFromPoints() { return this }
    dispose() {}
  }
  class Mesh {
    position = new V3()
    scale = { setScalar(_s: number) {} }
    userData: any = {}
    visible = true
    material = { color: { setHex() {} } }
    add() {}
  }
  class Line {
    position = new V3()
    rotation = { z: 0 }
    visible = false
    material = { color: { setHex() {} } }
    computeLineDistances() {}
  }
  class Points {
    position = new V3()
    visible = false
    material = { color: { setHex() {} } }
  }
  class Color {
    r = 0; g = 0; b = 0
    constructor(_c?: any) {}
    set() { return this }
    setHex() { return this }
    getHex() { return 0 }
    lerp() { return this }
    copy() { return this }
    multiplyScalar() { return this }
    setRGB() { return this }
    setStyle() { return this }
    clone() { return new Color() }
  }
  class Material {
    color = new Color()
    opacity = 1
    transparent = true
    needsUpdate = false
    depthWrite = true
    constructor(_p?: any) {}
    dispose() {}
  }
  class Object3D {
    position = new V3()
    scale = { setScalar(_s: number) {} }
    matrix = {}
    userData: any = {}
    visible = true
    children: any[] = []
    updateMatrix() {}
    add(o: any) { this.children.push(o) }
    remove() {}
  }
  class InstancedMesh extends Object3D {
    instanceMatrix = { needsUpdate: false, setUsage() {} }
    instanceColor: any = { needsUpdate: false }
    frustumCulled = true
    constructor(public geometry: any, public material: any, public count: number) {
      super()
      _instancedMeshes.push(this)
    }
    setMatrixAt() {}
    setColorAt() {}
    getMatrixAt() {}
    dispose() {}
  }

  return {
    WebGLRenderer: class {
      domElement = (() => {
        try { return document.createElement('canvas') } catch { return {} }
      })()
      constructor() { _webGLRendererCreated = true }
      setPixelRatio() {}
      setSize() {}
      setClearColor() {}
      render() {}
      dispose() {}
    },
    Scene: class { add() {} remove() {} clear() {} },
    PerspectiveCamera: class {
      position = new V3()
      aspect = 1
      updateProjectionMatrix() {}
      fov = 60
      getWorldDirection(v: any) { return v }
    },
    Vector3: V3,
    Vector2: class { constructor(public x = 0, public y = 0) {} },
    Plane: class {
      setFromNormalAndCoplanarPoint() { return this }
    },
    BufferGeometry: BufGeo,
    BufferAttribute: BufAttr,
    Mesh,
    SphereGeometry: class { dispose() {} },
    OctahedronGeometry: class { dispose() {} },
    MeshBasicMaterial: Material,
    MeshLambertMaterial: Material,
    HemisphereLight: Object3D,
    DirectionalLight: Object3D,
    Fog: class { constructor(public color?: any, public near?: number, public far?: number) {} },
    LineBasicMaterial: Material,
    LineDashedMaterial: Material,
    PointsMaterial: Material,
    LineSegments: class { constructor(public geometry?: any, public material?: any) {} },
    Object3D,
    InstancedMesh,
    Color,
    DynamicDrawUsage: 35048,
    Line,
    Points,
    Raycaster: class {
      ray = {
        intersectPlane(_plane: any, target: any) {
          if (target && typeof target.set === 'function') target.set(0, 0, 0)
          return target
        },
      }
      setFromCamera() {}
      intersectObjects() { return _intersectResult }
    },
  }
})

// ── Mock OrbitControls ──────────────────────────────────────────────────────
vi.mock('three/examples/jsm/controls/OrbitControls.js', () => {
  class V3Mock {
    x = 0; y = 0; z = 0
    set(x: number, y: number, z: number) { this.x = x; this.y = y; this.z = z; return this }
    lerp(v: any, alpha: number) { this.x += (v.x - this.x) * alpha; return this }
  }
  return {
    OrbitControls: class {
      enableDamping = false
      dampingFactor = 0
      autoRotate = false
      autoRotateSpeed = 0
      enabled = true
      target = new V3Mock()
      update() {}
      dispose() {}
      addEventListener() {}
      removeEventListener() {}
    },
  }
})

// ── Mock CSS2DRenderer ──────────────────────────────────────────────────────
vi.mock('three/examples/jsm/renderers/CSS2DRenderer.js', () => ({
  CSS2DRenderer: class {
    domElement = (() => {
      try { return document.createElement('div') } catch { return {} }
    })()
    setSize() {}
    render() {}
  },
  CSS2DObject: class {
    element: HTMLElement
    position = { set() {} }
    constructor(el: HTMLElement) { this.element = el }
  },
}))

// ── Mock d3-force-3d ────────────────────────────────────────────────────────
vi.mock('d3-force-3d', () => {
  const makeSim = () => ({
    numDimensions(n: number) { if (n === 3) _numDimensionsCalled = true; return this },
    force() { return this },
    on() { return this },
    stop() {},
    alpha() { return this },
    alphaTarget() { return this },
    restart() { return this },
  })
  return {
    forceSimulation: (nodes: any) => {
      _forceSimulationCalled = true
      return makeSim()
    },
    forceLink: () => ({ id: () => ({ strength: () => ({ distance() { return this } }) }), strength() { return this }, distance() { return this } }),
    forceManyBody: () => ({ strength() { return this } }),
    forceCenter: () => ({ strength() { return this } }),
  }
})

// ── Stub globals ───────────────────────────────────────────────────────────
vi.stubGlobal('ResizeObserver', vi.fn(() => ({
  observe: vi.fn(), disconnect: vi.fn(), unobserve: vi.fn(),
})))

// ── Lazy import ─────────────────────────────────────────────────────────────
let Graph3D: typeof import('@/components/graph/Graph3D').default

beforeEach(async () => {
  vi.useFakeTimers()
  resetMockState()

  const mod = await import('@/components/graph/Graph3D')
  Graph3D = mod.default

  useUIStore.setState({
    appState: 'main', centerTab: 'graph',
    selectedDocId: null, theme: 'dark', graphMode: '3d',
  })
  useGraphStore.setState({
    nodes: MOCK_NODES, links: MOCK_LINKS,
    selectedNodeId: null, hoveredNodeId: null,
    physics: { ...DEFAULT_PHYSICS },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('Graph3D — mount', () => {
  it('renders the container div with data-testid="graph-3d"', async () => {
    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(screen.getByTestId('graph-3d')).toBeInTheDocument()
  })

  it('creates a WebGLRenderer on mount', async () => {
    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(_webGLRendererCreated).toBe(true)
  })
})

describe('Graph3D — simulation', () => {
  it('initialises d3-force-3d simulation', async () => {
    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(_forceSimulationCalled).toBe(true)
  })

  it('calls numDimensions(3) for 3D simulation', async () => {
    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(100) })
    expect(_numDimensionsCalled).toBe(true)
  })
})

describe('Graph3D — click handling', () => {
  it('click with no raycaster hit does not change selectedNodeId', async () => {
    _intersectResult = []
    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    const canvas = screen.getByTestId('graph-3d').querySelector('canvas')!
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300 })
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 300 })
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })
    expect(useGraphStore.getState().selectedNodeId).toBeNull()
  })

  it('single click selects the hit node; double click opens it in the editor', async () => {
    // Nodes are drawn as instances of two InstancedMeshes (spheres for documents, octahedra for
    // images). The first non-image mock node is instance 0 of the sphere mesh.
    const firstNode = MOCK_NODES.find(n => !n.isImage)!

    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(_instancedMeshes.length).toBeGreaterThanOrEqual(1)
    _intersectResult = [{
      object: _instancedMeshes[0],
      instanceId: 0,
      point: { x: 0, y: 0, z: 0 },
    }]
    // The component listens on the WebGL canvas it appends to the container: pointerdown starts a
    // potential drag, pointerup ends it, and the browser's following click event (no movement in
    // between, so the drag guard stays clear) selects the node. A second click within 300ms is a
    // double-click and opens the document in the editor.
    const canvas = screen.getByTestId('graph-3d').querySelector('canvas')!
    fireEvent.pointerDown(canvas, { clientX: 400, clientY: 300 })
    fireEvent.pointerUp(canvas, { clientX: 400, clientY: 300 })
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })

    expect(useGraphStore.getState().selectedNodeId).toBe(firstNode.id)
    expect(useUIStore.getState().centerTab).not.toBe('editor')

    fireEvent.click(canvas, { clientX: 400, clientY: 300 })
    expect(useUIStore.getState().centerTab).toBe('editor')
    expect(useUIStore.getState().editingDocId).toBe(firstNode.id)
  })
})

