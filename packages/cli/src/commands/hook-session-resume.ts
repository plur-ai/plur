import { type GlobalFlags } from '../plur.js'
import { clearFolderAsk, isResumeStart, parsePayload, readStdinRaw } from '../lib/folder-gate.js'

/**
 * plur hook-session-resume — Claude Code SessionStart hook, matcher "resume".
 *
 * `claude --resume` keeps the session id. SessionEnd already deleted that
 * session's folder-question nonces, but the ask-once record stayed, so the
 * resumed session was never asked again and a "yes" to the question shown
 * before the resume failed with nonce-unknown. This clears that record, so
 * the resumed session's first prompt asks again with a fresh nonce (#1347,
 * option C).
 *
 * The payload's `source` is checked as well as the matcher: a startup, clear
 * or compact SessionStart of an ongoing session must not re-ask. Prints
 * nothing, whatever the folder's mode; clearing a record that does not exist
 * is a no-op.
 *
 * Input: JSON on stdin — { session_id, cwd, hook_event_name, source }
 */
export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  const payload = parsePayload(readStdinRaw())
  if (!isResumeStart(payload)) return
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  clearFolderAsk(sessionId)
}
