import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import {
  PAYLOAD_DROP_LOG_MAX_ENTRIES,
  payloadDropLogPath,
  readPayloadDropLog,
  recordPayloadDrop,
  type PayloadDropRecord,
} from '../src/drop-log.js'

// Bounded, values-free forensic log for #772 payload drops. These tests pin
// the file-level contract; the wire-level behavior (what gets logged when a
// dropped frame arrives) is pinned in server.test.ts.
describe('payload drop log (#772)', () => {
  let dir: string

  const record = (n: number): PayloadDropRecord => ({
    ts: new Date().toISOString(),
    tool: 'plur_learn',
    arguments_wire: 'empty_object',
    params_keys: ['name', 'arguments'],
    received_fields: [],
    missing_fields: ['statement'],
    request_id: n,
    server_version: '0.0.0-test',
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'plur-drop-log-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates logs/payload-drops.jsonl under the storage root', () => {
    recordPayloadDrop(dir, record(1))
    expect(payloadDropLogPath(dir)).toBe(join(dir, 'logs', 'payload-drops.jsonl'))
    const records = readPayloadDropLog(dir)
    expect(records.length).toBe(1)
    expect(records[0].tool).toBe('plur_learn')
    expect(records[0].request_id).toBe(1)
  })

  it('is bounded: never grows past PAYLOAD_DROP_LOG_MAX_ENTRIES, keeping the newest', () => {
    const total = PAYLOAD_DROP_LOG_MAX_ENTRIES + 10
    for (let i = 0; i < total; i++) recordPayloadDrop(dir, record(i))
    const records = readPayloadDropLog(dir)
    expect(records.length).toBe(PAYLOAD_DROP_LOG_MAX_ENTRIES)
    // Oldest 10 trimmed; newest kept in order.
    expect(records[0].request_id).toBe(10)
    expect(records[records.length - 1].request_id).toBe(total - 1)
  })

  it('read tolerates a corrupt line without losing the rest', () => {
    recordPayloadDrop(dir, record(1))
    const path = payloadDropLogPath(dir)
    const intact = readFileSync(path, 'utf8')
    writeFileSync(path, 'not json at all\n' + intact)
    const records = readPayloadDropLog(dir)
    expect(records.length).toBe(1)
    expect(records[0].request_id).toBe(1)
  })

  it('read of a missing file returns []', () => {
    expect(readPayloadDropLog(dir)).toEqual([])
  })

  it('write failures are swallowed — diagnostics never throw', () => {
    // Make the logs path unwritable by occupying it with a FILE where the
    // directory should be.
    const logsDir = dirname(payloadDropLogPath(dir))
    writeFileSync(logsDir, 'a file squatting on the logs directory path')
    expect(() => recordPayloadDrop(dir, record(1))).not.toThrow()
    expect(readPayloadDropLog(dir)).toEqual([])
  })
})
