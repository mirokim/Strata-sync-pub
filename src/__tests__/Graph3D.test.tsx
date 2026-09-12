import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { useUIStore } from '@/stores/uiStore'
import { useGraphStore } from '@/stores/graphStore'
import { MOCK_NODES, MOCK_LINKS } from '@/data/mockGraph'
import { DEFAULT_PHYSICS } from '@/stores/graphStore'

// ── Configurable mock state (module-level variables updated per test) ───────
// Mock factories close over these; tests mutate them directly.
let _intersectResult: { object: any }[] = []
let _numDimensionsCalled = false
let _forceSimulationCalled = false
let _webGLRendererCreated = false
let _useFrameRateCalled = false

// Reset all state between tests
function resetMockState() {
  _intersectResult = []
  _numDimensionsCalled = false
  _forceSimulationCalled = false
  _webGLRendererCreated = false
  _useFrameRateCalled = false
}

// ── Mock Three.js ──────────────────────────────────────────────────────────
vi.mock('three', () => {
  class V3 {
    x = 0; y = 0; z = 0
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
    MeshBasicMaterial: class { opacity = 1; transparent = true; color = { setHex() {} }; dispose() {} },
    Object3D: class {
      position = new V3()
      scale = { setScalar(_s: number) {} }
      matrix = {}
      updateMatrix() {}
      add() {}
    },
    InstancedMesh: class {
      instanceMatrix = { setUsage() {}, needsUpdate: false }
      instanceColor = null
      count = 0
      setMatrixAt() {}
      setColorAt() {}
      getColorAt() {}
      dispose() {}
      constructor(_geo: any, _mat: any, count: number) { this.count = count }
    },
    DynamicDrawUsage: 35048,
    Color: class {
      r = 1; g = 1; b = 1
      constructor(_c?: any) {}
      set(_c: any) { return this }
      setHex(_h: number) { return this }
      getHex() { return 0xffffff }
    },
    LineBasicMaterial: class { dispose() {} },
    LineDashedMaterial: class { color = { setHex() {} }; dispose() {} },
    PointsMaterial: class { color = { setHex() {} }; dispose() {} },
    LineSegments: class {},
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
      intersectObjects(meshes: any[]) {
        if (_intersectResult.length > 0 && meshes.length > 0) {
          // Attach the actual first mesh so nodeIdFromHit can match sphereInstancedRef.current
          return _intersectResult.map(r => ({ ...r, object: meshes[0], instanceId: 0 }))
        }
        return _intersectResult
      }
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

// ── Mock useFrameRate ───────────────────────────────────────────────────────
vi.mock('@/hooks/useFrameRate', () => ({
  useFrameRate: () => { _useFrameRateCalled = true },
}))

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
  it('pointerdown with no raycaster hit does not change selectedNodeId', async () => {
    _intersectResult = []
    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    const el = screen.getByTestId('graph-3d')
    fireEvent.pointerDown(el, { clientX: 400, clientY: 300 })
    fireEvent.pointerUp(el, { clientX: 400, clientY: 300 })
    expect(useGraphStore.getState().selectedNodeId).toBeNull()
  })

  it('double-click on canvas with a raycaster hit opens editor', async () => {
    const firstNode = MOCK_NODES[0]
    _intersectResult = [{
      object: {},
      point: { x: 0, y: 0, z: 0 },
    }]

    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    const el = screen.getByTestId('graph-3d')
    // Events are bound to renderer.domElement (canvas), not the outer div.
    // First click: selects node + starts 300ms double-click timer.
    // Second click (before timer fires): treated as double-click → opens editor.
    const canvas = el.querySelector('canvas') ?? el
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })

    expect(useGraphStore.getState().selectedNodeId).toBe(firstNode.id)
    // Double-click calls openInEditor → centerTab becomes 'editor'
    expect(useUIStore.getState().centerTab).toBe('editor')
    expect(useUIStore.getState().editingDocId).toBe(firstNode.id)
  })
})

describe('Graph3D — graphMode routing', () => {
  it('mounts successfully with 3D graphMode (WebGLRenderer created)', async () => {
    render(<Graph3D width={800} height={600} />)
    await act(async () => { vi.advanceTimersByTime(50) })
    expect(_webGLRendererCreated).toBe(true)
  })

  it('setGraphMode("2d") switches store to 2D mode', () => {
    useUIStore.getState().setGraphMode('2d')
    expect(useUIStore.getState().graphMode).toBe('2d')
  })
})
