/**
 * One canonical endpoint identity (Codex round 3, finding 2).
 *
 * `https://plur.example.com`, `https://plur.example.com:443`,
 * `https://PLUR.example.com/` and `https://plur.example.com/sse` all address
 * the same server. Before this fix the identity only folded a trailing `/sse`
 * and `/`, so the default port and host case made one server count as two:
 * the resolver reported a conflict, saves were refused and queued deliveries
 * were held. Every identity comparison now goes through the same URL-parsed
 * form; a different base path or a non-default port is still another server.
 * The url the user wrote is never rewritten on disk.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { normalizeEndpointUrl } from '../src/store/remote-store.js'
import { resolveScopeTarget, urlGroupsForScope } from '../src/store-resolver.js'
import { serverEntryIdentities, identityBaseOf } from '../src/store-expand.js'
import type { StoreEntry } from '../src/schemas/config.js'
import { StubServer } from './helpers/stub-server.js'

const BASE = 'https://plur.example.com'
/** Spellings of BASE that must all be the same server. */
const EQUIVALENT = [
  'https://plur.example.com:443',
  'https://PLUR.Example.COM',
  'HTTPS://plur.example.com/',
  'https://plur.example.com/sse',
  'https://plur.example.com:443/sse/',
  'https://alice:secret@plur.example.com',
]
/** Spellings that name another server. */
const DIFFERENT = [
  'https://plur.example.com:8443',
  'http://plur.example.com',
  'https://plur.example.com/tenant-a',
  'https://other.example.com',
]

const SCOPE = 'group:acme/team'
const entry = (url: string, extra: Record<string, unknown> = {}): StoreEntry =>
  ({ url, token: 't', scope: SCOPE, shared: true, readonly: false, ...extra }) as unknown as StoreEntry

describe('normalizeEndpointUrl: the canonical identity', () => {
  it.each(EQUIVALENT)('%s is the same server as the plain url', (u) => {
    expect(normalizeEndpointUrl(u)).toBe(normalizeEndpointUrl(BASE))
  })

  it.each(DIFFERENT)('%s is a different server', (u) => {
    expect(normalizeEndpointUrl(u)).not.toBe(normalizeEndpointUrl(BASE))
  })

  it('keeps a meaningful base path, folding only its trailing /sse and slash', () => {
    expect(normalizeEndpointUrl('https://PLUR.example.com:443/tenant-a/sse/')).toBe('https://plur.example.com/tenant-a')
    expect(normalizeEndpointUrl('https://plur.example.com/tenant-a')).not.toBe(normalizeEndpointUrl('https://plur.example.com/tenant-b'))
    // Path case is significant; only scheme and host are case-folded.
    expect(normalizeEndpointUrl('https://plur.example.com/Tenant')).not.toBe(normalizeEndpointUrl('https://plur.example.com/tenant'))
  })

  it('the default port of http is folded too, a non-default one is kept', () => {
    expect(normalizeEndpointUrl('http://plur.example.com:80/')).toBe('http://plur.example.com')
    expect(normalizeEndpointUrl('http://plur.example.com:8080')).toBe('http://plur.example.com:8080')
  })

  it('userinfo is never part of the identity', () => {
    expect(normalizeEndpointUrl('https://bob:tok@plur.example.com/sse')).toBe('https://plur.example.com')
  })
})

describe('resolver grouping', () => {
  it.each(EQUIVALENT)('%s and the plain url on one scope → one server, not a conflict', (u) => {
    expect(urlGroupsForScope(SCOPE, [entry(BASE), entry(u)])).toHaveLength(1)
    expect(resolveScopeTarget(SCOPE, [entry(BASE), entry(u)]).kind).toBe('remote')
  })

  it.each(DIFFERENT)('%s and the plain url on one scope → still a conflict', (u) => {
    expect(resolveScopeTarget(SCOPE, [entry(BASE), entry(u)]).kind).toBe('conflict')
  })
})

describe('store-expand identity', () => {
  const server = (url: string) => ({ url, token: 't', scopes: [SCOPE], enterprise: {} })

  it('two server entries that differ only in the url spelling share an identity base', () => {
    const ids = serverEntryIdentities([server(BASE), server('https://PLUR.example.com:443/sse')])
    expect(identityBaseOf(ids[0]!)).toBe(identityBaseOf(ids[1]!))
    expect(ids[1]!.endsWith('#1')).toBe(true)
  })

  it('a different base path or port is another identity', () => {
    for (const other of ['https://plur.example.com/tenant-a', 'https://plur.example.com:8443']) {
      const ids = serverEntryIdentities([server(BASE), server(other)])
      expect(identityBaseOf(ids[0]!)).not.toBe(identityBaseOf(ids[1]!))
    }
  })
})

