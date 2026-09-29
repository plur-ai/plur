import { openSync, writeSync, closeSync, renameSync, unlinkSync, readFileSync, constants } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { randomBytes } from 'crypto'
import { ensureSessionDir } from './codex-hook-io.js'
import { safeSessionKey } from './session-key.js'

/**
 * State directory for the Claude Code `hook-inject` family: session markers,
 * reminder clocks, inject locks and the per-session task file.
 *
 * On Linux `$TMPDIR` is usually the shared /tmp. The directory is therefore
 * created 0700 and must be a real directory owned by this user
 * (`ensureSessionDir`, the check the Codex/Cursor/Antigravity families already
 * use). A directory that fails the check — a planted symlink, or one another
 * user created — is refused, and state goes to a private directory under the
 * PLUR root instead. Nothing is ever written into the refused directory.
 */
export function hookSessionDir(): string {
  const shared = join(tmpdir(), 'plur-sessions')
  if (ensureSessionDir(shared)) return shared
  const fallback = join(process.env.PLUR_PATH ?? join(homedir(), '.plur'), 'hook-sessions')
  ensureSessionDir(fallback) // best effort; writes below fail open if it cannot be made
  return fallback
}

/**
 * The rehydrate query is a search string, not a transcript. Keep only the head
 * of the prompt: enough to find relevant engrams after compaction, and no more
 * of the user's text on disk than that.
 */
export const SESSION_TASK_MAX_CHARS = 1000

function taskPath(sessionId: unknown): string | null {
  return typeof sessionId === 'string' && sessionId
    ? join(hookSessionDir(), `${safeSessionKey(sessionId)}.task`)
    : null
}

/**
 * Store the latest prompt for a session, for rehydration after compaction.
 * Written 0600 to an exclusive, no-follow temp file in the verified directory,
 * then renamed over the destination: a symlink planted at the destination is
 * replaced, never followed. Fail-open: a hook must never break the prompt.
 */
export function writeSessionTask(sessionId: unknown, text: string): void {
  const path = taskPath(sessionId)
  if (!path || !text) return
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let fd: number | null = null
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    writeSync(fd, text.slice(0, SESSION_TASK_MAX_CHARS))
    closeSync(fd)
    fd = null
    renameSync(tmp, path)
  } catch {
    if (fd !== null) try { closeSync(fd) } catch {}
    try { unlinkSync(tmp) } catch {}
  }
}

export function readSessionTask(sessionId: unknown): string {
  const path = taskPath(sessionId)
  if (!path) return ''
  try {
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try { return readFileSync(fd, 'utf8') } finally { closeSync(fd) }
  } catch {
    return ''
  }
}

/** Remove a session's task file at session end. unlink never follows a symlink. */
export function removeSessionTask(sessionId: unknown): void {
  const path = taskPath(sessionId)
  if (path) try { unlinkSync(path) } catch {}
}
