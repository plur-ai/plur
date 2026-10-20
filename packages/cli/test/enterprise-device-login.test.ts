/**
 * The device sign-in client, un-gated (#1638, plan C Task 3).
 *
 * `deviceSignIn` runs RFC 8628 against `/api/v1/auth/device` and
 * `/api/v1/auth/token` with the C3 field names: the poll interval and
 * `slow_down` are honoured, a 429 is backed off, every RFC error has a plain
 * message, and the key is never printed. `plur login <host>` then writes the
 * one server entry to config.yaml through core's registration (never
 * `~/.plur/config.json`), takes the personal scope from `/me`, names a stale
 * entry that holds that scope and offers `--remove-stale`, and leaves nothing
 * behind when interrupted. A remaining `~/.plur/config.json` is moved into
 * config.yaml once, with a notice, then no longer read.
 *
 * The unit tests script `fetch` per URL; the process tests run the built CLI
 * against an in-test HTTP server with the same contract as the enterprise
 * contract stub.
 *
 * Refs plur-ai/plur#1638
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { spawn } from 'child_process'
import yaml from 'js-yaml'
import '../src/commands/login.js'
import { detectSensitive } from '@plur-ai/core'
import { deviceName, isHeadless, isVsCodeRemote } from '../src/enterprise/device-name.js'
import { helloStatement } from '../src/enterprise/hello.js'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const KEY = 'plur_sk_test_0123456789abcdef'

// ── device-name.ts ──────────────────────────────────────────────────────────

describe('device name and headless detection', () => {
  it('names the device after the host and platform, at most 80 characters', () => {
    expect(deviceName('ws-0142', 'win32', false)).toBe('ws-0142 (Windows)')
    expect(deviceName('ws-0142', 'darwin', false)).toBe('ws-0142 (macOS)')
    expect(deviceName('ws-0142', 'linux', false)).toBe('ws-0142 (Linux)')
    expect(deviceName('x'.repeat(100), 'linux', true)).toMatch(/^x+ \(Linux \(WSL\)\)$/)
    expect(deviceName('x'.repeat(100), 'linux', true).length).toBe(80)
  })

  it('uses only the first label of a dotted host name, so the install hello passes the privacy check (#1732)', () => {
    expect(deviceName('Mac-1760915000123.local', 'darwin', false)).toBe('Mac-1760915000123 (macOS)')
    expect(deviceName('Mac-1760915000123.local.', 'darwin', false)).toBe('Mac-1760915000123 (macOS)')
    expect(deviceName('ws-0142.corp.example.com', 'linux', false)).toBe('ws-0142 (Linux)')
    expect(deviceName('build-staging.lan', 'linux', true)).toBe('build-staging (Linux (WSL))')
    expect(deviceName('10.0.0.12', 'linux', false)).toBe('10.0.0.12 (Linux)')
    expect(deviceName('.local', 'darwin', false)).toBe('unknown host (macOS)')
    for (const host of ['Mac-1760915000123.local', 'box.lan', 'ws.internal', 'db.corp', 'pc.intranet', 'api.svc.cluster.local', 'hub-staging.example.com']) {
      const statement = helloStatement({ username: 'smoke', deviceName: deviceName(host, 'darwin', false), tools: ['Codex'], version: '0.0.0', date: '2026-10-20' })
      expect(detectSensitive(statement), `${host}: ${statement}`).toEqual([])
    }
  })

  it('the name always passes the server\'s device_name rule: no control, format or separator characters, no half of a surrogate pair', () => {
    // The server refuses a device_name with any \\p{Cc}, \\p{Cf}, \\p{Cs}, \\p{Zl} or \\p{Zp}
    // character, or longer than 80 UTF-16 units (enterprise: deviceNameOf).
    const serverRefuses = (v: string) => v.length > 80 || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(v)
    expect(deviceName('ws\u200e-01\u202e42\u0085\u2028', 'win32', false)).toBe('ws-0142 (Windows)')
    for (const host of ['x'.repeat(69) + '\u{1F600}'.repeat(5), '\u{1F600}'.repeat(60), 'a\uD800b', '\u200b\u2029']) {
      for (const wsl of [false, true]) {
        const name = deviceName(host, 'linux', wsl)
        expect(serverRefuses(name), JSON.stringify(name)).toBe(false)
        expect(name).toMatch(wsl ? / \(Linux \(WSL\)\)$/ : / \(Linux\)$/)
      }
    }
  })

  it('is headless over SSH, and on Linux without a display', () => {
    expect(isHeadless({ SSH_CONNECTION: '1 2 3 4' }, 'darwin')).toBe(true)
    expect(isHeadless({}, 'linux')).toBe(true)
    expect(isHeadless({ DISPLAY: ':0' }, 'linux')).toBe(false)
    expect(isHeadless({}, 'darwin')).toBe(false)
  })

  it('a VS Code Remote-SSH terminal is headless and recognised', () => {
    const env = { SSH_CONNECTION: '1 2 3 4', VSCODE_IPC_HOOK_CLI: '/tmp/vscode-ipc.sock' }
    expect(isHeadless(env, 'linux')).toBe(true)
    expect(isVsCodeRemote(env)).toBe(true)
    expect(isVsCodeRemote({ SSH_CONNECTION: '1 2 3 4' })).toBe(false)
  })
})

// ── deviceSignIn with a scripted fetch ──────────────────────────────────────

type Answer = { status: number; body?: unknown; headers?: Record<string, string> }

function scriptedFetch(script: Record<string, Answer[]>) {
  const calls: Array<{ path: string; body: unknown }> = []
  const f = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const queue = script[path]
    const a = queue && queue.length > 1 ? queue.shift()! : queue?.[0]
    if (!a) throw new Error(`no scripted answer for ${path}`)
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), {
      status: a.status, headers: { 'content-type': 'application/json', ...(a.headers ?? {}) },
    })
  }) as unknown as typeof fetch
  return { f, calls }
}

const DEVICE = { device_code: 'dc-1', user_code: 'WDJB-MJHT', verification_uri: 'https://plur.example.com/me/device', interval: 5, expires_in: 600 }
const GRANT = { access_token: KEY, token_type: 'Bearer', username: 'alice', key_id: 'k1', key_name: 'alice — ws-0142 (Windows)' }
const pending = { status: 400, body: { error: 'authorization_pending' } }
const slow = { status: 400, body: { error: 'slow_down' } }
const ok = { status: 200, body: GRANT }

function harness(script: Record<string, Answer[]>, extra: Record<string, unknown> = {}) {
  const { f, calls } = scriptedFetch(script)
  const sleeps: number[] = []
  const printed: string[] = []
  const opened: string[] = []
  const opts = {
    server: 'https://plur.example.com',
    deviceName: 'ws-0142 (Windows)',
    fetch: f,
    sleep: async (ms: number) => { sleeps.push(ms) },
    print: (line: string) => { printed.push(line) },
    openBrowser: async (url: string) => { opened.push(url); return true },
    headless: false,
    rerunHint: 'Run the installer again.',
    ...extra,
  }
  return { opts, calls, sleeps, printed, opened }
}

async function signIn(h: ReturnType<typeof harness>) {
  const { deviceSignIn } = await import('../src/commands/login.js')
  return deviceSignIn(h.opts)
}

describe('deviceSignIn', () => {
  it('happy path: pending, slow_down, then the key; C3 bodies; interval and slow_down honoured; key never printed', async () => {
    const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [pending, slow, ok] })
    const r = await signIn(h)
    expect(r).toEqual({ key: KEY, keyId: 'k1', keyName: 'alice — ws-0142 (Windows)', username: 'alice' })
    expect(h.calls[0]).toEqual({ path: '/api/v1/auth/device', body: { client_id: 'plur-cli', device_name: 'ws-0142 (Windows)' } })
    for (const c of h.calls.slice(1)) {
      expect(c).toEqual({ path: '/api/v1/auth/token', body: { grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'dc-1', client_id: 'plur-cli' } })
    }
    expect(h.sleeps).toEqual([5000, 5000, 10000])
    expect(h.printed).toContain('Go to  https://plur.example.com/me/device  and enter the code  WDJB-MJHT')
    expect(h.opened).toEqual(['https://plur.example.com/me/device'])
    expect(h.printed.join('\n')).not.toContain(KEY)
  })

  it('does not open a browser when headless; the code line is still printed', async () => {
    const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [ok] }, { headless: true })
    await signIn(h)
    expect(h.opened).toEqual([])
    expect(h.printed).toContain('Go to  https://plur.example.com/me/device  and enter the code  WDJB-MJHT')
  })

  it('a token_type other than Bearer is refused', async () => {
    const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 200, body: { ...GRANT, token_type: 'mac' } }] })
    await expect(signIn(h)).rejects.toThrow('unexpected answer from the server')
  })

  it('a username or key name with control characters is refused (they are printed to the terminal)', async () => {
    for (const bad of [{ username: 'alice\u001b[2J' }, { key_name: 'alice \u001b]8;;https://evil.example.net\u0007x' }, { key_id: 'k\r1' }]) {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 200, body: { ...GRANT, ...bad } }] })
      await expect(signIn(h)).rejects.toThrow('unexpected answer from the server')
    }
  })

  it('a key that is not a PLUR device key is refused, and the message does not carry it', async () => {
    const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 200, body: { ...GRANT, access_token: 'short-sekrit' } }] })
    const err = await signIn(h).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/unexpected answer from the server/)
    expect(err?.message).not.toMatch(/sekrit/)
  })

  it.each([
    ['access_denied', 'Sign-in was cancelled in the browser. Nothing was changed.'],
    ['expired_token', 'The code expired before it was entered. Run the installer again.'],
    ['invalid_grant', 'The server no longer knows this sign-in request (already used or unknown). Run the installer again.'],
  ])('%s → a plain message', async (error, message) => {
    const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 400, body: { error } }] })
    await expect(signIn(h)).rejects.toThrow(message)
  })

  it('plur login passes its own rerun hint', async () => {
    const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 400, body: { error: 'expired_token' } }] },
      { rerunHint: 'Run `plur login` again.' })
    await expect(signIn(h)).rejects.toThrow('The code expired before it was entered. Run `plur login` again.')
  })

  it('stops when the code expires (expires_in) without an answer', async () => {
    const h = harness({ '/api/v1/auth/device': [{ status: 200, body: { ...DEVICE, expires_in: 12 } }], '/api/v1/auth/token': [pending] })
    await expect(signIn(h)).rejects.toThrow(/expired before it was entered/)
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(12_000)
    expect(h.sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(20_000)
  })

  it('a verification_uri that is not on the server\'s own origin is refused before anything is printed', async () => {
    for (const uri of ['https://evil.example.net/me/device', 'http://plur.example.com/me/device', 'javascript:alert(1)']) {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: { ...DEVICE, verification_uri: uri } }], '/api/v1/auth/token': [ok] })
      await expect(signIn(h)).rejects.toThrow(/unexpected answer from the server/)
      expect(h.printed).toEqual([])
      expect(h.opened).toEqual([])
    }
  })

  it('a user_code outside the C3 alphabet is refused', async () => {
    const h = harness({ '/api/v1/auth/device': [{ status: 200, body: { ...DEVICE, user_code: 'PLUR-1234' } }], '/api/v1/auth/token': [ok] })
    await expect(signIn(h)).rejects.toThrow('unexpected answer from the server')
    expect(h.printed).toEqual([])
  })

  describe('rate limits', () => {
    it('slow_down twice: each adds 5 s and the added time is kept', async () => {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [slow, slow, ok] })
      await signIn(h)
      expect(h.sleeps).toEqual([5000, 10000, 15000])
    })

    it('/auth/token 429 with Retry-After: waits that long and polls the same code; no new device request', async () => {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 429, body: {}, headers: { 'retry-after': '30' } }, ok] })
      await signIn(h)
      expect(h.sleeps).toEqual([5000, 30000])
      expect(h.calls.filter(c => c.path === '/api/v1/auth/device')).toHaveLength(1)
      expect(h.calls.filter(c => c.path === '/api/v1/auth/token').every(c => (c.body as { device_code: string }).device_code === 'dc-1')).toBe(true)
    })

    it('/auth/token 429 with a Retry-After shorter than the interval still waits the interval (no tight loop)', async () => {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 429, body: {}, headers: { 'retry-after': '0' } }, { status: 429, body: {}, headers: { 'retry-after': '1' } }, ok] })
      await signIn(h)
      expect(h.sleeps).toEqual([5000, 5000, 5000])
    })

    it('no wait runs past the code\'s expiry and no key is taken after it', async () => {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: { ...DEVICE, expires_in: 12 } }], '/api/v1/auth/token': [{ status: 429, body: {}, headers: { 'retry-after': '120' } }, ok] })
      await expect(signIn(h)).rejects.toThrow(/expired before it was entered/)
      expect(h.sleeps).toEqual([5000, 7000])
      expect(h.calls.filter(c => c.path === '/api/v1/auth/token')).toHaveLength(1)
      // --timeout shorter than the interval: no poll at all, so no key.
      const h2 = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [ok] }, { timeoutSecs: 1 })
      await expect(signIn(h2)).rejects.toThrow(/expired before it was entered/)
      expect(h2.sleeps).toEqual([1000])
      expect(h2.calls.filter(c => c.path === '/api/v1/auth/token')).toHaveLength(0)
    })

    it('the time spent opening the browser counts against the code\'s expiry', async () => {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: { ...DEVICE, expires_in: 2, interval: 1 } }], '/api/v1/auth/token': [ok] },
        { openBrowser: async () => { await new Promise(r => setTimeout(r, 1100)); return true } })
      await expect(signIn(h)).rejects.toThrow(/expired before it was entered/)
      expect(h.calls.filter(c => c.path === '/api/v1/auth/token')).toHaveLength(0)
    })

    it('a poll still in flight at the deadline does not hand over a key', async () => {
      const slowOk = (async (u: string, init?: RequestInit) => {
        if (new URL(u).pathname === '/api/v1/auth/device') return new Response(JSON.stringify(DEVICE), { status: 200 })
        // The key arrives 1.5 s after the poll is sent — past the deadline.
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 1500)
          init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')) })
        })
        return new Response(JSON.stringify(GRANT), { status: 200 })
      }) as unknown as typeof fetch
      const h = harness({}, { fetch: slowOk, timeoutSecs: 6 })
      await expect(signIn(h)).rejects.toThrow(/expired before it was entered/)
    })

    it('an unknown token error is not echoed (it could carry anything, a key included)', async () => {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 400, body: { error: 'plur_sk_' + 'a'.repeat(43) } }] })
      const err = await signIn(h).then(() => null, (e: Error) => e)
      expect(err?.message).toMatch(/unexpected answer from the server/)
      expect(err?.message).not.toContain('plur_sk_')
    })

    it('a body that never finishes is cut off by the request timeout', async () => {
      const { requestDeviceCode } = await import('../src/commands/login.js')
      const f = (async (_u: string, init?: RequestInit) => {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode('{"device_code":'))
            init?.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')))
          },
        })
        return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch
      const started = Date.now()
      await expect(requestDeviceCode('https://plur.example.com', { fetch: f, requestTimeoutMs: 200 })).rejects.toThrow(/Unexpected response/)
      expect(Date.now() - started).toBeLessThan(5000)
    })

    it('/auth/token 429 without Retry-After is treated like slow_down', async () => {
      const h = harness({ '/api/v1/auth/device': [{ status: 200, body: DEVICE }], '/api/v1/auth/token': [{ status: 429, body: {} }, ok] })
      await signIn(h)
      expect(h.sleeps).toEqual([5000, 10000])
    })

    it('/auth/device 429: one retry after Retry-After, then a plain message', async () => {
      const busy = { status: 429, body: {}, headers: { 'retry-after': '20' } }
      const h1 = harness({ '/api/v1/auth/device': [busy, { status: 200, body: DEVICE }], '/api/v1/auth/token': [ok] })
      await signIn(h1)
      expect(h1.sleeps[0]).toBe(20000)
      const h2 = harness({ '/api/v1/auth/device': [busy, busy], '/api/v1/auth/token': [ok] })
      const err = await signIn(h2).then(() => null, (e: Error) => e)
      expect(err?.message).toBe('The PLUR server is busy with sign-ins from your network. Wait a minute, then run the installer again.')
      expect(err?.message).not.toMatch(/429|at /)
    })
  })
})

// ── plur login <host> against an in-test contract server ───────────────────

interface Stub {
  url: string
  server: Server
  tokenPolls: number
  /** 'grant' answers pending once, then the key; 'pending' never grants. */
  mode: 'grant' | 'pending'
  minted: string[]
  legacyToken: string
  /** Repeat the key in the user name and key name (a misbehaving server). */
  reflect?: boolean
  /** Repeat the key as a malformed scope_metadata entry in /me. */
  reflectMeta?: boolean
}

