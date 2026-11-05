import * as fs from 'fs'
import { withLock } from './file-lock.js'
import * as yaml from 'js-yaml'
import { logger } from './logger.js'
import { join } from 'path'
import { createHash } from 'crypto'
// session-manifest imports this module too; the cycle is safe because the
// record hash is only called at checkpoint time, after both have loaded.
import { computeRecordHash } from './session-manifest.js'
import type { Engram } from './schemas/engram.js'

export interface HistoryEvent {
  event: 'engram_created' | 'engram_updated' | 'engram_merged' | 'feedback_received' | 'engram_retired' | 'engram_decremented' | 'engram_promoted' | 'engram_rescoped' | 'failure_reported' | 'procedure_evolved' | 'recurrence_detected' | 'contradiction_detected' | 'scope_promoted' | 'buffer_pruned' | 'weekly_review' | 'engram_route_failed' | 'co_injection' | 'injection_outcome' | 'session_scope_changed' | 'dedup_near_duplicate' | 'engram_duplicate_absorbed' | 'checkpoint'
    /** A later copy of a clashing id was given a fresh id. `engram_id` is the NEW id; `data.from` the old one. */
    | 'engram_rekeyed'
    /** Engrams a recall returned to a session. `data.ids`, `data.session_id`, `data.query_hash`, `data.source`. */
    | 'recall_returned'
    /** A sync pull changed memories this machine did not write. `data.engram_ids` names them; `data.cause`. */
    | 'store_synced'
    /** compact() removed retired rows. `data.engram_ids` names them. */
    | 'store_compacted'
  /**
   * Engram this event belongs to. Session-level events
   * (`session_scope_changed`) carry no engram — they use `''`, which by
   * construction never matches a real id in `readHistoryForEngram`.
   */
  engram_id: string
  timestamp: string // ISO
  data: Record<string, unknown> // event-specific payload
  /**
   * Who or what caused this event.
   *
   * Optional, and omitted rather than guessed. Every reader MUST tolerate its
   * absence: older events have none, and a writer that does not know the actor
   * leaves it out. The shape matches `attribution` on the engram (see
   * `AttributionSchema` in `schemas/engram.ts`).
   */
  actor?: {
    asserted_by?: string
    runtime?: { name: string; version?: string }
    model?: { name: string; prompt_id?: string; prompt_version?: string; prompt_sha256?: string }
    tool?: { name: string; version?: string }
    on_behalf_of?: string
  }
  /** Why this happened, when the caller knows. */
  reason?: string
  /**
   * SHA-256 over the canonical bytes of this event (sorted keys, no whitespace,
   * ISO-8601 timestamps). Set by appendHistory(). Older events have no hash
   * field — readers must tolerate its absence.
   */
  hash?: string
  /**
   * Hash of the predecessor event in the chain, or null when this event is the
   * genesis of the chain or the predecessor could not be read (a gap — the
   * write still proceeds, never fabricates). Older events have no prev field.
   */
  prev?: string | null
  /**
   * Ed25519 signature over the canonical bytes of this event (the same bytes
   * the `hash` covers — excludes `hash`, `signature`, and `signer` themselves).
   * Present only on `checkpoint` events when the acting identity has a key
   * configured. Base64-encoded. A missing signature means "unsigned (L2)",
   * not "tampered".
   */
  signature?: string
  /**
   * Identity of the signer when `signature` is present. Top-level field,
   * excluded from canonical bytes (so it cannot differ from the signature's
   * implicit claim). Readers must tolerate its absence.
   */
  signer?: string
}

/**
 * Recursively sort object keys by UTF-16 code unit order (lexicographic), the
 * same sort order used by JSON.stringify's default key visitor in V8.
 * Arrays are preserved as arrays (elements sorted recursively if objects).
 *
 * This is the canonical-bytes normaliser: every event hash is computed over
 * JSON.stringify(sortKeysDeep(event_without_hash)), so two independent
 * implementations that agree on this function agree on all hashes.
 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep)
  }
  if (value !== null && typeof value === 'object') {
    // Honour toJSON BEFORE walking the object, exactly as JSON.stringify does.
    // Otherwise a value with custom serialisation (e.g. a Date) canonicalises
    // to `{}` while JSON.stringify writes it as an ISO string, so the hash
    // would cover bytes that are not the bytes on disk. js-yaml parses ISO
    // timestamps into Date objects, so hashing parsed YAML depends on this.
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
 * Canonical bytes for a history event: UTF-8 JSON, keys sorted recursively by
 * UTF-16 code unit (JS default sort), no insignificant whitespace.
 * `hash` is excluded (it is computed from these bytes); `prev` is included as
 * part of the chain linkage. Timestamps must be ISO-8601 strings, never floats;
 * hashes are lowercase hex SHA-256.
 */
