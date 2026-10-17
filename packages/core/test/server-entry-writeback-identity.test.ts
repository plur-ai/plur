/**
 * Server entry writeback (#1631): which on-disk entry a change lands on, and
 * what it keeps.
 *
 *   - Identity: an expanded entry names its server entry by a stable identity,
 *     not by array position, so an entry another process inserts between this
 *     process's load and its locked reread never receives this entry's data.
 *   - Rotation: a new key reaches only the selected server entry; another
 *     server entry on the same url keeps its own token / token_env; a scope
 *     two server entries on one url both list is refused, not applied to both.
 *   - Sensitivity: the collapse applies the existing writeback rules inside
 *     scope_settings (and on a compat scope's top-level metadata): ordinary
 *     writeback keeps unknown `forbid` categories and nested keys, an
 *     authoritative server update replaces `forbid`.
 *   - Compat scope: its top-level metadata stays where it is on an unrelated
 *     writeback and is updated in place when it changes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { loadConfig } from '../src/config.js'
import { Plur, type RemoteScopeDiscovery } from '../src/index.js'

const dirs: string[] = []
const write = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'plur-sewi-'))
  dirs.push(dir)
  const p = join(dir, 'config.yaml')
  writeFileSync(p, `embeddings:\n  enabled: false\n${content}`)
  return p
}
const readRaw = (p: string): any => yaml.load(readFileSync(p, 'utf8'))
const unrelatedWrite = (plur: Plur) => plur.addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('server entry identity — a concurrent insertion never receives another entry\'s data', () => {
  const ONE = `stores:
  - url: https://a.example.com
    token: t-a
    scopes: ["group:acme/team"]
    enterprise: {}
`
  it('metadata computed before another process inserted a server entry at index 0 lands on its own entry', () => {
    const p = write(ONE)
    const plur = new Plur({ path: dirname(p) })
    // This process expands the config (load) and changes one scope's metadata.
    const stores = (loadConfig(p).stores ?? []).map(s => s.scope === 'group:acme/team' ? { ...s, covers: ['acme.team'] } : s)
    // Another process inserts a server entry at the top before our locked reread.
    const onDisk = readRaw(p)
    onDisk.stores.unshift({ url: 'https://b.example.com', token: 't-b', scopes: ['group:acme/b'], enterprise: {} })
    writeFileSync(p, yaml.dump(onDisk))
    ;(plur as any).persistStores(stores)
    const raw = readRaw(p)
    const a = raw.stores.filter((s: any) => s.url === 'https://a.example.com')
    const b = raw.stores.filter((s: any) => s.url === 'https://b.example.com')
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(b[0].scope_settings).toBeUndefined()
    expect(a[0].scope_settings?.['group:acme/team']?.covers).toEqual(['acme.team'])
  })

  it('a key computed before another process inserted a server entry for the same url rotates only the selected entry', () => {
    const p = write(ONE)
    const plur = new Plur({ path: dirname(p) })
    const loaded = loadConfig(p).stores ?? []
    const selected = loaded.find(s => s.scope === 'group:acme/team')!
    const onDisk = readRaw(p)
    onDisk.stores.unshift({ url: 'https://a.example.com', token: 't-other', scopes: ['group:acme/other'], enterprise: {} })
    writeFileSync(p, yaml.dump(onDisk))
    ;(plur as any).persistStores(loaded, { serverEntryToken: { entry: selected, token: 't-new' } })
    const raw = readRaw(p)
    expect(raw.stores.map((s: any) => [s.scopes, s.token])).toEqual([
      [['group:acme/other'], 't-other'],
      [['group:acme/team'], 't-new'],
    ])
  })
})

describe('server entry rotation — only the selected server entry', () => {
  const TWO_ON_ONE_URL = `stores:
  - url: https://plur.example.com
    token: t-one
    scopes: ["group:acme/a"]
    enterprise: {}
  - url: https://plur.example.com
    token_env: TWO_KEY
    scopes: ["group:acme/b"]
    enterprise: {}
`
  it('rotating a scope of the first entry leaves the second entry\'s token_env reference untouched', () => {
    process.env.TWO_KEY = 't-two'
    try {
      const p = write(TWO_ON_ONE_URL)
      const plur = new Plur({ path: dirname(p) })
      const r = plur.addStore('', 'group:acme/a', { url: 'https://plur.example.com', token: 't-new' })
      expect(r.status).toBe('token_rotated')
      expect(r.token_scopes).toEqual(['group:acme/a'])
      const raw = readRaw(p)
      expect(raw.stores).toHaveLength(2)
      expect(raw.stores[0].token).toBe('t-new')
      expect(raw.stores[1].token_env).toBe('TWO_KEY')
      expect(raw.stores[1]).not.toHaveProperty('token')
      const reloaded = loadConfig(p).stores ?? []
      expect(reloaded.map(s => [s.scope, s.token])).toEqual([['group:acme/a', 't-new'], ['group:acme/b', 't-two']])
    } finally {
      delete process.env.TWO_KEY
    }
  })

  it('a scope that two server entries on one url both list is refused and nothing changes', () => {
    const p = write(`stores:
  - url: https://plur.example.com
    token: t-one
    scopes: ["group:acme/a"]
    enterprise: {}
  - url: https://plur.example.com
    token: t-two
    scopes: ["group:acme/a", "group:acme/b"]
    enterprise: {}
`)
    const before = readFileSync(p, 'utf8')
    const plur = new Plur({ path: dirname(p) })
    expect(() => plur.addStore('', 'group:acme/a', { url: 'https://plur.example.com', token: 't-new' }))
      .toThrow(/more than one server entry/)
    expect(readFileSync(p, 'utf8')).toBe(before)
  })
})

describe('server entry collapse — sensitivity writeback rules inside scope_settings', () => {
  const FWD = `stores:
  - url: https://plur.example.com
    token: t
    scope: group:acme/compat
    sensitivity: { forbid: ["secrets", "future-top"], future_nested: 1 }
    scopes: ["group:acme/team", "group:acme/compat"]
    enterprise: {}
    scope_settings:
      group:acme/team: { sensitivity: { forbid: ["secrets", "future-category"], future_nested: kept } }
`
  it('an unrelated writeback keeps unknown forbid categories and nested keys in scope_settings', () => {
    const p = write(FWD)
    const plur = new Plur({ path: dirname(p) })
    unrelatedWrite(plur)
    const srv = readRaw(p).stores[0]
    expect(srv.scope_settings['group:acme/team'].sensitivity.forbid).toEqual(['secrets', 'future-category'])
    expect(srv.scope_settings['group:acme/team'].sensitivity.future_nested).toBe('kept')
  })

  it('an unrelated writeback keeps the compat scope\'s top-level sensitivity and adds no scope_settings for it', () => {
    const p = write(FWD)
    const plur = new Plur({ path: dirname(p) })
    unrelatedWrite(plur)
    const srv = readRaw(p).stores[0]
    expect(srv.sensitivity.forbid).toEqual(['secrets', 'future-top'])
    expect(srv.sensitivity.future_nested).toBe(1)
    expect(srv.scope_settings['group:acme/compat']).toBeUndefined()
  })

  it('an authoritative server update replaces forbid inside scope_settings', () => {
    const p = write(FWD)
    const plur = new Plur({ path: dirname(p) })
    const discovery: RemoteScopeDiscovery = {
      url: 'https://plur.example.com', ok: true,
      authorized: ['group:acme/team'], registered: ['group:acme/team'], unregistered: [],
      metadata: [{ scope: 'group:acme/team', sensitivity: { forbid: ['infra'] } } as any],
    }
    plur.persistScopeMetadata([discovery])
    const srv = readRaw(p).stores[0]
    expect(srv.scope_settings['group:acme/team'].sensitivity.forbid).toEqual(['infra'])
    const team = (loadConfig(p).stores ?? []).find(s => s.scope === 'group:acme/team')
    expect(team?.sensitivity?.forbid).toEqual(['infra'])
  })
})

describe('server entry collapse — compat scope top-level metadata', () => {
  const COMPAT = `stores:
  - url: https://plur.example.com
    token: t
    scope: group:acme/team
    dial: never
    description: Old
    scopes: []
    enterprise: {}
`
  it('an unrelated writeback keeps dial: never at the top level and it still applies after reload', () => {
    const p = write(COMPAT)
    const plur = new Plur({ path: dirname(p) })
    unrelatedWrite(plur)
    const srv = readRaw(p).stores[0]
    expect(srv.dial).toBe('never')
    expect(srv.scope_settings).toBeUndefined()
    expect((loadConfig(p).stores ?? []).find(s => s.scope === 'group:acme/team')?.dial).toBe('never')
  })

  it('a server update of the compat scope\'s description updates it where it is', () => {
    const p = write(COMPAT)
    const plur = new Plur({ path: dirname(p) })
    const discovery: RemoteScopeDiscovery = {
      url: 'https://plur.example.com', ok: true,
      authorized: ['group:acme/team'], registered: ['group:acme/team'], unregistered: [],
      metadata: [{ scope: 'group:acme/team', description: 'New' }],
    }
    plur.persistScopeMetadata([discovery])
    const srv = readRaw(p).stores[0]
    expect(srv.description).toBe('New')
    expect(srv.dial).toBe('never')
    expect((loadConfig(p).stores ?? []).find(s => s.scope === 'group:acme/team')?.description).toBe('New')
  })
})
