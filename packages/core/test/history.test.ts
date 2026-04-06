import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { appendHistory, readHistory, listHistoryMonths, type HistoryEvent } from '../src/history.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-history-'))
}

describe('history', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  describe('appendHistory', () => {
    it('creates history directory and file on first write', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-2026-0406-001',
        timestamp: '2026-04-06T12:00:00.000Z',
        data: { type: 'behavioral' },
      }
      appendHistory(dir, event)
      const historyDir = path.join(dir, 'history')
      expect(fs.existsSync(historyDir)).toBe(true)
      expect(fs.existsSync(path.join(historyDir, '2026-04.jsonl'))).toBe(true)
    })

    it('appends multiple events to the same file', () => {
      const event1: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-2026-0406-001',
        timestamp: '2026-04-06T12:00:00.000Z',
        data: {},
      }
      const event2: HistoryEvent = {
        event: 'feedback_received',
        engram_id: 'ENG-2026-0406-001',
        timestamp: '2026-04-06T13:00:00.000Z',
        data: { signal: 'positive' },
      }
      appendHistory(dir, event1)
      appendHistory(dir, event2)
      const content = fs.readFileSync(path.join(dir, 'history', '2026-04.jsonl'), 'utf8')
      const lines = content.trim().split('\n')
      expect(lines.length).toBe(2)
    })

    it('writes to different files for different months', () => {
      appendHistory(dir, {
        event: 'engram_created',
        engram_id: 'ENG-2026-0406-001',
        timestamp: '2026-04-06T12:00:00.000Z',
        data: {},
      })
      appendHistory(dir, {
        event: 'engram_retired',
        engram_id: 'ENG-2026-0406-001',
        timestamp: '2026-05-01T12:00:00.000Z',
        data: {},
      })
      const historyDir = path.join(dir, 'history')
      expect(fs.existsSync(path.join(historyDir, '2026-04.jsonl'))).toBe(true)
      expect(fs.existsSync(path.join(historyDir, '2026-05.jsonl'))).toBe(true)
    })
  })

  describe('readHistory', () => {
    it('returns empty array when no file exists', () => {
      expect(readHistory(dir, '2026-04')).toEqual([])
    })

    it('reads back written events', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-2026-0406-001',
        timestamp: '2026-04-06T12:00:00.000Z',
        data: { type: 'behavioral' },
      }
      appendHistory(dir, event)
      const events = readHistory(dir, '2026-04')
      expect(events.length).toBe(1)
      expect(events[0].event).toBe('engram_created')
      expect(events[0].engram_id).toBe('ENG-2026-0406-001')
      expect(events[0].data.type).toBe('behavioral')
    })

    it('skips malformed lines gracefully', () => {
      const historyDir = path.join(dir, 'history')
      fs.mkdirSync(historyDir, { recursive: true })
      fs.writeFileSync(
        path.join(historyDir, '2026-04.jsonl'),
        '{"event":"engram_created","engram_id":"E1","timestamp":"2026-04-06T00:00:00Z","data":{}}\nnot json\n{"event":"engram_retired","engram_id":"E2","timestamp":"2026-04-06T01:00:00Z","data":{}}\n',
      )
      const events = readHistory(dir, '2026-04')
      expect(events.length).toBe(2)
    })
  })

  describe('listHistoryMonths', () => {
    it('returns empty when no history dir', () => {
      expect(listHistoryMonths(dir)).toEqual([])
    })

    it('lists all months with history', () => {
      appendHistory(dir, {
        event: 'engram_created',
        engram_id: 'E1',
        timestamp: '2026-03-15T00:00:00Z',
        data: {},
      })
      appendHistory(dir, {
        event: 'engram_created',
        engram_id: 'E2',
        timestamp: '2026-04-06T00:00:00Z',
        data: {},
      })
      const months = listHistoryMonths(dir)
      expect(months).toEqual(['2026-03', '2026-04'])
    })
  })
})
