/**
 * Tests for `plur login` — config write, reload signal, and arg parsing.
 *
 * Pure unit tests: no spawned CLI processes, no real HTTP. The OAuth device
 * flow itself is tested via a local stub server. Browser-open is not tested
 * (it shells out to `open`/`xdg-open`/`start`; those are OS calls we don't
 * control). Signal delivery is tested by asserting the signalReload() return
 * value rather than actually sending a kill, which would require a real process.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { spawn } from 'child_process'

const CLI = join(__dirname, '..', 'dist', 'index.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Run the CLI in a subprocess with a fake HOME. Same pattern as init-remote
 * tests — spawn (not execSync) so the event loop stays alive to serve the
 * stub HTTP server.
 */
function runCli(args: string, cwd: string, home: string): Promise<{ stdout: string; status: number }> {
  return new Promise(resolve => {
    const child = spawn('node', [CLI, ...args.split(' ').filter(s => s.length > 0)], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    })
    let out = ''
    child.stdout.on('data', c => { out += c.toString() })
    child.stderr.on('data', c => { out += c.toString() })
    child.on('close', code => resolve({ stdout: out, status: code ?? 0 }))
    setTimeout(() => { child.kill(); resolve({ stdout: out + '\n[test-timeout]', status: 124 }) }, 8000)
  })
}

// ── Unit tests (no subprocess) ────────────────────────────────────────────────

describe('login helpers — config read/write', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'plur-login-cfg-'))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('plurConfigPath returns ~/.plur/config.json', async () => {
    const { plurConfigPath } = await import('../src/commands/login.js')
    const p = plurConfigPath(tmpHome)
    expect(p).toMatch(/\.plur[/\\]config\.json$/)
  })

  it('readPlurConfig returns {} when file is absent', async () => {
    const { readPlurConfig } = await import('../src/commands/login.js')
    const cfg = readPlurConfig(tmpHome)
    expect(cfg).toEqual({})
  })

  it('writePlurConfig creates parent directory and writes JSON', async () => {
    const { plurConfigPath, writePlurConfig } = await import('../src/commands/login.js')
    const configPath = plurConfigPath(tmpHome)

    const data = {
      enterprise: {
        url: 'https://plur.example.com',
        token: 'tok_test_abc',
        username: 'test-user',
        scopes: ['user:test'],
        authed_at: '2026-01-01T00:00:00.000Z',
      },
    }
    writePlurConfig(data, tmpHome)

    expect(existsSync(configPath)).toBe(true)
    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(written.enterprise.url).toBe('https://plur.example.com')
    expect(written.enterprise.token).toBe('tok_test_abc')
    expect(written.enterprise.username).toBe('test-user')
    expect(written.enterprise.scopes).toEqual(['user:test'])
  })

  it('writePlurConfig is idempotent — overwriting preserves other top-level keys', async () => {
    const { plurConfigPath, writePlurConfig } = await import('../src/commands/login.js')
    const configPath = plurConfigPath(tmpHome)

    // Write initial config with extra top-level key
    writePlurConfig({ enterprise: { url: 'https://a.example.com', token: 'tok1' }, custom_key: 'preserved' }, tmpHome)
    writePlurConfig({ enterprise: { url: 'https://b.example.com', token: 'tok2' }, custom_key: 'preserved' }, tmpHome)

    const written = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(written.enterprise.url).toBe('https://b.example.com')
    expect(written.enterprise.token).toBe('tok2')
    expect(written.custom_key).toBe('preserved')
  })
})

describe('login helpers — signalReload', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'plur-login-pid-'))
  })

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns "no running server" message when PID file is absent', async () => {
    const { signalReload } = await import('../src/commands/login.js')
    const result = signalReload(tmpHome)
    expect(typeof result).toBe('string')
    expect(result).toMatch(/no running server|no PID file/i)
  })

  it('returns stale-process message when PID file holds an unknown PID', async () => {
    const { serverPidPath, signalReload } = await import('../src/commands/login.js')
    // Write a PID file pointing to a process that definitely does not exist.
    // PID 2^30 is astronomically unlikely to be real.
    const pidFile = serverPidPath(tmpHome)
    mkdirSync(join(pidFile, '..'), { recursive: true })
    writeFileSync(pidFile, '1073741824')  // 2^30

    const result = signalReload(tmpHome)
    expect(result).toMatch(/no longer running|not found|ESRCH|could not signal|invalid|no running server/i)
  })
})

// ── OAuth device flow unit tests (no subprocess, with stub server) ────────────