async function startStub(): Promise<Stub> {
  const stub = { tokenPolls: 0, mode: 'grant', minted: [] as string[], legacyToken: 'plur_sk_legacy_0123456789abcdef' } as Stub
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const codes = new Map<string, number>()
  stub.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { /* {} */ }
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'POST' && path === '/api/v1/auth/device') {
        if (body.client_id !== 'plur-cli' || typeof body.device_name !== 'string' || body.device_name.length > 80) return json(res, 400, { error: 'invalid_request' })
        const dc = `dc-${codes.size + 1}`
        codes.set(dc, 0)
        return json(res, 200, { device_code: dc, user_code: 'WDJB-MJHT', verification_uri: `${stub.url}/me/device`, interval: 1, expires_in: 600 })
      }
      if (req.method === 'POST' && path === '/api/v1/auth/token') {
        stub.tokenPolls++
        const dc = String(body.device_code)
        if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code' || !codes.has(dc)) return json(res, 400, { error: 'invalid_grant' })
        const n = codes.get(dc)! + 1
        codes.set(dc, n)
        if (stub.mode === 'pending' || n === 1) return json(res, 400, { error: 'authorization_pending' })
        codes.delete(dc)
        const key = `${KEY}${stub.minted.length}`
        stub.minted.push(key)
        return json(res, 200, { access_token: key, token_type: 'Bearer', username: stub.reflect ? `alice-${key}` : 'alice', key_id: `k${stub.minted.length}`, key_name: stub.reflect ? `alice ${key}` : 'alice — test device' })
      }
      if (req.method === 'GET' && path === '/api/v1/me') {
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        if (!stub.minted.includes(bearer) && bearer !== stub.legacyToken) { res.writeHead(401).end(); return }
        return json(res, 200, { username: 'alice', org_id: 'acme', role: 'developer', scopes: ['user:acme:alice', 'group:acme/team', ...(stub.reflectMeta ? [`group:acme/${bearer}`] : [])], scopes_status: 'ok', scope_metadata: stub.reflectMeta ? [{ scope: bearer }, { scope: `group:acme/${bearer}` }, { scope: 'group:acme/team', sensitivity: { forbid: [bearer] } }] : [], scope_metadata_status: 'ok', gitlab_host: null, project_paths: {} })
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  stub.url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

function runCli(args: string[], home: string, opts: { onSpawn?: (child: ReturnType<typeof spawn>) => void; timeoutMs?: number } = {}) {
  return new Promise<{ out: string; status: number | null; signal: NodeJS.Signals | null }>(resolve => {
    const child = spawn('node', [CLI, ...args], { cwd: home, env: { ...isolatedHomeEnv(home), DISPLAY: '', WAYLAND_DISPLAY: '' } })
    let out = ''
    const on = (c: Buffer) => { out += c.toString() }
    opts.onSpawn?.(child)
    child.stdout.on('data', on)
    child.stderr.on('data', on)
    const t = setTimeout(() => { child.kill('SIGKILL') }, opts.timeoutMs ?? 30_000)
    child.on('close', (status, signal) => { clearTimeout(t); resolve({ out, status, signal }) })
  })
}

describe('plur login <host> (process, contract server)', () => {
  let stub: Stub
  let home: string
  const cfg = () => join(home, '.plur', 'config.yaml')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stores = (): any[] => (yaml.load(readFileSync(cfg(), 'utf8')) as { stores?: unknown[] })?.stores as any[] ?? []

  beforeEach(async () => {
    stub = await startStub()
    home = mkdtempSync(join(tmpdir(), 'plur-device-login-'))
    mkdirSync(join(home, '.plur'), { recursive: true })
  })
  afterEach(async () => {
    await new Promise<void>(resolve => stub.server.close(() => resolve()))
    rmSync(home, { recursive: true, force: true })
  })

  it('signs in, writes one server entry with the key and the personal scope from /me, never config.json, never prints the key', async () => {
    const r = await runCli(['login', stub.url, '--no-open'], home)
    expect(r.status, r.out).toBe(0)
    expect(stub.minted).toHaveLength(1)
    const s = stores()
    expect(s).toHaveLength(1)
    expect(s[0]).toMatchObject({ url: stub.url, token: stub.minted[0], scope: 'user:acme:alice' })
    expect(s[0].scopes).toEqual(expect.arrayContaining(['user:acme:alice', 'group:acme/team']))
    expect(existsSync(join(home, '.plur', 'config.json'))).toBe(false)
    expect(r.out).not.toContain(stub.minted[0])
    expect(r.out).toContain('WDJB-MJHT')
    expect(r.out).toMatch(/alice/)
  }, 40_000)

  it('ctrl-C while waiting for approval: exit 130, config.yaml byte-identical, no config.json', async () => {
    stub.mode = 'pending'
    writeFileSync(cfg(), 'stores: []\n')
    const before = readFileSync(cfg(), 'utf8')
    let sent = false
    const r = await runCli(['login', stub.url, '--no-open'], home, {
      // Interrupt once the CLI is polling for the key.
      onSpawn: child => {
        const t = setInterval(() => {
          if (stub.tokenPolls >= 1) { sent = true; clearInterval(t); child.kill('SIGINT') }
        }, 50)
        child.on('close', () => clearInterval(t))
      },
    })
    expect(sent, r.out).toBe(true)
    expect(r.status, r.out).toBe(130)
    expect(r.out).toMatch(/cancelled\. Nothing was changed/i)
    expect(readFileSync(cfg(), 'utf8')).toBe(before)
    expect(existsSync(join(home, '.plur', 'config.json'))).toBe(false)
  }, 40_000)

  it('a stale entry holding the personal scope: named, the cleanup command offered, nothing written; --remove-stale removes it with a backup', async () => {
    const seed = `stores:\n  - url: ${stub.url}\n    token: plur_sk_old_0123456789abcdef\n    scope: user:acme:bob\n    scopes: []\n` +
      `  - url: https://b.example.com/sse\n    token: plur_sk_other_0123456789abcd\n    scope: user:acme:alice\n`
    writeFileSync(cfg(), seed)
    const r1 = await runCli(['login', stub.url, '--no-open'], home)
    expect(r1.status, r1.out).toBe(1)
    expect(r1.out).toContain('user:acme:alice')
    expect(r1.out).toContain('https://b.example.com')
    expect(r1.out).toContain(`plur login ${stub.url} --remove-stale`)
    expect(r1.out).toMatch(/Nothing was changed/)
    expect(readFileSync(cfg(), 'utf8')).toBe(seed)
    expect(r1.out).not.toContain(stub.minted[0])
    expect(r1.out).not.toContain('plur_sk_other')

    const r2 = await runCli(['login', stub.url, '--no-open', '--remove-stale'], home)
    expect(r2.status, r2.out).toBe(0)
    const s = stores()
    expect(s.map(e => e.url)).toEqual([stub.url])
    expect(s[0]).toMatchObject({ token: stub.minted[1], scope: 'user:acme:alice' })
    const backups = readdirSync(join(home, '.plur', 'backups'))
    expect(backups).toHaveLength(1)
    const backup = join(home, '.plur', 'backups', backups[0], 'config.yaml')
    expect(readFileSync(backup, 'utf8')).toBe(seed)
    expect(r2.out).toContain(backup)
    expect(r2.out).toContain('https://b.example.com')
    expect(r2.out).not.toContain(stub.minted[1])
  }, 60_000)

  it('a key the server repeats in the key name or user name is never printed', async () => {
    stub.reflect = true
    const r = await runCli(['login', stub.url, '--no-open'], home)
    expect(r.status, r.out).toBe(0)
    expect(stub.minted).toHaveLength(1)
    expect(r.out).not.toContain(stub.minted[0])
  }, 40_000)

  it('an older entry for the server that keeps the personal scope: saved, but the personal writes still go there — said, exit 1', async () => {
    writeFileSync(cfg(), `stores:\n  - url: ${stub.url}\n    token: plur_sk_old_0123456789abcdef\n    scope: user:acme:alice\n`)
    const r = await runCli(['login', stub.url, '--no-open'], home)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/still served by another entry for .* with another key/)
    expect(r.out).not.toContain(stub.minted[0])
    expect(r.out).not.toContain('plur_sk_old')
  }, 40_000)

  it('a local store that keeps the personal scope: said, exit 1', async () => {
    const local = join(home, 'local-store')
    mkdirSync(local)
    writeFileSync(cfg(), `stores:\n  - path: ${local}\n    scope: user:acme:alice\n`)
    const r = await runCli(['login', stub.url, '--no-open'], home)
    expect(r.status, r.out).toBe(1)
    expect(r.out).toMatch(/still served by a local store/)
  }, 40_000)

  it('a key the server reflects into /me scope metadata is not logged', async () => {
    stub.reflectMeta = true
    // Granted scope names and sensitivity values that carry the key too.
    const r = await runCli(['login', stub.url, '--no-open'], home)
    expect(stub.minted).toHaveLength(1)
    expect(r.out).not.toContain(stub.minted[0])
  }, 40_000)

  it('login and the config.json move build Plur without project-store discovery (no config write before the sign-in)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'commands', 'login.ts'), 'utf8')
    expect(src).not.toMatch(/createPlur\(flags\)(?!,)/)
    expect(src.match(/createPlur\(flags, \{ autoDiscover: false \}\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  it('a remaining ~/.plur/config.json is moved into config.yaml once, with a notice, then not read again', async () => {
    const legacy = JSON.stringify({ enterprise: { url: stub.url, token: stub.legacyToken, username: 'alice' } })
    writeFileSync(join(home, '.plur', 'config.json'), legacy)
    const r1 = await runCli(['login', '--status', '--json'], home)
    expect(r1.out).toMatch(/config\.json/)
    expect(r1.out).toMatch(/moved into .*config\.yaml/i)
    expect(r1.out).not.toContain(stub.legacyToken)
    expect(existsSync(join(home, '.plur', 'config.json'))).toBe(false)
    expect(stores()).toEqual([expect.objectContaining({ url: stub.url, token: stub.legacyToken, scope: 'user:acme:alice' })])
    const backups = readdirSync(join(home, '.plur', 'backups'))
    expect(readFileSync(join(home, '.plur', 'backups', backups[0], 'config.json'), 'utf8')).toBe(legacy)

    const r2 = await runCli(['login', '--status', '--json'], home)
    expect(r2.out).not.toMatch(/config\.json/)
    expect(r2.status, r2.out).toBe(0)
  }, 40_000)

  it('a config.json for a server config.yaml already signs in to: the newer key in config.yaml is kept, config.json is set aside unread by the server', async () => {
    const current = 'plur_sk_current_0123456789abcdef'
    const seed = `stores:\n  - url: ${stub.url}\n    token: ${current}\n    scope: user:acme:alice\n    scopes: []\n`
    writeFileSync(cfg(), seed)
    writeFileSync(join(home, '.plur', 'config.json'), JSON.stringify({ enterprise: { url: stub.url, token: stub.legacyToken } }))
    const r = await runCli(['login', '--status', '--json'], home)
    expect(r.out).toMatch(/already/)
    expect(r.out).not.toContain(stub.legacyToken)
    expect(r.out).not.toContain(current)
    expect(stores()).toEqual([expect.objectContaining({ url: stub.url, token: current })])
    expect(readFileSync(cfg(), 'utf8')).not.toContain(stub.legacyToken)
    expect(existsSync(join(home, '.plur', 'config.json'))).toBe(false)
  }, 40_000)

  it('a config.json for a server whose config.yaml entry holds no key is moved in (that entry is no sign-in)', async () => {
    writeFileSync(cfg(), `stores:\n  - url: ${stub.url}\n    scope: user:acme:alice\n    scopes: []\n`)
    writeFileSync(join(home, '.plur', 'config.json'), JSON.stringify({ enterprise: { url: stub.url, token: stub.legacyToken } }))
    const r = await runCli(['login', '--status', '--json'], home)
    expect(r.out).toMatch(/moved into .*config\.yaml/i)
    expect(stores()).toEqual([expect.objectContaining({ url: stub.url, token: stub.legacyToken })])
    expect(r.out).not.toContain(stub.legacyToken)
  }, 40_000)

  it('a config.json whose sign-in the server rejects is not moved into config.yaml; the old file is set aside', async () => {
    writeFileSync(join(home, '.plur', 'config.json'), JSON.stringify({ enterprise: { url: stub.url, token: 'plur_sk_revoked_0123456789abc' } }))
    const r = await runCli(['login', '--status', '--json'], home)
    expect(r.out).toMatch(/no longer accepted/)
    expect(r.out).toContain(`plur login ${stub.url}`)
    expect(r.out).not.toContain('plur_sk_revoked')
    expect(existsSync(join(home, '.plur', 'config.json'))).toBe(false)
    expect(existsSync(cfg()) ? stores() : []).toEqual([])
  }, 40_000)
})

// ── Backups that hold a key: owner-only through core's helper (#1631) ───────

describe('backups of config.yaml and config.json (Windows, icacls mocked)', () => {
  const ACCOUNT = 'ACME\\alice'
  const SID = 'S-1-5-21-1111-2222-3333-1001'
  type Call = string[]
  type Answer = { status: number | null; stdout: string }
  function fakeExec(answer: (args: string[]) => Answer) {
    const calls: Call[] = []
    const exec = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      return cmd === 'whoami' ? { status: 0, stdout: `"${ACCOUNT}","${SID}"\r\n` } : answer(args)
    }
    return { calls, exec }
  }
  const saved = (args: string[], trustees: string[]): Answer => {
    writeFileSync(args[2], Buffer.from(`x\r\nD:PAI${trustees.map(t => `(A;OICI;FA;;;${t})`).join('')}\r\n`, 'utf16le'))
    return { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files\n' }
  }
  const ownerOnly = (args: string[]) => args[1] === '/save'
    ? saved(args, [SID])
    : { status: 0, stdout: 'Successfully processed 1 files; Failed processing 0 files\n' }
  const grants = (calls: Call[]) => calls.filter(c => c[0] === 'icacls' && c[2] === '/inheritance:r').map(c => [c[1], c[4]])
  let root: string
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'plur-login-backup-')); mkdirSync(join(root, '.plur')) })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('the config.yaml backup of --remove-stale: folder and file get an owner-only access list, verified', async () => {
    const { backupSecretFile } = await import('../src/enterprise/sign-in-shared.js')
    const src = join(root, '.plur', 'config.yaml')
    writeFileSync(src, 'stores: []  # plur_sk_secret_0123456789abcdef\n')
    const { calls, exec } = fakeExec(ownerOnly)
    const dest = backupSecretFile(join(root, '.plur'), src, { platform: 'win32', exec, account: ACCOUNT })
    expect(dest.startsWith(join(root, '.plur', 'backups'))).toBe(true)
    expect(readFileSync(dest, 'utf8')).toBe(readFileSync(src, 'utf8'))
    const dir = join(dest, '..')
    expect(grants(calls)).toEqual([[dir, `*${SID}:(OI)(CI)F`], [dest, `*${SID}:F`]])
  })

  it('a backup that cannot be made owner-only is refused, and no copy of the key is left', async () => {
    const { backupSecretFile } = await import('../src/enterprise/sign-in-shared.js')
    const src = join(root, '.plur', 'config.yaml')
    writeFileSync(src, 'stores: []  # plur_sk_secret_0123456789abcdef\n')
    const { exec } = fakeExec(args => (args[1] === '/inheritance:r' && args[3] === `*${SID}:F`) ? { status: 5, stdout: '' } : ownerOnly(args))
    expect(() => backupSecretFile(join(root, '.plur'), src, { platform: 'win32', exec, account: ACCOUNT })).toThrow(/could not be made private/)
    const stamp = readdirSync(join(root, '.plur', 'backups'))
    expect(stamp.flatMap(d => readdirSync(join(root, '.plur', 'backups', d)))).toEqual([])
  })

  it('config.json is set aside through the same helper; when that fails it stays where it is, with a notice', async () => {
    const { migrateLegacyLogin } = await import('../src/enterprise/legacy-login.js')
    const file = join(root, '.plur', 'config.json')
    const noPlur = () => { throw new Error('not reached') }
    // Holds no sign-in: set aside, owner-only.
    writeFileSync(file, '{}')
    const ok = fakeExec(ownerOnly)
    const printed: string[] = []
    expect(await migrateLegacyLogin({ home: root, plur: noPlur, print: l => printed.push(l), backupHost: { platform: 'win32', exec: ok.exec, account: ACCOUNT } })).toBe('set-aside')
    expect(existsSync(file)).toBe(false)
    expect(grants(ok.calls).map(g => g[1])).toEqual([`*${SID}:(OI)(CI)F`, `*${SID}:F`])
    // Protection fails: the file is kept, nothing half-moved.
    writeFileSync(file, '{}')
    const bad = fakeExec(() => ({ status: 5, stdout: '' }))
    const printed2: string[] = []
    expect(await migrateLegacyLogin({ home: root, plur: noPlur, print: l => printed2.push(l), backupHost: { platform: 'win32', exec: bad.exec, account: ACCOUNT } })).toBe('kept')
    expect(readFileSync(file, 'utf8')).toBe('{}')
    expect(printed2.join('\n')).toMatch(/could not be set aside/)
  })
})

