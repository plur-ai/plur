/**
 * Codex round 4, finding 2: discovery replaced a server entry's compatibility
 * `scope` (with the personal scope /me lists) without moving the old compat
 * scope's top-level metadata. Expansion gives top-level metadata to whatever
 * scope holds the compat field, so the team lost `dial: never` (and became
 * eligible for remote recall) and the personal scope inherited it.
 *
 * Fixed: before the compat scope changes, its top-level metadata moves into
 * `scope_settings[oldScope]` (keys already there win) and leaves the top level.
 *
 * Real HTTP against the stub.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import type { RemoteRecallHost } from '../src/remote-recall.js'
import { StubServer } from './helpers/stub-server.js'

const TOKEN = 'plur_sk_c4-compat'
const TEAM = 'group:acme/team'
const PERSONAL = 'user:acme:alice'

let stub: StubServer
let url: string
let dir: string

const configPath = (): string => join(dir, 'config.yaml')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawEntry = (): any => (yaml.load(readFileSync(configPath(), 'utf8')) as any).stores[0]
const write = (stores: unknown[]): void =>
  writeFileSync(configPath(), yaml.dump({ index: false, embeddings: { enabled: false }, stores }))
const hostsOf = (plur: Plur, options?: Record<string, unknown>): RemoteRecallHost[] =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plur as any)._remoteRecallHosts(options)

beforeAll(async () => {
  stub = new StubServer(TOKEN)
  ;({ url } = await stub.start())
})
afterAll(async () => { await stub.stop() })
beforeEach(() => {
  stub.reset()
  stub.setMe({
    username: 'alice', org_id: 'acme', role: 'developer',
    scopes: [TEAM, PERSONAL], scopes_status: 'ok', scope_metadata_status: 'absent',
  })
  dir = mkdtempSync(join(tmpdir(), 'plur-c4-compat-'))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('a compat-scope change keeps the old scope\'s metadata on that scope', () => {
  it('legacy team entry with dial: never: the team keeps it and is never dialled; the personal scope does not inherit it', async () => {
    write([{
      url, token: TOKEN, enterprise: {},
      scope: TEAM, scopes: [TEAM],
      dial: 'never', description: 'Team-wide', covers: ['acme.team'],
      sensitivity: { forbid: ['secrets'] }, future_meta: 'kept',
    }])
    const [o] = await new Plur({ path: dir }).refreshServerScopes()
    expect(o).toMatchObject({ status: 'ok', applied: true })

    const raw = rawEntry()
    expect(raw.scope).toBe(PERSONAL)
    for (const k of ['dial', 'description', 'covers', 'sensitivity', 'future_meta']) expect(raw[k]).toBeUndefined()
    expect(raw.scope_settings?.[TEAM]).toEqual({
      dial: 'never', description: 'Team-wide', covers: ['acme.team'],
      sensitivity: { forbid: ['secrets'] }, future_meta: 'kept',
    })
    expect(raw.scope_settings?.[PERSONAL]).toBeUndefined()

    const plur = new Plur({ path: dir })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stores = (plur as any).config.stores as Array<Record<string, unknown>>
    const team = stores.find(s => s.scope === TEAM)
    const personal = stores.find(s => s.scope === PERSONAL)
    expect(team).toMatchObject({ dial: 'never', description: 'Team-wide', covers: ['acme.team'], future_meta: 'kept' })
    expect(personal?.dial).toBeUndefined()
    expect(personal?.description).toBeUndefined()
    expect(personal?.covers).toBeUndefined()
    expect(personal?.sensitivity).toBeUndefined()
    expect(personal?.future_meta).toBeUndefined()

    // Never dialled for the team, from an org context or by its own scope;
    // the personal scope is still dialled.
    expect(hostsOf(plur, { scope: 'project:acme/app' }).flatMap(h => h.scopes)).not.toContain(TEAM)
    expect(hostsOf(plur, { scope: TEAM }).flatMap(h => h.scopes)).not.toContain(TEAM)
    expect(hostsOf(plur, { scope: PERSONAL }).flatMap(h => h.scopes)).toContain(PERSONAL)
  })

  it('keys already in scope_settings[oldScope] win over the moved top-level values', async () => {
    write([{
      url, token: TOKEN, enterprise: {},
      scope: TEAM, scopes: [TEAM],
      dial: 'never', description: 'Old',
      scope_settings: { [TEAM]: { description: 'New' } },
    }])
    await new Plur({ path: dir }).refreshServerScopes()
    const raw = rawEntry()
    expect(raw.scope).toBe(PERSONAL)
    expect(raw.dial).toBeUndefined()
    expect(raw.description).toBeUndefined()
    expect(raw.scope_settings[TEAM]).toEqual({ dial: 'never', description: 'New' })
  })

  it('control: the compat scope does not change (already personal): the top level is left as it is', async () => {
    write([{
      url, token: TOKEN, enterprise: {},
      scope: PERSONAL, scopes: [PERSONAL], description: 'Mine',
    }])
    await new Plur({ path: dir }).refreshServerScopes()
    const raw = rawEntry()
    expect(raw.scope).toBe(PERSONAL)
    expect(raw.description).toBe('Mine')
    expect(raw.scope_settings).toBeUndefined()
  })
})
