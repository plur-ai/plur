import { unlinkSync } from 'fs'
import { type GlobalFlags } from '../plur.js'
import { hookFolderPolicy, isWorkingMode, payloadDir, plurRoot } from '../lib/folder-gate.js'
import { endFolderNonceSession } from '@plur-ai/core'
import { flushOutboxForHook, HOOK_OUTBOX_BUDGET_MS } from '../lib/hook-outbox-flush.js'
import {
  readStdinJson,
  runCodexHook,
  codexSessionId,
  sentinelPath,
  counterPath,
  cleanupStaleSessionFiles,
  sessionDirSafeToSweep,
  sessionDir,
} from '../lib/codex-hook-io.js'

/**
 * plur hook-codex-session-end — Codex `SessionEnd` hook. Codex clamps it to 3s and runs it
 * synchronously, so it only removes this session's sentinel/counters and sweeps stale ones —
 * no episode capture (being killed mid-write is worse than not writing).
 * It retries queued team writes within the budget, skipped when nothing is queued; a cut-short
 * flush loses nothing. `runCodexHook` force-exits afterwards.
 * Input: JSON on stdin { session_id, reason, ... }. Output: nothing.
 */
export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  await runCodexHook('codex session-end', async () => {
    const input = readStdinJson()
    // This session's ask-flow nonces expire with it, whatever the mode.
    const endingId = typeof input.session_id === 'string' ? input.session_id : ''
    if (endingId) try { endFolderNonceSession(plurRoot(flags), endingId) } catch { /* best-effort */ }
    // Otherwise silent unless the folder map says on.
    const dir = payloadDir(input)
    const policy = hookFolderPolicy(dir, flags)
    if (!isWorkingMode(policy)) return
    const sessionId = codexSessionId(input)
    if (sessionId && sessionDirSafeToSweep(sessionDir())) {
      // Never unlink through a symlinked or foreign directory — the same rule
      // the stale sweep follows.
      for (const p of [
        sentinelPath(sessionId),
        counterPath(sessionId, 'guard-count'),
        counterPath(sessionId, 'tool-count'),
      ]) {
        try { unlinkSync(p) } catch { /* already gone */ }
      }
      cleanupStaleSessionFiles()
    }

    // Bound to the payload's folder, not this process's.
    await flushOutboxForHook(flags, { hook: 'hook-codex-session-end', budgetMs: HOOK_OUTBOX_BUDGET_MS.codexSessionEnd, folder: { dir, policy } })
  })
}
