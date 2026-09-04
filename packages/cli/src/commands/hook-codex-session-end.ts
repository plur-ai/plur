import { unlinkSync } from 'fs'
import { type GlobalFlags } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'
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
 * Input:  JSON on stdin — { session_id, reason, ... }
 * Output: nothing.
 */
export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex session-end', async () => {
    if (!isPlurConfigured()) return

    const input = readStdinJson()
    const sessionId = codexSessionId(input)
    if (!sessionId) return

    for (const p of [
      sentinelPath(sessionId),
      counterPath(sessionId, 'guard-count'),
      counterPath(sessionId, 'tool-count'),
    ]) {
      try { unlinkSync(p) } catch { /* already gone */ }
    }

    cleanupStaleSessionFiles()
  })
}