export function canonicalEventBytes(event: HistoryEvent): Buffer {
  // `hash` is excluded because it is computed FROM these bytes (circular).
  // `signature` and `signer` are excluded for the same reason: both `hash`
  // and `signature` cover the identical payload, and `signer` is metadata
  // about the signing — excluding it keeps the signed bytes stable regardless
  // of which identity signs. A third-party verifier recomputes hash and checks
  // the signature from the same canonical form without special-casing any field.
  const { hash: _hash, signature: _sig, signer: _snr, ...rest } = event
  void _hash
  void _sig
  void _snr
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
 * Sidecar in the history directory holding the 64-char hex hash of the last
 * chained event: a 65-byte read that works across processes. It is advisory —
 * the JSONL is authoritative, and an absent, invalid or suspect sidecar falls
 * back to tail-seeking. A stale sidecar after a crash yields a documented gap.
 */
const CHAIN_HEAD_FILE = '.chain-head'

/** Hex-only, exactly 64 characters. */
const HEX64 = /^[0-9a-f]{64}$/

/**
 * In-process cache of the last chain-head hash per historyDir: tier 1 of
 * findPredecessorHash (memory, then sidecar, then JSONL tail-seek).
 * Covers only this process's writes; the sidecar covers other processes.
 * Call clearChainHeadMemCache(historyDir) when the store is reloaded from disk.
 */
interface ChainHeadRecord {
  /** Chain head hash as of the observation below. */
  hash: string
  /** Month file the hash was read from / written to. */
  file: string
  /** Byte size of that file at the moment the hash was recorded. */
  size: number
  /** Inode of that file, so a wiped-and-recreated store is not mistaken for it. */
  ino: number
}

const _chainHeadMem = new Map<string, ChainHeadRecord>()

/**
 * Is a recorded observation still true of the file on disk? The cache and
 * sidecar are trusted only while the file has the same size and inode:
 * another process's append changes the size, a crash before the sidecar write
 * leaves it describing a shorter file, and a recreated store gets a new inode.
 * Fails CLOSED: any doubt falls through to the authoritative tail-seek.
 */
function observationHolds(rec: ChainHeadRecord, file: string): boolean {
  if (rec.file !== file) return false
  try {
    const st = fs.statSync(file)
    return st.size === rec.size && st.ino === rec.ino
  } catch {
    return false
  }
}

/**
 * Clear the in-process chain-head cache for a specific history directory, or
 * all directories when called with no argument. Call this whenever the store
 * is reloaded from disk (e.g. after a sync or an explicit reload) so the next
 * findPredecessorHash falls through to the sidecar file rather than returning
 * a potentially stale in-memory value.
 */
export function clearChainHeadMemCache(historyDir?: string): void {
  if (historyDir === undefined) {
    _chainHeadMem.clear()
  } else {
    _chainHeadMem.delete(historyDir)
  }
}

/**
 * Read the sidecar chain-head file. Returns the 64-char hex hash or null when
 * the file is absent, empty, or contains an invalid value.
 */
export function readChainHead(historyDir: string, currentMonthFile?: string): string | null {
  try {
    const content = fs.readFileSync(join(historyDir, CHAIN_HEAD_FILE), 'utf8').trim()

    // Plain-hash sidecar (older format). Trusted only when the caller does not
    // care which file it describes — it carries no way to check itself, so a
    // validating caller must reject it.
    if (HEX64.test(content)) return currentMonthFile === undefined ? content : null

    const rec = JSON.parse(content) as Partial<ChainHeadRecord>
    if (typeof rec.hash !== 'string' || !HEX64.test(rec.hash)) return null
    if (typeof rec.file !== 'string' || typeof rec.size !== 'number' || typeof rec.ino !== 'number') return null
    if (currentMonthFile === undefined) return rec.hash
    return observationHolds(rec as ChainHeadRecord, currentMonthFile) ? rec.hash : null
  } catch {
    return null // ENOENT, malformed, or any I/O error — fall back to tail-seek
  }
}

/**
 * Drop every cached chain-head observation for `historyDir`.
 *
 * Used when we cannot bound what we just observed — an unlocked write, or a
 * stat that failed. Both tiers go, including the on-disk sidecar: leaving a
 * stale sidecar behind would let ANOTHER process trust an observation this one
 * already knows is unreliable.
 *
 * @param historyDir - the history directory whose caches to drop.
 */
function invalidateChainHead(historyDir: string): void {
  _chainHeadMem.delete(historyDir)
  try { fs.unlinkSync(join(historyDir, CHAIN_HEAD_FILE)) } catch { /* already gone */ }
}

/**
 * Write the sidecar chain-head file. Best-effort: a write failure must not
 * propagate to the caller or fail the history append. The sidecar is advisory;
 * the JSONL is authoritative.
 */
function writeChainHead(historyDir: string, rec: ChainHeadRecord): void {
  const target = join(historyDir, CHAIN_HEAD_FILE)
  const tmp = `${target}.${process.pid}.tmp`
  try {
    // Temp-file-and-rename so a reader can never observe a half-written
    // sidecar. Deliberately NOT fsynced: the sidecar is advisory and
    // self-validating — one lost or left behind by a crash fails its own
    // size/inode check and the lookup falls through to the authoritative
    // tail-seek, so an fsync per append would cost the hot path for nothing.
    fs.writeFileSync(tmp, JSON.stringify(rec) + '\n', 'utf8')
    fs.renameSync(tmp, target)
  } catch {
    // best-effort — sidecar is advisory; JSONL is authoritative
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean up */ }
  }
}

// tailSeekLastHash: the predecessor-hash read for chain linkage. Reads the last
// TAIL_WINDOW bytes and scans back for a newline; if the window lies inside the
// final line it doubles, up to TAIL_MAX_WINDOW, so a large event never reads as
// a gap over an intact log. Missing, unreadable or hashless input returns null
// (a documented gap, never an error); appendHistory writes the gap marker.
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

