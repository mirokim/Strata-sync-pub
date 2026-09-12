import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, utimesSync, readdirSync, unlinkSync } from 'node:fs'
import fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeServer } from './fakeServer.js'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SyncEngine, isSyncable, conflictName } = require('../engine.cjs') as typeof import('../engine.cjs')

type Engine = InstanceType<typeof SyncEngine>

let server: FakeServer
let dirs: string[] = []
let clock = 1_800_000_000_000

/** Manual timers so the test decides when debounced pushes / scheduled pulls fire. */
class ManualTimers {
  pending: { fn: () => void; at: number; id: number }[] = []
  nextId = 1
  setTimeout = ((fn: () => void, ms: number) => { const id = this.nextId++; this.pending.push({ fn, at: clock + ms, id }); return id }) as unknown as typeof setTimeout
  clearTimeout = ((id: number) => { this.pending = this.pending.filter(p => p.id !== id) }) as unknown as typeof clearTimeout
  /** Fire every timer due by now (after advancing the clock). */
  async flush(advanceMs = 0) {
    clock += advanceMs
    const due = this.pending.filter(p => p.at <= clock).sort((a, b) => a.at - b.at)
    this.pending = this.pending.filter(p => p.at > clock)
    for (const p of due) p.fn()
    await new Promise(r => setImmediate(r))
  }
}

function newVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'strata-sync-test-'))
  dirs.push(d)
  return d
}

function write(vault: string, rel: string, text: string, mtimeMs = clock) {
  const file = join(vault, rel)
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, text, 'utf-8')
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
}
const read = (vault: string, rel: string) => readFileSync(join(vault, rel), 'utf-8')
const files = (vault: string) => readdirSync(vault).filter(f => !f.startsWith('.')).sort()

function makeEngine(vault: string, author: string, timers: ManualTimers): Engine {
  return new SyncEngine({
    vaultPath: vault,
    config: { url: 'https://sync.test', token: 'tok', author, pullIntervalMs: 30_000 },
    deps: { fs: fsp, fetch: server.fetch, now: () => clock, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, log: () => {} },
  })
}

/** Wait for the engine's internal queue to drain. */
const settle = (e: Engine) => (e as unknown as { queue: Promise<unknown> }).queue

beforeEach(() => { server = new FakeServer('tok'); clock = 1_800_000_000_000 })
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = [] })

describe('isSyncable / conflictName', () => {
  it('syncs markdown and images, never dot-folders or other types', () => {
    expect(isSyncable('active/[2026.01.28] 피드백.md')).toBe(true)
    expect(isSyncable('img/shot.PNG')).toBe(true)
    expect(isSyncable('.obsidian/workspace.json')).toBe(false)
    expect(isSyncable('.strata-sync/personas.md')).toBe(false)
    expect(isSyncable('.vector_cache_v6.json')).toBe(false)
    expect(isSyncable('notes/data.xlsx')).toBe(false)
    expect(isSyncable('a/../b.md')).toBe(false)
  })
  it('names conflict copies next to the file, Obsidian-friendly', () => {
    expect(conflictName('active/Combat.md', 'miro', Date.UTC(2026, 8, 12, 9, 5))).toMatch(/^active\/Combat \(conflict miro 2026-09-12 \d{4}\)\.md$/)
    expect(conflictName('a.md', 'we/ird:name', 0)).not.toMatch(/[/:]name/)
  })
})

