import { readSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync, openSync, fstatSync, closeSync, constants as fsConstants } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { ensureSessionDir, ticketCounter } from '../lib/codex-hook-io.js'
import { hookFolderOn, payloadDir, parsePayload } from '../lib/folder-gate.js'
import { hookSessionKey } from '../lib/session-key.js'
import { hookSessionDir } from '../lib/session-task.js'
import { claimNudge, hasLearnSignal, lastUserMessage, learnFallbackInterval } from '../lib/learn-signal.js'

/**
 * plur hook-learn-check — Stop hook: learning nudges and periodic crash-recovery checkpoints.
 * - Nudges when the last user message (from `transcript_path`) signals a correction /
 *   preference / decision, else every PLUR_LEARN_FALLBACK_INTERVAL-th Stop (default 10;
 *   0 = off); at most once per message, never after plur_learn was called in that reply.
 * - Every 10th Stop writes a checkpoint to `<PLUR root>/sessions` for deferred wrap-up.
 * Counter keyed to the payload `session_id`; writes only to directories passing the ownership check.
 * Only `hookSpecificOutput` reaches the model (forcing one turn), so it stays silent when
 * `stop_hook_active` to avoid a loop. Never echoes input: Stop stdout is parsed as hook output.
 */

const CHECKPOINT_INTERVAL = parseInt(process.env.PLUR_CHECKPOINT_INTERVAL || '10', 10)

/**
 * The one shared session-key helper — payload `session_id`, then
 * CLAUDE_SESSION_ID, then ppid — so the checkpoint writer and every reader
 * (hook-session-end, plur_session_end, the deferred wrap-up) agree. Readers
 * also try the legacy env-first stripped key (legacyHookSessionKeys). The stop
 * counter is not migrated: an orphaned counter delays one nudge at most.
 */
function sessionKey(payloadSessionId?: unknown): string {
  return hookSessionKey(payloadSessionId)
}

// The counter lives in the hook state dir and follows its rule
// (lib/session-task.ts hookSessionDir): the shared dir if it passes the
// ownership check, else the private fallback if it passes, else null — and
// null means persist nothing.
function counterPath(key: string): string | null {
  const dir = hookSessionDir()
  return dir ? join(dir, `${key}.stop-count`) : null
}

// One marker per (session, message) a nudge (signal or fallback) fired for, next to the
// counter: a later Stop with no new human message (a background task ending)
// still sees the same message and must not nudge for it again. Claimed with an
// exclusive, no-follow create (claimNudge), so two racing Stops cannot both
// nudge and an unwritable marker means no nudge. The 7-day sweep of the hook
// dir (cleanupStaleSessionFiles) removes old markers.
function nudgeMarkerPath(counter: string, messageId: string): string {
  const h = createHash('sha256').update(messageId).digest('hex').slice(0, 16)
  return counter.replace(/\.stop-count$/, `.learn-${h}.nudged`)
}

/**
 * Per-session Stop counter. Append-a-byte-then-stat is not atomic as a pair:
 * `A-append, B-append, A-stat, B-stat` would hand both hooks 2, so one
 * fallback/CHECKPOINT_INTERVAL multiple would fire twice and the next be
 * skipped. Each caller instead gets the position of its own appended line:
 * distinct values, exactly 1..n after n calls (PlurSpec/R2CLI.lean §4).
 */
function incrementCounter(path: string): number {
  return ticketCounter(path)
}

/**
 * The store root — resolved exactly as createPlur resolves it (`--path`, then
 * PLUR_PATH, then ~/.plur), so hook-session-end looks in the directory this
 * writer wrote. `||`, not `??`: an empty PLUR_PATH means unset, never "the
 * cwd".
 */
export function checkpointRoot(flags: GlobalFlags): string {
  return flags.path || process.env.PLUR_PATH || join(homedir(), '.plur')
}

// The checkpoint stays where its readers look (hook-session-end,
// plur_session_end, hook-inject's deferred wrap-up) but is written only when
// that directory passes the same ownership check: a planted symlink or a
// directory someone else owns is refused, and the checkpoint is skipped.
function checkpointDir(flags: GlobalFlags): string | null {
  const dir = join(checkpointRoot(flags), 'sessions')
  return ensureSessionDir(dir) ? dir : null
}

/**
 * Read a file only if it is a regular file: a FIFO or device planted at the
 * path would block a plain readFileSync and hang the Stop (the same hardening
 * as the transcript read). Throws on anything else.
 */
function readRegularFile(path: string): string {
  if (!statSync(path).isFile()) throw new Error('not a regular file')
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0))
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file')
    return readFileSync(fd, 'utf8')
  } finally {
    closeSync(fd)
  }
}

