/**
 * Plur.registerEnterpriseServer — one server entry per company server, with
 * the per-scope entries that hold the same key folded into it (#1631, plan B
 * Task 5).
 *
 * - A new entry gets its compat `scope` at registration from the personal
 *   scope the caller passes (owner decision O6: the caller already holds the
 *   /me answer; registration makes no network call), so it is never without one.
 * - A new key for the same server replaces the key in that one entry; every
 *   other field of it is kept, and no other entry's key changes.
 * - A per-scope entry on the same server (by canonical endpoint identity) whose
 *   token, token_env and readonly equal the server entry's is folded: its scope
 *   goes to `pinned_scopes`, its metadata to `scope_settings[scope]`. Any other
 *   one stays as it is and is reported in `kept_separate`.
 * - Nothing in the file, the result, an error or the log carries the key.
 *
 * Refs plur-ai/plur#1631
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { loadConfig } from '../src/config.js'
import { logger } from '../src/logger.js'
import { foldStoresIntoServerEntry } from '../src/server-discovery.js'
import { resolveScopeTarget } from '../src/store-resolver.js'

const URL_ = 'https://plur.example.com'
const ME = 'user:acme:alice'
let dir: string
let plur: Plur

const configPath = (): string => join(dir, 'config.yaml')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rawConfig = (): any => yaml.load(readFileSync(configPath(), 'utf8'))
const seed = (content: string): void => { writeFileSync(configPath(), content); plur = new Plur({ path: dir }) }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plur-register-'))
  plur = new Plur({ path: dir })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks() })

describe('registerEnterpriseServer — a new server entry', () => {
  it('adds one enterprise entry with its compat scope and an empty scopes list, without a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.status).toBe('added')
    expect(rawConfig().stores).toEqual([{ url: URL_, token: 'k1', scope: ME, enterprise: {}, scopes: [] }])
    expect(fetchSpy).not.toHaveBeenCalled()
    // Loaded, the entry serves its compat scope with the key.
    const stores = loadConfig(configPath()).stores ?? []
    expect(stores.map(s => [s.scope, s.url, s.token])).toEqual([[ME, URL_, 'k1']])
  })

  it('a key from a variable stores the reference, never the key', async () => {
    process.env.PLUR_TEST_REG_KEY = 'k-env'
    try {
      const r = await plur.registerEnterpriseServer(URL_, { token: 'k-env', tokenEnv: 'PLUR_TEST_REG_KEY', personalScope: ME })
      expect(r.status).toBe('added')
      expect(rawConfig().stores).toEqual([{ url: URL_, token_env: 'PLUR_TEST_REG_KEY', scope: ME, enterprise: {}, scopes: [] }])
      expect(readFileSync(configPath(), 'utf8')).not.toContain('k-env')
    } finally { delete process.env.PLUR_TEST_REG_KEY }
  })

  it('refuses without a personal scope, or with one that is not a personal scope, and writes nothing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(plur.registerEnterpriseServer(URL_, { token: 'k1' } as any)).rejects.toThrow(/personal scope/)
    await expect(plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: 'group:acme/team' })).rejects.toThrow(/personal scope/)
    await expect(plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: 'user:acme:al ice' })).rejects.toThrow(/personal scope/)
    expect(existsSync(configPath())).toBe(false)
  })

  it('refuses a missing key, a non-http(s) url and a url carrying credentials — and never echoes the key', async () => {
    await expect(plur.registerEnterpriseServer(URL_, { personalScope: ME })).rejects.toThrow(/key/)
    await expect(plur.registerEnterpriseServer('ftp://plur.example.com', { token: 'sekrit-1', personalScope: ME }))
      .rejects.toThrow(/http/)
    const err = await plur.registerEnterpriseServer('https://bob:sekrit-2@plur.example.com', { token: 'sekrit-1', personalScope: ME })
      .then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/user name or password/)
    expect(err?.message).not.toContain('sekrit')
    expect(existsSync(configPath())).toBe(false)
  })

  it('keeps every other top-level key of config.yaml', async () => {
    seed(`embeddings:\n  enabled: false\nauto_learn: true\n`)
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(rawConfig()).toMatchObject({ embeddings: { enabled: false }, auto_learn: true })
  })
})

describe('registerEnterpriseServer — folding per-scope entries', () => {
  it('folds a per-scope entry with the same key into pinned_scopes, keeping its covers', async () => {
    seed(`stores:\n  - url: https://plur.example.com/sse\n    token: k1\n    scope: group:acme/team\n    covers: [acme.team]\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.status).toBe('added')
    expect(r.fold.folded).toEqual([{ scope: 'group:acme/team' }])
    expect(r.fold.kept_separate).toEqual([])
    const s = rawConfig().stores
    expect(s).toHaveLength(1)
    expect(s[0].scope).toBe(ME)
    expect(s[0].pinned_scopes).toEqual(['group:acme/team'])
    expect(s[0].scope_settings['group:acme/team'].covers).toEqual(['acme.team'])
  })

  it('keeps an entry with a different token separate and says why', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k0\n    scope: group:acme/team\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.folded).toEqual([])
    expect(r.fold.kept_separate).toEqual([{ scope: 'group:acme/team', why: 'different-token' }])
    const s = rawConfig().stores
    expect(s).toHaveLength(2)
    expect(s.find((e: { scope: string }) => e.scope === 'group:acme/team')).toEqual({ url: URL_, token: 'k0', scope: 'group:acme/team' })
  })

  it('a different token_env or readonly also keeps the entry separate', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token_env: OTHER_KEY\n    scope: group:acme/a\n  - url: ${URL_}\n    token: k1\n    readonly: true\n    scope: group:acme/b\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.kept_separate).toEqual([
      { scope: 'group:acme/a', why: 'different-token-env' },
      { scope: 'group:acme/b', why: 'readonly-differs' },
    ])
    expect(rawConfig().stores).toHaveLength(3)
  })

  it('a per-scope entry on another server is neither folded nor listed', async () => {
    seed(`stores:\n  - url: https://other.example.com\n    token: k1\n    scope: group:acme/x\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold).toMatchObject({ folded: [], kept_separate: [] })
    expect(rawConfig().stores[0]).toEqual({ url: 'https://other.example.com', token: 'k1', scope: 'group:acme/x' })
  })

  it('preserves the legacy metadata (dial, description, sensitivity, unknown keys) in scope_settings and keeps token_env references', async () => {
    process.env.PLUR_TEST_REG_KEY = 'k-env'
    try {
      seed(`stores:\n  - url: ${URL_}/\n    token_env: PLUR_TEST_REG_KEY\n    scope: group:acme/team\n    shared: true\n    readonly: false\n` +
        `    dial: never\n    description: Team notes\n    sensitivity:\n      forbid: [secrets]\n      future_key: 7\n    x_newer: kept\n`)
      const r = await plur.registerEnterpriseServer(URL_, { token: 'k-env', tokenEnv: 'PLUR_TEST_REG_KEY', personalScope: ME })
      expect(r.fold.folded).toEqual([{ scope: 'group:acme/team' }])
      const [e] = rawConfig().stores
      expect(e.token_env).toBe('PLUR_TEST_REG_KEY')
      expect('token' in e).toBe(false)
      expect(e.scope_settings['group:acme/team']).toEqual({
        dial: 'never', description: 'Team notes', sensitivity: { forbid: ['secrets'], future_key: 7 }, x_newer: 'kept',
      })
      expect(readFileSync(configPath(), 'utf8')).not.toContain('k-env')
      // Loaded, the folded scope has its metadata and the same key and url.
      const team = (loadConfig(configPath()).stores ?? []).find(s => s.scope === 'group:acme/team')!
      expect(team).toMatchObject({ url: URL_, token: 'k-env', readonly: false, dial: 'never', description: 'Team notes' })
    } finally { delete process.env.PLUR_TEST_REG_KEY }
  })

  it('never drops a scope: every scope served before is served after, with the same key and url', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/a\n  - url: ${URL_}/sse\n    token: k1\n    scope: project:acme/b\n` +
      `  - url: ${URL_}\n    token: k0\n    scope: group:acme/c\n  - path: ${join(dir, 'local.yaml')}\n    scope: project:mine\n`)
    const before = (loadConfig(configPath()).stores ?? []).map(s => s.scope).sort()
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    const after = loadConfig(configPath()).stores ?? []
    expect(after.map(s => s.scope).sort()).toEqual([...before, ME].sort())
    const tok = Object.fromEntries(after.map(s => [s.scope, s.token]))
    expect(tok).toMatchObject({ 'group:acme/a': 'k1', 'project:acme/b': 'k1', 'group:acme/c': 'k0', [ME]: 'k1' })
  })

  it('the new entry goes at the end: it never moves ahead of an entry already there (gate review)', async () => {
    seed(`stores:\n  - url: https://other.example.com\n    token: z\n    scope: group:o/x\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/a\n` +
      `  - url: https://third.example.com\n    token: z\n    scope: group:t/y\n`)
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(rawConfig().stores.map((e: { url: string }) => e.url)).toEqual(['https://other.example.com', 'https://third.example.com', URL_])
  })

  it('reports queued saves per scope of the server entry after the fold', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/team\n`)
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams: [{
      id: 'ENG-2026-10-18-001', statement: 'queued', type: 'behavioral', scope: 'group:acme/team', status: 'active', visibility: 'public',
      structured_data: { _outbox: { target_scope: 'group:acme/team', queued_at: new Date().toISOString(), attempt_count: 1 } },
    }] }))
    plur = new Plur({ path: dir })
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.queued_by_scope).toEqual({ 'group:acme/team': 1 })
  })
})

describe('registerEnterpriseServer — re-running', () => {
  it('same url and token twice → unchanged, file byte-identical', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/team\n`)
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME, enterprise: { device_name: 'laptop' } })
    const before = readFileSync(configPath(), 'utf8')
    const r = await plur.registerEnterpriseServer(`${URL_}/`, { token: 'k1', personalScope: ME, enterprise: { device_name: 'laptop' } })
    expect(r.status).toBe('unchanged')
    expect(r.fold).toMatchObject({ folded: [], kept_separate: [] })
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it('a new token for the same server → updated in the same entry, old token gone, everything else kept, still one entry', async () => {
    seed(`stores:\n  - url: https://other.example.com\n    token: k-other\n    scope: group:o/x\n` +
      `  - url: ${URL_}\n    token: k-old\n    scope: ${ME}\n    scopes: [${ME}, project:acme/api]\n    pinned_scopes: [group:acme/team]\n` +
      `    scope_settings:\n      group:acme/team:\n        dial: never\n    discovery:\n      status: ok\n      org_id: acme\n` +
      `    enterprise:\n      hello_engram_id: ENG-1\n    x_unknown: 1\n` +
      `  - url: ${URL_}\n    token: k-old\n    scope: group:acme/legacy\n`)
    const logs: string[] = []
    for (const lvl of ['info', 'warning', 'error', 'debug'] as const) {
      vi.spyOn(logger, lvl).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")) })
    }
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k-new', personalScope: ME })
    expect(r.status).toBe('updated')
    const s = rawConfig().stores
    expect(s).toHaveLength(3)
    expect(s[1]).toEqual({
      url: URL_, token: 'k-new', scope: ME, scopes: [ME, 'project:acme/api'], pinned_scopes: ['group:acme/team'],
      scope_settings: { 'group:acme/team': { dial: 'never' } }, discovery: { status: 'ok', org_id: 'acme' },
      enterprise: { hello_engram_id: 'ENG-1' }, x_unknown: 1,
    })
    // Only the selected entry's key changed: the other server and the
    // per-scope entry that holds the old key keep theirs.
    expect(s[0].token).toBe('k-other')
    expect(s[2]).toEqual({ url: URL_, token: 'k-old', scope: 'group:acme/legacy' })
    expect(r.fold.kept_separate).toEqual([{ scope: 'group:acme/legacy', why: 'different-token' }])
    expect(readFileSync(configPath(), 'utf8')).not.toContain('k-old\n    scope: user')
    expect(JSON.stringify(r)).not.toMatch(/k-new|k-old/)
    expect(logs.join('\n')).not.toMatch(/k-new|k-old/)
  })

  it('a key from a variable replaces an inline key (and the inline key leaves the file)', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k-old\n    scope: ${ME}\n    enterprise: {}\n    scopes: []\n`)
    const r = await plur.registerEnterpriseServer(URL_, { tokenEnv: 'PLUR_TEST_REG_KEY2', personalScope: ME })
    expect(r.status).toBe('updated')
    expect(rawConfig().stores).toEqual([{ url: URL_, token_env: 'PLUR_TEST_REG_KEY2', scope: ME, enterprise: {}, scopes: [] }])
  })

  it('opts.enterprise merges hello_engram_id into the block, other keys kept', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n    enterprise:\n      device_name: laptop\n    scopes: []\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME, enterprise: { hello_engram_id: 'ENG-2' } })
    expect(r.status).toBe('updated')
    expect(rawConfig().stores[0].enterprise).toEqual({ device_name: 'laptop', hello_engram_id: 'ENG-2' })
  })

  it('a server entry without a compat scope gets one; an existing bare server entry gains the enterprise block', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scopes: [project:acme/api]\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.status).toBe('updated')
    expect(rawConfig().stores).toEqual([{ url: URL_, token: 'k1', scopes: ['project:acme/api'], scope: ME, enterprise: {} }])
  })

  it("a different personal scope becomes the compat scope; the old one's top-level metadata moves to its scope_settings", async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/team\n    dial: never\n    enterprise: {}\n    scopes: [group:acme/team]\n`)
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    const [e] = rawConfig().stores
    expect(e.scope).toBe(ME)
    expect('dial' in e).toBe(false)
    expect(e.scope_settings['group:acme/team']).toEqual({ dial: 'never' })
  })

  it('two server entries on the same server are refused: nothing written, the key is not echoed', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k-a\n    scopes: [group:acme/a]\n  - url: ${URL_}/sse\n    token: k-b\n    scopes: [group:acme/b]\n`)
    const before = readFileSync(configPath(), 'utf8')
    const err = await plur.registerEnterpriseServer(URL_, { token: 'k-new', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/more than one server entry/)
    expect(err?.message).not.toMatch(/k-new|k-a|k-b/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it('in memory, the next routing sees the new key without a restart', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k-old\n    scope: ${ME}\n    enterprise: {}\n    scopes: [project:acme/api]\n`)
    await plur.registerEnterpriseServer(URL_, { token: 'k-new', personalScope: ME })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mem = ((plur as any).config.stores as Array<{ scope: string; token?: string }>)
    expect(mem.map(s => [s.scope, s.token])).toEqual([['project:acme/api', 'k-new'], [ME, 'k-new']])
  })
})

describe('foldStoresIntoServerEntry — pure', () => {
  it('folds into the one server entry; a scope already pinned is not repeated', () => {
    const raw = [
      { url: URL_, token: 'k1', scope: ME, enterprise: {}, scopes: [], pinned_scopes: ['group:acme/a'] },
      { url: `${URL_}/sse`, token: 'k1', scope: 'group:acme/a', description: 'A' },
    ]
    const { stores, report } = foldStoresIntoServerEntry(raw, URL_, 'k1', undefined)
    expect(report).toEqual({ folded: [{ scope: 'group:acme/a' }], kept_separate: [] })
    expect(stores).toEqual([{ url: URL_, token: 'k1', scope: ME, enterprise: {}, scopes: [], pinned_scopes: ['group:acme/a'], scope_settings: { 'group:acme/a': { description: 'A' } } }])
    expect(raw).toHaveLength(2)  // input untouched
  })

  it("an entry whose metadata differs from the server entry's scope_settings for the scope is kept separate (Codex audit round 1)", () => {
    const raw = [
      { url: URL_, token: 'k1', scope: ME, enterprise: {}, scopes: [], scope_settings: { 'group:acme/a': { dial: 'auto', covers: ['x'] } } },
      { url: URL_, token: 'k1', scope: 'group:acme/a', dial: 'never' },
    ]
    const { stores, report } = foldStoresIntoServerEntry(raw, URL_, 'k1', undefined)
    expect(report.kept_separate).toEqual([{ scope: 'group:acme/a', why: 'metadata-differs' }])
    expect(stores).toEqual(raw)
  })

  it('an entry whose metadata equals the server entry settings for the scope folds, and the settings stay', () => {
    const raw = [
      { url: URL_, token: 'k1', scope: ME, enterprise: {}, scopes: [], scope_settings: { 'group:acme/a': { dial: 'never' } } },
      { url: URL_, token: 'k1', scope: 'group:acme/a', dial: 'never' },
    ]
    const { stores, report } = foldStoresIntoServerEntry(raw, URL_, 'k1', undefined)
    expect(report.folded).toEqual([{ scope: 'group:acme/a' }])
    expect((stores[0] as { scope_settings: unknown }).scope_settings).toEqual({ 'group:acme/a': { dial: 'never' } })
  })

  it('a path entry, a scope that fails the grammar, or an explicit shared flag the scope does not have is not folded', () => {
    const raw = [
      { url: URL_, token: 'k1', scope: ME, enterprise: {}, scopes: [] },
      { url: URL_, path: '/x.yaml', token: 'k1', scope: 'group:acme/p' },
      { url: URL_, token: 'k1', scope: 'group:acme/bad scope' },
      { url: URL_, token: 'k1', scope: 'group:acme/s', shared: false },
    ]
    const { stores, report } = foldStoresIntoServerEntry(raw, URL_, 'k1', undefined)
    expect(stores).toHaveLength(4)
    expect(report.folded).toEqual([])
    expect(report.kept_separate).toEqual([
      { scope: 'group:acme/bad scope', why: 'invalid-scope' },
      { scope: 'group:acme/s', why: 'shared-differs' },
    ])
  })
})

describe('registerEnterpriseServer — the route a write takes never moves (gate review)', () => {
  const route = (scope: string): [string | undefined, string | undefined] => {
    const t = resolveScopeTarget(scope, loadConfig(configPath()).stores ?? [])
    return t.kind === 'remote' ? [t.entry.url, t.entry.token] : [t.kind, undefined]
  }

  it('a per-scope entry is not folded while another entry with another key serves the same scope ahead of the server entry', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n    enterprise: {}\n    scopes: []\n` +
      `  - url: ${URL_}\n    token: k0\n    scope: group:acme/team\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/team\n`)
    const before = route('group:acme/team')
    expect(before[1]).toBe('k0')
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(route('group:acme/team')).toEqual(before)
    expect(r.fold.folded).toEqual([])
  })

  it('folding never moves the server entry ahead of an entry that serves one of its scopes with another key', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/other\n` +
      `  - url: ${URL_}\n    token: k0\n    scope: project:acme/api\n` +
      `  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n    enterprise: {}\n    scopes: [project:acme/api]\n`)
    const before = route('project:acme/api')
    expect(before[1]).toBe('k0')
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.folded).toEqual([{ scope: 'group:acme/other' }])
    expect(route('project:acme/api')).toEqual(before)
    expect(route('group:acme/other')[1]).toBe('k1')
  })

  it('a personal scope another server also serves is not folded, so its writes keep their server', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:bob\n  - url: https://other.example.com\n    token: z\n    scope: user:acme:bob\n`)
    const before = route('user:acme:bob')
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(route('user:acme:bob')).toEqual(before)
  })

  it('an unreadable config.yaml is refused without echoing a key it holds', async () => {
    writeFileSync(configPath(), `stores:\n  - url: ${URL_}\n    token: sekrit-on-disk\n   scope: : bad\n`)
    const err = await plur.registerEnterpriseServer(URL_, { token: 'sekrit-new', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err).not.toBeNull()
    expect(err!.message).not.toMatch(/sekrit/)
    expect(String(err!.stack)).not.toMatch(/sekrit/)
  })
})

describe('registerEnterpriseServer — Codex audit round 1', () => {
  const route = (scope: string): [string | undefined, string | undefined] => {
    const t = resolveScopeTarget(scope, loadConfig(configPath()).stores ?? [])
    return t.kind === 'remote' ? [t.entry.url, t.entry.token] : [t.kind, undefined]
  }

  it('a new personal scope keeps the old compat scope served by the entry (pinned), so its writes keep their key', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/old\n    scopes: []\n  - url: ${URL_}\n    token: k-other\n    scope: group:acme/old\n`)
    const before = route('group:acme/old')
    expect(before[1]).toBe('k1')
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(route('group:acme/old')).toEqual(before)
    expect(rawConfig().stores[0].pinned_scopes).toEqual(['group:acme/old'])
  })

  it('two same-key entries for one scope with different metadata are not folded, so the active policy stays', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/team\n    sensitivity:\n      forbid: [infra]\n      allow: []\n` +
      `  - url: ${URL_}\n    token: k1\n    scope: group:acme/team\n    sensitivity:\n      forbid: [infra]\n      allow: [infra]\n`)
    const before = plur.getScopeMetadata('group:acme/team')
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.folded).toEqual([])
    expect(plur.getScopeMetadata('group:acme/team')).toEqual(before)
  })

  it("a per-scope entry whose metadata differs from the server entry's settings for that scope is not folded", async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n    enterprise: {}\n    scopes: [group:acme/team]\n` +
      `    scope_settings:\n      group:acme/team:\n        sensitivity:\n          forbid: [infra]\n` +
      `  - url: ${URL_}\n    token: k1\n    scope: group:acme/team\n    sensitivity:\n      forbid: []\n`)
    const before = plur.getScopeMetadata('group:acme/team')
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.kept_separate).toEqual([{ scope: 'group:acme/team', why: 'metadata-differs' }])
    expect(plur.getScopeMetadata('group:acme/team')).toEqual(before)
  })

  it('a YAML error never quotes text from config.yaml (alias and tag names included)', async () => {
    for (const bad of [`stores:\n  - token: *sekrit-alias\n`, `stores:\n  - token: !sekrit-tag x\n`]) {
      writeFileSync(configPath(), bad)
      const err = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME }).then(() => null, (e: Error) => e)
      expect(err).not.toBeNull()
      expect(err!.message).not.toMatch(/sekrit/)
      expect(String(err!.stack)).not.toMatch(/sekrit/)
    }
  })
})

describe('registerEnterpriseServer — Codex audit round 2', () => {
  const route = (scope: string): [string | undefined, string | undefined] => {
    const t = resolveScopeTarget(scope, loadConfig(configPath()).stores ?? [])
    return t.kind === 'remote' ? [t.entry.url, t.entry.token] : [t.kind, undefined]
  }

  it('refuses to claim a personal scope another entry already serves (another server), writing nothing', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:bob\n    scopes: []\n  - url: https://b.example.com\n    token: k0\n    scope: ${ME}\n`)
    const before = readFileSync(configPath(), 'utf8')
    const err = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/already served by another entry/)
    expect(err?.message).not.toMatch(/k0|k1/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
    expect(route(ME)).toEqual(['https://b.example.com', 'k0'])
  })

  it('refuses a new writable entry that would outrank a readonly entry serving its personal scope with another key', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k-old\n    readonly: true\n    scope: ${ME}\n`)
    const err = await plur.registerEnterpriseServer(URL_, { token: 'k-new', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/already served by another entry/)
    expect(err?.message).not.toMatch(/k-old|k-new/)
  })

  it('a new entry behind an entry that keeps serving its personal scope is allowed: that route does not move', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k-old\n    scope: ${ME}\n`)
    const before = route(ME)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k-new', personalScope: ME })
    expect(r.fold.kept_separate).toEqual([{ scope: ME, why: 'different-token' }])
    expect(route(ME)).toEqual(before)
  })

  it('a personal scope served only by an entry that folds is not a conflict', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.folded).toEqual([{ scope: ME }])
    expect(rawConfig().stores).toHaveLength(1)
  })

  it('a __proto__ scope is never folded, so its metadata is not lost', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: __proto__\n    dial: never\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.kept_separate).toEqual([{ scope: '__proto__', why: 'invalid-scope' }])
    expect(rawConfig().stores[0]).toEqual({ url: URL_, token: 'k1', scope: '__proto__', dial: 'never' })
  })
})

describe('registerEnterpriseServer — Codex audit round 3', () => {
  it('a path entry runtime ignores does not hide a personal-scope takeover: refused', async () => {
    seed(`stores:\n  - path: ${join(dir, 'engrams.yaml')}\n    scope: ${ME}\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:bob\n    scopes: []\n` +
      `  - url: https://b.example.com\n    token: k2\n    scope: ${ME}\n`)
    const before = readFileSync(configPath(), 'utf8')
    const err = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/already served by another entry/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it('a personal scope served only in another letter case is not taken over', async () => {
    seed(`stores:\n  - url: https://b.example.com\n    token: k2\n    scope: user:acme:Alice\n`)
    const err = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/already served by another entry/)
  })

  it('a server entry that does not load is refused, so no working entry is folded into it', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n    scopes: []\n    readonly: "false"\n  - url: ${URL_}\n    token: k1\n    scope: group:acme/team\n`)
    const before = readFileSync(configPath(), 'utf8')
    const err = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/not valid/)
    expect(err?.message).not.toMatch(/k1/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it.skipIf(process.platform === 'win32')('a config.yaml readable by others is made owner-only before the key is written', async () => {
    seed(`auto_learn: true\n`)
    chmodSync(configPath(), 0o644)
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(statSync(configPath()).mode & 0o777).toBe(0o600)
  })

  it('queued_by_scope counts a scope named like an Object property as a number', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: constructor\n`)
    writeFileSync(join(dir, 'engrams.yaml'), yaml.dump({ engrams: [{
      id: 'ENG-2026-10-18-002', statement: 'queued', type: 'behavioral', scope: 'constructor', status: 'active', visibility: 'public',
      structured_data: { _outbox: { target_scope: 'constructor', queued_at: new Date().toISOString(), attempt_count: 1 } },
    }] }))
    plur = new Plur({ path: dir })
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.queued_by_scope.constructor).toBe(1)
  })
})

describe('registerEnterpriseServer — Codex audit round 4', () => {
  it('an entry that did not load is not "already serving" its scope: a takeover is refused', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: 123\n    scope: ${ME}\n    scopes: []\n  - url: https://b.example.com\n    token: key-b\n    scope: ${ME}\n`)
    const before = readFileSync(configPath(), 'utf8')
    const err = await plur.registerEnterpriseServer(URL_, { token: 'key-a', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/already served by another entry/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it.skipIf(process.platform === 'win32')('the owner-only step runs under the config lock, right before the write', async () => {
    seed(`auto_learn: true\n`)
    chmodSync(configPath(), 0o644)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = plur as any
    const orig = p._updateRawStores.bind(p)
    p._updateRawStores = (mutate: (s: unknown[]) => boolean) => {
      chmodSync(configPath(), 0o644)   // another writer widened it after any earlier check
      return orig(mutate)
    }
    await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(statSync(configPath()).mode & 0o777).toBe(0o600)
  })

  it('an existing server entry whose url carries a user name or password is refused, and nothing echoes it', async () => {
    seed(`stores:\n  - url: https://u:old-sekrit@plur.example.com\n    token: old-sekrit\n    scope: ${ME}\n    scopes: []\n`)
    const before = readFileSync(configPath(), 'utf8')
    const logs: string[] = []
    for (const lvl of ['info', 'warning', 'error', 'debug'] as const) {
      vi.spyOn(logger, lvl).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    }
    const err = await plur.registerEnterpriseServer(URL_, { tokenEnv: 'PLUR_TEST_UNSET_VAR', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/user name or password/)
    expect(err?.message).not.toMatch(/sekrit/)
    expect(logs.join('\n')).not.toMatch(/sekrit/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it('the unset token_env warning names the url without its user name or password', () => {
    writeFileSync(configPath(), `stores:\n  - url: https://u:old-sekrit@plur.example.com\n    token_env: PLUR_TEST_UNSET_VAR\n    scope: group:acme/x\n`)
    const logs: string[] = []
    vi.spyOn(logger, 'warning').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    loadConfig(configPath())
    expect(logs.join('\n')).toMatch(/PLUR_TEST_UNSET_VAR/)
    expect(logs.join('\n')).not.toMatch(/sekrit/)
  })
})

describe('registerEnterpriseServer — Codex audit round 5', () => {
  it('a per-scope entry the loader rejects is never folded, so its scope does not start going to the server', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: project:acme/private\n    readonly: "true"\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.kept_separate).toEqual([{ scope: 'project:acme/private', why: 'invalid-entry' }])
    expect(resolveScopeTarget('project:acme/private', loadConfig(configPath()).stores ?? []).kind).toBe('local')
  })

  it('an entry whose dial differs from the server entry serving the scope (absent counts) is not folded', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n    scopes: []\n  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n    dial: never\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.kept_separate).toEqual([{ scope: ME, why: 'metadata-differs' }])
    expect(rawConfig().stores).toHaveLength(2)
  })

  it('an unreadable outbox fails the registration before anything is written', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: old-key\n    scope: ${ME}\n    scopes: []\n`)
    const before = readFileSync(configPath(), 'utf8')
    vi.spyOn(plur, 'listOutbox').mockRejectedValue(new Error('engrams.yaml unreadable'))
    await expect(plur.registerEnterpriseServer(URL_, { token: 'new-key', personalScope: ME })).rejects.toThrow(/unreadable/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })
})

describe('registerEnterpriseServer — Codex audit round 6', () => {
  it('a personal scope served in another letter case (dial: never) is not taken over by folding it in', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:Alice\n    dial: never\n`)
    const before = readFileSync(configPath(), 'utf8')
    const err = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME }).then(() => null, (e: Error) => e)
    expect(err?.message).toMatch(/already served by another entry/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })
})

describe('registerEnterpriseServer — Codex audit round 7', () => {
  it('a personal scope in another letter case is not folded into a server entry that serves the scope', async () => {
    seed(`stores:\n  - url: ${URL_}\n    token: k1\n    scope: user:acme:Alice\n    dial: never\n` +
      `  - url: ${URL_}\n    token: k1\n    scope: ${ME}\n    enterprise: {}\n    scopes: [${ME}]\n`)
    const r = await plur.registerEnterpriseServer(URL_, { token: 'k1', personalScope: ME })
    expect(r.fold.kept_separate).toEqual([{ scope: 'user:acme:Alice', why: 'scope-served-elsewhere' }])
    expect(r.status).toBe('unchanged')
  })

  it('two folding entries for one personal scope in different letter cases are both kept', () => {
    const raw = [
      { url: URL_, token: 'k1', scope: ME, enterprise: {}, scopes: [] },
      { url: URL_, token: 'k1', scope: 'user:acme:Bob' },
      { url: URL_, token: 'k1', scope: 'user:acme:bob' },
    ]
    const { report } = foldStoresIntoServerEntry(raw, URL_, 'k1', undefined)
    expect(report.folded).toEqual([])
  })
})
