/**
 * An unscoped `plur recall` / `plur inject` in a team folder searches that
 * folder's team store, as MCP does since #1566 (finding L10 of the third
 * 0.21.1 pre-release check).
 *
 * The CLI uses the same workspace resolver as the MCP server
 * (workspaceFolderScope in core): its one input is the folder it runs in (the
 * CLI has no client roots). When that folder resolves to `on` with a scope,
 * the read dials that scope's store, exactly as a session started there would.
 * An explicit `--scope` wins; an `off` or undecided folder, the home folder,
 * and a folder with no scope keep today's behaviour (no team store dialed).
 *
 * Async spawn: the stub server lives in this process and must keep serving.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'recall-folder-scope-token'
const TEAM = 'group:test/eng'
const PERSONAL = 'user:test:tester'

describe('unscoped plur recall / inject in a team folder dial the team store (L10)', { timeout: 60000 }, () => {
  let server: StubServer
  let baseUrl: string
  let root: string
  let home: string
  let store: string
  let work: string

  beforeAll(async () => {
    server = new StubServer(TOKEN)
    baseUrl = (await server.start()).url
  })
  afterAll(async () => { await server.stop() })

  beforeEach(() => {
    server.reset()
    server.setMe({ username: 'tester', org_id: 'test', role: 'developer', scopes: [TEAM, PERSONAL] })
    root = realpathSync(mkdtempSync(join(tmpdir(), 'plur-recall-folder-')))
    home = join(root, 'home')
    store = join(root, 'store')
    work = join(root, 'work')
    for (const d of [home, store, work]) mkdirSync(d, { recursive: true })
    writeFileSync(join(store, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${TEAM}"\n` +
      `  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${PERSONAL}"\n`)
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  function mapFolder(entry: string): void {
    writeFileSync(join(store, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${work}"\n${entry}`)
  }

  function serve(statement: string, scope: string): void {
    server.recallRows = [{ id: 'ENG-2026-1004-001', scope, status: 'active', statement, score: 1 }]
  }

  function run(args: string[], cwd = work): Promise<{ stdout: string; status: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, ...args, '--path', store, '--json'], {
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_DISABLE_EMBEDDINGS: '1', PLUR_PATH: store },
        cwd,
      })
      let stdout = ''
      child.stdout.on('data', d => { stdout += String(d) })
      child.on('error', reject)
      child.on('close', code => resolve({ stdout, status: code ?? 1 }))
    })
  }

  const found = (stdout: string, needle: string): boolean => stdout.includes(needle)

  it('recall (keyword) in a folder mapped on + team scope dials the team store', async () => {
    mapFolder(`    plur: on\n    scope: "${TEAM}"\n`)
    serve('lynx-team the deploy target is the blue cluster', TEAM)
    const { stdout } = await run(['recall', 'lynx-team deploy target', '--fast'])
    expect(server.recallCalls, stdout).toBeGreaterThan(0)
    expect(found(stdout, 'lynx-team the deploy target')).toBe(true)
  })

  it('recall (hybrid, the default) dials the team store too', async () => {
    mapFolder(`    plur: on\n    scope: "${TEAM}"\n`)
    serve('lynx-hybrid the release train leaves on tuesday', TEAM)
    const { stdout } = await run(['recall', 'lynx-hybrid release train'])
    expect(server.recallCalls, stdout).toBeGreaterThan(0)
    expect(found(stdout, 'lynx-hybrid the release train')).toBe(true)
  })

  it('a personal user: scope backed by a remote store: recall dials it', async () => {
    mapFolder(`    plur: on\n    scope: "${PERSONAL}"\n`)
    serve('lynx-personal my editor uses tabs', PERSONAL)
    const { stdout } = await run(['recall', 'lynx-personal editor', '--fast'])
    expect(found(stdout, 'lynx-personal my editor')).toBe(true)
  })

  it('inject (hybrid) in a team folder dials the team store', async () => {
    mapFolder(`    plur: on\n    scope: "${TEAM}"\n`)
    serve('lynx-inject always run the canary before every deploy', TEAM)
    const { stdout } = await run(['inject', 'lynx-inject canary before deploy'])
    expect(server.recallCalls, stdout).toBeGreaterThan(0)
    expect(found(stdout, 'lynx-inject always run the canary')).toBe(true)
  })

  it('guard: an explicit --scope wins (global dials no team store)', async () => {
    mapFolder(`    plur: on\n    scope: "${TEAM}"\n`)
    serve('lynx-explicit a team fact', TEAM)
    const { stdout } = await run(['recall', 'lynx-explicit team fact', '--fast', '--scope', 'global'])
    expect(server.recallCalls).toBe(0)
    expect(found(stdout, 'lynx-explicit a team fact')).toBe(false)
  })

  it('guard: an off folder dials no team store', async () => {
    mapFolder(`    plur: off\n    scope: "${TEAM}"\n`)
    serve('lynx-off a team fact', TEAM)
    await run(['recall', 'lynx-off team fact', '--fast'])
    await run(['inject', 'lynx-off team fact'])
    expect(server.recallCalls).toBe(0)
  })

  it('guard: an undecided (ask) folder dials no team store', async () => {
    serve('lynx-ask a team fact', TEAM)
    await run(['recall', 'lynx-ask team fact', '--fast'])
    await run(['inject', 'lynx-ask team fact'])
    expect(server.recallCalls).toBe(0)
  })

  it('guard: run from the home folder, a mapped entry there gives no team default', async () => {
    writeFileSync(join(store, 'folders.yaml'), `version: 1\nfolders:\n  - path: "${home}"\n    plur: on\n    scope: "${TEAM}"\n`)
    serve('lynx-home a team fact', TEAM)
    await run(['recall', 'lynx-home team fact', '--fast'], home)
    expect(server.recallCalls).toBe(0)
  })
})
