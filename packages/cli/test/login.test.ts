/**
 * Tests for `plur login` — token status (#587), config write, reload signal,
 * and arg parsing.
 *
 * The `--status` path is covered at two levels: pure unit tests over the
 * exported classification/report helpers (JWT expiry classification, grouping
 * fan-in via buildStatusReport, remediation strings), and process-level tests
 * spawning the real CLI against the core StubServer (real HTTP) for exit
 * codes, --json shape, and the unreachable-host path. The OAuth device flow
 * helpers are tested via a local stub server; the flow itself is GATED in the
 * command (#300/#532) and the gate is pinned here. Browser-open is not tested
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
import { StubServer } from '../../core/test/helpers/stub-server.js'
// Warm the module graph at collection time: login.js now pulls in the full
// @plur-ai/core barrel (checkRemoteHealth reuse, #587), and paying that import
// inside the FIRST per-test dynamic import blows the 5s test timeout.
import '../src/commands/login.js'

const CLI = join(__dirname, '..', 'dist', 'index.js')

const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
const makeJwt = (payload: object) =>
  `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.sig`
/** JWT expiring `days` whole days from now (+1h slack so day math is stable). */
const jwtExpiringIn = (days: number, claims: object = {}) =>
  makeJwt({ sub: 'gregor', orgId: 'igea', exp: Math.floor(Date.now() / 1000) + days * 86_400 + 3_600, ...claims })

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

// ── Token-status helpers (#587) — pure unit tests ─────────────────────────────

describe('classifyTokenStatus (#587)', () => {
  it('probe ok + far-future expiry → VALID', async () => {
    const { classifyTokenStatus } = await import('../src/commands/login.js')
    expect(classifyTokenStatus({ status: 'ok', tokenExpiresInDays: 23 })).toBe('VALID')
  })

  it('probe ok + opaque key (no expiry claim) → VALID', async () => {
    const { classifyTokenStatus } = await import('../src/commands/login.js')
    expect(classifyTokenStatus({ status: 'ok', tokenExpiresInDays: null })).toBe('VALID')
  })

  it('probe ok + <7d to expiry → EXPIRING SOON (boundary: 6 yes, 7 no)', async () => {
    const { classifyTokenStatus } = await import('../src/commands/login.js')
    expect(classifyTokenStatus({ status: 'ok', tokenExpiresInDays: 6 })).toBe('EXPIRING SOON')
    expect(classifyTokenStatus({ status: 'ok', tokenExpiresInDays: 0 })).toBe('EXPIRING SOON')
    expect(classifyTokenStatus({ status: 'ok', tokenExpiresInDays: 7 })).toBe('VALID')
  })

  it('auth failure + locally-expired JWT → EXPIRED', async () => {
    const { classifyTokenStatus } = await import('../src/commands/login.js')
    expect(classifyTokenStatus({ status: 'auth_expired', tokenExpiresInDays: -3 })).toBe('EXPIRED')
  })

  it('auth failure + non-expired or opaque token → INVALID (revoked/wrong)', async () => {
    const { classifyTokenStatus } = await import('../src/commands/login.js')
    expect(classifyTokenStatus({ status: 'auth_expired', tokenExpiresInDays: 20 })).toBe('INVALID')
    expect(classifyTokenStatus({ status: 'auth_expired', tokenExpiresInDays: null })).toBe('INVALID')
  })

  it('network failure → UNREACHABLE (not an auth verdict)', async () => {
    const { classifyTokenStatus } = await import('../src/commands/login.js')
    expect(classifyTokenStatus({ status: 'unreachable', tokenExpiresInDays: 23 })).toBe('UNREACHABLE')
  })
})

describe('formatRelativeExpiry (#587)', () => {
  it('formats future, past, same-day, and opaque expiries', async () => {
    const { formatRelativeExpiry } = await import('../src/commands/login.js')
    expect(formatRelativeExpiry(23)).toBe('expires in 23d')
    expect(formatRelativeExpiry(-3)).toBe('EXPIRED 3d ago')
    expect(formatRelativeExpiry(0)).toBe('expires in <1d')
    expect(formatRelativeExpiry(null)).toMatch(/no expiry claim/)
    expect(formatRelativeExpiry(undefined)).toMatch(/no expiry claim/)
  })
})