describe('SyncEngine — first sync', () => {
  it('pushes a local-only vault to an empty server and records the index', async () => {
    const vault = newVault()
    write(vault, 'Combat.md', '# Combat')
    write(vault, 'notes/Story.md', '# Story')
    write(vault, '.obsidian/workspace.json', '{}')
    const t = new ManualTimers()
    const e = makeEngine(vault, 'miro', t)
    await e.start()

    expect(server.text('Combat.md')).toBe('# Combat')
    expect(server.text('notes/Story.md')).toBe('# Story')
    expect(server.blobs.objects.has('.obsidian/workspace.json')).toBe(false)
    expect(e.getStatus().pending).toBe(0)
    expect(e.getStatus().lastError).toBeNull()
    const state = JSON.parse(read(vault, '.strata-sync/sync-state.json'))
    expect(Object.keys(state.index).sort()).toEqual(['Combat.md', 'notes/Story.md'])
    e.stop()
  })

  it('pulls a populated server into an empty vault, preserving mtimes', async () => {
    const seed = newVault()
    write(seed, 'Design.md', '# Design', 1_700_000_000_000)
    const ts = new ManualTimers()
    const seeder = makeEngine(seed, 'dana', ts)
    await seeder.start(); seeder.stop()

    const vault = newVault()
    const t = new ManualTimers()
    const e = makeEngine(vault, 'miro', t)
    await e.start()
    expect(read(vault, 'Design.md')).toBe('# Design')
    expect(Math.floor((await fsp.stat(join(vault, 'Design.md'))).mtimeMs)).toBe(1_700_000_000_000)
    expect(e.getStatus().lastSeq).toBe(1)
    e.stop()
  })
})

describe('SyncEngine — two clients', () => {
  it('propagates an edit from one client to the other on the next pull', async () => {
    const a = newVault(), b = newVault()
    const ta = new ManualTimers(), tb = new ManualTimers()
    const ea = makeEngine(a, 'ann', ta), eb = makeEngine(b, 'bob', tb)
    write(a, 'Doc.md', 'v1')
    await ea.start(); await eb.start()
    expect(read(b, 'Doc.md')).toBe('v1')

    clock += 5_000
    write(a, 'Doc.md', 'v2 from ann')
    ea.noteLocalChange('Doc.md')
    await ta.flush(2_000)               // debounce fires → push
    await settle(ea)
    expect(server.text('Doc.md')).toBe('v2 from ann')

    await eb.syncNow()
    expect(read(b, 'Doc.md')).toBe('v2 from ann')
    expect(eb.getStatus().conflicts).toEqual([])
    ea.stop(); eb.stop()
  })

  it('keeps both versions when the same file was edited on both sides', async () => {
    const a = newVault(), b = newVault()
    const ta = new ManualTimers(), tb = new ManualTimers()
    const ea = makeEngine(a, 'ann', ta), eb = makeEngine(b, 'bob', tb)
    write(a, 'Doc.md', 'base')
    await ea.start(); await eb.start()

    clock += 5_000
    write(a, 'Doc.md', 'ann edit'); ea.noteLocalChange('Doc.md')
    await ta.flush(2_000); await settle(ea)
    expect(server.text('Doc.md')).toBe('ann edit')

    clock += 5_000
    write(b, 'Doc.md', 'bob edit'); eb.noteLocalChange('Doc.md')
    await tb.flush(2_000); await settle(eb)   // bob's push 409s → conflict copy

    expect(read(b, 'Doc.md')).toBe('ann edit')                  // server version takes the name
    const conflicts = files(b).filter(f => f.includes('conflict'))
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]).toMatch(/^Doc \(conflict bob /)
    expect(read(b, conflicts[0])).toBe('bob edit')               // nothing lost
    expect(eb.getStatus().conflicts[0].path).toBe('Doc.md')
    expect(eb.getStatus().conflicts[0].remoteAuthor).toBe('ann')

    // the conflict copy is itself pushed so ann sees it too
    await tb.flush(2_000); await settle(eb)
    await ea.syncNow()
    expect(files(a).some(f => f.includes('conflict bob'))).toBe(true)
    ea.stop(); eb.stop()
  })

  it('propagates deletions, but never deletes a file the other side edited meanwhile', async () => {
    const a = newVault(), b = newVault()
    const ta = new ManualTimers(), tb = new ManualTimers()
    const ea = makeEngine(a, 'ann', ta), eb = makeEngine(b, 'bob', tb)
    write(a, 'Gone.md', 'x'); write(a, 'Edited.md', 'x')
    await ea.start(); await eb.start()

    // ann deletes both
    unlinkSync(join(a, 'Gone.md')); unlinkSync(join(a, 'Edited.md'))
    ea.noteLocalChange('Gone.md'); ea.noteLocalChange('Edited.md')
    await ta.flush(2_000); await settle(ea)
    expect(server.text('Gone.md')).toBeNull()

    // bob had edited Edited.md before pulling the tombstone
    clock += 1_000
    write(b, 'Edited.md', 'bob kept working')
    await eb.syncNow()
    expect(existsSync(join(b, 'Gone.md'))).toBe(false)
    expect(read(b, 'Edited.md')).toBe('bob kept working')
    // and his version is re-published
    await tb.flush(2_000); await settle(eb)
    await eb.syncNow()
    expect(server.text('Edited.md')).toBe('bob kept working')
    ea.stop(); eb.stop()
  })
})

