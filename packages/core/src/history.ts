import * as fs from 'fs'
import { withLock } from './sync.js'
import * as yaml from 'js-yaml'
import { logger } from './logger.js'
import { join } from 'path'
import { createHash } from 'crypto'

export interface HistoryEvent {
  event: 'engram_created' | 'engram_updated' | 'engram_merged' | 'feedback_received' | 'engram_retired' | 'engram_decremented' | 'engram_promoted' | 'engram_rescoped' | 'failure_reported' | 'procedure_evolved' | 'recurrence_detected' | 'contradiction_detected' | 'scope_promoted' | 'buffer_pruned' | 'weekly_review' | 'engram_route_failed' | 'co_injection' | 'injection_outcome' | 'session_scope_changed' | 'dedup_near_duplicate' | 'engram_duplicate_absorbed' | 'checkpoint'
  /**
   * Engram this event belongs to. Session-level events
   * (`session_scope_changed`) carry no engram — they use `''`, which by
   * construction never matches a real id in `readHistoryForEngram`.
   */
  engram_id: string
  timestamp: string // ISO
  data: Record<string, unknown> // event-specific payload
  /**
   * SHA-256 over the canonical bytes of this event (sorted keys, no whitespace,
   * ISO-8601 timestamps). Set by appendHistory() for events written after #1051.
   * Legacy events have no hash field — readers must tolerate its absence.
   */
  hash?: string
  /**
   * Hash of the predecessor event in the chain, or null when this event is the
   * genesis of the chain (first chained event in the store) or when the
   * predecessor could not be read (gap — the write still proceeds, never fabricates).
   * Legacy events have no prev field — readers must tolerate its absence.
   */
  prev?: string | null
}

/**
 * Recursively sort object keys by UTF-16 code unit order (lexicographic), the
 * same sort order used by JSON.stringify's default key visitor in V8.
 * Arrays are preserved as arrays (elements sorted recursively if objects).
 *
 * This is the canonical-bytes normaliser for #1051: every event hash is
 * computed over JSON.stringify(sortKeysDeep(event_without_hash)), so two
 * independent implementations that agree on this function agree on all hashes.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    // Honour toJSON BEFORE walking the object, exactly as JSON.stringify does.
    //
    // Without this the canonical form and the stored form disagree for any
    // value with custom serialisation: a Date in `event.data` walks as an
    // object with no own enumerable keys and canonicalises to `{}`, while
    // JSON.stringify writes it to disk as an ISO string. The event's recorded
    // hash then covers bytes that are not the bytes on disk, and it can never
    // verify again.
    //
    // Latent today — all 31 call sites pass `.toISOString()` — but `data` is
    // typed Record<string, unknown>, and this module's own docs promise that
    // "two independent implementations that agree on this function agree on all
    // hashes". A third-party verifier using JSON.stringify semantics would
    // disagree with us on the first Date anyone passes.
    //
    // It stops being latent with #1052's canonical store_hash: js-yaml parses
    // ISO timestamps into Date objects, so hashing parsed YAML walks straight
    // into it.
    const maybe = value as { toJSON?: (key?: string) => unknown }
    if (typeof maybe.toJSON === 'function') {
      return sortKeysDeep(maybe.toJSON())
    }
    const obj = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeysDeep(obj[key])
    }
    return sorted
  }
  return value
}

/**
 * Canonical bytes for a history event: UTF-8 JSON, keys sorted
 * lexicographically by UTF-16 code unit, no insignificant whitespace.
 *
 * The `hash` field is EXCLUDED from its own canonical representation (circular
 * by construction). The `prev` field is INCLUDED — it is a known value at hash
 * time and forms part of the chain linkage.
 *
 * Spec (#1051):
 * - UTF-8 JSON
 * - Keys sorted recursively by UTF-16 code unit (JS default sort)
 * - No insignificant whitespace (JSON.stringify with no space arg)
 * - Timestamps must be ISO-8601 strings, never floats
 * - Hashes: lowercase hex SHA-256
 */
export function canonicalEventBytes(event: HistoryEvent): Buffer {
  const { hash: _hash, ...rest } = event
  void _hash // excluded from the canonical form
  const sorted = sortKeysDeep(rest)
  return Buffer.from(JSON.stringify(sorted), 'utf8')
}

/**
 * Compute the SHA-256 hash of a history event's canonical bytes.
 * Returns lowercase hex string (64 chars).
 *
 * Callers must pass the event WITHOUT the hash field set, or use this before
 * setting event.hash (canonical bytes always exclude `hash` — see above).
 */
export function computeEventHash(event: HistoryEvent): string {
  return createHash('sha256').update(canonicalEventBytes(event)).digest('hex')
}

