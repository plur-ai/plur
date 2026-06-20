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
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
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
