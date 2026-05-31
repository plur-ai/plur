import { readSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
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
 * Deadlock prevention (#199): if the guard has blocked more than
 * MAX_BLOCKS_BEFORE_FALLBACK tool calls without a session starting (e.g.
 * because the MCP server failed to start), it stops blocking and warns
 * via stderr instead. This prevents permanent deadlock while still
 * enforcing the session start flow under normal conditions.
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

// Nudge at most once per session, then fail open. A hard deny-everything
// guard collapses the agent's action space to the single exempt call
// (plur_session_start); under the deferred-tool flow that call can fail with
// "task required" if its schema isn't loaded yet, and the agent then retries
// it in a tight loop. Bounding the guard to one nudge makes that impossible:
// session-start memory is best-effort (hook-inject already injects on
// UserPromptSubmit), never worth trapping or pressuring a session.
const MAX_BLOCKS_BEFORE_FALLBACK = 1

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

function blockCountPath(sessionId: string): string {
  const dir = join(tmpdir(), 'plur-sessions')
  mkdirSync(dir, { recursive: true })
  return join(dir, `${sessionId}.guard-count`)
}

function incrementBlockCount(sessionId: string): number {
  const path = blockCountPath(sessionId)
  let count = 0
  try {
    count = parseInt(readFileSync(path, 'utf8'), 10) || 0
  } catch { /* file doesn't exist yet */ }
  count++
  writeFileSync(path, String(count))
  return count
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

  // Deadlock prevention (#199): if we've blocked too many times without a
  // session starting, the MCP server likely failed to load. Stop blocking
  // to prevent permanent deadlock.
  const blockCount = incrementBlockCount(sessionId)
  if (blockCount > MAX_BLOCKS_BEFORE_FALLBACK) {
    process.stderr.write(
      `[plur] session guard: allowing tools after ${MAX_BLOCKS_BEFORE_FALLBACK} nudge(s) ` +
      `without a session start. If plur_session_start never ran, the MCP server ` +
      `may be down — run \`plur doctor\` to diagnose. Memory injection is best-effort.\n`,
    )
    return
  }

  // Nudge once (calm, anti-batching), then fail open on the next call.
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Reminder: call mcp__plur__plur_session_start once before other tools ' +
        'so this session has memory. It is a deferred tool — first run ' +
        "ToolSearch 'select:mcp__plur__plur_session_start' as its own step, " +
        'then call it a single time with a short task description. Do not batch ' +
        'the ToolSearch with the call, and do not repeat it. This reminder fires ' +
        'only once; your next tool call proceeds normally whether or not ' +
        'session_start succeeded.',
    },
  }
  process.stdout.write(JSON.stringify(output))
}
