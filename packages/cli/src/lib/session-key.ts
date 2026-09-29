/**
 * Filesystem-safe token derived from a raw session/conversation id.
 *
 * Hook payloads (Claude Code `session_id`, Cursor `conversation_id`) are not
 * guaranteed safe to interpolate directly into a path — a `../`-laden or
 * OS-invalid id can escape the sessions/temp dir (path traversal) or throw
 * ENOENT/EINVAL. Replacing anything outside [A-Za-z0-9_-] closes both path
 * traversal (`../`, `/`) and OS-invalid characters (`:`, `|`, null bytes) while
 * leaving well-formed real ids (UUIDs, which are already in this safe set)
 * untouched.
 *
 * Shared by the Cursor hooks (cursor-hook-io.ts) and the Claude Code session
 * hooks (hook-session-guard.ts, hook-session-mark.ts) so every hook that turns
 * an id into a path sanitizes it identically — a guard and its sentinel-writer
 * must agree on the key, or a well-formed session would stop matching.
 */
export function safeSessionKey(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, '_')
  return safe || 'unknown'
}

/**
 * THE key for Claude Code hook state — inject marker, reminder timer, inject
 * lock, stop counter, session checkpoint (owner decision H1 = "payload",
 * 2026-09-29). One helper, so writers and readers cannot disagree:
 *
 *   payload `session_id` → `CLAUDE_SESSION_ID` → `process.ppid`
 *
 * The payload is first because Claude Code sends it on every hook and other
 * editors do not set the variable (#1278/#1301). Path-safe via
 * {@link safeSessionKey}; at most 64 characters, the length the checkpoint
 * readers (hook-session-end, plur_session_end) have always used.
 */
export function hookSessionKey(payloadSessionId?: unknown): string {
  const raw =
    (typeof payloadSessionId === 'string' && payloadSessionId) ||
    process.env.CLAUDE_SESSION_ID ||
    String(process.ppid || 'unknown')
  return safeSessionKey(raw).slice(0, 64)
}

/**
 * Keys older writers used for the same session, for READERS only (H1: nothing
 * is lost on upgrade). Never written. In order:
 *  - #1228's hook-inject key: `sid-` + safeSessionKey(payload id);
 *  - the uncapped #1301 form: safeSessionKey(raw) without the 64-char cap;
 *  - main's / #1228's checkpoint and counter key: env first, then ppid, with
 *    unsafe characters STRIPPED (not replaced), capped at 64, else 'default';
 *  - the stripped form of the payload id (older plur_session_end readers).
 * The current {@link hookSessionKey} is excluded; duplicates are dropped.
 */
export function legacyHookSessionKeys(payloadSessionId?: unknown): string[] {
  const payload = typeof payloadSessionId === 'string' && payloadSessionId ? payloadSessionId : ''
  const env = process.env.CLAUDE_SESSION_ID || ''
  const ppid = String(process.ppid || 'unknown')
  const strip = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)
  const forms = [
    payload ? `sid-${safeSessionKey(payload)}` : '',
    safeSessionKey(payload || env || ppid),
    strip(env || ppid) || 'default',
    payload ? strip(payload) : '',
  ]
  const current = hookSessionKey(payloadSessionId)
  return [...new Set(forms.filter(k => k && k !== current))]
}
