/**
 * A small, deliberately shaped vault for lint tests.
 *
 *   combat cluster:    Combat System ─ Skill Design ─ Damage Formula ─ Hitbox   (dense)
 *   narrative cluster: Story Outline ─ Character A ─ Character B ─ World Lore    (dense)
 *   Design Pillars     links Combat System + Story Outline only  → thin community bridge (2 links)
 *   World Lore ─ Hitbox  second path between the clusters, so Design Pillars is not a cut vertex
 *   Combat Index       hangs three leaf notes off the combat cluster → articulation point (strands 3);
 *                      reached from two cluster docs so neither of them becomes a cut vertex
 *   "Enemy AI Spec"    linked from 4 documents, does not exist   → phantom-hot
 *   "Minor Todo"       linked once                               → below threshold
 *   Random Note        no links                                  → orphan
 *   Broken Note        links only to a missing document          → orphan with unresolved link
 *   Character A Copy   exists, unlinked to Character A           → near-duplicate (via similarPairs)
 *   _reports/Lint Old  orphan inside an ignored folder           → not reported
 */
import { parseVaultFile, type LoadedDocument, type VaultFile } from '../../parser.js'

export const NOW = Date.parse('2026-09-12T00:00:00Z')
const DAY = 24 * 60 * 60 * 1000

interface Spec { name: string; folder?: string; body: string; ageDays?: number; frontmatter?: string }

const SPECS: Spec[] = [
  { name: 'Combat System', ageDays: 200, body: 'Core loop. See [[Skill Design]], [[Damage Formula]], [[Hitbox]], [[Enemy AI Spec]] and [[Combat Index]].' },
  { name: 'Skill Design', body: 'Skills. [[Combat System]] [[Damage Formula]] [[Hitbox]] [[Enemy AI Spec]]' },
  { name: 'Damage Formula', body: 'Numbers. [[Combat System]] [[Skill Design]] [[Hitbox|hitboxes]]' },
  { name: 'Hitbox', body: 'Shapes. [[Combat System#Loop]] [[Skill Design]] [[Damage Formula]] [[Enemy AI Spec]] [[Minor Todo]]' },

  { name: 'Story Outline', body: 'Acts. [[Character A]] [[Character B]] [[World Lore]]' },
  { name: 'Character A', body: 'Protagonist. [[Story Outline]] [[Character B]] [[World Lore]]' },
  { name: 'Character B', body: 'Rival. [[Story Outline]] [[Character A]] [[World Lore]]' },
  { name: 'World Lore', body: 'Setting. [[Story Outline]] [[Character A]] [[Character B]] [[Hitbox]]' },

  { name: 'Design Pillars', body: 'Pillars. [[Combat System]] [[Story Outline]] [[Enemy AI Spec]]' },

  { name: 'Combat Index', body: 'Index. [[Combat System]] [[Skill Design]] [[Legacy Combat Notes]] [[Old Balance Sheet]] [[Old SFX List]]' },
  { name: 'Legacy Combat Notes', body: 'Old. [[Combat Index]]' },
  { name: 'Old Balance Sheet', body: 'Old. [[Combat Index]]' },
  { name: 'Old SFX List', body: 'Old. [[Combat Index]]' },

  { name: 'Random Note', body: 'Nothing links here and this links nowhere.' },
  { name: 'Broken Note', body: 'Points at [[Nowhere]] only.' },
  { name: 'Character A Copy', body: 'Protagonist duplicate text.' },
  { name: 'Lint Old', folder: '_reports', body: 'Yesterday\'s report.' },
]

export function fixtureDocs(overrides: Partial<Record<string, Partial<Spec>>> = {}): LoadedDocument[] {
  return SPECS.map(spec => {
    const merged = { ...spec, ...(overrides[spec.name] ?? {}) }
    const rel = merged.folder ? `${merged.folder}/${merged.name}.md` : `${merged.name}.md`
    const file: VaultFile = {
      relativePath: rel,
      absolutePath: `/vault/${rel}`,
      content: `${merged.frontmatter ?? '---\ntags: [test]\n---'}\n\n# ${merged.name}\n\n${merged.body}\n`,
      mtime: NOW - (merged.ageDays ?? 3) * DAY,
    }
    return parseVaultFile(file)
  })
}

/** docId of a fixture document by its display name. */
export function idOf(docs: LoadedDocument[], name: string): string {
  const d = docs.find(x => x.filename === `${name}.md`)
  if (!d) throw new Error(`no fixture doc ${name}`)
  return d.id
}
