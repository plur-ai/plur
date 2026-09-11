import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, readHistory, type HistoryEvent } from '../src/history.js'

const fault = vi.hoisted(() => ({ sync: false, short: false }))
vi.mock('fs', async original => {
  const real = await original<typeof import('node:fs')>()
  return { ...real,
    fsyncSync: (fd: number) => { if (fault.sync) throw new Error('injected history sync failure'); return real.fsyncSync(fd) },
    writeSync: (fd: number, buffer: Buffer, offset: number, length: number) => real.writeSync(fd, buffer, offset, fault.short ? Math.min(5, length) : length),
  }
})
let root: string
const event: HistoryEvent = { timestamp: '2026-09-08T00:00:00Z', event: 'engram_created', engram_id: 'ENG-AUDIT-1', data: { statement: 'Private history 🗃️' } }
beforeEach(() => { root = fs.mkdtempSync(join(tmpdir(), 'plur-history-audit-')); fault.sync = false; fault.short = false })
afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

it('retains a valid Unicode event across short writes and an earlier interrupted append', () => {
  fs.mkdirSync(join(root, 'history'))
  const file = join(root, 'history', '2026-09.jsonl')
  fs.writeFileSync(file, '{"incomplete":')
  fault.short = true
  expect(appendHistory(root, event)).toBe(true)
  expect(readHistory(root, '2026-09')).toEqual([event])
  expect(fs.statSync(file).mode & 0o777).toBe(0o600)
})

it('reports failed persistence instead of returning a successful history acknowledgement', () => {
  fault.sync = true
  expect(appendHistory(root, event)).toBe(false)
})

it('contains malformed timestamp paths without creating a file outside history', () => {
  expect(appendHistory(root, { ...event, timestamp: '../escape' })).toBe(false)
  expect(fs.existsSync(join(root, 'escape.jsonl'))).toBe(false)
})
