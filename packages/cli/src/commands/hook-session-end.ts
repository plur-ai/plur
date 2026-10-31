import { readSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { createPlur } from '../plur.js'
import { hookFolderPolicy, isWorkingMode, payloadDir } from '../lib/folder-gate.js'
import type { FolderPolicy } from '@plur-ai/core'
import { endFolderNonceSession } from '@plur-ai/core'
import { safeSessionKey } from '../lib/session-key.js'
import { flushOutboxForHook, HOOK_OUTBOX_BUDGET_MS } from '../lib/hook-outbox-flush.js'
import { hookSessionKey, legacyHookSessionKeys } from '../lib/session-key.js'
import { removeSessionTask } from '../lib/session-task.js'

/**
 * plur hook-session-end — Claude Code SessionEnd hook.
 *
 * Auto-closes the PLUR memory lifecycle when a session ends, instead of
 * relying on the agent remembering to call plur_session_end.
 *
 * How it relates to the rest of the lifecycle:
 * - hook-learn-check writes periodic session checkpoints.
 * - plur_session_end (agent-called) is the primary close: it creates engrams
 *   from LLM-reviewed suggestions, captures an episode, AND unlinks the
 *   checkpoint.
 * - If the agent never calls plur_session_end, the checkpoint is left behind.
 *   hook-inject's deferred wrap-up on the NEXT session_start emits a
 *   transient notice for it but captures no durable episode.
 *
 * This hook is fired by Claude Code at the moment the session ends: it captures a durable closing episode from the checkpoint metadata and
 * cleans up the checkpoint — at the right time, with the right cwd. It cannot
 * produce LLM-quality engram suggestions (no model runs in a shell hook), so it
 * is a conservative safety net, not a replacement for plur_session_end.
 *
 * If the checkpoint is absent, plur_session_end already ran (clean close) or
 * the session was too short to checkpoint — either way there is nothing to do.
 *
 * It also retries queued team writes (the outbox), within a bounded
 * budget, on every exit path — including the clean-close one, where there is
 * no checkpoint to act on.
 *
 * Input: JSON on stdin (Claude Code SessionEnd hook format: session_id, cwd,
 *        reason). Never blocks; SessionEnd output is advisory.
 */

function sessionKeys(payloadSessionId?: string): string[] {
  // Mirror plur_session_end's key resolution (tools.ts): payload session_id
  // first, then CLAUDE_SESSION_ID, then ppid. hook-learn-check writes the
  // checkpoint under safeSessionKey(id), which REPLACES unsafe characters with
  // '_' — try that form first, then the stripped form older writers used.
  //
  // The writer's key is hookSessionKey (payload first); legacyHookSessionKeys
  // adds the forms older writers used (including the env-first stripped key
  // and its 'default'). The per-candidate forms below are a superset so
  // checkpoints written under any of those keys are still found.
  const perCandidate = [payloadSessionId, process.env.CLAUDE_SESSION_ID, String(process.ppid)]
    .filter(Boolean)
    .flatMap(k => [
      safeSessionKey(k!).slice(0, 64),
      k!.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64),
    ])
  return [...new Set([hookSessionKey(payloadSessionId), ...legacyHookSessionKeys(payloadSessionId), ...perCandidate])]
    .filter(Boolean)
}

function plurPath(flags: GlobalFlags): string {
  // `||`, as createPlur and the checkpoint writer resolve it: an
  // empty PLUR_PATH means "unset" everywhere, not "the current directory".
  return flags.path || process.env.PLUR_PATH || join(homedir(), '.plur')
}