/**
 * The hash of the last CHAINED event in `text`, scanning backwards.
 * Skips hashless events (from an older PLUR on the same store), matching
 * `verifyChain`. A line that will not parse stops the scan: under the lock a
 * torn tail is already dropped (dropTornTail), so it is corruption.
 * @returns the hash; null when a line will not parse; undefined when the text
 *          holds no chained event at all.
 */
function lastChainedHash(text: string): string | null | undefined {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return null // malformed JSON — treat as unreadable
    }
    const hash = (parsed as { hash?: unknown } | null)?.hash
    if (typeof hash === 'string' && hash.length === 64) return hash
  }
  return undefined
}

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
      //
      // Keep every COMPLETE line in the window (drop only the leading
      // fragment), so the scan below can step back over events that carry no
      // hash; grow the window when none of them does.
      const body = text.replace(/\n+$/, '')
      const firstBoundary = body.indexOf('\n')
      if (firstBoundary !== -1) {
        const found = lastChainedHash(body.slice(firstBoundary + 1))
        if (found !== undefined) return found
      }
      if (window >= TAIL_MAX_WINDOW) return null // documented gap, never an OOM
    }
    return lastChainedHash(text) ?? null
  } catch {
    return null
  }
}

/**
 * Hash of the most recent chained event, current month file first, then
 * earlier months. Lookup order: in-process cache (_chainHeadMem), the
 * `.chain-head` sidecar, then the JSONL tail-seek.
 * Returns null when there is no chained predecessor (genesis, gap, or
 * unreadable files).
 */
export function findPredecessorHash(historyDir: string, currentMonthFile: string): string | null {
  // Tier 1: in-process memory, validated. The cached hash is accepted only
  // while the month file still has the length and inode it had when the hash
  // was recorded — one statSync, no read, no parse. Without the check, another
  // process's appends would be invisible and two long-lived writers (e.g. an
  // MCP server and a CLI on the same store) would fork the chain.
  const rec = _chainHeadMem.get(historyDir)
  if (rec !== undefined && observationHolds(rec, currentMonthFile)) return rec.hash

  // Tier 2: sidecar file — cross-process fast path, validated the same way.
  // Passing currentMonthFile is what makes it reject a sidecar left stale by a
  // crash between the JSONL fsync and the sidecar write.
  const sidecarHash = readChainHead(historyDir, currentMonthFile)
  if (sidecarHash !== null) return sidecarHash

  // Slow path (sidecar absent or invalid, e.g. cold start or after a crash):
  // fall back to JSONL tail-seek.

  // If the current month file has content, the predecessor (if any) is within
  // it. A null return means the last event has no hash (gap) or the file is
  // empty/unreadable. Prior months are not consulted in that case.
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
      // If the last event in the most recent prior month has no hash, stop —
      // no chained predecessor exists before this gap.
      break
    }
  } catch {
    // best-effort
  }
  return null
}

/**
 * Append a history event to {root}/history/YYYY-MM.jsonl, setting `prev` (the
 * predecessor hash, across months) and `hash` over the canonical bytes.
 * - Read-tail, hash and append run under a short cross-process lock on the
 *   history dir; lock order is store lock then this one, never the reverse
 *   (nothing here calls back into store code). Callers need not hold the store lock.
 * - Lock failure or unreadable predecessor writes `prev: null` (a declared gap,
 *   never a fabricated hash); the write must still land. Legacy events stay as-is.
 * @returns `true` when written. Never throws, so callers that must stay
 *          consistent with the log (e.g. `injection_count`) check the result.
 */
export function appendHistory(root: string, event: HistoryEvent): boolean {
  return appendHistoryStamped(root, event)
}

/**
 * `appendHistory` with an `onPrev` hook run inside the critical section once the
 * predecessor is known, before serialising. Checkpoints use it so `chain_head`
 * is exactly the `prev` this append chains onto.
 * `onPrev` holds the chain lock and may read the store; keep it minimal, since
 * every history append waits behind it.
 */
