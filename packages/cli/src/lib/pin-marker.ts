import { openSync, writeSync, closeSync, renameSync, unlinkSync, readFileSync, constants } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { hookSessionDir } from './session-task.js'
import { safeSessionKey } from './session-key.js'

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
 * - Subagent start always includes them: a subagent is a new context.
 *
 * Keyed on the payload `session_id` only. No session id means no marker and
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
  return dir ? join(dir, `${safeSessionKey(sessionId).slice(0, 64)}.pins`) : null
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

/** Atomic 0600 write: exclusive no-follow temp file, renamed over the marker. Fail-open. */
function writePinMarker(m: PinMarker): void {
  const path = pinMarkerPath(m.session_id)
  if (!path) return
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeSync(fd, JSON.stringify(m))
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch {
    if (fd !== null) try { closeSync(fd) } catch { /* ignore */ }
    try { unlinkSync(tmp) } catch { /* ignore */ }
  }
}

/** Start a new context for this session: epoch + 1, no delivery yet. Returns the new marker (null without a session id). */
export function bumpPinEpoch(sessionId: unknown): PinMarker | null {
  if (typeof sessionId !== 'string' || !sessionId) return null
  const cur = readPinMarker(sessionId)
  const next: PinMarker = { session_id: sessionId, epoch: (cur?.epoch ?? 0) + 1, pins_delivered: false }
  writePinMarker(next)
  return next
}

/**
 * Record that the pins reached the context of `epoch`. Ignored when the
 * marker has moved to a later epoch since (a compaction raced the injection).
 */
export function recordPinsDelivered(sessionId: unknown, epoch: number): void {
  if (typeof sessionId !== 'string' || !sessionId) return
  const cur = readPinMarker(sessionId)
  const curEpoch = cur?.epoch ?? 0
  if (curEpoch !== epoch) return
  writePinMarker({ session_id: sessionId, epoch, pins_delivered: true })
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

/** SessionStart with source compact, clear or resume: a context whose earlier injections may be gone. */
export function isEpochBumpStart(input: Record<string, unknown>): boolean {
  if (input.hook_event_name !== 'SessionStart') return false
  return input.source === 'compact' || input.source === 'clear' || input.source === 'resume'
}

/** Remove the marker at session end. unlink never follows a symlink. */
export function removePinMarker(sessionId: unknown): void {
  const path = pinMarkerPath(sessionId)
  if (path) try { unlinkSync(path) } catch { /* gone */ }
}
