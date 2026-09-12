/**
 * PersonalMapper — the app-side translation between virtual (what the app shows) and physical
 * (what the server stores) paths of one owner's personal documents.
 */
import { describe, it, expect } from 'vitest'
import { PersonalMapper, personalRootFor, ownerSegment, isPersonalPath, PERSONAL_PREFIX } from '@/web/personal'

const ROOT = `${PERSONAL_PREFIX}1001/`
const mapper = (existing: string[], root: string | null = ROOT) => new PersonalMapper(root, p => existing.includes(p))

describe('personal path helpers', () => {
  it('sanitises owner segments the same way the server does', () => {
    expect(ownerSegment('1001')).toBe('1001')
    expect(ownerSegment('google|a b/c@d')).toBe('google-a-b-c-d')
    expect(ownerSegment('')).toBe('unknown')
    expect(ownerSegment('x'.repeat(100))).toHaveLength(80)
    expect(personalRootFor('a b')).toBe(`${PERSONAL_PREFIX}a-b/`)
    expect(isPersonalPath('_personal\\1001\\a.md')).toBe(true)
    expect(isPersonalPath('design/_personal/x.md')).toBe(false)
  })
})

describe('PersonalMapper.virtualOf', () => {
  it('strips the owner prefix, unless a team document already sits at the virtual path', () => {
    const m = mapper(['design/Stamina.md'])
    expect(m.virtualOf(`${ROOT}design/Draft.md`)).toEqual({ path: 'design/Draft.md', personal: true })
    expect(m.virtualOf(`${ROOT}design/Stamina.md`)).toEqual({ path: `${ROOT}design/Stamina.md`, personal: true })   // collision: keep the physical path
    expect(m.virtualOf('design/Stamina.md')).toEqual({ path: 'design/Stamina.md', personal: false })
  })

  it('passes other owners\' paths and the bare root through, and does nothing without an owner', () => {
    const m = mapper([])
    expect(m.virtualOf(`${PERSONAL_PREFIX}2002/design/X.md`)).toEqual({ path: `${PERSONAL_PREFIX}2002/design/X.md`, personal: false })
    expect(m.virtualOf(ROOT)).toEqual({ path: ROOT, personal: true })            // nothing after the prefix: nothing to strip
    const off = mapper([], null)
    expect(off.enabled).toBe(false)
    expect(off.virtualOf(`${ROOT}design/Draft.md`)).toEqual({ path: `${ROOT}design/Draft.md`, personal: false })
    expect(m.enabled).toBe(true)
  })
})

describe('PersonalMapper.physicalOf', () => {
  it('prefers the personal copy when one exists, otherwise leaves the path alone', () => {
    const m = mapper([`${ROOT}design/Draft.md`])
    expect(m.physicalOf('design/Draft.md')).toBe(`${ROOT}design/Draft.md`)
    expect(m.physicalOf('design/Stamina.md')).toBe('design/Stamina.md')
  })

  it('never double-prefixes a path that is already physical, even one it could not see', () => {
    const m = mapper([`${ROOT}design/Draft.md`, `${ROOT}${ROOT}design/Draft.md`])
    expect(m.physicalOf(`${ROOT}design/Draft.md`)).toBe(`${ROOT}design/Draft.md`)
    expect(m.physicalOf(`${PERSONAL_PREFIX}2002/x.md`)).toBe(`${PERSONAL_PREFIX}2002/x.md`)
    expect(mapper([`${ROOT}a.md`], null).physicalOf('a.md')).toBe('a.md')          // no owner: no personal copies to find
  })

  it('round-trips with virtualOf for a personal document', () => {
    const m = mapper([`${ROOT}design/Draft.md`])
    expect(m.physicalOf(m.virtualOf(`${ROOT}design/Draft.md`).path)).toBe(`${ROOT}design/Draft.md`)
  })

  // When a team document and the owner's personal copy share a virtual path, the personal copy
  // keeps its physical path in the app and the plain path always means the team document.
  it('round-trips with virtualOf when a team document collides with a personal copy', () => {
    const m = mapper(['design/Stamina.md', `${ROOT}design/Stamina.md`])
    expect(m.virtualOf(`${ROOT}design/Stamina.md`).path).toBe(`${ROOT}design/Stamina.md`)   // the personal copy keeps its physical path…
    expect(m.physicalOf('design/Stamina.md')).toBe('design/Stamina.md')                       // …so the plain path must stay the team document's
  })
})

describe('PersonalMapper.personalPath', () => {
  it('builds the owner path for a new document, dropping leading slashes; null without an owner', () => {
    const m = mapper([])
    expect(m.personalPath('ideas/Loot.md')).toBe(`${ROOT}ideas/Loot.md`)
    expect(m.personalPath('///ideas/Loot.md')).toBe(`${ROOT}ideas/Loot.md`)
    expect(m.personalPath('')).toBe(ROOT)
    expect(mapper([], null).personalPath('ideas/Loot.md')).toBeNull()
  })
})
