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
import { computeEventHash, hashEngramsFile, listHistoryMonths, type HistoryEvent } from './history.js'

export type BreakReason =
  | 'hash_mismatch'            // the event does not hash to its recorded hash
  | 'prev_mismatch'            // prev does not equal the predecessor's hash
  | 'dangling_prev'            // prev names a hash no event in the log carries
  | 'checkpoint_head_missing'  // a checkpoint pins a head the chain no longer contains
  | 'store_hash_mismatch'      // the newest checkpoint attests a store that is not the one on disk
  | 'declared_gap'             // prev is null mid-chain: a writer could not take the lock

export interface ChainBreak {
  month:    string
  index:    number
  event_id: string
  reason:   BreakReason
  expected: string | null
  actual:   string | null
}

export interface ChainFork {
  /** The predecessor these events claim, or null when they claim genesis. */
  prev: string | null
  claimed_by: Array<{ month: string; index: number; event_id: string; hash: string }>
}

export interface ChainVerifyResult {
  ok:                 boolean
  chain_head:         string | null
  total_events:       number
  verified_events:    number
  /** Pre-#1051 events carrying no hash/prev, wherever they appear in the log. */
  unprotected_legacy: { from: number; to: number; count: number } | null
  breaks:             ChainBreak[]
  forks:              ChainFork[]
  checkpoints_checked: number
  /**
   * An incomplete final line in the newest month file, if present.
   *
   * Reported rather than refused: it is a write that was still in flight (or a
   * writer that crashed mid-flush), so the chain up to it is intact and the
   * honest answer is "verified, and one append was in progress" — not "cannot
   * verify". Never null-and-silent: a caller that wants to know is told.
   */
  torn_tail: { month: string; line: number } | null
}

export type ChainVerifyOutcome =
  | { status: 'verified'; result: ChainVerifyResult }
  | { status: 'broken';   result: ChainVerifyResult }
  | { status: 'cannot_verify'; reason: string; month?: string; line?: number }

interface Scanned { month: string; index: number; event: HistoryEvent }

/**
 * Claims key for an event with no predecessor.
 *
 * Not a hash, and cannot be mistaken for one: every real key is 64 hex
 * characters. Genesis events must share a key so that two of them are visible
 * as a fork.
 */
