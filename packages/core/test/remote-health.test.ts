/**
 * Remote auth/reachability health — closes part of plur-ai/plur#295.
 *
 * checkRemoteHealth() probes GET /api/v1/me per configured remote and decodes
 * the token's JWT expiry, so callers (plur_doctor, plur_session_start) can
 * distinguish 'auth_expired' (reauth) from 'unreachable' (network) instead of
 * the old silent failure. Runs against the in-process stub server (real HTTP).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'health-test-token'
let server: StubServer
let baseUrl: string
const dirs: string[] = []

beforeAll(async () => {
  server = new StubServer(TOKEN)
  const info = await server.start()
  baseUrl = info.url
})

afterAll(async () => {
  await server.stop()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  server.reset()
  server.setMe({ username: 'maintainer', org_id: 'plur', role: 'developer', scopes: ['group:plur/plur-ai/engineering'] })
})

const writeConfig = (stores: unknown[]): Plur => {
  const dir = mkdtempSync(join(tmpdir(), 'plur-health-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), yaml.dump({ stores, index: false }, { lineWidth: 120, noRefs: true }))
  return new Plur({ path: dir })
}

describe('Plur.checkRemoteHealth()', () => {
  it('reports ok for a reachable endpoint with a valid token', async () => {
    const plur = writeConfig([{ url: baseUrl, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }])
    const [h] = await plur.checkRemoteHealth()
    expect(h.status).toBe('ok')
    expect(h.ok).toBe(true)
    expect(h.url).toBe(baseUrl)
    expect(h.scopes).toContain('group:plur/plur-ai/engineering')
  })

  it('reports auth_expired on a 401 (rejected token)', async () => {
    const plur = writeConfig([{ url: baseUrl, token: 'wrong-token', scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }])
    const [h] = await plur.checkRemoteHealth()
    expect(h.status).toBe('auth_expired')
    expect(h.ok).toBe(false)
    expect(h.reason).toMatch(/401/)
  })

  it('short-circuits to auth_expired for an already-expired JWT (no probe needed)', async () => {
    const exp = Math.floor(Date.now() / 1000) - 86_400 // yesterday
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const expiredJwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'maintainer', exp })}.sig`
    const plur = writeConfig([{ url: baseUrl, token: expiredJwt, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }])
    const [h] = await plur.checkRemoteHealth()
    expect(h.status).toBe('auth_expired')
    expect(h.tokenExpiresInDays).toBeLessThan(0)
  })

  it('reports unreachable when the endpoint is down', async () => {
    const down = new StubServer(TOKEN)
    const info = await down.start()
    await down.stop() // started then stopped → port closed
    const plur = writeConfig([{ url: info.url, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }])
    const [h] = await plur.checkRemoteHealth({ timeoutMs: 1500 })
    expect(h.status).toBe('unreachable')
    expect(h.ok).toBe(false)
  })

  it('returns [] when no remote stores are configured', async () => {
    const plur = writeConfig([])
    expect(await plur.checkRemoteHealth()).toEqual([])
  })

  it('probes each distinct (url, token) group separately (#587)', async () => {
    // Two credentials on ONE host: the old per-URL first-token-wins collapse
    // reported this config healthy while the second token was dead.
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:test', shared: true, readonly: false },
      { url: baseUrl, token: 'dead-second-token', scope: 'group:other', shared: true, readonly: false },
    ])
    const rows = await plur.checkRemoteHealth()
    expect(rows).toHaveLength(2)
    const ok = rows.find(r => r.status === 'ok')
    const dead = rows.find(r => r.status === 'auth_expired')
    expect(ok?.scopes).toEqual(['group:test'])
    expect(dead?.scopes).toEqual(['group:other'])
    expect(dead?.reason).toMatch(/401/)
  })

  it('collapses same (url, token) across scopes and URL spellings into one probe (#587)', async () => {
    const plur = writeConfig([
      { url: baseUrl, token: TOKEN, scope: 'group:test', shared: true, readonly: false },
      { url: `${baseUrl}/`, token: TOKEN, scope: 'group:second', shared: true, readonly: false },
    ])
    const rows = await plur.checkRemoteHealth()
    expect(rows).toHaveLength(1)
    expect(rows[0].scopes).toEqual(['group:test', 'group:second'])
  })

  it('reports server-confirmed identity + granted scope count on ok (#587)', async () => {
    server.setMe({ username: 'maintainer', org_id: 'plur', role: 'developer', scopes: ['group:a', 'group:b', 'group:c'] })
    const plur = writeConfig([{ url: baseUrl, token: TOKEN, scope: 'group:a', shared: true, readonly: false }])
    const [h] = await plur.checkRemoteHealth()
    expect(h.status).toBe('ok')
    expect(h.username).toBe('maintainer')
    expect(h.orgId).toBe('plur')
    expect(h.grantedScopes).toBe(3)
  })

  it('surfaces display-only JWT subject/org claims even when the server rejects the token (#587)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 20 * 86_400
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const revokedJwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'gregor', orgId: 'igea', exp })}.sig`
    const plur = writeConfig([{ url: baseUrl, token: revokedJwt, scope: 'group:igea/gis', shared: true, readonly: false }])
    const [h] = await plur.checkRemoteHealth()
    expect(h.status).toBe('auth_expired') // stub 401s any token it did not mint
    expect(h.tokenSubject).toBe('gregor')
    expect(h.tokenOrg).toBe('igea')
    expect(h.tokenExpiresInDays).toBeGreaterThan(18)
  })
})

describe('Plur.remoteEndpointTokenGroups() (#587)', () => {
  it('groups by (normalized url, token) preserving config order of scopes', () => {
    const plur = writeConfig([
      { url: 'https://x.example.com', token: 't1', scope: 'group:a', shared: true, readonly: false },
      { url: 'https://x.example.com/', token: 't1', scope: 'group:b', shared: true, readonly: false },
      { url: 'https://x.example.com', token: 't2', scope: 'group:c', shared: true, readonly: false },
      { url: 'https://y.example.com', token: 't1', scope: 'group:d', shared: true, readonly: false },
    ])
    const groups = plur.remoteEndpointTokenGroups()
    expect(groups).toHaveLength(3)
    expect(groups[0]).toEqual({ url: 'https://x.example.com', token: 't1', scopes: ['group:a', 'group:b'] })
    expect(groups[1]).toEqual({ url: 'https://x.example.com', token: 't2', scopes: ['group:c'] })
    expect(groups[2]).toEqual({ url: 'https://y.example.com', token: 't1', scopes: ['group:d'] })
  })

  it('ignores filesystem stores', () => {
    const plur = writeConfig([{ path: '/tmp/some-store', scope: 'user:me', shared: false, readonly: false }])
    expect(plur.remoteEndpointTokenGroups()).toEqual([])
  })
})

describe('Plur.remoteTokenExpiries()', () => {
  it('decodes JWT expiry locally with no network call', () => {
    const exp = Math.floor(Date.now() / 1000) + 5 * 86_400
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'maintainer', exp })}.sig`
    const plur = writeConfig([{ url: baseUrl, token: jwt, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }])
    const [t] = plur.remoteTokenExpiries()
    expect(t.expired).toBe(false)
    // floor of ~4.999 days (now is truncated to whole seconds) → 4 or 5; floor is
    // intentionally conservative for an expiry warning.
    expect(t.expiresInDays).toBeGreaterThanOrEqual(4)
    expect(t.expiresInDays).toBeLessThanOrEqual(5)
    expect(t.url).toBe(baseUrl)
  })

  it('yields null expiry fields for an opaque key', () => {
    const plur = writeConfig([{ url: baseUrl, token: 'plur_sk_opaque', scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }])
    const [t] = plur.remoteTokenExpiries()
    expect(t.expiresInDays).toBeNull()
    expect(t.expired).toBe(false)
  })
})

describe('learnRouted outbox auth flag (#295)', () => {
  it('flags _outbox.auth_failed when a remote write is rejected with 401', async () => {
    const plur = writeConfig([{ url: baseUrl, token: 'wrong-token', scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }])
    const e: any = await plur.learnRouted('Team convention: prefix feature branches with the issue number', { scope: 'group:plur/plur-ai/engineering' })
    expect(e.structured_data?._outbox).toBeDefined()
    expect(e.structured_data._outbox.auth_failed).toBe(true)
    expect(e.structured_data._outbox.last_error).toMatch(/401/)
  })

  it('does NOT flag auth_failed for a non-auth (unreachable) failure', async () => {
    const down = new StubServer(TOKEN)
    const info = await down.start()
    await down.stop() // port closed → network error, not 401
    const plur = writeConfig([{ url: info.url, token: TOKEN, scope: 'group:plur/plur-ai/engineering', shared: true, readonly: false }])
    const e: any = await plur.learnRouted('Team convention: rebase, do not merge-commit, onto main', { scope: 'group:plur/plur-ai/engineering' })
    expect(e.structured_data?._outbox).toBeDefined()
    expect(e.structured_data._outbox.auth_failed).toBe(false)
  })
})
