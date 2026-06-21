/**
 * PR-3 (#353 audit, HIGH-17/18) — config robustness / data-loss prevention.
 *
 * Two distinct losses are closed here:
 *
 *  (a) READ-DROP: a bad `forbid` category (a hand-edited / forward-compat
 *      category like `pii`) used to fail StoreEntry safeParse, so loadConfig
 *      dropped the WHOLE entry — including its `url`/`token`. The
 *      ScopeSensitivitySchema.forbid preprocess now drops only the unknown
 *      category and keeps the entry. (scope-metadata.ts)
 *
 *  (b) WRITEBACK-STRIP: persistStores wrote typed StoreEntry[] over the raw
 *      YAML, stripping unknown/future fields — both TOP-LEVEL and NESTED inside
 *      `sensitivity`. `.passthrough()` on BOTH StoreEntrySchema and
 *      ScopeSensitivitySchema + a merge in persistStores (with an explicit
 *      one-level `sensitivity` deep-merge) preserve them. (config.ts schema +
 *      index.ts persistStores)
 *
 * NOTE (chain-of-custody): loadConfig already pushes the RAW entry on a
 * successful per-entry safeParse, so top-level unknowns survive the READ path
 * for entries that pass. The TOP-LEVEL round-trip test below is therefore
 * driven through persistStores (via addStore token rotation) so it is
 * NON-VACUOUS — it proves the WRITEBACK path, not merely the read path.
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { loadConfig } from '../src/config.js'
import { StoreEntrySchema } from '../src/schemas/config.js'

describe('PR-3 config robustness — bad forbid category (read-drop fix)', () => {
  const dirs: string[] = []
  const mkdir = (): string => { const d = mkdtempSync(join(tmpdir(), 'plur-pr3-')); dirs.push(d); return d }
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); vi.restoreAllMocks() })

  /** Write a config.yaml with the given raw stores array and return its path. */
  const writeConfig = (dir: string, stores: unknown[]): string => {
    const p = join(dir, 'config.yaml')
    writeFileSync(p, yaml.dump({ index: false, stores }, { noRefs: true }))
    return p
  }

  it('a bad forbid category does NOT drop the entry — url/token survive, forbid → safe default, scope named', () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const p = writeConfig(dir, [
      {
        url: 'https://enterprise.example.com',
        token: 'secret-token-123',
        scope: 'group:eng',
        shared: true,
        // hand-edited / forward-compat category the schema doesn't know
        sensitivity: { forbid: ['pii'] },
      },
    ])

    const cfg = loadConfig(p)
    // Entry preserved — NOT dropped.
    expect(cfg.stores).toHaveLength(1)
    const entry = cfg.stores![0]
    expect(entry.url).toBe('https://enterprise.example.com')
    expect(entry.token).toBe('secret-token-123')   // the data-loss target — intact
    expect(entry.scope).toBe('group:eng')
    // bad-only forbid falls to the safe default.
    expect(entry.sensitivity?.forbid).toEqual(['secrets', 'infra'])

    // One warning names the bad value `pii`; a second names the scope.
    const msgs = warn.mock.calls.map(c => c.join(' '))
    expect(msgs.some(m => /pii/.test(m) && /unknown sensitivity categor/.test(m))).toBe(true)
    expect(msgs.some(m => /scope=group:eng/.test(m) && /pii/.test(m))).toBe(true)
  })

  it('partial-bad forbid keeps the VALID subset (not the whole-array default)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const p = writeConfig(dir, [
      { path: '/tmp/eng.yaml', scope: 'group:eng', sensitivity: { forbid: ['secrets', 'pii'] } },
    ])
    const cfg = loadConfig(p)
    expect(cfg.stores).toHaveLength(1)
    expect(cfg.stores![0].sensitivity?.forbid).toEqual(['secrets']) // pii dropped, secrets kept
  })

  it('a scalar (non-array) forbid → safe default, no Zod throw, entry not dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const p = writeConfig(dir, [
      // hand-edited scalar instead of an array
      { url: 'https://e.example.com', token: 't', scope: 'group:eng', sensitivity: { forbid: 'secrets' } },
    ])
    const cfg = loadConfig(p)
    expect(cfg.stores).toHaveLength(1)
    expect(cfg.stores![0].token).toBe('t')
    expect(cfg.stores![0].sensitivity?.forbid).toEqual(['secrets', 'infra'])
  })

  // R2-D (#7): PR-3 only rescued a bad `forbid` CATEGORY. A malformed ENCLOSING
  // shape — a scalar `sensitivity`, a non-array `allow`, or a non-array `covers`
  // — used to fail the whole StoreEntry safeParse and drop the entry incl.
  // url/token, reproducing the exact credential-loss bug PR-3 claimed to close.
  // These three cases must now survive the read with url/token intact.
  it('a scalar `sensitivity` (not an object) survives — entry kept, url/token intact, field dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const p = writeConfig(dir, [
      { url: 'https://e.example.com', token: 'tok-keep', scope: 'group:eng', shared: true, sensitivity: 'oops' },
    ])
    const cfg = loadConfig(p)
    expect(cfg.stores).toHaveLength(1)              // NOT dropped
    expect(cfg.stores![0].url).toBe('https://e.example.com')
    expect(cfg.stores![0].token).toBe('tok-keep')  // the data-loss target — intact
    expect(cfg.stores![0].scope).toBe('group:eng')
    expect(cfg.stores![0].sensitivity).toBeUndefined() // malformed shape coerced away
  })

  it('a non-array `allow` survives — entry kept, url/token intact, allow → []', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const p = writeConfig(dir, [
      { url: 'https://e.example.com', token: 'tok-keep', scope: 'group:eng', sensitivity: { forbid: ['secrets'], allow: 'infra' } },
    ])
    const cfg = loadConfig(p)
    expect(cfg.stores).toHaveLength(1)
    expect(cfg.stores![0].token).toBe('tok-keep')
    expect(cfg.stores![0].sensitivity?.forbid).toEqual(['secrets'])
    expect(cfg.stores![0].sensitivity?.allow).toEqual([]) // scalar coerced to []
  })

  it('a non-array `covers` survives — entry kept, url/token intact, covers dropped', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const p = writeConfig(dir, [
      { url: 'https://e.example.com', token: 'tok-keep', scope: 'group:eng', covers: 5 },
    ])
    const cfg = loadConfig(p)
    expect(cfg.stores).toHaveLength(1)
    expect(cfg.stores![0].token).toBe('tok-keep')
    expect(cfg.stores![0].covers).toBeUndefined() // non-array shape coerced away
  })

  it('ALL THREE malformed shapes at once on one entry still survive with url/token', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const p = writeConfig(dir, [
      { url: 'https://e.example.com', token: 'tok-keep', scope: 'group:eng', covers: 'broken', sensitivity: 'oops' },
    ])
    const cfg = loadConfig(p)
    expect(cfg.stores).toHaveLength(1)
    expect(cfg.stores![0].url).toBe('https://e.example.com')
    expect(cfg.stores![0].token).toBe('tok-keep')
  })

  it('StoreEntrySchema.passthrough + refine: an unknown field AND path-xor-url both hold', () => {
    // refine still rejects a both-path-and-url entry…
    expect(StoreEntrySchema.safeParse({ path: '/x', url: 'https://x.example.com', scope: 's' }).success).toBe(false)
    // …but an unknown TOP-LEVEL field survives a valid (path-only) entry.
    const ok = StoreEntrySchema.safeParse({ path: '/x', scope: 's', future_field: 'kept' })
    expect(ok.success).toBe(true)
    if (ok.success) expect((ok.data as Record<string, unknown>).future_field).toBe('kept')
  })

  // The NESTED writeback test below relies on the merge-against-raw AND on the
  // sub-schema passthrough. Prove the sub-schema passthrough INDEPENDENTLY here
  // so the round-trip test is non-vacuous even when read in isolation: the
  // TYPED parse output of a store entry must itself carry a nested unknown
  // inside `sensitivity` (this is what would be stripped without
  // ScopeSensitivitySchema.passthrough).
  it('ScopeSensitivitySchema.passthrough: the typed parse carries a NESTED unknown field', () => {
    const ok = StoreEntrySchema.safeParse({
      path: '/x', scope: 's', sensitivity: { forbid: ['secrets'], future_policy: { redact: true } },
    })
    expect(ok.success).toBe(true)
    if (ok.success) {
      const sens = (ok.data as { sensitivity?: Record<string, unknown> }).sensitivity!
      expect(sens.forbid).toEqual(['secrets'])
      expect(sens.future_policy).toEqual({ redact: true }) // nested unknown survives the TYPED parse
    }
  })
})

