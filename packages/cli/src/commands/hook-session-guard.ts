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

const MAX_BLOCKS_BEFORE_FALLBACK = 5

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
      `[plur] WARNING: session guard gave up after ${MAX_BLOCKS_BEFORE_FALLBACK} blocked calls. ` +
      `The plur MCP server may not be running. Run \`plur doctor\` to diagnose.\n`,
    )
    return
  }

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
