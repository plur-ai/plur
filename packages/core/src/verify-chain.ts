/**
 * Chain verification for the history log (#1053).
 *
 * The gap this closes, in the reviewer's words: "Nothing anywhere in
 * packages/core, packages/cli or packages/mcp ever verifies prev/hash
 * linkage." #1051 writes a chain and #1052 checkpoints it, but nothing ever
 * checked either, so a fork, a broken link or a deletion was silent. A chain
 * nobody verifies is a chain that proves nothing.
 *
 * ## What this can and cannot establish
 *
 * It detects every edit that does NOT recompute the chain — content tampering
 * (the event no longer hashes to its recorded `hash`), a broken link, a
 * deleted event, a fork, a `prev` pointing at nothing.
 *
 * It cannot, from the log alone, detect a rewrite that recomputes every `prev`
 * and `hash` over the remaining events: that file is internally consistent by
 * construction. This is the ceiling of any self-contained hash chain and the
 * reason checkpoints exist — a checkpoint pins a `chain_head` that a later
 * rewrite cannot reproduce, so `checkpoint_head_missing` catches exactly that
 * case for everything written before the checkpoint. Anchoring a checkpoint
 * externally extends the same argument past the boundary of this file.
 *
 * Verification is never a bare bool. A bool is not anchorable and hides where
 * the chain broke, so the result names each break, each fork, and the
 * unprotected legacy range, and refusal is its own outcome distinct from both
 * "verified" and "broken" — per docs/design/failure-must-be-distinguishable.md
 * and the same rule the enterprise audit surface follows.
 */
import * as fs from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { computeEventHash, listHistoryMonths, type HistoryEvent } from './history.js'

export type BreakReason =
  | 'hash_mismatch'            // the event does not hash to its recorded hash
  | 'prev_mismatch'            // prev does not equal the predecessor's hash
  | 'dangling_prev'            // prev names a hash no event in the log carries
  | 'checkpoint_head_missing'  // a checkpoint pins a head the chain no longer contains

export interface ChainBreak {
  month:    string
  index:    number
  event_id: string
  reason:   BreakReason
  expected: string | null
  actual:   string | null
}

export interface ChainFork {
  prev: string
  claimed_by: Array<{ month: string; index: number; event_id: string; hash: string }>
}

export interface ChainVerifyResult {
  ok:                 boolean
  chain_head:         string | null
  total_events:       number
  verified_events:    number
  /** Contiguous leading run of pre-#1051 events carrying no hash/prev. */
  unprotected_legacy: { from: number; to: number; count: number } | null
  breaks:             ChainBreak[]
  forks:              ChainFork[]
  checkpoints_checked: number
}

export type ChainVerifyOutcome =
  | { status: 'verified'; result: ChainVerifyResult }
  | { status: 'broken';   result: ChainVerifyResult }
  | { status: 'cannot_verify'; reason: string; month?: string; line?: number }

interface Scanned { month: string; index: number; event: HistoryEvent }

/**
 * Verify the whole history chain for a store.
 *
 * Reads raw lines rather than going through `readHistory`, which silently
 * skips malformed lines (history.ts:390). A verifier that skipped them would
 * report a clean chain over a file it could not fully read — the benign-zero
 * this surface exists to refuse. A line that will not parse is a refusal.
 */
