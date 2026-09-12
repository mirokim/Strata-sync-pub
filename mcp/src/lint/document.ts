/**
 * The slice of a vault document the graph core needs.
 *
 * `mcp/src/lint` is shared by the MCP server, the CLI and the Cloudflare Worker's nightly batch.
 * The MCP parser's LoadedDocument satisfies this structurally; the Worker builds it with the
 * dependency-free parser in `vaultDoc.ts` (no gray-matter, no fs).
 */
export interface LintDocument {
  /** Stable id derived from the vault-relative path (see docIdFromPath). */
  id: string
  /** Basename including extension, e.g. `Combat System.md`. */
  filename: string
  /** Vault-relative folder, forward slashes, '' at the root. */
  folderPath: string
  /** Last modification, ms since epoch. */
  mtime?: number
  tags: string[]
  /** Frontmatter `links:` — extra outgoing wikilink targets. */
  links: string[]
  /** Body split into sections; only `wikiLinks` is read by the graph core. */
  sections: { wikiLinks: string[] }[]
  /** Frontmatter `graph_weight`: 'skip' documents are never reported or linked. */
  graphWeight?: 'normal' | 'low' | 'skip'
}