/**
 * Tail-seek the last non-empty line of a JSONL file and extract the `hash`
 * field from the parsed JSON. Returns null if the file does not exist, cannot
 * be read, has no non-empty lines, or the last line lacks a `hash` field.
 *
 * This is the predecessor-hash read for chain linkage. It is intentionally
 * robust: an unreadable or missing predecessor results in null (a documented
 * gap), not an error. The caller (appendHistory) writes the gap marker rather
 * than failing the mutation.
 *
 * Implementation: reads the last TAIL_WINDOW bytes and scans backwards for a
 * newline, avoiding a full-file parse on the hot write path. If the window
 * lands entirely INSIDE the final line -- no newline in it -- the window is
 * doubled and the read retried, up to TAIL_MAX_WINDOW.
 *
 * That retry is not a nicety. A fixed window silently breaks the chain on any
 * event longer than it: the buffer starts mid-line, JSON.parse fails, the
 * function returns null, and the NEXT event chains from nothing -- a gap that
 * `plur verify` then reports, over a log that is perfectly intact. `data` is
 * typed `Record<string, unknown>`, and a co_injection carrying a large id array
 * or a weekly_review payload reaches 8 KiB without anything unusual happening,
 * so "sufficient for any realistic event line" was an assumption, not a bound.
 */
/** Initial tail read. Covers the overwhelming majority of event lines. */
const TAIL_WINDOW = 8192
/**
 * Ceiling on the doubling retry.
 *
 * A bound is still required -- without one, a corrupt file with no newline at
 * all would be read entirely into memory on the hot write path. At the ceiling
 * the function gives up and returns null, which is the documented gap: honest,
 * visible, and preferable to an OOM during a write.
 */
const TAIL_MAX_WINDOW = 1024 * 1024

