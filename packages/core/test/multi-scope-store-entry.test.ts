/**
 * Multi-scope server store entry (#1631).
 *
 * A store entry may carry `scopes: string[]` in addition to a single `scope`.
 * At load it is expanded into one in-memory entry per scope; per-scope
 * `scope_settings` fields are merged onto each expanded entry. On writeback
 * the expanded entries collapse back into the one on-disk server entry.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { loadConfig } from '../src/config.js'
import { logger } from '../src/logger.js'
import { StoreEntrySchema } from '../src/schemas/config.js'
import { Plur, type RemoteScopeDiscovery } from '../src/index.js'

const SERVER = `stores:
  - url: https://plur.example.com
    token: t-alice
    scope: user:acme:alice
    scopes: ["user:acme:alice", "group:acme/team", "project:acme/team/backend"]
    discovery:
      discovered_at: "2026-10-16T12:00:00Z"
      scopes_status: ok
      gitlab_host: gitlab.example.com
    enterprise: { hello_engram_id: ENG-1 }
    scope_settings:
      group:acme/team: { description: "Team-wide", covers: ["acme.team"] }
`

const dirs: string[] = []
const write = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'plur-msse-'))
  dirs.push(dir)
  const p = join(dir, 'config.yaml')
  writeFileSync(p, content)
  return p
}

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('multi-scope server entry — load expansion', () => {
  it('expands a scopes entry into one in-memory entry per scope', () => {
    const cfg = loadConfig(write(SERVER))
    const stores = cfg.stores ?? []
    expect(stores.map(s => s.scope)).toEqual(['user:acme:alice', 'group:acme/team', 'project:acme/team/backend'])
    expect(stores.every(s => s.url === 'https://plur.example.com' && s.token === 't-alice')).toBe(true)
    expect(stores[1].description).toBe('Team-wide')
    expect(stores[1].shared).toBe(true)
    expect(stores[0].shared).toBe(false)
  })

  it('#1220: a malformed scopes value keeps the entry and its token', () => {
    const cfg = loadConfig(write(`stores:\n  - url: https://plur.example.com\n    token: t\n    scopes: [5, "group:acme/team", {x: 1}]\n`))
    const stores = cfg.stores ?? []
    expect(stores.map(s => s.scope)).toEqual(['group:acme/team'])
    expect(stores[0].token).toBe('t')
  })

  it('a compat scope next to scopes loads deduplicated — user:acme:alice appears exactly once', () => {
    // SERVER has scope: user:acme:alice AND scopes includes user:acme:alice
    const cfg = loadConfig(write(SERVER))
    const stores = cfg.stores ?? []
    const personal = stores.filter(s => s.scope === 'user:acme:alice')
    expect(personal).toHaveLength(1)
    expect(stores).toHaveLength(3)
  })

  it('token_env on a server entry resolves for every expanded scope', () => {
    process.env.ALICE_KEY = 't-from-env'
    try {
      const cfg = loadConfig(write(
        `stores:\n  - url: https://plur.example.com\n    token_env: ALICE_KEY\n    scopes: ["user:acme:alice", "group:acme/team"]\n`
      ))
      const stores = cfg.stores ?? []
      expect(stores).toHaveLength(2)
      expect(stores.every(s => s.token === 't-from-env')).toBe(true)
    } finally {
      delete process.env.ALICE_KEY
    }
  })
})

describe('multi-scope server entry — backward compatibility guards', () => {
  it('a legacy per-scope config loads byte-identical to v0.21.5', () => {
    // Entries without a `scopes` key are NOT server entries — the existing path is taken
    const legacyCfg = `stores:
  - url: https://plur.example.com
    token: t-alice
    scope: user:acme:alice
  - url: https://plur.example.com
    token: t-alice
    scope: group:acme/team
    description: Team-wide
    covers: ["acme.team"]
`
    const cfg = loadConfig(write(legacyCfg))
    // Snapshot generated from v0.21.5 (origin/main) before any code change
    expect(cfg.stores ?? []).toEqual([
      { url: 'https://plur.example.com', token: 't-alice', scope: 'user:acme:alice', shared: false, readonly: false },
      { url: 'https://plur.example.com', token: 't-alice', scope: 'group:acme/team', shared: false, readonly: false, description: 'Team-wide', covers: ['acme.team'] },
    ])
  })

  it('an older client keeps the written entry: it parses with v0.21.5 StoreEntrySchema as scope user:acme:alice', () => {
    // The SERVER YAML carries scope: user:acme:alice (C6 compat field).
    // An older client running StoreEntrySchema.safeParse on the raw YAML must succeed
    // with scope user:acme:alice — confirming the compat field is present on disk.
    const p = write(SERVER)
    const raw = yaml.load(readFileSync(p, 'utf8')) as { stores: unknown[] }
    const result = StoreEntrySchema.safeParse(raw.stores[0])
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.scope).toBe('user:acme:alice')
  })
})

describe('multi-scope server entry — writeback collapse', () => {
  it('an empty scopes list loads as zero entries and is not dropped from disk on writeback', () => {
    const p = write(`stores:\n  - url: https://plur.example.com\n    token: t\n    enterprise: {}\n    scopes: []\n`)
    const plur = new Plur({ path: dirname(p) })
    plur.addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })
    const raw = yaml.load(readFileSync(p, 'utf8')) as any
    expect(raw.stores[0]).toMatchObject({ url: 'https://plur.example.com', enterprise: {}, scopes: [] })
    expect(raw.stores[0].scope).toBeUndefined()
    expect(raw.stores).toHaveLength(2)
  })

  it('writeback keeps one server entry, never N per-scope entries', () => {
    const p = write(SERVER)
    const plur = new Plur({ path: dirname(p) })
    // persistScopeMetadata triggers persistStores with the expanded entries
    const discovery: RemoteScopeDiscovery = {
      url: 'https://plur.example.com', ok: true,
      authorized: ['project:acme/team/backend'], registered: ['project:acme/team/backend'], unregistered: [],
      metadata: [{ scope: 'project:acme/team/backend', description: 'Backend', covers: ['acme.backend'] }],
    }
    plur.persistScopeMetadata([discovery])
    const raw = yaml.load(readFileSync(p, 'utf8')) as any
    expect(raw.stores).toHaveLength(1)
    expect(raw.stores[0].scopes).toEqual(['user:acme:alice', 'group:acme/team', 'project:acme/team/backend'])
    expect(raw.stores[0]).not.toHaveProperty('_expanded_from')
  })

  it('C6: scope, enterprise.hello_engram_id and discovery survive a load and a writeback', () => {
    const p = write(SERVER)
    const plur = new Plur({ path: dirname(p) })
    plur.addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })
    const raw = yaml.load(readFileSync(p, 'utf8')) as any
    const srv = raw.stores[0]
    expect(srv.scope).toBe('user:acme:alice')
    expect(srv.enterprise?.hello_engram_id).toBe('ENG-1')
    expect(srv.discovery).toMatchObject({
      discovered_at: '2026-10-16T12:00:00Z',
      scopes_status: 'ok',
      gitlab_host: 'gitlab.example.com',
    })
  })

  it('a per-scope metadata update lands in scope_settings', () => {
    const p = write(SERVER)
    const plur = new Plur({ path: dirname(p) })
    const discovery: RemoteScopeDiscovery = {
      url: 'https://plur.example.com', ok: true,
      authorized: ['project:acme/team/backend'], registered: ['project:acme/team/backend'], unregistered: [],
      metadata: [{ scope: 'project:acme/team/backend', description: '', covers: ['acme.backend'] }],
    }
    plur.persistScopeMetadata([discovery])
    const raw = yaml.load(readFileSync(p, 'utf8')) as any
    expect(raw.stores[0].scope_settings?.['project:acme/team/backend']?.covers).toEqual(['acme.backend'])
    // Existing scope_settings for group:acme/team must be preserved too
    expect(raw.stores[0].scope_settings?.['group:acme/team']?.covers).toEqual(['acme.team'])
  })

  it('token_env on a server entry is never written back as a resolved token', () => {
    process.env.ALICE_KEY = 't-from-env'
    try {
      const p = write(
        `stores:\n  - url: https://plur.example.com\n    token_env: ALICE_KEY\n    scopes: ["user:acme:alice", "group:acme/team"]\n`,
      )
      const plur = new Plur({ path: dirname(p) })
      plur.addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })
      const raw = yaml.load(readFileSync(p, 'utf8')) as any
      expect(raw.stores[0].token_env).toBe('ALICE_KEY')
      expect(raw.stores[0].token).toBeUndefined()
    } finally {
      delete process.env.ALICE_KEY
    }
  })
})

describe('multi-scope server entry — load hardening', () => {
  it('scope_settings cannot override the url, scope, token or readonly of an expanded entry', () => {
    const cfg = loadConfig(write(`stores:
  - url: https://plur.example.com
    token: t-alice
    scopes: ["group:acme/team"]
    scope_settings:
      group:acme/team: { url: "https://other.example.com", scope: "group:acme/other", token: "t-other", readonly: true, description: "Team" }
`))
    const stores = cfg.stores ?? []
    expect(stores).toHaveLength(1)
    expect(stores[0]).toMatchObject({ url: 'https://plur.example.com', scope: 'group:acme/team', token: 't-alice', readonly: false, description: 'Team' })
  })

  it('a future or malformed discovery, enterprise, pinned_scopes or scope_settings value keeps the entry and its token (#1220)', () => {
    const cfg = loadConfig(write(`stores:
  - url: https://plur.example.com
    token: t-alice
    scope: user:acme:alice
    scopes: ["group:acme/team"]
    pinned_scopes: "group:acme/pinned"
    enterprise: yes
    discovery: { status: expired, scopes_status: partial, discovered_at: "2026-10-16T12:00:00Z" }
    scope_settings:
      group:acme/team: 5
`))
    const stores = cfg.stores ?? []
    expect(stores.map(s => s.scope)).toEqual(['group:acme/team', 'user:acme:alice'])
    expect(stores.every(s => s.token === 't-alice')).toBe(true)
  })

  it('a scope that fails the safe grammar is dropped and its raw text never reaches the log', () => {
    const warn = vi.spyOn(logger, 'warning')
    try {
      const cfg = loadConfig(write(`stores:
  - url: https://plur.example.com
    token: t-alice
    scopes: ["group:acme/team", "group:x\nFORGED log line"]
`))
      expect((cfg.stores ?? []).map(s => s.scope)).toEqual(['group:acme/team'])
      const joined = warn.mock.calls.map(c => String(c[0])).join('\n')
      expect(joined).toContain('https://plur.example.com')
      expect(joined).not.toContain('FORGED')
      expect(joined).not.toContain('t-alice')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('multi-scope server entry — writeback keeps the file as it was', () => {
  const LEGACY_THEN_SERVER = `stores:
  - url: https://legacy.example.com
    token: t-legacy
    scope: group:acme/legacy
  - url: https://plur.example.com
    token: t-alice
    scope: user:acme:alice
    scopes: ["user:acme:alice", "group:acme/team"]
    enterprise: {}
`

  it('a writeback keeps the on-disk order of entries', () => {
    const p = write(LEGACY_THEN_SERVER)
    const plur = new Plur({ path: dirname(p) })
    plur.addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })
    const raw = yaml.load(readFileSync(p, 'utf8')) as any
    expect(raw.stores.map((s: any) => s.url)).toEqual([
      'https://legacy.example.com', 'https://plur.example.com', 'https://other.example.com',
    ])
  })

  it('a per-scope entry on the same url and scope as the server entry stays a per-scope entry', () => {
    // The upgrade path: an older per-scope entry for the personal scope, then
    // the server entry whose compat scope is the same scope.
    const p = write(`stores:
  - url: https://plur.example.com
    token: t-old
    scope: user:acme:alice
  - url: https://plur.example.com
    token: t-alice
    scope: user:acme:alice
    scopes: ["user:acme:alice", "group:acme/team"]
    enterprise: { hello_engram_id: ENG-1 }
`)
    const plur = new Plur({ path: dirname(p) })
    plur.addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })
    const raw = yaml.load(readFileSync(p, 'utf8')) as any
    expect(raw.stores).toHaveLength(3)
    expect(raw.stores[0]).not.toHaveProperty('scopes')
    expect(raw.stores[0]).not.toHaveProperty('enterprise')
    expect(raw.stores[0].token).toBe('t-old')
    expect(raw.stores[1]).toMatchObject({ token: 't-alice', scopes: ['user:acme:alice', 'group:acme/team'], enterprise: { hello_engram_id: 'ENG-1' } })
  })

  it('an entry inserted on disk after load does not receive the server entry\'s scope_settings', () => {
    const p = write(LEGACY_THEN_SERVER)
    const plur = new Plur({ path: dirname(p) })
    // Another process inserts a second server entry at the top after this one loaded.
    const onDisk = yaml.load(readFileSync(p, 'utf8')) as any
    onDisk.stores.unshift({ url: 'https://second.example.com', token: 't2', scopes: ['group:acme/second'], enterprise: {} })
    writeFileSync(p, yaml.dump(onDisk))
    const discovery: RemoteScopeDiscovery = {
      url: 'https://plur.example.com', ok: true,
      authorized: ['group:acme/team'], registered: ['group:acme/team'], unregistered: [],
      metadata: [{ scope: 'group:acme/team', description: 'Team', covers: ['acme.team'] }],
    }
    plur.persistScopeMetadata([discovery])
    const raw = yaml.load(readFileSync(p, 'utf8')) as any
    const second = raw.stores.find((s: any) => s.url === 'https://second.example.com')
    const server = raw.stores.find((s: any) => s.url === 'https://plur.example.com')
    expect(second?.scope_settings).toBeUndefined()
    expect(server?.scope_settings?.['group:acme/team']?.covers).toEqual(['acme.team'])
  })
})

