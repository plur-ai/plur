/**
 * Files PLUR derives from the engram store are never readable by more accounts
 * than engrams.yaml itself (security audit 2026-11-06).
 *
 * atomicWrite keeps an existing engrams.yaml at the mode the owner set, so a
 * `chmod 600` on the store survives every save. The daily backup snapshot and
 * its sidecar, the history log and its chain-head sidecar, episodes.yaml and
 * tensions.yaml used to be born at the umask default (0644/0664), copying store
 * content into files another local account could read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { maybeDailyBackup, _resetBackupProcessState } from '../src/backup.js'
import { appendHistory, appendHistoryBatch, type HistoryEvent } from '../src/history.js'
import { captureEpisode } from '../src/episodes.js'
import { saveTensions } from '../src/tension-store.js'

const isPosix = process.platform !== 'win32'

let root: string
let storePath: string

function mode(p: string): number {
  return fs.statSync(p).mode & 0o777
}

function writeOwnerOnlyStore(): void {
  fs.writeFileSync(storePath, yaml.dump({
    engrams: [{
      id: 'ENG-2026-11-06-001',
      statement: 'dummy private local fact',
      type: 'behavioral',
      status: 'active',
      confidence: 0.5,
      created: '2026-11-06',
      scope: 'local',
    }],
  }))
  fs.chmodSync(storePath, 0o600)
}

function event(id: string, ts: string): HistoryEvent {
  return { event: 'engram_retired', engram_id: id, timestamp: ts, data: { reason: 'dummy forget reason' } }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-artifact-mode-'))
  storePath = path.join(root, 'engrams.yaml')
  _resetBackupProcessState()
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!isPosix)('store artifacts follow an owner-only engrams.yaml', () => {
  it('daily snapshot, its sidecar and backups/ are owner-only', () => {
    writeOwnerOnlyStore()
    const out = maybeDailyBackup(root, storePath, new Date('2026-12-01T10:00:00Z'))
    expect(out.taken).toBe(true)
    const dest = out.path!
    expect(mode(dest)).toBe(0o600)
    expect(mode(`${dest}.sha256`)).toBe(0o600)
    expect(mode(path.dirname(dest)) & 0o077).toBe(0)
    expect(mode(path.join(path.dirname(dest), '.state.json')) & 0o077).toBe(0)
  })

  it('history month file, chain-head sidecar and history/ are owner-only', () => {
    writeOwnerOnlyStore()
    expect(appendHistory(root, event('ENG-2026-11-06-001', '2026-11-06T10:00:00.000Z'))).toBe(true)
    const historyDir = path.join(root, 'history')
    expect(mode(historyDir) & 0o077).toBe(0)
    expect(mode(path.join(historyDir, '2026-11.jsonl'))).toBe(0o600)
    const head = path.join(historyDir, '.chain-head')
    if (fs.existsSync(head)) expect(mode(head)).toBe(0o600)
  })

  it('batch history append creates owner-only files', () => {
    writeOwnerOnlyStore()
    expect(appendHistoryBatch(root, [event('ENG-2026-11-06-002', '2026-10-06T10:00:00.000Z')])).toBe(true)
    expect(mode(path.join(root, 'history')) & 0o077).toBe(0)
    expect(mode(path.join(root, 'history', '2026-10.jsonl'))).toBe(0o600)
  })

  it('episodes.yaml and tensions.yaml are owner-only', () => {
    writeOwnerOnlyStore()
    captureEpisode(path.join(root, 'episodes.yaml'), 'dummy episode summary')
    expect(mode(path.join(root, 'episodes.yaml'))).toBe(0o600)
    saveTensions(path.join(root, 'tensions.yaml'), [])
    expect(mode(path.join(root, 'tensions.yaml'))).toBe(0o600)
  })

  it('derived files take the store mode when it is wider, too (parity)', () => {
    fs.writeFileSync(storePath, yaml.dump({ engrams: [] }))
    fs.chmodSync(storePath, 0o644)
    captureEpisode(path.join(root, 'episodes.yaml'), 'dummy episode summary')
    expect(mode(path.join(root, 'episodes.yaml'))).toBe(0o644)
  })
})