export function tailSeekLastHash(filePath: string): string | null {
  try {
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      return null // file does not exist
    }
    if (stat.size === 0) return null

    // Grow the window until it contains a line boundary, or until it covers the
    // whole file, or until the ceiling. Without this, an event longer than the
    // window is unreadable and silently becomes a chain gap.
    let text = ''
    for (let window = TAIL_WINDOW; ; window *= 2) {
      const readSize = Math.min(stat.size, window)
      const offset = stat.size - readSize
      const buf = Buffer.allocUnsafe(readSize)
      const fd = fs.openSync(filePath, 'r')
      try {
        fs.readSync(fd, buf, 0, readSize, offset)
      } finally {
        fs.closeSync(fd)
      }
      text = buf.toString('utf8')
      // Whole file read: the scan below already tolerates a leading partial
      // line being absent and a trailing terminator being present.
      if (readSize >= stat.size) break
      // Otherwise the window starts mid-file, so its first line is a fragment.
      // Look for the START of the FINAL record, which means ignoring the file's
      // trailing terminator first: a JSONL file ends in a newline, so the naive
      // "does the window contain a newline" test is satisfied by that byte
      // alone and slicing from it yields an empty string.
      const body = text.replace(/\n+$/, '')
      const lastBoundary = body.lastIndexOf('\n')
      if (lastBoundary !== -1) {
        text = body.slice(lastBoundary + 1)
        break
      }
      if (window >= TAIL_MAX_WINDOW) return null // documented gap, never an OOM
    }
    // Scan backwards for the last non-empty line
    const lines = text.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.length === 0) continue
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>
        if (typeof parsed.hash === 'string' && parsed.hash.length === 64) {
          return parsed.hash
        }
        // Last event exists but has no hash (legacy event) — this is a gap in
        // the chain. Return null to signal "predecessor found but unchained".
        return null
      } catch {
        return null // malformed JSON — treat as unreadable
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Find the hash of the most recent chained event across all month files in the
 * history directory, looking at the current month file first and then scanning
 * backwards through prior months.
 *
 * Used by appendHistory for cross-month chain continuity: when the first event
 * of a new month is written, the predecessor is in the prior month's file.
 *
 * Returns null when no chained predecessor is found (genesis event, gap after
 * a legacy event, or unreadable files).
 */
export function findPredecessorHash(historyDir: string, currentMonthFile: string): string | null {
  // If the current month file exists and has content, the predecessor (if any)
  // is within it. A null return means either: last event is a legacy event
  // (no hash — gap) or the file is empty/unreadable. We don't cross back to
  // prior months when the current month file already has events written into it.
  try {
    const stat = fs.statSync(currentMonthFile)
    if (stat.size > 0) {
      // File exists with content — predecessor lives here (or it's a gap)
      return tailSeekLastHash(currentMonthFile)
    }
    // File exists but empty — treat as absent
  } catch {
    // File does not exist — this is the first event of a new month.
    // Look at the most recent prior month for cross-month continuity.
  }

  // Current month file absent or empty: walk backwards through prior months
  // for cross-month chain continuity.
  try {
    if (!fs.existsSync(historyDir)) return null
    const months = fs.readdirSync(historyDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => f.replace('.jsonl', ''))
      .sort()
      .reverse() // newest first

    for (const month of months) {
      const filePath = join(historyDir, `${month}.jsonl`)
      // Skip the current month file — already checked above
      if (filePath === currentMonthFile) continue
      const hash = tailSeekLastHash(filePath)
      if (hash !== null) return hash
      // If the last event in the most recent prior month has no hash (legacy),
      // stop — no chained predecessor exists before this gap.
      break
    }
  } catch {
    // best-effort
  }
  return null
}

/**
 * Append a history event to the JSONL file for the current month.
 * Files are stored in {root}/history/YYYY-MM.jsonl.
 * Auto-creates the history directory and file on first write.
 *
 * Hash-chain (#1051): before writing, this function:
 *   1. Tail-seeks for the predecessor's hash — current month file first, then
 *      the most recent prior month file (cross-month continuity)
 *   2. Sets event.prev = predecessor hash | null (gap when predecessor unreadable)
 *   3. Computes SHA-256 over canonical bytes (sorted keys, no whitespace) and
 *      sets event.hash
 *
 * Concurrency: this function serializes itself. The read-predecessor →
 * compute-hash → append sequence is wrapped in a short cross-process lock on
 * the history directory, so two writers cannot both read the same tail and
 * both append from it.
 *
 * It used to document a precondition instead — "must be called from within the
 * store write lock" — which the codebase did not honour: 19 of 28 call sites in
 * index.ts were outside any `_withStoreLock`, and BOTH `emitCheckpoint` sites
 * were, which is what produced 83 duplicate-prev forks across 600 events in
 * review testing. A precondition that callers do not meet is not a design, and
 * the mutex is not re-entrant so `_withStoreLock` could not simply be called
 * here. Locking the thing that actually needs exclusion — this append — fixes
 * every call site at once, present and future.
 *
 * Lock ordering is one-way: a caller may hold the store lock and then take this
 * one, never the reverse (nothing here calls back into store code), so the two
 * cannot deadlock.
 *
 * This is the same critical section `.datacore/lib/ledger/log.py` serializes
 * with `fcntl.flock`. That ledger goes further and gives each actor its own
 * file, making forks unrepresentable rather than merely prevented; adopting
 * that partitioning here is the follow-up this lock buys time for.
 *
 * If the lock cannot be acquired, the event is still written but with
 * `prev: null` — a DECLARED GAP rather than a possibly-stale predecessor.
 * A gap is visible and honest; a fork is silent corruption. The write itself
 * must always land: history NAMES the engrams a restore cannot recover, so
 * dropping a record makes restore under-report the loss.
 *
 * Gap handling: if the predecessor cannot be read (file missing, malformed line,
 * legacy event without hash), prev is set to null. This is a documented gap in
 * the chain — never an error, never a fabricated hash.
 *
 * Legacy events: events written before #1051 carry no hash or prev fields. They
 * are loaded and reported as-is, never silently upgraded, never errored.
 */
export function appendHistory(root: string, event: HistoryEvent): void {
  appendHistoryStamped(root, event)
}

/**
 * `appendHistory`, with a hook that runs INSIDE the critical section once the
 * predecessor is known and before the event is serialised.
 *
 * This exists for checkpoints (#1052). A checkpoint's payload carries
 * `chain_head`, which must be the very predecessor the event chains onto — and
 * the only way to guarantee that is to build the payload from the `prev` this
 * append is about to use, under the same lock. Computing it separately and
 * hoping nothing lands in between is what made 76/300 checkpoints disagree with
 * their own `prev` at 200 KB, and 174/300 at 2 MB.
 *
 * `onPrev` runs with the chain lock held, and MAY read the store — that is the
 * point. #1052's checkpoint has to bind its `store_hash` to the `chain_head` it
 * records, and the only way to do that is to read the store inside the same
 * critical section that fixes the predecessor. It should still do no more than
 * it must: every history append waits behind it.
 */
export function appendHistoryStamped(
  root: string,
  event: HistoryEvent,
  onPrev?: (prev: string | null) => void,
): void {
  const historyDir = join(root, 'history')
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true })
  }

  const date = event.timestamp.slice(0, 7) // YYYY-MM
  const filePath = join(historyDir, `${date}.jsonl`)

  // Hash-chain linkage (#1051) under exclusion. Reading the tail and appending
  // from it must be one atomic step, or two writers chain from the same
  // predecessor and the log forks. `withLock` is the synchronous twin of the
  // store's async lock — token-based release, stale detection, liveness check —
  // and `appendHistory` is synchronous, so it is the one that fits.
  // The critical section is read-tail -> compute -> WRITE, all three. Stamping
  // under the lock and appending after it is not enough: two writers can both
  // read the same tail, both release, and both then append from it — measured
  // at 52 forks in 300 events. This is the boundary
  // .datacore/lib/ledger/log.py draws around "read-tail + compute-next + write".
  // An `onPrev` failure is NOT a lock failure, and must not be treated as one.
  // The catch below falls back to an unlocked append when the lock cannot be
  // taken; without this flag a throw from `onPrev` — a checkpoint that could
  // not attest its store — would take that same path and write the event
  // anyway, with whatever `data` happened to be set. Recorded here so the
  // catch can rethrow instead.
  let onPrevFailure: unknown
  const stampAndWrite = (): void => {
    const predecessorHash = findPredecessorHash(historyDir, filePath)
    event.prev = predecessorHash // null when gap or genesis
    // Payload built from the predecessor this append will actually use, before
    // the hash covers it (#1052 checkpoints).
    try {
      onPrev?.(predecessorHash)
    } catch (err) {
      onPrevFailure = err
      throw err
    }
    event.hash = computeEventHash(event) // canonical bytes exclude the hash field
    writeEventLine(JSON.stringify(event) + '\n')
  }
  // fsync the append (#813, audit finding 20). O_APPEND makes the write atomic
  // against concurrent writers, but not durable: a committed engram mutation
  // could survive a power cut while its history record did not. That matters
  // beyond bookkeeping — `plur restore` reads this log to NAME the engrams a
  // restore cannot recover, so a lost record makes restore UNDER-report the
  // loss, which is the one thing it exists not to do.
  //
  // Best-effort on the fsync itself: the append already succeeded, and failing
  // the caller's mutation because a diagnostic log could not be flushed would
  // trade a small durability gap for a large availability one.
  // Best-effort on the WHOLE append, not just the fsync.
  //
  // The reasoning above — that failing a caller's mutation because a
  // diagnostic log could not be written trades a small durability gap for a
  // large availability one — was applied only to `fsyncSync`. `openSync` and
  // `writeSync` were unguarded, so an unwritable history directory (disk full,
  // permissions, a path that is not a file) propagated out and failed the
  // learn/forget/feedback that called it. Found by a test that made the month
  // file unreadable to check id allocation degraded safely: it did not
  // degrade, it threw EISDIR out of `plur.learn()`.
  //
  // Warned rather than silently swallowed: history is load-bearing for `plur
  // restore` (it NAMES the engrams a restore cannot recover) and, since #816,
  // for id allocation. A store writing no history is degraded and the operator
  // needs to know — but the write itself must still land.
  function writeEventLine(line: string): void {
  try {
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeSync(fd, line)
      try { fs.fsyncSync(fd) } catch { /* append landed; durability is best-effort */ }
    } finally {
      fs.closeSync(fd)
    }
  } catch (err) {
    if (!warnedHistoryPaths.has(filePath)) {
      warnedHistoryPaths.add(filePath)
      logger.warning(
        `[plur] history could not be written to ${filePath}: ${(err as Error).message}. ` +
        `The operation itself succeeded. While this persists, \`plur restore\` cannot name ` +
        `unrecoverable engrams and engram-id allocation loses its cross-compaction guarantee (#816).`,
      )
    }
  }
  }

  try {
    // Tuned to the section, not to the default: this critical section is a
    // tail-read, a hash and an append — microseconds — so the stock 100 ms
    // first backoff has waiters sleeping orders of magnitude longer than the
    // holder needs, and under real concurrency they starve and fall through to
    // the gap path below.
    withLock(join(historyDir, 'chain'), stampAndWrite, { maxRetries: 12, baseDelay: 2 })
  } catch (err) {
    // Distinguish the two ways the block above can fail. If `onPrev` threw, the
    // caller could not build its payload — a checkpoint that cannot attest its
    // store — and writing the event anyway is worse than not writing it.
    if (onPrevFailure !== undefined) throw onPrevFailure
    void err
    // Could not take the lock. Do NOT chain from a tail we could not read
    // under exclusion — that is exactly how a fork is written. Declare a gap
    // instead: visible to `plur verify`, never mistaken for tampering. The
    // write itself must still land: history NAMES the engrams a restore cannot
    // recover, so dropping the record would make restore under-report.
    event.prev = null
    try {
      onPrev?.(null)
    } catch (onPrevErr) {
      // Same rule on the gap path: a payload that cannot be built means no
      // event, not an event with an empty one.
      throw onPrevErr
    }
    event.hash = computeEventHash(event)
    writeEventLine(JSON.stringify(event) + '\n')
  }
}

