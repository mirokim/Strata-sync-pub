/**
 * personal.ts — the client side of personal documents. The server keeps a user's not-yet-shared
 * documents under `_personal/<owner>/…` and shows them to that user only; the app strips the
 * prefix so a personal document appears in its ordinary folder, with a flag, and puts the prefix
 * back on every write. Mirrors cloud/src/personal.ts — keep the two in step.
 */
export const PERSONAL_PREFIX = '_personal/'

/** Owner segment of a path: the OAuth sub, made safe for a path (same rule as the server). */
export function ownerSegment(sub: string): string {
  return sub.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'unknown'
}

export function personalRootFor(sub: string): string {
  return `${PERSONAL_PREFIX}${ownerSegment(sub)}/`
}

export function isPersonalPath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(PERSONAL_PREFIX)
}

/**
 * Maps between what the app sees (virtual paths) and what the server stores (physical paths)
 * for one owner. A personal document keeps its physical path in the app only when a team
 * document already occupies the same virtual path — the app cannot hold two files at one path.
 */
export class PersonalMapper {
  constructor(private readonly root: string | null, private readonly exists: (physical: string) => boolean) {}

  get enabled(): boolean { return this.root !== null }

  /** Physical → virtual. Team paths and other people's personal paths pass through unchanged. */
  virtualOf(physical: string): { path: string; personal: boolean } {
    if (this.root && physical.startsWith(this.root)) {
      const rest = physical.slice(this.root.length)
      if (rest && !this.exists(rest)) return { path: rest, personal: true }
      return { path: physical, personal: true }
    }
    return { path: physical, personal: false }
  }

  /** Virtual → physical: the personal copy when one exists, else the path as given. */
  physicalOf(virtual: string): string {
    if (!this.root || virtual.startsWith(PERSONAL_PREFIX)) return virtual
    const personal = this.root + virtual
    return this.exists(personal) ? personal : virtual
  }

  /** The personal path for a new document of this owner; null without a signed-in owner. */
  personalPath(virtual: string): string | null {
    return this.root ? this.root + virtual.replace(/^\/+/, '') : null
  }
}
