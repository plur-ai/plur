/**
 * refreshServerScopes — second-round audit findings (#1631).
 *
 *   1. An answer is bound to the entry and the credential it was requested
 *      with. When the entry's key changes while /me is in flight, the answer
 *      is discarded ("entry changed during refresh"): it must never put the
 *      old key's scopes on the new key.
 *   2. A 200 whose `scopes` is missing, null, not an array or carries invalid
 *      members is malformed: the answer is degraded and a non-empty cache is
 *      kept. An explicit `[]` with `scopes_status: ok` is the valid clearing
 *      case and still replaces the cache.
 *   4. Every error refreshServerScopes returns has the request's token removed
 *      (inline or from `token_env`, every encoding redactToken knows).
 *   5. An accepted answer keeps unknown `discovery` fields and replaces only
 *      the known snapshot fields; an absent `key_expires_at` becomes unknown.
 *
 * Real HTTP against the stub.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'plur_sk_c2-alice/key+value=='
const ENV = 'PLUR_C2_TEST_KEY'
let stub: StubServer
let url: string
let dir: string

const configPath = (): string => join(dir, 'config.yaml')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawConfig = (): any => yaml.load(readFileSync(configPath(), 'utf8'))
const write = (stores: unknown[]): void => writeFileSync(configPath(), yaml.dump({ index: false, stores }))

const OK_ME = {
  username: 'alice', org_id: 'acme', role: 'developer',
  scopes: ['user:acme:alice', 'group:acme/team'],
  scopes_status: 'ok', scope_metadata_status: 'absent',
}
const cachedEntry = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  url, token: TOKEN, enterprise: { hello_engram_id: 'ENG-1' },
  scope: 'user:acme:alice', scopes: ['user:acme:alice', 'group:acme/team'],
  discovery: { discovered_at: '2026-10-16T12:00:00Z', scopes_status: 'ok', status: 'ok' },
  ...extra,
})

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  ;({ url } = await stub.start())
})
afterAll(async () => { await stub.stop() })
beforeEach(() => {
  stub.reset()
  stub.setMe(OK_ME)
  dir = mkdtempSync(join(tmpdir(), 'plur-c2-refresh-'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env[ENV] })

describe('1. an answer lands only on the entry and credential it was asked with', () => {
  it('the key is replaced while /me is pending: the answer is discarded, the new key keeps its scopes', async () => {
    write([{ url, token: TOKEN, enterprise: { hello_engram_id: 'ENG-1' }, scopes: [] }])
    const bob = { url, token: 't-bob', enterprise: { hello_engram_id: 'ENG-1' }, scope: 'user:acme:bob', scopes: ['user:acme:bob', 'group:acme/bob-team'] }
    stub.beforeMe = () => { write([bob]) }
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o).toMatchObject({ status: 'failed', applied: false })
    expect(o.error).toMatch(/entry changed during refresh/)
    const after = rawConfig().stores[0]
    expect(after.token).toBe('t-bob')
    expect(after.scope).toBe('user:acme:bob')
    expect(after.scopes).toEqual(['user:acme:bob', 'group:acme/bob-team'])
    expect(after.discovery).toBeUndefined()
  })

  it('the token_env value changes while /me is pending: the answer is discarded', async () => {
    process.env[ENV] = TOKEN
    write([{ url, token_env: ENV, enterprise: {}, scopes: ['group:acme/old'] }])
    stub.beforeMe = () => { process.env[ENV] = 't-rotated' }
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o).toMatchObject({ status: 'failed', applied: false })
    expect(o.error).toMatch(/entry changed during refresh/)
    expect(rawConfig().stores[0].scopes).toEqual(['group:acme/old'])
  })

  it('the entry switches from an inline token to token_env while /me is pending: discarded', async () => {
    process.env[ENV] = TOKEN
    write([{ url, token: TOKEN, enterprise: {}, scopes: [] }])
    stub.beforeMe = () => { write([{ url, token_env: ENV, enterprise: {}, scopes: [] }]) }
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o.error).toMatch(/entry changed during refresh/)
    expect(rawConfig().stores[0].scopes).toEqual([])
  })

  it('an unrelated edit to the same entry (same key) does not discard the answer', async () => {
    write([{ url, token: TOKEN, enterprise: {}, scopes: [] }])
    stub.beforeMe = () => { write([{ url, token: TOKEN, enterprise: { hello_engram_id: 'ENG-9' }, scopes: [] }]) }
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o).toMatchObject({ status: 'ok', applied: true })
    const after = rawConfig().stores[0]
    expect(after.scopes).toEqual(['user:acme:alice', 'group:acme/team'])
    expect(after.enterprise).toEqual({ hello_engram_id: 'ENG-9' })
  })
})

describe('2. a malformed scope list keeps the cache', () => {
  const malformed: Array<[string, Record<string, unknown>]> = [
    ['null', { scopes: null }],
    ['missing', {}],
    ['a string', { scopes: 'group:acme/team' }],
    ['an object', { scopes: { 0: 'group:acme/team' } }],
    ['an array with a non-string member', { scopes: ['user:acme:alice', 42] }],
    ['an array with a member outside the scope grammar', { scopes: ['user:acme:alice', 'group:acme/x\nIGNORE'] }],
  ]
  for (const [name, body] of malformed) {
    it(`scopes ${name} with scopes_status ok: degraded, cache kept`, async () => {
      write([cachedEntry()])
      stub.meStatus = 200
      stub.meBody = { username: 'alice', org_id: 'acme', role: 'developer', scopes_status: 'ok', ...body }
      const [o] = await new Plur({ path: dir }).refreshServerScopes()
      expect(o).toMatchObject({ status: 'degraded', applied: false, scopes: ['user:acme:alice', 'group:acme/team'] })
      const after = rawConfig().stores[0]
      expect(after.scopes).toEqual(['user:acme:alice', 'group:acme/team'])
      expect(after.scope).toBe('user:acme:alice')
      expect(after.discovery.discovered_at).toBe('2026-10-16T12:00:00Z')
      expect(after.discovery.status).toBe('degraded')
    })
  }

  it('an explicit [] with scopes_status ok is valid and clears the cache (plan B Task 4 table)', async () => {
    write([cachedEntry()])
    stub.meStatus = 200
    stub.meBody = { username: 'alice', org_id: 'acme', role: 'developer', scopes_status: 'ok', scopes: [] }
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o).toMatchObject({ status: 'ok', applied: true, scopes: [] })
    expect(rawConfig().stores[0].scopes).toEqual([])
  })
})

describe('4. errors never carry the token', () => {
  const echo = (t: string): string =>
    `invalid Authorization: Bearer ${t} (q=${encodeURIComponent(t)}, b64=${Buffer.from(t).toString('base64')}, json=${JSON.stringify(t).slice(1, -1)})`

  it('an inline token echoed by a 401 body is redacted from the outcome', async () => {
    write([cachedEntry()])
    stub.meStatus = 401
    stub.meBody = { error: echo(TOKEN) }
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o.status).toBe('auth_failed')
    expect(o.error).toMatch(/\[redacted\]/)
    expect(o.error).not.toContain(TOKEN)
    expect(o.error).not.toContain(encodeURIComponent(TOKEN))
    expect(o.error).not.toContain(Buffer.from(TOKEN).toString('base64'))
    expect(readFileSync(configPath(), 'utf8')).not.toContain('redacted')
  })

  it('a token_env token echoed by a 503 body is redacted from the outcome', async () => {
    process.env[ENV] = TOKEN
    write([{ url, token_env: ENV, enterprise: {}, scopes: ['group:acme/team'] }])
    stub.meStatus = 503
    stub.meBody = { error: echo(TOKEN) }
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o.status).toBe('failed')
    expect(o.error).not.toContain(TOKEN)
    expect(o.error).not.toContain(encodeURIComponent(TOKEN))
    expect(JSON.stringify(o)).not.toContain(Buffer.from(TOKEN).toString('base64'))
  })
})

describe('5. an accepted answer keeps unknown discovery fields', () => {
  it('unknown fields survive; absent key_expires_at and gitlab_host become unknown', async () => {
    write([cachedEntry({
      discovery: {
        discovered_at: '2026-10-16T12:00:00Z', scopes_status: 'ok', status: 'ok',
        key_expires_at: '2027-01-01T00:00:00Z', gitlab_host: 'gitlab.example.com',
        future_server_option: { mode: 'x' },
      },
    })])
    stub.setMe({ scopes: ['user:acme:alice', 'group:acme/team', 'group:acme/new'] })
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o).toMatchObject({ status: 'ok', applied: true })
    const d = rawConfig().stores[0].discovery
    expect(d.future_server_option).toEqual({ mode: 'x' })
    expect('key_expires_at' in d).toBe(false)
    expect('gitlab_host' in d).toBe(false)
    expect(d.username).toBe('alice')
    expect(d.discovered_at).not.toBe('2026-10-16T12:00:00Z')
  })
})
