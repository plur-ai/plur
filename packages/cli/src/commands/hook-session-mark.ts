import { readSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { safeSessionKey } from '../lib/session-key.js'
import { writeFileNoFollow } from '../lib/codex-hook-io.js'

/**
 * plur hook-session-mark — PostToolUse hook on mcp__plur__plur_session_start.
 *
 * Creates a sentinel file so hook-session-guard allows subsequent tool calls.
 *
 * Input: JSON on stdin (Claude Code PostToolUse hook format)
 * Output: none
 */

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

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  // Silent pass-through for projects without plur configured (#95).
  if (!isPlurConfigured()) return

  const raw = readStdinRaw()
  let data: { session_id?: string }
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }

  const sessionId = data.session_id ?? ''
  if (!sessionId) return

  // Sanitize before interpolating into a path (shared with hook-session-guard,
  // which reads this same sentinel): a `../`-laden session_id would otherwise
  // escape $TMPDIR and write the sentinel wherever it points (path traversal).
  const sentinel = join(tmpdir(), `plur-session-${safeSessionKey(sessionId)}`)
  // O_NOFOLLOW, 0600 (formal r2, cli#8): the sentinel sits directly in the
  // shared tmpdir, and a plain writeFileSync followed a pre-planted
  // `plur-session-<id>` symlink and TRUNCATED whatever it pointed at.
  // Best-effort — a failed mark costs one extra nudge.
  writeFileNoFollow(sentinel, '')
}
