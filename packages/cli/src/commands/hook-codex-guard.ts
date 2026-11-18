import { type GlobalFlags } from '../plur.js'
import { hookFolderOn, payloadDir } from '../lib/folder-gate.js'
import {
  readStdinJson,
  runCodexHook,
  codexSessionId,
  isPlurSessionStartTool,
  isSessionStarted,
  markSessionStarted,
  incrementCounter,
  counterPath,
} from '../lib/codex-hook-io.js'

/**
 * plur hook-codex-guard — Codex `PreToolUse` hook. Codex accepts only
 * `permissionDecision: "deny"` (with a reason) and rejects "allow"/"ask", so this
 * hook denies or stays silent; it can never wave a tool through. It rarely fires
 * (SessionStart writes the sentinel first). Deadlock prevention: nudge once,
 * then mark the session started, so a missing MCP server cannot lock the agent.
 * Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 * Output: JSON on stdout — a deny decision, or nothing.
 */

const MAX_BLOCKS_BEFORE_FALLBACK = 1

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex guard', async () => {
    const input = readStdinJson()
    // Silent unless the folder map says on.
    if (!hookFolderOn(payloadDir(input), flags)) return
    const toolName = String(input.tool_name ?? '')
    if (isPlurSessionStartTool(toolName)) return

    const sessionId = codexSessionId(input)
    if (!sessionId) return // can't track — allow through rather than block blind

    if (isSessionStarted(sessionId)) return

    const blockCount = incrementCounter(counterPath(sessionId, 'guard-count'))
    if (blockCount > MAX_BLOCKS_BEFORE_FALLBACK) {
      markSessionStarted(sessionId)
      process.stderr.write(
        `[plur] guard: allowing tools after ${MAX_BLOCKS_BEFORE_FALLBACK} nudge(s) without an ` +
        'explicit session start. Marking the session started so memory reminders can resume in ' +
        'degraded mode. If plur_session_start never ran, the MCP server may be down — run ' +
        '`plur doctor`.\n',
      )
      return
    }

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'PLUR: call plur_session_start once with a short task description before using other ' +
          'tools, so this session has memory. This stops blocking as soon as that call succeeds, ' +
          'and only nudges once even if it does not.',
      },
    }))
  })
}
