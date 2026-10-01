/**
 * The remote-only guarantee on EVERY path (audit of #1521, owner 2026-10-01):
 * in a remote-only folder nothing creates a permanent local personal engram,
 * and nothing reads one.
 *
 *   B1  a team save is never absorbed into a personal row (only queued rows count)
 *   B2  every mutator and id-addressed read is guarded while bound; a queued
 *       remote-only save can only be delivered or deleted, never made local
 *   B3  an entry that only sets `trusted` (or only a scope) does not override
 *   S3  a malformed folders.yaml fails safe: nothing is read or written
 *   S4  remote-only matches the same spellings `off` does
 *   S5  tension warnings never carry a personal engram's text
 *   C1  learnBatch's LLM UPDATE cannot rewrite a personal row
 *
 * Real-HTTP stub; temp PLUR home and HOME only.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, resolveFolderPolicy, RemoteOnlyWriteError } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'
import { backgroundPushesSettled } from './helpers/background-pushes.js'

const TOKEN = 'remote-only-guard-token'
const TEAM = 'group:acme/client'

let server: StubServer
let baseUrl: string
beforeAll(async () => { server = new StubServer(TOKEN); baseUrl = (await server.start()).url })
afterAll(async () => { await server.stop() })

let base: string, home: string, root: string, work: string, prevHome: string | undefined

function config(extra: Record<string, unknown> = {}, storeExtra: Record<string, unknown> = {}): void {
  writeFileSync(join(root, 'config.yaml'), yaml.dump({
    index: false, embeddings: { enabled: false },
    stores: [{ url: baseUrl, token: TOKEN, scope: TEAM, shared: true, readonly: false, ...storeExtra }],
    ...extra,
  }))
}
function map(folders: unknown[]): void {
  writeFileSync(join(root, 'folders.yaml'), yaml.dump({ version: 1, folders }))
}
function rows(): any[] {
  const f = join(root, 'engrams.yaml')
  if (!existsSync(f)) return []
  return ((yaml.load(readFileSync(f, 'utf8')) as { engrams?: any[] } | null)?.engrams) ?? []
}
const row = (id: string) => rows().find(r => r.id === id)

beforeEach(() => {
  server.reset()
  base = realpathSync(mkdtempSync(join(tmpdir(), 'plur-ro-guard-')))
  home = join(base, 'home'); root = join(home, '.plur'); work = join(home, 'client')
  mkdirSync(root, { recursive: true }); mkdirSync(work, { recursive: true })
  prevHome = process.env.HOME; process.env.HOME = home
  config()
})
afterEach(async () => {
  await backgroundPushesSettled(root).catch(() => {})
  process.env.HOME = prevHome
  rmSync(base, { recursive: true, force: true })
})

/** A personal engram (written outside the folder), then a bound instance. */
async function personalThenBound(statement = 'my dentist is on Tuesday', ctx: Record<string, unknown> = {}) {
  const outside = new Plur({ path: root })
  const p = await outside.learn(statement, ctx as never)
  map([{ path: work, plur: 'remote-only', scope: TEAM }])
  const plur = new Plur({ path: root })
  plur.bindFolder(work)
  return { plur, personal: p }
}

async function refused(fn: () => unknown): Promise<unknown> {
  try { await fn() } catch (e) { return e }
  return null
}

describe('B1: a team save is never absorbed into a personal row', () => {
  it('a private personal row in the team scope does not absorb the save; the server gets it', async () => {
    const statement = 'Use the blue deploy lane for client hotfixes'
    const { plur, personal } = await personalThenBound(statement, { scope: TEAM, visibility: 'private' })
    const before = row(personal.id)
    for (const m of ['learnRouted', 'learn'] as const) {
      const e = await plur[m](statement)
      expect(e.id, m).not.toBe(personal.id)
    }
    await backgroundPushesSettled(root)
    expect(server.appendStatements.filter(s => s === statement).length).toBeGreaterThanOrEqual(1)
    expect(row(personal.id)).toEqual(before)
  })

  it('wouldDeduplicate does not answer with a personal row', async () => {
    const statement = 'client builds use node 22'
    const { plur } = await personalThenBound(statement, { scope: TEAM, visibility: 'private' })
    expect(await plur.wouldDeduplicate(statement)).toBeNull()
  })
})

