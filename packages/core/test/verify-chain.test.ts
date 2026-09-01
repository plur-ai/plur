/**
 * plur verify — structured chain verification (#1053).
 *
 * WHY THIS EXISTS. Črt's review of #1073 established the hole this closes:
 * "Nothing anywhere in packages/core, packages/cli or packages/mcp ever
 * verifies prev/hash linkage." He deleted a middle event, recomputed prev and
 * hash over the remainder, and got a file with zero broken links and an
 * unchanged store_hash. Until something checks the chain, the chain proves
 * nothing — and #1051's forks and #1052's mismatched checkpoints are all
 * silent in production.
 *
 * WHAT A HASH CHAIN CAN AND CANNOT DETECT. It detects edits that do NOT
 * recompute the chain: content tampering, a broken link, a deletion, a fork.
 * A full recomputation over the whole file is internally consistent and is
 * NOT detectable from the file alone — that is the L2 ceiling, and the reason
 * checkpoints exist. A checkpoint that recorded a chain head which the
 * recomputed chain no longer contains is what catches it. These tests assert
 * both halves, including the limitation, so no one reads more assurance into
 * this than it provides.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyChain, hashStoreFile } from '../src/verify-chain.js'
import { appendHistory, computeEventHash, emitCheckpoint, type HistoryEvent } from '../src/history.js'

let root: string
const historyDir = () => join(root, 'history')
const monthFile = (m: string) => join(historyDir(), `${m}.jsonl`)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'plur-verify-'))
  mkdirSync(historyDir(), { recursive: true })
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Build a chained run of events and write them to `month`. */
function writeChain(month: string, count: number, startPrev: string | null = null): HistoryEvent[] {
  const events: HistoryEvent[] = []
  let prev = startPrev
  for (let i = 0; i < count; i++) {
    const e: HistoryEvent = {
      event: 'engram_created',
      engram_id: `ENG-${month}-${String(i).padStart(3, '0')}`,
      timestamp: `2026-01-0${(i % 9) + 1}T00:00:00.000Z`,
      data: { n: i },
      prev,
    }
    e.hash = computeEventHash(e)
    events.push(e)
    prev = e.hash
  }
  writeFileSync(monthFile(month), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  return events
}

function readLines(month: string): string[] {
  return readFileSync(monthFile(month), 'utf8').split('\n').filter(l => l.trim())
}
function writeLines(month: string, lines: string[]): void {
  writeFileSync(monthFile(month), lines.join('\n') + '\n')
}

describe('verifyChain — a clean chain', () => {
  it('verifies and reports a structured result, never a bare bool', () => {
    writeChain('2026-01', 5)
    const out = verifyChain(root)
    expect(out.status).toBe('verified')
    if (out.status !== 'verified') return
    expect(out.result.ok).toBe(true)
    expect(out.result.verified_events).toBe(5)
    expect(out.result.breaks).toEqual([])
    expect(out.result.forks).toEqual([])
    expect(out.result.chain_head).toMatch(/^[0-9a-f]{64}$/)
  })

  it('chains across a month boundary', () => {
    const jan = writeChain('2026-01', 3)
    writeChain('2026-02', 2, jan[jan.length - 1].hash!)
    const out = verifyChain(root)
    expect(out.status).toBe('verified')
    if (out.status !== 'verified') return
    expect(out.result.verified_events).toBe(5)
  })
})

describe('verifyChain — tampering that does not recompute the chain', () => {
  it('names a mid-chain content edit as a hash mismatch', () => {
    writeChain('2026-01', 5)
    const lines = readLines('2026-01')
    const ev = JSON.parse(lines[2]) as HistoryEvent
    ev.data = { n: 999 }                 // edited, hash left alone
    lines[2] = JSON.stringify(ev)
    writeLines('2026-01', lines)

    const out = verifyChain(root)
    expect(out.status).toBe('broken')
    if (out.status !== 'broken') return
    expect(out.result.ok).toBe(false)
    const b = out.result.breaks.find(x => x.reason === 'hash_mismatch')
    expect(b, 'a content edit must be named a hash mismatch').toBeDefined()
    expect(b!.event_id).toBe('ENG-2026-01-002')
  })

  it('names a deleted middle event as a broken link', () => {
    writeChain('2026-01', 5)
    const lines = readLines('2026-01')
    lines.splice(2, 1)                   // remove one, recompute nothing
    writeLines('2026-01', lines)

    const out = verifyChain(root)
    expect(out.status).toBe('broken')
    if (out.status !== 'broken') return
    expect(out.result.breaks.some(b => b.reason === 'prev_mismatch')).toBe(true)
  })

  it('names a fork — two events claiming one predecessor', () => {
    const evs = writeChain('2026-01', 3)
    const forked: HistoryEvent = {
      event: 'engram_created',
      engram_id: 'ENG-FORK',
      timestamp: '2026-01-09T00:00:00.000Z',
      data: { n: 99 },
      prev: evs[0].hash!,                // same prev as evs[1]
    }
    forked.hash = computeEventHash(forked)
    writeLines('2026-01', [...readLines('2026-01'), JSON.stringify(forked)])

    const out = verifyChain(root)
    expect(out.status).toBe('broken')
    if (out.status !== 'broken') return
    expect(out.result.forks.length).toBe(1)
    expect(out.result.forks[0].prev).toBe(evs[0].hash)
    expect(out.result.forks[0].claimed_by.length).toBe(2)
  })

  it('names a prev that references no known event', () => {
    const evs = writeChain('2026-01', 2)
    const dangling: HistoryEvent = {
      event: 'engram_created',
      engram_id: 'ENG-DANGLE',
      timestamp: '2026-01-09T00:00:00.000Z',
      data: {},
      prev: 'f'.repeat(64),
    }
    dangling.hash = computeEventHash(dangling)
    void evs
    writeLines('2026-01', [...readLines('2026-01'), JSON.stringify(dangling)])

    const out = verifyChain(root)
    expect(out.status).toBe('broken')
    if (out.status !== 'broken') return
    expect(out.result.breaks.some(b => b.reason === 'dangling_prev')).toBe(true)
  })
})

describe('verifyChain — refusal is distinguishable from a finding', () => {
  it('refuses on a corrupted JSONL line instead of skipping it', () => {
    // readHistory() silently skips malformed lines. A verifier that did the
    // same would report a clean chain over a file it could not fully read —
    // the benign-zero this whole surface exists to refuse.
    //
    // The corruption sits mid-file deliberately: a malformed line in the LAST
    // position is an in-flight write and is tolerated (see the torn-tail block
    // below). Only a bad line that a write-in-progress cannot explain refuses.
    writeChain('2026-01', 3)
    const lines = readLines('2026-01')
    writeLines('2026-01', [lines[0], '{not json', lines[1], lines[2]])

    const out = verifyChain(root)
    expect(out.status).toBe('cannot_verify')
    if (out.status !== 'cannot_verify') return
    expect(out.reason).toMatch(/parse/i)
    expect(out.month).toBe('2026-01')
  })

  it('an empty store verifies rather than refusing — nothing there is a real answer', () => {
    const out = verifyChain(root)
    expect(out.status).toBe('verified')
    if (out.status !== 'verified') return
    expect(out.result.verified_events).toBe(0)
    expect(out.result.chain_head).toBeNull()
  })
})

describe('verifyChain — legacy events are a first-class outcome, not an error', () => {
  it('reports an unchained region without failing', () => {
    const legacy = [0, 1, 2].map(i => JSON.stringify({
      event: 'engram_created', engram_id: `OLD-${i}`,
      timestamp: '2025-12-01T00:00:00.000Z', data: {},
    }))
    writeLines('2026-01', legacy)

    const out = verifyChain(root)
    expect(out.status).toBe('verified')
    if (out.status !== 'verified') return
    expect(out.result.ok).toBe(true)
    expect(out.result.unprotected_legacy).toEqual({ from: 0, to: 2, count: 3 })
    expect(out.result.verified_events).toBe(0)
  })

  it('a legacy prefix followed by a chained region verifies the chained part only', () => {
    const legacy = JSON.stringify({
      event: 'engram_created', engram_id: 'OLD-0',
      timestamp: '2025-12-01T00:00:00.000Z', data: {},
    })
    writeChain('2026-01', 3)
    writeLines('2026-01', [legacy, ...readLines('2026-01')])

    const out = verifyChain(root)
    expect(out.status).toBe('verified')
    if (out.status !== 'verified') return
    expect(out.result.unprotected_legacy).toEqual({ from: 0, to: 0, count: 1 })
    expect(out.result.verified_events).toBe(3)
  })
})

describe('verifyChain — the L2 ceiling, stated honestly', () => {
  it('CANNOT detect a full recomputation from the file alone', () => {
    // Črt's probe. This asserts the LIMITATION on purpose: if this ever starts
    // failing, someone has claimed a property a hash chain does not have.
    writeChain('2026-01', 5)
    const kept = readLines('2026-01').map(l => JSON.parse(l) as HistoryEvent)
    kept.splice(2, 1)
    let prev: string | null = null
    for (const e of kept) {
      e.prev = prev
      delete e.hash
      e.hash = computeEventHash(e)
      prev = e.hash
    }
    writeLines('2026-01', kept.map(e => JSON.stringify(e)))

    const out = verifyChain(root)
    expect(out.status, 'a fully recomputed chain is internally consistent').toBe('verified')
  })

  it('DOES detect it once a checkpoint recorded the old head', () => {
    // This is what makes checkpoints the anchorable object: they pin a head
    // that a later rewrite cannot reproduce.
    const evs = writeChain('2026-01', 5)
    const cp: HistoryEvent = {
      event: 'checkpoint',
      engram_id: '',
      timestamp: '2026-01-09T00:00:00.000Z',
      data: { chain_head: evs[4].hash!, engram_count: 5, actor: 'cli' },
      prev: evs[4].hash!,
    }
    cp.hash = computeEventHash(cp)
    writeLines('2026-01', [...readLines('2026-01'), JSON.stringify(cp)])

    // Now rewrite history below the checkpoint, recomputing everything.
    const all = readLines('2026-01').map(l => JSON.parse(l) as HistoryEvent)
    const rewritten = all.filter(e => e.event !== 'checkpoint')
    rewritten.splice(2, 1)
    let prev: string | null = null
    for (const e of rewritten) {
      e.prev = prev; delete e.hash; e.hash = computeEventHash(e); prev = e.hash
    }
    const keptCp = all.find(e => e.event === 'checkpoint')!
    keptCp.prev = prev; delete keptCp.hash; keptCp.hash = computeEventHash(keptCp)
    writeLines('2026-01', [...rewritten, keptCp].map(e => JSON.stringify(e)))

    const out = verifyChain(root)
    expect(out.status).toBe('broken')
    if (out.status !== 'broken') return
    expect(out.result.breaks.some(b => b.reason === 'checkpoint_head_missing')).toBe(true)
  })
})

describe('verifyChain — a torn final line is an in-flight write, not corruption', () => {
  it('tolerates an incomplete last line and reports it', () => {
    // THE DEFECT THIS GUARDS: refusing on ANY malformed line meant every
    // concurrent append raced the verifier into a spurious "cannot_verify".
    // An alarm that fires when nothing is wrong is an alarm that gets ignored.
    // .datacore/lib/ledger/log.py already draws this line: a torn FINAL line
    // is a write still in flight; a bad line anywhere else is corruption.
    writeChain('2026-01', 3)
    const raw = readFileSync(monthFile('2026-01'), 'utf8')
    writeFileSync(monthFile('2026-01'), raw + '{"event":"engram_created","eng')

    const out = verifyChain(root)
    expect(out.status, 'the chain before the torn line is intact').toBe('verified')
    if (out.status !== 'verified') return
    expect(out.result.verified_events).toBe(3)
    expect(out.result.torn_tail).toEqual({ month: '2026-01', line: 4 })
  })

  it('still refuses a malformed line that is NOT last', () => {
    writeChain('2026-01', 3)
    const lines = readLines('2026-01')
    writeLines('2026-01', [lines[0], '{torn in the middle', lines[1], lines[2]])

    const out = verifyChain(root)
    expect(out.status).toBe('cannot_verify')
    if (out.status !== 'cannot_verify') return
    expect(out.line).toBe(2)
  })

  it('refuses a torn line in an OLDER month — only the newest can be in flight', () => {
    writeChain('2026-01', 2)
    writeChain('2026-02', 2)
    const raw = readFileSync(monthFile('2026-01'), 'utf8')
    writeFileSync(monthFile('2026-01'), raw + '{"event":"trunc')

    const out = verifyChain(root)
    expect(out.status).toBe('cannot_verify')
    if (out.status !== 'cannot_verify') return
    expect(out.month).toBe('2026-01')
  })
})

// ── The attestation a checkpoint exists to make must actually be checked ─────

describe('verifyChain — the checkpoint attests the STORE, so verify it', () => {
  /**
   * The gap: verifyChain read `chain_head` from checkpoint payloads and ignored
   * `store_hash` entirely. A store whose engrams.yaml was replaced wholesale,
   * with the history chain left untouched, verified as OK — the one thing the
   * checkpoint exists to make detectable.
   *
   * Compounding it, `hashStoreFile` hashed RAW FILE BYTES while emitCheckpoint
   * recorded the CANONICAL JSON of the parsed document. Different preimages, so
   * the two could never be equal even if something had compared them.
   */
  function storeWith(dir: string, ids: string[]): void {
    writeFileSync(
      join(dir, 'engrams.yaml'),
      'engrams:\n' + ids.map(id => `  - id: ${id}\n    status: active\n`).join(''),
      'utf8',
    )
  }

  it('hashStoreFile agrees with what a checkpoint records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-attest-'))
    try {
      storeWith(dir, ['ENG-001'])
      const cp = emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
      // The whole point: these are the same preimage.
      expect(hashStoreFile(join(dir, 'engrams.yaml'))).toBe(cp.store_hash)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('BREAKS when the store no longer matches the newest checkpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-attest-'))
    try {
      storeWith(dir, ['ENG-001'])
      emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
      expect(verifyChain(dir).status).toBe('verified')

      // Replace the store wholesale, leaving the chain untouched.
      storeWith(dir, ['ENG-666'])
      const out = verifyChain(dir)
      expect(out.status).toBe('broken')
      const reasons = out.status === 'broken' ? out.result.breaks.map(b => b.reason) : []
      expect(reasons).toContain('store_hash_mismatch')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('does NOT break on formatting-only changes — it attests content', () => {
    // A checkpoint attests the engrams, not the whitespace. Raw-byte hashing
    // would fail here, which is why #1052 rejected it.
    const dir = mkdtempSync(join(tmpdir(), 'vc-attest-'))
    try {
      writeFileSync(join(dir, 'engrams.yaml'), 'engrams:\n  - id: ENG-001\n    status: active\n', 'utf8')
      emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
      // Same document, CRLF and an extra trailing newline.
      writeFileSync(join(dir, 'engrams.yaml'), 'engrams:\r\n  - id: ENG-001\r\n    status: active\r\n\r\n', 'utf8')
      expect(verifyChain(dir).status).toBe('verified')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('compares only the NEWEST checkpoint — older ones attest older states', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-attest-'))
    try {
      storeWith(dir, ['ENG-001'])
      emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
      storeWith(dir, ['ENG-001', 'ENG-002'])
      emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
      // The first checkpoint legitimately describes a store that no longer
      // exists. Only the newest is a claim about now.
      expect(verifyChain(dir).status).toBe('verified')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('an absent store is not a mismatch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vc-attest-'))
    try {
      storeWith(dir, ['ENG-001'])
      emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
      rmSync(join(dir, 'engrams.yaml'))
      expect(verifyChain(dir).status).toBe('verified')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('verifyChain — a declared gap is not tampering', () => {
  it('reports prev:null mid-chain as declared_gap, not prev_mismatch', () => {
    // appendHistory writes prev:null when it cannot take the chain lock, and
    // #1052 promises that is "never mistaken for tampering". Reporting it as
    // prev_mismatch — the reason a rewritten link produces — was exactly that
    // mistake, and under real contention it would fire routinely.
    const dir = mkdtempSync(join(tmpdir(), 'vc-gap-'))
    try {
      appendHistory(dir, { event: 'engram_created', engram_id: 'ENG-001', timestamp: '2026-01-01T00:00:00.000Z', data: {} })
      appendHistory(dir, { event: 'engram_created', engram_id: 'ENG-002', timestamp: '2026-01-01T00:01:00.000Z', data: {} })

      // Rewrite the second event with prev:null and a hash that matches it —
      // exactly what the lock-failure path produces.
      const file = join(dir, 'history', '2026-01.jsonl')
      const lines = readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as HistoryEvent)
      const gapped: HistoryEvent = { ...lines[1], prev: null }
      delete (gapped as { hash?: string }).hash
      gapped.hash = computeEventHash(gapped)
      writeFileSync(file, [lines[0], gapped].map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8')

      const out = verifyChain(dir)
      expect(out.status).toBe('broken')
      const reasons = out.status === 'broken' ? out.result.breaks.map(b => b.reason) : []
      expect(reasons).toContain('declared_gap')
      expect(reasons).not.toContain('prev_mismatch')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