describe('PR-3 config robustness — version-skew writeback (no field stripping)', () => {
  const dirs: string[] = []
  const mkdir = (): string => { const d = mkdtempSync(join(tmpdir(), 'plur-pr3-skew-')); dirs.push(d); return d }
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); vi.restoreAllMocks() })

  const readStores = (dir: string): Array<Record<string, unknown>> => {
    const cfg = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { stores?: Array<Record<string, unknown>> }
    return cfg.stores ?? []
  }

  /**
   * TOP-LEVEL version-skew (NON-VACUOUS): a store entry with an unknown future
   * top-level field, driven through persistStores via addStore's token
   * rotation, STILL has the field afterwards. This exercises the WRITEBACK path
   * (typed stores → persistStores merge), not merely the read path.
   */
  it('preserves an unknown TOP-LEVEL field through a persistStores round-trip', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const URL = 'https://enterprise.example.com'
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { url: URL, token: 'old-token', scope: 'group:eng', shared: true, readonly: false, future_field: 'preserve-me' },
      ],
    }, { noRefs: true }))

    const plur = new Plur({ path: dir })
    // Token rotation flows the entry through this.config.stores → persistStores.
    const res = plur.addStore('', 'group:eng', { url: URL, token: 'new-token' })
    expect(res.status).toBe('token_rotated')

    const stores = readStores(dir)
    expect(stores).toHaveLength(1)
    expect(stores[0].token).toBe('new-token')         // parsed delta applied
    expect(stores[0].url).toBe(URL)                   // preserved
    expect(stores[0].future_field).toBe('preserve-me') // unknown top-level field survives writeback
  })

  /**
   * NESTED version-skew: an unknown field INSIDE `sensitivity`, after the same
   * round-trip, STILL has the nested field. This is the test the evaluator
   * flagged would be vacuous unless ScopeSensitivitySchema ALSO has
   * `.passthrough()` AND persistStores deep-merges `sensitivity` one level.
   */
  it('preserves an unknown NESTED field inside sensitivity through a persistStores round-trip', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const URL = 'https://enterprise.example.com'
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        {
          url: URL, token: 'old-token', scope: 'group:eng', shared: true,
          sensitivity: { forbid: ['secrets'], allow: [], future_policy: { redact: true } },
        },
      ],
    }, { noRefs: true }))

    const plur = new Plur({ path: dir })
    const res = plur.addStore('', 'group:eng', { url: URL, token: 'new-token' })
    expect(res.status).toBe('token_rotated')

    const stores = readStores(dir)
    expect(stores).toHaveLength(1)
    const sensitivity = stores[0].sensitivity as Record<string, unknown>
    expect(stores[0].token).toBe('new-token')
    expect(sensitivity.forbid).toEqual(['secrets'])          // parsed value
    expect(sensitivity.future_policy).toEqual({ redact: true }) // NESTED unknown survives writeback
  })

  /**
   * R2-D (#14): a forward/unknown `forbid` value is salvaged on READ (PR-3
   * preprocess rewrites `['pii']` → the safe default in the TYPED config), but
   * the first persistStores writeback used to land the typed (normalized) value
   * on top of the raw one, ERASING the forward-compat declaration on disk.
   * mergeStoresForWriteback now restores the raw `forbid` verbatim, so a
   * load→persist round-trip preserves the future-version policy declaration.
   */
  it('preserves a forward-compat `forbid` value through a persistStores round-trip', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const URL = 'https://enterprise.example.com'
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { url: URL, token: 'old-token', scope: 'group:eng', shared: true, sensitivity: { forbid: ['pii'] } },
      ],
    }, { noRefs: true }))

    const plur = new Plur({ path: dir })
    const res = plur.addStore('', 'group:eng', { url: URL, token: 'new-token' })
    expect(res.status).toBe('token_rotated')

    const stores = readStores(dir)
    expect(stores).toHaveLength(1)
    expect(stores[0].token).toBe('new-token')
    const sensitivity = stores[0].sensitivity as Record<string, unknown>
    // The forward-compat declaration survives the writeback (NOT overwritten to
    // the read-time-normalized ['secrets','infra']).
    expect(sensitivity.forbid).toEqual(['pii'])
  })

  /**
   * MERGE-KEY correctness: two remote stores share the SAME url but DIFFERENT
   * scopes. Rotating the token on one must leave the OTHER's token/url/unknowns
   * unchanged — proving the merge keys on url+scope, not url alone.
   */
  it('rotating one of two same-url/different-scope stores leaves the other untouched (url+scope key)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const URL = 'https://enterprise.example.com'
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { url: URL, token: 'eng-old', scope: 'group:eng', shared: true, eng_marker: 'E' },
        { url: URL, token: 'comms-tok', scope: 'group:comms', shared: true, comms_marker: 'C' },
      ],
    }, { noRefs: true }))

    const plur = new Plur({ path: dir })
    const res = plur.addStore('', 'group:eng', { url: URL, token: 'eng-new' })
    expect(res.status).toBe('token_rotated')

    const stores = readStores(dir)
    const byScope = Object.fromEntries(stores.map(s => [s.scope as string, s]))
    // eng rotated.
    expect(byScope['group:eng'].token).toBe('eng-new')
    expect(byScope['group:eng'].eng_marker).toBe('E')
    // comms entirely untouched — token, url, and its own unknown field intact.
    expect(byScope['group:comms'].token).toBe('comms-tok')
    expect(byScope['group:comms'].url).toBe(URL)
    expect(byScope['group:comms'].comms_marker).toBe('C')
  })
})

