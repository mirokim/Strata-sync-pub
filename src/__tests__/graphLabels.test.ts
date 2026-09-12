import { describe, it, expect } from 'vitest'
import { chooseLabelledNodes, sphereSegmentsFor } from '@/lib/graphLabels'

const cam = { position: { x: 0, y: 0, z: 100 }, forward: { x: 0, y: 0, z: -1 } }
const node = (id: string, deg: number, x = 0, y = 0, z = 0) => ({ id, deg, x, y, z })

describe('sphereSegmentsFor', () => {
  it('drops tessellation as the graph grows', () => {
    expect(sphereSegmentsFor(100)).toEqual([20, 14])
    expect(sphereSegmentsFor(1000)).toEqual([14, 10])
    expect(sphereSegmentsFor(5674)).toEqual([10, 7])
  })
})

describe('chooseLabelledNodes', () => {
  it('labels every node when the pool is big enough', () => {
    const chosen = chooseLabelledNodes([node('a', 1), node('b', 0), node('c', 5)], 10, cam, [])
    expect(chosen.sort()).toEqual(['a', 'b', 'c'])
  })

  it('pinned nodes come first and are never duplicated', () => {
    const nodes = [node('a', 1), node('b', 0), node('c', 5)]
    expect(chooseLabelledNodes(nodes, 10, cam, ['c', 'c', ''])).toEqual(['c', 'a', 'b'])
    // Pinned nodes win even over a hub when the pool is tiny
    expect(chooseLabelledNodes(nodes, 1, cam, ['b'])).toEqual(['b'])
  })

  it('on a big graph prefers hubs and nearby nodes, ignoring what is behind the camera', () => {
    const nodes = [
      node('far-hub', 200, 0, 0, -800),
      node('near-leaf', 0, 0, 0, 90),      // 10 units in front of the camera
      node('mid-leaf', 0, 0, 0, 0),
      node('behind', 500, 0, 0, 300),      // behind the camera at z=100 looking down -z
      node('far-leaf', 0, 0, 0, -900),
    ]
    const chosen = chooseLabelledNodes(nodes, 2, cam, [])
    expect(chosen).toHaveLength(2)
    expect(chosen).toContain('near-leaf')
    expect(chosen).toContain('far-hub')
    expect(chosen).not.toContain('behind')
  })

  it('never exceeds the pool size', () => {
    const nodes = Array.from({ length: 500 }, (_, i) => node(`n${i}`, i % 7, i, 0, -i))
    expect(chooseLabelledNodes(nodes, 40, cam, ['n3'])).toHaveLength(40)
  })
})
