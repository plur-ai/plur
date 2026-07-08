import { readFileSync, writeFileSync } from 'fs'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { readStdinJson, cursorConversationId, stopCountPath } from '../lib/cursor-hook-io.js'

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
 * Input: JSON on stdin — { status, conversation_id | session_id }
 * Output: JSON on stdout — { followup_message } or nothing
 */

const NUDGE_EVERY_N_STOPS = 3

function incrementStopCount(conversationId: string): number {
  const path = stopCountPath(conversationId)
  let count = 0
  try { count = parseInt(readFileSync(path, 'utf8'), 10) || 0 } catch {}
  count++
  writeFileSync(path, String(count))
  return count
}

export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  if (!isPlurConfigured()) return

  const input = readStdinJson()
  const conversationId = cursorConversationId(input)
  if (!conversationId) return

  const status = String(input.status ?? '')
  if (status !== 'completed') return // don't nudge on aborted/error turns

  const count = incrementStopCount(conversationId)
  if (count % NUDGE_EVERY_N_STOPS !== 0) return

  process.stdout.write(JSON.stringify({
    followup_message:
      'Before continuing: if anything from this turn is worth remembering (a correction, ' +
      'a preference, a convention), call plur_learn now.',
  }))
}
