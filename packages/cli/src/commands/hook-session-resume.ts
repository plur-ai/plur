import { type GlobalFlags } from '../plur.js'
import { clearFolderAsk, isResumeStart, parsePayload, readStdinRaw } from '../lib/folder-gate.js'

/**
 * plur hook-session-resume — Claude Code SessionStart hook, matcher "resume".
 * `claude --resume` keeps the session id, and SessionEnd deleted its nonces but
 * not the ask-once record, so clear that record and the resumed session asks
 * again with a fresh nonce. `source` is checked too: startup/clear/compact must
 * not re-ask. Prints nothing; clearing a missing record is a no-op.
 * Input: JSON on stdin — { session_id, cwd, hook_event_name, source }
 */
export async function run(_args: string[], _flags: GlobalFlags): Promise<void> {
  const payload = parsePayload(readStdinRaw())
  if (!isResumeStart(payload)) return
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : ''
  clearFolderAsk(sessionId)
}
