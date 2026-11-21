import { openSync, writeSync, closeSync, renameSync, unlinkSync, readFileSync, statSync, constants } from 'fs'
import { join } from 'path'
import { randomBytes, createHash } from 'crypto'
import { hookSessionDir } from './session-task.js'
import { safeSessionKey } from './session-key.js'
import { recordHookNote } from './hook-runs.js'

/**
 * Pins once per context (retrieval and injection overhaul, W2+4 / R7).
 *
 * The pinned engrams are the always-on slot. Claude Code keeps what a hook
 * injected in the context until compaction, so re-sending the pins on every
 * skill, agent or plan-mode event spends the budget on text the model already
 * has. This marker says, per Claude Code session, whether the CURRENT context
 * has received them:
 *
 *   { session_id, epoch, pins_delivered }
 *
 * - The epoch goes up on SessionStart with source compact, clear or resume:
 *   each starts a context whose earlier injections may be gone. A bump resets
 *   `pins_delivered`.
 * - A delivery is recorded only after the hook's output reached stdout, and
 *   only for the epoch it was read under, so a bump that races an injection
 *   is never overwritten by it.
 * - Skill, agent and plan-mode events leave pins out ONLY when the current
 *   epoch records a delivery. A missing, corrupt or foreign marker, or one
 *   whose epoch has no delivery yet (a session start that timed out, a
 *   rehydration that did not finish), includes them: fail open.
 * - A subagent is its own context (H7). Its events — SubagentStart and the
 *   tool events fired inside it — carry `agent_id`, and use a marker keyed on
 *   session id plus agent id (`pinContext`), never the main session's: a
 *   subagent's delivery must not make the main context drop its pins, nor
 *   the main delivery the subagent's. A subagent-descended event without an
 *   agent id always includes the pins and records nothing.
 * - Read-check-write is compare-and-swap under `<marker>.lock` (H8).
 *
 * Keyed on the payload `session_id` (plus `agent_id` for a subagent) only. No session id means no marker and
 * pins included — never a ppid key, which changes on every hook process.
 * Stored 0600 in the hook-inject state directory (`hookSessionDir`).
 */
export interface PinMarker {
  session_id: string
  epoch: number
  pins_delivered: boolean
}

/** The events that run in a context which may already hold the pins. */
const SAME_CONTEXT_EVENTS = new Set(['skill', 'agent', 'plan_mode'])

export function pinMarkerPath(sessionId: unknown): string | null {
  if (typeof sessionId !== 'string' || !sessionId) return null
  const dir = hookSessionDir()
  if (!dir) return null
  const safe = safeSessionKey(sessionId)
  // A longer id (a subagent context: session id + agent id) is hashed rather
  // than cut, so two contexts never share a marker by truncation.
  const name = safe.length <= 64 && !sessionId.includes('#agent:')
    ? safe
    : `${safe.slice(0, 40)}-${createHash('sha256').update(sessionId).digest('hex').slice(0, 20)}`
  return join(dir, `${name}.pins`)
}

/** The context id of a subagent: its own marker key (H7). */
function subagentContextId(sessionId: string, agentId: string): string {
  return `${sessionId}#agent:${agentId}`
}

export interface PinContext {
  /** The marker key this injection reads and records under; null = no marker (include, never record). */
  contextId: string | null
  /** Offer the pins in this injection. */
  include: boolean
  /** Record a delivery once the output (with pins in it) is out. */
  record: boolean
}

/**
 * H7: which pin context an injection runs in, and whether it offers the pins.
 * `event` is the hook-inject `--event` value, or null for the first-prompt
 * and rehydrate injections.
 *   - payload `agent_id`: a subagent's own context, keyed per subagent;
 *     SubagentStart and the events inside it share it.
 *   - SubagentStart, or an event carrying `agent_type`, with no agent id: a
 *     subagent we cannot key — always include, never record.
 *   - otherwise the main context, keyed on the session id.
 */
export function pinContext(input: Record<string, unknown>, event: string | null): PinContext {
  const sid = typeof input.session_id === 'string' && input.session_id ? input.session_id : null
  const agentId = typeof input.agent_id === 'string' && input.agent_id ? input.agent_id : null
  const subagent = event === 'subagent' || input.hook_event_name === 'SubagentStart'
    || (typeof input.agent_type === 'string' && input.agent_type !== '' && event !== null)
  if (!sid) return { contextId: null, include: true, record: false }
  if (agentId && event !== null) {
    const contextId = subagentContextId(sid, agentId)
    return { contextId, include: !(readPinMarker(contextId)?.pins_delivered === true), record: true }
  }
  if (subagent) return { contextId: null, include: true, record: false }
  return { contextId: sid, include: shouldIncludePins(event, readPinMarker(sid)), record: true }
}

/** The marker for this session, or null when absent, unreadable or not this session's. */
export function readPinMarker(sessionId: unknown): PinMarker | null {
  const path = pinMarkerPath(sessionId)
  if (!path) return null
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    let raw: string
    try { raw = readFileSync(fd, 'utf8') } finally { closeSync(fd) }
    if (raw.length > 4096) return null
    const m = JSON.parse(raw) as Partial<PinMarker>
    if (m.session_id !== sessionId) return null
    if (typeof m.epoch !== 'number' || !Number.isSafeInteger(m.epoch) || m.epoch < 0) return null
    return { session_id: sessionId as string, epoch: m.epoch, pins_delivered: m.pins_delivered === true }
  } catch {
    return null
  }
}