export function appendHistoryStamped(
  root: string,
  event: HistoryEvent,
  onPrev?: (prev: string | null) => void,
): boolean {
  const historyDir = join(root, 'history')
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true })
  }

  const date = event.timestamp.slice(0, 7) // YYYY-MM
  // Recomputed under the lock (targetMonthFile): an event stamped before a
  // month boundary that another writer already crossed joins the newest file.
  let filePath = join(historyDir, `${date}.jsonl`)

  // Read-tail -> compute -> WRITE must all run under the lock (`withLock`, the
  // synchronous twin of the store lock), or two writers chain from the same
  // predecessor and the log forks.
  // An `onPrev` failure is not a lock failure: it is rethrown rather than
  // falling back to an unlocked append with an incomplete payload.
  let onPrevFailure: unknown
  let written = false
  const stampAndWrite = (): void => {
    filePath = targetMonthFile(historyDir, date)
    dropTornTail(historyDir, filePath)
    const predecessorHash = findPredecessorHash(historyDir, filePath)
    event.prev = predecessorHash // null when gap or genesis
    // Payload built from the predecessor this append will actually use, before
    // the hash covers it (checkpoints).
    try {
      onPrev?.(predecessorHash)
    } catch (err) {
      onPrevFailure = err
      throw err
    }
    event.hash = computeEventHash(event) // canonical bytes exclude the hash field
    written = writeEventLine(JSON.stringify(event) + '\n', true)
  }
  // fsync the append: `plur restore` uses this log to name unrecoverable
  // engrams. The append is best-effort (never fail the caller's mutation), but
  // failures are warned, not swallowed.
  /**
   * Append one JSONL line and record the chain head it establishes.
   * Only a writer holding the chain lock (`chained`) may update the caches: an
   * unlocked writer's stat can include a concurrent append and pass validation
   * while naming the wrong tail. The unlocked path instead drops the memory
   * entry and removes the sidecar, forcing the next lookup to tail-seek.
   */
  function writeEventLine(line: string, chained: boolean): boolean {
  try {
    const fd = fs.openSync(filePath, 'a')
    try {
      fs.writeSync(fd, line)
      try { fs.fsyncSync(fd) } catch { /* append landed; durability is best-effort */ }
    } finally {
      fs.closeSync(fd)
    }
    // Record what we just observed: the hash and the exact file state it
    // describes, in both the in-process cache and the on-disk sidecar. Both
    // tiers are validated against this on the next lookup, so neither can
    // outlive the state it was true of.
    if (!chained) {
      // Wrote without the lock. Anything we observe now may already include
      // another writer's append, so there is no observation worth keeping.
      invalidateChainHead(historyDir)
    } else {
      try {
        const st = fs.statSync(filePath)
        const rec: ChainHeadRecord = { hash: event.hash!, file: filePath, size: st.size, ino: st.ino }
        _chainHeadMem.set(historyDir, rec)
        writeChainHead(historyDir, rec)
      } catch {
        // Could not stat what we just wrote — drop the cache rather than record
        // an observation we cannot bound. The next lookup tail-seeks, which is
        // slower and always right.
        invalidateChainHead(historyDir)
      }
    }
    return true
  } catch (err) {
    if (!warnedHistoryPaths.has(filePath)) {
      warnedHistoryPaths.add(filePath)
      logger.warning(
        `[plur] history could not be written to ${filePath}: ${(err as Error).message}. ` +
        `The operation itself succeeded. While this persists, \`plur restore\` cannot name ` +
        `unrecoverable engrams and engram-id allocation loses its cross-compaction guarantee.`,
      )
    }
    return false
  }
  }

  try {
    // This critical section is microseconds (tail-read, hash, append), so the
    // default 100 ms first backoff would make waiters starve and fall through
    // to the gap path. Start at 2 ms and still back off exponentially.
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
    filePath = targetMonthFile(historyDir, date)
    // Without the lock a torn tail is not ours to truncate (another writer may
    // be mid-append), so start on a fresh line instead of gluing onto it.
    written = writeEventLine((endsMidLine(filePath) ? '\n' : '') + JSON.stringify(event) + '\n', false)
  }
  return written
}

/**
 * The month file an event stamped in `ownMonth` is appended to: its own, or
 * the newest month file that already has events when that one is later.
 *
 * Timestamps are taken before the chain lock, so a writer can stamp the last
 * second of a month and get the lock after another writer started the next
 * month's file. Appending to the older file would chain onto a predecessor the
 * new month's first event already claimed, and verify would report a fork.
 * Joining the newest file keeps the log one chain in file order; the event
 * keeps its own timestamp.
 */
function targetMonthFile(historyDir: string, ownMonth: string): string {
  // Only months after this one and no later than the current month count: a
  // file stamped in the future (a skewed clock, a caller's timestamp) must not
  // capture every later append. That is normally zero or one stat — no
  // directory listing on the hot path.
  const current = new Date().toISOString().slice(0, 7)
  // An event stamped after the current month is written to the current month
  // file (its timestamp unchanged), so no month file beyond today ever starts
  // a second chain that findPredecessorHash would then walk to.
  if (ownMonth > current) return join(historyDir, `${current}.jsonl`)
  let newest = ownMonth
  for (let m = nextMonth(ownMonth); m <= current; m = nextMonth(m)) {
    try { if (fs.statSync(join(historyDir, `${m}.jsonl`)).size > 0) newest = m } catch { /* no file for that month */ }
  }
  return join(historyDir, `${newest}.jsonl`)
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return '9999-99'
  return m >= 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}

/** Number of memory groups a checkpoint fingerprints separately. */
export const STORE_BUCKETS = 64

/** The group a memory id falls into, 0..STORE_BUCKETS-1, from a hash of the id. */
export function storeBucketOf(id: string): number {
  return createHash('sha256').update(id).digest()[0] % STORE_BUCKETS
}

