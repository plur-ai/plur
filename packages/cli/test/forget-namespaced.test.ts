/**
 * `plur forget <id>` × configured stores (#1119, #1109; the CLI half of #1114).
 *
 * The invariant this file pins, in three parts:
 *
 *   1. A NAMESPACED id (`ENG-<PREFIX>-…`, the shape every read path hands
 *      back for a `stores:` engram, #914) always reaches the store its prefix
 *      declares — or surfaces that store's refusal. It is never answered
 *      "Engram not found" by a lookup that never left the local cache.
 *   2. A BARE id (`ENG-YYYY-…`) keeps the graceful contract: held locally →
 *      retired locally, behind the #831 collision guard; held only remotely →
 *      retired there (#84); held nowhere → "Engram not found", exit 1; a store
 *      that could not be reached is reported as unreached, never as absence
 *      (#907). `--scope` is the operator's disambiguator, as `scope` is for
 *      MCP plur_forget.
 *   3. NO id segment is ever rewritten. The only transformation on the way to
 *      a store is `_stripRemotePrefix` removing THAT store's own prefix. A
 *      2–4-letter segment that is not this store's prefix, a lowercase
 *      prefix, an extra segment, or a prefix matching no configured store all
 *      pass through untouched — asserted with DECOY rows that a mangled id
 *      would have hit. (PR #1122's `bareEngramId` regex broke exactly this and
 *      with it the #831 guard; the shapes below are the ones it mangled.)
 *
 * Why the CLI needed its own fix: `getById` resolves against `_loadAllEngrams`,
 * whose remote leg is a synchronous cache PEEK (`_loadRemoteCached`) that
 * nothing warms in a one-shot CLI process. So the command's local pre-check
 * missed every remote engram and exited "Engram not found" before
 * `plur.forget()` — which already routes, walks, and refuses correctly — ever
 * ran. The MCP handler delegates to forget() on a miss; the CLI now does too.
 *
 * Real spawned CLI against the in-process StubServer, and the spawn is ASYNC
 * on purpose: the stub lives in this process, and a spawnSync would block the
 * event loop for the child's whole lifetime, so the stub could never accept
 * the child's connection and every remote dial would read as a timeout (the
 * deadlock is the harness's, not the CLI's — see hook-remote-recall.test.ts).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { storePrefix } from '@plur-ai/core'

const CLI = join(__dirname, '..', 'dist', 'index.js')
const TOKEN = 'forget-ns-token'
const SCOPE = 'group:test'
/** Derived, not typed: the test must follow the prefix rule, not restate it. */
const PREFIX = storePrefix(SCOPE)
const UNREACHABLE = 'http://127.0.0.1:1'
/** Generous: a cold Node start under a loaded parallel run is the only thing
 *  that has ever tripped a spawn budget in this suite family (#793). */
const SPAWN_KILL_MS = 60_000
const TEST_TIMEOUT_MS = 120_000

interface Run { status: number; stdout: string; stderr: string }

let server: StubServer
let baseUrl: string

