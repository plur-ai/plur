/**
 * Property tests for the save-side shrink guard.
 *
 * ## Why this file exists
 *
 * The guard has been broken twice, by the same optimisation, for the same
 * reason — and the existing fixture tests could not have caught either:
 *
 *   1. #810 estimated the on-disk record count from a bytes-per-engram
 *      constant. Real engrams averaged 785 bytes against an assumed 2400, so a
 *      20,000-engram store was read as 6,500 and a genuine 50% shrink skipped
 *      the guard entirely.
 *   2. The replacement compared serialized bytes to on-disk bytes. That removed
 *      the bad constant but kept the assumption under it, which the code stated
 *      out loud: "records are broadly similar in size". They are not. Dropping
 *      11 of 100 records moved the COUNT 11% and the BYTES under 5%, so the
 *      guard never ran (audit 2026-08-03, finding 5).
 *
 * Both survived a suite with thorough fixture coverage because every fixture
 * used uniformly generated engrams, where count and bytes move together by
 * construction. No amount of care in writing more fixtures fixes that — the
 * blind spot IS the fixture generator.
 *
 * So this file does not assert on examples. It states the invariant and lets a
 * generator attack it with heterogeneous corpora and random writes:
 *
 *   a write that removes more than SHRINK_TOLERANCE of the records must throw,
 *   and one that removes fewer must not, whatever the bytes happen to do.
 *
 * ## Determinism
 *
 * Seeded PRNG, not `Math.random`. A property test that cannot be replayed
 * reports a failure you then have to reproduce by guessing; this one prints the
 * seed, and `PLUR_PROPERTY_SEED=<n>` replays it exactly. The default seed list
 * is fixed so CI runs the same cases every time — the value is in the SHAPE of
 * the generated data, not in fresh randomness on every run, which would make
 * the suite flaky rather than thorough.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as yaml from 'js-yaml'
import { join } from 'path'
import { loadEngrams, saveEngrams, EngramStoreShrinkError } from '../src/engrams.js'
import { EngramSchemaPassthrough, type Engram } from '../src/schemas/engram.js'

/** Must match SHRINK_TOLERANCE in engrams.ts. */
const SHRINK_TOLERANCE = 0.1

/** Deterministic PRNG (mulberry32) — small, fast, and replayable from a seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1))

/**
 * An engram of deliberately unpredictable WEIGHT.
 *
 * The point of the generator is that record size and record count must be
 * allowed to move independently. `rationale`, `dual_coding` and
 * `knowledge_anchors` all feed the serialized form, and a corpus mixing bare
 * statements with fully-populated engrams spans more than an order of magnitude
 * per record — which is what real stores look like and what every previous
 * fixture failed to represent.
 */
function randomEngram(r: () => number, n: number): Engram {
  const heavy = r() < 0.5
  const base: Record<string, unknown> = {
    id: `ENG-2026-08-03-${String(n).padStart(5, '0')}`,
    statement: 'x'.repeat(int(r, 10, heavy ? 3000 : 60)),
    type: 'behavioral',
    status: 'active',
    confidence: 0.5,
    created: '2026-08-03',
    scope: 'local',
  }
  if (heavy) {
    base.rationale = 'r'.repeat(int(r, 100, 4000))
    if (r() < 0.5) base.dual_coding = { example: 'e'.repeat(int(r, 50, 1500)) }
    if (r() < 0.5) base.tags = Array.from({ length: int(r, 1, 12) }, (_, i) => `tag-${i}`)
  }
  return EngramSchemaPassthrough.parse(base) as Engram
}

let root: string
let storePath: string

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'plur-prop-shrink-'))
  storePath = join(root, 'engrams.yaml')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** Seeds run by default. Override with PLUR_PROPERTY_SEED to replay one. */
const SEEDS = process.env.PLUR_PROPERTY_SEED
  ? [Number(process.env.PLUR_PROPERTY_SEED)]
  : [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]

