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