/** True when the file exists, is non-empty, and its last byte is not a newline. */
function endsMidLine(filePath: string): boolean {
  try {
    const st = fs.statSync(filePath)
    if (st.size === 0) return false
    const fd = fs.openSync(filePath, 'r')
    try {
      const b = Buffer.alloc(1)
      fs.readSync(fd, b, 0, 1, st.size - 1)
      return b[0] !== 0x0a
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

/**
 * Drop an incomplete final line, under the chain lock.
 *
 * A writer killed mid-append leaves a fragment with no newline; appending
 * after it would glue the next event onto the fragment, losing it and making
 * `plur verify` refuse the file. Every chaining writer holds this lock, so a
 * fragment seen here is a dead write, not one in flight. Best-effort: a failure
 * leaves the file as it was, and the append below still starts on its own line.
 */
function dropTornTail(historyDir: string, filePath: string): void {
  if (!endsMidLine(filePath)) return
  // A writer without the lock (the gap path, or an older process still
  // running) may be mid-append right now. Watch the size briefly; a fragment
  // that is still growing is not dead and is left alone — the kernel finishes
  // that write before ours lands.
  try {
    const st0 = fs.statSync(filePath)
    // A fragment untouched for 2 s is a dead write. A fresher one is watched
    // for a few ms (sleeping, not spinning).
    if (Date.now() - st0.mtimeMs < 2000) {
      const nap = new Int32Array(new SharedArrayBuffer(4))
      for (let i = 0; i < 5; i++) {
        Atomics.wait(nap, 0, 0, 5)
        if (fs.statSync(filePath).size !== st0.size) return
      }
    }
  } catch { return }
  if (!endsMidLine(filePath)) return
  try {
    const st = fs.statSync(filePath)
    const window = Math.min(st.size, TAIL_MAX_WINDOW)
    const buf = Buffer.alloc(window)
    const fd = fs.openSync(filePath, 'r+')
    try {
      fs.readSync(fd, buf, 0, window, st.size - window)
      const nl = buf.lastIndexOf(0x0a)
      if (nl === -1 && window < st.size) return // fragment longer than the ceiling: leave it
      const keep = nl === -1 ? 0 : st.size - window + nl + 1
      fs.ftruncateSync(fd, keep)
      logger.warning(`[plur] history: dropped an incomplete final line (${st.size - keep} bytes) in ${filePath} left by an interrupted write.`)
    } finally {
      fs.closeSync(fd)
    }
    invalidateChainHead(historyDir)
  } catch { /* leave the file as it was */ }
}

/**
 * Append several events with one write and one fsync per month file — the same
 * contract as {@link appendHistory} (best-effort, never throws), for callers
 * that record many events at once.
 */
export function appendHistoryBatch(root: string, events: readonly HistoryEvent[]): boolean {
  if (events.length === 0) return true
  const historyDir = join(root, 'history')
  // The batch writes exactly the chain links the same events appended one by
  // one would. It is written in runs of consecutive events for one month file:
  // within a run each event links to the one before it; the first event of
  // each run links to what `findPredecessorHash` reads from disk after the
  // earlier runs are written — the same read a single append makes, so a batch
  // that crosses months, returns to a month, or moves into an empty month links
  // as single appends do. One write and one fsync per run, under the chain lock.
  const runs: HistoryEvent[][] = []
  for (const ev of events) {
    const last = runs.at(-1)
    if (last && last[0].timestamp.slice(0, 7) === ev.timestamp.slice(0, 7)) last.push(ev)
    else runs.push([ev])
  }
  const writeRun = (run: HistoryEvent[], firstPrev: string | null, filePath: string): boolean => {
    let prev = firstPrev
    const lines: string[] = []
    for (const ev of run) {
      ev.prev = prev
      ev.hash = computeEventHash(ev)
      prev = ev.hash
      lines.push(JSON.stringify(ev) + '\n')
    }
    let ok = true
    try {
      const fd = fs.openSync(filePath, 'a')
      try {
        fs.writeSync(fd, (endsMidLine(filePath) ? '\n' : '') + lines.join(''))
        try { fs.fsyncSync(fd) } catch { /* append landed; durability is best-effort */ }
      } finally {
        fs.closeSync(fd)
      }
    } catch (err) {
      ok = false
      if (!warnedHistoryPaths.has(filePath)) {
        warnedHistoryPaths.add(filePath)
        logger.warning(`[plur] history could not be written to ${filePath}: ${(err as Error).message}. The operation itself succeeded.`)
      }
    }
    // The head cache is not updated from here; dropping it sends the next read
    // (the next run's, or the next append's) to the authoritative tail-seek.
    invalidateChainHead(historyDir)
    return ok
  }
  try {
    if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true })
  } catch (err) {
    logger.warning(`[plur] history directory ${historyDir} could not be created: ${(err as Error).message}. The operation itself succeeded.`)
    return false
  }
  let result = true
  let done = 0
  try {
    withLock(join(historyDir, 'chain'), () => {
      for (const run of runs) {
        const file = targetMonthFile(historyDir, run[0].timestamp.slice(0, 7))
        dropTornTail(historyDir, file)
        if (!writeRun(run, findPredecessorHash(historyDir, file), file)) result = false
        done++
      }
    }, { maxRetries: 12, baseDelay: 2 })
  } catch {
    // Same rule as appendHistory: without the lock, declare a gap rather than
    // chain from a tail read without exclusion — once per run, where a single
    // append would have read a tail. Runs already written under the lock are
    // not written again.
    for (const run of runs.slice(done)) if (!writeRun(run, null, targetMonthFile(historyDir, run[0].timestamp.slice(0, 7)))) result = false
  }
  return result
}

/** Warn once per path — this is on the hot write path; a broken log must not
 *  also become a log flood. */
const warnedHistoryPaths = new Set<string>()

/**
 * Payload of a `checkpoint` history event. Through the prev/hash chain it
 * commits to all prior history once externally anchored.
 *   chain_head   — predecessor hash, or null for genesis (duplicates `prev` so
 *                  the payload is self-contained).
 *   store_hash   — hex SHA-256 over each engram's id, status and record hash
 *                  (see attestStore); only computed on explicit checkpoints.
 *   engram_count — active (non-retired) engrams at checkpoint time.
 *   actor        — trigger ('session_end' | 'cli' | string).
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
  /** Per-group fingerprints of the same records (see attestStore); absent on older checkpoints. */
  store_buckets?: string[]
  engram_count: number
  actor: string
  /** The session this checkpoint closed, when a session end wrote it. */
  session_id?: string
  /**
   * Ed25519 signature over the checkpoint's canonical bytes, base64-encoded.
   * Present only when the acting identity has a key configured.
   * An unsigned checkpoint is a valid L2 object — absence is "unsigned", not error.
   */
  signature?: string | null
  /**
   * Identity of the signer, when `signature` is present.
   * Allows a verifier to look up the public key in `keys.yaml`.
   */
  signer?: string | null
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
 * Hash a store AND count it from ONE read, so the count is attested by the
 * hash and no concurrent `learn()` can land between them.
 * Parse errors THROW: "0 engrams" beside a full-store hash is a false attestation.
 * @param engramsPath - absolute path to engrams.yaml.
 * @returns the canonical store hash and the active engram count, from one read.
 * @throws if the store cannot be read or parsed.
 */
export function attestStore(engramsPath: string): { store_hash: string; engram_count: number; store_buckets: string[] } {
  const raw = fs.readFileSync(engramsPath, 'utf8')

  // Hash parsed CONTENT, not bytes, so the digest is stable across line
  // endings, emitter and platform. Relies on sortKeysDeep honouring toJSON
  // (js-yaml yields Date objects). Each engram reduces to id, status and its
  // record hash (`computeRecordHash`), never usage counters, so ordinary
  // recall/feedback does not make `plur verify` report BROKEN.
  const parsed = yaml.load(raw)
  const engram_count = countActive(parsed, engramsPath)
  const records = storeRecords(parsed)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.record < b.record ? -1 : a.record > b.record ? 1 : 0))
  const store_hash = createHash('sha256').update(canonicalBytesOf({ kind: 'plur/store-records/v1', records })).digest('hex')
  // The same records split into STORE_BUCKETS groups by a hash of the id, each
  // fingerprinted (16 hex). Verify uses them to localise a difference: a group
  // that changed must hold a memory history names as changed since the
  // checkpoint, or the change was made behind PLUR's back.
  const groups: Array<typeof records> = Array.from({ length: STORE_BUCKETS }, () => [])
  for (const r of records) groups[storeBucketOf(r.id)].push(r)
  const store_buckets = groups.map(g => createHash('sha256').update(canonicalBytesOf(g)).digest('hex').slice(0, 16))
  return { store_hash, engram_count, store_buckets }
}

