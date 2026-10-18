/**
 * The installer's store step (#1638, plan C Task 4): reuse a working key, one
 * server store with a backup, and a rollback that leaves config.yaml
 * byte-identical.
 *
 * - `checkExistingKey` finds the one server entry (C6: `scopes` and an
 *   `enterprise` block) for the server and asks `/me` with its key. 401/403 →
 *   `rejected` (sign in again); 503, a network error or a timeout → `unknown`,
 *   which stops the run: no new key is minted and nothing is written (review
 *   focus 1).
 * - `connectServerStore` backs config.yaml up (owner-only) BEFORE core's
 *   `registerEnterpriseServer` writes the key, then runs
 *   `refreshServerScopes({ url })`. A refusal writes nothing; a failure after
 *   the write is rolled back to the backup's exact bytes.
 * - Owner decision on B5: registration that would take over another entry's
 *   personal-scope writes is refused, and the installer offers the cleanup
 *   (`plur login <server> --remove-stale`, the command #1638 added).
 * - The key is never printed, logged or put in an error.
 *
 * Refs plur-ai/plur#1638
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import yaml from 'js-yaml'
import { Plur, PersonalScopeTakenError } from '@plur-ai/core'
import { checkExistingKey, connectServerStore, rollbackServerStore, storeRefusalLines } from '../src/enterprise/server-store.js'

const KEY = 'plur_sk_test_0123456789abcdef'
const NEW_KEY = 'plur_sk_new_fedcba9876543210'
const isWin = process.platform === 'win32'
const modeOf = (p: string) => statSync(p).mode & 0o777

// ── checkExistingKey (scripted fetch) ───────────────────────────────────────

type Answer = { status: number; body?: unknown } | { throws: Error }

function scriptedFetch(answer: Answer) {
  const calls: Array<{ url: string; auth: string | undefined }> = []
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), auth: (init?.headers as Record<string, string> | undefined)?.authorization })
    if ('throws' in answer) throw answer.throws
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status, headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { f, calls }
}

const ME = { username: 'alice', org_id: 'acme', role: 'developer', scopes: ['user:acme:alice', 'group:acme/team'], scopes_status: 'ok' }
const serverEntry = (url: string, extra: Record<string, unknown> = {}) => ({
  url, token: KEY, scope: 'user:acme:alice', scopes: ['user:acme:alice'], shared: true, readonly: false, enterprise: { device_name: 'ws-0142 (Linux)' }, ...extra,
})

describe('checkExistingKey', () => {
  const server = 'https://plur.example.com'

  it('transient /me failure keeps the key and stops: a network error → unknown, naming the error code', async () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(`read ECONNRESET ${KEY}`), { code: 'ECONNRESET' }) })
    const { f } = scriptedFetch({ throws: err })
    const r = await checkExistingKey({ server, config: { stores: [serverEntry(server)] }, fetch: f })
    expect(r.state).toBe('unknown')
    expect((r as { reason: string }).reason).toMatch(/ECONNRESET/)
    expect(JSON.stringify(r)).not.toContain(KEY)
  })

  it('503 {"error":"scope_lookup_failed"} → unknown', async () => {
    const { f } = scriptedFetch({ status: 503, body: { error: 'scope_lookup_failed' } })
    const r = await checkExistingKey({ server, config: { stores: [serverEntry(server)] }, fetch: f })
    expect(r).toEqual({ state: 'unknown', reason: 'HTTP 503' })
  })

  it('401 and 403 → rejected; 200 → works with the key and the /me answer', async () => {
    for (const status of [401, 403]) {
      const { f } = scriptedFetch({ status })
      expect(await checkExistingKey({ server, config: { stores: [serverEntry(server)] }, fetch: f })).toEqual({ state: 'rejected' })
    }
    const { f, calls } = scriptedFetch({ status: 200, body: ME })
    const r = await checkExistingKey({ server, config: { stores: [serverEntry(server)] }, fetch: f })
    expect(r.state).toBe('works')
    if (r.state !== 'works') return
    expect(r.token).toBe(KEY)
    expect(r.me.username).toBe('alice')
    expect(r.me.orgId).toBe('acme')
    expect(calls).toEqual([{ url: 'https://plur.example.com/api/v1/me', auth: `Bearer ${KEY}` }])
  })

  it('the server entry for https://plur.example.com/ (trailing slash, enterprise block) is the one found; another url is ignored', async () => {
    const { f, calls } = scriptedFetch({ status: 200, body: ME })
    const other = serverEntry('https://plur.other.example.com', { token: 'plur_sk_other_0123456789abcdef' })
    const r = await checkExistingKey({ server, config: { stores: [other, serverEntry('https://plur.example.com/')] }, fetch: f })
    expect(r.state).toBe('works')
    expect(calls[0].auth).toBe(`Bearer ${KEY}`)

    const none = scriptedFetch({ status: 200, body: ME })
    expect(await checkExistingKey({ server, config: { stores: [other] }, fetch: none.f })).toEqual({ state: 'none' })
    expect(none.calls).toEqual([])
  })

  it('no config, no stores, or only a per-scope entry (no scopes list or enterprise block) → none, without a request', async () => {
    const { f, calls } = scriptedFetch({ status: 200, body: ME })
    expect(await checkExistingKey({ server, config: {}, fetch: f })).toEqual({ state: 'none' })
    expect(await checkExistingKey({ server, config: { stores: [] }, fetch: f })).toEqual({ state: 'none' })
    const perScope = { url: server, token: KEY, scope: 'group:acme/team', shared: true }
    expect(await checkExistingKey({ server, config: { stores: [perScope, 'junk', null] }, fetch: f })).toEqual({ state: 'none' })
    expect(calls).toEqual([])
  })

  it('a server entry with token_env: the key comes from that variable; unset → none', async () => {
    const entry = serverEntry(server, { token: undefined, token_env: 'PLUR_ACME_KEY' })
    const { f, calls } = scriptedFetch({ status: 200, body: ME })
    const r = await checkExistingKey({ server, config: { stores: [entry] }, fetch: f, env: { PLUR_ACME_KEY: KEY } })
    expect(r.state).toBe('works')
    expect(calls[0].auth).toBe(`Bearer ${KEY}`)
    expect(await checkExistingKey({ server, config: { stores: [entry] }, fetch: f, env: {} })).toEqual({ state: 'none' })
  })

  it('two server entries for the server → unknown (registration would refuse which key to replace)', async () => {
    const { f, calls } = scriptedFetch({ status: 200, body: ME })
    const r = await checkExistingKey({ server, config: { stores: [serverEntry(server), serverEntry(`${server}/`, { token: 'plur_sk_second_0123456789abcdef' })] }, fetch: f })
    expect(r.state).toBe('unknown')
    expect((r as { reason: string }).reason).toMatch(/more than one/)
    expect(calls).toEqual([])
  })
})

// ── connectServerStore / rollbackServerStore (real core, contract server) ─────

interface Stub { url: string; server: Server; keys: string[]; meCalls: number }

async function startStub(): Promise<Stub> {
  const stub = { keys: [KEY, NEW_KEY], meCalls: 0 } as Stub
  stub.server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume()
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      if (req.method === 'GET' && path === '/api/v1/me') {
        stub.meCalls++
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        if (!stub.keys.includes(bearer)) { res.writeHead(401).end(); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...ME, scope_metadata: [], scope_metadata_status: 'ok', gitlab_host: null, project_paths: {} }))
        return
      }
      res.writeHead(404).end()
    })
  })
  await new Promise<void>(resolve => stub.server.listen(0, '127.0.0.1', resolve))
  stub.url = `http://127.0.0.1:${(stub.server.address() as AddressInfo).port}`
  return stub
}

describe('connectServerStore', () => {
  let stub: Stub
  let root: string
  let cfg: string
  let printed: string[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stores = (): any[] => ((yaml.load(readFileSync(cfg, 'utf8')) as { stores?: unknown[] })?.stores ?? []) as any[]
  const plur = () => new Plur({ path: root })

  beforeEach(async () => {
    stub = await startStub()
    root = mkdtempSync(join(tmpdir(), 'plur-server-store-'))
    cfg = join(root, 'config.yaml')
    printed = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { printed.push(a.map(String).join(' ')) })
    }
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => { printed.push(String(c)); return true }) as typeof process.stderr.write)
  })
  afterEach(async () => {
    vi.restoreAllMocks()
    await new Promise<void>(resolve => stub.server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  it('backs config.yaml up first (byte-equal, owner-only), then registers the key, then refreshes the scopes', async () => {
    const before = 'stores: []\nindex: false\n'
    writeFileSync(cfg, before)
    const p = plur()
    const order: string[] = []
    const origReg = p.registerEnterpriseServer.bind(p)
    const origRef = p.refreshServerScopes.bind(p)
    const reg = vi.spyOn(p, 'registerEnterpriseServer').mockImplementation(async (...args) => {
      order.push(`register:${existsSync(join(root, 'backups')) ? 'after-backup' : 'before-backup'}`)
      return origReg(...args)
    })
    const ref = vi.spyOn(p, 'refreshServerScopes').mockImplementation(async (...args) => {
      order.push('refresh')
      return origRef(...args)
    })

    const r = await connectServerStore({ plur: p, server: stub.url, token: KEY, personalScope: 'user:acme:alice', configPath: cfg })

    expect(order).toEqual(['register:after-backup', 'refresh'])
    expect(reg).toHaveBeenCalledWith(stub.url, { token: KEY, personalScope: 'user:acme:alice' })
    expect(ref).toHaveBeenCalledWith({ url: stub.url })
    expect(r.status).toBe('added')
    expect(r.discovery.status).toBe('ok')
    expect(r.backupPath).not.toBeNull()
    expect(r.backupPath!.startsWith(join(root, 'backups'))).toBe(true)
    expect(readFileSync(r.backupPath!, 'utf8')).toBe(before)
    if (!isWin) {
      expect(modeOf(r.backupPath!)).toBe(0o600)
      expect(modeOf(dirname(r.backupPath!))).toBe(0o700)
      expect(modeOf(cfg)).toBe(0o600)
    }
    const s = stores()
    expect(s).toHaveLength(1)
    expect(s[0].url).toBe(stub.url)
    expect(s[0].token).toBe(KEY)
    expect(JSON.stringify(r)).not.toContain(KEY)
    expect(printed.join('\n')).not.toContain(KEY)
  })

  it('with a new key over an existing same-URL entry: updated, still one entry, enterprise.hello_engram_id kept', async () => {
    writeFileSync(cfg, yaml.dump({ stores: [{ ...serverEntry(stub.url), enterprise: { hello_engram_id: 'ENG-2026-10-01-001', device_name: 'ws-0142 (Linux)' } }] }))
    const r = await connectServerStore({ plur: plur(), server: stub.url, token: NEW_KEY, personalScope: 'user:acme:alice', configPath: cfg })
    expect(r.status).toBe('updated')
    const s = stores()
    expect(s).toHaveLength(1)
    expect(s[0].token).toBe(NEW_KEY)
    expect(s[0].enterprise.hello_engram_id).toBe('ENG-2026-10-01-001')
    expect(printed.join('\n')).not.toContain(NEW_KEY)
  })

  it('a fresh machine (no config.yaml): no backup to take, backupPath is null', async () => {
    const p = plur()
    const existed = existsSync(cfg)
    const r = await connectServerStore({ plur: p, server: stub.url, token: KEY, personalScope: 'user:acme:alice', configPath: cfg })
    expect(r.backupPath === null).toBe(!existed)
    expect(stores()).toHaveLength(1)
  })

  it('B5: a takeover of the personal scope is refused, nothing is written, and the cleanup is offered', async () => {
    // Another server serving the personal scope in another letter case: registering would move its writes.
    const holder = { url: 'https://plur.old.example.com', token: 'plur_sk_old_0123456789abcdef', scope: 'user:acme:Alice' }
    writeFileSync(cfg, yaml.dump({ stores: [holder] }))
    const before = readFileSync(cfg)
    const p = plur()
    const ref = vi.spyOn(p, 'refreshServerScopes')
    const err = await connectServerStore({ plur: p, server: stub.url, token: KEY, personalScope: 'user:acme:alice', configPath: cfg }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(PersonalScopeTakenError)
    expect(readFileSync(cfg).equals(before)).toBe(true)
    expect(ref).not.toHaveBeenCalled()
    expect(String((err as Error).message)).not.toContain(KEY)

    const lines = storeRefusalLines(err as PersonalScopeTakenError, stub.url, cfg, { reused: false })
    const text = lines.join('\n')
    expect(text).toContain('https://plur.old.example.com')
    expect(text).toContain(`plur login ${stub.url} --remove-stale`)
    expect(text).toMatch(/run the installer again/i)
    expect(text).toContain('the key from this sign-in was not saved')
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('plur_sk_old')
    // A reused key was already saved: the wording does not say it was lost.
    expect(storeRefusalLines(err as PersonalScopeTakenError, stub.url, cfg, { reused: true }).join('\n')).not.toContain('key from this sign-in')
  })

  it('a failure after the key was written is rolled back: config.yaml is byte-identical, and the error never carries the key', async () => {
    const before = Buffer.from('# hand-written\nstores: []\nindex: false\n')
    writeFileSync(cfg, before)
    const p = plur()
    vi.spyOn(p, 'refreshServerScopes').mockRejectedValue(new Error(`lock failed near ${KEY}`))
    const err = await connectServerStore({ plur: p, server: stub.url, token: KEY, personalScope: 'user:acme:alice', configPath: cfg }).then(() => null, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).not.toContain(KEY)
    expect(readFileSync(cfg).equals(before)).toBe(true)
    expect(printed.join('\n')).not.toContain(KEY)
  })

  it('a failure on a fresh machine removes the config.yaml the registration created', async () => {
    const p = plur()
    rmSync(cfg, { force: true })
    vi.spyOn(p, 'refreshServerScopes').mockRejectedValue(new Error('boom'))
    await expect(connectServerStore({ plur: p, server: stub.url, token: KEY, personalScope: 'user:acme:alice', configPath: cfg })).rejects.toThrow(/boom/)
    expect(existsSync(cfg)).toBe(false)
  })

  it('a backup that cannot be made refuses the whole step: no registration, config.yaml unchanged', async () => {
    const before = 'stores: []\n'
    writeFileSync(cfg, before)
    writeFileSync(join(root, 'backups'), 'not a folder')
    const p = plur()
    const reg = vi.spyOn(p, 'registerEnterpriseServer')
    await expect(connectServerStore({ plur: p, server: stub.url, token: KEY, personalScope: 'user:acme:alice', configPath: cfg })).rejects.toThrow(/backed up before saving the key.*Nothing was changed/)
    expect(reg).not.toHaveBeenCalled()
    expect(readFileSync(cfg, 'utf8')).toBe(before)
  })

  it.skipIf(isWin)('the key file stays 0600 through a later core rewrite', async () => {
    writeFileSync(cfg, 'stores: []\n')
    await connectServerStore({ plur: plur(), server: stub.url, token: KEY, personalScope: 'user:acme:alice', configPath: cfg })
    expect(modeOf(cfg)).toBe(0o600)
    await connectServerStore({ plur: plur(), server: stub.url, token: NEW_KEY, personalScope: 'user:acme:alice', configPath: cfg })
    expect(modeOf(cfg)).toBe(0o600)
  })
})

describe('rollbackServerStore', () => {
  let root: string
  let cfg: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'plur-server-rollback-'))
    cfg = join(root, 'config.yaml')
  })
  afterEach(() => { rmSync(root, { recursive: true, force: true }) })

  it('restores the exact bytes (owner-only), whatever was written since', () => {
    const before = Buffer.concat([Buffer.from('stores: []\n# '), Buffer.from([0xc3, 0xa9]), Buffer.from(' no trailing newline')])
    const backup = join(root, 'backups', 'x', 'config.yaml')
    mkdirSync(dirname(backup), { recursive: true })
    writeFileSync(backup, before)
    writeFileSync(cfg, `stores:\n  - url: https://plur.example.com\n    token: ${KEY}\n`)
    rollbackServerStore(backup, cfg)
    expect(readFileSync(cfg).equals(before)).toBe(true)
    if (!isWin) expect(modeOf(cfg)).toBe(0o600)
  })

  it('with no backup (there was no config.yaml), removes the file', () => {
    writeFileSync(cfg, `stores:\n  - url: https://plur.example.com\n    token: ${KEY}\n`)
    rollbackServerStore(null, cfg)
    expect(existsSync(cfg)).toBe(false)
    expect(() => rollbackServerStore(null, cfg)).not.toThrow()
  })
})
