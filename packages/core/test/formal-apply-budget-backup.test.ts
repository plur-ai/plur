/**
 * Apply phase of the formal-verification run (owner decisions P2, P3).
 * Model: spec/formal/PlurSpec/Persistence.lean (Backup section).
 *
 * P2 last-written: saveEngrams records the count PLUR last wrote; the backup
 *    shrink gate compares the file against THAT, so a legitimate shrink
 *    re-baselines automatically while an external truncation (the file shrinks
 *    without PLUR having written it) is still refused. Replayed pre-fix: after
 *    one legitimate >10% forget, every later day was refused as "shrunk".
 * P3 engram_created only: the restore "unrecoverable" list counts only
 *    `engram_created` events after the snapshot, minus ids later retired.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { maybeDailyBackup, planRestore, restoreBackup, listBackups, _resetBackupProcessState } from '../src/backup.js'
import { saveEngrams } from '../src/engrams.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'

let root: string
let storePath: string

function engram(n: number) {
  return EngramSchemaPassthrough.parse({
    id: `ENG-2026-08-02-${String(n).padStart(3, '0')}`,
    statement: `fact number ${n}`, type: 'behavioral', status: 'active',
    confidence: 0.5, created: '2026-08-02', scope: 'local',
  })
}
const engrams = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => engram(from + i))
const day = (n: number) => new Date(Date.UTC(2026, 7, n, 9, 0, 0))
const next = () => _resetBackupProcessState()

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-apply-backup-'))
  storePath = path.join(root, 'engrams.yaml')
  _resetBackupProcessState()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('P2 — the shrink gate compares against what PLUR last wrote', () => {
  it('a legitimate >10% removal by PLUR re-baselines: the next day is snapshotted', () => {
    saveEngrams(storePath, engrams(0, 100) as never)
    expect(maybeDailyBackup(root, storePath, day(1)).taken).toBe(true)
    next()
    saveEngrams(storePath, engrams(0, 70) as never, { allowShrink: true }) // forget 30
    const d2 = maybeDailyBackup(root, storePath, day(2))
    expect(d2.skipped).toBeUndefined()
    expect(d2.taken).toBe(true)
    next()
    expect(maybeDailyBackup(root, storePath, day(3)).taken).toBe(true)
  })

  it('an external truncation (no PLUR write) is still refused', () => {
    saveEngrams(storePath, engrams(0, 100) as never)
    expect(maybeDailyBackup(root, storePath, day(1)).taken).toBe(true)
    next()
    saveEngrams(storePath, engrams(0, 100) as never)
    fs.writeFileSync(storePath, yaml.dump({ engrams: engrams(0, 20) })) // not through PLUR
    const d2 = maybeDailyBackup(root, storePath, day(2))
    expect(d2.taken).toBe(false)
    expect(d2.validity?.failures).toContain('shrunk')
  })

  it('an external truncation after a legitimate shrink is refused against the new baseline', () => {
    saveEngrams(storePath, engrams(0, 100) as never)
    maybeDailyBackup(root, storePath, day(1)); next()
    saveEngrams(storePath, engrams(0, 70) as never, { allowShrink: true })
    fs.writeFileSync(storePath, yaml.dump({ engrams: engrams(0, 50) }))
    const d2 = maybeDailyBackup(root, storePath, day(2))
    expect(d2.taken).toBe(false)
    expect(d2.validity?.failures).toContain('shrunk')
  })

  it('a restore records its count too: the next day is not refused as "shrunk"', () => {
    saveEngrams(storePath, engrams(0, 50) as never)
    maybeDailyBackup(root, storePath, day(1)); next()
    saveEngrams(storePath, engrams(0, 100) as never)
    maybeDailyBackup(root, storePath, day(2)); next()
    restoreBackup(root, storePath, { stamp: '2026-08-01' })
    expect(maybeDailyBackup(root, storePath, day(3)).taken).toBe(true)
  })

  it('good case: no record yet (first run) falls back to the snapshot baseline', () => {
    fs.writeFileSync(storePath, yaml.dump({ engrams: engrams(0, 100) }))
    expect(maybeDailyBackup(root, storePath, day(1)).taken).toBe(true)
    next()
    fs.writeFileSync(storePath, yaml.dump({ engrams: engrams(0, 50) }))
    expect(maybeDailyBackup(root, storePath, day(2)).validity?.failures).toContain('shrunk')
    expect(listBackups(root)).toHaveLength(1)
  })
})

describe('P3 — unrecoverable counts only engram_created, minus later retirements', () => {
  function history(events: object[]) {
    fs.mkdirSync(path.join(root, 'history'), { recursive: true })
    fs.writeFileSync(path.join(root, 'history', 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  }

  it('feedback on an existing engram absent from the snapshot is not "created after"', () => {
    fs.writeFileSync(storePath, yaml.dump({ engrams: [engram(0)] }))
    maybeDailyBackup(root, storePath, day(2))
    history([
      { event: 'engram_created', engram_id: 'ENG-2026-08-02-050', timestamp: '2026-08-02T14:00:00.000Z' },
      { event: 'feedback_received', engram_id: 'ENG-2026-08-02-007', timestamp: '2026-08-02T14:01:00.000Z' },
      { event: 'engram_updated', engram_id: 'ENG-2026-08-02-008', timestamp: '2026-08-02T14:02:00.000Z' },
    ])
    expect(planRestore(root, storePath).unrecoverable).toEqual(['ENG-2026-08-02-050'])
  })

  it('an engram created and then retired after the snapshot is not reported', () => {
    fs.writeFileSync(storePath, yaml.dump({ engrams: [engram(0)] }))
    maybeDailyBackup(root, storePath, day(2))
    history([
      { event: 'engram_created', engram_id: 'ENG-2026-08-02-050', timestamp: '2026-08-02T14:00:00.000Z' },
      { event: 'engram_created', engram_id: 'ENG-2026-08-02-060', timestamp: '2026-08-02T14:00:00.000Z' },
      { event: 'engram_retired', engram_id: 'ENG-2026-08-02-060', timestamp: '2026-08-02T15:00:00.000Z' },
    ])
    expect(planRestore(root, storePath).unrecoverable).toEqual(['ENG-2026-08-02-050'])
  })

  it('good case: every engram created after the snapshot is named', () => {
    fs.writeFileSync(storePath, yaml.dump({ engrams: [engram(0)] }))
    maybeDailyBackup(root, storePath, day(2))
    history([
      { event: 'engram_created', engram_id: 'ENG-2026-08-02-050', timestamp: '2026-08-02T14:00:00.000Z' },
      { event: 'engram_created', engram_id: 'ENG-2026-08-02-051', timestamp: '2026-08-02T15:00:00.000Z' },
      { event: 'engram_created', engram_id: 'ENG-2026-08-02-001', timestamp: '2026-08-02T08:00:00.000Z' },
    ])
    expect(planRestore(root, storePath).unrecoverable).toEqual(['ENG-2026-08-02-050', 'ENG-2026-08-02-051'])
  })
})
