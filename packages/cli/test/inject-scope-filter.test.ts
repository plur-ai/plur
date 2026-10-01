/**
 * `plur inject "<task>" --scope <s>` was silently ignored: inject declared no
 * flags, so nothing refused `--scope`, and its parser skipped it. The
 * injection drew on every scope, and the hybrid path's remote leg (which uses
 * an explicit scope as its dialing context, #243/#776) was never dialed for
 * the scope asked for. MCP `plur_inject` / `plur_inject_hybrid` take `scope`;
 * the CLI now passes it the same way. They take no `domain`, so `--domain`
 * (and any other undeclared flag) is refused instead of ignored.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync, spawn } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

describe('plur inject --scope filter', { timeout: 60000 }, () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-inject-scope-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const env = () => ({ ...process.env, PLUR_DISABLE_EMBEDDINGS: '1', PLUR_REMOTE_RECALL: 'off' })

  function learn(statement: string, extra: string): void {
    execSync(`node ${CLI} learn "${statement}" --path ${dir} --json ${extra}`, {
      encoding: 'utf-8', timeout: 15000, env: env(),
    })
  }

  function inject(args: string, mode: '--fast' | '' = '--fast'): string {
    const out = execSync(`node ${CLI} inject ${args} --path ${dir} --json ${mode}`, {
      encoding: 'utf-8', timeout: 30000, env: env(),
    })
    const r = JSON.parse(out)
    return `${r.constraints ?? ''}\n${r.directives ?? ''}\n${r.consider ?? ''}`
  }

  function seed(): void {
    learn('deploy alpha service with blue green rollout', '--scope project:alpha')
    learn('deploy beta service with canary rollout', '--scope project:beta')
  }

  it('without --scope, injection draws on both projects (baseline)', () => {
    seed()
    const text = inject('"deploy service rollout"')
    expect(text).toContain('alpha service')
    expect(text).toContain('beta service')
  })

  it('--scope limits keyword (--fast) injection to that scope', () => {
    seed()
    const text = inject('"deploy service rollout" --scope project:alpha')
    expect(text).toContain('alpha service')
    expect(text).not.toContain('beta service')
  })

  it('--scope limits hybrid (default) injection to that scope', () => {
    seed()
    const text = inject('"deploy service rollout" --scope project:beta', '')
    expect(text).toContain('beta service')
    expect(text).not.toContain('alpha service')
  })

  it('--budget, --no-with-default-protocol and a dash-led task after -- still work', () => {
    seed()
    expect(inject('"deploy service rollout" --budget 500 --no-with-default-protocol')).toContain('rollout')
    expect(() => inject('-- "-deploy service rollout"')).not.toThrow()
  })

  it('--domain (which inject cannot honour) is refused, not silently ignored', () => {
    let status = 0
    let out = ''
    try {
      execSync(`node ${CLI} inject "deploy" --domain ops --path ${dir} --json --fast`, {
        encoding: 'utf-8', timeout: 15000, env: env(), stdio: 'pipe',
      })
    } catch (err: any) {
      status = err.status
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    expect(status).toBe(1)
    expect(out).toContain('--domain')
  })
})

describe('plur inject --scope dials the remote store for that scope (hybrid)', { timeout: 60000 }, () => {
  const TOKEN = 'inject-scope-token'
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
    root = mkdtempSync(join(tmpdir(), 'plur-inject-remote-'))
    dir = join(root, 'store')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - url: "${baseUrl}"\n    token: "${TOKEN}"\n    scope: "${SCOPE}"\n`)
    server.recallRows = [{
      id: 'ENG-2026-1001-002', scope: SCOPE, status: 'active',
      statement: 'team deployment conventions require canary verification', score: 1,
    }]
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  // Async spawn: the stub server lives in this process and must keep serving.
  function injectAsync(extra: string[]): Promise<{ stdout: string; status: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, 'inject', 'deployment conventions', '--path', dir, '--json', ...extra], {
        env: { ...process.env, HOME: root, USERPROFILE: root, PLUR_DISABLE_EMBEDDINGS: '1' },
        cwd: root,
      })
      let stdout = ''
      child.stdout.on('data', d => { stdout += String(d) })
      child.on('error', reject)
      child.on('close', code => resolve({ stdout, status: code ?? 1 }))
    })
  }

  it('dials the store whose scope matches --scope and injects its rows', async () => {
    const { stdout, status } = await injectAsync(['--scope', SCOPE])
    expect(status).toBe(0)
    expect(server.recallCalls).toBe(1)
    expect(server.lastRecallBody?.scopes).toEqual([SCOPE])
    expect(stdout).toContain('canary verification')
  })

  it('without --scope (no project or session context) the store is not dialed', async () => {
    await injectAsync([])
    expect(server.recallCalls).toBe(0)
  })
})