export function verifyChain(root: string): ChainVerifyOutcome {
  const months = listHistoryMonths(root)
  const scanned: Scanned[] = []

  let globalIndex = 0
  for (const month of months) {
    const filePath = join(root, 'history', `${month}.jsonl`)
    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      return { status: 'cannot_verify', reason: `could not read history file: ${(err as Error).message}`, month }
    }
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      let event: HistoryEvent
      try {
        event = JSON.parse(line) as HistoryEvent
      } catch (err) {
        return {
          status: 'cannot_verify',
          reason: `could not parse history line as JSON: ${(err as Error).message}`,
          month,
          line: i + 1,
        }
      }
      scanned.push({ month, index: globalIndex++, event })
    }
  }

  const result: ChainVerifyResult = {
    ok: true,
    chain_head: null,
    total_events: scanned.length,
    verified_events: 0,
    unprotected_legacy: null,
    breaks: [],
    forks: [],
    checkpoints_checked: 0,
  }

  // Leading run of legacy events. Pre-#1051 events carry neither hash nor
  // prev; per runbook law 8 that is an "unprotected legacy range", a
  // first-class outcome, never an error and never silently upgraded.
  let firstChained = 0
  while (firstChained < scanned.length && scanned[firstChained].event.hash === undefined) firstChained++
  if (firstChained > 0) {
    result.unprotected_legacy = { from: 0, to: firstChained - 1, count: firstChained }
  }

  const byHash = new Map<string, Scanned>()
  const prevClaims = new Map<string, Scanned[]>()
  let expectedPrev: string | null = null
  let sawFirstChained = false

  for (let k = firstChained; k < scanned.length; k++) {
    const { month, index, event } = scanned[k]
    const id = event.engram_id || `(${event.event})`

    // A legacy event appearing AFTER the chain started is not a legacy range —
    // it is a hole in a region that is supposed to be chained.
    if (event.hash === undefined) {
      result.breaks.push({
        month, index, event_id: id, reason: 'hash_mismatch',
        expected: 'a chained event', actual: 'an event with no hash',
      })
      continue
    }

    const recorded = event.hash
    const recomputed = computeEventHash(event)
    if (recomputed !== recorded) {
      result.breaks.push({
        month, index, event_id: id, reason: 'hash_mismatch',
        expected: recorded, actual: recomputed,
      })
      // Keep walking: the caller wants every break, not just the first.
    } else {
      result.verified_events++
    }

    const prev = event.prev ?? null
    if (sawFirstChained && prev !== expectedPrev) {
      result.breaks.push({
        month, index, event_id: id, reason: 'prev_mismatch',
        expected: expectedPrev, actual: prev,
      })
    }

    if (prev !== null) {
      const claims = prevClaims.get(prev) ?? []
      claims.push(scanned[k])
      prevClaims.set(prev, claims)
    }

    byHash.set(recorded, scanned[k])
    expectedPrev = recorded
    sawFirstChained = true
    result.chain_head = recorded

    if (event.event === 'checkpoint') result.checkpoints_checked++
  }

  // A prev that names a hash no event in the log carries. Distinct from
  // prev_mismatch: the link is not merely to the wrong place, it is to nothing.
  for (const [prev, claims] of prevClaims) {
    if (byHash.has(prev)) continue
    for (const c of claims) {
      result.breaks.push({
        month: c.month, index: c.index,
        event_id: c.event.engram_id || `(${c.event.event})`,
        reason: 'dangling_prev', expected: 'an event with this hash', actual: prev,
      })
    }
  }

  // Two events claiming one predecessor. Its own outcome, not tamper: it is
  // what concurrent writers produce, and the fix is different.
  for (const [prev, claims] of prevClaims) {
    if (claims.length < 2) continue
    result.forks.push({
      prev,
      claimed_by: claims.map(c => ({
        month: c.month, index: c.index,
        event_id: c.event.engram_id || `(${c.event.event})`,
        hash: c.event.hash!,
      })),
    })
  }

  // Checkpoints pin a head. If the chain no longer contains it, everything
  // below that checkpoint was rewritten — the one rewrite the linkage checks
  // above cannot see.
  for (const { month, index, event } of scanned) {
    if (event.event !== 'checkpoint') continue
    const head = (event.data as { chain_head?: unknown }).chain_head
    if (typeof head !== 'string') continue
    if (byHash.has(head)) continue
    result.breaks.push({
      month, index, event_id: `(checkpoint)`, reason: 'checkpoint_head_missing',
      expected: head, actual: null,
    })
  }

  result.ok = result.breaks.length === 0 && result.forks.length === 0
  return { status: result.ok ? 'verified' : 'broken', result }
}

/**
 * SHA-256 of a store's engrams.yaml bytes, or null when absent.
 * Used to compare a checkpoint's recorded store_hash against the file today.
 */
export function hashStoreFile(engramsPath: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(engramsPath)).digest('hex')
  } catch {
    return null
  }
}