describe('buildStatusReport (#587)', () => {
  it('maps a healthy probe to VALID with granted-scope count and mounted scopes', async () => {
    const { buildStatusReport } = await import('../src/commands/login.js')
    const report = buildStatusReport([{
      url: 'https://plur.example.com', scopes: ['group:igea/gis'], status: 'ok', ok: true,
      tokenExpiresAt: '2026-08-23T00:00:00.000Z', tokenExpiresInDays: 23,
      tokenSubject: 'gregor', tokenOrg: 'igea', username: 'gregor', orgId: 'igea', grantedScopes: 5,
    }])
    expect(report.ok).toBe(true)
    const h = report.hosts[0]
    expect(h.status).toBe('VALID')
    expect(h.subject).toBe('gregor')
    expect(h.org).toBe('igea')
    expect(h.expiry).toBe('expires in 23d')
    expect(h.probe).toEqual({ probed: true, reachable: true, grantedScopes: 5 })
    expect(h.mountedScopes).toEqual(['group:igea/gis'])
    expect(h.remediation).toBeUndefined()
  })

  it('marks a locally-expired token EXPIRED with probe skipped, and fails the report', async () => {
    const { buildStatusReport } = await import('../src/commands/login.js')
    const report = buildStatusReport([{
      url: 'https://plur.example.com', scopes: ['group:igea/gis'], status: 'auth_expired', ok: false,
      reason: 'token expired 2026-07-28T00:00:00.000Z',
      tokenExpiresAt: '2026-07-28T00:00:00.000Z', tokenExpiresInDays: -3, tokenSubject: 'gregor',
    }])
    expect(report.ok).toBe(false)
    const h = report.hosts[0]
    expect(h.status).toBe('EXPIRED')
    expect(h.expiry).toBe('EXPIRED 3d ago')
    expect(h.probe.probed).toBe(false)
    expect(h.remediation).toBeTruthy()
  })

  it('EXPIRED/INVALID remediation gives the sign-in-URL + plur_stores_add flow and never suggests running plur login', async () => {
    const { buildStatusReport } = await import('../src/commands/login.js')
    const report = buildStatusReport([
      { url: 'https://plur.example.com', scopes: ['group:a'], status: 'auth_expired', ok: false, tokenExpiresInDays: -3 },
      { url: 'https://other.example.com', scopes: ['group:b'], status: 'auth_expired', ok: false, tokenExpiresInDays: null, reason: 'Remote /me failed: 401' },
    ])
    for (const h of report.hosts) {
      const fix = h.remediation!
      // A4′ flow: sign in at <host>/auth, re-add via plur_stores_add.
      expect(fix).toContain('/auth')
      expect(fix).toContain('plur_stores_add')
      // `plur login` must never be SUGGESTED — enterprise servers have no
      // device-flow endpoints. The A4′ string may only mention it to say it
      // does NOT work.
      expect(fix).not.toMatch(/run\s+`?plur login/i)
      for (const m of fix.matchAll(/`?plur login`?/g)) {
        expect(fix.slice(m.index)).toMatch(/^`?plur login`? does not work/)
      }
    }
  })

  it('UNREACHABLE does not fail the report (network is not an auth verdict)', async () => {
    const { buildStatusReport } = await import('../src/commands/login.js')
    const report = buildStatusReport([{
      url: 'https://plur.example.com', scopes: ['group:a'], status: 'unreachable', ok: false,
      reason: 'fetch failed', tokenExpiresInDays: 23,
    }])
    expect(report.hosts[0].status).toBe('UNREACHABLE')
    expect(report.hosts[0].probe).toEqual({ probed: true, reachable: false, reason: 'fetch failed' })
    expect(report.ok).toBe(true)
  })

  it('an empty credential set is not ok, and an unmounted legacy login token is flagged', async () => {
    const { buildStatusReport } = await import('../src/commands/login.js')
    const report = buildStatusReport([], { url: 'https://plur.example.com', mounted: false })
    expect(report.ok).toBe(false)
    expect(report.hosts).toEqual([])
    expect(report.legacyLogin).toEqual({ url: 'https://plur.example.com', mounted: false })
  })
})

describe('formatStatusLines (#587)', () => {
  it('renders one block per credential with status, expiry, probe, and mounted scopes', async () => {
    const { buildStatusReport, formatStatusLines } = await import('../src/commands/login.js')
    const report = buildStatusReport([
      { url: 'https://a.example.com', scopes: ['group:a'], status: 'ok', ok: true, tokenExpiresInDays: 23, tokenExpiresAt: '2026-08-23T00:00:00.000Z', tokenSubject: 'gregor', tokenOrg: 'igea', grantedScopes: 5 },
      { url: 'https://b.example.com', scopes: ['group:b'], status: 'auth_expired', ok: false, tokenExpiresInDays: -3 },
    ])
    const text = formatStatusLines(report).join('\n')
    expect(text).toContain('✓ https://a.example.com — VALID')
    expect(text).toContain('identity: gregor (org: igea)')
    expect(text).toContain('5 scope(s) granted')
    expect(text).toContain('mounted:  group:a')
    expect(text).toContain('✗ https://b.example.com — EXPIRED')
    expect(text).toContain('not probed — token already expired')
  })

  it('with no credentials, points at the /auth + plur_stores_add flow (never `plur login`)', async () => {
    const { buildStatusReport, formatStatusLines } = await import('../src/commands/login.js')
    const text = formatStatusLines(buildStatusReport([])).join('\n')
    expect(text).toContain('No enterprise tokens configured')
    expect(text).toContain('plur_stores_add')
    expect(text).not.toMatch(/run\s+`?plur login/i)
  })

  it('flags an unmounted legacy config.json token as unused', async () => {
    const { buildStatusReport, formatStatusLines } = await import('../src/commands/login.js')
    const text = formatStatusLines(buildStatusReport([], { url: 'https://plur.example.com', mounted: false })).join('\n')
    expect(text).toContain('legacy `plur login` token')
    expect(text).toContain('nothing reads it')
  })
})

// ── CLI process-level tests ───────────────────────────────────────────────────
// `login` is registered in the dispatcher for `--status` (#587); the device
// flow itself is gated inside the command (#300/#532) — pinned below.

/** Write a plur root (config.yaml) and return its --path value. */
function writePlurRoot(stores: Array<Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'plur-login-root-'))
  const storeYaml = stores.map(s =>
    `  - ${Object.entries(s).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n    ')}`,
  ).join('\n')
  writeFileSync(
    join(dir, 'config.yaml'),
    `embeddings:\n  enabled: false\nindex: false\nstores:\n${storeYaml}\n`,
  )
  return dir
}

