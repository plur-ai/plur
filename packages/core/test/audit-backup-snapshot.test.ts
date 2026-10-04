/** Invariant: validation, checksum, and restore refer to identical bytes;
 * repeat attempts never overwrite an existing recovery snapshot. */
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import yaml from 'js-yaml'
import { _resetBackupProcessState, maybeDailyBackup, restoreBackup, listBackups } from '../src/backup.js'
import { EngramSchemaPassthrough } from '../src/schemas/engram.js'

const probe = vi.hoisted(() => ({ target: '', reads: 0, swap: '' }))
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, readFileSync: (...args: any[]) => {
    const result = (real.readFileSync as any)(...args)
    if (args[0] === probe.target && ++probe.reads === 1) real.writeFileSync(probe.target, probe.swap)
    return result
  } }
})
let root: string
let store: string
function content(n: number) {
  return yaml.dump({ engrams: Array.from({ length: n }, (_, i) => EngramSchemaPassthrough.parse({
    id: `ENG-2026-09-08-${i}`, scope: 'local', type: 'behavioral', status: 'active', statement: `Keep fact ${i}`,
  })) })
}
beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'plur-backup-snapshot-')); store = join(root, 'engrams.yaml')
  probe.target = ''; probe.reads = 0; probe.swap = ''; _resetBackupProcessState()
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

it('snapshots exactly the validated bytes if the path changes after the read', () => {
  const good = content(2)
  fs.writeFileSync(store, good)
  probe.target = store; probe.swap = 'corrupt: ['
  const result = maybeDailyBackup(root, store)
  expect(result.taken).toBe(true)
  expect(fs.readFileSync(result.path!, 'utf8')).toBe(good)
})

it('restores exactly the checksum-verified bytes despite a replaced backup path', () => {
  const good = content(2)
  fs.writeFileSync(store, good); maybeDailyBackup(root, store)
  const backup = listBackups(root)[0]
  fs.writeFileSync(store, content(1))
  probe.target = backup.path; probe.swap = content(3)
  restoreBackup(root, store)
  expect(fs.readFileSync(store, 'utf8')).toBe(good)
})

it('never overwrites a same-day recovery snapshot when state metadata is lost', () => {
  const good = content(2)
  fs.writeFileSync(store, good); maybeDailyBackup(root, store)
  const backup = listBackups(root)[0]
  fs.unlinkSync(join(root, 'backups', '.state.json'))
  fs.writeFileSync(store, content(3)); _resetBackupProcessState()
  maybeDailyBackup(root, store)
  expect(fs.readFileSync(backup.path, 'utf8')).toBe(good)
})

it('preserves separate pre-restore copies when restores share a timestamp', () => {
  fs.writeFileSync(store, content(1)); maybeDailyBackup(root, store)
  vi.spyOn(Date, 'now').mockReturnValue(1234567890)
  try {
    fs.writeFileSync(store, content(2)); const first = restoreBackup(root, store)
    fs.writeFileSync(store, content(3)); const second = restoreBackup(root, store)
    expect(first.supersededPath).not.toBe(second.supersededPath)
    expect(fs.readFileSync(first.supersededPath, 'utf8')).toBe(content(2))
    expect(fs.readFileSync(second.supersededPath, 'utf8')).toBe(content(3))
  } finally { vi.restoreAllMocks() }
})

it('repairs a lost state hint from an intact same-day snapshot, so the check runs once', () => {
  fs.writeFileSync(store, content(2)); maybeDailyBackup(root, store)
  const backup = listBackups(root)[0]
  const statePath = join(root, 'backups', '.state.json')
  const hint = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  fs.unlinkSync(statePath); _resetBackupProcessState()

  expect(maybeDailyBackup(root, store).skipped).toBe('already-today')
  // The hint is back, with the snapshot's own count and checksum…
  expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toEqual(hint)
  // …and the process remembers the answer: even with the hint gone again,
  // there is no second snapshot inspection.
  fs.unlinkSync(statePath)
  const reads = vi.spyOn(fs, 'readdirSync')
  try {
    expect(maybeDailyBackup(root, store).skipped).toBe('already-today')
    expect(reads).not.toHaveBeenCalled()
  } finally { reads.mockRestore() }
  expect(fs.readFileSync(backup.path, 'utf8')).toBe(content(2))
})

it('replaces an unverifiable same-day snapshot with a fresh verified one, keeping the old bytes aside', () => {
  fs.writeFileSync(store, content(2)); maybeDailyBackup(root, store)
  const backup = listBackups(root)[0]
  fs.writeFileSync(backup.path, 'damaged\n')
  fs.unlinkSync(join(root, 'backups', '.state.json'))
  fs.writeFileSync(store, content(3)); _resetBackupProcessState()

  const result = maybeDailyBackup(root, store)
  expect(result.taken).toBe(true)
  expect(fs.readFileSync(backup.path, 'utf8')).toBe(content(3))
  const fresh = listBackups(root)
  expect(fresh).toHaveLength(1)
  expect(fresh[0].count).toBe(3)
  const aside = fs.readdirSync(join(root, 'backups')).filter(f => f.includes('.unverified-') && !f.endsWith('.sha256'))
  expect(aside).toHaveLength(1)
  expect(fs.readFileSync(join(root, 'backups', aside[0]), 'utf8')).toBe('damaged\n')
})

it.skipIf(process.platform === 'win32')('keeps the pre-restore copy as private as the store', () => {
  fs.writeFileSync(store, content(1)); maybeDailyBackup(root, store)
  fs.writeFileSync(store, content(2)); fs.chmodSync(store, 0o600)
  const restored = restoreBackup(root, store)
  expect(fs.statSync(restored.supersededPath).mode & 0o777).toBe(0o600)
})
