import { existsSync, writeFileSync, statSync } from 'fs'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import {
  readStdinJson,
  cursorConversationId,
  isPlurSessionStartTool,
  sentinelPath,
  lastReminderPath,
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
 * Delivery mechanism (audit fix, live-evidence version — see Global
 * Constraints): the reminder was originally `additional_context`-only. Cursor's
 * own team confirmed on their forum this is dropped for `postToolUse` too
 * (same race condition as `sessionStart`), so the reminder is now written to
 * its own dynamic rules file via `writeContextRule()` as the PRIMARY channel,
 * with `additional_context` kept as a harmless secondary output. This used to
 * write to the SAME file hook-cursor-session-start.ts uses for recalled
 * engram content, which meant the first reminder silently deleted that
 * session's injected memory (audit fix — Codex adversarial review,
 * 2026-07-08) — see `cursorReminderRulePath()`'s docstring.
 *
 * Tool-name matching uses the shared isPlurSessionStartTool() (audit fix —
 * this used to be a second, slightly different local implementation here;
 * see cursor-hook-io.ts's docstring for why that was a real divergence
 * risk). It isn't confirmed whether Cursor sends MCP tool names prefixed
 * like Claude Code's mcp__plur__plur_session_start or bare
 * (plur_session_start) — Task 11 (manual verification) settles this, and
 * because the check now lives in one place, that fix only needs to happen
 * once.
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

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  if (!isPlurConfigured()) return

  const input = readStdinJson()
  const conversationId = cursorConversationId(input)
  if (!conversationId) return

  const toolName = String(input.tool_name ?? '')

  if (isPlurSessionStartTool(toolName)) {
    markSessionStarted(conversationId)
    return
  }

  if (!existsSync(sentinelPath(conversationId))) return // session not started — nothing to remind about yet
  if (!isReminderDue(conversationId)) return

  writeFileSync(lastReminderPath(conversationId), String(Date.now()))
  writeContextRule(REMINDER_TEXT, cursorReminderRulePath())
  process.stdout.write(JSON.stringify({ additional_context: REMINDER_TEXT }))
}
