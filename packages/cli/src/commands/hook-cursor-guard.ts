import { type GlobalFlags } from '../plur.js'
import { cursorHookFolder } from '../lib/folder-gate.js'
import {
  readStdinJson,
  cursorConversationId,
  isPlurSessionStartTool,
  sentinelPath,
  isSessionStarted,
  markSessionStarted,
  incrementCounter,
} from '../lib/cursor-hook-io.js'

/**
 * plur hook-cursor-guard — Cursor `preToolUse` hook.
 *
 * Cursor's `preToolUse` fires for every tool call, including MCP tools, and
 * its `permission: "deny"` output is documented to be enforced — the analog
 * of Claude Code's PreToolUse session guard. That enforcement is documented
 * but not verified against a live Cursor install; the tests can only assert
 * that the hook process emits `{"permission":"deny"}`. Cursor hooks can only
 * reliably deny (an "allow" does not override Cursor's MCP approval UI), so
 * this hook emits a deny or nothing, never an explicit allow.
 *
 * In normal interactive use this rarely denies: sessionStart already wrote
 * the sentinel before the first tool call. Its job is the background/cloud-
 * agent path, where sessionStart never runs — there it denies until the agent
 * calls plur_session_start, which hook-cursor-post-tool then marks
 * (postToolUse runs for cloud agents). Whether Cursor fires preToolUse on
 * that path is not confirmed; if it does not, this hook never runs there.
 *
 * Deadlock prevention, as in Claude Code's hook-session-guard: stop blocking
 * after one nudge so a broken MCP server can't wedge the agent into only ever
 * being allowed to call plur_session_start. On giving up, the session is
 * marked started too: hook-cursor-post-tool's reminders are gated on the
 * sentinel, and without it the background/cloud-agent case would get no
 * memory reminders for the rest of the conversation.
 *
 * Input: JSON on stdin — { tool_name, tool_input, conversation_id | session_id, ... }
 * Output: JSON on stdout — { permission: "deny", user_message, agent_message } or nothing
 */

const MAX_BLOCKS_BEFORE_FALLBACK = 1

function blockCountPath(conversationId: string): string {
  return `${sentinelPath(conversationId)}.guard-count`
}

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const input = readStdinJson()
  // Silent unless the folder map says on.
  if (cursorHookFolder(input, flags).policy.mode !== 'on') return
  const toolName = String(input.tool_name ?? '')
  if (isPlurSessionStartTool(toolName)) return

  const conversationId = cursorConversationId(input)
  if (!conversationId) return // can't check — allow through rather than block blind

  if (isSessionStarted(conversationId)) return // session already started

  const blockCount = incrementCounter(blockCountPath(conversationId))
  if (blockCount > MAX_BLOCKS_BEFORE_FALLBACK) {
    // Mark the session started too, so hook-cursor-post-tool's reminder path
    // is not starved — see the file-level comment above.
    markSessionStarted(conversationId)
    process.stderr.write(
      `[plur] guard: allowing tools after ${MAX_BLOCKS_BEFORE_FALLBACK} nudge(s) without an ` +
      'explicit session start. Marking the session started anyway so memory reminders can ' +
      'still resume in degraded mode. If plur_session_start never ran, the MCP server may be ' +
      'down — run `plur doctor` to diagnose.\n',
    )
    return
  }

  process.stdout.write(JSON.stringify({
    permission: 'deny',
    user_message: 'PLUR: starting memory for this session first.',
    agent_message:
      'Call plur_session_start once with a short task description before using other ' +
      'tools, so this session has memory. This will stop blocking automatically once that ' +
      'call succeeds, and only nudges once even if it does not.',
  }))
}
