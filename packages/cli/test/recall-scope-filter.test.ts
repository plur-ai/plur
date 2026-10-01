/**
 * `plur recall <q> --scope <s>` (and `--domain <d>`) were declared as flags
 * the command accepts (#986), so the argv check let them through — and then
 * the parser skipped them and the recall ran unfiltered. A user asking for
 * one project's memory got every project's, and the remote leg (which uses
 * an explicit recall scope as its dialing context, #243/#776) was never
 * dialed for the scope asked for.
 *
 * Same semantics as MCP `plur_recall`: `scope` and `domain` go to core recall
 * as filters. `--type`/`--tags` have no core recall filter, so they are no
 * longer declared and the argv check refuses them instead of ignoring them.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, spawn } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('plur recall --scope / --domain filter', { timeout: 60000 }, () => {
  let dir: string
  // HOME and the default store point at empty temp dirs: every command names
  // its store with --path, so neither may gain a file (asserted last).
  const guardHome = mkdtempSync(join(tmpdir(), 'plur-recall-guard-home-'))
  const guardStore = mkdtempSync(join(tmpdir(), 'plur-recall-guard-store-'))
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-recall-scope-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  afterAll(() => {
    rmSync(guardHome, { recursive: true, force: true })
    rmSync(guardStore, { recursive: true, force: true })
  })

  const env = () => ({
    ...process.env, HOME: guardHome, USERPROFILE: guardHome, PLUR_PATH: guardStore,
    XDG_CONFIG_HOME: join(guardHome, '.config'),
    PLUR_DISABLE_EMBEDDINGS: '1', PLUR_REMOTE_RECALL: 'off',
  })

  function learn(statement: string, extra: string): void {
    execSync(`node ${CLI} learn "${statement}" --path ${dir} --json ${extra}`, {
      encoding: 'utf-8', timeout: 15000, env: env(),
    })
  }

  function recall(args: string, mode: '--fast' | '' = '--fast'): Array<{ statement: string; scope: string; domain: string | null }> {
    try {
      const out = execSync(`node ${CLI} recall ${args} --path ${dir} --json ${mode}`, {
        encoding: 'utf-8', timeout: 30000, env: env(),
      })
      return JSON.parse(out).results
    } catch (err: any) {
      if (err.status === 2) return [] // no results
      throw err
    }
  }

  function seed(): void {
    learn('deploy alpha service with blue green rollout', '--scope project:alpha --domain ops.deploy')
    learn('deploy beta service with canary rollout', '--scope project:beta --domain ops.release')
  }

  it('without --scope, recall returns both projects (baseline)', () => {
    seed()
    const scopes = recall('"deploy rollout"').map(r => r.scope).sort()
    expect(scopes).toEqual(['project:alpha', 'project:beta'])
  })

  it('--scope filters keyword (--fast) results to that scope', () => {
    seed()
    const results = recall('"deploy rollout" --scope project:alpha')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.scope === 'project:alpha')).toBe(true)
  })

  it('--scope filters hybrid (default) results to that scope', () => {
    seed()
    const results = recall('"deploy rollout" --scope project:beta', '')
    expect(results.length).toBeGreaterThan(0)
    expect(results.every(r => r.scope === 'project:beta')).toBe(true)
  })

  it('--domain filters results by domain prefix', () => {
    seed()
    const results = recall('"deploy rollout" --domain ops.release')
    expect(results.map(r => r.domain)).toEqual(['ops.release'])
  })

  it('--type and --tags are refused, not silently ignored', () => {
    for (const flag of ['--type behavioral', '--tags x']) {
      let status = 0
      let stderr = ''
      try {
        execSync(`node ${CLI} recall "deploy" ${flag} --path ${dir} --json --fast`, {
          encoding: 'utf-8', timeout: 15000, env: env(), stdio: 'pipe',
        })
      } catch (err: any) {
        status = err.status
        stderr = `${err.stdout ?? ''}${err.stderr ?? ''}`
      }
      expect(status).toBe(1)
      expect(stderr).toContain(flag.split(' ')[0])
    }
  })

  // Runs last in this describe (vitest runs tests in order).
  it('never touches HOME or the default store', () => {
    expect(readdirSync(guardHome)).toEqual([])
    expect(readdirSync(guardStore)).toEqual([])
  })
})

describe('plur recall --scope dials the remote store for that scope', { timeout: 60000 }, () => {
  const TOKEN = 'recall-scope-token'
  const SCOPE = 'group:test'
  let server: StubServer
  let baseUrl: string
  let root: string
  let dir: string

  beforeAll(async () => {
    server = new StubServer(TOKEN)
    baseUrl = (await server.start()).url
  })
  afterAll(async () => { await server.stop() })

  beforeEach(() => {
    server.reset()
    root = mkdtempSync(join(tmpdir(), 'plur-recall-remote-'))
    dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`)
    server.recallRows = [{
      id: 'ENG-2026-1001-001', scope: SCOPE, status: 'active',
      statement: 'team deployment conventions require canary verification', score: 1,
    }]
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  // Async spawn: the stub server lives in this process and must keep serving.
  function recallAsync(extra: string[]): Promise<{ stdout: string; status: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, 'recall', 'deployment conventions', '--path', dir, '--json', '--fast', ...extra], {
        env: { ...process.env, HOME: root, USERPROFILE: root, PLUR_DISABLE_EMBEDDINGS: '1' },
        cwd: root,
      })
      let stdout = ''
      child.stdout.on('data', d => { stdout += String(d) })
      child.on('error', reject)
      child.on('close', code => resolve({ stdout, status: code ?? 1 }))
    })
  }

  it('dials the store whose scope matches --scope and merges its rows', async () => {
    const { stdout, status } = await recallAsync(['--scope', SCOPE])
    expect(status).toBe(0)
    expect(server.recallCalls).toBe(1)
    expect(server.lastRecallBody?.scopes).toEqual([SCOPE])
    const out = JSON.parse(stdout)
    expect(out.results.some((r: { statement: string }) => r.statement.includes('canary verification'))).toBe(true)
  })

  it('without --scope (no project or session context) the store is not dialed', async () => {
    await recallAsync([])
    expect(server.recallCalls).toBe(0)
  })
})
