/**
 * Owner decision 17 (epic 1797; formal StoreEntry C3, RoutingDiscovery D4):
 * two server entries that differ only in their token share one stable
 * identity base, so a writeback cannot tell which of them a loaded entry came
 * from. The collapse writes NOTHING for such a base, as key rotation already
 * refuses one, instead of putting one entry's metadata on the other.
 * Model: spec/formal/PlurSpec/StoreEntry.lean §3 (`collapseAt`,
 * `ambiguous_writes_nothing`, `mistarget_impossible`).
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
  const dir = mkdtempSync(join(tmpdir(), 'plur-amb-'))
  dirs.push(dir)
  const p = join(dir, 'config.yaml')
  writeFileSync(p, `embeddings:\n  enabled: false\n${content}`)
  return p
}
const readRaw = (p: string): any => yaml.load(readFileSync(p, 'utf8'))
const withCovers = (p: string, scope: string, covers: string[]) =>
  (loadConfig(p).stores ?? []).map(s => s.scope === scope ? { ...s, covers } : s)

afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }) })

const ONE = `stores:
  - url: https://a.example.com
    token: t-a
    scopes: ["group:acme/team"]
    enterprise: {}
`

describe('collapse writes nothing for an identity two server entries share', () => {
  it('an entry with the same base inserted BEFORE ours after load: neither entry receives our metadata', () => {
    const p = write(ONE)
    const plur = new Plur({ path: dirname(p) })
    const stores = withCovers(p, 'group:acme/team', ['mine'])
    const onDisk = readRaw(p)
    onDisk.stores.unshift({ url: 'https://a.example.com', token: 't-other', scopes: ['group:acme/team'], enterprise: {} })
    writeFileSync(p, yaml.dump(onDisk))
    ;(plur as any).persistStores(stores)
    const raw = readRaw(p)
    expect(raw.stores.map((s: any) => [s.token, s.scope_settings ?? null])).toEqual([
      ['t-other', null],
      ['t-a', null],
    ])
  })

  it('two same-base entries already on disk at load: a metadata change writes to neither', () => {
    const p = write(`${ONE}  - url: https://a.example.com
    token: t-b
    scopes: ["group:acme/team"]
    enterprise: {}
`)
    const plur = new Plur({ path: dirname(p) })
    const stores = withCovers(p, 'group:acme/team', ['mine'])
    ;(plur as any).persistStores(stores)
    const raw = readRaw(p)
    expect(raw.stores.map((s: any) => [s.token, s.scope_settings ?? null])).toEqual([
      ['t-a', null],
      ['t-b', null],
    ])
  })

  it('loaded as two, one removed by another process before the writeback: the survivor is not written', () => {
    const p = write(`${ONE}  - url: https://a.example.com
    token: t-b
    scopes: ["group:acme/team"]
    enterprise: {}
`)
    const plur = new Plur({ path: dirname(p) })
    const stores = withCovers(p, 'group:acme/team', ['mine'])
    const onDisk = readRaw(p)
    onDisk.stores.shift()
    writeFileSync(p, yaml.dump(onDisk))
    ;(plur as any).persistStores(stores)
    const raw = readRaw(p)
    expect(raw.stores.map((s: any) => [s.token, s.scope_settings ?? null])).toEqual([['t-b', null]])
  })

  it('an unambiguous entry next to an ambiguous pair is still written (non-vacuity)', () => {
    const p = write(`${ONE}  - url: https://a.example.com
    token: t-b
    scopes: ["group:acme/team"]
    enterprise: {}
  - url: https://c.example.com
    token: t-c
    scopes: ["group:acme/c"]
    enterprise: {}
`)
    const plur = new Plur({ path: dirname(p) })
    const stores = (loadConfig(p).stores ?? []).map(s => ({ ...s, covers: ['mine'] }))
    ;(plur as any).persistStores(stores)
    const raw = readRaw(p)
    expect(raw.stores.map((s: any) => [s.token, s.scope_settings ?? null])).toEqual([
      ['t-a', null],
      ['t-b', null],
      ['t-c', { 'group:acme/c': { covers: ['mine'] } }],
    ])
  })

  it('a single entry is still written (the good case)', () => {
    const p = write(ONE)
    const plur = new Plur({ path: dirname(p) })
    ;(plur as any).persistStores(withCovers(p, 'group:acme/team', ['mine']))
    expect(readRaw(p).stores[0].scope_settings).toEqual({ 'group:acme/team': { covers: ['mine'] } })
  })
})
