import { readSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'

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
 * The counter persists via a temp file keyed to the session ID.
 *
 * Input: JSON on stdin (Claude Code Stop hook format)
 * Output: JSON on stdout with additionalContext (or passthrough)
 */

const LEARN_INTERVAL = 3 // Learning nudge every N stops
const CHECKPOINT_INTERVAL = parseInt(process.env.PLUR_CHECKPOINT_INTERVAL || '10', 10)

function sessionKey(): string {
  const raw = process.env.CLAUDE_SESSION_ID || String(process.ppid || 'unknown')
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default'
}

function counterPath(): string {
  const dir = join(tmpdir(), 'plur-sessions')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${sessionKey()}.stop-count`)
}

function plurPath(): string {
  return process.env.PLUR_PATH ?? join(homedir(), '.plur')
}

function checkpointDir(): string {
  const dir = join(plurPath(), 'sessions')
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeCheckpoint(count: number, cwd: string): void {
  const id = sessionKey()
  const dir = checkpointDir()
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

  writeFileSync(path, JSON.stringify(checkpoint, null, 2) + '\n')
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

const LEARN_PROMPT = `[PLUR] Did you discover, learn, or get corrected on something in your last response? If yes — call plur_learn now before moving on. If no — continue.`

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()

  // Silent pass-through for projects without plur configured (#247).
  // Lets hooks be installed globally without affecting non-plur projects.
  if (!isPlurConfigured()) {
    process.stdout.write(raw)
    return
  }

  // Parse stdin for cwd (provided by Claude Code hook payload)
  let cwd = process.cwd()
  try {
    const data = JSON.parse(raw)
    if (data.cwd) cwd = data.cwd
  } catch { /* use process.cwd fallback */ }

  // Read and increment persistent counter
  const cPath = counterPath()
  let count = 1
  try {
    const prev = parseInt(readFileSync(cPath, 'utf8').trim(), 10)
    if (prev > 0 && prev < 100000) count = prev + 1
  } catch {}
  try { writeFileSync(cPath, String(count)) } catch {}

  // Write session checkpoint periodically (#215)
  if (count % CHECKPOINT_INTERVAL === 0) {
    try { writeCheckpoint(count, cwd) } catch { /* never block on checkpoint failure */ }
  }

  // Learning nudge every Nth stop
  if (count % LEARN_INTERVAL !== 0) {
    process.stdout.write(raw)
    return
  }

  const output = { additionalContext: LEARN_PROMPT }
  process.stdout.write(JSON.stringify(output))
}