describe('plur forget × namespaced ids and configured stores (#1119)', () => {
  let root: string
  let plurDir: string
  let home: string

  beforeAll(async () => {
    server = new StubServer(TOKEN)
    baseUrl = (await server.start()).url
  })
  afterAll(async () => { await server.stop() })

  beforeEach(() => {
    // Project dir and HOME kept apart, as in the real deployment: nothing in
    // this suite may read or write the developer's own ~/.plur.
    root = mkdtempSync(join(tmpdir(), 'plur-forget-ns-'))
    plurDir = join(root, 'plur')
    home = join(root, 'home')
    mkdirSync(plurDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    server.reset()
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function writeConfig(storeUrl: string | null): void {
    const stores = storeUrl === null
      ? ''
      : `stores:\n  - url: "${storeUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`
    writeFileSync(join(plurDir, 'config.yaml'), `embeddings:\n  enabled: false\n${stores}`)
  }

  function seed(id: string, statement = `remote row ${id}`): void {
    server.seedEngram({
      id, scope: SCOPE, status: 'active',
      data: { statement, type: 'behavioral', retrieval_strength: 0.7 },
    })
  }
  const remoteStatus = (id: string): string | undefined => server.getEngram(id)?.status

  function cli(args: string[]): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, ...args, '--path', plurDir], {
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: plurDir },
        cwd: root,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        // Refuse to interpret the output of a process that did not finish
        // (see helpers/spawn.ts): a timeout is a harness failure, not a result.
        reject(new Error(`plur ${args.join(' ')} timed out after ${SPAWN_KILL_MS}ms; stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`))
      }, SPAWN_KILL_MS)
      child.stdout.on('data', d => { stdout += String(d) })
      child.stderr.on('data', d => { stderr += String(d) })
      child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ status: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() })
      })
    })
  }

  /** `plur learn` into the LOCAL primary store; returns the bare id it minted. */
  async function learnLocal(statement: string): Promise<string> {
    const r = await cli(['learn', statement, '--json'])
    expect(r.status, `learn failed: ${r.stderr}`).toBe(0)
    return JSON.parse(r.stdout).id as string
  }

  /** The entry point's --json error envelope (`{error}` on stdout, exit 1). */
  function jsonError(r: Run): string {
    expect(r.status).toBe(1)
    const parsed = JSON.parse(r.stdout)
    expect(typeof parsed.error).toBe('string')
    return parsed.error as string
  }

  // ---------------------------------------------------------------------------
  // 1. Namespaced ids reach their declared store — or surface its refusal.
  // ---------------------------------------------------------------------------

  it('retires a remote engram by its namespaced id (--json)', async () => {
    writeConfig(baseUrl)
    seed('ENG-2026-09-01-007')
    const r = await cli(['forget', `ENG-${PREFIX}-2026-09-01-007`, '--json'])
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ success: true, retired: { id: `ENG-${PREFIX}-2026-09-01-007` } })
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('retired')
  }, TEST_TIMEOUT_MS)

  it('retires a remote engram by its namespaced id (no --json flag, --reason given)', async () => {
    // Piped stdout selects the JSON envelope (`shouldOutputJson`), so this
    // exercises the flag-less parse path, not a prose renderer — no spawned
    // child has a TTY. The retire itself, and --reason riding along, are what
    // is under test.
    writeConfig(baseUrl)
    seed('ENG-2026-09-01-007')
    const r = await cli(['forget', `ENG-${PREFIX}-2026-09-01-007`, '--reason', 'stale'])
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ success: true, retired: { id: `ENG-${PREFIX}-2026-09-01-007` } })
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('retired')
  }, TEST_TIMEOUT_MS)

  it('surfaces the #1114 refusal when the declared store cannot be reached — never "not found"', async () => {
    writeConfig(UNREACHABLE)
    const r = await cli(['forget', `ENG-${PREFIX}-2026-09-01-007`, '--json'])
    const err = jsonError(r)
    expect(err).toContain(`Cannot reach "${SCOPE}" to retire "ENG-${PREFIX}-2026-09-01-007"`)
    expect(err).not.toContain('Engram not found')
    // Second attempt in the same store root: the first dial tripped the
    // persisted host breaker (#1069, "fast-failing every store on this host"),
    // so this one takes the breaker-open path — and must surface the same
    // refusal, not downgrade to absence.
    const t = await cli(['forget', `ENG-${PREFIX}-2026-09-01-007`])
    const err2 = jsonError(t)
    expect(err2).toContain(`Cannot reach "${SCOPE}" to retire "ENG-${PREFIX}-2026-09-01-007"`)
    expect(err2).not.toContain('Engram not found')
  }, TEST_TIMEOUT_MS)

  it('a namespaced id the store does not hold is "not found" for THAT id, exit 1, nothing else touched', async () => {
    writeConfig(baseUrl)
    seed('ENG-2026-09-01-007')
    const r = await cli(['forget', `ENG-${PREFIX}-2026-09-01-999`, '--json'])
    expect(jsonError(r)).toBe(`Engram not found: ENG-${PREFIX}-2026-09-01-999`)
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('active')
  }, TEST_TIMEOUT_MS)

  // ---------------------------------------------------------------------------
  // 2. Bare ids keep the graceful contract.
  // ---------------------------------------------------------------------------

  it('a bare id that exists nowhere is "Engram not found", exit 1, with no unreached-store caveat', async () => {
    writeConfig(baseUrl)
    const r = await cli(['forget', 'ENG-2026-09-01-999', '--json'])
    expect(jsonError(r)).toBe('Engram not found: ENG-2026-09-01-999')
    // Flag-less spelling (piped stdout still selects the JSON envelope).
    const t = await cli(['forget', 'ENG-2026-09-01-999'])
    expect(jsonError(t)).toBe('Engram not found: ENG-2026-09-01-999')
  }, TEST_TIMEOUT_MS)

  it('a bare id held only remotely is retired there (#84)', async () => {
    writeConfig(baseUrl)
    seed('ENG-2026-09-01-007')
    const r = await cli(['forget', 'ENG-2026-09-01-007', '--json'])
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ success: true, retired: { id: 'ENG-2026-09-01-007' } })
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('retired')
  }, TEST_TIMEOUT_MS)

  it('a bare id with an unreachable store keeps the graceful #907 wording, not the namespaced refusal', async () => {
    writeConfig(UNREACHABLE)
    const r = await cli(['forget', 'ENG-2026-09-01-999', '--json'])
    const err = jsonError(r)
    expect(err).toContain('Engram not found: ENG-2026-09-01-999')
    expect(err).toContain('could not be reached')
    expect(err).not.toContain('Cannot reach')
  }, TEST_TIMEOUT_MS)

  it('a bare id held both locally and remotely is refused (#831), and --scope picks the side', async () => {
    writeConfig(null)
    const id = await learnLocal('collision fixture learned locally')
    writeConfig(baseUrl)
    seed(id, 'the unrelated remote engram that shares the id')

    const refused = await cli(['forget', id, '--json'])
    expect(jsonError(refused)).toContain(`Ambiguous engram ID "${id}"`)
    expect(remoteStatus(id)).toBe('active')
    const stillLocal = await cli(['list', '--json'])
    expect(stillLocal.stdout).toContain(id)

    // --scope primary retires the LOCAL one and never dials the remote.
    const local = await cli(['forget', id, '--scope', 'primary', '--json'])
    expect(local.status, local.stderr).toBe(0)
    expect(JSON.parse(local.stdout)).toEqual({ success: true, retired: { id, scope: 'primary' } })
    expect(remoteStatus(id)).toBe('active')

    // --scope <remote scope> retires the REMOTE one.
    const remote = await cli(['forget', id, '--scope', SCOPE, '--json'])
    expect(remote.status, remote.stderr).toBe(0)
    expect(JSON.parse(remote.stdout)).toEqual({ success: true, retired: { id, scope: SCOPE } })
    expect(remoteStatus(id)).toBe('retired')
  }, TEST_TIMEOUT_MS)

  it('--scope naming no configured store is rejected, not guessed at; --scope without a value is a usage error', async () => {
    writeConfig(baseUrl)
    seed('ENG-2026-09-01-007')
    const typo = await cli(['forget', 'ENG-2026-09-01-007', '--scope', 'group:tset', '--json'])
    expect(typo.status).toBe(1)
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('active')

    const dangling = await cli(['forget', 'ENG-2026-09-01-007', '--scope'])
    expect(dangling.status).toBe(1)
    expect(dangling.stderr).toContain('--scope requires a value')
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('active')
  }, TEST_TIMEOUT_MS)

  it('search mode refuses a remote --scope: a local match must never be routed to a server that shares its id', async () => {
    writeConfig(null)
    const id = await learnLocal('search-mode fixture about kestrels')
    writeConfig(baseUrl)
    seed(id, 'the unrelated remote row that shares the local id')

    const r = await cli(['forget', 'kestrels', '--search', '--scope', SCOPE, '--json'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('cannot be combined with search mode')
    expect(remoteStatus(id)).toBe('active')
    const stillLocal = await cli(['list', '--json'])
    expect(stillLocal.stdout).toContain(id)

    // `primary` is the one scope consistent with a local search hit: it is
    // the #831 escape hatch and retires the LOCAL match without dialing.
    const ok = await cli(['forget', 'kestrels', '--search', '--scope', 'primary', '--json'])
    expect(ok.status, ok.stderr).toBe(0)
    expect(JSON.parse(ok.stdout).retired.id).toBe(id)
    expect(remoteStatus(id)).toBe('active')
  }, TEST_TIMEOUT_MS)

  it('the local path is unchanged: a local id is retired with its statement echoed', async () => {
    writeConfig(baseUrl)
    const id = await learnLocal('purely local fixture')
    const r = await cli(['forget', id, '--json'])
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ success: true, retired: { id, statement: 'purely local fixture' } })
    const again = await cli(['forget', id, '--json'])
    expect(again.status).toBe(1)
    expect(again.stderr).toContain(`Already retired: ${id}`)
  }, TEST_TIMEOUT_MS)

  // ---------------------------------------------------------------------------
  // 3. No id segment is ever rewritten. Each case seeds the row a mangled id
  //    WOULD have hit and asserts it is untouched.
  // ---------------------------------------------------------------------------

  it('a 2–4-letter middle segment that is not this store\'s prefix is not a prefix (ENG-ZZZ-…)', async () => {
    writeConfig(baseUrl)
    seed('ENG-2026-09-01-007') // decoy: what bare-ifying ENG-ZZZ-2026-09-01-007 would hit
    const r = await cli(['forget', 'ENG-ZZZ-2026-09-01-007', '--json'])
    expect(jsonError(r)).toBe('Engram not found: ENG-ZZZ-2026-09-01-007')
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('active')
  }, TEST_TIMEOUT_MS)

  it('a lowercase prefix is not this store\'s prefix (ENG-gte-…)', async () => {
    writeConfig(baseUrl)
    seed('ENG-2026-09-01-007')
    const r = await cli(['forget', `ENG-${PREFIX.toLowerCase()}-2026-09-01-007`, '--json'])
    expect(jsonError(r)).toBe(`Engram not found: ENG-${PREFIX.toLowerCase()}-2026-09-01-007`)
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('active')
  }, TEST_TIMEOUT_MS)

  it('an extra segment survives: only this store\'s own prefix is removed, once (ENG-GTE-XX-…)', async () => {
    writeConfig(baseUrl)
    seed('ENG-2026-09-01-007') // decoy: what stripping BOTH segments would hit
    const miss = await cli(['forget', `ENG-${PREFIX}-XX-2026-09-01-007`, '--json'])
    expect(jsonError(miss)).toBe(`Engram not found: ENG-${PREFIX}-XX-2026-09-01-007`)
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('active')

    // The positive twin: a server that mints ENG-XX-… ids (the #86 shape,
    // e.g. ENG-SRV-001) is reached by exactly that id once the prefix is off.
    seed('ENG-XX-2026-09-01-007')
    const hit = await cli(['forget', `ENG-${PREFIX}-XX-2026-09-01-007`, '--json'])
    expect(hit.status, hit.stderr).toBe(0)
    expect(remoteStatus('ENG-XX-2026-09-01-007')).toBe('retired')
    expect(remoteStatus('ENG-2026-09-01-007')).toBe('active')
  }, TEST_TIMEOUT_MS)

  it('the #831 cold-cache fixture shape is routed intact (ENG-GTE-COLD-001 → ENG-COLD-001, never ENG-001)', async () => {
    writeConfig(baseUrl)
    seed('ENG-COLD-001')
    seed('ENG-001') // decoy: what PR #1122's regex turned ENG-COLD-001 into
    const r = await cli(['forget', `ENG-${PREFIX}-COLD-001`, '--json'])
    expect(r.status, r.stderr).toBe(0)
    expect(remoteStatus('ENG-COLD-001')).toBe('retired')
    expect(remoteStatus('ENG-001')).toBe('active')

    // And the bare form of that shape reaches the store unchanged too.
    seed('ENG-COLD-002')
    seed('ENG-002')
    const bare = await cli(['forget', 'ENG-COLD-002', '--json'])
    expect(bare.status, bare.stderr).toBe(0)
    expect(remoteStatus('ENG-COLD-002')).toBe('retired')
    expect(remoteStatus('ENG-002')).toBe('active')
  }, TEST_TIMEOUT_MS)
})
