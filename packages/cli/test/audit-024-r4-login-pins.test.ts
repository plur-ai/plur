/**
 * 0.24 review, round 4 (CLI side): `plur login <url>` registers a company
 * server, a store whose pinned engrams load into every session. Under
 * `pinning.agents: request` or `deny` it follows `plur stores add`: run by an
 * agent (no terminal) core refuses the write, and with PLUR_ACTOR=owner and
 * no terminal the typed confirmation refuses before the device sign-in
 * starts. Nothing is written when refused. Under `allow` it signs in as
 * before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { spawn } from 'child_process'
import yaml from 'js-yaml'
import { builtCliPath } from './helpers/built-cli.js'
import { isolatedHomeEnv } from './helpers/isolated-env.js'

const CLI = builtCliPath(join(__dirname, '..'))
const KEY = 'plur_sk_r4_login_0123456789abcdef'

let server: Server, url: string, home: string, deviceRequests: number

beforeEach(async () => {
  deviceRequests = 0
  const polls = new Map<string, number>()
  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}') } catch { /* {} */ }
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'POST' && path === '/api/v1/auth/device') {
        deviceRequests++
        const dc = `dc-${deviceRequests}`
        polls.set(dc, 0)
        return json(res, 200, { device_code: dc, user_code: 'WDJB-MJHT', verification_uri: `${url}/me/device`, interval: 1, expires_in: 600 })
      }
      if (req.method === 'POST' && path === '/api/v1/auth/token') {
        const dc = String(body.device_code)
        const n = (polls.get(dc) ?? 0) + 1
        polls.set(dc, n)
        if (n === 1) return json(res, 400, { error: 'authorization_pending' })
        return json(res, 200, { access_token: KEY, token_type: 'Bearer', username: 'alice', key_id: 'k1', key_name: 'alice — test device' })
      }
      if (req.method === 'GET' && path === '/api/v1/me') {
        if ((req.headers.authorization ?? '') !== `Bearer ${KEY}`) { res.writeHead(401).end(); return }
        return json(res, 200, { username: 'alice', org_id: 'acme', role: 'developer', scopes: ['user:acme:alice'], scopes_status: 'ok', scope_metadata: [], scope_metadata_status: 'ok', gitlab_host: null, project_paths: {} })
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  home = mkdtempSync(join(tmpdir(), 'plur-r4-login-'))
  mkdirSync(join(home, '.plur'), { recursive: true })
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
})

const cfg = () => join(home, '.plur', 'config.yaml')
const stores = () => ((yaml.load(readFileSync(cfg(), 'utf8')) as { stores?: unknown[] })?.stores ?? [])
const config = (agents: 'allow' | 'request' | 'deny') => writeFileSync(cfg(), `embeddings:\n  enabled: false\nindex: false\npinning:\n  agents: ${agents}\n`)

function login(env: NodeJS.ProcessEnv = {}) {
  return new Promise<{ out: string; status: number | null }>(resolve => {
    const child = spawn(process.execPath, [CLI, 'login', url, '--no-open'], {
      cwd: home, env: { ...isolatedHomeEnv(home), DISPLAY: '', WAYLAND_DISPLAY: '', PLUR_DISABLE_EMBEDDINGS: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', c => { out += c }); child.stderr.on('data', c => { out += c })
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000)
    child.on('close', status => { clearTimeout(t); resolve({ out, status }) })
  })
}

describe('round 4: plur login under pinning.agents', () => {
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: from an agent shell the server entry is not written`, async () => {
      config(agents)
      const before = readFileSync(cfg(), 'utf8')
      const r = await login()
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/reserved for the owner/)
      expect(r.out).not.toContain(KEY)
      expect(readFileSync(cfg(), 'utf8')).toBe(before)
    }, 40_000)

    it(`${agents}: PLUR_ACTOR=owner without a terminal is refused before the sign-in starts`, async () => {
      config(agents)
      const before = readFileSync(cfg(), 'utf8')
      const r = await login({ PLUR_ACTOR: 'owner' })
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/pinning\.agents is "(request|deny)".*interactive terminal/)
      expect(deviceRequests).toBe(0)
      expect(readFileSync(cfg(), 'utf8')).toBe(before)
    }, 40_000)
  }

  // 0.24 review round 6: a second server for a personal scope another,
  // owner-registered server already serves is still a new server address.
  for (const agents of ['request', 'deny'] as const) {
    it(`${agents}: from an agent shell, signing in to a new server for an already-served personal scope writes nothing`, async () => {
      writeFileSync(cfg(), yaml.dump({
        embeddings: { enabled: false }, index: false, pinning: { agents },
        stores: [{ url: 'https://a.example.test', token: 'owner-key', scope: 'user:acme:alice', scopes: ['user:acme:alice'], enterprise: {} }],
      }, { lineWidth: 120, noRefs: true }))
      const before = readFileSync(cfg(), 'utf8')
      const r = await login()
      expect(r.status, r.out).toBe(1)
      expect(r.out).toMatch(/reserved for the owner/)
      expect(r.out).not.toContain(KEY)
      expect(readFileSync(cfg(), 'utf8')).toBe(before)
    }, 40_000)
  }

  it('allow (default): plur login from a shell writes the server entry as before', async () => {
    config('allow')
    const r = await login()
    expect(r.status, r.out).toBe(0)
    expect(stores()).toHaveLength(1)
  }, 40_000)
})
