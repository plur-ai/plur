/**
 * Tests for the validity-gated backup line (audit #794, issue #799).
 *
 * The point of these is not that a file gets copied. It is that the WRONG file
 * does not: backing up an already-corrupt store silently replaces the last good
 * copy with a bad one, and the user finds out at restore time that their safety
 * net was cut days ago. So most of what follows tests refusals.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import {
  maybeDailyBackup,
  listBackups,
  planRestore,
  restoreBackup,
  validateStore,
  _resetBackupProcessState,
  BACKUP_DIR,
} from '../src/backup.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'

let root: string
let storePath: string

function engram(n: number) {
  return EngramSchemaPassthrough.parse({
    id: `ENG-2026-08-02-${String(n).padStart(3, '0')}`,
    statement: `fact number ${n} about the system`,
    type: 'behavioral',
    status: 'active',
    confidence: 0.5,
    created: '2026-08-02',
    scope: 'local',
  })
}

function writeStore(count: number): void {
  const engrams = Array.from({ length: count }, (_, i) => engram(i))
  fs.writeFileSync(storePath, yaml.dump({ engrams }))
}

function day(n: number): Date {
  return new Date(Date.UTC(2026, 7, n))
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-backup-'))
  storePath = path.join(root, 'engrams.yaml')
  _resetBackupProcessState()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('validateStore — the gate', () => {
  it('accepts a healthy store', () => {
    writeStore(5)
    const v = validateStore(storePath)
    expect(v.ok).toBe(true)
    expect(v.count).toBe(5)
  })

  it('rejects a zero-length file', () => {
    fs.writeFileSync(storePath, '')
    expect(validateStore(storePath).failures).toContain('empty')
  })

  it('rejects unparseable YAML', () => {
    fs.writeFileSync(storePath, '{{{ not yaml\n')
    expect(validateStore(storePath).failures).toContain('unparseable')
  })

  it('rejects a file that parses but is not a store', () => {
    fs.writeFileSync(storePath, yaml.dump({ something_else: true }))
    expect(validateStore(storePath).failures).toContain('not-a-store')
  })

  it('rejects schema-invalid entries — the F2 case', () => {
    writeStore(5)
    const raw: any = yaml.load(fs.readFileSync(storePath, 'utf8'))
    delete raw.engrams[2].statement
    fs.writeFileSync(storePath, yaml.dump(raw))
    expect(validateStore(storePath).failures).toContain('invalid-entries')
  })

  it('rejects duplicate ids', () => {
    writeStore(3)
    const raw: any = yaml.load(fs.readFileSync(storePath, 'utf8'))
    raw.engrams[1].id = raw.engrams[0].id
    fs.writeFileSync(storePath, yaml.dump(raw))
    expect(validateStore(storePath).failures).toContain('duplicate-ids')
  })

  it('rejects a corpus that shrank past tolerance — the F1 truncation case', () => {
    // The only check that CAN catch a truncation: a truncated file is valid
    // YAML describing a smaller corpus, so nothing internal to it is wrong.
    writeStore(50)
    expect(validateStore(storePath, 100).failures).toContain('shrunk')
  })

  it('allows a small shrink within tolerance', () => {
    writeStore(95)
    expect(validateStore(storePath, 100).ok).toBe(true)
  })

  it('skips the shrink check when there is no baseline', () => {
    writeStore(2)
    expect(validateStore(storePath).ok).toBe(true)
  })

  it('flags a file that does not end in a newline', () => {
    writeStore(3)
    const body = fs.readFileSync(storePath, 'utf8')
    fs.writeFileSync(storePath, body.trimEnd())
    expect(validateStore(storePath).failures).toContain('truncated')
  })
})

describe('maybeDailyBackup', () => {
  it('takes a snapshot with a verifiable sidecar', () => {
    writeStore(5)
    const out = maybeDailyBackup(root, storePath, day(2))
    expect(out.taken).toBe(true)
    const backups = listBackups(root)
    expect(backups).toHaveLength(1)
    expect(backups[0].count).toBe(5)
    expect(backups[0].sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('takes at most one snapshot per day', () => {
    writeStore(5)
    expect(maybeDailyBackup(root, storePath, day(2)).taken).toBe(true)
    _resetBackupProcessState() // simulate a fresh process, same day
    expect(maybeDailyBackup(root, storePath, day(2)).taken).toBe(false)
    expect(listBackups(root)).toHaveLength(1)
  })

  it('REFUSES to snapshot a corrupt store, leaving the last good one intact', () => {
    writeStore(5)
    maybeDailyBackup(root, storePath, day(2))
    const good = fs.readFileSync(listBackups(root)[0].path, 'utf8')

    fs.writeFileSync(storePath, '')
    _resetBackupProcessState()
    const out = maybeDailyBackup(root, storePath, day(3))

    expect(out.taken).toBe(false)
    expect(out.skipped).toBe('invalid')
    expect(listBackups(root)).toHaveLength(1)
    expect(fs.readFileSync(listBackups(root)[0].path, 'utf8')).toBe(good)
  })

  it('REFUSES a snapshot of a truncated store, using the last good count', () => {
    writeStore(100)
    maybeDailyBackup(root, storePath, day(2))
    writeStore(10) // as if truncated
    _resetBackupProcessState()
    expect(maybeDailyBackup(root, storePath, day(3)).skipped).toBe('invalid')
    expect(listBackups(root)[0].count).toBe(100)
  })

  it('retries later the same day once the store is repaired', () => {
    // Deliberately not marked done on failure — a user who fixes the file at
    // noon should get a snapshot, not wait until tomorrow.
    writeStore(5)
    fs.writeFileSync(storePath, '')
    expect(maybeDailyBackup(root, storePath, day(4)).taken).toBe(false)
    writeStore(5)
    expect(maybeDailyBackup(root, storePath, day(4)).taken).toBe(true)
  })

  it('does nothing when there is no store yet', () => {
    expect(maybeDailyBackup(root, storePath, day(2)).skipped).toBe('no-store')
  })

  it('rotates old snapshots but keeps the recent daily window', () => {
    for (let d = 1; d <= 12; d++) {
      writeStore(10 + d)
      _resetBackupProcessState()
      maybeDailyBackup(root, storePath, day(d))
    }
    const backups = listBackups(root)
    expect(backups.length).toBeLessThan(12)
    expect(backups.length).toBeGreaterThanOrEqual(7)
    // The newest seven days are always present.
    const stamps = backups.map(b => b.stamp)
    for (let d = 6; d <= 12; d++) expect(stamps).toContain(`2026-08-${String(d).padStart(2, '0')}`)
  })
})

describe('restore', () => {
  it('names what a restore would lose instead of rolling back silently', () => {
    writeStore(3)
    maybeDailyBackup(root, storePath, day(2))
    // Two engrams learned after the snapshot.
    const raw: any = yaml.load(fs.readFileSync(storePath, 'utf8'))
    raw.engrams.push(engram(90), engram(91))
    fs.writeFileSync(storePath, yaml.dump(raw))

    const plan = planRestore(root, storePath)
    expect(plan.integrityOk).toBe(true)
    expect(plan.wouldLose).toEqual(['ENG-2026-08-02-090', 'ENG-2026-08-02-091'])
  })

  it('names SAME-DAY engrams the snapshot cannot recover', () => {
    // Snapshots are daily, so everything learned after the morning's snapshot
    // is unprotected by it. Comparing history at day granularity would classify
    // all of it as "already backed up" — the exact false reassurance a restore
    // must not give. Regression for a bug found by running the CLI end to end.
    writeStore(1)
    const taken = new Date(Date.UTC(2026, 7, 2, 9, 0, 0))
    maybeDailyBackup(root, storePath, taken)

    fs.mkdirSync(path.join(root, 'history'), { recursive: true })
    fs.writeFileSync(
      path.join(root, 'history', 'events.jsonl'),
      [
        { event: 'engram_learned', engram_id: 'ENG-2026-08-02-050', timestamp: '2026-08-02T14:00:00.000Z' },
        { event: 'engram_learned', engram_id: 'ENG-2026-08-02-051', timestamp: '2026-08-02T15:00:00.000Z' },
        // Before the snapshot — already in it, must NOT be reported.
        { event: 'engram_learned', engram_id: 'ENG-2026-08-02-000', timestamp: '2026-08-02T08:00:00.000Z' },
      ].map(e => JSON.stringify(e)).join('\n') + '\n',
    )

    const plan = planRestore(root, storePath)
    expect(plan.unrecoverable).toEqual(['ENG-2026-08-02-050', 'ENG-2026-08-02-051'])
  })

  it('restores and keeps the pre-restore store aside', () => {
    writeStore(5)
    maybeDailyBackup(root, storePath, day(2))
    writeStore(1)

    const result = restoreBackup(root, storePath)
    expect(result.restored).toBe(true)
    expect(validateStore(storePath).count).toBe(5)
    // A restore made on a wrong assumption must not be the end of the line.
    expect(fs.existsSync(result.supersededPath)).toBe(true)
  })

  it('refuses to restore a backup whose bytes do not match its sidecar', () => {
    writeStore(5)
    maybeDailyBackup(root, storePath, day(2))
    const b = listBackups(root)[0]
    fs.appendFileSync(b.path, '# tampered\n')

    expect(() => restoreBackup(root, storePath)).toThrow(/sha256 does not match/i)
  })

  it('refuses to restore a backup that does not itself validate', () => {
    writeStore(5)
    maybeDailyBackup(root, storePath, day(2))
    const b = listBackups(root)[0]
    // Corrupt the backup AND its sidecar, so integrity passes but validity fails.
    fs.writeFileSync(b.path, '')
    fs.writeFileSync(`${b.path}.sha256`, `${'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'}  ${path.basename(b.path)}\n0 engrams\n`)

    expect(() => restoreBackup(root, storePath)).toThrow(/refusing to restore/i)
  })

  it('reports a clear error when there is nothing to restore from', () => {
    writeStore(2)
    expect(() => planRestore(root, storePath)).toThrow(/no backups found/i)
  })

  it('backups live under the backups/ directory', () => {
    writeStore(2)
    maybeDailyBackup(root, storePath, day(2))
    expect(fs.existsSync(path.join(root, BACKUP_DIR))).toBe(true)
  })
})
