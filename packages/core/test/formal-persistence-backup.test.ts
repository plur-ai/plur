/**
 * Formal-verification replay (spec/formal/findings/persistence.md, candidate 6):
 * `planRestore().unrecoverable` is documented as "engram ids the history log
 * records as created after the backup", but it collected `engram_id` from EVERY
 * event: co_injection rows carry an injection id (INJ-…), session-level events
 * carry '' — so the restore warning named things that are not engrams.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { maybeDailyBackup, planRestore, _resetBackupProcessState } from '../src/backup.js'
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-fbackup-'))
  storePath = path.join(root, 'engrams.yaml')
  _resetBackupProcessState()
})
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe('formal-persistence: unrecoverable lists only engram ids', () => {
  it('ignores injection ids and empty session-level ids', () => {
    fs.writeFileSync(storePath, yaml.dump({ engrams: [engram(0)] }))
    maybeDailyBackup(root, storePath, new Date(Date.UTC(2026, 7, 2, 9, 0, 0)))
    fs.mkdirSync(path.join(root, 'history'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'history', 'events.jsonl'),
      [
        { event: 'engram_created', engram_id: 'ENG-2026-08-02-050', timestamp: '2026-08-02T14:00:00.000Z' },
        { event: 'co_injection', engram_id: 'INJ-2026-08-02-abc', timestamp: '2026-08-02T14:01:00.000Z' },
        { event: 'session_scope_changed', engram_id: '', timestamp: '2026-08-02T14:02:00.000Z' },
      ].map(e => JSON.stringify(e)).join('\n') + '\n',
    )
    expect(planRestore(root, storePath).unrecoverable).toEqual(['ENG-2026-08-02-050'])
  })
})