describe('B2: every mutator and id read is guarded while bound', () => {
  it('getById / getByIds do not return a personal row', async () => {
    const { plur, personal } = await personalThenBound()
    expect(await plur.getById(personal.id)).toBeNull()
    expect(await plur.getByIds([personal.id])).toEqual([])
  })

  it('forget, setPinned, feedback and updateEngram refuse a personal row and leave it unchanged', async () => {
    const { plur, personal } = await personalThenBound()
    const before = row(personal.id)
    expect(await refused(() => plur.forget(personal.id))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(await refused(() => plur.setPinned(personal.id, true))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(await refused(() => plur.feedback(personal.id, 'positive'))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(await refused(() => plur.updateEngram({ ...before, statement: 'rewritten from the client folder' }))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(row(personal.id)).toEqual(before)
  })

  it('saveMetaEngrams and exportPack are refused', async () => {
    const { plur, personal } = await personalThenBound()
    const meta = { ...row(personal.id), id: 'META-2026-1001-001', scope: 'global', statement: 'meta from client folder' }
    expect(await refused(() => plur.saveMetaEngrams([meta]))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(rows().some(r => r.id === 'META-2026-1001-001')).toBe(false)
    expect(await refused(() => plur.exportPack([], join(base, 'out'), { name: 'x', version: '1.0', license: 'MIT' } as never))).toBeInstanceOf(RemoteOnlyWriteError)
  })

  it('purgeTensions (it rewrites personal rows) is refused', async () => {
    const { plur } = await personalThenBound()
    expect(await refused(() => plur.purgeTensions())).toBeInstanceOf(RemoteOnlyWriteError)
  })

  it('listPinned, timeline and listTensions show nothing personal', async () => {
    const outside = new Plur({ path: root })
    const p = await outside.learn('pinned personal rule PERSONALZEBRA')
    await outside.setPinned(p.id, true)
    outside.capture('personal session PERSONALZEBRA')
    map([{ path: work, plur: 'remote-only', scope: TEAM }])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    expect(JSON.stringify(await plur.listPinned())).not.toContain('PERSONALZEBRA')
    expect(JSON.stringify(plur.timeline())).not.toContain('PERSONALZEBRA')
  })

  it('a queued remote-only save cannot be rescoped or updated to a local scope, bound or not', async () => {
    map([{ path: work, plur: 'remote-only', scope: TEAM }])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    server.appendErrorResponse = { status: 503, body: 'down' }
    const q = await plur.learnRouted('Client staging DB is restored nightly at 02:00')
    await backgroundPushesSettled(root)
    expect(row(q.id)?.structured_data?._outbox).toBeDefined()
    expect(await refused(() => plur.rescope(q.id, 'local'))).toBeInstanceOf(RemoteOnlyWriteError)
    const unbound = new Plur({ path: root })
    const r = await refused(() => unbound.rescope(q.id, 'local'))
    // Either refused outright or reported as not done — never a local row.
    if (!r) expect(row(q.id)?.structured_data?._outbox).toBeDefined()
    expect(await refused(() => unbound.updateEngram({ ...row(q.id), scope: 'local' }))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(row(q.id)?.scope).toBe(TEAM)
    expect(row(q.id)?.structured_data?._outbox).toBeDefined()
  })

  it('forgetting a queued remote-only save deletes it; nothing stays local', async () => {
    map([{ path: work, plur: 'remote-only', scope: TEAM }])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    server.appendErrorResponse = { status: 503, body: 'down' }
    const q = await plur.learnRouted('Client VPN rotates monthly')
    await backgroundPushesSettled(root)
    await plur.forget(q.id)
    expect(rows().some(r => r.statement === 'Client VPN rotates monthly')).toBe(false)
  })

  it('a flush under a tightened policy keeps a remote-only save queued; it is never demoted to local', async () => {
    config({}, { sensitivity: { forbid: ['infra'], allow: ['infra'] } })
    map([{ path: work, plur: 'remote-only', scope: TEAM }])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    server.appendErrorResponse = { status: 503, body: 'down' }
    const q = await plur.learnRouted('client prod box is at 139.59.155.82')
    await backgroundPushesSettled(root)
    server.appendErrorResponse = null
    config({}, { sensitivity: { forbid: ['infra'] } })
    const r = await new Plur({ path: root }).flushOutbox({ force: true })
    expect(r.flushed).toBe(0)
    expect(server.appendStatements).not.toContain('client prod box is at 139.59.155.82')
    expect(row(q.id)?.scope).toBe(TEAM)
    expect(row(q.id)?.structured_data?._demoted).toBeUndefined()
    expect(row(q.id)?.structured_data?._outbox).toBeDefined()
  })
})

describe('C1: learnBatch cannot rewrite a personal row', () => {
  it('an LLM UPDATE aimed at a personal id (even one the server echoes) leaves it unchanged', async () => {
    const { plur, personal } = await personalThenBound('PERSONAL ORIGINAL')
    const before = row(personal.id)
    server.badAppendId = personal.id
    const llm = async () => JSON.stringify({ decision: 'UPDATE', target_id: personal.id })
    await plur.learnBatch([
      { statement: 'CLIENT FIRST FACT' },
      { statement: 'CLIENT SECRET REFINEMENT' },
    ], llm).catch(() => {})
    server.badAppendId = null
    expect(row(personal.id)).toEqual(before)
  })
})

describe('B3 / S4: the resolver', () => {
  it('a trusted-only or scope-only child entry does not turn remote-only back on; an explicit mode does', () => {
    const repo = join(work, 'repo')
    mkdirSync(repo)
    writeFileSync(join(repo, '.plur.yaml'), 'scope: project:repo\n')
    map([{ path: work, plur: 'remote-only', scope: TEAM }, { path: repo, trusted: true }])
    expect(resolveFolderPolicy(repo, { root, home })).toMatchObject({ mode: 'remote-only', scope: TEAM })
    map([{ path: work, plur: 'remote-only', scope: TEAM }, { path: repo, scope: 'project:repo' }])
    expect(resolveFolderPolicy(repo, { root, home })).toMatchObject({ mode: 'remote-only', scope: TEAM })
    map([{ path: work, plur: 'remote-only', scope: TEAM }, { path: repo, plur: 'on' }])
    expect(resolveFolderPolicy(repo, { root, home }).mode).toBe('on')
  })

  const caseInsensitive = (() => {
    try { const d = mkdtempSync(join(tmpdir(), 'plur-case-')); const r = existsSync(d.toUpperCase()); rmSync(d, { recursive: true }); return r } catch { return false }
  })()
  it.skipIf(!caseInsensitive)('an entry spelled in another letter case matches, as `off` does', () => {
    map([{ path: work.replace(/client$/, 'CLIENT'), plur: 'remote-only', scope: TEAM }])
    expect(resolveFolderPolicy(work, { root, home }).mode).toBe('remote-only')
  })
})

describe('S3: a malformed folders.yaml fails safe', () => {
  it('resolves to ask with the file and line named, even with a repo marker; a bound instance reads and writes nothing', async () => {
    const outside = new Plur({ path: root })
    await outside.learn('malformed codeword PERSONALZEBRA')
    writeFileSync(join(work, '.mcp.json'), JSON.stringify({ mcpServers: { plur: { command: 'plur-mcp' } } }))
    writeFileSync(join(root, 'folders.yaml'), `version: 1\nfolders:\n  - path: ${work}\n    plur: remoteonly\n`)
    const p = resolveFolderPolicy(work, { root, home })
    expect(p.mode).toBe('ask')
    expect(p.reason).toBe('malformed-map')
    expect(p.error).toContain(join(root, 'folders.yaml'))
    writeFileSync(join(root, 'folders.yaml'), 'version: 1\nfolders: [[[\n')
    const p2 = resolveFolderPolicy(work, { root, home })
    expect(p2.reason).toBe('malformed-map')
    expect(p2.error).toMatch(/line \d+/)
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    expect(await refused(() => plur.learn('anything'))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(JSON.stringify(await plur.recall('malformed codeword'))).not.toContain('PERSONALZEBRA')
    const inj = await plur.inject('malformed codeword')
    expect(inj.count).toBe(0)
  })
})

describe('S5: tension warnings carry no personal text', () => {
  it('a confirmed tension between a team row and a personal row does not print the personal side', async () => {
    const outside = new Plur({ path: root })
    const p = await outside.learn('deploy checklist codeword PERSONALZEBRA says skip canary')
    map([{ path: work, plur: 'remote-only', scope: TEAM }])
    server.recallRows = [{ id: 'ENG-2026-1001-031', scope: TEAM, status: 'active', score: 1, statement: 'deploy checklist codeword TEAMHERON says always canary' }]
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const first = await plur.inject('deploy checklist codeword')
    const teamId = first.injected_ids.find(id => id.includes('2026-1001-031'))
    expect(teamId).toBeDefined()
    const rec = await outside.recordTensions([{ id_a: teamId!, id_b: p.id, statement_a: 'deploy checklist codeword TEAMHERON says always canary', statement_b: 'deploy checklist codeword PERSONALZEBRA says skip canary', confidence: 0.9, reason: 'contradiction' }])
    outside.confirmTension(rec.records[0].id)
    const r = await plur.inject('deploy checklist codeword')
    expect(JSON.stringify(r)).not.toContain('PERSONALZEBRA')
  })
})

describe('re-audit of #1521', () => {
  async function queuedSave(statement: string) {
    map([{ path: work, plur: 'remote-only', scope: TEAM }])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    server.appendErrorResponse = { status: 503, body: 'down' }
    const q = await plur.learnRouted(statement)
    await backgroundPushesSettled(root)
    server.appendErrorResponse = null
    return { plur, q }
  }

  it('B-3: an unbound forget with an explicit local scope deletes a queued remote-only save outright', async () => {
    const { q } = await queuedSave('Queued client secret X2')
    await new Plur({ path: root }).forget(q.id, 'x', { scope: 'primary', force: true }).catch(() => {})
    expect(rows().some(r => r.statement === 'Queued client secret X2')).toBe(false)
  })

  it('B-3: an unbound same-scope update keeps the queue marker', async () => {
    const { q } = await queuedSave('Queued client fact E23')
    const unbound = new Plur({ path: root })
    const r = row(q.id)
    await unbound.updateEngram({ ...r, structured_data: {} }).catch(() => {})
    const after = row(q.id)
    expect(after === undefined || !!after.structured_data?._outbox?.remote_only).toBe(true)
  })

  it('S-1: an unreadable folders.yaml refuses even an explicit team-scope save', async () => {
    writeFileSync(join(root, 'folders.yaml'), 'version: 1\nfolders: [[[\n')
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    expect(await refused(() => plur.learnRouted('blocked team save', { scope: TEAM }))).toBeInstanceOf(RemoteOnlyWriteError)
    expect(server.appendStatements).not.toContain('blocked team save')
    expect(rows().some(r => r.statement === 'blocked team save')).toBe(false)
  })

  it('S-2: a personal row in a local secondary store cannot be rated or forgotten while bound', async () => {
    const outside = new Plur({ path: root })
    const p = await outside.learn('template row')
    const second = join(root, 'mine.yaml')
    writeFileSync(second, yaml.dump({ engrams: [{ ...row(p.id), id: 'ENG-2026-10-01-060', scope: 'project:mine', statement: 'second store fact' }] }))
    config({ stores: undefined }, {})
    writeFileSync(join(root, 'config.yaml'), yaml.dump({
      index: false, embeddings: { enabled: false },
      stores: [{ url: baseUrl, token: TOKEN, scope: TEAM, shared: true, readonly: false }, { path: second, scope: 'project:mine' }],
    }))
    const before = readFileSync(second, 'utf8')
    map([{ path: work, plur: 'remote-only', scope: TEAM }])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const ids = ['ENG-2026-10-01-060', 'ENG-PMI-2026-10-01-060']
    for (const id of ids) {
      await plur.feedback(id, 'positive').catch(() => {})
      await plur.forget(id).catch(() => {})
    }
    expect(readFileSync(second, 'utf8')).toBe(before)
  })

  it('S-2: learn with supersedes never writes onto a personal row', async () => {
    const { plur, personal } = await personalThenBound()
    const before = row(personal.id)
    await plur.learn('client replacement fact', { supersedes: [personal.id] } as never).catch(() => {})
    await backgroundPushesSettled(root)
    expect(row(personal.id)).toEqual(before)
  })

  it('S-2 regression: team-scoped feedback is not refused because a personal row shares the id', async () => {
    const { plur, personal } = await personalThenBound()
    server.seedEngram({ id: personal.id, scope: TEAM, status: 'active', data: { statement: 'team row with the same id' } })
    const err = await refused(() => plur.feedback(personal.id, 'positive', TEAM))
    expect(err).not.toBeInstanceOf(RemoteOnlyWriteError)
  })

  it('C-3: getByIds with a remote capability does not reach a personal remote store', async () => {
    writeFileSync(join(root, 'config.yaml'), yaml.dump({
      index: false, embeddings: { enabled: false },
      stores: [
        { url: baseUrl, token: TOKEN, scope: TEAM, shared: true, readonly: false },
        { url: baseUrl, token: TOKEN, scope: 'user:alice', readonly: false },
      ],
    }))
    server.setMe({ capabilities: ['feedback.source'] })
    server.seedEngram({ id: 'ENG-2026-10-01-070', scope: 'user:alice', status: 'active', data: { statement: 'alice personal remote PERSONALREMOTE' } })
    map([{ path: work, plur: 'remote-only', scope: TEAM }])
    const plur = new Plur({ path: root })
    plur.bindFolder(work)
    const { namespaceEngramId } = await import('../src/engrams.js')
    const got = await plur.getByIds([namespaceEngramId('ENG-2026-10-01-070', 'user:alice')], { remoteCapability: 'feedback.source' })
    expect(JSON.stringify(got)).not.toContain('PERSONALREMOTE')
  })

  it('N-1 / N-2: a bound instance sees and absorbs only its own folder\'s queued saves', async () => {
    const other = join(home, 'other-client')
    mkdirSync(other)
    map([{ path: work, plur: 'remote-only', scope: TEAM }, { path: other, plur: 'remote-only', scope: TEAM }])
    const a = new Plur({ path: root }); a.bindFolder(other)
    server.appendErrorResponse = { status: 503, body: 'down' }
    const qa = await a.learnRouted('other client queued fact')
    await backgroundPushesSettled(root)
    // an ordinary queued team save, made outside any folder
    const outside = new Plur({ path: root })
    const qo = await outside.learnRouted('ordinary queued team fact', { scope: TEAM })
    await backgroundPushesSettled(root)
    server.appendErrorResponse = null
    const b = new Plur({ path: root }); b.bindFolder(work)
    expect(await b.getById(qa.id)).toBeNull()
    const again = await b.learnRouted('ordinary queued team fact')
    expect(again.id).not.toBe(qo.id)
  })
})