function readStdinRaw(): string {
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    while (true) {
      try {
        const n = readSync(0, buf, 0, buf.length, null)
        if (n === 0) break
        chunks.push(Buffer.from(buf.subarray(0, n)))
      } catch {
        break
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  } catch {
    return ''
  }
}

export async function run(_args: string[], flags: GlobalFlags): Promise<void> {
  // The folder gate decides. An off folder gets nothing, the outbox flush
  // included.
  const folder = await closeSession(flags)
  if (!folder) return
  // After the close, never instead of it — the checkpoint work is the
  // cheaper, more important half, and the flush has the rest of the budget.
  // Bound to the payload's folder, not this process's.
  await flushOutboxForHook(flags, { hook: 'hook-session-end', budgetMs: HOOK_OUTBOX_BUDGET_MS.claudeSessionEnd, folder })
}

/**
 * Closes the session's checkpoint. Returns the payload's folder and its
 * decision when the hooks work there (on or remote-only), else false.
 */
async function closeSession(flags: GlobalFlags): Promise<{ dir: string; policy: FolderPolicy } | false> {
  const raw = readStdinRaw()
  let payload: { session_id?: string; cwd?: string; reason?: string } = {}
  try {
    payload = JSON.parse(raw)
  } catch { /* fall back to env-derived keys */ }

  // The hook-inject rehydrate query is a copy of the user's latest prompt;
  // it has no use once the session is over.
  removeSessionTask(payload.session_id)

  // The ask flow's nonces for this session expire with it, whatever
  // the folder's mode. Only removes this session's own nonce file.
  if (payload.session_id) try { endFolderNonceSession(plurPath(flags), payload.session_id) } catch { /* best-effort */ }

  // Nothing is captured unless the folder map says on.
  const dir = payloadDir(payload as Record<string, unknown>)
  const policy = hookFolderPolicy(dir, flags)
  if (!isWorkingMode(policy)) return false
  const folder = { dir, policy }
  // remote-only: no timeline capture. The session's
  // checkpoint (its metadata) is dropped too, so no later session captures it.
  const remoteOnly = policy.mode === 'remote-only'

  const sessionsDir = join(plurPath(flags), 'sessions')
  if (!existsSync(sessionsDir)) return folder

  // Locate this session's checkpoint. Presence means plur_session_end did NOT
  // run (it unlinks the checkpoint), so we auto-close.
  let checkpointPath: string | null = null
  let checkpoint: any = null
  for (const key of sessionKeys(payload.session_id)) {
    const cp = join(sessionsDir, `${key}.checkpoint.json`)
    if (existsSync(cp)) {
      try {
        checkpoint = JSON.parse(readFileSync(cp, 'utf8'))
        checkpointPath = cp
        break
      } catch {
        // Unparseable checkpoint — RETAIN it, never destroy it. writeCheckpoint
        // is atomic (temp-file + rename), so this is genuine on-disk
        // corruption, but a checkpoint is a session's only durable record and
        // unlinking it would be silent data loss. Leave it in place and stop —
        // the next session_start's deferred wrap-up can still find it, and
        // nothing is captured from unparseable content.
        return folder
      }
    }
  }

  // No checkpoint → clean close already happened, or session too short. Nothing
  // to close.
  if (!checkpointPath || !checkpoint) return folder
  // The checkpoint's OWN folder decides too: a
  // payload without a usable cwd falls back to this process's folder, which
  // may not be the session's. When in doubt, nothing is captured.
  let checkpointPolicy: { mode: string; reason?: string } | null = null
  if (typeof checkpoint.cwd === 'string' && checkpoint.cwd) {
    checkpointPolicy = hookFolderPolicy(checkpoint.cwd, flags)
  }
  if (remoteOnly || checkpointPolicy?.mode === 'remote-only') {
    try { unlinkSync(checkpointPath) } catch { /* gone */ }
    return folder
  }
  // An unresolvable folder: no capture; the checkpoint stays for a later,
  // resolvable session to decide.
  if (checkpointPolicy?.reason === 'malformed-map' || checkpointPolicy?.reason === 'resolver-error') return folder

  // Build a conservative, metadata-only summary — the same information the
  // deferred wrap-up reports, but captured as a durable episode.
  const started = checkpoint.started_at ? new Date(checkpoint.started_at) : null
  const ended = checkpoint.last_checkpoint ? new Date(checkpoint.last_checkpoint) : null
  let durationStr = ''
  if (started && ended && !isNaN(started.getTime()) && !isNaN(ended.getTime())) {
    const durationMin = Math.max(0, Math.round((ended.getTime() - started.getTime()) / 60000))
    durationStr = durationMin >= 60
      ? `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`
      : `${durationMin}m`
  }
  const cwd = payload.cwd || checkpoint.cwd || ''
  const project = cwd ? cwd.split('/').slice(-2).join('/') : ''
  const reason = payload.reason ? ` (reason: ${payload.reason})` : ''

  const summary =
    `Session auto-closed on SessionEnd${reason} without an explicit plur_session_end. ` +
    `${checkpoint.stop_count ?? 0} responses` +
    `${durationStr ? `, ${durationStr}` : ''}` +
    `${project ? `, ${project}` : ''}.`

  let captured = false
  try {
    const plur = createPlur(flags)
    plur.capture(summary, {
      channel: 'hook',
      agent: 'claude-code',
      session_id: checkpoint.session_id || payload.session_id,
      tags: ['session-end', 'auto-close'],
    })
    captured = true
  } catch (err) {
    // Capture is best-effort — never let a SessionEnd hook fail the session.
    // But do NOT delete the checkpoint below when it fails: the checkpoint is
    // the session's only durable record, and on a full disk (or any capture
    // failure) unlinking it would be silent data loss. Retaining it lets the
    // next session_start's deferred wrap-up recover the session. Advisory stderr only — SessionEnd output is not
    // surfaced to the user.
    process.stderr.write(
      `[plur] hook-session-end: capture failed, retaining checkpoint for recovery: ` +
      `${(err as Error)?.message ?? String(err)}\n`,
    )
  }

  // Clean up the checkpoint ONLY after a successful capture, so the session's
  // durable record survives a failed capture. On success this also prevents
  // the next session_start's deferred wrap-up from double-reporting this
  // session.
  if (captured) {
    try { unlinkSync(checkpointPath) } catch {}
  }

  // Ensure the sessions dir still exists for subsequent sessions (defensive —
  // capture may create the plur root lazily).
  try { mkdirSync(sessionsDir, { recursive: true }) } catch {}
  return folder
}
