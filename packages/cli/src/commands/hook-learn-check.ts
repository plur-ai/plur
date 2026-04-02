import { readSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { type GlobalFlags } from '../plur.js'

/**
 * plur hook-learn-check — Stop hook that prompts learning reflection.
 *
 * Runs at the end of every response. Every 3rd Stop, injects a brief
 * reminder to check if anything worth remembering happened. This catches
 * reasoning moments that no tool-level hook can intercept.
 *
 * The counter persists via a temp file keyed to the parent process (session).
 *
 * Input: JSON on stdin (Claude Code Stop hook format)
 * Output: JSON on stdout with additionalContext (or passthrough)
 */

const INTERVAL = 3 // Fire every N stops

function counterPath(): string {
  const dir = join(tmpdir(), 'plur-sessions')
  mkdirSync(dir, { recursive: true })
  // Use session ID (stable across all hooks in a session) with ppid fallback
  const sessionKey = process.env.CLAUDE_SESSION_ID || String(process.ppid || 'unknown')
  const safeKey = sessionKey.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'default'
  return join(dir, `${safeKey}.stop-count`)
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

  // Read and increment persistent counter
  const cPath = counterPath()
  let count = 1
  try {
    const prev = parseInt(readFileSync(cPath, 'utf8').trim(), 10)
    if (prev > 0 && prev < 100000) count = prev + 1
  } catch {}
  try { writeFileSync(cPath, String(count)) } catch {}

  // Only fire every Nth stop
  if (count % INTERVAL !== 0) {
    process.stdout.write(raw)
    return
  }

  const output = { additionalContext: LEARN_PROMPT }
  process.stdout.write(JSON.stringify(output))
}
