/**
 * init-remote + remote-inject path tests.
 *
 * Coverage for the high-priority paths flagged by the pre-publish
 * audit (criticism #3, cto #6): the YAML parser variants, args bounds
 * checking, .gitignore boundary, and stripRemoteKeys idempotency.
 *
 * Pure CLI process-level tests (matches the init.test.ts pattern):
 * each test spawns the built CLI in a tmpdir with HOME overridden so
 * we never touch the developer's real .plur.yaml.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, realpathSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { spawn, execFileSync } from 'child_process'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { readProjectConfig } from '@plur-ai/core'
import { builtCliPath } from './helpers/built-cli.js'

const CLI = builtCliPath(join(__dirname, '..'))

/**
 * Async runner — critical for these tests. The earlier execSync version
 * blocks the parent's event loop, which means the local stub HTTP server
 * (started in beforeEach) can't accept the connection from the child CLI
 * process. The child times out with "operation aborted" and tests fail.
 * spawn + Promise lets the parent keep processing the server event loop
 * while the child runs.
 */
function runCli(args: string | string[], cwd: string, home: string): Promise<{ stdout: string; status: number }> {
  return new Promise(resolve => {
    const child = spawn('node', [CLI, ...(Array.isArray(args) ? args : args.split(' ').filter(s => s.length > 0))], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, PLUR_PATH: join(home, '.plur'), PLUR_AUTO_DISCOVER: '0' },
    })
    let out = ''
    child.stdout.on('data', c => { out += c.toString() })
    child.stderr.on('data', c => { out += c.toString() })
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 8000)
    child.on('error', error => { clearTimeout(timer); resolve({ stdout: out + error.message, status: 1 }) })
    child.on('close', code => { clearTimeout(timer); resolve({ stdout: out, status: code ?? 124 }) })
  })
}

