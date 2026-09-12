/**
 * Agent proposals on the app side — promote / discard files under `_agent/`.
 *
 * The rules (folder, frontmatter markers, promoted file name) live in the shared module so the
 * MCP `vault_promote` tool and this code cannot drift apart.
 */
import { isProposalPath, stripProposalFrontmatter, promotedPath, PROPOSAL_FOLDER } from '@shared/proposals'
import type { LoadedDocument } from '@/types'

export { isProposalPath, PROPOSAL_FOLDER }

export function isProposal(doc: LoadedDocument | undefined | null): boolean {
  return Boolean(doc && isProposalPath(doc.folderPath))
}

/** Frontmatter value of `proposed_source`, if present. */
export function proposalSource(doc: LoadedDocument): string {
  const m = /^proposed_source:\s*"?([^"\n]*)"?/m.exec(doc.rawContent ?? '')
  return m?.[1]?.trim() || 'agent'
}

/** Vault-relative path of a document (forward slashes). */
export function vaultRelativePath(doc: LoadedDocument, vaultPath: string): string {
  const abs = doc.absolutePath.replace(/\\/g, '/')
  const root = vaultPath.replace(/\\/g, '/').replace(/\/+$/, '')
  return abs.startsWith(root + '/') ? abs.slice(root.length + 1) : `${doc.folderPath ? doc.folderPath + '/' : ''}${doc.filename}`
}

export interface PromoteResult { newAbsolutePath: string; newRelativePath: string }

/**
 * Promote: write the stripped content to the destination, then delete the proposal.
 * Refuses to overwrite an existing file. Caller reloads the vault afterwards.
 */
export async function promoteProposal(doc: LoadedDocument, vaultPath: string, destFolder = ''): Promise<PromoteResult> {
  const api = window.vaultAPI
  if (!api) throw new Error('vault API unavailable')
  if (!isProposal(doc)) throw new Error('not a proposal')
  const rel = vaultRelativePath(doc, vaultPath)
  const newRel = promotedPath(rel, destFolder)
  const sep = vaultPath.includes('\\') ? '\\' : '/'
  const newAbs = `${vaultPath.replace(/[\\/]+$/, '')}${sep}${newRel.replace(/\//g, sep)}`
  if (await api.readFile(newAbs) !== null) throw new Error(`"${newRel}" already exists`)
  const content = await api.readFile(doc.absolutePath)
  if (content === null) throw new Error('proposal could not be read')
  await api.saveFile(newAbs, stripProposalFrontmatter(content))
  await api.deleteFile(doc.absolutePath)
  return { newAbsolutePath: newAbs, newRelativePath: newRel }
}

export async function discardProposal(doc: LoadedDocument): Promise<void> {
  const api = window.vaultAPI
  if (!api) throw new Error('vault API unavailable')
  if (!isProposal(doc)) throw new Error('not a proposal')
  await api.deleteFile(doc.absolutePath)
}