function writeCheckpoint(id: string, count: number, cwd: string, flags: GlobalFlags): void {
  // id: hookSessionKey of this Stop payload
  const dir = checkpointDir(flags)
  if (!dir) return
  const path = join(dir, `${id}.checkpoint.json`)

  const now = new Date().toISOString()
  const dateStr = now.slice(0, 10) // YYYY-MM-DD for observation file

  // Read existing checkpoint to preserve started_at
  let startedAt = now
  try {
    const existing = JSON.parse(readRegularFile(path))
    if (existing.started_at) startedAt = existing.started_at
  } catch { /* first checkpoint, or not a regular file */ }

  const checkpoint = {
    session_id: id,
    started_at: startedAt,
    last_checkpoint: now,
    stop_count: count,
    cwd,
    observation_file: `${dateStr}.jsonl`,
  }

  // Atomic write: temp file + rename, so a concurrent reader (hook-session-end,
  // the deferred wrap-up in hook-inject) never observes a mid-write PARTIAL
  // file: a partial read is indistinguishable from genuine corruption, and the
  // checkpoint is a live session's only durable record. renameSync is atomic
  // on POSIX when src and dst are on the same filesystem (they share this dir).
  const tmpPath = `${path}.${process.pid}.tmp`
  writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2) + '\n')
  try {
    renameSync(tmpPath, path)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* best-effort temp cleanup */ }
    throw err
  }
}

function readStdinRaw(): string {
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    while (true) {
      try {
        const n = readSync(0, buf, 0, buf.length, null)
        if (n === 0) break
        chunks.push(Buffer.from(buf.subarray(0, n)))
      } catch {
        break
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  }
}

// Delivered as a one-turn instruction: Claude Code gives the model one
// continuation turn to act on it. Keep it short and make the "nothing" path
// near-silent. PLUR's instructions have the agent end every reply with a
// memory line, so the "nothing" answer is that line alone — never a separate
// "ok" on top of it. Without the memory-line rule installed, the same
// sentence still means "say nothing else".
const NOTHING_TO_KEEP = 'Otherwise add nothing: no reply is needed beyond your usual memory line, if you end replies with one. Do not repeat or continue your previous answer.'

export const LEARN_PROMPT = `[PLUR] Memory check: if your last response involved a correction, a stated preference, or a reusable discovery, call plur_learn for it now. ${NOTHING_TO_KEEP}`

// Sent when the user's last message looked like a correction, preference or
// decision: say why, so the turn is spent on that message, not a recap.
export const SIGNAL_PROMPT = `[PLUR] Memory check: the user's last message looks like a correction, a preference or a decision. If it states something worth keeping beyond this task, call plur_learn for it now. ${NOTHING_TO_KEEP}`

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()

  // Silent unless the folder map says on.
  if (!hookFolderOn(payloadDir(parsePayload(raw)), flags)) return

  // Parse stdin for cwd, session_id and stop_hook_active (Claude Code payload)
  let cwd = process.cwd()
  let data: { cwd?: unknown; session_id?: unknown; stop_hook_active?: unknown; transcript_path?: unknown } = {}
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') data = parsed
    if (typeof data.cwd === 'string' && data.cwd) cwd = data.cwd
  } catch { /* use process.cwd fallback */ }

  // A continuation Stop — the turn our own nudge forced. Never nudge here
  // (that is the loop), and do not count it: the interval is per response.
  if (data.stop_hook_active === true) return

  const key = sessionKey(data.session_id)

  // Increment the persistent counter (see incrementCounter's docstring).
  // Fail-open: if the state dir is unwritable (read-only $TMPDIR, full disk),
  // a Stop hook MUST NOT crash the response — print nothing and exit 0.
  // counterPath() creates the dir and incrementCounter() appends; either can
  // throw on an unwritable filesystem, so wrap both.
  const counter = counterPath(key)
  if (!counter) return // no trusted state dir: persist nothing, stay silent
  let count: number
  try {
    count = incrementCounter(counter)
  } catch {
    return
  }

  // Write session checkpoint periodically
  if (count % CHECKPOINT_INTERVAL === 0) {
    try { writeCheckpoint(key, count, cwd, flags) } catch { /* never block on checkpoint failure */ }
  }

  // Signal nudge for an un-nudged correction/preference/decision message; none when the
  // agent already called plur_learn in that reply. The fallback (every Nth Stop) claims the
  // same per-message marker, so one message gets at most one nudge. No readable transcript:
  // only the count decides.
  let prompt: string | null = null
  const msg = lastUserMessage(data.transcript_path)
  if (msg?.learned) return
  const fallback = learnFallbackInterval()
  const fallbackDue = fallback > 0 && count % fallback === 0
  if (msg) {
    const signal = hasLearnSignal(msg.text)
    if ((signal || fallbackDue) && claimNudge(nudgeMarkerPath(counter, msg.id))) {
      prompt = signal ? SIGNAL_PROMPT : LEARN_PROMPT
    }
  } else if (fallbackDue) {
    prompt = LEARN_PROMPT
  }
  if (!prompt) return

  const output = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: prompt } }
  process.stdout.write(JSON.stringify(output))
}
