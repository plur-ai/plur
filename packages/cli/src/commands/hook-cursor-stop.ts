import { type GlobalFlags } from '../plur.js'
import { hookFolderOn, payloadDir } from '../lib/folder-gate.js'
import { readStdinJson, cursorConversationId, stopCountPath, incrementCounter } from '../lib/cursor-hook-io.js'
import { flushOutboxForHook, HOOK_OUTBOX_BUDGET_MS, CURSOR_STOP_MIN_INTERVAL_MS } from '../lib/hook-outbox-flush.js'

/**
 * plur hook-cursor-stop — Cursor `stop` hook.
 *
 * Fires when the agent loop ends. Its `followup_message` output is
 * auto-submitted as the next turn (per Cursor's docs) — the same mechanism
 * Claude Code's Stop hook uses for the learning-reflection nudge
 * (hook-learn-check), just exposed through a different field name. Fires
 * every Nth stop, not every one, to avoid an extra auto-submitted turn on
 * every single response.
 *
 * Cursor has no session-end hook, so this is also where queued team writes
 * (the outbox, #1269) are retried — whatever the stop's status, at most once
 * every five minutes. With nothing queued that costs one file read; otherwise
 * it is bounded to fit the hook's 3s timeout. The flush writes only to stderr, so stdout stays the
 * hook's JSON.
 *
 * Input: JSON on stdin — { status, conversation_id | session_id }
 * Output: JSON on stdout — { followup_message } or nothing
 */

const NUDGE_EVERY_N_STOPS = 3

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  const input = readStdinJson()
  // Silent unless the folder map says on (#1347).
  if (!hookFolderOn(payloadDir(input), flags)) return
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
