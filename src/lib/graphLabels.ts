/**
 * graphLabels.ts — pure helpers for the 3D graph's bounded label pool and geometry LOD.
 * Kept free of three.js so they can be unit-tested without a WebGL mock.
 */

/** Sphere tessellation for the instanced node geometry: fewer triangles as the graph grows. */
export function sphereSegmentsFor(nodeCount: number): [number, number] {
  if (nodeCount > 2500) return [10, 7]
  if (nodeCount > 800) return [14, 10]
  return [20, 14]
}

/**
 * Which nodes get a label when there are more nodes than labels. Hovered, selected and AI-highlighted
 * nodes always do; the rest of the pool goes to nodes in front of the camera, ranked by degree and
 * closeness (score = (degree + 1) / (distance + 50)), so hubs stay labelled from afar and the
 * neighbourhood the user is looking at gets labelled up close.
 */
export function chooseLabelledNodes(
  nodes: { id: string; deg: number; x: number; y: number; z: number }[],
  poolSize: number,
  camera: { position: { x: number; y: number; z: number }; forward: { x: number; y: number; z: number } },
  pinned: Iterable<string>,
): string[] {
  const chosen: string[] = []
  const taken = new Set<string>()
  for (const id of pinned) { if (id && !taken.has(id) && chosen.length < poolSize) { taken.add(id); chosen.push(id) } }
  if (nodes.length <= poolSize) {
    for (const n of nodes) if (!taken.has(n.id)) chosen.push(n.id)
    return chosen
  }
  const scored: { id: string; score: number }[] = []
  const { x: cx, y: cy, z: cz } = camera.position
  const { x: fx, y: fy, z: fz } = camera.forward
  for (const n of nodes) {
    if (taken.has(n.id)) continue
    const dx = n.x - cx, dy = n.y - cy, dz = n.z - cz
    if (dx * fx + dy * fy + dz * fz <= 0) continue          // behind the camera
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
    scored.push({ id: n.id, score: (n.deg + 1) / (dist + 50) })
  }
  scored.sort((a, b) => b.score - a.score)
  for (let i = 0; i < scored.length && chosen.length < poolSize; i++) chosen.push(scored[i].id)
  return chosen
}