/**
 * Atomic 0600 write: exclusive no-follow temp file, renamed over the marker.
 * Returns whether it landed; on failure the temp file is removed and the
 * error is passed back for the caller to act on (H13).
 */
function writePinMarker(m: PinMarker): { ok: true } | { ok: false; error: string } {
  const path = pinMarkerPath(m.session_id)
  if (!path) return { ok: false, error: 'no marker path' }
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeSync(fd, JSON.stringify(m))
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
    return { ok: true }
  } catch (err: unknown) {
    if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
    try { unlinkSync(tmp) } catch { /* ignore */ }
    return { ok: false, error: (err as Error)?.message ?? String(err) }
  }
}

// H8: the marker's read-check-write runs under `<marker>.lock` (O_EXCL), so
// a bump cannot land between a delivery's read and write and be overwritten.
// Held for microseconds; one older than this belongs to a killed process.
const MARKER_LOCK_STALE_MS = 2_000

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Take `<marker>.lock` within `waitMs`; returns the release, or null when busy. */
function lockMarker(path: string, waitMs: number): (() => void) | null {
  const lock = `${path}.lock`
  const until = Date.now() + Math.max(0, waitMs)
  for (;;) {
    try {
      const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
      closeSync(fd)
      return () => { try { unlinkSync(lock) } catch { /* gone */ } }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return null
      try {
        if (Date.now() - statSync(lock).mtimeMs > MARKER_LOCK_STALE_MS) { unlinkSync(lock); continue }
      } catch { continue /* released in between */ }
    }
    if (Date.now() >= until) return null
    sleepSync(10)
  }
}

/**
 * Start a new context for this session: epoch + 1, no delivery yet. Returns
 * the new marker (null without a session id, when the lock stayed busy and
 * `forceOnTimeout` is false, or when the write failed — then the marker is
 * removed and a hook-runs note says why, H13). By default a bump that cannot take the lock in
 * `lockWaitMs` writes anyway: a bump fails toward re-delivering the pins.
 */
export function bumpPinEpoch(sessionId: unknown, opts: { lockWaitMs?: number; forceOnTimeout?: boolean; notesRoot?: string } = {}): PinMarker | null {
  if (typeof sessionId !== 'string' || !sessionId) return null
  const path = pinMarkerPath(sessionId)
  if (!path) return null
  const release = lockMarker(path, opts.lockWaitMs ?? 1_000)
  if (!release && opts.forceOnTimeout === false) return null
  try {
    const cur = readPinMarker(sessionId)
    const next: PinMarker = { session_id: sessionId, epoch: (cur?.epoch ?? 0) + 1, pins_delivered: false }
    const written = writePinMarker(next)
    if (written.ok) return next
    // H13: the old marker may still say the pins were delivered, to a context
    // that no longer has them. Without a marker every event includes them.
    let removed = false
    try { unlinkSync(path); removed = true } catch (err: unknown) { removed = (err as NodeJS.ErrnoException)?.code === 'ENOENT' }
    recordHookNote('claude', 'pin_marker', { op: 'epoch-bump', error: written.error, marker_removed: removed }, opts.notesRoot)
    return null
  } finally {
    release?.()
  }
}

/**
 * Record that the pins reached the context of `epoch`. Compare-and-swap
 * (H8): under the marker lock, written only while the marker is still at
 * `epoch` (a compaction that raced the injection wins). A lock that stays
 * busy skips the record — the next event then includes the pins (fail open).
 */
export function recordPinsDelivered(sessionId: unknown, epoch: number, opts: { lockWaitMs?: number; _beforeWrite?: () => void } = {}): void {
  if (typeof sessionId !== 'string' || !sessionId) return
  const path = pinMarkerPath(sessionId)
  if (!path) return
  const release = lockMarker(path, opts.lockWaitMs ?? 200)
  if (!release) return
  try {
    const cur = readPinMarker(sessionId)
    const curEpoch = cur?.epoch ?? 0
    if (curEpoch !== epoch) return
    opts._beforeWrite?.()
    writePinMarker({ session_id: sessionId, epoch, pins_delivered: true })
  } finally {
    release()
  }
}

/**
 * Should this injection offer the pins? `event` is the hook-inject `--event`
 * value, or null for the first-prompt and rehydrate injections (which always
 * include them).
 */
export function shouldIncludePins(event: string | null, marker: PinMarker | null): boolean {
  if (event === null || event === 'subagent') return true
  if (!SAME_CONTEXT_EVENTS.has(event)) return true
  return !(marker?.pins_delivered === true)
}

/**
 * SessionStart with source compact, clear or resume. `compact` and `resume`
 * keep the session id and start a context whose earlier injections may be
 * gone. `clear` (H10): Claude Code gives the cleared conversation a NEW
 * session id, which has no marker yet — the bump only writes that new
 * session's marker at epoch 1 with nothing delivered, the same as no marker.
 * It is kept for a harness that keeps the id across a clear.
 */
export function isEpochBumpStart(input: Record<string, unknown>): boolean {
  if (input.hook_event_name !== 'SessionStart') return false
  return input.source === 'compact' || input.source === 'clear' || input.source === 'resume'
}

/** Remove the marker at session end. unlink never follows a symlink. */
export function removePinMarker(sessionId: unknown): void {
  const path = pinMarkerPath(sessionId)
  if (path) try { unlinkSync(path) } catch { /* gone */ }
}