/** Warn once per path — this is on the hot write path; a broken log must not
 *  also become a log flood. */
const warnedHistoryPaths = new Set<string>()

/**
 * Payload of a `checkpoint` history event (#1052).
 *
 * A checkpoint commits to every event that precedes it in the chain — the
 * chain linkage (prev/hash) makes the whole prior history tamper-evident
 * once this checkpoint is externally anchored.
 *
 * Fields:
 *   chain_head  — hash of the predecessor event (the last event before this
 *                 checkpoint), or null when this is the genesis checkpoint.
 *                 Redundant with the HistoryEvent.prev field, but kept in
 *                 data so the payload is self-contained without parsing chain
 *                 linkage separately.
 *   store_hash  — SHA-256 of the engrams.yaml bytes at checkpoint time,
 *                 hex-encoded. Never computed on append (hot path) — only
 *                 computed when a checkpoint is explicitly requested.
 *   engram_count — count of active (non-retired) engrams at checkpoint time.
 *   actor        — who/what triggered the checkpoint ('session_end' | 'cli' | string).
 */
export interface CheckpointData {
  /**
   * SHA-256 of this checkpoint event itself — the value to anchor externally.
   *
   * Present on the value `emitCheckpoint` RETURNS; absent from the persisted
   * payload, because an event's canonical bytes exclude its own hash. Null only
   * when the append could not stamp one.
   */
  event_hash?: string | null
  chain_head: string | null
  store_hash: string
  engram_count: number
  actor: string
}

