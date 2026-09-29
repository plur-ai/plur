import { readSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { hookSessionKey } from '../lib/session-key.js'
import { ensureSessionDir, ticketCounter } from '../lib/codex-hook-io.js'

/**
 * plur hook-learn-check — Stop hook that prompts learning reflection
 * AND writes periodic session checkpoints for crash recovery (#215).
 *
 * Runs at the end of every response:
 * - Every 3rd Stop: injects a learning reflection nudge
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
 * Delivery (#1266, verified against a real Claude Code session): a Stop
 * hook's TOP-LEVEL `additionalContext` is ignored — recorded as plain hook
 * stdout, never shown to the model. Only
 * `{hookSpecificOutput: {hookEventName: "Stop", additionalContext}}` reaches
 * the model, and it does so by forcing ONE continuation turn. That turn ends
 * in another Stop carrying `stop_hook_active: true`; nudging there would loop
 * (observed: ~10 empty turns per prompt), so this hook stays silent on it.
 *
 * Input: JSON on stdin (Claude Code Stop hook format)
 * Output: the hookSpecificOutput nudge on every LEARN_INTERVAL-th Stop,
 *         otherwise nothing. The input payload is never echoed back: a Stop
 *         hook's stdout is parsed as hook OUTPUT, so an echo was at best
 *         ignored and at worst misread.
 */

const LEARN_INTERVAL = 3 // Learning nudge every N stops
const CHECKPOINT_INTERVAL = parseInt(process.env.PLUR_CHECKPOINT_INTERVAL || '10', 10)

/**
 * Owner decision H1 ("payload"): the one shared helper — payload
 * `session_id`, then CLAUDE_SESSION_ID, then ppid. The checkpoint readers
 * (hook-session-end, plur_session_end, processDeferredWrapups) find it under
 * this key and also try the legacy forms (legacyHookSessionKeys). The stop
 * counter is not migrated: a counter left under an old key only delays the
 * next nudge/checkpoint by at most one interval.
 */
function sessionKey(payloadSessionId?: unknown): string {
  return hookSessionKey(payloadSessionId)
}

function counterPath(key: string): string {
  const dir = join(tmpdir(), 'plur-sessions')
  // Vetted (formal r2, cli#8): a symlinked or foreign dir is refused and the
  // caller's fail-open branch passes the payload through untouched.
  if (!ensureSessionDir(dir)) throw new Error('session state dir refused')
  return join(dir, `${key}.stop-count`)
}

/**
 * Per-session Stop counter. It used to be "atomic" append-a-byte-then-stat:
 * the append is atomic, the pair is not — `A-append, B-append, A-stat,
 * B-stat` handed both hooks 2, so one LEARN_INTERVAL/CHECKPOINT_INTERVAL
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
 * directory the writer never wrote (formal r2, cli#6).
 */
export function checkpointRoot(flags: GlobalFlags): string {
  return flags.path || process.env.PLUR_PATH || join(homedir(), '.plur')
}

function checkpointDir(flags: GlobalFlags): string {
  const dir = join(checkpointRoot(flags), 'sessions')
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeCheckpoint(id: string, count: number, cwd: string, flags: GlobalFlags): void {
  const dir = checkpointDir(flags)
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

// Delivered as a one-turn instruction: Claude Code gives the model exactly one
// continuation turn to act on it. Keep it short and give the "nothing" path an
// explicit, near-silent answer so that turn costs as little as possible.
export const LEARN_PROMPT = `[PLUR] Memory check: if your last response involved a correction, a stated preference, or a reusable discovery, call plur_learn for it now. Otherwise reply with just "ok". Do not repeat or continue your previous answer.`

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()

  // Silent pass-through for projects without plur configured (#247).
  // Lets hooks be installed globally without affecting non-plur projects.
  if (!isPlurConfigured()) return

  // Parse stdin for cwd, session_id and stop_hook_active (Claude Code payload)
  let cwd = process.cwd()
  let data: { cwd?: unknown; session_id?: unknown; stop_hook_active?: unknown } = {}
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
  let count: number
  try {
    count = incrementCounter(counterPath(key))
  } catch {
    return
  }

  // Write session checkpoint periodically (#215)
  if (count % CHECKPOINT_INTERVAL === 0) {
    try { writeCheckpoint(key, count, cwd, flags) } catch { /* never block on checkpoint failure */ }
  }

  // Learning nudge every Nth stop
  if (count % LEARN_INTERVAL !== 0) return

  const output = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: LEARN_PROMPT } }
  process.stdout.write(JSON.stringify(output))
}
