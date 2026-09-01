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
  attestStore,
  tailSeekLastHash,
  countEngramsInStore,
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
      // 42 is deliberately a lie. The count must come from the store the hash
      // covers, not from the caller — an attested count that is not bound to
      // the hash beside it is not attested at all.
      const data = emitCheckpoint(dir, engramsPath, 'cli')
      expect(typeof data.store_hash).toBe('string')
      expect(data.store_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof data.engram_count).toBe('number')
      expect(data.engram_count).toBe(0) // engrams: [] — the store, not the argument
      expect(data.actor).toBe('cli')
      // chain_head is null on genesis (no prior chained events)
      expect(data.chain_head).toBeNull()
    })

    it('store_hash matches hashEngramsFile for the same path', () => {
      const engramsPath = path.join(dir, 'engrams.yaml')
      const data = emitCheckpoint(dir, engramsPath, 'cli')
      expect(data.store_hash).toBe(hashEngramsFile(engramsPath))
    })

    it('actor field is preserved verbatim', () => {
      const engramsPath = path.join(dir, 'engrams.yaml')
      const data = emitCheckpoint(dir, engramsPath, 'session_end')
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
      emitCheckpoint(dir, engramsPath, 'cli', ts)
      const events = readHistory(dir, '2026-04')
      expect(events).toHaveLength(1)
      expect(events[0].event).toBe('checkpoint')
    })

    it('checkpoint event has empty engram_id (store-level event)', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      emitCheckpoint(dir, engramsPath, 'cli', ts)
      const [ev] = readHistory(dir, '2026-04')
      expect(ev.engram_id).toBe('')
    })

    it('checkpoint event is itself hash-chained (has hash and prev)', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      emitCheckpoint(dir, engramsPath, 'cli', ts)
      const [ev] = readHistory(dir, '2026-04')
      expect(ev.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(ev.prev).toBeNull() // genesis
    })

    it('checkpoint event hash round-trips correctly', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      emitCheckpoint(dir, engramsPath, 'cli', ts)
      const [stored] = readHistory(dir, '2026-04')
      // Recomputing from stored event (excluding stored.hash) must match
      const recomputed = computeEventHash(stored)
      expect(recomputed).toBe(stored.hash)
    })

    it('checkpoint data payload is stored in event.data', () => {
      const ts = '2026-04-15T10:00:00.000Z'
      const engramsPath = path.join(dir, 'engrams.yaml')
      const cp = emitCheckpoint(dir, engramsPath, 'session_end', ts)
      const [ev] = readHistory(dir, '2026-04')
      const d = ev.data as Record<string, unknown>
      expect(d.store_hash).toBe(cp.store_hash)
      expect(d.engram_count).toBe(0) // derived from the store, not the caller's 7
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
      emitCheckpoint(dir, engramsPath, 'cli', ts2)
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
      emitCheckpoint(dir, engramsPath, 'cli', ts2)

      const events = readHistory(dir, '2026-04')
      const cpEvent = events[1]
      const d = cpEvent.data as Record<string, unknown>
      expect(d.chain_head).toBe(cpEvent.prev)
    })

    it('two checkpoints chain correctly — second links to first', () => {
      const engramsPath = path.join(dir, 'engrams.yaml')
      const ts1 = '2026-04-15T10:00:00.000Z'
      const ts2 = '2026-04-15T11:00:00.000Z'

      emitCheckpoint(dir, engramsPath, 'cli', ts1)
      emitCheckpoint(dir, engramsPath, 'cli', ts2)

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

      emitCheckpoint(dir, engramsPath, 'cli', tsApril)
      emitCheckpoint(dir, engramsPath, 'cli', tsMay)

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

// ── The attested count and hash describe the same bytes ─────────────────────

describe('checkpoint attestation is bound to the store it hashes', () => {
  it('counts the engrams actually present', () => {
    // THE DEFECT THIS GUARDS: engram_count was whatever the caller passed, so
    // `emitCheckpoint(root, path, 99999, 'cli')` against a one-engram store
    // wrote 99999 verbatim into an object meant for external anchoring. The
    // count parameter no longer exists -- a stale call is now a type error
    // rather than a number that quietly stops mattering.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-count-'))
    const engramsPath = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(engramsPath,
      'engrams:\n  - id: ENG-001\n    status: active\n  - id: ENG-002\n    status: active\n', 'utf8')

    const d = emitCheckpoint(dir, engramsPath, 'cli')
    expect(d.engram_count).toBe(2)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('store_hash survives re-serialisation — it attests content, not bytes', () => {
    // Raw-byte hashing made an anchored store_hash prove only that someone
    // holds a byte-identical copy: LF vs CRLF, or a trailing newline, changed
    // the digest over identical YAML. It would not survive git autocrlf, a
    // different emitter, or a different OS.
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lf-'))
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-crlf-'))
    const yamlLf = 'engrams:\n  - id: ENG-001\n    status: active\n'
    fs.writeFileSync(path.join(a, 'engrams.yaml'), yamlLf, 'utf8')
    fs.writeFileSync(path.join(b, 'engrams.yaml'), yamlLf.replace(/\n/g, '\r\n'), 'utf8')

    const da = emitCheckpoint(a, path.join(a, 'engrams.yaml'), 'cli')
    const db = emitCheckpoint(b, path.join(b, 'engrams.yaml'), 'cli')
    expect(da.store_hash).toBe(db.store_hash)

    fs.rmSync(a, { recursive: true, force: true })
    fs.rmSync(b, { recursive: true, force: true })
  })

  it('chain_head equals the event own prev — they cannot drift apart', () => {
    // 76/300 checkpoints disagreed with their own prev at 200 KB, because
    // chain_head was computed, then file I/O happened, then appendHistory
    // recomputed prev independently. The payload meant for anchoring was the
    // field that went wrong.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-drift-'))
    const engramsPath = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(engramsPath, 'engrams: []\n', 'utf8')
    appendHistory(dir, {
      event: 'engram_created', engram_id: 'ENG-1',
      timestamp: new Date().toISOString(), data: {},
    })
    const d = emitCheckpoint(dir, engramsPath, 'cli')

    const months = fs.readdirSync(path.join(dir, 'history')).filter(f => f.endsWith('.jsonl'))
    const evs = months.flatMap(m =>
      fs.readFileSync(path.join(dir, 'history', m), 'utf8').split('\n')
        .filter(l => l.trim()).map(l => JSON.parse(l) as HistoryEvent))
    const cp = evs.find(e => e.event === 'checkpoint')!
    expect(d.chain_head).toBe(cp.prev)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

// ── One read, or the two values can describe different stores ───────────────

describe('attestStore reads once and fails closed', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-attest-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('derives hash and count from the SAME bytes', () => {
    // Two separate readFileSync calls left a window for a concurrent learn() to
    // land between them, after which the checkpoint asserted a count for a
    // store state its own hash did not describe -- undetectable downstream,
    // because both values were individually well-formed.
    const p = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(p, 'engrams:\n  - id: ENG-001\n    status: active\n', 'utf8')

    const first = attestStore(p)
    expect(first.engram_count).toBe(1)

    // Simulate the concurrent write, then re-attest: BOTH values must move
    // together. If they were read separately, one could describe each state.
    fs.writeFileSync(p, 'engrams:\n  - id: ENG-001\n    status: active\n  - id: ENG-002\n    status: active\n', 'utf8')
    const second = attestStore(p)
    expect(second.engram_count).toBe(2)
    expect(second.store_hash).not.toBe(first.store_hash)
  })

  it('agrees with hashEngramsFile and countEngramsInStore', () => {
    const p = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(p, 'engrams:\n  - id: ENG-001\n    status: active\n', 'utf8')
    const a = attestStore(p)
    expect(a.store_hash).toBe(hashEngramsFile(p))
    expect(a.engram_count).toBe(countEngramsInStore(p))
  })

  it('THROWS on a malformed store rather than attesting a count of 0', () => {
    // The previous `catch { return 0 }` produced a checkpoint claiming "0
    // engrams" beside a hash of the real file: a FALSE attestation, which is
    // worse than none. A checkpoint that cannot be computed honestly must not
    // be written at all.
    const p = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(p, 'this: is not a store\n', 'utf8')
    expect(() => attestStore(p)).toThrow(/cannot checkpoint/)
    expect(() => emitCheckpoint(dir, p, 'cli')).toThrow(/cannot checkpoint/)
  })

  it('THROWS on unparseable YAML rather than degrading', () => {
    const p = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(p, 'engrams:\n  - [unclosed\n', 'utf8')
    expect(() => attestStore(p)).toThrow()
  })

  it('writes NO checkpoint event when attestation fails', () => {
    // Fail-closed must mean nothing lands, not a half-written event.
    const p = path.join(dir, 'engrams.yaml')
    fs.writeFileSync(p, 'this: is not a store\n', 'utf8')
    expect(() => emitCheckpoint(dir, p, 'cli')).toThrow()
    const historyDir = path.join(dir, 'history')
    const files = fs.existsSync(historyDir) ? fs.readdirSync(historyDir).filter(f => f.endsWith('.jsonl')) : []
    const events = files.flatMap(f =>
      fs.readFileSync(path.join(historyDir, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)))
    expect(events.filter(e => e.event === 'checkpoint')).toHaveLength(0)
  })
})

// ── A long event must not silently become a chain gap ───────────────────────

describe('tailSeekLastHash handles events larger than the tail window', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-tail-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('reads the hash of an event line far longer than 8 KiB', () => {
    // A fixed 8 KiB window lands entirely inside a longer final line: the
    // buffer starts mid-record, JSON.parse fails, null comes back, and the next
    // append chains from nothing -- a gap over a log that is perfectly intact.
    // `data` is Record<string, unknown>; a co_injection with a large id array
    // gets here without anything unusual happening.
    const bigIds = Array.from({ length: 4000 }, (_, i) => 'ENG-2026-0101-' + String(i).padStart(6, '0'))
    appendHistory(dir, {
      event: 'co_injection',
      engram_id: 'inj-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      data: { ids: bigIds, query_hash: 'abc123' },
    })

    const file = path.join(dir, 'history', '2026-01.jsonl')
    expect(fs.statSync(file).size).toBeGreaterThan(8192)

    const written = JSON.parse(fs.readFileSync(file, 'utf8').trim()) as HistoryEvent
    expect(tailSeekLastHash(file)).toBe(written.hash)
  })

  it('a large event does not break the chain for the NEXT event', () => {
    // The consequence that matters: the following event must chain onto it,
    // not declare a gap.
    const bigIds = Array.from({ length: 4000 }, (_, i) => 'ENG-2026-0101-' + String(i).padStart(6, '0'))
    appendHistory(dir, {
      event: 'co_injection', engram_id: 'inj-1',
      timestamp: '2026-01-01T00:00:00.000Z', data: { ids: bigIds },
    })
    appendHistory(dir, {
      event: 'engram_created', engram_id: 'ENG-2026-0101-001',
      timestamp: '2026-01-01T00:01:00.000Z', data: {},
    })

    const events = readHistory(dir, '2026-01')
    expect(events).toHaveLength(2)
    expect(events[1].prev, 'second event declared a gap over an intact log').toBe(events[0].hash)
    expect(events[1].prev).not.toBeNull()
  })

  it('still returns a gap for a file with no line boundary at all', () => {
    // The ceiling must hold: a corrupt file with no newline is a documented
    // gap, never an unbounded read on the write path.
    const historyDir = path.join(dir, 'history')
    fs.mkdirSync(historyDir, { recursive: true })
    const file = path.join(historyDir, '2026-01.jsonl')
    fs.writeFileSync(file, 'x'.repeat(2 * 1024 * 1024), 'utf8')
    expect(tailSeekLastHash(file)).toBeNull()
  })
})