const GENESIS_CLAIM = '(genesis)'

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
  /** A torn final line in the newest month — an in-flight write, reported not refused. */
  let torn_tail: { month: string; line: number } | null = null

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
    // Index of the last non-empty line: a torn FINAL line is an in-flight
    // write, not corruption.
    let lastContentLine = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().length > 0) { lastContentLine = i; break }
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (line.trim().length === 0) continue
      let event: HistoryEvent
      try {
        event = JSON.parse(line) as HistoryEvent
      } catch (err) {
        // A writer that crashed, or one still flushing, leaves the file's LAST
        // line incomplete. That is an in-flight write, and refusing on it would
        // make every concurrent append a spurious "cannot verify" — an alarm
        // that fires when nothing is wrong is an alarm that gets ignored.
        // A malformed line ANYWHERE ELSE cannot be explained that way and is
        // real corruption.
        //
        // This is the distinction .datacore/lib/ledger/log.py already draws:
        // append() truncates a torn final line under the lock and read_events()
        // skips it, while a bad line elsewhere raises CorruptLogError naming
        // the file and its 1-based line number.
        if (i === lastContentLine && month === months[months.length - 1]) {
          torn_tail = { month, line: i + 1 }
          continue
        }
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
    torn_tail: null,
  }

  // Unchained (pre-#1051) events. They carry neither hash nor prev; per runbook
  // law 8 that is an "unprotected legacy range" — a first-class outcome, never
  // an error and never silently upgraded.
  //
  // Counted WHEREVER they appear, not only as a leading run. Treating a leading
  // run as legacy and everything after it as tampering assumed a store crosses
  // the chain boundary exactly once, which is not the ordinary rollout shape: a
  // chained build runs, then any non-chaining path writes, and the store now
  // interleaves. Reported as `hash_mismatch` ("content was edited") those
  // events made a real pre-chain store return exit 1 with roughly 920 breaks
  // citing tampering, with `unprotected_legacy: null` actively denying the
  // legacy region existed. Nothing was edited.
  const legacyIdx = scanned.map((s, i) => (s.event.hash === undefined ? i : -1)).filter(i => i >= 0)
  if (legacyIdx.length > 0) {
    result.unprotected_legacy = {
      from: legacyIdx[0],
      to: legacyIdx[legacyIdx.length - 1],
      count: legacyIdx.length,
    }
  }

  const byHash = new Map<string, Scanned>()
  const prevClaims = new Map<string, Scanned[]>()
  let expectedPrev: string | null = null
  let sawFirstChained = false

  // Every event, in order. Unchained ones are skipped inside the loop rather
  // than by starting past a leading run — they can appear anywhere.
  for (let k = 0; k < scanned.length; k++) {
    const { month, index, event } = scanned[k]
    const id = event.engram_id || `(${event.event})`

    // An unchained event is not a break. It is uncovered, which is what
    // `unprotected_legacy` reports, and `verified` already means "the chain
    // holds over everything it covers" — not "everything is covered".
    //
    // It does NOT advance `expectedPrev`: the next chained event's predecessor
    // is the last CHAINED event, because that is what appendHistory's tail-seek
    // would have found. When the tail-seek instead returned null the next event
    // carries prev:null, which is reported as a declared_gap.
    if (event.hash === undefined) continue

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
      // A null prev mid-chain is what appendHistory writes when it cannot take
      // the chain lock. #1052 calls that "a DECLARED GAP ... never mistaken for
      // tampering", and it is the honest choice -- but reporting it as
      // `prev_mismatch` IS mistaking it for tampering, because that is the
      // reason a rewritten link produces. Under the contention #1052 itself
      // measured, a busy machine would show BROKEN with a tampering reason for
      // a log nobody touched, which is the alarm-that-cries-wolf this surface
      // exists to avoid. Its own reason code, so an operator can tell a
      // concurrency artifact from an edit.
      result.breaks.push({
        month, index, event_id: id,
        reason: prev === null ? 'declared_gap' : 'prev_mismatch',
        expected: expectedPrev, actual: prev,
      })
    }

    // Genesis is a claim too. Excluding `prev: null` meant the ONE fork shape
    // the lock-failure path can actually produce was the one not labelled a
    // fork: two concurrent writers on an empty store both take the gap path,
    // both write `prev: null`, and the result was `forks: []` plus a single
    // prev_mismatch. Keyed under a sentinel that cannot collide with a hash —
    // hashes are 64 hex characters, this is not.
    const claimKey = prev ?? GENESIS_CLAIM
    const claims = prevClaims.get(claimKey) ?? []
    claims.push(scanned[k])
    prevClaims.set(claimKey, claims)

    byHash.set(recorded, scanned[k])
    expectedPrev = recorded
    sawFirstChained = true
    result.chain_head = recorded

    if (event.event === 'checkpoint') result.checkpoints_checked++
  }

  // A prev that names a hash no event in the log carries. Distinct from
  // prev_mismatch: the link is not merely to the wrong place, it is to nothing.
  for (const [prev, claims] of prevClaims) {
    if (prev === GENESIS_CLAIM) continue // genesis names no predecessor by design
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
      // Reported as null rather than the sentinel: the consumer's contract is
      // "the predecessor these events claim", and for genesis that is nothing.
      prev: prev === GENESIS_CLAIM ? null : prev,
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

  // The checkpoint's whole purpose is to attest the STORE, and nothing checked
  // it: verifyChain read `chain_head` and ignored `store_hash`, so a store whose
  // engrams.yaml had been replaced wholesale -- the chain left untouched --
  // verified as OK. Compare the NEWEST checkpoint only: older ones attest older
  // states and are expected to differ.
  const newestCheckpoint = [...scanned].reverse().find(s => s.event.event === 'checkpoint')
  if (newestCheckpoint) {
    const attested = (newestCheckpoint.event.data as { store_hash?: unknown }).store_hash
    if (typeof attested === 'string') {
      const actual = hashStoreFile(join(root, 'engrams.yaml'))
      // A store that cannot be read is not a mismatch: an absent store is a
      // real state (nothing learned yet), and an unreadable one is a refusal
      // the caller already sees through `cannot_verify` on the log itself.
      if (actual !== null && actual !== attested) {
        result.breaks.push({
          month: newestCheckpoint.month,
          index: newestCheckpoint.index,
          event_id: '(checkpoint)',
          reason: 'store_hash_mismatch',
          expected: attested,
          actual,
        })
      }
    }
  }

  result.torn_tail = torn_tail
  // A torn tail does not make the chain broken — everything before it verified.
  result.ok = result.breaks.length === 0 && result.forks.length === 0
  return { status: result.ok ? 'verified' : 'broken', result }
}

/**
 * The store's CANONICAL hash, or null when it cannot be computed.
 *
 * Must be the digest a checkpoint records, or the comparison is meaningless.
 * This function used to hash the raw file bytes while `emitCheckpoint` recorded
 * the canonical JSON of the parsed document -- two different preimages, so the
 * value printed by `plur verify` could never equal the value in any checkpoint,
 * and the doc comment claiming it was "used to compare a checkpoint's recorded
 * store_hash against the file today" described something that could not happen.
 * Raw-byte hashing was rejected on purpose in #1052 (LF vs CRLF, emitter, OS);
 * reintroducing it in the verifier was the harder half of that bug to see.
 *
 * Null rather than throwing: a store may legitimately be absent (nothing has
 * been learned yet), and that is not a verification failure.
 *
 * @param engramsPath - absolute path to engrams.yaml.
 * @returns the canonical store hash, or null when absent or unparseable.
 */
export function hashStoreFile(engramsPath: string): string | null {
  try {
    return hashEngramsFile(engramsPath)
  } catch {
    return null
  }
}
