import { unlinkSync } from 'fs'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
import { flushOutboxForHook, HOOK_OUTBOX_BUDGET_MS } from '../lib/hook-outbox-flush.js'
import {
  readStdinJson,
  runCodexHook,
  codexSessionId,
  sentinelPath,
  counterPath,
  cleanupStaleSessionFiles,
} from '../lib/codex-hook-io.js'

/**
 * plur hook-codex-session-end — Codex `SessionEnd` hook.
 *
 * Codex clamps SessionEnd timeouts (to 3s) and forces them to run
 * synchronously even if declared async, so this stays deliberately cheap:
 * it removes this session's sentinel and counters, and opportunistically
 * sweeps stale ones. It does NOT try to capture a closing episode the way
 * Claude Code's `hook-session-end` does — that call can take longer than
 * the budget, and being killed mid-write is worse than not writing.
 *
 * Closing the memory lifecycle properly remains the agent's job via
 * `plur_session_end`; the PostToolUse nudge reminds it.
 *
 * It does retry queued team writes (the outbox, #1269), inside a budget that
 * fits the 3s clamp and is skipped outright when nothing is queued. Unlike an
 * episode capture, a flush cut short loses nothing: undelivered entries stay
 * queued. `runCodexHook` force-exits afterwards, so nothing lingers.
 *
 * Input:  JSON on stdin — { session_id, reason, ... }
 * Output: nothing.
 */
export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex session-end', async () => {
    if (!isPlurConfigured()) return

    const input = readStdinJson()
    const sessionId = codexSessionId(input)
    if (sessionId) {
      for (const p of [
        sentinelPath(sessionId),
        counterPath(sessionId, 'guard-count'),
        counterPath(sessionId, 'tool-count'),
      ]) {
        try { unlinkSync(p) } catch { /* already gone */ }
      }
      cleanupStaleSessionFiles()
    }

    await flushOutboxForHook(flags, { hook: 'hook-codex-session-end', budgetMs: HOOK_OUTBOX_BUDGET_MS.codexSessionEnd })
  })
}
