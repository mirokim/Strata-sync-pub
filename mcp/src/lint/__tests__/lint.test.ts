import { describe, it, expect } from 'vitest'
import { runLint, reportToMarkdown, normalizeWikiLink, articulationPoints, detectCommunities, buildLintGraph } from '../index.js'
import { fixtureDocs, idOf, NOW } from './fixtureVault.js'

const adj = (edges: [string, string][]): Map<string, Set<string>> => {
  const m = new Map<string, Set<string>>()
  for (const [a, b] of edges) {
    if (!m.has(a)) m.set(a, new Set()); if (!m.has(b)) m.set(b, new Set())
    m.get(a)!.add(b); m.get(b)!.add(a)
  }
  return m
}

describe('normalizeWikiLink', () => {
  it('strips alias, heading, block ref, folder and extension', () => {
    expect(normalizeWikiLink('Combat System')).toBe('combat system')
    expect(normalizeWikiLink(' Design/Combat System|the loop ')).toBe('combat system')
    expect(normalizeWikiLink('Combat System#Loop')).toBe('combat system')
    expect(normalizeWikiLink('Combat System^abc12')).toBe('combat system')
    expect(normalizeWikiLink('Combat System.md')).toBe('combat system')
  })
})

describe('articulationPoints', () => {
  it('finds the middle of a path and nothing in a cycle', () => {
    const path = articulationPoints(adj([['a', 'b'], ['b', 'c'], ['c', 'd']]))
    expect([...path.keys()].sort()).toEqual(['b', 'c'])
    expect(path.get('b')!.pieces).toEqual([2, 1])
    const cycle = articulationPoints(adj([['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'a']]))
    expect(cycle.size).toBe(0)
  })
  it('a star centre strands every leaf', () => {
    const star = articulationPoints(adj([['hub', 'x'], ['hub', 'y'], ['hub', 'z']]))
    expect([...star.keys()]).toEqual(['hub'])
    expect(star.get('hub')!.pieces).toEqual([1, 1, 1])
  })
  it('handles the DFS root being a cut vertex regardless of id order', () => {
    // 'a' sorts first and is the cut vertex between b and c
    const g = articulationPoints(adj([['a', 'b'], ['a', 'c']]))
    expect([...g.keys()]).toEqual(['a'])
  })
})

describe('detectCommunities', () => {
  it('splits two cliques joined by a single edge', () => {
    const edges: [string, string][] = []
    const A = ['a1', 'a2', 'a3', 'a4'], B = ['b1', 'b2', 'b3', 'b4']
    for (const g of [A, B]) for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) edges.push([g[i], g[j]])
    edges.push(['a1', 'b1'])
    const res = detectCommunities(adj(edges))
    expect(res.communities.length).toBe(2)
    expect(new Set(A.map(x => res.membership.get(x))).size).toBe(1)
    expect(new Set(B.map(x => res.membership.get(x))).size).toBe(1)
    expect(res.membership.get('a1')).not.toBe(res.membership.get('b1'))
    expect(res.modularity).toBeGreaterThan(0.3)
  })
  it('is deterministic', () => {
    const edges: [string, string][] = [['a', 'b'], ['b', 'c'], ['c', 'a'], ['d', 'e'], ['e', 'f'], ['f', 'd'], ['c', 'd']]
    const r1 = detectCommunities(adj(edges)), r2 = detectCommunities(adj(edges))
    expect(r1.communities).toEqual(r2.communities)
  })
  it('handles an empty graph and isolated nodes', () => {
    expect(detectCommunities(new Map()).communities).toEqual([])
    const iso = detectCommunities(new Map([['x', new Set<string>()], ['y', new Set<string>()]]))
    expect(iso.communities.length).toBe(2)
  })
})

describe('buildLintGraph', () => {
  it('resolves links case-insensitively with aliases and records phantoms with referrers', () => {
    const docs = fixtureDocs()
    const g = buildLintGraph(docs)
    expect(g.adjacency.get(idOf(docs, 'Damage Formula'))!.has(idOf(docs, 'Hitbox'))).toBe(true)  // [[Hitbox|hitboxes]]
    expect(g.adjacency.get(idOf(docs, 'Hitbox'))!.has(idOf(docs, 'Combat System'))).toBe(true)   // [[Combat System#Loop]]
    expect(g.phantoms.get('enemy ai spec')!.size).toBe(4)
    expect(g.phantoms.get('minor todo')!.size).toBe(1)
    expect(g.phantoms.has('nowhere')).toBe(true)
  })
})

describe('runLint — fixture vault', () => {
  const docs = fixtureDocs()
  const report = runLint({ docs }, { now: NOW })
  const byRule = (rule: string) => report.findings.filter(f => f.rule === rule)

  it('reports the hot phantom and not the one-off', () => {
    const phantoms = byRule('phantom-hot')
    expect(phantoms.map(f => f.title)).toEqual(['Enemy AI Spec'])
    expect(phantoms[0].severity).toBe('error')
    expect(phantoms[0].evidence.referrerCount).toBe(4)
    expect(phantoms[0].evidence.referrers).toContain('Design Pillars')
  })

  it('flags Combat Index as a single point of failure stranding three notes', () => {
    const spof = byRule('bridge-spof').find(f => f.docId === idOf(docs, 'Combat Index'))
    expect(spof).toBeDefined()
    expect(spof!.severity).toBe('error')
    expect(spof!.evidence.strandedDocs).toBe(3)
  })

  it('flags Design Pillars as a thin bridge between two clusters', () => {
    const bridge = byRule('bridge-spof').find(f => f.docId === idOf(docs, 'Design Pillars'))
    expect(bridge).toBeDefined()
    expect(bridge!.severity).toBe('warn')
    expect(bridge!.evidence.clustersJoined).toBe(2)
  })

  it('does not call leaf notes single points of failure', () => {
    expect(byRule('bridge-spof').some(f => f.docId === idOf(docs, 'Old SFX List'))).toBe(false)
  })

  it('reports orphans, distinguishes broken links, and skips ignored folders', () => {
    const orphans = byRule('orphan')
    const titles = orphans.map(f => f.title).sort()
    expect(titles).toEqual(['Broken Note', 'Character A Copy', 'Random Note'])
    expect(orphans.find(f => f.title === 'Broken Note')!.evidence.unresolvedLinks).toBe(1)
    expect(report.findings.some(f => f.title === 'Lint Old')).toBe(false)
  })

  it('flags the old hub and leaves fresh hubs alone', () => {
    const stale = byRule('stale-hub')
    expect(stale.map(f => f.title)).toEqual(['Combat System'])
    expect(stale[0].evidence.ageDays).toBe(200)
  })

  it('skips rules that need inputs the caller did not provide', () => {
    expect(report.skipped.map(s => s.rule).sort()).toEqual(['cluster-drift', 'near-duplicate'])
    expect(report.rulesRun).not.toContain('near-duplicate')
  })

  it('orders findings by severity then score and fills the summary', () => {
    expect(report.findings[0].severity).toBe('error')
    const sev = report.findings.map(f => f.severity)
    expect(sev.indexOf('warn')).toBeGreaterThan(sev.lastIndexOf('error'))
    expect(report.summary.bySeverity.error).toBe(2)
    expect(report.summary.byRule['orphan']).toBe(3)
    expect(report.communityCount).toBeGreaterThanOrEqual(2)
    expect(report.snapshot.communities.flat().length).toBe(docs.length)
  })
})

describe('runLint — optional inputs', () => {
  const docs = fixtureDocs()

  it('near-duplicate uses supplied pairs and ignores already-linked ones', () => {
    const a = idOf(docs, 'Character A'), copy = idOf(docs, 'Character A Copy'), b = idOf(docs, 'Character B')
    const report = runLint({ docs, similarPairs: [
      { docA: a, docB: copy, similarity: 0.95 },
      { docA: a, docB: b, similarity: 0.97 },      // linked → not a finding
      { docA: a, docB: copy, similarity: 0.5 },    // below threshold
    ] }, { now: NOW, rules: ['near-duplicate'] })
    expect(report.findings.length).toBe(1)
    expect(report.findings[0].title).toBe('Character A ↔ Character A Copy')
  })

  it('cluster-drift compares against a previous snapshot', () => {
    const first = runLint({ docs }, { now: NOW })
    const same = runLint({ docs, previousSnapshot: first.snapshot }, { now: NOW, rules: ['cluster-drift'] })
    expect(same.findings).toEqual([])

    // A community that mixed combat and narrative docs no longer exists in that shape
    const scrambled = { ...first.snapshot, communities: [[
      idOf(docs, 'Combat System'), idOf(docs, 'Skill Design'), idOf(docs, 'Story Outline'), idOf(docs, 'Character A'), idOf(docs, 'World Lore'),
    ].sort()] }
    const drift = runLint({ docs, previousSnapshot: scrambled }, { now: NOW, rules: ['cluster-drift'] })
    expect(drift.findings.length).toBe(1)
    expect(drift.findings[0].evidence.previousSize).toBe(5)
  })

  it('respects minSeverity, rules and limitPerRule', () => {
    const report = runLint({ docs }, { now: NOW, minSeverity: 'error' })
    expect(report.findings.every(f => f.severity === 'error')).toBe(true)
    const limited = runLint({ docs }, { now: NOW, rules: ['orphan'], limitPerRule: 1 })
    expect(limited.findings.length).toBe(1)
    expect(limited.rulesRun).toEqual(['orphan'])
  })

  it('never reports graph_weight: skip documents', () => {
    const withSkip = fixtureDocs({ 'Random Note': { frontmatter: '---\ngraph_weight: skip\n---' } })
    const report = runLint({ docs: withSkip }, { now: NOW, rules: ['orphan'] })
    expect(report.findings.some(f => f.title === 'Random Note')).toBe(false)
  })
})

describe('reportToMarkdown', () => {
  it('renders every rule section with wikilinked titles', () => {
    const docs = fixtureDocs()
    const md = reportToMarkdown(runLint({ docs }, { now: NOW }), { title: 'Nightly lint' })
    expect(md.startsWith('# Nightly lint — 2026-09-12')).toBe(true)
    expect(md).toContain('## Missing documents that are already linked (1)')
    expect(md).toContain('[[Enemy AI Spec]]')
    expect(md).toContain('[[Combat Index]]')
    expect(md).toContain('Skipped: near-duplicate')
  })
})
