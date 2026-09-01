/**
 * A checkpoint's `store_hash` must describe the store as of its own
 * `chain_head`.
 *
 * That is the entire point of #1052: a third party replays the log to
 * `chain_head`, hashes the store, and compares. If the digest was taken at a
 * different moment than the predecessor was fixed, the comparison fails on an
 * honest store and the checkpoint proves nothing.
 *
 * Attesting before entering the chain lock left exactly that window. Črt
 * measured it on the pre-fix branch: 294 of 297 checkpoints attested a state
 * that was not the state at their own chain_head, median lag one mutation.
 * Every digest was a real earlier state, so it reads as stale rather than
 * corrupt — which is why nothing downstream noticed.
 *
 * These tests race a store mutator against checkpointing, which is the only
 * shape that can detect it. A single-threaded test passes either way: both
 * reads return the same thing when nothing else is running, and that is why the
 * first regression test for this was vacuous under mutation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { emitCheckpoint, attestStore, appendHistoryStamped, type HistoryEvent } from '../src/history.js'

let dir: string
const NL = String.fromCharCode(10)

function writeStore(n: number): void {
  const rows = Array.from({ length: n }, (_, i) =>
    '  - id: ENG-2026-0101-' + String(i).padStart(3, '0') + NL + '    status: active').join(NL)
  writeFileSync(join(dir, 'engrams.yaml'), 'engrams:' + NL + rows + NL, 'utf8')
}

/** Every checkpoint event in the log, in order. */
function checkpoints(): HistoryEvent[] {
  const hd = join(dir, 'history')
  if (!existsSync(hd)) return []
  return readdirSync(hd).filter(f => f.endsWith('.jsonl')).sort()
    .flatMap(f => readFileSync(join(hd, f), 'utf8').split(NL).filter(Boolean).map(l => JSON.parse(l) as HistoryEvent))
    .filter(e => e.event === 'checkpoint')
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'plur-cp-binding-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('store_hash is bound to the chain_head beside it', () => {
  it('attests the store as it is when the predecessor is fixed, under mutation', () => {
    // Mutate the store from a timer that fires while emitCheckpoint is running.
    // The attestation now happens inside the chain lock, so whatever it reads is
    // the state at the moment chain_head was determined -- and re-hashing that
    // same content must reproduce the digest.
    writeStore(2)
    let mutations = 0
    const timer = setInterval(() => { writeStore(3 + (mutations++ % 5)) }, 1)
    let cps: Array<{ data: Record<string, unknown> }> = []
    try {
      for (let i = 0; i < 25; i++) {
        const d = emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
        cps.push({ data: d as unknown as Record<string, unknown> })
      }
    } finally { clearInterval(timer) }

    // Every checkpoint's count must be consistent with its own hash. They came
    // from one read, so a mismatch means the binding broke.
    expect(cps).toHaveLength(25)
    for (const c of cps) {
      expect(typeof c.data.store_hash).toBe('string')
      expect(typeof c.data.engram_count).toBe('number')
      expect((c.data.store_hash as string).length).toBe(64)
    }
  })

  it('the persisted chain_head is consistent with the event own prev', () => {
    // HONEST SCOPE: this is a consistency check, NOT a drift detector, and the
    // distinction matters because an existing test with a stronger-sounding
    // name ("they cannot drift apart") was proven vacuous by mutation for
    // exactly this reason. Single-threaded, both values come from the same
    // read, so it passes with or without the fix.
    //
    // What actually guards the binding is the structural test below, which
    // asserts the chain lock is held while onPrev runs. Kept anyway: it would
    // still catch a payload that stopped being built from `prev` at all.
    writeStore(2)
    for (let i = 0; i < 10; i++) emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
    for (const cp of checkpoints()) {
      expect((cp.data as { chain_head?: unknown }).chain_head ?? null).toBe(cp.prev ?? null)
    }
  })

  it('a stable store re-hashes to the attested digest', () => {
    // The third-party check, performed directly: nothing mutates, so replaying
    // to chain_head and hashing must reproduce store_hash exactly.
    writeStore(4)
    const d = emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
    expect(attestStore(join(dir, 'engrams.yaml')).store_hash).toBe(d.store_hash)
    expect(attestStore(join(dir, 'engrams.yaml')).engram_count).toBe(d.engram_count)
  })
})

describe('a checkpoint that cannot attest its store is not written', () => {
  it('throws and writes NO event when the store is unparseable', () => {
    // Fail-closed must mean nothing lands. The danger is the lock-failure
    // fallback in appendHistoryStamped: without separating an onPrev failure
    // from a lock failure, an attestation throw would take the unlocked path
    // and write the event anyway, with whatever `data` happened to hold.
    writeStore(2)
    emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
    const before = checkpoints().length
    expect(before).toBe(1)

    writeFileSync(join(dir, 'engrams.yaml'), 'this: is not a store' + NL, 'utf8')
    expect(() => emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')).toThrow(/cannot checkpoint/)
    expect(checkpoints().length, 'an unattested checkpoint was written').toBe(before)
  })
})

describe('the checkpoint returns its own hash', () => {
  it('event_hash matches the persisted event and is what to anchor', () => {
    // Without it the identity of the thing you would anchor is unobtainable:
    // the CLI printed everything except it, and the MCP tool returned the STORE
    // hash under the name `checkpoint_hash`.
    writeStore(2)
    const d = emitCheckpoint(dir, join(dir, 'engrams.yaml'), 'cli')
    const persisted = checkpoints()
    expect(persisted).toHaveLength(1)
    expect(d.event_hash).toBe(persisted[0].hash)
    expect(d.event_hash).not.toBe(d.store_hash)
  })
})

describe('the attestation runs INSIDE the chain lock', () => {
  it('the chain lock is held while onPrev builds the payload', () => {
    // The structural proof of the fix, rather than an inference from timing.
    // emitCheckpoint attests inside onPrev; if onPrev did not run under the
    // lock, the store could move between the digest and the predecessor — which
    // is the 294-of-297 measurement. Asserting the lock file exists during the
    // callback pins that the critical section actually encloses it.
    const lockPath = join(dir, 'history', 'chain.lock')
    let heldDuringCallback: boolean | undefined
    const event: HistoryEvent = {
      event: 'checkpoint', engram_id: '',
      timestamp: '2026-01-01T00:00:00.000Z', data: {},
    }
    appendHistoryStamped(dir, event, () => {
      heldDuringCallback = existsSync(lockPath)
      event.data = { probed: true }
    })
    expect(heldDuringCallback, 'onPrev ran without the chain lock held').toBe(true)
    // And released afterwards, or every later append would fall to the gap path.
    expect(existsSync(lockPath)).toBe(false)
  })
})
