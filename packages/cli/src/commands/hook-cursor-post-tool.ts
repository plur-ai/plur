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
 * plur hook-cursor-post-tool — Cursor `postToolUse` hook (fires reliably, even
 * in background agents). On plur_session_start (via isPlurSessionStartTool())
 * it marks the sentinel; otherwise it reminds about plur_learn every 10 minutes.
 * Cursor drops `additional_context`, so the PRIMARY channel is
 * `.cursor/rules/plur-reminder.mdc` via `writeContextRule()` — never the
 * session-context file (see `cursorReminderRulePath()`).
 * Input: JSON on stdin — { tool_name, tool_input, tool_output, conversation_id | session_id }
 * Output: JSON on stdout — { additional_context } or nothing (secondary channel)
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