/**
 * R3 (final-audit MEDIUM): the R2-D forbid-restore added an `'forbid' in
 * rawSensitivity` membership check WITHOUT a runtime object check. loadConfig
 * does not dedup `stores`, so a hand-edited config with two entries on the SAME
 * url+scope key — one with a proper sensitivity OBJECT, one with a malformed
 * truthy PRIMITIVE (`sensitivity: 'oops'`) — survives loading. rawMap keeps the
 * LAST raw dup (the primitive), and merging the object-typed entry then runs the
 * `in` operator against a string and throws a TypeError that propagates out of
 * addStore. The guard now type-checks rawSensitivity is a plain object first.
 */
describe('R3 config robustness — mergeStoresForWriteback primitive-sensitivity crash', () => {
  const dirs: string[] = []
  const mkdir = (): string => { const d = mkdtempSync(join(tmpdir(), 'plur-r3-prim-')); dirs.push(d); return d }
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); vi.restoreAllMocks() })

  const readStores = (dir: string): Array<Record<string, unknown>> => {
    const cfg = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as { stores?: Array<Record<string, unknown>> }
    return cfg.stores ?? []
  }

  it('a duplicate-keyed entry with a primitive `sensitivity` round-trips without throwing (string)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const URL = 'https://enterprise.example.com'
    // Two entries on the SAME url+scope: a proper object-sensitivity one, then a
    // malformed scalar one (last-wins in rawMap). loadConfig coerces the scalar
    // entry's `sensitivity` away but keeps BOTH entries (no dedup), so the typed
    // array still carries an object-sensitivity entry whose raw match is a string.
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { url: URL, token: 'old-token', scope: 'group:eng', shared: true, sensitivity: { forbid: ['secrets'] } },
        { url: URL, token: 'old-token', scope: 'group:eng', shared: true, sensitivity: 'oops' },
      ],
    }, { noRefs: true }))

    const plur = new Plur({ path: dir })
    // Before the guard this threw: "Cannot use 'in' operator to search for 'forbid' in oops".
    expect(() => plur.addStore('', 'group:eng', { url: URL, token: 'new-token' })).not.toThrow()
    const stores = readStores(dir)
    expect(stores.length).toBeGreaterThanOrEqual(1)
    expect(stores.some(s => s.token === 'new-token')).toBe(true)
  })

  it.each([
    ['number', 5],
    ['boolean', true],
  ])('a duplicate-keyed entry with a primitive `sensitivity` round-trips without throwing (%s)', (_label, prim) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const URL = 'https://enterprise.example.com'
    writeFileSync(join(dir, 'config.yaml'), yaml.dump({
      index: false,
      stores: [
        { url: URL, token: 'old-token', scope: 'group:eng', shared: true, sensitivity: { forbid: ['secrets'] } },
        { url: URL, token: 'old-token', scope: 'group:eng', shared: true, sensitivity: prim },
      ],
    }, { noRefs: true }))

    const plur = new Plur({ path: dir })
    expect(() => plur.addStore('', 'group:eng', { url: URL, token: 'new-token' })).not.toThrow()
  })
})

