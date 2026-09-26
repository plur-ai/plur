/**
 * Formal-verification replay (spec/formal/PlurSpec/Persistence.lean §2, candidate 2):
 * a failed migration run must leave the live engrams.yaml byte-identical.
 *
 * `up()`/`down()` run in memory and nothing is written before the loop finishes,
 * so the live file is already intact when one throws. Restoring `.bak.<v>` over
 * it — a backup that is never refreshed (no-clobber, #813) — replaced the live
 * store with whatever it held when it was first taken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { runMigrations, rollbackMigrations, ALL_MIGRATIONS } from '../src/migrations/index.js'
import { saveEngrams, loadEngrams } from '../src/engrams.js'
import type { Engram } from '../src/schemas/engram.js'

function makeEngram(id: string): Engram {
  return {
    id, version: 2, status: 'active', consolidated: false, type: 'behavioral', scope: 'global',
    visibility: 'private', statement: `statement ${id}`,
    activation: { retrieval_strength: 0.7, storage_strength: 1.0, frequency: 0, last_accessed: '2026-04-06' },
    feedback_signals: { positive: 0, negative: 0, neutral: 0 },
    knowledge_anchors: [], associations: [], derivation_count: 1, tags: [], pack: null,
    abstract: null, derived_from: null, polarity: null,
  } as Engram
}

describe('formal-persistence: failed migration leaves the live store untouched', () => {
  let dir: string, engramsPath: string, configPath: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-fmig-'))
    engramsPath = path.join(dir, 'engrams.yaml')
    configPath = path.join(dir, 'config.yaml')
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('run: a throwing up() after a rollback does not restore the stale .bak.0', () => {
    saveEngrams(engramsPath, [makeEngram('ENG-2026-0406-001')])
    runMigrations(engramsPath, configPath) // creates .bak.0 holding 1 engram
    saveEngrams(engramsPath, [
      ...loadEngrams(engramsPath),
      makeEngram('ENG-2026-0406-002'),
      makeEngram('ENG-2026-0406-003'),
    ])
    rollbackMigrations(engramsPath, configPath, 0)
    expect(loadEngrams(engramsPath)).toHaveLength(3)
    const before = fs.readFileSync(engramsPath)

    const last = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]
    const origUp = last.up
    last.up = () => { throw new Error('injected failure') }
    try {
      expect(() => runMigrations(engramsPath, configPath)).toThrow(/injected failure/)
    } finally {
      last.up = origUp
    }
    expect(fs.readFileSync(engramsPath).equals(before)).toBe(true)
    expect(loadEngrams(engramsPath)).toHaveLength(3)
  })

  it('rollback: a throwing down() does not restore a stale .bak.<v>', () => {
    saveEngrams(engramsPath, [makeEngram('ENG-2026-0406-001')])
    runMigrations(engramsPath, configPath)
    // Rollback once to create .bak.6 with 1 engram, then migrate back up.
    rollbackMigrations(engramsPath, configPath, 5)
    runMigrations(engramsPath, configPath)
    saveEngrams(engramsPath, [...loadEngrams(engramsPath), makeEngram('ENG-2026-0406-002')])
    const before = fs.readFileSync(engramsPath)

    const last = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]
    const origDown = last.down
    last.down = () => { throw new Error('injected down failure') }
    try {
      expect(() => rollbackMigrations(engramsPath, configPath, 5)).toThrow(/injected down failure/)
    } finally {
      last.down = origDown
    }
    expect(fs.readFileSync(engramsPath).equals(before)).toBe(true)
  })
})