/**
 * Each memory's attested record (status + record hash) by id, or null when the
 * store cannot be read. What `recordStoreSync` compares across a sync pull.
 */
export function storeRecordMap(engramsPath: string): Map<string, string> | null {
  try {
    const parsed = yaml.load(fs.readFileSync(engramsPath, 'utf8'))
    const list = Array.isArray(parsed) ? parsed : (parsed as { engrams?: unknown[] } | null)?.engrams
    if (!Array.isArray(list)) return null
    return new Map(storeRecords(parsed).map(r => [r.id, `${r.status}:${r.record}`]))
  } catch {
    return null
  }
}

/**
 * Each engram reduced to what a checkpoint attests: id, status, record hash.
 * One definition for attestStore and storeRecordMap, so a pull is named in
 * exactly the terms verify fingerprints.
 */
function storeRecords(parsed: unknown): Array<{ id: string; status: string; record: string }> {
  const list = (Array.isArray(parsed) ? parsed : (parsed as { engrams?: unknown[] } | null)?.engrams) as Array<Record<string, unknown> | null> | undefined
  if (!Array.isArray(list)) return []
  return list
    .filter((e): e is Record<string, unknown> => e !== null && typeof e === 'object')
    .map(e => ({ id: String(e.id ?? ''), status: String(e.status ?? 'active'), record: computeRecordHash(e as unknown as Engram) }))
}

/**
 * Record the memories a sync pull changed, as one `store_synced` event naming
 * their ids.
 *
 * History is not synced, so memories another machine learned arrive in
 * engrams.yaml with no local event and would look like an edit made behind
 * PLUR's back. The pull is PLUR's own operation, so it is recorded like any
 * other write. Ids only — never content. Best-effort, like every history append.
 */
