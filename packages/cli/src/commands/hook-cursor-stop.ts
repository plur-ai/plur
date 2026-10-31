import { type GlobalFlags } from '../plur.js'
import { cursorHookFolder } from '../lib/folder-gate.js'
import { readStdinJson, cursorConversationId, stopCountPath, incrementCounter } from '../lib/cursor-hook-io.js'
import { flushOutboxForHook, HOOK_OUTBOX_BUDGET_MS, CURSOR_STOP_MIN_INTERVAL_MS } from '../lib/hook-outbox-flush.js'

/**
 * plur hook-cursor-stop — Cursor `stop` hook. Its `followup_message` is
 * auto-submitted as the next turn (like Claude Code's Stop nudge), so it nudges
 * only every Nth stop. Cursor has no session-end hook, so this also retries the
 * outbox at most every five minutes, bounded to the 3s timeout; the flush writes
 * only to stderr so stdout stays the hook's JSON.
 * Input: JSON on stdin — { status, conversation_id | session_id }
 * Output: JSON on stdout — { followup_message } or nothing
 */

const NUDGE_EVERY_N_STOPS = 3

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const input = readStdinJson()
  // Silent unless the folder map says on: no nudge and no outbox flush.
  if (cursorHookFolder(input, flags).policy.mode !== 'on') return

  nudge(input)
  await flushOutboxForHook(flags, {
    hook: 'hook-cursor-stop',
    budgetMs: HOOK_OUTBOX_BUDGET_MS.cursorStop,
    minIntervalMs: CURSOR_STOP_MIN_INTERVAL_MS,
  })
}

function nudge(input: Record<string, unknown>): void {
  const conversationId = cursorConversationId(input)
  if (!conversationId) return

  const status = String(input.status ?? '')
  if (status !== 'completed') return // don't nudge on aborted/error turns

  const count = incrementCounter(stopCountPath(conversationId))
  if (count % NUDGE_EVERY_N_STOPS !== 0) return

  process.stdout.write(JSON.stringify({
    followup_message:
      'Before continuing: if anything from this turn is worth remembering (a correction, ' +
      'a preference, a convention), call plur_learn now.',
  }))
}