/**
 * Compute the SHA-256 hash of the engrams.yaml file at `engramsPath`.
 * Returns lowercase hex string. Throws if the file cannot be read.
 *
 * This is ONLY called when a checkpoint is explicitly requested — never on
 * the hot write path (learn/feedback/forget).
 */
export function hashEngramsFile(engramsPath: string): string {
  return attestStore(engramsPath).store_hash
}

/**
 * Hash a store AND count it from ONE read of ONE buffer.
 *
 * The two values are emitted side by side in a checkpoint, and a count that is
 * not derived from the bytes the hash covers is not attested by it. Two
 * separate `readFileSync` calls -- which is what this replaced -- leave a window
 * for a concurrent `learn()` to land between them, after which the checkpoint
 * asserts a count for a store state its own hash does not describe. Nothing
 * downstream can detect that, because both values look individually well-formed.
 *
 * Parse errors THROW rather than degrading. The previous `catch { return 0 }` on
 * the count meant an unreadable or malformed store produced a checkpoint
 * attesting "0 engrams" beside a hash of a full store -- a false attestation,
 * which is worse than no attestation. A checkpoint that cannot be computed
 * honestly must not be written.
 *
 * @param engramsPath - absolute path to engrams.yaml.
 * @returns the canonical store hash and the active engram count, from one read.
 * @throws if the store cannot be read or parsed.
 */
export function attestStore(engramsPath: string): { store_hash: string; engram_count: number } {
  const raw = fs.readFileSync(engramsPath, 'utf8')

  // Hash the CONTENT, not the bytes.
  //
  // Raw-byte hashing made store_hash differ for identical stores across LF vs
  // CRLF and trailing-newline vs none, so an anchored store_hash only ever
  // proved that someone holds a byte-identical copy of the file — it would not
  // survive git autocrlf, a different YAML emitter, or a different OS. For the
  // one value a checkpoint exists to have anchored, that is close to useless.
  //
  // Canonicalising the parsed document gives a digest that is stable across
  // re-serialisation, emitter and platform, which is what a third party needs
  // in order to check our claim. Same choice, and the same reasoning, as
  // `.datacore/lib/ledger/fold.py:state_root()`.
  //
  // The trade, stated: this attests the engrams, not the file. A comment-only
  // or formatting-only edit does not change it. That is the correct scope for
  // provenance — the record is the data, not its whitespace.
  //
  // Depends on sortKeysDeep honouring toJSON: js-yaml parses ISO timestamps
  // into Date objects, which without that fix canonicalise to `{}`.
  const parsed = yaml.load(raw)
  const store_hash = createHash('sha256').update(canonicalBytesOf(parsed)).digest('hex')
  return { store_hash, engram_count: countActive(parsed, engramsPath) }
}

/**
 * Active engrams in an ALREADY-PARSED store document.
 *
 * Takes the parsed document, not a path, so it cannot re-read the file and
 * cannot disagree with the hash computed beside it.
 *
 * @param doc - the parsed engrams.yaml document.
 * @param engramsPath - only for the error message.
 * @returns the number of active (non-retired) engrams.
 * @throws if the document is not a store shape.
 */
function countActive(doc: unknown, engramsPath: string): number {
  const list = Array.isArray(doc) ? doc : (doc as { engrams?: unknown } | null)?.engrams
  if (!Array.isArray(list)) {
    throw new Error(
      `[plur] cannot checkpoint ${engramsPath}: expected a store document with an 'engrams' list, ` +
      `got ${doc === null || doc === undefined ? 'nothing' : typeof doc}. ` +
      `Refusing rather than attesting a count of 0 beside a hash of the real file.`,
    )
  }
  return list.filter(e => {
    const status = (e as { status?: unknown } | null)?.status
    return status === undefined || status === 'active'
  }).length
}

/** Canonical UTF-8 JSON bytes of any parsed value — the §3 form. */
function canonicalBytesOf(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(sortKeysDeep(value)), 'utf8')
}

/**
 * Count the active engrams in a store.
 *
 * Thin wrapper over {@link attestStore}. Prefer `attestStore` when you also
 * need the hash: calling this AND `hashEngramsFile` reads the file twice and
 * reopens the window where the two disagree.
 *
 * @param engramsPath - absolute path to engrams.yaml.
 * @returns the number of active engrams.
 * @throws if the store cannot be read or parsed.
 */
export function countEngramsInStore(engramsPath: string): number {
  return attestStore(engramsPath).engram_count
}

/**
 * Emit a `checkpoint` history event for the store at `root`.
 *
 * Computes:
 *   - chain_head: the predecessor hash (last chained event in the store)
 *   - store_hash: SHA-256 of engrams.yaml bytes (only done at checkpoint time)
 *   - engram_count: number of active engrams provided by the caller
 *
 * The checkpoint is itself a chained event — it gets its own hash and prev
 * via appendHistory, so two checkpoints across a month boundary chain correctly
 * via the existing cross-month mechanism.
 *
 * The `engram_id` field is set to '' (empty string — same convention as
 * session_scope_changed): checkpoints are store-level events, not engram-level.
 *
 * @param root        — plur store root (e.g. ~/.plur)
 * @param engramsPath — absolute path to engrams.yaml
 * The caller does NOT supply the engram count. It used to, and
 * `emitCheckpoint(root, path, 99999, 'cli')` against a one-engram store wrote
 * 99999 verbatim. The first fix kept the parameter and ignored it, which is
 * worse in a published API: every existing call still compiles and its argument
 * is silently discarded. The parameter is gone, so a stale call is a type error
 * the compiler reports rather than a number that quietly stops mattering.
 * @param actor       — who triggered the checkpoint ('session_end' | 'cli' | custom)
 * @param timestamp   — ISO-8601 timestamp; defaults to now
 * @returns the written CheckpointData
 */
