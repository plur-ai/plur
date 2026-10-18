/**
 * Formal-verification replays for the server store entry cluster
 * (spec/formal/PlurSpec/StoreEntry.lean, findings in spec/formal/findings/store-entry.md).
 *
 *   - Legacy top-level metadata of a server entry is checked with the same
 *     shape tolerance as scope_settings: a top-level `description:` left
 *     empty (YAML null) or a number must drop that field, never the whole
 *     config (and with it every store registration).
 *   - Round trip: an unrelated writeback leaves what a reload sees unchanged.
 *   - scope_settings / top-level metadata never set url, token, scope or readonly.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { loadConfig } from '../src/config.js'
import { Plur } from '../src/index.js'

const dirs: string[] = []
const write = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'plur-fse-'))
  dirs.push(dir)
  const p = join(dir, 'config.yaml')
  writeFileSync(p, `embeddings:\n  enabled: false\n${content}`)
  return p
}
const readRaw = (p: string): any => yaml.load(readFileSync(p, 'utf8'))
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

describe('legacy top-level metadata is shape-tolerant (never drops the whole config)', () => {
  for (const [label, value] of [['an empty value (null)', ''], ['a number', ' 5']] as const) {
    it(`a top-level description that is ${label} drops the field, not every store`, () => {
      const p = write(`stores:
  - path: /tmp/plur-fse-local.yaml
    scope: local:notes
  - url: https://plur.example.com
    token: t
    scope: group:acme/team
    dial: never
    description:${value}
    scopes: ["group:acme/team", "group:acme/other"]
    enterprise: {}
`)
      const stores = loadConfig(p).stores ?? []
      expect(stores.map(s => s.scope)).toEqual(['local:notes', 'group:acme/team', 'group:acme/other'])
      const team = stores.find(s => s.scope === 'group:acme/team')!
      expect(team.dial).toBe('never')
      expect(team.description).toBeUndefined()
    })
  }

  it('an unrelated store addition then keeps the local entry on disk', () => {
    const p = write(`stores:
  - path: /tmp/plur-fse-local.yaml
    scope: local:notes
  - url: https://plur.example.com
    token: t
    scope: group:acme/team
    description:
    scopes: ["group:acme/team"]
    enterprise: {}
`)
    const plur = new Plur({ path: dirname(p) })
    plur.addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })
    const raw = readRaw(p)
    expect(raw.stores.map((s: any) => s.scope)).toEqual(['local:notes', 'group:acme/team', 'group:other/x'])
  })
})

describe('round trip — an unrelated writeback does not change what a reload sees', () => {
  const RICH = `stores:
  - url: https://plur.example.com
    token: t
    scope: group:acme/compat
    dial: never
    covers: [a, b]
    sensitivity: { forbid: ["secrets", "future-top"], future_nested: 1 }
    future_top_key: keep
    scopes: ["group:acme/team", "group:acme/compat"]
    pinned_scopes: ["group:acme/pinned"]
    enterprise: { hello_engram_id: ENG-1 }
    discovery: { status: ok }
    scope_settings:
      group:acme/team: { description: Team, sensitivity: { forbid: ["infra", "future-category"] }, future: x }
      group:acme/compat: { covers: [c] }
`
  it('loadConfig before and after are equal, and the server entry keeps its fields', () => {
    const p = write(RICH)
    const before = loadConfig(p).stores ?? []
    const rawBefore = readRaw(p).stores[0]
    const plur = new Plur({ path: dirname(p) })
    plur.addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })
    const after = (loadConfig(p).stores ?? []).filter(s => s.scope !== 'group:other/x')
    expect(after).toEqual(before)
    const rawAfter = readRaw(p).stores[0]
    for (const k of ['url', 'token', 'scope', 'scopes', 'pinned_scopes', 'enterprise', 'discovery', 'dial', 'covers', 'future_top_key']) {
      expect(rawAfter[k]).toEqual(rawBefore[k])
    }
    expect(rawAfter.sensitivity.forbid).toEqual(['secrets', 'future-top'])
    expect(rawAfter.scope_settings['group:acme/team'].sensitivity.forbid).toEqual(['infra', 'future-category'])
    expect(rawAfter.scope_settings['group:acme/team'].future).toBe('x')
    // A second unrelated writeback is a fixed point on disk.
    const once = readFileSync(p, 'utf8')
    new Plur({ path: dirname(p) }).addStore('', 'group:other/x', { url: 'https://other.example.com', token: 'o' })
    expect(readFileSync(p, 'utf8')).toBe(once)
  })
})

describe('metadata never sets identity or credentials', () => {
  it('scope_settings and top-level keys named url/token/scope/readonly/path are ignored', () => {
    const p = write(`stores:
  - url: https://plur.example.com
    token: real
    readonly: true
    scope: group:acme/team
    scopes: ["group:acme/team"]
    enterprise: {}
    scope_settings:
      group:acme/team: { url: "https://evil.example.com", token: stolen, scope: "group:evil/x", readonly: false, path: /tmp/x, shared: false, token_env: EVIL }
`)
    const [team, ...rest] = loadConfig(p).stores ?? []
    expect(rest).toEqual([])
    expect(team).toMatchObject({ url: 'https://plur.example.com', token: 'real', scope: 'group:acme/team', readonly: true, shared: true })
    expect(team).not.toHaveProperty('path')
    expect(team).not.toHaveProperty('token_env')
  })
})
