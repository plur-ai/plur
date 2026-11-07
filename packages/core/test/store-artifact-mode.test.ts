// security audit 2026-11-06: files derived from the engram store are never wider than engrams.yaml.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'js-yaml'
import { maybeDailyBackup, _resetBackupProcessState } from '../src/backup.js'
import { appendHistory, appendHistoryBatch, type HistoryEvent } from '../src/history.js'
import { captureEpisode } from '../src/episodes.js'
import { saveTensions } from '../src/tension-store.js'
import { prepareIndexFiles } from '../src/storage-indexed.js'

let root: string
let storePath: string
const mode = (p: string) => fs.statSync(p).mode & 0o777
const event = (id: string, ts: string): HistoryEvent =>
  ({ event: 'engram_retired', engram_id: id, timestamp: ts, data: { reason: 'dummy forget reason' } })

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'plur-artifact-mode-'))
  storePath = path.join(root, 'engrams.yaml')
  fs.writeFileSync(storePath, yaml.dump({ engrams: [] }))
  fs.chmodSync(storePath, 0o600)
  _resetBackupProcessState()
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('store artifacts follow an owner-only engrams.yaml', () => {
  it.each<[string, () => string[]]>([
    ['daily snapshot and sidecar', () => {
      const dest = maybeDailyBackup(root, storePath, new Date('2026-12-01T10:00:00Z')).path!
      return [dest, `${dest}.sha256`, path.join(path.dirname(dest), '.state.json')]
    }],
    ['history month file', () => {
      appendHistory(root, event('ENG-2026-11-06-001', '2026-11-06T10:00:00.000Z'))
      const head = path.join(root, 'history', '.chain-head')
      return [path.join(root, 'history', '2026-11.jsonl'), ...(fs.existsSync(head) ? [head] : [])]
    }],
    ['batch history append', () => {
      appendHistoryBatch(root, [event('ENG-2026-11-06-002', '2026-10-06T10:00:00.000Z')])
      return [path.join(root, 'history', '2026-10.jsonl')]
    }],
    ['episodes.yaml and tensions.yaml', () => {
      captureEpisode(path.join(root, 'episodes.yaml'), 'dummy episode summary')
      saveTensions(path.join(root, 'tensions.yaml'), [])
      return [path.join(root, 'episodes.yaml'), path.join(root, 'tensions.yaml')]
    }],
    ['engrams.db, new or existing wider, narrowed by a tighter secondary store', () => {
      const db = path.join(root, 'engrams.db')
      prepareIndexFiles(db, [storePath])
      fs.chmodSync(storePath, 0o644)
      const secondary = path.join(root, 'other.yaml')
      fs.writeFileSync(secondary, 'engrams: []\n')
      fs.chmodSync(secondary, 0o600)
      fs.chmodSync(db, 0o664)
      prepareIndexFiles(db, [storePath, secondary])
      return [db]
    }],
  ])('%s', (_name, produce) => {
    const files = produce()
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(mode(f), f).toBe(0o600)
  })

  it('control: derived files take the store mode when it is wider', () => {
    fs.chmodSync(storePath, 0o644)
    captureEpisode(path.join(root, 'episodes.yaml'), 'dummy episode summary')
    expect(mode(path.join(root, 'episodes.yaml'))).toBe(0o644)
  })
})
