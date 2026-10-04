/**
 * Plur.addRemoteStore — verified registration of a url store (#1265).
 *
 * An enterprise deployment reported that its installer could not register a
 * url store from a script: `addStore` never checks the token, so the only
 * safe path was the MCP tool. addRemoteStore asks the server first
 * (GET /api/v1/me) and writes config.yaml only when the token is accepted AND
 * the requested scope is one the token is authorised for.
 *
 * Real HTTP against the in-process StubServer.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import yaml from 'js-yaml'
import { Plur, redactToken } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'add-remote-valid-token-9f3a'
const SCOPE = 'group:example/eng'
let server: StubServer
let baseUrl: string

beforeAll(async () => {
  server = new StubServer(TOKEN)
  baseUrl = (await server.start()).url
})
afterAll(async () => { await server.stop() })

let dir: string
beforeEach(() => {
  server.reset()
  server.setMe({ username: 'installer', org_id: 'example', role: 'developer', scopes: [SCOPE, 'group:example/ops'] })
  dir = mkdtempSync(join(tmpdir(), 'plur-add-remote-'))
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false }))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const configText = () => readFileSync(join(dir, 'config.yaml'), 'utf8')
const remoteEntries = () =>
  ((yaml.load(configText()) as { stores?: Array<{ url?: string; token?: string; scope: string }> }).stores ?? [])
    .filter(s => s.url)

describe('Plur.addRemoteStore (#1265)', () => {
  it('verifies against /me, then writes the entry', async () => {
    const plur = new Plur({ path: dir })
    const r = await plur.addRemoteStore({ url: baseUrl, token: TOKEN, scope: SCOPE })
    expect(r.status).toBe('added')
    expect(r.scope).toBe(SCOPE)
    expect(r.username).toBe('installer')
    expect(remoteEntries()).toEqual([expect.objectContaining({ url: baseUrl, token: TOKEN, scope: SCOPE })])
  })

  it('refuses a rejected token and writes nothing', async () => {
    const before = configText()
    const plur = new Plur({ path: dir })
    await expect(plur.addRemoteStore({ url: baseUrl, token: 'wrong-token-77', scope: SCOPE }))
      .rejects.toMatchObject({ code: 'auth_rejected' })
    expect(configText()).toBe(before)
  })

  it('refuses a scope the token is not authorised for, and writes nothing', async () => {
    const before = configText()
    const plur = new Plur({ path: dir })
    const err = await plur.addRemoteStore({ url: baseUrl, token: TOKEN, scope: 'group:example/finance' })
      .catch(e => e)
    expect(err).toMatchObject({ code: 'scope_not_authorised' })
    expect(err.authorised).toEqual([SCOPE, 'group:example/ops'])
    expect(configText()).toBe(before)
  })

  it('refuses an unreachable server, and writes nothing', async () => {
    const before = configText()
    const plur = new Plur({ path: dir })
    await expect(plur.addRemoteStore({ url: 'http://127.0.0.1:1', token: TOKEN, scope: SCOPE, timeoutMs: 2000 }))
      .rejects.toMatchObject({ code: 'unreachable' })
    expect(configText()).toBe(before)
  })

  it('refuses a malformed url before any network call', async () => {
    const plur = new Plur({ path: dir })
    await expect(plur.addRemoteStore({ url: 'not a url', token: TOKEN, scope: SCOPE }))
      .rejects.toMatchObject({ code: 'invalid_url' })
  })

  it('is idempotent: a second identical call reports already_registered and leaves config byte-identical', async () => {
    const plur = new Plur({ path: dir })
    await plur.addRemoteStore({ url: baseUrl, token: TOKEN, scope: SCOPE })
    const after1 = configText()
    const r2 = await new Plur({ path: dir }).addRemoteStore({ url: baseUrl, token: TOKEN, scope: SCOPE })
    expect(r2.status).toBe('already_registered')
    expect(configText()).toBe(after1)
  })

  it('same url+scope with a new token that verifies: token is rotated in place', async () => {
    // Register with an old token written by hand (the server no longer accepts it).
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false, stores: [{ url: baseUrl, token: 'old-rotated-token', scope: SCOPE, shared: true, readonly: false }],
    }))
    const r = await new Plur({ path: dir }).addRemoteStore({ url: baseUrl, token: TOKEN, scope: SCOPE })
    expect(r.status).toBe('token_rotated')
    expect(remoteEntries()).toEqual([expect.objectContaining({ token: TOKEN, scope: SCOPE })])
  })

  it('same url+scope with a new token that is rejected: the old entry is untouched', async () => {
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false, stores: [{ url: baseUrl, token: TOKEN, scope: SCOPE, shared: true, readonly: false }],
    }))
    const before = configText()
    await expect(new Plur({ path: dir }).addRemoteStore({ url: baseUrl, token: 'bad-new-token', scope: SCOPE }))
      .rejects.toMatchObject({ code: 'auth_rejected' })
    expect(configText()).toBe(before)
  })

  it('never puts the token in an error message', async () => {
    const secret = 'sk-secret-should-not-leak-1234'
    const plur = new Plur({ path: dir })
    const errs = await Promise.all([
      plur.addRemoteStore({ url: baseUrl, token: secret, scope: SCOPE }).catch(e => e),
      plur.addRemoteStore({ url: 'http://127.0.0.1:1', token: secret, scope: SCOPE, timeoutMs: 1000 }).catch(e => e),
    ])
    for (const e of errs) {
      expect(e).toBeInstanceOf(Error)
      expect(String(e.message)).not.toContain(secret)
      expect(JSON.stringify(e)).not.toContain(secret)
    }
    expect(existsSync(join(dir, 'config.yaml'))).toBe(true)
  })

  describe('scope already registered to a different store', () => {
    const seedConflict = () => writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false, stores: [{ path: join(dir, 'team.yaml'), scope: SCOPE, shared: false, readonly: false }],
    }))

    it('refuses without overwriteScope, naming the option, and writes nothing', async () => {
      seedConflict()
      const before = configText()
      const err = await new Plur({ path: dir }).addRemoteStore({ url: baseUrl, token: TOKEN, scope: SCOPE }).catch(e => e)
      expect(err).toMatchObject({ code: 'scope_conflict' })
      expect(err.message).toContain('overwriteScope')
      expect(err.message).not.toContain(TOKEN)
      expect(configText()).toBe(before)
    })

    it('with overwriteScope, reassigns the scope after /me verifies', async () => {
      seedConflict()
      const r = await new Plur({ path: dir }).addRemoteStore({ url: baseUrl, token: TOKEN, scope: SCOPE, overwriteScope: true })
      expect(r.status).toBe('overwritten')
      const stores = (yaml.load(configText()) as { stores: Array<{ url?: string; path?: string; scope: string }> }).stores
      expect(stores.filter(s => s.scope === SCOPE)).toEqual([expect.objectContaining({ url: baseUrl, token: TOKEN })])
    })

    it('with overwriteScope but a rejected token, the existing entry is untouched', async () => {
      seedConflict()
      const before = configText()
      await expect(new Plur({ path: dir }).addRemoteStore({ url: baseUrl, token: 'nope-token', scope: SCOPE, overwriteScope: true }))
        .rejects.toMatchObject({ code: 'auth_rejected' })
      expect(configText()).toBe(before)
    })
  })

  // Audit of #1272: a buggy or hostile server can hand the token back in an
  // encoded form, or inside the /me scope list or username.
  describe('token echoes from the server (audit)', () => {
    const ODD = 'plr_SECRET/+=va"lue'
    const forms = (t: string) => [
      t,
      encodeURIComponent(t),
      encodeURIComponent(t).replace(/%[0-9A-F]{2}/g, m => m.toLowerCase()),
      JSON.stringify(t).slice(1, -1),
      Buffer.from(t).toString('base64'),
      Buffer.from(t).toString('base64').replace(/=+$/, ''),
      Buffer.from(t).toString('base64url'),
    ]

    it('redactToken removes raw, percent-encoded, JSON-escaped and base64 forms', () => {
      const text = forms(ODD).map((f, i) => `form${i}=${f};`).join(' ')
      const out = redactToken(text, ODD)
      for (const f of forms(ODD)) expect(out).not.toContain(f)
      expect(out).toContain('form0=')
    })

    it('a 401 body echoing every encoding of the token is fully scrubbed from the error', async () => {
      let echo: Server | undefined
      try {
        echo = createServer((req, res) => {
          res.writeHead(401, { 'content-type': 'text/plain' })
          res.end(`invalid token ${forms(ODD).join(' | ')}`)
        })
        await new Promise<void>(r => echo!.listen(0, '127.0.0.1', () => r()))
        const url = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`
        const err = await new Plur({ path: dir }).addRemoteStore({ url, token: ODD, scope: SCOPE }).catch(e => e)
        expect(err).toMatchObject({ code: 'auth_rejected' })
        const dump = err.message + JSON.stringify(err)
        for (const f of forms(ODD)) expect(dump).not.toContain(f)
      } finally {
        await new Promise<void>(r => (echo ? echo.close(() => r()) : r()))
      }
    })

    it('a /me scope list or username carrying the token never reaches the error or the result', async () => {
      server.setMe({ username: `u-${TOKEN}`, scopes: [SCOPE, `group:${TOKEN}`, `group:${Buffer.from(TOKEN).toString('base64url')}`, 'group:example/ops'] })
      try {
        const err = await new Plur({ path: dir }).addRemoteStore({ url: baseUrl, token: TOKEN, scope: 'group:example/finance' }).catch(e => e)
        expect(err).toMatchObject({ code: 'scope_not_authorised' })
        expect(err.authorised).toEqual([SCOPE, 'group:example/ops'])
        expect(err.message + JSON.stringify(err)).not.toContain(TOKEN)
        expect(err.message).not.toContain(Buffer.from(TOKEN).toString('base64url'))

        const ok = await new Plur({ path: dir }).addRemoteStore({ url: baseUrl, token: TOKEN, scope: SCOPE })
        expect(ok.status).toBe('added')
        expect(JSON.stringify(ok)).not.toContain(TOKEN)
        expect(ok.authorised).toEqual([SCOPE, 'group:example/ops'])
      } finally {
        server.setMe({ username: 'installer' })
      }
    })
  })
})

describe('Plur.verifyRemoteStore (#1413)', () => {
  it('runs every check and writes nothing', async () => {
    const before = configText()
    const plur = new Plur({ path: dir })
    const r = await plur.verifyRemoteStore({ url: baseUrl, token: TOKEN, scope: SCOPE })
    expect(r).toEqual({ scope: SCOPE, username: 'installer', authorised: [SCOPE, 'group:example/ops'] })
    expect(configText()).toBe(before)
  })

  it('refuses what addRemoteStore refuses, with the same codes', async () => {
    const plur = new Plur({ path: dir })
    await expect(plur.verifyRemoteStore({ url: baseUrl, token: 'wrong-token-77', scope: SCOPE }))
      .rejects.toMatchObject({ code: 'auth_rejected' })
    await expect(plur.verifyRemoteStore({ url: baseUrl, token: TOKEN, scope: 'group:example/finance' }))
      .rejects.toMatchObject({ code: 'scope_not_authorised' })
  })
})
