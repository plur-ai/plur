import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
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
 * plur hook-codex-guard — Codex `PreToolUse` hook.
 *
 * Codex accepts `permissionDecision: "deny"` with a
 * `permissionDecisionReason` and surfaces that reason to the model —
 * verified on codex-cli 0.149.1, where denying a shell call made the model
 * go looking for `plur_session_start`. It REJECTS `"allow"` and `"ask"`
 * from a hook ("PreToolUse hook returned unsupported permissionDecision"),
 * so this hook only ever denies or stays silent; it can never wave a tool
 * through that Codex's own approval policy would have stopped.
 *
 * In practice this rarely fires: SessionStart writes the sentinel before the
 * first tool call. It exists for the paths where SessionStart does not run.
 *
 * Deadlock prevention, same rule as Claude Code's hook-session-guard (#199)
 * and the Cursor guard: nudge once, then give up and mark the session
 * started anyway. A wedged or missing MCP server must not be able to lock
 * the agent into a state where the only permitted tool is one it cannot
 * reach.
 *
 * Input:  JSON on stdin — { session_id, tool_name, tool_input, ... }
 * Output: JSON on stdout — a deny decision, or nothing.
 */

const MAX_BLOCKS_BEFORE_FALLBACK = 1

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex guard', async () => {
    if (!isPlurConfigured()) return

    const input = readStdinJson()
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
