// PRV-7: Moving a memory to another scope keeps a usable copy and its history,
// and a preview or a failed move changes nothing.
//
// Driven through the engine (`rescope`, what `plur rescope` and the MCP
// plur_rescope tool call), with a preview also run through the CLI and the MCP
// tool. A stub team server is mounted for the team scope.
//  - A move to a local scope keeps the memory (same text, findable in its new
//    scope) and its history, with the move recorded.
//  - A move to the team scope leaves a copy on the team server, links the
//    retired original to it, and records the move in the original's history.
//  - A preview (dry run) changes no file and sends nothing.
//  - A move that cannot be written (team server down), or that is blocked
//    because the memory carries a secret, changes nothing.
//  - When the team server hands back an id that a different local memory
//    already has, that other memory is untouched.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Plur } from '../../packages/core/src/index.js'
import {
  resetTeamStub, startTeamStub, teamStore, TEAM_SCOPE, type TeamStore, type TeamStub,
} from '../helpers/privacy-folders-team-stub.js'
import { callTool, connectMcp, offlineFetch, writeFolderMap } from '../helpers/privacy-folders-team-mcp.js'
import { hookHome, runSource, type HookHome } from '../helpers/agent-tools-hooks-cli.js'

const FACT = 'release notes are drafted on the Monday before each release'
const SECRET = 'the staging database is reached at https://admin:Hunter2-Staging@db.example.com/main'
const LOCAL_TARGET = 'project:releases'

const storeBytes = (dir: string) => readFileSync(join(dir, 'engrams.yaml'), 'utf8')
const events = (p: Plur, id: string) => p.getEngramHistory(id).map(e => String(e.event))

