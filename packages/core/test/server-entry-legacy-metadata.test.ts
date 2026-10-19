/**
 * Server entry expansion keeps the legacy top-level metadata of its
 * compatibility scope (#1631).
 *
 * A per-scope entry written by an older client carries its metadata at the
 * top level (`dial`, `description`, `covers`, `sensitivity`, and any key a
 * newer client added). When the entry also gains a `scopes` list it is loaded
 * as a server entry. The top-level metadata still belongs to the compat
 * `scope` and must stay on that scope's in-memory entry; an explicit
 * `scope_settings[scope]` value takes precedence. Other scopes of the entry
 * never inherit it.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadConfig } from '../src/config.js'
import { Plur } from '../src/index.js'
import type { RemoteRecallHost } from '../src/remote-recall.js'

const dirs: string[] = []
const dirWith = (stores: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'plur-selm-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'config.yaml'), `embeddings:\n  enabled: false\nstores:\n${stores}`)
  return dir
}
const hostsOf = (plur: Plur, options?: Record<string, unknown>): RemoteRecallHost[] =>
  (plur as any)._remoteRecallHosts(options)

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('server entry — legacy top-level metadata of the compat scope', () => {
  it('dial: never on an entry that gained a scopes list still prevents remote requests', () => {
    const dir = dirWith(
      `  - url: https://plur.example.com\n    token: t1\n    scope: group:acme/team\n    scopes: []\n    dial: never\n`,
    )
    const team = (loadConfig(join(dir, 'config.yaml')).stores ?? []).find(s => s.scope === 'group:acme/team')
    expect(team?.dial).toBe('never')
    const plur = new Plur({ path: dir })
    expect(hostsOf(plur, { scope: 'project:acme/app' })).toHaveLength(0)
  })

  it('control: without dial: never the same entry is dialed from an org context', () => {
    const dir = dirWith(`  - url: https://plur.example.com\n    token: t1\n    scope: group:acme/team\n    scopes: []\n`)
    const plur = new Plur({ path: dir })
    expect(hostsOf(plur, { scope: 'project:acme/app' }).map(h => h.scopes)).toEqual([['group:acme/team']])
  })

  it('keeps description, covers, sensitivity and unknown per-scope keys on the compat scope only', () => {
    const dir = dirWith(`  - url: https://plur.example.com
    token: t1
    scope: group:acme/team
    scopes: ["group:acme/team", "group:acme/other"]
    description: Team-wide
    covers: ["acme.team"]
    sensitivity: { forbid: ["secrets"] }
    future_meta: kept
`)
    const stores = loadConfig(join(dir, 'config.yaml')).stores ?? []
    const team = stores.find(s => s.scope === 'group:acme/team') as Record<string, unknown> | undefined
    const other = stores.find(s => s.scope === 'group:acme/other') as Record<string, unknown> | undefined
    expect(team).toMatchObject({ description: 'Team-wide', covers: ['acme.team'], future_meta: 'kept' })
    expect((team?.sensitivity as { forbid?: string[] })?.forbid).toEqual(['secrets'])
    expect(other?.description).toBeUndefined()
    expect(other?.covers).toBeUndefined()
    expect(other?.sensitivity).toBeUndefined()
    expect(other?.future_meta).toBeUndefined()
  })

  it('explicit scope_settings for the compat scope take precedence over the top-level value', () => {
    const dir = dirWith(`  - url: https://plur.example.com
    token: t1
    scope: group:acme/team
    scopes: ["group:acme/team"]
    dial: never
    description: Old
    covers: ["acme.old"]
    scope_settings:
      group:acme/team: { dial: always, description: New }
`)
    const team = (loadConfig(join(dir, 'config.yaml')).stores ?? []).find(s => s.scope === 'group:acme/team')
    expect(team).toMatchObject({ dial: 'always', description: 'New', covers: ['acme.old'] })
  })

  it('top-level identity keys are never treated as metadata', () => {
    const dir = dirWith(`  - url: https://plur.example.com
    token: t1
    readonly: true
    scope: user:acme:alice
    scopes: ["group:acme/team"]
    enterprise: { hello_engram_id: ENG-1 }
`)
    const stores = loadConfig(join(dir, 'config.yaml')).stores ?? []
    expect(stores.map(s => [s.scope, s.shared, s.readonly])).toEqual([
      ['group:acme/team', true, true],
      ['user:acme:alice', false, true],
    ])
  })
})
