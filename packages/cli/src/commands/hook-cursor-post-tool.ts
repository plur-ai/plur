import { statSync } from 'fs'
import { type GlobalFlags } from '../plur.js'
import { cursorHookFolder } from '../lib/folder-gate.js'
import {
  readStdinJson,
  cursorConversationId,
  isPlurSessionStartTool,
  lastReminderPath,
  isSessionStarted,
  touchReminder,
  markSessionStarted,
  writeContextRule,
} from '../lib/cursor-hook-io.js'
import { cursorReminderRulePath } from '../mcp-config.js'

/**
 * plur hook-cursor-post-tool — Cursor `postToolUse` hook.
 *
 * Two jobs, both keyed off the same event because postToolUse is the only
 * Cursor hook that fires reliably after any tool call — including in cloud/
 * background agents, where sessionStart never fires:
 *
 *   1. If the call was plur_session_start, mark the sentinel — this is what
 *      covers the cloud/background-agent path (hook-cursor-session-start
 *      never ran there, so nothing else marks it).
 *   2. Otherwise, on a 10-minute cadence, remind the agent to call plur_learn
 *      — the closest available substitute for Claude Code's per-turn
 *      UserPromptSubmit reminder, since Cursor's beforeSubmitPrompt output is
 *      documented as not respected for context injection.
 *
 * Delivery: Cursor drops `additional_context` for `postToolUse` (the same
 * race as `sessionStart`), so the reminder is written to its own dynamic
 * rules file via `writeContextRule()` as the PRIMARY channel, with
 * `additional_context` kept as a harmless secondary output. It must not share
 * the file hook-cursor-session-start.ts uses for recalled engrams, or the
 * first reminder would erase that session's injected memory — see
 * `cursorReminderRulePath()`.
 *
 * Tool-name matching uses the shared isPlurSessionStartTool(), so the
 * prefixed (mcp__plur__plur_session_start) and bare (plur_session_start)
 * forms are handled in one place for every Cursor hook.
 *
 * Input: JSON on stdin — { tool_name, tool_input, tool_output, conversation_id | session_id }
 * Output: JSON on stdout — { additional_context } or nothing (secondary channel)
 * Side effect: overwrites `.cursor/rules/plur-reminder.mdc` when reminding (primary channel) —
 * NOT the session-context file hook-cursor-session-start.ts writes.
 */

const REMINDER_INTERVAL_MS = 10 * 60 * 1000

const REMINDER_TEXT =
  '[PLUR Memory Reminder] If the user corrected you, stated a preference, or you ' +
  'discovered a pattern — call plur_learn now. Call plur_session_end before the ' +
  'conversation ends.'

function isReminderDue(conversationId: string): boolean {
  try {
    const stat = statSync(lastReminderPath(conversationId))
    return Date.now() - stat.mtimeMs > REMINDER_INTERVAL_MS
  } catch {
    return true
  }
}

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const input = readStdinJson()
  // Silent unless the folder map says on.
  const folder = cursorHookFolder(input, flags)
  if (folder.policy.mode !== 'on' || !folder.dir) return
  const dir = folder.dir
  const conversationId = cursorConversationId(input)
  if (!conversationId) return

  const toolName = String(input.tool_name ?? '')

  if (isPlurSessionStartTool(toolName)) {
    markSessionStarted(conversationId)
    return
  }

  if (!isSessionStarted(conversationId)) return // session not started — nothing to remind about yet
  if (!isReminderDue(conversationId)) return

  touchReminder(conversationId)
  writeContextRule(REMINDER_TEXT, cursorReminderRulePath(dir))
  process.stdout.write(JSON.stringify({ additional_context: REMINDER_TEXT }))
}
