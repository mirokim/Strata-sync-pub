import { beforeEach, expect, it } from 'vitest'
import { MemoryMeta, MemoryBlobs, enc } from './fakes.js'
import { putFile, deleteFile } from '../src/sync.js'
import { callTool, type McpDeps } from '../src/mcp.js'
import { invalidateVaultView } from '../src/vaultIndex.js'

// Small deterministic Korean corpus: CI always checks these contracts without a live vault.
const corpus = [
  ['결정/저소음 목표.md', '# 저소음 목표\n\n야간 소음 목표는 45 dBA로 결정했다. 팬 회전수를 낮춘다. 근거: [[야간 소음 시험]].'],
  ['시험/야간 소음 시험.md', '# 야간 소음 시험\n\n침실 야간 소음 측정에서 팬 회전수를 낮추면 소음이 줄었다. [[저소음 목표]]를 검증한다.'],
  ['설계/배터리 보호.md', '# 배터리 보호\n\n충전 온도 센서로 과열을 방지하고 충전을 중단한다.'],
  ['_personal/alice/비공개 소음.md', '# 비공개 소음\n\n비밀소음표식: 아직 공개하지 않은 개인 실험.'],
]
let deps: McpDeps
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await callTool(deps, name, args)
  expect(r.isError).not.toBe(true)
  return JSON.parse((r.content[0] as { text: string }).text)
}
beforeEach(async () => {
  invalidateVaultView()
  deps = { meta: new MemoryMeta(), blobs: new MemoryBlobs(), maxFileBytes: 100_000, author: 'qa', viewer: { sub: 'service', service: true } }
  for (const [path, text] of corpus) await putFile(deps, { path, body: enc(text), mtime: 1000, author: 'qa' })
})

it('ranks Korean topic matches above unrelated documents', async () => {
  const r = await call('vault_search', { query: '야간 소음', topK: 3 })
  expect(r.results.length).toBeGreaterThan(0)
  expect(r.results[0].path).toMatch(/소음/)
  expect(r.results.some((d: { path: string }) => d.path === '설계/배터리 보호.md')).toBe(false)
})
it('recalls linked evidence with source paths and no private content', async () => {
  const r = await call('vault_recall', { query: '저소음 목표', seeds: 1, neighbours: 3, format: 'json' })
  expect(r.core.length).toBe(1)
  expect(r.sources).toContain('결정/저소음 목표.md')
  expect(r.sources).toContain('시험/야간 소음 시험.md')
  expect(JSON.stringify(r)).not.toContain('비밀소음표식')
})
it('removes deleted documents from subsequent searches', async () => {
  await call('vault_search', { query: '배터리 보호' })
  await deleteFile(deps, '설계/배터리 보호.md', undefined, 'qa')
  const r = await call('vault_search', { query: '배터리 보호' })
  expect(r.results.some((d: { path: string }) => d.path === '설계/배터리 보호.md')).toBe(false)
})