export function recordStoreSync(root: string, before: Map<string, string> | null, cause: string): void {
  if (before === null) return
  const after = storeRecordMap(join(root, 'engrams.yaml'))
  if (after === null) return
  const changed = new Set<string>()
  for (const [id, v] of after) if (before.get(id) !== v) changed.add(id)
  for (const id of before.keys()) if (!after.has(id)) changed.add(id)
  if (changed.size === 0) return
  appendHistory(root, {
    event: 'store_synced',
    engram_id: '',
    timestamp: new Date().toISOString(),
    data: { engram_ids: [...changed].sort(), cause },
  })
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

/** Canonical UTF-8 JSON bytes of any parsed value. */
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
 * Signing options for `emitCheckpoint`.
 *
 * When provided, the checkpoint event gains a `signature` field (Ed25519
 * over its canonical bytes) and a `signer` field naming the identity.
 * An unsigned checkpoint is a valid L2 object — callers omit this when no
 * key is configured.
 */
export interface CheckpointSigningOptions {
  /** The actor identity whose key should sign — typically `provenance.identity`. */
  identity: string
  /**
   * Function that returns an Ed25519 signature (base64) for the given bytes,
   * or null when the key is unavailable. Injected rather than resolved here to
   * keep `history.ts` free of a `node:crypto` dependency beyond what it already
   * has, and to make signing testable in isolation.
   */
  sign: (data: Buffer) => string | null
}

/**
 * Emit a chained `checkpoint` event (engram_id '') with chain_head, store_hash
 * and engram_count (see attestStore).
 * @param root        — plur store root (e.g. ~/.plur)
 * @param engramsPath — absolute path to engrams.yaml
 * @param actor       — who triggered the checkpoint ('session_end' | 'cli' | custom)
 * @param timestamp   — ISO-8601 timestamp; defaults to now
 * @param signing     — optional; absent means unsigned (valid L2, not L3-capable)
 * @returns the written CheckpointData
 */
export function emitCheckpoint(
  root: string,
  engramsPath: string,
  actor: string,
  timestamp?: string,
  signing?: CheckpointSigningOptions,
  sessionId?: string,
): CheckpointData {
  const ts = timestamp ?? new Date().toISOString()

  const event: HistoryEvent = {
    event: 'checkpoint',
    engram_id: '', // store-level event; no single engram
    timestamp: ts,
    data: {} as Record<string, unknown>, // filled under the lock, below
  }

  // chain_head must be the SAME predecessor the event chains onto, so the
  // predecessor is read once, inside the same lock that appends, and the
  // payload is built from it (appendHistoryStamped's onPrev hook).
  const written = appendHistoryStamped(root, event, prev => {
    // Attest INSIDE the chain lock from ONE read, binding store_hash to both
    // engram_count and chain_head (a replay to chain_head must reproduce this
    // digest). Holding the lock across a store parse is fine: checkpoints are
    // rare. A throw aborts the checkpoint (see onPrevFailure).
    const { store_hash, engram_count, store_buckets } = attestStore(engramsPath)
    const data: CheckpointData = { chain_head: prev, store_hash, store_buckets, engram_count, actor, ...(sessionId ? { session_id: sessionId } : {}) }
    event.data = data as unknown as Record<string, unknown>

    // Sign the checkpoint if a key is available. The signature is
    // computed over the canonical bytes of the event as it stands at this
    // point: data and prev are set; hash, signature, and signer are absent
    // (all three are excluded from canonical bytes by canonicalEventBytes).
    // Any field added AFTER signing would be uncovered by the signature;
    // keeping signer top-level (not in data) prevents a circular dependency
    // where the signer's identity would have to be in the signed bytes.
    //
    // An unsigned checkpoint is a valid L2 object. Signing failure is
    // best-effort: if the key cannot be read or signing fails, we proceed
    // without a signature rather than aborting the checkpoint.
    if (signing !== undefined) {
      try {
        const sig = signing.sign(canonicalEventBytes(event))
        if (sig !== null) {
          event.signature = sig
          event.signer = signing.identity
          // signer and signature are top-level fields; they are NOT added to
          // event.data so they are excluded from the canonical bytes that both
          // the hash and the signature cover — keeping both consistent.
        }
      } catch {
        // best-effort: unsigned checkpoint is still valid L2
      }
    }
  })

  // The checkpoint's OWN hash is returned but not persisted — an event cannot
  // contain its own hash (canonical bytes exclude the field). It is the value
  // a caller anchors externally.
  //
  // signature and signer are top-level HistoryEvent fields (not in event.data),
  // so they must be added explicitly to the return value.
  return {
    ...(event.data as unknown as CheckpointData),
    // A line that never reached the file has no hash to anchor, so the one
    // computed in memory is not returned.
    event_hash: written ? event.hash ?? null : null,
    signature: event.signature,
    signer: event.signer,
  }
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
 * Ids this store has ever MINTED with one of `prefixes`, from the append-only
 * log, so `generateEngramId` never reuses an id freed by `compact()` (shared
 * ids would merge history, backups, edges and remote rows).
 * Under-reporting is safe (it only lowers the floor). Reads only the current
 * month and never throws; an unreadable log degrades to corpus-only allocation.
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
export function readHistoryForEngram(root: string, engramId: string | ReadonlySet<string>): HistoryEvent[] {
  // A set names one engram under several spellings — a team engram's current
  // id and the older-form id it may have been recorded under.
  const wanted = typeof engramId === 'string' ? new Set([engramId]) : engramId
  const months = listHistoryMonths(root)
  const events: HistoryEvent[] = []
  for (const month of months) {
    const monthEvents = readHistory(root, month)
    for (const event of monthEvents) {
      if (wanted.has(event.engram_id)) {
        events.push(event)
      }
    }
  }
  return events
}

/**
 * Every `engram_rekeyed` rename already in the log, as `from\0to` keys — ONE
 * pass over all months, for any number of renames (a per-rename
 * `readHistoryForEngram` would re-read the whole log each time). Lines that
 * cannot be a rekey are skipped before JSON.parse, so the pass costs little
 * more than the read.
 */
export function readRekeyedPairs(root: string): Set<string> {
  const out = new Set<string>()
  const historyDir = join(root, 'history')
  for (const month of listHistoryMonths(root)) {
    let content: string
    try { content = fs.readFileSync(join(historyDir, `${month}.jsonl`), 'utf8') } catch { continue }
    if (!content.includes('engram_rekeyed')) continue
    for (const line of content.split('\n')) {
      if (!line.includes('engram_rekeyed')) continue
      try {
        const ev = JSON.parse(line) as HistoryEvent
        const from = (ev.data as { from?: unknown } | undefined)?.from
        if (ev.event === 'engram_rekeyed' && typeof from === 'string') out.add(`${from}\0${ev.engram_id}`)
      } catch { /* malformed line: skip, as readHistory does */ }
    }
  }
  return out
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

// --- Injection provenance ---
// Feeds the co-fire edge pipeline and temporal-replay self-labeling:
//   co_injection      — one per inject/session-start with >=1 engram; engram_id
//                       is the INJ-... id; data holds ids only, never statements.
//   injection_outcome — one per positive/negative feedback on an injected
//                       engram, linked by { injection_id, signal }. "Ignored"
//                       is the absence of an outcome; none is ever synthesised.

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
 * Cross-process dedup for co_injection events, checked against the shared
 * history file (hook processes cannot see each other's memory).
 * Key: query_hash + sorted engram ids + source + session. Window: 5 seconds,
 * reading only the tail of the current (and previous) month file.
 */
export function isRecentDuplicateInjection(
  root: string,
  queryHash: string,
  engramIds: string[],
  windowMs = 5_000,
  source?: string,
  sessionId?: string,
): boolean {
  const now = Date.now()

  /**
   * Read the tail of one month file.
   *
   * The window is sized for the WHOLE log, not for co_injection events alone:
   * the file interleaves every event type, and injections with many long ids
   * can be large. 64 KB is a heuristic, not a guarantee.
   */
  const TAIL_BYTES = 65_536
  const readTail = (filePath: string): string | null => {
    try {
      if (!fs.existsSync(filePath)) return null
      const stat = fs.statSync(filePath)
      if (stat.size === 0) return null
      if (stat.size <= TAIL_BYTES) return fs.readFileSync(filePath, 'utf8')
      const buf = Buffer.alloc(TAIL_BYTES)
      const fd = fs.openSync(filePath, 'r')
      try {
        fs.readSync(fd, buf, 0, TAIL_BYTES, stat.size - TAIL_BYTES)
      } finally {
        fs.closeSync(fd)
      }
      const text = buf.toString('utf8')
      // Drop the first partial line — the window began mid-record.
      const firstNewline = text.indexOf('\n')
      return firstNewline >= 0 ? text.slice(firstNewline + 1) : text
    } catch {
      return null // unreadable → not a duplicate (fail-open)
    }
  }

  // Both the current month and the previous one, when the window straddles the
  // rollover: a duplicate pair across midnight on the 1st lands in two files.
  const monthOf = (t: number): string => new Date(t).toISOString().slice(0, 7)
  const months = [...new Set([monthOf(now - windowMs), monthOf(now)])]
  const tails = months
    .map(m => readTail(join(root, 'history', `${m}.jsonl`)))
    .filter((t): t is string => t !== null)
  if (tails.length === 0) return false
  const tail = tails.join('\n')

  const sortedIds = [...engramIds].sort().join(',')
  const lines = tail.split('\n').filter(l => l.trim().length > 0)

  for (const line of lines) {
    let ev: HistoryEvent
    try { ev = JSON.parse(line) as HistoryEvent } catch { continue }
    if (ev.event !== 'co_injection') continue

    // A malformed timestamp yields NaN, and `now - NaN > windowMs` is FALSE,
    // so without this check the event would count as inside the window forever
    // and could suppress real records. This function may let a duplicate
    // through; it must not drop a real record. A future timestamp (clock skew)
    // is likewise unusable.
    const evTime = new Date(ev.timestamp).getTime()
    if (!Number.isFinite(evTime)) continue
    const age = now - evTime
    if (age < 0 || age > windowMs) continue

    const evHash = ev.data.query_hash as string | undefined
    if (evHash !== queryHash) continue

    const evIds = ev.data.ids as string[] | undefined
    if (!Array.isArray(evIds)) continue
    if ([...evIds].sort().join(',') !== sortedIds) continue
    // Normalise BOTH sides: the write path defaults source to 'inject', so an
    // absent caller source must compare as 'inject' too, not skip the check.
    const evSource = (ev.data.source as string | undefined) ?? 'inject'
    if (evSource !== (source ?? 'inject')) continue
    // Session is part of the key: the duplicate being suppressed is ONE
    // session's hooks firing twice from separate processes. Two different
    // sessions injecting the same engrams are two real injections, and
    // `plur receipt` counts each as engram-session evidence.
    const evSession = ev.data.session_id as string | undefined
    if (evSession !== sessionId) continue
    return true
  }

  return false
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
 * Payload of a `co_injection` event. `tokens_used` and `source` are absent on
 * older events, so both are optional and every reader must tolerate their
 * absence.
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
 * volume gate in plur_status — training on injection outcomes is gated on
 * having enough labels.
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
