/**
 * #1052 — Checkpoint events: the anchorable object.
 *
 * Tests for:
 *   - CheckpointData payload shape
 *   - hashEngramsFile: SHA-256 of engrams.yaml bytes
 *   - emitCheckpoint: writes a 'checkpoint' history event that chains correctly
 *   - Two checkpoints chain across a month boundary (uses existing cross-month mechanism)
 *   - Checkpoint event round-trips through readHistory
 *   - store_hash is never computed on non-checkpoint writes (no stat side-effects)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  emitCheckpoint,
  hashEngramsFile,
  appendHistory,
  readHistory,
  computeEventHash,
  type HistoryEvent,
} from '../src/history.js'

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-checkpoint-'))
}

function writeEngrams(dir: string, content: string): string {
  const p = path.join(dir, 'engrams.yaml')
  fs.writeFileSync(p, content, 'utf8')
  return p
}

describe('checkpoint events (#1052)', () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
    // Minimal required files for Plur (not needed for direct history calls,
    // but ensures emitCheckpoint can find engrams.yaml)
    fs.writeFileSync(path.join(dir, 'engrams.yaml'), 'engrams: []\n', 'utf8')
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // ---------------------------------------------------------------------------
  // hashEngramsFile
  // ---------------------------------------------------------------------------

  describe('hashEngramsFile', () => {
    it('returns a 64-char lowercase hex SHA-256', () => {
      const engramsPath = writeEngrams(dir, 'engrams: []\n')
      const h = hashEngramsFile(engramsPath)
      expect(h).toMatch(/^[0-9a-f]{64}$/)
    })

    it('different file contents produce different hashes', () => {
      const p1 = writeEngrams(dir, 'engrams: []\n')
      const h1 = hashEngramsFile(p1)
      fs.writeFileSync(p1, 'engrams:\n  - id: ENG-001\n    statement: hello\n', 'utf8')
      const h2 = hashEngramsFile(p1)
      expect(h1).not.toBe(h2)
    })

    it('same bytes always produce the same hash (deterministic)', () => {
      const content = 'engrams:\n  - id: ENG-001\n    statement: hello world\n'
      const p = writeEngrams(dir, content)
      expect(hashEngramsFile(p)).toBe(hashEngramsFile(p))
    })

    it('throws when the file does not exist', () => {
      expect(() => hashEngramsFile(path.join(dir, 'nonexistent.yaml'))).toThrow()
    })
  })

  // ---------------------------------------------------------------------------
  // emitCheckpoint — payload shape
  // ---------------------------------------------------------------------------

  describe('emitCheckpoint payload', () => {
    it('returns a CheckpointData with all required fields', () => {
      const engramsPath = path.join(dir, 'engrams.yaml')
      const data = emitCheckpoint(dir, engramsPath, 42, 'cli')
      expect(typeof data.store_hash).toBe('string')
      expect(data.store_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof data.engram_count).toBe('number')
      expect(data.engram_count).toBe(42)
      expect(data.actor).toBe('cli')
      // chain_head is null on genesis (no prior chained events)
      expect(data.chain_head).toBeNull()
    })

    it('store_hash matches hashEngramsFile for the same path', () => {
      const engramsPath = path.join(dir, 'engrams.yaml')
      const data = emitCheckpoint(dir, engramsPath, 0, 'cli')
      expect(data.store_hash).toBe(hashEngramsFile(engramsPath))
    })

    it('actor field is preserved verbatim', () => {
      const engramsPath = path.join(dir, 'engrams.yaml')
      const data = emitCheckpoint(dir, engramsPath, 0, 'session_end')
      expect(data.actor).toBe('session_end')
    })
  })

  // ---------------------------------------------------------------------------
  // emitCheckpoint — written history event
  // ---------------------------------------------------------------------------

  describe('emitCheckpoint history event', () => {
    it('writes a checkpoint event to the correct month file', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      emitCheckpoint(dir, engramsPath, 5, 'cli', ts)
      const events = readHistory(dir, '2026-04')
      expect(events).toHaveLength(1)
      expect(events[0].event).toBe('checkpoint')
    })

    it('checkpoint event has empty engram_id (store-level event)', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      emitCheckpoint(dir, engramsPath, 5, 'cli', ts)
      const [ev] = readHistory(dir, '2026-04')
      expect(ev.engram_id).toBe('')
    })

    it('checkpoint event is itself hash-chained (has hash and prev)', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      emitCheckpoint(dir, engramsPath, 5, 'cli', ts)
      const [ev] = readHistory(dir, '2026-04')
      expect(ev.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(ev.prev).toBeNull() // genesis
    })

    it('checkpoint event hash round-trips correctly', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      emitCheckpoint(dir, engramsPath, 5, 'cli', ts)
      const [stored] = readHistory(dir, '2026-04')
      // Recomputing from stored event (excluding stored.hash) must match
      const recomputed = computeEventHash(stored)
      expect(recomputed).toBe(stored.hash)
    })

    it('checkpoint data payload is stored in event.data', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      const cp = emitCheckpoint(dir, engramsPath, 7, 'session_end', ts)
      const [ev] = readHistory(dir, '2026-04')
      const d = ev.data as Record<string, unknown>
      expect(d.store_hash).toBe(cp.store_hash)
      expect(d.engram_count).toBe(7)
      expect(d.actor).toBe('session_end')
      expect(d.chain_head).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // chain linkage: checkpoint chains onto prior events
  // ---------------------------------------------------------------------------

  describe('checkpoint chain linkage', () => {
    it('first checkpoint after a regular event links its prev to that event\'s hash', () => {
      const ts1 = '2026-04-15T10:00:00.000Z'
      const ts2 = '2026-04-15T10:01:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')

      // Write a regular event first
      const regularEvent: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: ts1,
        data: { statement: 'test' },
      }
      appendHistory(dir, regularEvent)
      const [written] = readHistory(dir, '2026-04')

      // Now emit a checkpoint
      emitCheckpoint(dir, engramsPath, 1, 'cli', ts2)
      const events = readHistory(dir, '2026-04')
      expect(events).toHaveLength(2)
      const cpEvent = events[1]
      // checkpoint's prev must equal the regular event's hash
      expect(cpEvent.prev).toBe(written.hash)
    })

    it('chain_head in data matches prev in the event envelope', () => {
      const ts1 = '2026-04-15T10:00:00.000Z'
      const ts2 = '2026-04-15T10:01:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')

      const regularEvent: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: ts1,
        data: {},
      }
      appendHistory(dir, regularEvent)
      emitCheckpoint(dir, engramsPath, 1, 'cli', ts2)

      const events = readHistory(dir, '2026-04')
      const cpEvent = events[1]
      const d = cpEvent.data as Record<string, unknown>
      expect(d.chain_head).toBe(cpEvent.prev)
    })

    it('two checkpoints chain correctly — second links to first', () => {
      const engramsPath = path.join(dir, 'engrams.yaml')
      const ts1 = '2026-04-15T10:00:00.000Z'
      const ts2 = '2026-04-15T11:00:00.000Z'

      emitCheckpoint(dir, engramsPath, 0, 'cli', ts1)
      emitCheckpoint(dir, engramsPath, 0, 'cli', ts2)

      const events = readHistory(dir, '2026-04')
      expect(events).toHaveLength(2)
      expect(events[1].prev).toBe(events[0].hash)
    })
  })

  // ---------------------------------------------------------------------------
  // month-boundary chaining
  // ---------------------------------------------------------------------------

  describe('two checkpoints chain across a month boundary', () => {
    it('May checkpoint prev links back to April checkpoint hash', () => {
      const engramsPath = path.join(dir, 'engrams.yaml')
      const tsApril = '2026-04-30T23:59:00.000Z'
      const tsMay   = '2026-05-01T00:01:00.000Z'

      emitCheckpoint(dir, engramsPath, 10, 'cli', tsApril)
      emitCheckpoint(dir, engramsPath, 10, 'cli', tsMay)

      const aprilEvents = readHistory(dir, '2026-04')
      const mayEvents   = readHistory(dir, '2026-05')
      expect(aprilEvents).toHaveLength(1)
      expect(mayEvents).toHaveLength(1)

      // May's checkpoint links back to April's checkpoint
      expect(mayEvents[0].prev).toBe(aprilEvents[0].hash)

      // chain_head in May's data also reflects April's hash
      const d = mayEvents[0].data as Record<string, unknown>
      expect(d.chain_head).toBe(aprilEvents[0].hash)
    })
  })

  // ---------------------------------------------------------------------------
  // hashing is not performed on regular history writes
  // ---------------------------------------------------------------------------

  describe('store_hash not computed on regular events', () => {
    it('regular appendHistory events have no store_hash in data', () => {
      const regularEvent: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-15T10:00:00.000Z',
        data: { statement: 'test' },
      }
      appendHistory(dir, regularEvent)
      const [ev] = readHistory(dir, '2026-04')
      expect((ev.data as Record<string, unknown>).store_hash).toBeUndefined()
    })
  })
})
