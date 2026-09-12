import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeServer } from './fakeServer.js'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const manager = require('../manager.cjs') as typeof import('../manager.cjs')

/** Reversible "encryption" standing in for Electron safeStorage. */
const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from([...Buffer.from(s, 'utf-8')].map(b => b ^ 0x5a)),
  decryptString: (b: Buffer) => Buffer.from([...b].map(x => x ^ 0x5a)).toString('utf-8'),
}

let dirs: string[] = []
let server: FakeServer
let sent: { channel: string; payload: unknown }[] = []
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d }

beforeEach(() => {
  server = new FakeServer('team-token')
  vi.stubGlobal('fetch', server.fetch)
  sent = []
})
afterEach(() => {
  manager.shutdown()
  vi.unstubAllGlobals()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs = []
})

function boot(userData: string, vault: string | null) {
  return manager.init({
    userDataDir: userData,
    safeStorage: fakeSafeStorage as unknown as Electron.SafeStorage,
    getVaultPath: () => vault,
    send: (channel, payload) => sent.push({ channel, payload }),
    log: () => {},
  })
}

describe('team sync manager', () => {
  it('starts idle with defaults and does not touch the network', async () => {
    await boot(tmp('ud-'), tmp('vault-'))
    const s = manager.getState()
    expect(s.config.enabled).toBe(false)
    expect(s.config.hasToken).toBe(false)
    expect(s.status.enabled).toBe(false)
    expect(server.calls).toEqual([])
  })

  it('persists config with the token encrypted, masks it when read back, and starts syncing', async () => {
    const ud = tmp('ud-'), vault = tmp('vault-')
    writeFileSync(join(vault, 'Hello.md'), '# hi')
    await boot(ud, vault)

    const state = await manager.updateConfig({ url: 'https://sync.test/', token: 'team-token', author: 'miro', enabled: true })
    expect(state.config.url).toBe('https://sync.test')          // trailing slash trimmed
    expect(state.config.token).toBe('••••oken')
    expect(state.config.hasToken).toBe(true)
    expect(state.status.enabled).toBe(true)
    expect(server.text('Hello.md')).toBe('# hi')

    const onDisk = JSON.parse(readFileSync(join(ud, 'team-sync.json'), 'utf-8'))
    expect(onDisk.token.startsWith('enc:')).toBe(true)
    expect(onDisk.token).not.toContain('team-token')

    // a masked token sent back from the UI must not overwrite the real one
    await manager.updateConfig({ token: '••••oken', author: 'miro2' })
    expect(manager.getState().config.hasToken).toBe(true)
    expect(manager.getState().config.author).toBe('miro2')
    expect(sent.some(m => m.channel === 'sync:status')).toBe(true)
  })

  it('reloads the encrypted token on the next start', async () => {
    const ud = tmp('ud-'), vault = tmp('vault-')
    await boot(ud, vault)
    await manager.updateConfig({ url: 'https://sync.test', token: 'team-token', enabled: false })
    manager.shutdown()

    await boot(ud, vault)
    expect(manager.getState().config.hasToken).toBe(true)
    const test = await manager.testConnection()
    expect(test.ok).toBe(true)
  })

  it('testConnection distinguishes a bad token from an unreachable server', async () => {
    await boot(tmp('ud-'), tmp('vault-'))
    expect((await manager.testConnection('https://sync.test', 'wrong')).error).toMatch(/token was rejected/)
    server.offline = true
    expect((await manager.testConnection('https://sync.test', 'team-token')).ok).toBe(false)
    expect((await manager.testConnection('', '')).error).toMatch(/URL is empty/)
  })

  it('search proxies to /v1/search and degrades to ok:false when off or unconfigured', async () => {
    await boot(tmp('ud-'), tmp('vault-'))
    expect((await manager.search('anything')).ok).toBe(false)
    await manager.updateConfig({ url: 'https://sync.test', token: 'team-token', enabled: true })
    // the fake server has no /v1/search → 404 → ok:false with a reason, never a throw
    const r = await manager.search('combat')
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/404/)
    expect(server.calls.some(c => c.startsWith('POST /v1/search'))).toBe(true)
  })

  it('follows the active vault and stays idle without one', async () => {
    const ud = tmp('ud-')
    let vault: string | null = null
    await manager.init({
      userDataDir: ud, safeStorage: fakeSafeStorage as unknown as Electron.SafeStorage,
      getVaultPath: () => vault, send: () => {}, log: () => {},
    })
    await manager.updateConfig({ url: 'https://sync.test', token: 'team-token', enabled: true })
    expect(manager.getState().status.enabled).toBe(false)     // enabled in config, but no vault

    vault = tmp('vault-'); writeFileSync(join(vault, 'A.md'), 'a')
    await manager.onVaultChanged()
    expect(manager.getState().status.enabled).toBe(true)
    expect(manager.getState().vaultPath).toBe(vault)
    expect(server.text('A.md')).toBe('a')
  })
})
