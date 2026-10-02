/**
 * Third re-audit of #1521 (owner, 2026-10-02): the hold on a queued remote-only
 * save is a property of the ROW, enforced where every writer writes.
 *
 *   R3-1  `primaryStore` stays the store passed in (identity, instanceof)
 *   R3-2  a queued save is never stripped of its queue entry or demoted: not
 *         by an update to a local-family scope that has a url store, not by
 *         procedure evolution, not by an LLM dedup update
 *   R3-3  never retargeted to a personal url store; a malformed queued row
 *         does not block saves in the folder
 *   R3-4  unscoped pin / feedback / forget never reach a personal url store
 *         from the folder
 *   R3-5  a rebind in the middle of a locked operation cannot empty the store
 *   one rule for "a deliverable team scope": shared, a writable url store, not
 *         a user: or local-family scope
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, RemoteOnlyWriteError, YamlPrimaryStore, MemoryPrimaryStore } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'reaudit3-token'
const TEAM = 'group:acme/client'

let server: StubServer
let baseUrl: string
beforeAll(async () => { server = new StubServer(TOKEN); baseUrl = (await server.start()).url })
afterAll(async () => { await server.stop() })

let base: string, home: string, root: string, work: string, prevHome: string | undefined
function config(extra: unknown[] = [], teamExtra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'config.yaml'), yaml.dump({
    index: false, embeddings: { enabled: false },
    stores: [{ url: baseUrl, token: TOKEN, scope: TEAM, shared: true, readonly: false, ...teamExtra }, ...extra],
  }))
}
function rows(): any[] {
  const f = join(root, 'engrams.yaml')
  if (!existsSync(f)) return []
  return ((yaml.load(readFileSync(f, 'utf8')) as { engrams?: any[] } | null)?.engrams) ?? []
}
const row = (id: string) => rows().find(r => r.id === id)
async function refused(fn: () => unknown): Promise<unknown> { try { await fn() } catch (e) { return e } return null }

beforeEach(() => {
  server.reset()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-r3-')))
  home = join(base, 'home'); root = join(home, '.plur'); work = join(home, 'client')
  mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
  prevHome = process.env.HOME; process.env.HOME = home
  config()
  writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders: [{ path: work, plur: 'remote-only', scope: TEAM }] }))
})
afterEach(async () => {
  await backgroundPushesSettled(root).catch(() => {})
  process.env.HOME = prevHome
  rmSync(base, { recursive: true, force: true })
})

async function queue(statement: string, ctx: Record<string, unknown> = {}) {
  const plur = new Plur({ path: root }); plur.bindFolder(work)
  server.appendErrorResponse = { status: 503, body: 'down' }
  const q = await plur.learnRouted(statement, ctx as never)
  await backgroundPushesSettled(root)
  server.appendErrorResponse = null
  return q
}
function stillQueued(id: string): void {
  const r = row(id)
  expect(r, `${id} gone`).toBeDefined()
  expect(r.scope).toBe(TEAM)
  expect(r.status).toBe('active')
  expect(r.structured_data?._outbox?.remote_only).toBe(true)
  expect(r.structured_data?._outbox?.target_scope).toBe(TEAM)
}

describe('R3-1: primaryStore is the store passed in', () => {
  it('keeps identity and class, unbound and bound', () => {
    const s = new YamlPrimaryStore(join(root, 'engrams.yaml'))
    const plur = new Plur({ path: root, store: s })
    expect(plur.primaryStore).toBe(s)
    expect(plur.primaryStore instanceof YamlPrimaryStore).toBe(true)
    plur.bindFolder(work)
    expect(plur.primaryStore).toBe(s)
  })
})

describe('R3-2 / R3-3: the hold is on the row, for every writer', () => {
  it('an update from outside to a local-family scope that has a url store is refused', async () => {
    const q = await queue('client fact for the global store')
    config([{ url: baseUrl, token: TOKEN, scope: 'global', readonly: false }])
    const outside = new Plur({ path: root })
    expect(await refused(() => outside.updateEngram({ ...row(q.id), scope: 'global' }))).toBeInstanceOf(RemoteOnlyWriteError)
    stillQueued(q.id)
  })

  it('a retarget to a personal url store is refused', async () => {
    const q = await queue('client fact not for user me')
    config([{ url: baseUrl, token: TOKEN, scope: 'user:me', readonly: false }])
    const outside = new Plur({ path: root })
    expect(await refused(() => outside.updateEngram({ ...row(q.id), scope: 'user:me' }))).toBeInstanceOf(RemoteOnlyWriteError)
    stillQueued(q.id)
  })

  it('procedure evolution never demotes a queued save', async () => {
    config([], { sensitivity: { forbid: ['infra'] } })
    const q = await queue('to deploy the client app run the release script', { type: 'procedural' })
    const outside = new Plur({ path: root })
    const llm = async () => 'to deploy the client app ssh to 139.59.155.82 and run the release script'
    await outside.reportFailure(q.id, 'the deploy failed', llm).catch(() => {})
    stillQueued(q.id)
    expect(row(q.id).statement).not.toContain('139.59.155.82')
  })

  it('an LLM dedup update from outside never demotes a queued save', async () => {
    config([], { sensitivity: { forbid: ['infra'] } })
    const q = await queue('client staging host is the blue box')
    const outside = new Plur({ path: root })
    const llm = async () => JSON.stringify({ decision: 'UPDATE', target_id: q.id })
    await outside.learnAsync('client staging host is the blue box at 139.59.155.82', { scope: TEAM, llm } as never).catch(() => {})
    stillQueued(q.id)
  })

  it('a malformed queued row does not block saves in the folder', async () => {
    const q = await queue('client fact that gets broken by hand')
    const all = rows()
    const r = all.find(x => x.id === q.id)
    r.scope = 'user:me'
    r.structured_data._outbox.target_scope = 'user:me'
    writeFileSync(join(root, 'engrams.yaml'), yaml.dump({ engrams: all }))
    const plur = new Plur({ path: root }); plur.bindFolder(work)
    // learn() writes the save locally (queued) before it pushes it.
    const e = await plur.learn('a new client fact after the broken row')
    await backgroundPushesSettled(root)
    expect(e.scope).toBe(TEAM)
    expect(server.appendStatements).toContain('a new client fact after the broken row')
  })
})

describe('R3-4: unscoped pin / feedback / forget never reach a personal url store', () => {
  it('leaves the personal remote row untouched', async () => {
    config([{ url: baseUrl, token: TOKEN, scope: 'user:me', readonly: false }])
    server.seedEngram({ id: 'ENG-2026-10-02-077', scope: 'user:me', status: 'active', data: { statement: 'my personal remote note' } })
    const plur = new Plur({ path: root }); plur.bindFolder(work)
    await plur.setPinned('ENG-2026-10-02-077', true).catch(() => {})
    await plur.feedback('ENG-2026-10-02-077', 'negative').catch(() => {})
    await plur.forget('ENG-2026-10-02-077', 'x').catch(() => {})
    const s = server.getEngram('ENG-2026-10-02-077')!
    expect(s.status).toBe('active')
    expect((s.data as any).pinned).not.toBe(true)
    expect(server.feedbackBodies).toEqual([])
  })
})

describe('R3-5: a rebind during a locked operation', () => {
  it('cannot empty the store', async () => {
    const seed = new Plur({ path: root })
    // A store with whole-corpus saves only (like YAML), so a write after the
    // rebind would replace everything with what the guard had let through.
    const inner = new MemoryPrimaryStore()
    const mem: any = {
      kind: 'memory', location: null, refusesUnreadable: true,
      load: () => inner.load(), loadCached: () => inner.loadCached(),
      save: (rows: any[], o?: any) => inner.save(rows, o), invalidate: () => inner.invalidate(),
    }
    const plur = new Plur({ path: root, store: mem })
    for (let i = 0; i < 12; i++) await plur.learn(`personal memory number ${i}`, { scope: 'global' })
    plur.bindFolder(work)
    server.appendErrorResponse = { status: 503, body: 'down' }
    await plur.learnRouted('client save for the rebind test')
    server.appendErrorResponse = null
    // The flush's merge-back read (its third full load on this head, taken
    // under the store lock) unbinds the instance right after it returns, as a
    // concurrent call from another workspace could. The write that follows
    // must still go through the binding the locked operation started with.
    const origLoad = mem.load.bind(mem)
    let loads = 0
    mem.load = async () => {
      const r = await origLoad()
      if (++loads === 3) plur.bindFolderPolicy(home, { mode: 'ask', remoteAllowed: false, source: 'default' })
      return r
    }
    await plur.flushOutbox({ force: true }).catch(() => {})
    const left = (await inner.load()).filter(e => e.statement.startsWith('personal memory number'))
    expect(left.length).toBe(12)
    void seed
  })
})
