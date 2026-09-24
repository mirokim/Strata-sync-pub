/** Read-only live vault QA. Usage: node scripts/check-remote-mcp.mjs --from-claude
 * Or STRATA_MCP_URL + STRATA_TEAM_TOKEN (optional for an anonymous test server).
 * Uses the already authorized Claude project connection only with the explicit flag.
 * Never writes documents, sends inbox messages, or prints credentials/document bodies.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
const require = createRequire(new URL('../cloud/package.json', import.meta.url))
const { Client } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href)
const { StreamableHTTPClientTransport } = await import(pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href)
let url = process.env.STRATA_MCP_URL
let headers = process.env.STRATA_TEAM_TOKEN ? { Authorization: `Bearer ${process.env.STRATA_TEAM_TOKEN}` } : {}
if (process.argv.includes('--from-claude')) {
  const config = JSON.parse(await readFile(resolve(homedir(), '.claude.json'), 'utf8'))
  const project = Object.entries(config.projects ?? {}).find(([path, value]) => resolve(path).toLowerCase() === resolve(process.cwd()).toLowerCase() && value.mcpServers?.strata)?.[1]
  const server = project?.mcpServers?.strata
  assert(server?.url, 'No strata MCP connection in this Claude project')
  url = server.url; headers = server.headers ?? {}
}
assert(url, 'Set STRATA_MCP_URL or pass --from-claude')
const client = new Client({ name: 'strata-readonly-qa', version: '1.0.0' })
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 })
  assert(!result.isError, `${name} returned an error`)
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
  try { return JSON.parse(text) } catch { return text }
}
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }))
  const { tools } = await client.listTools()
  for (const name of ['vault_list', 'vault_read', 'vault_search', 'vault_recall']) assert(tools.some(t => t.name === name), `Missing ${name}`)
  console.log(`MCP connected: ${tools.length} tools`)
  const listing = await call('vault_list', { limit: 5 })
  assert(listing.items?.length > 0, 'Vault listing is empty')
  console.log(`Vault: ${listing.total} indexed documents`)
  const query = process.env.STRATA_TEST_QUERY ?? '소음'
  const search = await call('vault_search', { query, topK: 5 })
  assert(search.results?.length > 0, 'Search returned no documents')
  assert(search.results.some(r => `${r.title} ${r.snippet} ${r.path}`.includes(query)), 'Search hits did not contain the requested topic')
  const source = await call('vault_read', { path: search.results[0].path })
  assert(typeof source === 'string' && source.length > 0, 'Search result could not be read')
  const recall = await call('vault_recall', { query, seeds: 3, neighbours: 3, budget: 4000, format: 'json' })
  assert(recall.core?.length > 0 && recall.sources?.length > 0, 'Recall returned no evidence')
  assert(recall.core.some(r => `${r.title} ${r.excerpt} ${r.path}`.includes(query)), 'Recall evidence did not contain the requested topic')
  console.log('Read-only search and recall passed')
} finally { await client.close() }
