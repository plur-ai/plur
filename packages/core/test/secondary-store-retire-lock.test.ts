/**
 * Retiring an engram in a SECONDARY store must hold that store's lock.
 *
 * `forget()` and `_retireEngramForResolution()` both do load -> mutate ->
 * `_writeEngrams`, and `_writeEngrams` replaces the WHOLE file. Neither took
 * the secondary store's lock, so two processes acting on one shared team store
 * did not merely lose an update — whichever wrote second dropped every change
 * the other had committed in between.
 *
 * Same defect already fixed for `feedback()` and `_recordCrossScopeRecurrence()`.
 * These two sites were missed, and a brace-accurate scan of every
 * `_writeEngrams` call site is what found them: a line-proximity scan reports
 * them as locked, because each sits ~40 lines below the lock belonging to its
 * own method's PRIMARY branch.
 *
 * Two sites in that file are deliberately NOT locked and must stay that way —
 * `_recordDuplicate` and `_recordCrossScopeRecurrence` write to the primary
 * store and every caller already holds that lock. `withAsyncLock` is not
 * reentrant, so "fixing" them would deadlock rather than protect anything.
 *
 * Note for anyone extending this file: `learn()` writes ONLY to the primary
 * store. A secondary store is populated on disk and reached by namespaced id,
 * which is why the fixtures below write YAML directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { Plur } from '../src/index.js'
import { storePrefix } from '../src/engrams.js'

const TIMEOUT = 60_000
const SCOPE = 'datafund'

function makeEngram(id: string, statement: string) {
  return {
    id, version: 2, status: 'active', consolidated: false, type: 'behavioral',
    scope: 'global', visibility: 'private', statement,
    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-07-28' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    associations: [], derivation_count: 1, tags: [], pack: null, abstract: null,
    derived_from: null, reference_count: 1, sources: [],
  }
}

describe('secondary-store retire holds the secondary lock', () => {
  let dirA: string
  let dirB: string
  let storeDir: string
  let storePath: string
  const ids = ['ENG-2026-0728-001', 'ENG-2026-0728-002', 'ENG-2026-0728-003', 'ENG-2026-0728-004']
  // Namespaced form: the store prefix is injected INTO the id
  // (ENG-DFD-2026-...), it is not a `scope:` prefix. Derived rather than
  // hardcoded so a change to storePrefix() fails here loudly.
  const ns = (id: string) => id.replace(/^ENG-/, `ENG-${storePrefix(SCOPE)}-`)

  /** Two Plur instances with DIFFERENT primary paths sharing one secondary store. */
  function makePair() {
    const cfg = yaml.dump({ stores: [{ path: storePath, scope: SCOPE, readonly: false }], index: false })
    writeFileSync(join(dirA, 'config.yaml'), cfg)
    writeFileSync(join(dirB, 'config.yaml'), cfg)
    return [new Plur({ path: dirA }), new Plur({ path: dirB })] as const
  }

  const readStore = () => (yaml.load(readFileSync(storePath, 'utf8')) as { engrams: Array<Record<string, unknown>> }).engrams

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'plur-sec-a-'))
    dirB = mkdtempSync(join(tmpdir(), 'plur-sec-b-'))
    storeDir = mkdtempSync(join(tmpdir(), 'plur-sec-store-'))
    storePath = join(storeDir, 'team.yaml')
    writeFileSync(storePath, yaml.dump({ engrams: ids.map((id, i) => makeEngram(id, `team convention number ${i}`)) }))
    writeFileSync(join(dirA, 'engrams.yaml'), 'engrams: []\n')
    writeFileSync(join(dirB, 'engrams.yaml'), 'engrams: []\n')
  })

  afterEach(() => {
    for (const d of [dirA, dirB, storeDir]) if (d) rmSync(d, { recursive: true, force: true })
  })

  it('two concurrent forgets of DIFFERENT engrams both land', async () => {
    // The core of it. Unlocked, both load the same snapshot and both write the
    // whole file back, so the second write erases the first retirement.
    const [p1, p2] = makePair()
    await p1.ready()
    await p2.ready()

    await Promise.all([p1.forget(ns(ids[0]), 'a'), p2.forget(ns(ids[1]), 'b')])

    const after = readStore()
    const retired = after.filter(e => e.status === 'retired').map(e => e.id)
    expect(
      retired.sort(),
      'one of the two concurrent retires was erased by the other whole-file write',
    ).toEqual([ids[0], ids[1]])
  }, TIMEOUT)

  it('a concurrent forget and feedback do not erase each other', async () => {
    // Cross-method: `feedback()` on a secondary store was locked already,
    // `forget()` was not — so the lock only helped if BOTH sides took it.
    const [p1, p2] = makePair()
    await p1.ready()
    await p2.ready()

    await Promise.all([p1.forget(ns(ids[0]), 'obsolete'), p2.feedback(ns(ids[2]), 'positive')])

    const after = readStore()
    const forgotten = after.find(e => e.id === ids[0])
    const rated = after.find(e => e.id === ids[2]) as { feedback_signals?: { positive?: number } }
    expect(forgotten?.status, 'the retire was lost').toBe('retired')
    expect(rated?.feedback_signals?.positive, 'the feedback increment was lost').toBe(1)
  }, TIMEOUT)

  it('nothing unrelated is dropped from the store', async () => {
    const [p1, p2] = makePair()
    await p1.ready()
    await p2.ready()
    await Promise.all([p1.forget(ns(ids[0]), 'a'), p2.forget(ns(ids[1]), 'b')])
    expect(
      readStore().map(e => e.id).sort(),
      'engrams nobody touched disappeared — the whole-file replace ran on a stale snapshot',
    ).toEqual([...ids].sort())
  }, TIMEOUT)

  it('a single forget still works — the lock must not skip the write', async () => {
    // Guards against "take the lock and do nothing" satisfying everything above.
    const [p1] = makePair()
    await p1.ready()
    await p1.forget(ns(ids[0]), 'obsolete')
    expect(readStore().find(e => e.id === ids[0])?.status).toBe('retired')
  }, TIMEOUT)
})
