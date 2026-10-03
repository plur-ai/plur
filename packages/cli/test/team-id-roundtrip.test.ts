/**
 * One id for a team engram on the CLI, from learn to recall to forget
 * (#1568, 0.21.1 pre-release check finding F3).
 *
 * `plur learn --scope <team>` returns the namespaced id (`ENG-<PREFIX>-…`).
 * `plur recall` used to print the same row under its bare server id — the id
 * a local engram minted the same day also has. Recall (json and text) now
 * prints the id learn returned, and `plur forget` with it retires the team
 * row only. Harness: the spawned CLI against the in-process StubServer, as in
 * forget-namespaced.test.ts (async spawn, see the note there).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { storePrefix, bareEngramId } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'team-id-token'
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

describe('plur recall gives a team engram the id plur learn returned (F3)', () => {
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
    root = mkdtempSync(join(tmpdir(), 'plur-team-id-'))
    plurDir = join(root, 'plur')
    home = join(root, 'home')
    mkdirSync(plurDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    server.reset()
    server.datedIds = true
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

  function cli(args: string[], nodeArgs: string[] = []): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [...nodeArgs, CLI, ...args, '--path', plurDir], {
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

  async function learn(statement: string, scope?: string): Promise<string> {
    const r = await cli(['learn', statement, ...(scope ? ['--scope', scope] : []), '--json'])
    expect(r.status, `learn failed: ${r.stderr}`).toBe(0)
    return JSON.parse(r.stdout).id as string
  }

  async function collidingPair(): Promise<{ local: string; team: string }> {
    writeConfig(baseUrl)
    const local = await learn('zebra crossings are painted white locally')
    const team = await learn('zebra team rule for deploy windows', SCOPE)
    expect(team.startsWith(`ENG-${PREFIX}-`)).toBe(true)
    expect(bareEngramId(team)).toBe(local)
    server.recallRows = [{ id: bareEngramId(team), scope: SCOPE, status: 'active', statement: 'zebra team rule for deploy windows', score: 1 }]
    return { local, team }
  }

  it('recall --json gives the team row the id learn returned', async () => {
    const { team } = await collidingPair()
    const r = await cli(['recall', 'zebra team rule deploy windows', '--scope', SCOPE, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const row = JSON.parse(r.stdout).results.find((x: any) => x.scope === SCOPE)
    expect(row?.id).toBe(team)
  }, TEST_TIMEOUT_MS)

  it('recall text output prints the id learn returned', async () => {
    const { team } = await collidingPair()
    // Text output is what a terminal gets; make the child's stdout read as one.
    const r = await cli(['recall', 'zebra team rule deploy windows', '--scope', SCOPE],
      ['--import', 'data:text/javascript,process.stdout.isTTY=true'])
    expect(r.status, r.stderr).toBe(0)
    expect(r.stdout).toContain(`[${team}]`)
  }, TEST_TIMEOUT_MS)

  it('forget with the recalled id retires the team row and leaves the local twin', async () => {
    const { local, team } = await collidingPair()
    const rec = await cli(['recall', 'zebra team rule deploy windows', '--scope', SCOPE, '--json'])
    const id = JSON.parse(rec.stdout).results.find((x: any) => x.scope === SCOPE).id as string
    const f = await cli(['forget', id, '--json'])
    expect(f.status, `${f.stdout} ${f.stderr}`).toBe(0)
    expect(server.getEngram(bareEngramId(team))?.status).toBe('retired')
    const list = await cli(['list', '--json'])
    // `plur list` shows active engrams only: the local twin is still there.
    const twin = JSON.parse(list.stdout).engrams.find((x: any) => x.id === local)
    expect(twin?.scope).toBe('global')
  }, TEST_TIMEOUT_MS)
})
