import { readSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { type GlobalFlags } from '../plur.js'
import { createPlur } from '../plur.js'
import { isPlurConfigured } from '../lib/plur-configured.js'

/**
 * plur hook-session-end — Claude Code SessionEnd hook (shipped v1.0.85).
 *
 * Auto-closes the PLUR memory lifecycle when a session ends, instead of
 * relying on the agent remembering to call plur_session_end (#217).
 *
 * How it relates to the rest of the lifecycle:
 * - hook-learn-check writes periodic session checkpoints (#215).
 * - plur_session_end (agent-called) is the primary close: it creates engrams
 *   from LLM-reviewed suggestions, captures an episode, AND unlinks the
 *   checkpoint.
 * - If the agent never calls plur_session_end, the checkpoint is left behind.
 *   Previously the ONLY recovery was hook-inject's deferred wrap-up (#216) on
 *   the NEXT session_start, which emits a transient notice but captures no
 *   durable episode.
 *
 * This hook closes that gap: fired by Claude Code at the moment the session
 * ends, it captures a durable closing episode from the checkpoint metadata and
 * cleans up the checkpoint — at the right time, with the right cwd. It cannot
 * produce LLM-quality engram suggestions (no model runs in a shell hook), so it
 * is a conservative safety net, not a replacement for plur_session_end.
 *
 * If the checkpoint is absent, plur_session_end already ran (clean close) or
 * the session was too short to checkpoint — either way there is nothing to do.
 *
 * Input: JSON on stdin (Claude Code SessionEnd hook format: session_id, cwd,
 *        reason). Never blocks; SessionEnd output is advisory.
 */

function sessionKeys(payloadSessionId?: string): string[] {
  // Mirror plur_session_end's key resolution (tools.ts): payload session_id
  // first, then CLAUDE_SESSION_ID, then ppid — sanitized the same way as
  // hook-learn-check writes them.
  return [payloadSessionId, process.env.CLAUDE_SESSION_ID, String(process.ppid)]
    .filter(Boolean)
    .map(k => k!.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64))
    .filter(Boolean)
}

function plurPath(flags: GlobalFlags): string {
  return flags.path ?? process.env.PLUR_PATH ?? join(homedir(), '.plur')
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
  // Silent pass-through for projects without plur configured (#247) — lets the
  // hook be installed globally without touching unrelated projects.
  if (!isPlurConfigured()) return

  const raw = readStdinRaw()
  let payload: { session_id?: string; cwd?: string; reason?: string } = {}
  try {
    payload = JSON.parse(raw)
  } catch { /* fall back to env-derived keys */ }

  const sessionsDir = join(plurPath(flags), 'sessions')
  if (!existsSync(sessionsDir)) return

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
        // Corrupt checkpoint — remove it and stop.
        try { unlinkSync(cp) } catch {}
        return
      }
    }
  }

  // No checkpoint → clean close already happened, or session too short. Nothing
  // to close.
  if (!checkpointPath || !checkpoint) return

  // Build a conservative, metadata-only summary — the same information the
  // deferred wrap-up (#216) reports, but captured as a durable episode.
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

  try {
    const plur = createPlur(flags)
    plur.capture(summary, {
      channel: 'hook',
      agent: 'claude-code',
      session_id: checkpoint.session_id || payload.session_id,
      tags: ['session-end', 'auto-close'],
    })
  } catch {
    // Capture is best-effort — never let a SessionEnd hook fail the session.
  }

  // Clean up the checkpoint so the next session_start's deferred wrap-up does
  // not double-report this session (#216).
  try { unlinkSync(checkpointPath) } catch {}

  // Ensure the sessions dir still exists for subsequent sessions (defensive —
  // capture may create the plur root lazily).
  try { mkdirSync(sessionsDir, { recursive: true }) } catch {}
}
