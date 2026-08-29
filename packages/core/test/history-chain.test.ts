/**
 * #1051 — Hash-chain history log: canonical bytes, prev links, test vectors.
 *
 * Each history event gains `hash` (SHA-256 over its own canonical bytes) and
 * `prev` (the predecessor's hash). One chain per store, continuing across
 * monthly JSONL files. This takes the history log from append-only (L1) to
 * hash-chained (L2).
 *
 * Canonical bytes spec:
 * - UTF-8 JSON, keys sorted by UTF-16 code unit (JS default sort)
 * - No insignificant whitespace
 * - `hash` field excluded from its own canonical representation
 * - `prev` field included (known at hash time)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { createHash } from 'crypto'
import {
  appendHistory,
  readHistory,
  computeEventHash,
  canonicalEventBytes,
  sortKeysDeep,
  tailSeekLastHash,
  readChainHead,
  type HistoryEvent,
} from '../src/history.js'

// Load fixtures once
import { readFileSync } from 'fs'
const FIXTURES = JSON.parse(
  readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures/history-chain/vectors.json'),
    'utf8',
  ),
) as {
  vectors: Array<{
    name: string
    description: string
    input: HistoryEvent
    canonical_bytes: string
    sha256: string
  }>
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'plur-chain-'))
}

describe('hash-chain history (#1051)', () => {
  let dir: string

  beforeEach(() => { dir = tmpDir() })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  // ---------------------------------------------------------------------------
  // sortKeysDeep
  // ---------------------------------------------------------------------------

  describe('sortKeysDeep', () => {
    it('sorts top-level keys lexicographically', () => {
      const result = sortKeysDeep({ z: 1, a: 2, m: 3 }) as Record<string, number>
      expect(Object.keys(result)).toEqual(['a', 'm', 'z'])
    })

    it('recurses into nested objects', () => {
      const result = sortKeysDeep({ b: { y: 1, a: 2 }, a: { z: 3, m: 4 } }) as Record<string, unknown>
      expect(Object.keys(result)).toEqual(['a', 'b'])
      expect(Object.keys(result['a'] as object)).toEqual(['m', 'z'])
      expect(Object.keys(result['b'] as object)).toEqual(['a', 'y'])
    })

    it('preserves arrays as arrays without sorting elements', () => {
      const result = sortKeysDeep([3, 1, 2]) as number[]
      expect(result).toEqual([3, 1, 2])
    })

    it('recurses into objects inside arrays', () => {
      const result = sortKeysDeep([{ z: 1, a: 2 }]) as Array<Record<string, number>>
      expect(Object.keys(result[0])).toEqual(['a', 'z'])
    })

    it('preserves null, numbers, booleans, strings', () => {
      expect(sortKeysDeep(null)).toBe(null)
      expect(sortKeysDeep(42)).toBe(42)
      expect(sortKeysDeep(true)).toBe(true)
      expect(sortKeysDeep('hello')).toBe('hello')
    })
  })

  // ---------------------------------------------------------------------------
  // canonicalEventBytes / computeEventHash
  // ---------------------------------------------------------------------------

  describe('canonicalEventBytes', () => {
    it('excludes the hash field from canonical bytes', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'E1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: {},
        prev: null,
        hash: 'should-not-appear',
      }
      const bytes = canonicalEventBytes(event).toString('utf8')
      expect(bytes).not.toContain('should-not-appear')
      expect(bytes).not.toContain('"hash"')
    })

    it('includes the prev field in canonical bytes', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'E1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: {},
        prev: 'abc123',
      }
      const bytes = canonicalEventBytes(event).toString('utf8')
      expect(bytes).toContain('"prev":"abc123"')
    })

    it('produces no whitespace in output', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'E1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: { key: 'value' },
        prev: null,
      }
      const bytes = canonicalEventBytes(event).toString('utf8')
      // No space after : or ,
      expect(bytes).not.toMatch(/[:{[,]\s/)
    })

    it('sorts top-level event keys', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'E1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: {},
        prev: null,
      }
      const parsed = JSON.parse(canonicalEventBytes(event).toString('utf8')) as Record<string, unknown>
      // data < engram_id < event < prev < timestamp (all ASCII, so UTF-16 = ASCII order)
      expect(Object.keys(parsed)).toEqual(['data', 'engram_id', 'event', 'prev', 'timestamp'])
    })
  })

  describe('computeEventHash', () => {
    it('returns a 64-char lowercase hex string', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'E1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: {},
        prev: null,
      }
      const h = computeEventHash(event)
      expect(h).toMatch(/^[0-9a-f]{64}$/)
    })

    it('produces same hash regardless of whether hash field is pre-set', () => {
      const base: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'E1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: {},
        prev: null,
      }
      const withHash = { ...base, hash: 'preexisting' }
      expect(computeEventHash(base)).toBe(computeEventHash(withHash as HistoryEvent))
    })

    it('changes hash when prev changes', () => {
      const base: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'E1',
        timestamp: '2026-01-01T00:00:00.000Z',
        data: {},
        prev: null,
      }
      const linked: HistoryEvent = { ...base, prev: 'abc' }
      expect(computeEventHash(base)).not.toBe(computeEventHash(linked))
    })
  })

  // ---------------------------------------------------------------------------
  // Test vectors from fixtures
  // ---------------------------------------------------------------------------

  describe('canonical-bytes test vectors', () => {
    for (const vector of FIXTURES.vectors) {
      it(`vector: ${vector.name} — ${vector.description}`, () => {
        const bytes = canonicalEventBytes(vector.input).toString('utf8')
        expect(bytes).toBe(vector.canonical_bytes)
        expect(computeEventHash(vector.input)).toBe(vector.sha256)
        // Cross-check: SHA-256 of bytes equals the stated hash
        const crossCheck = createHash('sha256').update(bytes, 'utf8').digest('hex')
        expect(crossCheck).toBe(vector.sha256)
      })
    }

    it('cjk: CJK characters are preserved verbatim in canonical bytes', () => {
      const cjkVector = FIXTURES.vectors.find(v => v.name === 'cjk-content')!
      const bytes = canonicalEventBytes(cjkVector.input).toString('utf8')
      expect(bytes).toContain('日本語のテスト記録')
    })

    it('nested-data: nested object keys are sorted recursively', () => {
      const nestedVector = FIXTURES.vectors.find(v => v.name === 'nested-data')!
      const bytes = canonicalEventBytes(nestedVector.input).toString('utf8')
      const parsed = JSON.parse(bytes) as { data: { nested: unknown } }
      // nested object: count < meta < tags
      expect(Object.keys(parsed.data.nested as object)).toEqual(['count', 'meta', 'tags'])
    })

    it('nested-data: prev hash from cjk-content is included in canonical bytes', () => {
      const cjkVector = FIXTURES.vectors.find(v => v.name === 'cjk-content')!
      const nestedVector = FIXTURES.vectors.find(v => v.name === 'nested-data')!
      expect(nestedVector.input.prev).toBe(cjkVector.sha256)
      expect(nestedVector.canonical_bytes).toContain(cjkVector.sha256)
    })
  })

  // ---------------------------------------------------------------------------
  // tailSeekLastHash
  // ---------------------------------------------------------------------------

  describe('tailSeekLastHash', () => {
    it('returns null for a non-existent file', () => {
      expect(tailSeekLastHash(path.join(dir, 'missing.jsonl'))).toBe(null)
    })

    it('returns null for an empty file', () => {
      const p = path.join(dir, 'empty.jsonl')
      fs.writeFileSync(p, '')
      expect(tailSeekLastHash(p)).toBe(null)
    })

    it('returns null for a file whose last line has no hash (legacy event)', () => {
      const p = path.join(dir, 'legacy.jsonl')
      fs.writeFileSync(
        p,
        '{"event":"engram_created","engram_id":"E1","timestamp":"2026-01-01T00:00:00.000Z","data":{}}\n',
      )
      expect(tailSeekLastHash(p)).toBe(null)
    })

    it('returns null for a file with a malformed last line', () => {
      const p = path.join(dir, 'bad.jsonl')
      fs.writeFileSync(p, 'not json\n')
      expect(tailSeekLastHash(p)).toBe(null)
    })

    it('returns the hash of the last event in a file with multiple events', () => {
      const p = path.join(dir, 'multi.jsonl')
      const hash1 = 'a'.repeat(64)
      const hash2 = 'b'.repeat(64)
      fs.writeFileSync(
        p,
        `{"event":"engram_created","engram_id":"E1","timestamp":"2026-01-01T00:00:00.000Z","data":{},"prev":null,"hash":"${hash1}"}\n` +
        `{"event":"engram_updated","engram_id":"E1","timestamp":"2026-01-01T00:01:00.000Z","data":{},"prev":"${hash1}","hash":"${hash2}"}\n`,
      )
      expect(tailSeekLastHash(p)).toBe(hash2)
    })

    it('skips trailing empty lines', () => {
      const p = path.join(dir, 'trailing.jsonl')
      const hash = 'c'.repeat(64)
      fs.writeFileSync(
        p,
        `{"event":"engram_created","engram_id":"E1","timestamp":"2026-01-01T00:00:00.000Z","data":{},"prev":null,"hash":"${hash}"}\n\n\n`,
      )
      expect(tailSeekLastHash(p)).toBe(hash)
    })

    it('ignores a 63-char hash (too short — invalid)', () => {
      const p = path.join(dir, 'short.jsonl')
      const shortHash = 'a'.repeat(63)
      fs.writeFileSync(
        p,
        `{"event":"engram_created","engram_id":"E1","timestamp":"2026-01-01T00:00:00.000Z","data":{},"prev":null,"hash":"${shortHash}"}\n`,
      )
      expect(tailSeekLastHash(p)).toBe(null)
    })
  })

  // ---------------------------------------------------------------------------
  // appendHistory with hash-chain
  // ---------------------------------------------------------------------------

  describe('appendHistory hash-chain integration', () => {
    it('first event gets prev=null and a valid hash', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T12:00:00.000Z',
        data: { type: 'behavioral' },
      }
      appendHistory(dir, event)
      const events = readHistory(dir, '2026-04')
      expect(events).toHaveLength(1)
      expect(events[0].prev).toBe(null)
      expect(events[0].hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('second event in same file has prev equal to first hash', () => {
      const e1: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T12:00:00.000Z',
        data: {},
      }
      const e2: HistoryEvent = {
        event: 'engram_updated',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T13:00:00.000Z',
        data: {},
      }
      appendHistory(dir, e1)
      appendHistory(dir, e2)
      const events = readHistory(dir, '2026-04')
      expect(events).toHaveLength(2)
      expect(events[1].prev).toBe(events[0].hash)
    })

    it('chain continues across month boundaries', () => {
      const eApril: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-30T23:59:59.000Z',
        data: {},
      }
      const eMay: HistoryEvent = {
        event: 'engram_updated',
        engram_id: 'ENG-001',
        timestamp: '2026-05-01T00:00:01.000Z',
        data: {},
      }
      appendHistory(dir, eApril)
      appendHistory(dir, eMay)
      const aprilEvents = readHistory(dir, '2026-04')
      const mayEvents = readHistory(dir, '2026-05')
      // May's first event links back to April's last event (cross-month chain)
      expect(mayEvents[0].prev).toBe(aprilEvents[0].hash)
    })

    it('hash field is reproducible: recomputing from stored bytes matches stored hash', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T12:00:00.000Z',
        data: { statement: '記録テスト', type: 'behavioral' },
      }
      appendHistory(dir, event)
      const [stored] = readHistory(dir, '2026-04')
      // Recompute hash from stored event (excluding stored.hash itself)
      const recomputed = computeEventHash(stored)
      expect(recomputed).toBe(stored.hash)
    })

    it('legacy events (no hash) are loaded without error and never forced into chain', () => {
      // Write a legacy event manually
      const historyDir = path.join(dir, 'history')
      fs.mkdirSync(historyDir, { recursive: true })
      fs.writeFileSync(
        path.join(historyDir, '2026-04.jsonl'),
        '{"event":"engram_created","engram_id":"ENG-LEGACY","timestamp":"2026-04-01T00:00:00.000Z","data":{}}\n',
      )

      // Read should succeed
      const events = readHistory(dir, '2026-04')
      expect(events).toHaveLength(1)
      expect(events[0].hash).toBeUndefined()
      expect(events[0].prev).toBeUndefined()

      // Appending a new event after the legacy one: prev=null (gap — predecessor
      // exists but has no hash to link to)
      const newEvent: HistoryEvent = {
        event: 'engram_updated',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T01:00:00.000Z',
        data: {},
      }
      appendHistory(dir, newEvent)
      const all = readHistory(dir, '2026-04')
      expect(all).toHaveLength(2)
      // The new event has hash set but prev=null (gap after legacy event)
      expect(all[1].hash).toMatch(/^[0-9a-f]{64}$/)
      expect(all[1].prev).toBe(null)
    })

    it('history write failure does not propagate to caller (best-effort)', () => {
      // Make history directory a file to cause write failure
      const historyDir = path.join(dir, 'history')
      fs.writeFileSync(historyDir, 'not a directory')
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T12:00:00.000Z',
        data: {},
      }
      // Should not throw — best-effort
      expect(() => appendHistory(dir, event)).not.toThrow()
    })

    it('CJK data in event hashes correctly per fixture', () => {
      const cjkVector = FIXTURES.vectors.find(v => v.name === 'cjk-content')!
      const event: HistoryEvent = { ...cjkVector.input }
      appendHistory(dir, event)
      const events = readHistory(dir, '2026-01')
      expect(events[0].hash).toBe(cjkVector.sha256)
      expect(events[0].prev).toBe(null)
    })
  })

  // ---------------------------------------------------------------------------
  // .chain-head sidecar (#1051 follow-up)
  // ---------------------------------------------------------------------------

  describe('.chain-head sidecar', () => {
    it('readChainHead returns null for a non-existent history dir', () => {
      expect(readChainHead(path.join(dir, 'history'))).toBe(null)
    })

    it('readChainHead returns null when the sidecar file is absent', () => {
      const historyDir = path.join(dir, 'history')
      fs.mkdirSync(historyDir, { recursive: true })
      expect(readChainHead(historyDir)).toBe(null)
    })

    it('readChainHead returns null for an empty sidecar', () => {
      const historyDir = path.join(dir, 'history')
      fs.mkdirSync(historyDir, { recursive: true })
      fs.writeFileSync(path.join(historyDir, '.chain-head'), '', 'utf8')
      expect(readChainHead(historyDir)).toBe(null)
    })

    it('readChainHead returns null for a 63-char (invalid) sidecar', () => {
      const historyDir = path.join(dir, 'history')
      fs.mkdirSync(historyDir, { recursive: true })
      fs.writeFileSync(path.join(historyDir, '.chain-head'), 'a'.repeat(63), 'utf8')
      expect(readChainHead(historyDir)).toBe(null)
    })

    it('readChainHead returns null for non-hex content', () => {
      const historyDir = path.join(dir, 'history')
      fs.mkdirSync(historyDir, { recursive: true })
      fs.writeFileSync(path.join(historyDir, '.chain-head'), 'z'.repeat(64), 'utf8')
      expect(readChainHead(historyDir)).toBe(null)
    })

    it('readChainHead returns the hash when the sidecar is valid (with trailing newline)', () => {
      const historyDir = path.join(dir, 'history')
      fs.mkdirSync(historyDir, { recursive: true })
      const hash = 'a'.repeat(64)
      fs.writeFileSync(path.join(historyDir, '.chain-head'), `${hash}\n`, 'utf8')
      expect(readChainHead(historyDir)).toBe(hash)
    })

    it('readChainHead returns the hash when the sidecar has no trailing newline', () => {
      const historyDir = path.join(dir, 'history')
      fs.mkdirSync(historyDir, { recursive: true })
      const hash = 'b'.repeat(64)
      fs.writeFileSync(path.join(historyDir, '.chain-head'), hash, 'utf8')
      expect(readChainHead(historyDir)).toBe(hash)
    })

    it('appendHistory writes .chain-head after the first event', () => {
      const event: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T12:00:00.000Z',
        data: {},
      }
      appendHistory(dir, event)
      const historyDir = path.join(dir, 'history')
      const head = readChainHead(historyDir)
      const [written] = readHistory(dir, '2026-04')
      expect(head).toBe(written.hash)
    })

    it('appendHistory keeps .chain-head updated to the latest event hash', () => {
      const e1: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T12:00:00.000Z',
        data: {},
      }
      const e2: HistoryEvent = {
        event: 'engram_updated',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T13:00:00.000Z',
        data: {},
      }
      appendHistory(dir, e1)
      appendHistory(dir, e2)
      const historyDir = path.join(dir, 'history')
      const events = readHistory(dir, '2026-04')
      // Sidecar must reflect the SECOND event, not the first
      expect(readChainHead(historyDir)).toBe(events[1].hash)
    })

    it('appendHistory updates .chain-head across month boundaries', () => {
      const eApril: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-30T23:59:59.000Z',
        data: {},
      }
      const eMay: HistoryEvent = {
        event: 'engram_updated',
        engram_id: 'ENG-001',
        timestamp: '2026-05-01T00:00:01.000Z',
        data: {},
      }
      appendHistory(dir, eApril)
      appendHistory(dir, eMay)
      const historyDir = path.join(dir, 'history')
      const mayEvents = readHistory(dir, '2026-05')
      // Sidecar must reflect May's event (the final write)
      expect(readChainHead(historyDir)).toBe(mayEvents[0].hash)
    })

    it('findPredecessorHash uses .chain-head instead of tail-seeking JSONL when sidecar is present', () => {
      // Write two events to establish a chain
      const e1: HistoryEvent = {
        event: 'engram_created',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T12:00:00.000Z',
        data: {},
      }
      const e2: HistoryEvent = {
        event: 'engram_updated',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T13:00:00.000Z',
        data: {},
      }
      appendHistory(dir, e1)
      appendHistory(dir, e2)

      // Corrupt the JSONL so tail-seek would return null; sidecar must still work
      const historyDir = path.join(dir, 'history')
      const jsonlPath = path.join(historyDir, '2026-04.jsonl')
      fs.appendFileSync(jsonlPath, 'this-is-not-json\n')

      // Third event: predecessor should come from sidecar, not the corrupt JSONL tail
      const e3: HistoryEvent = {
        event: 'engram_updated',
        engram_id: 'ENG-001',
        timestamp: '2026-04-01T14:00:00.000Z',
        data: {},
      }
      appendHistory(dir, e3)
      const events = readHistory(dir, '2026-04')
      // e3 is at index 2 (0=e1, 1=e2, 2=e3 — corrupt line is skipped)
      const e3written = events.find(e => e.timestamp === '2026-04-01T14:00:00.000Z')!
      const e2written = events.find(e => e.timestamp === '2026-04-01T13:00:00.000Z')!
      // e3 must link back to e2 (via sidecar), not null
      expect(e3written.prev).toBe(e2written.hash)
    })

    it('.chain-head does not break the concurrent-writer chain (sidecar survives two sequential writes)', () => {
      // Simulates two sequential writes from the same process — the sidecar must
      // track the latest after each write, keeping the chain linear.
      const writes = 5
      const events: HistoryEvent[] = Array.from({ length: writes }, (_, i) => ({
        event: 'engram_created' as const,
        engram_id: `ENG-${String(i).padStart(3, '0')}`,
        timestamp: `2026-04-01T${String(i).padStart(2, '0')}:00:00.000Z`,
        data: {},
      }))
      for (const ev of events) appendHistory(dir, ev)

      const historyDir = path.join(dir, 'history')
      const stored = readHistory(dir, '2026-04')
      // Sidecar must match the final event
      expect(readChainHead(historyDir)).toBe(stored[writes - 1].hash)
      // Chain must be linear: each event's prev = previous event's hash
      for (let i = 1; i < stored.length; i++) {
        expect(stored[i].prev).toBe(stored[i - 1].hash)
      }
    })
  })
})

// ── sortKeysDeep must agree with JSON.stringify on custom serialisation ──────

describe('sortKeysDeep honours toJSON (#1052 canonical store_hash prerequisite)', () => {
  it('canonicalises a Date the way JSON.stringify writes it', () => {
    // THE DEFECT THIS GUARDS: sortKeysDeep walked objects structurally and
    // ignored toJSON, so a Date canonicalised to {} while JSON.stringify wrote
    // it to disk as an ISO string. The recorded hash then covered bytes that
    // were not the bytes on disk, and the event could never verify again.
    const d = new Date('2026-08-31T12:00:00.000Z')
    expect(sortKeysDeep({ when: d })).toEqual({ when: '2026-08-31T12:00:00.000Z' })
    // The property that actually matters: our canonical form and the JSON we
    // persist must agree.
    expect(JSON.stringify(sortKeysDeep({ when: d }))).toBe(JSON.stringify({ when: d }))
  })

  it('an event carrying a Date still hashes to something reproducible', () => {
    const ev: HistoryEvent = {
      event: 'engram_created', engram_id: 'ENG-1',
      timestamp: '2026-08-31T12:00:00.000Z',
      data: { at: new Date('2026-08-31T12:00:00.000Z') } as unknown as Record<string, unknown>,
    }
    const a = computeEventHash(ev)
    // Same event, the Date already reduced to the string it serialises as.
    const b = computeEventHash({ ...ev, data: { at: '2026-08-31T12:00:00.000Z' } })
    expect(a).toBe(b)
  })

  it('nested and array cases follow the same rule', () => {
    const d = new Date('2026-01-01T00:00:00.000Z')
    expect(sortKeysDeep({ a: [d, { b: d }] }))
      .toEqual({ a: ['2026-01-01T00:00:00.000Z', { b: '2026-01-01T00:00:00.000Z' }] })
  })
})
