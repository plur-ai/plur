/**
 * Owner decision P2 (2026-09-27, `round2_rows.P2_shrink_ratchet`:
 * cumulative-tolerance; findings/r2-persist.md item 6b; proved by
 * `PlurSpec.R2Persist.Shrink.base_bounds`): "Gate every removal".
 *
 * The 10% tolerance for an undeclared shrink is cumulative since the last
 * non-shrinking or declared write, kept in process only. Before, each write was
 * judged against the file as it was just then, so ten tolerated writes took a
 * 100-engram store to 37 without one refusal.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { saveEngrams, EngramStoreShrinkError } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

function e(n: number): Engram {
  return {
    id: `ENG-2026-09-27-${String(n).padStart(3, '0')}`, statement: `fact ${n}`, type: 'behavioral',
    scope: 'global', status: 'active', tags: [],
    activation: { retrieval_strength: 1, storage_strength: 1, frequency: 0, last_accessed: '2026-09-27' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
  } as unknown as Engram
}
const first = (n: number) => Array.from({ length: n }, (_, i) => e(i + 1))

describe('P2: undeclared shrinks are tolerated cumulatively, not per write', () => {
  let dir: string
  let file: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-p2-')); file = join(dir, 'engrams.yaml') })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('the replayed run 100 -> 90 -> 81 is refused at its second step', () => {
    saveEngrams(file, first(100))
    saveEngrams(file, first(90))
    expect(() => saveEngrams(file, first(81))).toThrow(EngramStoreShrinkError)
  })

  it('ten tolerated steps can no longer reach 37', () => {
    saveEngrams(file, first(100))
    let refused = false
    for (const n of [90, 81, 73, 66, 60, 54, 49, 45, 41, 37]) {
      try { saveEngrams(file, first(n)) } catch (err) { expect(err).toBeInstanceOf(EngramStoreShrinkError); refused = true; break }
    }
    expect(refused).toBe(true)
  })

  it('a non-shrinking write moves the baseline', () => {
    saveEngrams(file, first(100))
    saveEngrams(file, first(91))
    saveEngrams(file, first(95)) // growth: new baseline 95
    expect(() => saveEngrams(file, first(86))).not.toThrow() // 86 >= 85.5
  })

  it('a declared shrink moves the baseline', () => {
    saveEngrams(file, first(100))
    saveEngrams(file, first(95))
    saveEngrams(file, first(50), { allowShrink: true })
    expect(() => saveEngrams(file, first(46))).not.toThrow() // 46 >= 45
  })

  it('a file changed by someone else since this process wrote it starts a new run', () => {
    saveEngrams(file, first(100))
    saveEngrams(file, first(95))
    // Another process (or a sync pull) legitimately removed engrams.
    writeFileSync(file, yaml.dump({ engrams: first(80) }))
    expect(() => saveEngrams(file, first(79))).not.toThrow()
  })

  it('a single write past 10% of the file is still refused (per-write rule kept)', () => {
    saveEngrams(file, first(100))
    expect(() => saveEngrams(file, first(89))).toThrow(EngramStoreShrinkError)
  })
})