export function emitCheckpoint(
  root: string,
  engramsPath: string,
  actor: string,
  timestamp?: string,
): CheckpointData {
  const ts = timestamp ?? new Date().toISOString()

  const event: HistoryEvent = {
    event: 'checkpoint',
    engram_id: '', // store-level event; no single engram
    timestamp: ts,
    data: {} as Record<string, unknown>, // filled under the lock, below
  }

  // chain_head must be the SAME predecessor the event chains onto.
  //
  // It used to be computed here, followed by file I/O, and only then handed to
  // appendHistory — which independently recomputed `prev`. Any write landing in
  // that window made `data.chain_head` disagree with the event's own `prev`:
  // 76/300 mismatching checkpoints at 200 KB, 174/300 at 2 MB, 101/200 at
  // 15 MB in review testing. The field meant for external anchoring was the
  // field that went wrong.
  //
  // So the predecessor is read once, inside the same lock that appends, and the
  // payload is built from it. `appendHistoryWithPrev` is appendHistory's own
  // critical section, entered once.
  appendHistoryStamped(root, event, prev => {
    // Attest INSIDE the chain lock, from ONE read.
    //
    // Two bindings are being made here and both are load-bearing:
    //
    //  1. store_hash to engram_count. Computed from two separate reads, a
    //     concurrent write landing between them produced a count for a store
    //     state the hash beside it did not describe.
    //
    //  2. store_hash to chain_head. This is the one that matters for the
    //     purpose #1052 exists for. Attesting before entering the lock meant
    //     the store could move between the digest and the predecessor the event
    //     records: measured at 294 of 297 checkpoints attesting a state that
    //     was not the state at their own chain_head (median lag one mutation,
    //     max four; 112 of 129 at 2 MB). Every digest was a real earlier state,
    //     so it read as stale rather than corrupt — but a third party who
    //     replays the log to chain_head and hashes the store gets a different
    //     digest, which is exactly the check the checkpoint exists to make
    //     possible.
    //
    // The cost is holding the chain lock across a whole-store parse. That is
    // the right trade: checkpoints are explicit and rare (CLI, session end),
    // history appends are frequent and short, and an attestation that is not
    // bound to what it attests is not worth the lock it saved. The `onPrev`
    // contract is widened from "cheap, no I/O" to "may read the store", which
    // is documented on appendHistoryStamped.
    //
    // A throw here aborts the checkpoint rather than writing an unattested one
    // — see the onPrevFailure handling in appendHistoryStamped.
    const { store_hash, engram_count } = attestStore(engramsPath)
    const data: CheckpointData = { chain_head: prev, store_hash, engram_count, actor }
    event.data = data as unknown as Record<string, unknown>
  })

  // The checkpoint's OWN hash, returned but not persisted — an event cannot
  // contain its own hash (canonical bytes exclude the field). Without it the
  // identity of the thing you would anchor is unobtainable from any caller:
  // the CLI printed only chain_head/store_hash/engram_count/actor, and the MCP
  // tool returned the STORE hash under the name `checkpoint_hash`. #1052 exists
  // so that a checkpoint is anchorable, and a payload omitting the hash you
  // would anchor is not anchorable either.
  return { ...(event.data as unknown as CheckpointData), event_hash: event.hash ?? null }
}

/**
 * Read history events from a specific month's JSONL file.
 * Returns empty array if file doesn't exist.
 */
export function readHistory(root: string, yearMonth: string): HistoryEvent[] {
  const filePath = join(root, 'history', `${yearMonth}.jsonl`)
  if (!fs.existsSync(filePath)) return []

  const content = fs.readFileSync(filePath, 'utf8')
  const lines = content.split('\n').filter(l => l.trim().length > 0)
  const events: HistoryEvent[] = []
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as HistoryEvent)
    } catch {
      // Skip malformed lines
    }
  }
  return events
}