describe('the config.json move against a concurrent sign-in', () => {
  it('a sign-in written to config.yaml while /me answers is kept; config.json is set aside', async () => {
    const { migrateLegacyLogin } = await import('../src/enterprise/legacy-login.js')
    const { Plur } = await import('@plur-ai/core')
    const root = mkdtempSync(join(tmpdir(), 'plur-login-race-'))
    try {
      const plurDir = join(root, '.plur')
      mkdirSync(plurDir)
      writeFileSync(join(plurDir, 'config.json'), JSON.stringify({ enterprise: { url: 'https://plur.example.com', token: 'plur_sk_legacy_0123456789abcdef' } }))
      const current = `stores:\n  - url: https://plur.example.com\n    token: plur_sk_current_0123456789abcdef\n    scope: user:acme:alice\n    scopes: []\n`
      const f = (async () => {
        writeFileSync(join(plurDir, 'config.yaml'), current)   // another process signs in meanwhile
        return new Response(JSON.stringify({ username: 'alice', org_id: 'acme', scopes: ['user:acme:alice'] }), { status: 200, headers: { 'content-type': 'application/json' } })
      }) as unknown as typeof fetch
      const printed: string[] = []
      const out = await migrateLegacyLogin({ home: root, plur: () => new Plur({ path: plurDir }), print: l => printed.push(l), fetch: f })
      expect(out).toBe('set-aside')
      expect(readFileSync(join(plurDir, 'config.yaml'), 'utf8')).toBe(current)
      expect(existsSync(join(plurDir, 'config.json'))).toBe(false)
      expect(printed.join('\n')).toMatch(/already holds a sign-in/)
      expect(printed.join('\n')).not.toContain('plur_sk_')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('module structure', () => {
  it('legacy-login does not import commands/login (no import cycle)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'enterprise', 'legacy-login.ts'), 'utf8')
    expect(src).not.toMatch(/from '\.\.\/commands\/login\.js'/)
  })
})
