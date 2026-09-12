import { describe, it, expect } from 'vitest'
import { chooseLabelledNodes, sphereSegmentsFor, nextQualityLevel, strongestEdgeMask, edgeSubsetIndex, QUALITY_MAX } from '@/lib/graph3dQuality'

const cam = { position: { x: 0, y: 0, z: 100 }, forward: { x: 0, y: 0, z: -1 } }
const node = (id: string, deg: number, x = 0, y = 0, z = 0) => ({ id, deg, x, y, z })

describe('sphereSegmentsFor', () => {
  it('drops tessellation as the graph grows', () => {
    expect(sphereSegmentsFor(100)).toEqual([20, 14])
    expect(sphereSegmentsFor(1000)).toEqual([14, 10])
    expect(sphereSegmentsFor(3000)).toEqual([10, 7])
    expect(sphereSegmentsFor(5674)).toEqual([8, 6])
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

describe('nextQualityLevel', () => {
  it('steps down once when the median frame interval is slow, never up', () => {
    const slow = Array(60).fill(30)
    const fast = Array(60).fill(16)
    expect(nextQualityLevel(0, slow)).toBe(1)
    expect(nextQualityLevel(1, fast)).toBe(1)
    expect(nextQualityLevel(0, [])).toBe(0)
    // One spike does not move the median
    expect(nextQualityLevel(0, [...fast, 400])).toBe(0)
  })
  it('stops at the lowest level', () => {
    expect(nextQualityLevel(QUALITY_MAX, Array(60).fill(100))).toBe(QUALITY_MAX)
  })
})

describe('edge subset', () => {
  const strengths = [0.1, 0.9, 0.5, 0.7, 0.3]
  it('keeps the strongest fraction', () => {
    expect(Array.from(strongestEdgeMask(strengths, 0.4))).toEqual([0, 1, 0, 1, 0])
    expect(Array.from(strongestEdgeMask(strengths, 1))).toEqual([1, 1, 1, 1, 1])
    expect(Array.from(strongestEdgeMask(strengths, 0))).toEqual([0, 0, 0, 0, 0])
  })
  it('builds vertex pairs in link order and adds the must-keep links', () => {
    const mask = strongestEdgeMask(strengths, 0.4)
    expect(Array.from(edgeSubsetIndex(mask))).toEqual([2, 3, 6, 7])
    expect(Array.from(edgeSubsetIndex(mask, [4, 1, 99]))).toEqual([2, 3, 6, 7, 8, 9])
  })
})