describe('shrink guard — property: the record COUNT decides, never the byte size', () => {
  it.each(SEEDS)('holds across randomised corpora and writes (seed %i)', (seedValue) => {
    const r = rng(seedValue)

    for (let round = 0; round < 40; round++) {
      const before = int(r, 20, 120)
      const corpus = Array.from({ length: before }, (_, i) => randomEngram(r, i))
      // Establish the baseline with the guard explicitly disabled, so the setup
      // can never be what fails.
      saveEngrams(storePath, corpus, { allowShrink: true })

      // Remove a random SUBSET — not a prefix. A prefix slice correlates size
      // with position whenever the generator emits runs of similar records; an
      // arbitrary subset is what a buggy caller actually produces.
      const keepCount = int(r, 0, before)
      const shuffled = [...corpus]
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = int(r, 0, i)
        ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
      }
      const outgoing = shuffled.slice(0, keepCount)

      const shouldRefuse = outgoing.length < before * (1 - SHRINK_TOLERANCE)
      const context = `seed=${seedValue} round=${round} before=${before} after=${outgoing.length}`

      if (shouldRefuse) {
        expect(() => saveEngrams(storePath, outgoing), `expected refusal — ${context}`)
          .toThrow(EngramStoreShrinkError)
        // Refusing must also mean not writing: a guard that throws AFTER
        // replacing the file protects nothing.
        expect(loadEngrams(storePath).length, `store changed despite refusal — ${context}`)
          .toBe(before)
      } else {
        expect(() => saveEngrams(storePath, outgoing), `unexpected refusal — ${context}`)
          .not.toThrow()
        expect(loadEngrams(storePath).length, `write did not land — ${context}`)
          .toBe(outgoing.length)
      }
    }
  })

  /**
   * The specific shape both historical bugs had: a large drop in RECORDS that
   * is a small change in BYTES. Generated rather than hand-picked, so it covers
   * the ratio space instead of the one example someone thought of.
   */
  it.each(SEEDS.slice(0, 5))('refuses record loss that barely moves the byte count (seed %i)', (seedValue) => {
    const r = rng(seedValue + 1000)

    for (let round = 0; round < 25; round++) {
      const heavyCount = int(r, 40, 90)
      const lightCount = int(r, 12, 30)
      // Heavy records dominate the bytes; light records dominate nothing.
      const heavy = Array.from({ length: heavyCount }, (_, i) =>
        EngramSchemaPassthrough.parse({
          id: `ENG-2026-08-03-H${String(i).padStart(4, '0')}`,
          statement: 'h'.repeat(2000), rationale: 'r'.repeat(3000),
          type: 'behavioral', status: 'active', confidence: 0.5,
          created: '2026-08-03', scope: 'local',
        }) as Engram)
      const light = Array.from({ length: lightCount }, (_, i) =>
        EngramSchemaPassthrough.parse({
          id: `ENG-2026-08-03-L${String(i).padStart(4, '0')}`,
          statement: 'l', type: 'behavioral', status: 'active',
          confidence: 0.5, created: '2026-08-03', scope: 'local',
        }) as Engram)

      const total = heavyCount + lightCount
      saveEngrams(storePath, [...heavy, ...light], { allowShrink: true })
      const bytesBefore = fs.statSync(storePath).size

      // Dropping every light record is always past the tolerance by count.
      expect(lightCount).toBeGreaterThan(total * SHRINK_TOLERANCE)

      const context = `seed=${seedValue} round=${round} ${total} -> ${heavyCount}`
      expect(() => saveEngrams(storePath, heavy), `expected refusal — ${context}`)
        .toThrow(EngramStoreShrinkError)

      // Document the trap in the assertion itself: the byte delta here is small
      // enough that any byte-proportional heuristic would have waved this
      // through. If a future optimisation reintroduces one, this fails.
      const bytesAfterIfWritten = Buffer.byteLength(
        yaml.dump({ engrams: heavy }, { lineWidth: 120, noRefs: true, quotingType: '"' }), 'utf8')
      const byteDrop = 1 - bytesAfterIfWritten / bytesBefore
      expect(byteDrop, `byte delta ${(byteDrop * 100).toFixed(1)}% — fixture no longer exercises the trap`)
        .toBeLessThan(SHRINK_TOLERANCE)
    }
  })

  /**
   * The counting path must be exact for every document PLUR itself writes.
   * `countEngramsOnDisk` scans for record-start lines rather than parsing, and
   * a scan that miscounts is worse than a parse that is slow: the baseline it
   * produces is what decides whether a write is refused.
   */
  it.each(SEEDS.slice(0, 5))('counts a written store exactly, whatever it contains (seed %i)', (seedValue) => {
    const r = rng(seedValue + 2000)

    for (let round = 0; round < 20; round++) {
      const n = int(r, 1, 60)
      const corpus = Array.from({ length: n }, (_, i) => {
        const e = randomEngram(r, i) as any
        // Multi-line scalars whose bodies contain sequence-looking lines are
        // the case a line scan can plausibly get wrong.
        if (r() < 0.4) e.rationale = 'first line\n- looks like an item\n- and another\n'
        return EngramSchemaPassthrough.parse(e) as Engram
      })
      saveEngrams(storePath, corpus, { allowShrink: true })

      // If the on-disk count were wrong by even one, the tolerance boundary
      // moves and one of these two assertions fails.
      const justInside = Math.ceil(n * (1 - SHRINK_TOLERANCE))
      const justOutside = justInside - 1
      const ctx = `seed=${seedValue} round=${round} n=${n}`

      if (justOutside >= 0 && justOutside < n * (1 - SHRINK_TOLERANCE)) {
        expect(() => saveEngrams(storePath, corpus.slice(0, justOutside)), `${ctx} justOutside`)
          .toThrow(EngramStoreShrinkError)
      }
      expect(() => saveEngrams(storePath, corpus.slice(0, justInside)), `${ctx} justInside`)
        .not.toThrow()
      // Restore the baseline for the next round.
      saveEngrams(storePath, corpus, { allowShrink: true })
    }
  })
})
