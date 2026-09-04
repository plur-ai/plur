import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import {
  readStdinJson,
  runCodexHook,
  codexSessionId,
  isPlurSessionStartTool,
  markSessionStarted,
  isSessionStarted,
  incrementCounter,
  counterPath,
  emitContext,
} from '../lib/codex-hook-io.js'

/**
 * plur hook-codex-post-tool — Codex `PostToolUse` hook.
 *
 * Two jobs:
 *
 * 1. SENTINEL. When the agent calls `plur_session_start` itself, mark the
 *    session started so `hook-codex-guard` stops denying. This is the path
 *    that matters when SessionStart never ran.
 *
 * 2. LEARN NUDGE. Codex has a `Stop` event, and Claude Code puts the nudge
 *    there — but `Stop` output is `{decision, reason}` only: no
 *    `additionalContext` (Codex explicitly warns "ignoring
 *    additionalContextLimit … this event cannot emit additionalContext"),
 *    and `decision: "block"` means "keep going", which would turn a gentle
 *    reminder into a forced extra turn. PostToolUse ACCEPTS
 *    additionalContext, so the nudge rides here on an every-Nth-tool
 *    cadence instead — the same fatigue-avoidance shape as
 *    `hook-learn-check`.
 *
 *    VERIFICATION STATUS (#1064): "accepts" is the verified part — Codex
 *    parses the output without complaint. Whether PostToolUse
 *    additionalContext actually REACHES the model was NOT covered by the
 *    2026-08-27 live verification, which exercised SessionStart and
 *    UserPromptSubmit delivery only. If Codex drops it, the cost is a
 *    silent no-op nudge (the sentinel job above is unaffected — it writes
 *    a file, needing no output channel). Verify with a trusted-hooks
 *    session per the probe procedure on #1064 before citing this nudge as
 *    working.
 *
 * Input:  JSON on stdin — { session_id, tool_name, tool_input, tool_response, ... }
 * Output: JSON on stdout — an additionalContext nudge, or nothing.
 */

const TOOLS_BETWEEN_NUDGES = 12

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex post-tool', async () => {
    if (!isPlurConfigured()) return

    const input = readStdinJson()
    const sessionId = codexSessionId(input)
    if (!sessionId) return

    const toolName = String(input.tool_name ?? '')

    if (isPlurSessionStartTool(toolName)) {
      markSessionStarted(sessionId)
      return
    }

    // Don't nudge before the session has actually started — the guard is
    // already saying something more specific at that point.
    if (!isSessionStarted(sessionId)) return

    const n = incrementCounter(counterPath(sessionId, 'tool-count'))
    if (n % TOOLS_BETWEEN_NUDGES !== 0) return

    emitContext(
      'PostToolUse',
      '[PLUR Memory] If anything in this session is worth remembering — a correction, a ' +
      'preference, a convention you discovered — call plur_learn now with an explicit domain ' +
      'and scope. Call plur_session_end before you finish.',
    )
  })
}