describe('PRV-7 moving a memory keeps a usable copy and its history; a preview or a failed move changes nothing', () => {
  let t: TeamStub
  let s: TeamStore | undefined
  let h: HookHome | undefined
  let net: ReturnType<typeof offlineFetch> | undefined
  const dirs: string[] = []
  const closers: Array<() => Promise<void>> = []
  beforeAll(async () => { t = await startTeamStub() })
  afterAll(async () => { await t.stop(); for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
  beforeEach(() => resetTeamStub(t))
  afterEach(async () => {
    vi.restoreAllMocks()
    for (const c of closers.splice(0)) await c()
    net?.restore(); net = undefined
    s?.cleanup(); s = undefined
    h?.cleanup(); h = undefined
  })

  it('a move to a local scope keeps the memory, findable there, with its history', async () => {
    s = await teamStore(t.url)
    const m = await s.plur.learn(FACT, { scope: 'global' })
    const r = await s.plur.rescope(m.id, LOCAL_TARGET)
    expect(r.results[0]?.status, `expected the move to succeed; got ${JSON.stringify(r.results)}`).toBe('rescoped')
    const moved = (await s.plur.list()).find(e => e.statement === FACT)
    expect(moved?.scope, 'expected the memory to be in its new scope').toBe(LOCAL_TARGET)
    expect(moved?.status ?? 'active', 'expected the moved memory to be active').toBe('active')
    const found = (await s.plur.recallWithMeta('release notes drafted Monday', { scope: LOCAL_TARGET })).engrams.map(e => e.statement)
    expect(found, 'expected the moved memory to be found in its new scope').toContain(FACT)
    const h1 = events(s.plur, moved!.id)
    expect(h1, `expected the history to keep the creation; it shows ${h1.join(', ')}`).toContain('engram_created')
    expect(h1, `expected the history to record the move; it shows ${h1.join(', ')}`).toContain('engram_rescoped')
  })

  it('a move to the team scope leaves a copy on the team server and links the original to it', async () => {
    s = await teamStore(t.url)
    const m = await s.plur.learn(FACT, { scope: 'global' })
    const r = await s.plur.rescope(m.id, TEAM_SCOPE)
    const res = r.results[0]
    expect(res?.status, `expected the move to succeed; got ${JSON.stringify(r.results)}`).toBe('rescoped')
    expect(t.stub.appendCountFor(FACT), 'expected exactly one copy of the memory on the team server').toBe(1)
    const copy = t.stub.getEngram(String(res!.new_id))
    expect(copy?.scope, `expected the team server's copy (${res!.new_id}) to be in the team scope`).toBe(TEAM_SCOPE)
    const original = await s.plur.getById(m.id)
    expect(original, 'expected the original to stay in the local store (retired, not deleted)').toBeTruthy()
    expect(JSON.stringify(original), 'expected the original to point at the team copy it was moved to').toContain(String(res!.new_id))
    const h1 = events(s.plur, m.id)
    expect(h1, `expected the original's history to keep its creation; it shows ${h1.join(', ')}`).toContain('engram_created')
    expect(h1, `expected the original's history to record the move; it shows ${h1.join(', ')}`).toContain('engram_rescoped')
  })

  it('a preview changes nothing and sends nothing, for a local and a team target', async () => {
    s = await teamStore(t.url)
    const m = await s.plur.learn(FACT, { scope: 'global' })
    const before = storeBytes(s.dir)
    const hist = events(s.plur, m.id)
    for (const target of [LOCAL_TARGET, TEAM_SCOPE]) {
      const r = await s.plur.rescope(m.id, target, { dry_run: true })
      expect(r.results[0]?.status, `precondition: the preview to ${target} says what would happen; got ${JSON.stringify(r.results)}`).toBe('rescoped')
      expect(storeBytes(s.dir) === before, `expected a preview to ${target} to leave the memory file unchanged`).toBe(true)
      expect(events(s.plur, m.id), `expected a preview to ${target} to add nothing to the history`).toEqual(hist)
    }
    expect(t.stub.appendCountFor(FACT), 'expected a preview to send nothing to the team server').toBe(0)
    expect((await s.plur.getById(m.id))?.scope, 'expected the memory to stay where it was').toBe('global')
  })

  it('a preview through the MCP tool and through the CLI changes nothing', async () => {
    s = await teamStore(t.url)
    const m = await s.plur.learn(FACT, { scope: 'global' })
    const before = storeBytes(s.dir)
    net = offlineFetch()
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'plur-eval-prv7-ws-')))
    dirs.push(folder)
    writeFolderMap(s.dir, [{ path: folder, plur: 'on' }])
    vi.spyOn(process, 'cwd').mockReturnValue(folder)
    const conn = await connectMcp(s.plur)
    closers.push(conn.close)
    const viaMcp = await callTool(conn.client, 'plur_rescope', { id: m.id, target_scope: TEAM_SCOPE, dry_run: true })
    expect(viaMcp.raw.isError, `plur_rescope preview failed: ${viaMcp.text}`).not.toBe(true)
    expect(viaMcp.json?.results?.[0]?.status, `precondition: the MCP preview describes the move; got ${viaMcp.text.slice(0, 400)}`).toBe('rescoped')
    expect(storeBytes(s.dir) === before, 'expected the MCP preview to leave the memory file unchanged').toBe(true)
    expect(t.stub.appendCountFor(FACT), 'expected the MCP preview to send nothing to the team server').toBe(0)

    h = hookHome()
    const cliStore = new Plur({ path: h.env.PLUR_PATH!, autoDiscover: false })
    const c = await cliStore.learn(FACT, { scope: 'global' })
    const cliBefore = storeBytes(h.env.PLUR_PATH!)
    const ran = runSource('cli', ['rescope', c.id, '--to', LOCAL_TARGET, '--dry-run'], { env: h.env, cwd: h.home, timeoutMs: 90_000 })
    expect(ran.status, `plur rescope --dry-run failed: ${ran.stderr.slice(0, 400)}`).toBe(0)
    expect(ran.stdout + ran.stderr, 'precondition: the CLI preview names the move it would make').toContain(LOCAL_TARGET)
    expect(storeBytes(h.env.PLUR_PATH!) === cliBefore, 'expected plur rescope --dry-run to leave the memory file unchanged').toBe(true)
  }, 180_000)

  it('a move to a team server that is down changes nothing', async () => {
    const down = await startTeamStub()
    const url = down.url
    await down.stop()
    s = await teamStore(url)
    const m = await s.plur.learn(FACT, { scope: 'global' })
    const before = storeBytes(s.dir)
    const hist = events(s.plur, m.id)
    const r = await s.plur.rescope(m.id, TEAM_SCOPE)
    expect(r.results[0]?.status, `precondition: the move is reported as failed; got ${JSON.stringify(r.results)}`).toBe('error')
    expect(storeBytes(s.dir) === before, 'expected a failed move to leave the memory file unchanged').toBe(true)
    expect(events(s.plur, m.id), 'expected a failed move to add nothing to the history').toEqual(hist)
    const still = await s.plur.getById(m.id)
    expect([still?.scope, still?.status ?? 'active'], 'expected the memory to stay active where it was').toEqual(['global', 'active'])
  })

  it('a move blocked because the memory carries a secret changes nothing', async () => {
    s = await teamStore(t.url)
    const m = await s.plur.learn(SECRET, { scope: 'global' })
    expect((await s.plur.getById(m.id))?.statement, 'precondition: the memory with the secret is stored locally').toBe(SECRET)
    const before = storeBytes(s.dir)
    const hist = events(s.plur, m.id)
    const r = await s.plur.rescope(m.id, TEAM_SCOPE)
    expect(r.results[0]?.status, `expected a memory carrying a secret not to be moved to the team; got ${JSON.stringify(r.results)}`).toBe('error')
    expect(t.stub.appendCountFor(SECRET), 'expected the secret not to reach the team server').toBe(0)
    expect(storeBytes(s.dir) === before, 'expected the blocked move to leave the memory file unchanged').toBe(true)
    expect(events(s.plur, m.id), 'expected the blocked move to add nothing to the history').toEqual(hist)
  })

  it('the team server hands back an id another local memory already has: that memory is untouched', async () => {
    // The team server numbers its memories the way this machine does
    // (ENG-<date>-NNN), so the id it assigns to the moved copy can be the id
    // of a different memory saved here earlier.
    t.stub.datedIds = true
    s = await teamStore(t.url)
    const other = 'the design review happens on Thursday afternoons'
    const o = await s.plur.learn(other, { scope: 'global' })
    const m = await s.plur.learn(FACT, { scope: 'global' })
    const takenId = `ENG-${new Date().toISOString().slice(0, 10)}-001`
    expect(o.id, `precondition: the other memory holds the id the team server will assign first (${takenId})`).toBe(takenId)
    const otherHist = events(s.plur, o.id)

    const r = await s.plur.rescope(m.id, TEAM_SCOPE)
    const res = r.results[0]
    expect(res?.status, `expected the move to succeed; got ${JSON.stringify(r.results)}`).toBe('rescoped')
    expect(String(res?.new_id), 'precondition: the team server assigned the id the other memory already has').toBe(takenId)
    expect(JSON.stringify(t.stub.getEngram(takenId) ?? null), 'expected the moved memory to have its copy on the team server').toContain(FACT)
    const otherAfter = (await s.plur.list()).find(e => e.statement === other)
    expect([otherAfter?.id, otherAfter?.scope, otherAfter?.status ?? 'active'],
      'expected the other memory with that id to stay as it was').toEqual([o.id, 'global', 'active'])
    const found = (await s.plur.recallWithMeta('design review Thursday afternoons', { scope: 'global' })).engrams.map(e => e.statement)
    expect(found, 'expected the other memory to still be found').toContain(other)
    expect(events(s.plur, o.id).filter(e => !otherHist.includes(e)),
      "expected nothing from the move to be written into the other memory's history").toEqual([])
    expect(events(s.plur, m.id), "expected the moved memory's history to record the move").toContain('engram_rescoped')
  })
})