/**
 * Ids this store has ever MINTED whose prefix matches one of `prefixes` (#816).
 *
 * `generateEngramId` allocates by scanning the corpus for the highest same-day
 * suffix, so the corpus is the only record of what has been handed out — and
 * `compact()` removes rows, which frees their ids for reuse. Two different
 * engrams then share an id, and everything keyed by id that outlives the corpus
 * entry (history itself, backups and restore diffs, `supersedes` edges, outbox
 * rows, remote store rows) silently merges two lives into one.
 *
 * The repair needs a record of allocation that survives removal. That record
 * already exists: this log is append-only, keyed by engram id, and written on
 * every create — nothing is ever deleted from it, which is exactly the property
 * the corpus lacks. No new state, no store-format change, no migration.
 *
 * ## Why this is safe even though history writes are best-effort
 *
 * Several call sites wrap `appendHistory` in try/catch, deliberately: a failed
 * history write must not fail the write it describes. So this can UNDER-report.
 * That is tolerable because the failure is one-directional — a missed record
 * leaves allocation exactly where it is today, while every record found can
 * only push the next suffix higher. Reading more allocation history can never
 * create a collision, only avoid one.
 *
 * Reads a single month (allocation is per-day, so only the current month can
 * hold same-day ids) and never throws: an unreadable log degrades to today's
 * corpus-only behaviour rather than blocking a write.
 */
export function mintedIdsWithPrefix(root: string, yearMonth: string, prefixes: string[]): string[] {
  try {
    const out: string[] = []
    for (const ev of readHistory(root, yearMonth)) {
      if (ev.event !== 'engram_created') continue
      const id = ev.engram_id
      if (typeof id === 'string' && prefixes.some(p => id.startsWith(p))) out.push(id)
    }
    return out
  } catch {
    return []
  }
}

/**
 * List all available history months (YYYY-MM format).
 */
export function listHistoryMonths(root: string): string[] {
  const historyDir = join(root, 'history')
  if (!fs.existsSync(historyDir)) return []
  return fs.readdirSync(historyDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace('.jsonl', ''))
    .sort()
}

/**
 * Read all history events for a specific engram, across all months.
 * Returns events sorted chronologically.
 */
export function readHistoryForEngram(root: string, engramId: string): HistoryEvent[] {
  const months = listHistoryMonths(root)
  const events: HistoryEvent[] = []
  for (const month of months) {
    const monthEvents = readHistory(root, month)
    for (const event of monthEvents) {
      if (event.engram_id === engramId) {
        events.push(event)
      }
    }
  }
  return events
}

// Per-process 2-char salt (PID mod 1296, base36) prevents cross-process
// same-millisecond collisions when the MCP server and a hook-spawned CLI
// process both call generateInjectionId()/generateEventId() concurrently.
// Suffix format: <2-char salt><4-char counter> = 6 chars [a-z0-9]{6}.
// Counter overflows to 5 chars past 36^4 (1,679,616 events/process) — not
// reachable in practice; suffix becomes 7 chars, IDs remain unique.
const _PROC_SALT = (process.pid % 1296).toString(36).padStart(2, '0')
let _evtSeq = 0
let _injSeq = 0

/**
 * Generate a globally-unique event ID for history entries.
 * Cross-process uniqueness via PID salt; intra-process via monotonic counter.
 * Format: EVT-<ts>-<2-char-pid-salt><4-char-counter>
 */
export function generateEventId(): string {
  return `EVT-${Date.now()}-${_PROC_SALT}${(_evtSeq++).toString(36).padStart(4, '0')}`
}

// --- Injection provenance (#452) ---
//
// Two event types feed the co-fire edge pipeline (#200/#201) and
// temporal-replay self-labeling (#202):
//
//   co_injection      — one per inject/session-start with >=1 injected engram.
//                       engram_id carries the injection ID (INJ-...) so the
//                       event is addressable; data = { ids, query_hash, ... }.
//                       Kept compact: engram IDs only, never statements.
//                       Measured: ~325 B at 5 ids, ~625 B at 20 ids.
//   injection_outcome — one per positive/negative plur_feedback verdict on an
//                       engram that was previously injected; data links back
//                       via { injection_id, signal }. ~170 B. "Ignored" is the
//                       ABSENCE of an outcome for an injected engram — no
//                       synthetic ignore events are ever written.
//
// Growth at ~50 sessions/day (one co_injection each, a handful of outcomes):
// under ~1 MiB/month of JSONL — see the #452 PR body for the measured table.

/**
 * Generate a globally-unique injection ID for co_injection events.
 * Cross-process uniqueness via PID salt; intra-process via monotonic counter.
 * Format: INJ-<ts>-<2-char-pid-salt><4-char-counter>
 */
export function generateInjectionId(): string {
  return `INJ-${Date.now()}-${_PROC_SALT}${(_injSeq++).toString(36).padStart(4, '0')}`
}

/**
 * Compact, stable hash of the injection query context. Case- and
 * whitespace-insensitive so retries of the same task hash identically.
 */
export function computeQueryHash(task: string): string {
  const normalized = task.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16)
}

/**
 * Find the most recent co_injection event that included the given engram.
 * Scans the newest `maxMonths` history files only (bounded read) — feedback
 * on injections older than that is not attributable to a specific injection.
 * Returns null when no recent co_injection contains the engram.
 */