describe('outbox target matching', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stillQueuedFor = (Plur as any)._stillQueuedFor.bind(Plur) as (e: unknown, t: { url: string; scope: string }) => boolean
  const queued = (target_url: string) => ({ id: 'ENG-1', structured_data: { _outbox: { target_url, target_scope: SCOPE, queued_at: '2026-10-17T00:00:00Z' } } })

  it.each(EQUIVALENT)('a row queued for %s is still queued for the plain url', (u) => {
    expect(stillQueuedFor(queued(u), { url: BASE, scope: SCOPE })).toBe(true)
  })

  it.each(DIFFERENT)('a row queued for %s is not queued for the plain url', (u) => {
    expect(stillQueuedFor(queued(u), { url: BASE, scope: SCOPE })).toBe(false)
  })
})

describe('Plur: rotation, metadata and refresh match on the canonical identity', () => {
  let dir: string
  const configPath = (): string => join(dir, 'config.yaml')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (): any => yaml.load(readFileSync(configPath(), 'utf8'))
  const write = (stores: unknown[]): void => writeFileSync(configPath(), yaml.dump({ index: false, stores }))

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-c3-identity-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('a key given for an equivalent spelling rotates the server entry and keeps the url as written', () => {
    write([{ url: BASE, token: 't-old', scopes: [SCOPE], enterprise: {} }])
    const r = new Plur({ path: dir }).addStore('', SCOPE, { url: 'https://PLUR.example.com:443/sse', token: 't-new' })
    expect(r.status).toBe('token_rotated')
    const stores = raw().stores
    expect(stores).toHaveLength(1)
    expect(stores[0].url).toBe(BASE)
    expect(stores[0].token).toBe('t-new')
  })

  it('a key for another port is not a rotation of this server entry', () => {
    write([{ url: BASE, token: 't-old', scopes: [SCOPE], enterprise: {} }])
    // Another server claiming a scope of a server entry is refused outright.
    expect(() => new Plur({ path: dir }).addStore('', SCOPE, { url: 'https://plur.example.com:8443', token: 't-new' }))
      .toThrow(/belongs to the server entry/)
    expect(raw().stores).toHaveLength(1)
    expect(raw().stores[0].token).toBe('t-old')
  })

  it('discovery metadata for an equivalent spelling lands on the entry', () => {
    write([{ url: BASE, token: 'tok', scope: SCOPE, shared: true, readonly: false }])
    const plur = new Plur({ path: dir, autoDiscover: false })
    plur.persistScopeMetadata([{
      url: 'https://PLUR.example.com:443/', ok: true, authorized: [SCOPE], registered: [SCOPE], unregistered: [],
      metadata: [{ scope: SCOPE, description: 'Team', covers: ['acme.team'] }],
    } as never])
    expect(raw().stores[0]).toMatchObject({ url: BASE, description: 'Team', covers: ['acme.team'] })
  })

  it('discovery metadata for another base path does not land on the entry', () => {
    write([{ url: BASE, token: 'tok', scope: SCOPE, shared: true, readonly: false }])
    const plur = new Plur({ path: dir, autoDiscover: false })
    plur.persistScopeMetadata([{
      url: `${BASE}/tenant-a`, ok: true, authorized: [SCOPE], registered: [SCOPE], unregistered: [],
      metadata: [{ scope: SCOPE, description: 'Team', covers: ['acme.team'] }],
    } as never])
    expect(raw().stores[0].description).toBeUndefined()
  })
})

describe('refreshServerScopes: the requested url matches an equivalent spelling', () => {
  const TOKEN = 'c3-identity-token'
  let stub: StubServer
  let url: string
  let dir: string
  beforeAll(async () => { stub = new StubServer(TOKEN); ({ url } = await stub.start()) })
  afterAll(async () => { await stub.stop() })
  beforeEach(() => {
    stub.reset()
    stub.setMe({ username: 'alice', org_id: 'acme', role: 'developer', scopes: ['user:acme:alice', SCOPE], scopes_status: 'ok', scope_metadata_status: 'absent' })
    dir = mkdtempSync(join(tmpdir(), 'plur-c3-refresh-'))
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({ index: false, stores: [{ url, token: TOKEN, enterprise: {}, scopes: [] }] }))
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('an upper-case scheme with /sse/ refreshes the configured entry', async () => {
    const variant = url.replace(/^http:/, 'HTTP:') + '/sse/'
    const outcomes = await new Plur({ path: dir }).refreshServerScopes({ url: variant })
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ applied: true })
    const after = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { stores: Array<{ url: string; scopes: string[] }> }
    expect(after.stores[0].url).toBe(url)
    expect(after.stores[0].scopes).toContain(SCOPE)
  })

  it('another base path refreshes nothing', async () => {
    expect(await new Plur({ path: dir }).refreshServerScopes({ url: `${url}/tenant-a` })).toEqual([])
  })
})