describe('plur init-remote', () => {
  let home: string
  let cwd: string
  let server: Server
  let serverUrl: string
  let projectRoot: string
  let lastRequest: { auth?: string; body?: any; path?: string } = {}
  let nextResponse: (req: { path: string }) => { status: number; body: any } =
    () => ({ status: 200, body: { username: 'test-user', org_id: 'test-org', scopes: ['user:test'] } })

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'plur-init-remote-home-'))
    projectRoot = mkdtempSync(join(tmpdir(), 'plur-init-remote-proj-'))
    cwd = join(projectRoot, 'project'); mkdirSync(cwd)
    nextResponse = () => ({ status: 200, body: { username: 'test-user', org_id: 'test-org', scopes: ['user:test'] } })
    // Mark cwd as a git project so the .gitignore walk stops there
    mkdirSync(join(cwd, '.git'))

    // Stub server — handles /api/v1/me (verifyConnectivity) and
    // /api/v1/inject (hook-inject remote call) via the nextResponse hook.
    lastRequest = {}
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        lastRequest = {
          auth: req.headers.authorization,
          body: chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined,
          path: req.url ?? '',
        }
        const r = nextResponse({ path: req.url ?? '' })
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.body))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    rmSync(home, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('writes .plur.yaml and updates .gitignore on success', async () => {
    const r = await runCli(`init-remote --url ${serverUrl} --token test-token`, cwd, home)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain(`Wrote ${join(realpathSync(cwd), '.plur.yaml')}`)
    expect(r.stdout).toContain('Token sensitivity')   // cloud-sync warning
    const yaml = readFileSync(join(cwd, '.plur.yaml'), 'utf8')
    expect(yaml).toContain(`remote_url: ${serverUrl}`)
    expect(yaml).toContain('remote_token: test-token')
    const gi = readFileSync(join(cwd, '.gitignore'), 'utf8')
    expect(gi).toContain('.plur.yaml')
  })

  it('refuses to write when --url is missing a value (args bounds check)', async () => {
    const r = await runCli(`init-remote --url --token x`, cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('--url requires a value')
    expect(existsSync(join(cwd, '.plur.yaml'))).toBe(false)
  })

  it('refuses to write when --scopes is the last flag with no value', async () => {
    const r = await runCli(`init-remote --url ${serverUrl} --token x --scopes`, cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('--scopes requires a value')
  })

  it('refuses to write when --token has a newline character', async () => {
    const r = await runCli(['init-remote', '--url', serverUrl, '--token', 'ab\nc'], cwd, home)
    expect(r.status).toBe(1)
    expect(existsSync(join(cwd, '.plur.yaml'))).toBe(false)
    expect(lastRequest.path).toBeUndefined()
  })

  it('round-trips quoted tokens and preserves nested non-remote keys in private config', async () => {
    writeFileSync(join(cwd, '.plur.yaml'), 'custom:\n  remote_url: https://preserve.example\n  values: [one, two]\n', { mode: 0o644 })
    const token = "a'quoted # token: value"
    const r = await runCli(['init-remote', '--url', serverUrl, '--token', token], cwd, home)
    expect(r.status).toBe(0)
    expect(readProjectConfig(cwd).remote_token).toBe(token)
    expect(readFileSync(join(cwd, '.plur.yaml'), 'utf8')).toContain('https://preserve.example')
    expect(statSync(join(cwd, '.plur.yaml')).mode & 0o777).toBe(0o600)
    expect((await runCli('init-remote --verify', cwd, home)).status).toBe(0)
    expect(lastRequest.auth).toBe(`Bearer ${token}`)
  })

  it('preserves malformed existing project config and omits its contents from diagnostics', async () => {
    const bytes = 'custom: [sensitive-example'; writeFileSync(join(cwd, '.plur.yaml'), bytes)
    const r = await runCli(['init-remote', '--url', serverUrl, '--token', 'new-token'], cwd, home)
    expect(r.status).not.toBe(0)
    expect(readFileSync(join(cwd, '.plur.yaml'), 'utf8')).toBe(bytes)
    expect(r.stdout).not.toContain('sensitive-example')
  })

  it('does not publish credentials when ignore protection cannot be installed', async () => {
    mkdirSync(join(cwd, '.gitignore'))
    const r = await runCli(['init-remote', '--url', serverUrl, '--token', 'new-token'], cwd, home)
    expect(r.status).not.toBe(0)
    expect(existsSync(join(cwd, '.plur.yaml'))).toBe(false)
  })

  it('does not mistake an earlier ignore rule for protection when a later rule negates it', async () => {
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
    execFileSync('git', ['init'], { cwd, env, stdio: 'pipe' })
    writeFileSync(join(cwd, '.gitignore'), '.plur.yaml\n!.plur.yaml\n')
    const r = await runCli(['init-remote', '--url', serverUrl, '--token', 'new-token'], cwd, home)
    expect(r.status).toBe(0)
    expect(execFileSync('git', ['check-ignore', '--', '.plur.yaml'], { cwd, env, encoding: 'utf8' }).trim()).toBe('.plur.yaml')
  })

  it('refuses a non-http/https URL scheme', async () => {
    const r = await runCli(`init-remote --url file:///etc/passwd --token x`, cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('must be http')
  })

  it('refuses to write a broken config when connectivity fails', async () => {
    nextResponse = () => ({ status: 401, body: { error: 'bad token' } })
    const r = await runCli(`init-remote --url ${serverUrl} --token bad`, cwd, home)
    expect(r.status).toBe(2)
    expect(r.stdout).toContain('Connection failed')
    expect(existsSync(join(cwd, '.plur.yaml'))).toBe(false)
  })

  it('is idempotent: re-running preserves non-remote keys and replaces remote_* block', async () => {
    // Pre-existing config with domain/scope + old remote_url
    writeFileSync(join(cwd, '.plur.yaml'),
      'domain: my-project\n' +
      'scope: org:plur\n' +
      'remote_url: https://old.example.com\n' +
      'remote_token: old-token\n' +
      'remote_scopes:\n' +
      '  - org:plur\n' +
      '  - group:plur/eng\n')

    const r = await runCli(`init-remote --url ${serverUrl} --token new-token --scopes org:plur`, cwd, home)
    expect(r.status).toBe(0)

    const yaml = readFileSync(join(cwd, '.plur.yaml'), 'utf8')
    expect(yaml).toContain('domain: my-project')      // preserved
    expect(yaml).toContain('scope: org:plur')          // preserved
    expect(yaml).toContain(`remote_url: ${serverUrl}`) // new
    expect(yaml).toContain('remote_token: new-token')  // new
    expect(yaml).not.toContain('https://old.example.com')
    expect(yaml).not.toContain('old-token')
    expect(yaml).not.toContain('group:plur/eng')       // old list dropped
  })

  it('stops the .gitignore walk at .git boundary', async () => {
    // Project at cwd, parent-of-parent has another .gitignore (monorepo root)
    const monorepo = join(cwd, '..')
    const monorepoGitignore = join(monorepo, '.gitignore.tmp-monorepo')
    writeFileSync(monorepoGitignore, '# monorepo gitignore\n')

    const r = await runCli(`init-remote --url ${serverUrl} --token x`, cwd, home)
    expect(r.status).toBe(0)
    // ensureGitignore should have stopped at cwd/.git boundary and
    // created cwd/.gitignore, NOT touched anything in the parent.
    expect(existsSync(join(cwd, '.gitignore'))).toBe(true)
    const original = readFileSync(monorepoGitignore, 'utf8')
    expect(original).toBe('# monorepo gitignore\n')   // untouched
    rmSync(monorepoGitignore)
  })
})

describe('plur init-remote --verify', () => {
  let home: string
  let cwd: string
  let server: Server
  let serverUrl: string

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'plur-verify-home-'))
    cwd  = mkdtempSync(join(tmpdir(), 'plur-verify-proj-'))
    mkdirSync(join(cwd, '.git'))
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ username: 'u', org_id: 'o', scopes: ['user:u'] }))
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('reports success when config + connectivity are valid', async () => {
    writeFileSync(join(cwd, '.plur.yaml'),
      `remote_url: ${serverUrl}\nremote_token: valid-token\n`)
    const r = await runCli(`init-remote --verify`, cwd, home)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Connected to')
  })

  it('exits non-zero when no remote config is present in cwd', async () => {
    const r = await runCli(`init-remote --verify`, cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('No remote config')
  })
})