export function findLatestInjectionFor(
  root: string,
  engramId: string,
  maxMonths = 2,
): { injection_id: string; timestamp: string } | null {
  // Time-based window: the maxMonths calendar months ending at the current
  // month. A sparse store's newest files can be arbitrarily old — linking
  // feedback to an injection from years ago would be a false label.
  const now = new Date()
  const allowed = new Set<string>()
  for (let i = 0; i < maxMonths; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    allowed.add(d.toISOString().slice(0, 7))
  }
  const months = listHistoryMonths(root).filter(m => allowed.has(m)).reverse()
  for (const month of months) {
    let latest: HistoryEvent | null = null
    for (const event of readHistory(root, month)) {
      if (event.event !== 'co_injection') continue
      const ids = event.data.ids
      if (!Array.isArray(ids) || !ids.includes(engramId)) continue
      if (!latest || event.timestamp > latest.timestamp) latest = event
    }
    if (latest) return { injection_id: latest.engram_id, timestamp: latest.timestamp }
  }
  return null
}

/**
 * Which surface asked for an injection. `'recall'` is deliberately absent:
 * plur_recall / plur_recall_hybrid do not route through _formatInjection and
 * therefore emit no co_injection event at all.
 */
export type InjectionSource = 'session_start' | 'inject' | 'hook' | 'unknown'

const INJECTION_SOURCES: ReadonlySet<string> = new Set([
  'session_start', 'inject', 'hook', 'unknown',
])

// Strict ISO-8601 as produced by Date.prototype.toISOString (the only shape a
// co_injection timestamp legitimately takes). Used instead of a bare Date.parse
// check, which accepts control characters inside a date and returns non-NaN.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Payload of a `co_injection` event. `tokens_used` and `source` were added by
 * the memory-receipt work; events written before that lack them, so both are
 * optional and every reader must tolerate their absence.
 */
export interface CoInjectionData {
  ids: string[]
  query_hash: string
  tokens_used?: number
  source?: InjectionSource
  scope?: string
  session_id?: string
}

export interface CoInjectionEvent {
  injection_id: string
  timestamp: string
  data: CoInjectionData
}

export interface CoInjectionReadResult {
  events: CoInjectionEvent[]
  /**
   * Count of co_injection events that were unusable or had to be cleaned:
   * a malformed payload (no ids array / no query_hash / unparseable timestamp),
   * dropped entirely, OR a kept event that had non-string ids stripped out.
   * Corrupt-JSON lines are dropped upstream in readHistory and are NOT counted
   * here. A diagnostic signal only — not currently surfaced in the receipt.
   */
  skipped: number
}

/**
 * Read every co_injection event across all history months, oldest first.
 *
 * Defensive by design: this feeds a read-only report that must degrade to
 * "no data" rather than throw. Unknown `source` values are coerced to
 * 'unknown' so they can never become arbitrary keys in a caller's tally, and
 * non-string ids are dropped so they can never reach a renderer.
 */
export function readCoInjections(root: string, months?: string[]): CoInjectionReadResult {
  const events: CoInjectionEvent[] = []
  let skipped = 0
  const wanted = months ? new Set(months) : null

  for (const month of listHistoryMonths(root)) {
    if (wanted && !wanted.has(month)) continue
    for (const event of readHistory(root, month)) {
      if (event.event !== 'co_injection') continue
      const raw = event.data as Partial<CoInjectionData>
      if (!Array.isArray(raw.ids) || typeof raw.query_hash !== 'string') { skipped++; continue }
      // Strict ISO-8601 only. Date.parse is lenient (accepts control chars in a
      // date, returns non-NaN); the timestamp is later sliced into the rendered
      // window dates, so a crafted line must not pass. co_injection timestamps
      // are always toISOString().
      if (typeof event.timestamp !== 'string' || !ISO_TIMESTAMP.test(event.timestamp)) { skipped++; continue }

      const ids = raw.ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
      if (ids.length !== raw.ids.length) skipped++

      const data: CoInjectionData = { ids, query_hash: raw.query_hash }
      if (typeof raw.tokens_used === 'number' && Number.isFinite(raw.tokens_used)) {
        data.tokens_used = raw.tokens_used
      }
      if (raw.source !== undefined) {
        data.source = INJECTION_SOURCES.has(raw.source) ? raw.source : 'unknown'
      }
      if (typeof raw.scope === 'string') data.scope = raw.scope
      if (typeof raw.session_id === 'string') data.session_id = raw.session_id

      events.push({ injection_id: event.engram_id, timestamp: event.timestamp, data })
    }
  }
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
  return { events, skipped }
}

export interface InjectionEventCounts {
  co_injection: number
  injection_outcome: number
  outcome_positive: number
  outcome_negative: number
}

/**
 * Count injection-provenance events across all history months. Feeds the
 * #202 volume gate via plur_status — training on injection outcomes is
 * gated on having enough labels.
 */
export function countInjectionEvents(root: string): InjectionEventCounts {
  const counts: InjectionEventCounts = {
    co_injection: 0,
    injection_outcome: 0,
    outcome_positive: 0,
    outcome_negative: 0,
  }
  for (const month of listHistoryMonths(root)) {
    for (const event of readHistory(root, month)) {
      if (event.event === 'co_injection') {
        counts.co_injection++
      } else if (event.event === 'injection_outcome') {
        counts.injection_outcome++
        if (event.data.signal === 'positive') counts.outcome_positive++
        else if (event.data.signal === 'negative') counts.outcome_negative++
      }
    }
  }
  return counts
}
