/**
 * #846 — deliberate feedback must not be outvoted by mere use.
 *
 * Three constants moved `activation.retrieval_strength`, set in two files that
 * did not reference each other:
 *
 *   passive retrieval  decay.ts    reactivate()               +0.10
 *   positive (★)       feedback.ts POSITIVE_STRENGTH_DELTA    +0.05
 *   negative (✗)       feedback.ts NEGATIVE_STRENGTH_DELTA    −0.10
 *
 * So a ★ was worth HALF of being incidentally fetched, and a ✗ was EXACTLY
 * cancelled by the next recall that returned the engram — a considered "this is
 * wrong" survived until the engram was next looked at, then did not exist.
 *
 * That mattered because the field reads as "how well-regarded is this": it is
 * what `min_strength` filters on, what `scoreEngram` multiplies into injection
 * ranking, and what admin surfaces present. It actually encoded "how often has
 * this been fetched" — self-reinforcing, and saturating at 1.0 after three
 * recalls, after which no feedback in either direction was visible at all.
 *
 * Fixed by separation rather than a new ratio: traffic already has a home in
 * `activation.frequency`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Plur } from '../src/index.js'
import { reactivate, LEGACY_REACTIVATION_STRENGTH_DELTA } from '../src/decay.js'
import { POSITIVE_STRENGTH_DELTA, NEGATIVE_STRENGTH_DELTA } from '../src/feedback.js'

describe('retrieval no longer moves retrieval_strength (#846)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-846-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('recall leaves strength unchanged but still counts the retrieval', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('rebase before pushing on this repo', { scope: 'global', type: 'behavioral' })
    const before = (await plur.getById(e.id))!.activation.retrieval_strength

    await plur.recall('rebase')
    await plur.recall('rebase')
    await plur.recall('rebase')

    const after = (await plur.getById(e.id))!
    expect(after.activation.retrieval_strength, 'traffic must not inflate a quality field').toBe(before)
    // …but the retrieval itself is still recorded, in the field that means it.
    expect(after.activation.frequency).toBeGreaterThan(0)
  })

  it('recall still refreshes recency, so decay behaviour is unaffected', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('pin RESTIC_CACHE_DIR for systemd units', { scope: 'global', type: 'procedural' })
    // Backdate, then recall: decay keys on last_accessed, not on strength, so
    // this is what actually protects a frequently-used engram.
    const stale = await plur.getById(e.id)
    stale!.activation.last_accessed = '2020-01-01'
    await plur.updateEngram(stale!)

    await plur.recall('RESTIC_CACHE_DIR')

    const after = (await plur.getById(e.id))!
    expect(after.activation.last_accessed).not.toBe('2020-01-01')
  })

  it('a negative rating is no longer erased by the next recall', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('always squash merge on this repo', { scope: 'global', type: 'behavioral' })
    const before = (await plur.getById(e.id))!.activation.retrieval_strength

    await plur.feedback(e.id, 'negative', 'primary')
    const rated = (await plur.getById(e.id))!.activation.retrieval_strength
    expect(rated).toBeLessThan(before)

    // The whole bug: one incidental fetch used to cancel this exactly.
    await plur.recall('squash merge')
    expect((await plur.getById(e.id))!.activation.retrieval_strength).toBe(rated)
  })

  it('a positive rating still moves it', async () => {
    const plur = new Plur({ path: dir })
    const e = await plur.learn('prefer flock over lockfiles where available', { scope: 'global', type: 'architectural' })
    const before = (await plur.getById(e.id))!.activation.retrieval_strength

    await plur.feedback(e.id, 'positive', 'primary')

    expect((await plur.getById(e.id))!.activation.retrieval_strength).toBeGreaterThan(before)
  })
})

describe('the constants tell a coherent story now (#846)', () => {
  it('reactivate is a no-op', () => {
    for (const v of [0, 0.3, 0.7, 0.95, 1]) expect(reactivate(v)).toBe(v)
  })

  it('the old reactivation delta is exported and named, not an anonymous literal', () => {
    // It was the one constant a downstream consumer had to know in order to
    // reason about what a feedback delta is WORTH, and it was the only one not
    // exported — so enterprise hand-copied it and guarded the copy by measuring
    // core's behaviour empirically.
    expect(LEGACY_REACTIVATION_STRENGTH_DELTA).toBe(0.1)
  })

  it('deliberate feedback is no longer outvoted by traffic', () => {
    // The property that failed before: a ★ has to be worth at least as much as
    // a retrieval. Retrieval is now worth zero, so any positive delta wins.
    expect(POSITIVE_STRENGTH_DELTA).toBeGreaterThan(0)
    expect(NEGATIVE_STRENGTH_DELTA).toBeGreaterThan(0)
    expect(POSITIVE_STRENGTH_DELTA).toBeGreaterThanOrEqual(reactivate(0.5) - 0.5)
  })
})