/**
 * R3 (final-audit LOW): persistStores reads the existing config to PRESERVE
 * other top-level keys (auto_learn, packs, embeddings, routing defaults, …). It
 * used to swallow ANY read error and proceed from `{}`, so a TRANSIENT read
 * failure on an EXISTING file caused the write to emit only `{ stores }` —
 * silently nuking every other top-level setting. The read now re-throws on any
 * error that is NOT ENOENT, aborting the writeback so a live config is never
 * truncated. (ENOENT — a genuinely-absent config — still starts safely from {}.)
 */
describe('R3 config robustness — persistStores transient read failure does not nuke top-level keys', () => {
  const dirs: string[] = []
  const mkdir = (): string => { const d = mkdtempSync(join(tmpdir(), 'plur-r3-read-')); dirs.push(d); return d }
  afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); vi.restoreAllMocks() })

  // Skip when running as root: chmod 000 doesn't block root reads, so the EACCES
  // we rely on never fires (CI sometimes runs as root in containers).
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
  const itNotRoot = asRoot ? it.skip : it
  itNotRoot('aborts the write (does not discard auto_learn/embeddings/etc) when the config read fails transiently', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const URL = 'https://enterprise.example.com'
    const cfgPath = join(dir, 'config.yaml')
    // A config rich in non-store top-level keys — the data at risk.
    const original = {
      index: false,
      auto_learn: true,
      packs: ['team-core'],
      embeddings: { model: 'bge-small' },
      unscoped_default: 'local',
      stores: [{ url: URL, token: 'old-token', scope: 'group:eng', shared: true }],
    }
    writeFileSync(cfgPath, yaml.dump(original, { noRefs: true }))

    const plur = new Plur({ path: dir })

    // Drive persistStores DIRECTLY so we isolate ONLY its read-then-merge step —
    // addStore's own loadConfig calls swallow read errors and would obscure the
    // guard under test. Simulate a TRANSIENT non-ENOENT read failure (EACCES — a
    // permission glitch / a concurrent truncating writer) by making the EXISTING
    // file unreadable. The file still EXISTS, so the guard must re-throw, not
    // start from {}.
    chmodSync(cfgPath, 0o000)
    try {
      // The writeback must ABORT (re-throw the non-ENOENT error) rather than
      // silently truncate the config to a stores-only file.
      expect(() => (plur as unknown as { persistStores(s: unknown[]): void }).persistStores([
        { url: URL, token: 'new-token', scope: 'group:eng', shared: true },
      ])).toThrow()
    } finally {
      chmodSync(cfgPath, 0o600)
    }

    // The on-disk config is INTACT — all the non-store top-level keys survive
    // (the aborted write never overwrote the file with a stores-only document).
    const after = yaml.load(readFileSync(cfgPath, 'utf8')) as Record<string, unknown>
    expect(after.auto_learn).toBe(true)
    expect(after.packs).toEqual(['team-core'])
    expect(after.embeddings).toEqual({ model: 'bge-small' })
    expect(after.unscoped_default).toBe('local')
    expect(Array.isArray(after.stores)).toBe(true)
    // and the token was NOT rotated — the write aborted before mutating anything.
    expect((after.stores as Array<Record<string, unknown>>)[0].token).toBe('old-token')
  })

  it('ENOENT (config genuinely absent) still starts safely from {} and writes the stores', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const dir = mkdir()
    const URL = 'https://enterprise.example.com'
    // No config.yaml on disk — a fresh install. persistStores must NOT throw on
    // the ENOENT; it should write a brand-new config with just the stores.
    const plur = new Plur({ path: dir })
    expect(() => (plur as unknown as { persistStores(s: unknown[]): void }).persistStores([
      { url: URL, token: 't', scope: 'group:eng', shared: true },
    ])).not.toThrow()
    const after = yaml.load(readFileSync(join(dir, 'config.yaml'), 'utf8')) as Record<string, unknown>
    expect(Array.isArray(after.stores)).toBe(true)
    expect((after.stores as Array<Record<string, unknown>>)[0].url).toBe(URL)
  })
})
