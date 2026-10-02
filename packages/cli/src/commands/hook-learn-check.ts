import { readSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs'
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
 * plur hook-learn-check — Stop hook that prompts learning reflection
 * AND writes periodic session checkpoints for crash recovery (#215).
 *
 * Runs at the end of every response:
 * - Nudges when the user's last message (read from the payload's
 *   `transcript_path`) carries a correction / preference / decision signal
 *   (lib/learn-signal.ts) — once per message — and otherwise only on every
 *   PLUR_LEARN_FALLBACK_INTERVAL-th Stop (default 10; 0 = off). It used to
 *   nudge every 3rd Stop, and the forced turn mostly ended in a bare "ok".
 *   A missing or unreadable transcript leaves only the fallback.
 * - Every 10th Stop: writes a session checkpoint to ~/.plur/sessions/
 *
 * Checkpoints enable deferred wrap-up (#216): if a session exits without
 * calling plur_session_end, the next session_start detects the orphaned
 * checkpoint and processes observations retroactively.
 *
 * The counter persists via a temp file keyed to the payload `session_id`
 * (#1266). Claude Code does not export CLAUDE_SESSION_ID to hooks, and each
 * Stop runs in a fresh shell, so the old ppid fallback gave every Stop its own
 * counter and the nudge never fired.
 *
 * Directories (decision H3): the counter lives in the hook state dir
 * (`hookSessionDir()`), and the checkpoint in `<PLUR root>/sessions`. Each is
 * written only if its directory passes the ownership check. When no trusted
 * directory exists, the hook persists nothing and prints nothing.
 *
 * Delivery (#1266, verified against a real Claude Code session): a Stop
 * hook's TOP-LEVEL `additionalContext` is ignored — recorded as plain hook
 * stdout, never shown to the model. Only
 * `{hookSpecificOutput: {hookEventName: "Stop", additionalContext}}` reaches
 * the model, and it does so by forcing ONE continuation turn. That turn ends
 * in another Stop carrying `stop_hook_active: true`; nudging there would loop
 * (observed: ~10 empty turns per prompt), so this hook stays silent on it.
 *
 * Input: JSON on stdin (Claude Code Stop hook format)
 * Output: the hookSpecificOutput nudge on a signal or a fallback Stop,
 *         otherwise nothing. The input payload is never echoed back: a Stop
 *         hook's stdout is parsed as hook OUTPUT, so an echo was at best
 *         ignored and at worst misread.
 */

const CHECKPOINT_INTERVAL = parseInt(process.env.PLUR_CHECKPOINT_INTERVAL || '10', 10)

/**
 * Owner decision H1 ("payload", 2026-09-29): the one shared helper —
 * payload `session_id`, then CLAUDE_SESSION_ID, then ppid — so the checkpoint
 * writer and every reader (hook-session-end, plur_session_end, the deferred
 * wrap-up) agree. Readers also try the env-first stripped key this function
 * used before (legacyHookSessionKeys). The stop counter is not migrated: an
 * orphaned counter delays one nudge at most.
 */
function sessionKey(payloadSessionId?: unknown): string {
  // Owner decision H1 ("payload", 2026-09-29): the one shared helper, so the
  // counter/checkpoint writer and every reader agree. The stop counter is not
  // migrated from legacy keys: an orphaned counter delays one nudge at most.
  return hookSessionKey(payloadSessionId)
}

// Decision H3: the counter lives in the hook state dir and follows its proved
// rule (lib/session-task.ts hookSessionDir): the shared dir if it passes the
// ownership check, else the private fallback if it passes, else null — and
// null means persist nothing (formal conflict H).
function counterPath(key: string): string | null {
  const dir = hookSessionDir()
  return dir ? join(dir, `${key}.stop-count`) : null
}

// One marker per (session, message) a signal nudge fired for, next to the
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
 * Per-session Stop counter. It used to be "atomic" append-a-byte-then-stat:
 * the append is atomic, the pair is not — `A-append, B-append, A-stat,
 * B-stat` handed both hooks 2, so one fallback/CHECKPOINT_INTERVAL
 * multiple fired twice and the next was skipped (formal r2, cli#11). Each
 * caller now gets the position of its own appended line: distinct values,
 * exactly 1..n after n calls (PlurSpec/R2CLI.lean §4).
 */
function incrementCounter(path: string): number {
  return ticketCounter(path)
}

/**
 * The store root — resolved exactly as createPlur resolves it (`--path`, then
 * PLUR_PATH, then ~/.plur). The writer used to read PLUR_PATH only while
 * hook-session-end honoured `--path`, so with `--path` the closer looked in a
 * directory the writer never wrote (formal r2, cli#6). `||`, not `??`: an
 * empty PLUR_PATH means unset, never "the cwd" (H3).
 */
export function checkpointRoot(flags: GlobalFlags): string {
  return flags.path || process.env.PLUR_PATH || join(homedir(), '.plur')
}

// The checkpoint stays where its readers look (hook-session-end,
// plur_session_end, hook-inject's deferred wrap-up) but is written only when
// that directory passes the same check (H3): a planted symlink or a directory
// someone else owns is refused, and the checkpoint is skipped.
function checkpointDir(flags: GlobalFlags): string | null {
  const dir = join(checkpointRoot(flags), 'sessions')
  return ensureSessionDir(dir) ? dir : null
}

function writeCheckpoint(id: string, count: number, cwd: string, flags: GlobalFlags): void {
  // id: hookSessionKey of this Stop payload (H1)
  const dir = checkpointDir(flags)
  if (!dir) return
  const path = join(dir, `${id}.checkpoint.json`)

  const now = new Date().toISOString()
  const dateStr = now.slice(0, 10) // YYYY-MM-DD for observation file

  // Read existing checkpoint to preserve started_at
  let startedAt = now
  try {
    const existing = JSON.parse(readFileSync(path, 'utf8'))
    if (existing.started_at) startedAt = existing.started_at
  } catch { /* first checkpoint */ }

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
  // file. A plain writeFileSync here made a partial read indistinguishable from
  // genuine corruption, which hook-session-end then used to justify DESTROYING
  // a live session's only durable record (#217). renameSync is atomic on POSIX
  // when src and dst are on the same filesystem (they share this dir).
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
// near-silent. PLUR's instructions (#1520) have the agent end every reply
// with a memory line, so the "nothing" answer is that line alone — never a
// separate "ok" on top of it. Without the memory-line rule installed, the
// same sentence still means "say nothing else".
const NOTHING_TO_KEEP = 'Otherwise add nothing: no reply is needed beyond your usual memory line, if you end replies with one. Do not repeat or continue your previous answer.'

export const LEARN_PROMPT = `[PLUR] Memory check: if your last response involved a correction, a stated preference, or a reusable discovery, call plur_learn for it now. ${NOTHING_TO_KEEP}`

// Sent when the user's last message looked like a correction, preference or
// decision: say why, so the turn is spent on that message, not a recap.
export const SIGNAL_PROMPT = `[PLUR] Memory check: the user's last message looks like a correction, a preference or a decision. If it states something worth keeping beyond this task, call plur_learn for it now. ${NOTHING_TO_KEEP}`

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()

  // Silent unless the folder map says on (#1347; was #247's project gate).
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

  // Increment persistent counter (atomic append — see incrementCounter's docstring).
  // Fail-open: if the state dir is unwritable (read-only $TMPDIR, full disk),
  // a Stop hook MUST NOT crash the response — print nothing and exit 0.
  // counterPath() creates the dir and incrementCounter() appends; either can
  // throw on an unwritable filesystem, so wrap both.
  const counter = counterPath(key)
  if (!counter) return // no trusted state dir: persist nothing, stay silent (H3)
  let count: number
  try {
    count = incrementCounter(counter)
  } catch {
    return
  }

  // Write session checkpoint periodically (#215)
  if (count % CHECKPOINT_INTERVAL === 0) {
    try { writeCheckpoint(key, count, cwd, flags) } catch { /* never block on checkpoint failure */ }
  }

  // Signal nudge: the user's last typed message reads as a correction,
  // preference or decision, and has not been nudged for yet. lastUserMessage
  // never throws; an unclaimable marker is "no nudge".
  // No nudge at all when the agent already called plur_learn in that reply:
  // the memory was saved, a forced turn would only repeat it.
  let prompt: string | null = null
  const msg = lastUserMessage(data.transcript_path)
  if (msg?.learned) return
  if (msg && hasLearnSignal(msg.text) && claimNudge(nudgeMarkerPath(counter, msg.id))) {
    prompt = SIGNAL_PROMPT
  }

  // Rare fallback, so a session with no explicit signal still gets a check.
  const fallback = learnFallbackInterval()
  if (!prompt && fallback > 0 && count % fallback === 0) prompt = LEARN_PROMPT
  if (!prompt) return

  const output = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: prompt } }
  process.stdout.write(JSON.stringify(output))
}
