import { readSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'

/**
 * plur hook-session-guard — PreToolUse hook that blocks all tools until
 * plur_session_start has been called.
 *
 * Uses a sentinel file at /tmp/plur-session-{session_id} to track whether
 * the session has been started. The sentinel is created by hook-session-mark
 * (PostToolUse on mcp__plur__plur_session_start).
 *
 * Exempt tools (allowed without session): ToolSearch, mcp__plur__plur_session_start
 *
 * Input: JSON on stdin (Claude Code PreToolUse hook format)
 * Output: JSON with permissionDecision: "deny" if session not started
 */

const EXEMPT_TOOLS = new Set([
  'mcp__plur__plur_session_start',
  'ToolSearch',
])

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

function sentinelPath(sessionId: string): string {
  return join(tmpdir(), `plur-session-${sessionId}`)
}

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  // Silent pass-through for projects without plur configured. Lets the hook
  // be installed globally without blocking tools in unrelated projects (#95).
  if (!isPlurConfigured()) return

  const raw = readStdinRaw()
  let data: { session_id?: string; tool_name?: string }
  try {
    data = JSON.parse(raw)
  } catch {
    return // Can't parse — allow through
  }

  const toolName = data.tool_name ?? ''
  const sessionId = data.session_id ?? ''

  // Always allow exempt tools
  if (EXEMPT_TOOLS.has(toolName)) return

  // No session ID — can't check, allow through
  if (!sessionId) return

  // Check sentinel
  if (existsSync(sentinelPath(sessionId))) return

  // Block
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'BLOCKED: plur_session_start has not been called yet. ' +
        'You MUST call mcp__plur__plur_session_start before using any other tool. ' +
        'Use ToolSearch to load it first if needed.',
    },
  }
  process.stdout.write(JSON.stringify(output))
}
