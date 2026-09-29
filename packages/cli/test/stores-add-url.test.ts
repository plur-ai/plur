/**
 * `plur stores add --url <u> --token <t> --scope <s>` (#1265).
 *
 * An enterprise deployment reported that its installer could not register a
 * url store from a script: `plur stores add` took only `<path> <scope>`. The
 * new form verifies the token against GET /api/v1/me before writing and
 * refuses — writing nothing — when the token is rejected or the scope is not
 * one the token is authorised for. The token may come from `--token`,
 * `--token-env <VAR>` or stdin (`--token -`) so it need not sit in shell
 * history, and it must never appear on stdout, stderr or `--json` output.
 *
 * Real spawned CLI against the in-process StubServer. The spawn is async so
 * the stub (in this process) can answer the child (see forget-namespaced).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn } from 'child_process'
import { StubServer } from '../../core/test/helpers/stub-server.js'
import { builtCliPath } from './helpers/built-cli.js'
// Warm the module graph at collection time (see login.test.ts).
import '../src/commands/stores.js'

const CLI = builtCliPath(join(__dirname, '..'))
const TOKEN = 'stores-add-url-SECRET-token-5c1e'
const SCOPE = 'group:example/eng'
const SPAWN_KILL_MS = 60_000
const TEST_TIMEOUT_MS = 120_000

interface Run { status: number; stdout: string; stderr: string }

let server: StubServer
let baseUrl: string
/** Every byte any CLI run in this file printed — grepped for the token at the end. */
const allOutput: string[] = []

describe('plur stores add --url (#1265)', () => {
  let root: string
  let plurDir: string
  let home: string

  beforeAll(async () => {
    server = new StubServer(TOKEN)
    baseUrl = (await server.start()).url
  })
  afterAll(async () => {
    await server.stop()
    // The token was passed on every run below; it must not appear anywhere.
    expect(allOutput.join('\n')).not.toContain(TOKEN)
    expect(allOutput.join('\n')).not.toContain('wrong-token-SECRET-88')
  })

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-stores-add-url-'))
    plurDir = join(root, 'plur')
    home = join(root, 'home')
    mkdirSync(plurDir, { recursive: true })
    mkdirSync(home, { recursive: true })
    writeFileSync(join(plurDir, 'config.yaml'), 'embeddings:\n  enabled: false\n')
    server.reset()
    server.setMe({ username: 'installer', org_id: 'example', role: 'developer', scopes: [SCOPE, 'group:example/ops'] })
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  const configText = () => readFileSync(join(plurDir, 'config.yaml'), 'utf8')

  function cli(args: string[], opts: { stdin?: string; env?: Record<string, string> } = {}): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn('node', [CLI, ...args, '--path', plurDir], {
        env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: plurDir, ...(opts.env ?? {}) },
        cwd: root,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill('SIGKILL')
        reject(new Error(`plur ${args.join(' ')} timed out; stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(0, 400)}`))
      }, SPAWN_KILL_MS)
      child.stdout.on('data', d => { stdout += String(d) })
      child.stderr.on('data', d => { stderr += String(d) })
      child.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        allOutput.push(stdout, stderr)
        resolve({ status: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() })
      })
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
      else child.stdin.end()
    })
  }

  /** Run the command in THIS process in text mode and return what it printed. */
  async function inProcess(args: string[]): Promise<string> {
    const { run } = await import('../src/commands/stores.js')
    let out = ''
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += String(c); return true })
    const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((c: string | Uint8Array) => { out += String(c); return true })
    try { await run(args, { path: plurDir, json: false }) } finally { spy.mockRestore(); spyErr.mockRestore() }
    allOutput.push(out)
    return out
  }

  it('verifies and registers; --json carries no token', async () => {
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(r.status, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out).toMatchObject({ success: true, status: 'added', url: baseUrl, scope: SCOPE })
    expect(r.stdout + r.stderr).not.toContain(TOKEN)
    expect(configText()).toContain(SCOPE)
    expect(configText()).toContain(baseUrl)
  }, TEST_TIMEOUT_MS)

  it('second identical run exits 0, says already registered, config unchanged', async () => {
    const first = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(first.status, first.stderr).toBe(0)
    const after1 = configText()
    const second = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(second.status, second.stderr).toBe(0)
    expect(JSON.parse(second.stdout)).toMatchObject({ success: true, status: 'already_registered' })
    expect(configText()).toBe(after1)
    // Text mode says so in words (in-process: a spawned child is never a TTY).
    const third = await inProcess(['add', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE])
    expect(third).toMatch(/already registered/i)
    expect(third).not.toContain(TOKEN)
    expect(configText()).toBe(after1)
  }, TEST_TIMEOUT_MS)

  it('rejected token: exit 1, nothing written', async () => {
    const before = configText()
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token', 'wrong-token-SECRET-88', '--scope', SCOPE])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toMatch(/rejected/i)
    expect(configText()).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('scope not authorised: exit 1, names the authorised scopes, nothing written', async () => {
    const before = configText()
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', 'group:example/finance'])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('group:example/finance')
    expect(r.stdout + r.stderr).toContain('group:example/ops')
    expect(configText()).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('--token-env reads the token from the named variable', async () => {
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token-env', 'INSTALLER_PLUR_TOKEN', '--scope', SCOPE, '--json'],
      { env: { INSTALLER_PLUR_TOKEN: TOKEN } })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'added' })
  }, TEST_TIMEOUT_MS)

  it('--token-env naming an unset variable: exit 1, nothing written', async () => {
    const before = configText()
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token-env', 'PLUR_TEST_UNSET_VAR_XYZ', '--scope', SCOPE])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('PLUR_TEST_UNSET_VAR_XYZ')
    expect(configText()).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('--token - reads the token from stdin (trailing newline trimmed)', async () => {
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token', '-', '--scope', SCOPE, '--json'], { stdin: TOKEN + '\n' })
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ status: 'added' })
    expect(configText()).toContain(SCOPE)
  }, TEST_TIMEOUT_MS)

  it('--url without --scope or token: usage error, nothing written', async () => {
    const before = configText()
    const a = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN])
    expect(a.status).toBe(1)
    const b = await cli(['stores', 'add', '--url', baseUrl, '--scope', SCOPE])
    expect(b.status).toBe(1)
    expect(configText()).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('legacy `plur stores add <path> <scope>` is unchanged', async () => {
    const storeFile = join(root, 'team.yaml')
    const r = await cli(['stores', 'add', storeFile, 'project:legacy', '--json'])
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ success: true, status: 'added', path: storeFile, scope: 'project:legacy' })
    expect(existsSync(storeFile)).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('discover empty state points at the new --url form', async () => {
    const out = await inProcess(['discover'])
    expect(out).toContain('plur stores add --url')
  }, TEST_TIMEOUT_MS)
})
