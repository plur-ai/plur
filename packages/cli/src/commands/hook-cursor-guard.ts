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
 * plur hook-cursor-guard — Cursor `preToolUse` session guard. Emits a deny or nothing,
 * never an allow (it cannot override Cursor's MCP approval UI); enforcement unverified.
 * Its job is the background/cloud-agent path where sessionStart never runs: deny
 * until plur_session_start (marked by hook-cursor-post-tool). After one nudge it
 * stops blocking and marks the session started, so a broken MCP server cannot wedge
 * the agent and post-tool reminders still fire.
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
