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
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
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
/** A token with characters that change under each encoding (audit of #1272). */
const ODD = 'plr_SECRET/+=va"lue'
const oddForms = [
  ODD,
  encodeURIComponent(ODD),
  encodeURIComponent(ODD).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()),
  JSON.stringify(ODD).slice(1, -1),
  Buffer.from(ODD).toString('base64'),
  Buffer.from(ODD).toString('base64url'),
]
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
    for (const f of oddForms) expect(allOutput.join('\n')).not.toContain(f)
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
    // #1561 (pre-release check L5): only the variable's name is stored, never
    // the token itself.
    expect(configText()).not.toContain(TOKEN)
    expect(configText()).toContain('token_env: INSTALLER_PLUR_TOKEN')
    // A re-run with the same variable is idempotent and still stores no value.
    const before = configText()
    const again = await cli(['stores', 'add', '--url', baseUrl, '--token-env', 'INSTALLER_PLUR_TOKEN', '--scope', SCOPE, '--json'],
      { env: { INSTALLER_PLUR_TOKEN: TOKEN } })
    expect(again.status, again.stderr).toBe(0)
    expect(JSON.parse(again.stdout)).toMatchObject({ status: 'already_registered' })
    expect(configText()).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('--token-env on a store registered with a literal token replaces the stored token with the reference (#1561)', async () => {
    const lit = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(lit.status, lit.stderr).toBe(0)
    expect(configText()).toContain(TOKEN)
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token-env', 'INSTALLER_PLUR_TOKEN', '--scope', SCOPE, '--json'],
      { env: { INSTALLER_PLUR_TOKEN: TOKEN } })
    expect(r.status, r.stderr).toBe(0)
    expect(configText()).not.toContain(TOKEN)
    expect(configText()).toContain('token_env: INSTALLER_PLUR_TOKEN')
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

  it('scope registered to a different store: exit 1 naming --overwrite-scope, config unchanged', async () => {
    writeFileSync(join(plurDir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - path: "${join(root, 'team.yaml')}"\n    scope: "${SCOPE}"\n`)
    const before = configText()
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE])
    expect(r.status).toBe(1)
    expect(r.stdout + r.stderr).toContain('--overwrite-scope')
    expect(r.stdout + r.stderr).not.toContain('overwriteScope: true')
    expect(configText()).toBe(before)
  }, TEST_TIMEOUT_MS)

  it('--overwrite-scope reassigns the scope after verification', async () => {
    writeFileSync(join(plurDir, 'config.yaml'),
      `embeddings:\n  enabled: false\nstores:\n  - path: "${join(root, 'team.yaml')}"\n    scope: "${SCOPE}"\n`)
    const r = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--overwrite-scope', '--json'])
    expect(r.status, r.stderr).toBe(0)
    expect(JSON.parse(r.stdout)).toMatchObject({ success: true, status: 'overwritten', scope: SCOPE })
    expect(configText()).toContain(baseUrl)
    expect(configText()).not.toContain('team.yaml')
    // A rejected token with the flag still writes nothing.
    const after = configText()
    const bad = await cli(['stores', 'add', '--url', 'http://127.0.0.1:1', '--token', 'wrong-token-SECRET-88', '--scope', SCOPE, '--overwrite-scope'])
    expect(bad.status).toBe(1)
    expect(configText()).toBe(after)
  }, TEST_TIMEOUT_MS)

  it('a server echoing the token in any encoding: nothing printed, text or --json', async () => {
    const echo: Server = createServer((_req, res) => {
      res.writeHead(401, { 'content-type': 'text/plain' })
      res.end(`invalid token ${oddForms.join(' | ')}`)
    })
    await new Promise<void>(r => echo.listen(0, '127.0.0.1', () => r()))
    try {
      const url = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`
      const before = configText()
      for (const extra of [['--json'], []]) {
        const r = await cli(['stores', 'add', '--url', url, '--token-env', 'ODD_TOKEN', '--scope', SCOPE, ...extra],
          { env: { ODD_TOKEN: ODD } })
        expect(r.status).toBe(1)
        for (const f of oddForms) expect(r.stdout + r.stderr).not.toContain(f)
      }
      expect(configText()).toBe(before)
    } finally {
      await new Promise<void>(r => echo.close(() => r()))
    }
  }, TEST_TIMEOUT_MS)

  it('a /me scope list or username carrying the token is never printed', async () => {
    server.setMe({ username: `u-${TOKEN}`, scopes: [SCOPE, `group:${TOKEN}`, 'group:example/ops'] })
    const refused = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', 'group:example/finance', '--json'])
    expect(refused.status).toBe(1)
    expect(refused.stdout + refused.stderr).toContain('group:example/ops')
    const ok = await cli(['stores', 'add', '--url', baseUrl, '--token', TOKEN, '--scope', SCOPE, '--json'])
    expect(ok.status, ok.stderr).toBe(0)
    const text = await inProcess(['add', '--url', baseUrl, '--token', TOKEN, '--scope', 'group:example/ops'])
    for (const out of [refused.stdout + refused.stderr, ok.stdout + ok.stderr, text]) expect(out).not.toContain(TOKEN)
  }, TEST_TIMEOUT_MS)

  it('discover empty state points at the new --url form', async () => {
    const out = await inProcess(['discover'])
    expect(out).toContain('plur stores add --url')
  }, TEST_TIMEOUT_MS)
})
