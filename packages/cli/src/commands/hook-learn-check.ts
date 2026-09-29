import { readSync, readFileSync, writeFileSync, existsSync, appendFileSync, statSync, renameSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { hookFolderOn, payloadDir, parsePayload } from '../lib/folder-gate.js'
import { hookSessionKey } from '../lib/session-key.js'
import { hookSessionDir } from '../lib/session-task.js'
import { ensureSessionDir } from '../lib/codex-hook-io.js'

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
 * Output: the hookSpecificOutput nudge on every LEARN_INTERVAL-th Stop,
 *         otherwise nothing. The input payload is never echoed back: a Stop
 *         hook's stdout is parsed as hook OUTPUT, so an echo was at best
 *         ignored and at worst misread.
 */

const LEARN_INTERVAL = 3 // Learning nudge every N stops
const CHECKPOINT_INTERVAL = parseInt(process.env.PLUR_CHECKPOINT_INTERVAL || '10', 10)

/**
 * Payload `session_id` first, then CLAUDE_SESSION_ID, then ppid — the same
 * precedence the checkpoint readers (hook-session-end, plur_session_end) use.
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

/**
 * Atomic counter via append-only file size, not read-int/increment/write
 * (audit fix, 2026-07-09 — cross-referenced from the feat/cursor-integration
 * branch's evaluator review: this file's own docstring at the top is what
 * hook-cursor-stop.ts cited as "the same mechanism" it mirrors, and an
 * identical audit there found and fixed this exact race — every Stop hook
 * invocation is a fresh, independent process, so a plain
 * read-then-write can lose an increment if two fire close together,
 * silently shifting/skipping the LEARN_INTERVAL nudge and
 * CHECKPOINT_INTERVAL gate below). Appending one byte is atomic on POSIX
 * filesystems even under concurrent writers; counting file size instead of
 * parsing decimal content can't lose an increment the way read-then-write
 * can.
 */
function incrementCounter(path: string): number {
  appendFileSync(path, '.')
  try {
    return statSync(path).size
  } catch {
    return 1
  }
}

function plurPath(): string {
  // `||`, not `??`: an empty PLUR_PATH means unset, never "the cwd" (H3).
  return process.env.PLUR_PATH || join(homedir(), '.plur')
}

// The checkpoint stays where its readers look (hook-session-end,
// plur_session_end, hook-inject's deferred wrap-up) but is written only when
// that directory passes the same check (H3): a planted symlink or a directory
// someone else owns is refused, and the checkpoint is skipped.
function checkpointDir(): string | null {
  const dir = join(plurPath(), 'sessions')
  return ensureSessionDir(dir) ? dir : null
}

function writeCheckpoint(id: string, count: number, cwd: string): void {
  const dir = checkpointDir()
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

// Delivered as a one-turn instruction: Claude Code gives the model exactly one
// continuation turn to act on it. Keep it short and give the "nothing" path an
// explicit, near-silent answer so that turn costs as little as possible.
export const LEARN_PROMPT = `[PLUR] Memory check: if your last response involved a correction, a stated preference, or a reusable discovery, call plur_learn for it now. Otherwise reply with just "ok". Do not repeat or continue your previous answer.`

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()

  // Silent unless the folder map says on (#1347; was #247's project gate).
  if (!hookFolderOn(payloadDir(parsePayload(raw)), flags)) return

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
    try { writeCheckpoint(key, count, cwd) } catch { /* never block on checkpoint failure */ }
  }

  // Learning nudge every Nth stop
  if (count % LEARN_INTERVAL !== 0) return

  const output = { hookSpecificOutput: { hookEventName: 'Stop', additionalContext: LEARN_PROMPT } }
  process.stdout.write(JSON.stringify(output))
}