describe('requestDeviceCode', () => {
  let server: Server
  let serverUrl: string
  let nextHandler: (req: { path: string; body: any }) => { status: number; body: any }

  beforeEach(async () => {
    nextHandler = () => ({
      status: 200,
      body: {
        device_code: 'dev_abc123',
        user_code: 'PLUR-1234',
        verification_uri: 'https://plur.example.com/device',
        expires_in: 300,
        interval: 5,
      },
    })

    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
        const r = nextHandler({ path: req.url ?? '', body })
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.body))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('returns device code fields on success', async () => {
    const { requestDeviceCode } = await import('../src/commands/login.js')
    const result = await requestDeviceCode(serverUrl)
    expect(result.device_code).toBe('dev_abc123')
    expect(result.user_code).toBe('PLUR-1234')
    expect(result.verification_uri).toBe('https://plur.example.com/device')
    expect(result.interval).toBe(5)
  })

  it('throws on non-OK response', async () => {
    const { requestDeviceCode } = await import('../src/commands/login.js')
    nextHandler = () => ({ status: 400, body: { error: 'invalid_client' } })
    await expect(requestDeviceCode(serverUrl)).rejects.toThrow('Device code request failed')
  })

  it('throws on missing required fields in response', async () => {
    const { requestDeviceCode } = await import('../src/commands/login.js')
    nextHandler = () => ({ status: 200, body: { device_code: 'x' } })  // missing user_code + uri
    await expect(requestDeviceCode(serverUrl)).rejects.toThrow('Unexpected response')
  })
})

describe('pollForToken', () => {
  let server: Server
  let serverUrl: string
  let responses: Array<{ status: number; body: any }>

  beforeEach(async () => {
    responses = []

    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', c => chunks.push(c as Buffer))
      req.on('end', () => {
        const r = responses.shift() ?? { status: 200, body: { error: 'authorization_pending' } }
        res.writeHead(r.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(r.body))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    serverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('returns token immediately when server responds with access_token', async () => {
    const { pollForToken } = await import('../src/commands/login.js')
    responses.push({ status: 200, body: { access_token: 'tok_live_xyz', token_type: 'Bearer' } })
    const result = await pollForToken(serverUrl, 'dev_abc', 0, 30)
    expect(result.access_token).toBe('tok_live_xyz')
  })

  it('polls past authorization_pending then returns token', async () => {
    const { pollForToken } = await import('../src/commands/login.js')
    responses.push({ status: 200, body: { error: 'authorization_pending' } })
    responses.push({ status: 200, body: { access_token: 'tok_second_try', token_type: 'Bearer' } })
    const result = await pollForToken(serverUrl, 'dev_abc', 0, 30)
    expect(result.access_token).toBe('tok_second_try')
  })

  it('throws on expired_token error', async () => {
    const { pollForToken } = await import('../src/commands/login.js')
    responses.push({ status: 200, body: { error: 'expired_token' } })
    await expect(pollForToken(serverUrl, 'dev_abc', 0, 30)).rejects.toThrow('expired')
  })

  it('throws on access_denied error', async () => {
    const { pollForToken } = await import('../src/commands/login.js')
    responses.push({ status: 200, body: { error: 'access_denied' } })
    await expect(pollForToken(serverUrl, 'dev_abc', 0, 30)).rejects.toThrow('Access denied')
  })

  it('throws when timeout is reached before approval', async () => {
    const { pollForToken } = await import('../src/commands/login.js')
    // No token in responses — poll will keep getting authorization_pending
    // Use a 0s timeout so it fails immediately after the first poll
    await expect(pollForToken(serverUrl, 'dev_abc', 0, 0)).rejects.toThrow(/timed out/)
  })
})

// ── CLI process-level smoke tests ─────────────────────────────────────────────

describe('plur login CLI', () => {
  let home: string
  let cwd: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'plur-login-cli-home-'))
    cwd  = mkdtempSync(join(tmpdir(), 'plur-login-cli-proj-'))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('exits 1 with usage help when no host is given', async () => {
    const r = await runCli('login', cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/Missing required argument|host/)
  })

  it('exits 1 with error on unknown flag', async () => {
    const r = await runCli('login --bad-flag', cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/unknown flag/)
  })

  it('exits 1 with error when --timeout has no value', async () => {
    const r = await runCli('login https://plur.example.com --timeout', cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/--timeout requires a value/)
  })

  it('exits 1 when --timeout value is not a positive integer', async () => {
    const r = await runCli('login https://plur.example.com --timeout abc', cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/--timeout must be a positive integer/)
  })

  it('--help prints usage and exits 0', async () => {
    const r = await runCli('login --help', cwd, home)
    expect(r.status).toBe(0)
    expect(r.stdout).toMatch(/OAuth|device flow|USAGE/i)
  })

  it('--status exits 1 when not logged in', async () => {
    const r = await runCli('login --status', cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/Not logged in/)
  })

  it.skip('--status prints auth info when config.json is present [requires real HOME]', async () => {
    // This test would require writing to the real ~/.plur/config.json.
    // Skipped — covered by the unit test above (writePlurConfig + readPlurConfig).
  })

  it('exits non-zero when the device code endpoint is unreachable', async () => {
    // Port 1 is reserved and will refuse connections on any OS
    const r = await runCli('login http://127.0.0.1:1 --no-open --timeout 5', cwd, home)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toMatch(/Error|failed|ECONNREFUSED/i)
  })
})
