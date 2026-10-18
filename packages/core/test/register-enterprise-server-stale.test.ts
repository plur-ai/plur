/**
 * registerEnterpriseServer and a stale entry holding the personal scope
 * (#1638, plan C Task 3; owner decision on B5: refuse, and the installer
 * offers to remove the stale entry).
 *
 * Registration refuses to take over another entry's personal-scope writes.
 * The refusal now names the entries that hold the scope (url origin or path,
 * the scope as they serve it, readonly) so `plur login` can name them, and
 * `removeStale: true` removes exactly those entries and registers in the same
 * locked write. Nothing in an error or the result carries a key.
 *
 * Refs plur-ai/plur#1638
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur, PersonalScopeTakenError, SignInHeldError } from '../src/index.js'
import { loadConfig } from '../src/config.js'
import { resolveScopeTarget } from '../src/store-resolver.js'

const URL_ = 'https://plur.example.com'
const ME = 'user:acme:alice'
let dir: string
let plur: Plur

const configPath = (): string => join(dir, 'config.yaml')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawConfig = (): any => yaml.load(readFileSync(configPath(), 'utf8'))
const seed = (content: string): void => { writeFileSync(configPath(), content); plur = new Plur({ path: dir }) }
const route = (scope: string): [string | undefined, string | undefined] => {
  const t = resolveScopeTarget(scope, loadConfig(configPath()).stores ?? [])
  return t.kind === 'remote' ? [t.entry.url, t.entry.token] : [t.kind, undefined]
}
const refusal = async (opts: { token: string; removeStale?: boolean }): Promise<PersonalScopeTakenError> => {
  const err = await plur.registerEnterpriseServer(URL_, { ...opts, personalScope: ME }).then(() => null, (e: Error) => e)
  expect(err).toBeInstanceOf(PersonalScopeTakenError)
  return err as PersonalScopeTakenError
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-register-stale-'))
  plur = new Plur({ path: dir })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('the refusal names the stale entry', () => {
  it('another server holding the personal scope: named by origin and scope, no key anywhere', async () => {
    // The server entry comes first, so it would outrank the other server's entry.
    seed(`stores:\n  - url: ${URL_}\n    token: k1-sekrit\n    scope: user:acme:bob\n    scopes: []\n  - url: https://b.example.com/sse\n    token: k0-sekrit\n    scope: ${ME}\n`)
    const err = await refusal({ token: 'k1-sekrit' })
    expect(err.message).toMatch(/already served by another entry/)
    expect(err.personalScope).toBe(ME)
    expect(err.holders).toEqual([{ url: 'https://b.example.com', scope: ME, readonly: false }])
    expect(err.removable).toBe(true)
    expect(JSON.stringify({ m: err.message, h: err.holders })).not.toMatch(/sekrit/)
  })

  it('a readonly entry on the same server with an old key', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k-old\n    readonly: true\n    scope: ${ME}\n`)
    const err = await refusal({ token: 'k-new' })
    expect(err.holders).toEqual([{ url: URL_, scope: ME, readonly: true }])
    expect(err.removable).toBe(true)
  })

  it('a case variant on another server is named with its own spelling', async () => {
    seed(`stores:\n  - url: https://b.example.com\n    token: k2\n    scope: user:acme:Alice\n`)
    const err = await refusal({ token: 'k1' })
    expect(err.holders).toEqual([{ url: 'https://b.example.com', scope: 'user:acme:Alice', readonly: false }])
  })

  it('a case variant that would fold into the server entry names the per-scope entry it comes from', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:Alice\n    dial: never\n`)
    const err = await refusal({ token: 'k1' })
    expect(err.holders).toEqual([{ url: URL_, scope: 'user:acme:Alice', readonly: false }])
    expect(err.removable).toBe(true)
  })

  it('a path entry serving the scope exactly is not named (it keeps the writes either way)', async () => {
    const p = join(dir, 'engrams.yaml')
    seed(`stores:\n  - path: ${p}\n    scope: ${ME}\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:bob\n    scopes: []\n  - url: https://b.example.com\n    token: k2\n    scope: ${ME}\n`)
    const err = await refusal({ token: 'k1' })
    expect(err.holders).toEqual([{ url: 'https://b.example.com', scope: ME, readonly: false }])
  })

  it('the old personal scope of this same server entry, in another case, cannot be removed for the caller', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:Alice\n    scopes: []\n`)
    const err = await refusal({ token: 'k1' })
    expect(err.holders).toEqual([{ url: URL_, scope: 'user:acme:Alice', readonly: false, sameServer: true }])
    expect(err.removable).toBe(false)
  })
})

describe('removeStale: remove the named entries and register, in one write', () => {
  it('removes the other server entry and registers; every other entry stays', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:bob\n    scopes: []\n  - url: https://b.example.com\n    token: k0\n    scope: ${ME}\n  - url: https://c.example.com\n    token: k3\n    scope: group:acme/team\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME, removeStale: true })
    expect(r.status).toBe('updated')
    expect(r.removed).toEqual([{ url: 'https://b.example.com', scope: ME, readonly: false }])
    const stores = rawConfig().stores
    expect(stores.map((e: { url: string }) => e.url)).toEqual([URL_, 'https://c.example.com'])
    expect(stores[1]).toEqual({ url: 'https://c.example.com', token: 'k3', scope: 'group:acme/team' })
    expect(route(ME)).toEqual([URL_, 'k1'])
    expect(route('user:acme:bob')).toEqual([URL_, 'k1'])
  })

  it('removes a folding case variant so it is not folded in', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:Alice\n    dial: never\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME, removeStale: true })
    expect(r.removed).toEqual([{ url: URL_, scope: 'user:acme:Alice', readonly: false }])
    expect(rawConfig().stores).toEqual([{ url: URL_, token: 'k1', scope: ME, enterprise: {}, scopes: [] }])
  })

  it('when the holder cannot be removed for the caller, it refuses and writes nothing', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:Alice\n    scopes: []\n`)
    const before = readFileSync(configPath(), 'utf8')
    const err = await refusal({ token: 'k1', removeStale: true })
    expect(err.removable).toBe(false)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it('with no conflict it is an ordinary registration that removes nothing', async () => {
    seed(`stores:\n  - url: https://c.example.com\n    token: k3\n    scope: group:acme/team\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME, removeStale: true })
    expect(r.status).toBe('added')
    expect(r.removed).toEqual([])
    expect(rawConfig().stores).toHaveLength(2)
  })

  it('without removeStale the result reports nothing removed', async () => {
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.removed).toEqual([])
  })
})

describe('gate review of #1665: a held sign-in, the backup under the lock', () => {
  it('keepSignIn: a sign-in config.yaml holds for the server is never replaced; nothing is written', async () => {
    for (const before of [
      `stores:\n  - url: ${URL_}\n    token: current-sekrit\n    scope: ${ME}\n    scopes: []\n`,
      `stores:\n  - url: ${URL_}/sse\n    token: current-sekrit\n    scope: group:acme/team\n`,
    ]) {
      seed(before)
      const err = await plur.registerEnterpriseServer(URL_, { token: 'legacy-sekrit', personalScope: ME, keepSignIn: true }).then(() => null, (e: Error) => e)
      expect(err).toBeInstanceOf(SignInHeldError)
      expect(err!.message).not.toMatch(/sekrit/)
      expect(readFileSync(configPath(), 'utf8')).toBe(before)
    }
  })

  it('beforeRemove runs under the lock on the file as it is then, only when entries are removed; a throw writes nothing', async () => {
    // The server entry comes first, so it would outrank the other server's entry: a holder.
    const before = `stores:\n  - url: ${URL_}\n    token: k1-sekrit\n    scope: user:acme:bob\n    scopes: []\n  - url: https://b.example.com/sse\n    token: k0-sekrit\n    scope: ${ME}\n`
    seed(before)
    const seen: string[] = []
    await plur.registerEnterpriseServer(URL_, { token: 'k1-sekrit', personalScope: ME, removeStale: true, beforeRemove: p => { seen.push(readFileSync(p, 'utf8')) } })
    expect(seen).toEqual([before])
    seed(before)
    const err = await plur.registerEnterpriseServer(URL_, { token: 'k1-sekrit', personalScope: ME, removeStale: true, beforeRemove: () => { throw new Error('no backup') } }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/backup/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
    // No removal → not called.
    seed('stores: []\n')
    const calls: string[] = []
    await plur.registerEnterpriseServer(URL_, { token: 'k1-sekrit', personalScope: ME, removeStale: true, beforeRemove: p => { calls.push(p) } })
    expect(calls).toEqual([])
  })

  it('YAML aliases: removeStale removes the holder at its own position, not the first copy of the same object', async () => {
    // The old entry appears twice through an alias: before the server entry (it keeps the
    // writes; not a holder) and after it (a holder). Only the holder position is removed.
    seed(`stores:\n  - &old\n    url: https://b.example.com/sse\n    token: k0-sekrit\n    scope: ${ME}\n  - url: ${URL_}\n    token: k1-sekrit\n    scope: user:acme:bob\n    scopes: []\n  - *old\n`)
    const err = await refusal({ token: 'k1-sekrit' })
    expect(err.removable).toBe(true)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1-sekrit', personalScope: ME, removeStale: true })
    expect(r.removed).toHaveLength(1)
    expect(rawConfig().stores.map((e: { url: string }) => e.url)).toEqual(['https://b.example.com/sse', URL_])
  })

  it('keepSignIn: an entry for the server with no key (no token, no token_env) is not a sign-in; registration goes ahead', async () => {
    seed(`stores:\n  - url: ${URL_}\n    scope: ${ME}\n    scopes: []\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'legacy-sekrit', personalScope: ME, keepSignIn: true })
    expect(r.status).toBe('updated')
    expect(rawConfig().stores[0].token).toBe('legacy-sekrit')
  })
})