describe('SyncEngine — resilience', () => {
  it('survives the server being unreachable and catches up when it returns', async () => {
    const vault = newVault()
    const t = new ManualTimers()
    const e = makeEngine(vault, 'miro', t)
    write(vault, 'A.md', 'a')
    await e.start()

    server.offline = true
    write(vault, 'B.md', 'b'); e.noteLocalChange('B.md')
    await t.flush(2_000); await settle(e)
    expect(e.getStatus().pending).toBe(1)

    await e.syncNow()
    expect(e.getStatus().lastError).toMatch(/fetch failed/)

    server.offline = false
    await e.syncNow()
    expect(server.text('B.md')).toBe('b')
    expect(e.getStatus().pending).toBe(0)
    expect(e.getStatus().lastError).toBeNull()
    e.stop()
  })

  it('does not re-upload files that already match the server (204 path) and ignores its own pull writes', async () => {
    const seed = newVault(); write(seed, 'Same.md', 'same')
    const ts = new ManualTimers(); const s = makeEngine(seed, 'x', ts); await s.start(); s.stop()

    const vault = newVault(); write(vault, 'Same.md', 'same')
    const t = new ManualTimers(); const e = makeEngine(vault, 'y', t)
    await e.start()
    const puts = server.calls.filter(c => c.startsWith('PUT') && c.includes('Same.md'))
    // one 201 from the seeder; the second engine found matching content and only indexed it
    expect(puts.length).toBe(1)

    // watcher echo of a pulled write must not trigger a push
    server.calls = []
    e.noteLocalChange('Same.md')
    await new Promise(r => setImmediate(r))
    await t.flush(2_000); await settle(e)
    expect(server.calls.filter(c => c.startsWith('PUT'))).toEqual([])
    e.stop()
  })

  it('skips oversized files with an error instead of retrying forever', async () => {
    const vault = newVault()
    const t = new ManualTimers()
    const e = new SyncEngine({
      vaultPath: vault, config: { url: 'https://sync.test', token: 'tok', author: 'm', maxFileBytes: 10 },
      deps: { fs: fsp, fetch: server.fetch, now: () => clock, setTimeout: t.setTimeout, clearTimeout: t.clearTimeout, log: () => {} },
    })
    write(vault, 'Big.md', 'x'.repeat(100))
    await e.start()
    expect(e.getStatus().pending).toBe(0)
    expect(e.getStatus().errors[0].path).toBe('Big.md')
    expect(server.text('Big.md')).toBeNull()
    e.stop()
  })

  it('a pull does not skip other clients\' changes that landed while we were uploading', async () => {
    const a = newVault(), b = newVault()
    const ta = new ManualTimers(), tb = new ManualTimers()
    const ea = makeEngine(a, 'ann', ta), eb = makeEngine(b, 'bob', tb)
    await ea.start(); await eb.start()

    // bob uploads first (seq 1), then ann uploads (seq 2) without having pulled
    write(b, 'FromBob.md', 'bob'); eb.noteLocalChange('FromBob.md'); await tb.flush(2_000); await settle(eb)
    write(a, 'FromAnn.md', 'ann'); ea.noteLocalChange('FromAnn.md'); await ta.flush(2_000); await settle(ea)

    await ea.syncNow()
    expect(existsSync(join(a, 'FromBob.md'))).toBe(true)
    ea.stop(); eb.stop()
  })
})