/** Parse the JSON object line from combined CLI output (ignores log noise). */
function parseJsonOut(stdout: string): any {
  const line = stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('{')).pop()
  expect(line, `no JSON line in output:\n${stdout}`).toBeTruthy()
  return JSON.parse(line!)
}

describe('plur login CLI (gated device flow + arg errors)', () => {
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

  it('--help prints usage (global help intercepts) and exits 0, listing login --status', async () => {
    const r = await runCli('login --help', cwd, home)
    expect(r.status).toBe(0)
    // The dispatcher's global --help intercept answers before command dispatch;
    // it must list the new status surface.
    expect(r.stdout).toMatch(/Usage/i)
    expect(r.stdout).toMatch(/login --status/)
  })

  it('device flow is gated: `plur login <host>` exits 1 with the /auth + plur_stores_add path', async () => {
    const r = await runCli('login https://plur.example.com', cwd, home)
    expect(r.status).toBe(1)
    expect(r.stdout).toMatch(/not available yet/)
    expect(r.stdout).toContain('https://plur.example.com/auth')
    expect(r.stdout).toContain('plur_stores_add')
    // The flow must not have started — no device code prompt.
    expect(r.stdout).not.toMatch(/one-time code/)
  })
})

describe('plur login --status (#587) — exit codes and --json shape', () => {
  const TOKEN = 'status-test-token'
  let server: StubServer
  let baseUrl: string
  let home: string
  let cwd: string
  const roots: string[] = []

  beforeEach(async () => {
    server = new StubServer(TOKEN)
    const info = await server.start()
    baseUrl = info.url
    server.setMe({ username: 'gregor', org_id: 'igea', role: 'developer', scopes: ['group:igea/gis', 'group:igea/eng', 'user:igea:gregor'] })
    home = mkdtempSync(join(tmpdir(), 'plur-status-home-'))
    cwd  = mkdtempSync(join(tmpdir(), 'plur-status-proj-'))
  })

  afterEach(async () => {
    await server.stop()
    rmSync(home, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
  })

  const root = (stores: Array<Record<string, unknown>>): string => {
    const dir = writePlurRoot(stores)
    roots.push(dir)
    return dir
  }

  it('exits 1 with an empty report when nothing is configured', async () => {
    const r = await runCli('login --status --json', cwd, home)
    expect(r.status).toBe(1)
    const report = parseJsonOut(r.stdout)
    expect(report.hosts).toEqual([])
    expect(report.ok).toBe(false)
  })

  it('VALID: reachable host + accepted opaque token → exit 0, full JSON row, no token leaked', async () => {
    const dir = root([{ url: baseUrl, token: TOKEN, scope: 'group:igea/gis' }])
    const r = await runCli(`login --status --json --path ${dir}`, cwd, home)
    expect(r.status).toBe(0)
    const report = parseJsonOut(r.stdout)
    expect(report.ok).toBe(true)
    expect(report.hosts).toHaveLength(1)
    const h = report.hosts[0]
    expect(h.url).toBe(baseUrl)
    expect(h.status).toBe('VALID')
    expect(h.subject).toBe('gregor')
    expect(h.org).toBe('igea')
    expect(h.probe).toEqual({ probed: true, reachable: true, grantedScopes: 3 })
    expect(h.mountedScopes).toEqual(['group:igea/gis'])
    // The token value itself must never appear anywhere in the output.
    expect(r.stdout).not.toContain(TOKEN)
  })

  it('EXPIRED: locally-expired JWT → exit 1, remediation is /auth + plur_stores_add', async () => {
    const expired = jwtExpiringIn(-3)
    const dir = root([{ url: baseUrl, token: expired, scope: 'group:igea/gis' }])
    const r = await runCli(`login --status --json --path ${dir}`, cwd, home)
    expect(r.status).toBe(1)
    const h = parseJsonOut(r.stdout).hosts[0]
    expect(h.status).toBe('EXPIRED')
    expect(h.subject).toBe('gregor')
    expect(h.expiry).toMatch(/^EXPIRED \dd ago$/)
    expect(h.probe.probed).toBe(false)
    expect(h.remediation).toContain('/auth')
    expect(h.remediation).toContain('plur_stores_add')
    expect(r.stdout).not.toContain(expired)
  })

  it('INVALID: server rejects a non-expired token (401) → exit 1', async () => {
    const dir = root([{ url: baseUrl, token: 'wrong-token', scope: 'group:igea/gis' }])
    const r = await runCli(`login --status --json --path ${dir}`, cwd, home)
    expect(r.status).toBe(1)
    const h = parseJsonOut(r.stdout).hosts[0]
    expect(h.status).toBe('INVALID')
    expect(h.probe.probed).toBe(true)
    expect(h.probe.reachable).toBe(true)
  })

  it('EXPIRING SOON: valid JWT with <7d left → exit 0 but flagged', async () => {
    const soonJwt = jwtExpiringIn(3)
    const soonServer = new StubServer(soonJwt) // server accepts exactly this JWT
    const info = await soonServer.start()
    try {
      const dir = root([{ url: info.url, token: soonJwt, scope: 'group:igea/gis' }])
      const r = await runCli(`login --status --json --path ${dir}`, cwd, home)
      expect(r.status).toBe(0)
      const h = parseJsonOut(r.stdout).hosts[0]
      expect(h.status).toBe('EXPIRING SOON')
      expect(h.expiry).toMatch(/^expires in \dd$/)
      expect(h.remediation).toContain('plur_stores_add')
    } finally {
      await soonServer.stop()
    }
  })

  it('UNREACHABLE: host down → exit 0 (network is not an auth verdict)', async () => {
    const down = new StubServer(TOKEN)
    const info = await down.start()
    await down.stop() // port now closed
    const dir = root([{ url: info.url, token: TOKEN, scope: 'group:igea/gis' }])
    const r = await runCli(`login --status --json --path ${dir}`, cwd, home)
    expect(r.status).toBe(0)
    const h = parseJsonOut(r.stdout).hosts[0]
    expect(h.status).toBe('UNREACHABLE')
    expect(h.probe.reachable).toBe(false)
  })

  it('groups by distinct (url, token): one dead second token fails the whole status', async () => {
    const dir = root([
      { url: baseUrl, token: TOKEN, scope: 'group:igea/gis' },
      { url: baseUrl, token: 'dead-second-token', scope: 'group:igea/eng' },
    ])
    const r = await runCli(`login --status --json --path ${dir}`, cwd, home)
    expect(r.status).toBe(1)
    const report = parseJsonOut(r.stdout)
    expect(report.hosts).toHaveLength(2)
    const statuses = report.hosts.map((h: any) => h.status).sort()
    expect(statuses).toEqual(['INVALID', 'VALID'])
  })

  it('flags an unmounted legacy config.json token instead of probing it', async () => {
    mkdirSync(join(home, '.plur'), { recursive: true })
    writeFileSync(
      join(home, '.plur', 'config.json'),
      JSON.stringify({ enterprise: { url: 'https://legacy.example.com', token: 'legacy-token' } }),
    )
    const r = await runCli('login --status --json', cwd, home)
    expect(r.status).toBe(1) // no mounted credentials → not ok
    const report = parseJsonOut(r.stdout)
    expect(report.legacyLogin).toEqual({ url: 'https://legacy.example.com', mounted: false })
    expect(r.stdout).not.toContain('legacy-token')
  })
})
