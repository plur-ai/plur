import { readSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { hookFolderOn, payloadDir } from '../lib/folder-gate.js'
import { safeSessionKey } from '../lib/session-key.js'

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

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const raw = readStdinRaw()
  let data: { session_id?: string; cwd?: string }
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  // Silent unless the folder map says on (#1347; was #95's project gate).
  if (!hookFolderOn(payloadDir(data as Record<string, unknown>), flags)) return

  const sessionId = data.session_id ?? ''
  if (!sessionId) return

  // Sanitize before interpolating into a path (shared with hook-session-guard,
  // which reads this same sentinel): a `../`-laden session_id would otherwise
  // escape $TMPDIR and write the sentinel wherever it points (path traversal).
  const sentinel = join(tmpdir(), `plur-session-${safeSessionKey(sessionId)}`)
  try {
    writeFileSync(sentinel, '')
  } catch {
    // Best-effort — tmpdir should always be writable
  }
}
