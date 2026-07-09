import { readSync, mkdirSync, writeFileSync, appendFileSync, statSync, readdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { cursorContextRulePath } from '../mcp-config.js'

/**
 * Shared stdin-reading and sentinel-path helpers for the four hook-cursor-*
 * commands. Split out from any single hook file because all four need the
 * exact same conversation-id resolution and directory layout.
 *
 * Known structural limitations (evaluator review, 2026-07-08 — tracked as
 * follow-ups, not fixed here; see .superpowers/sdd/progress.md):
 *
 * 1. NO PER-CONVERSATION SCOPING of delivered content. Sentinel/reminder
 *    state IS scoped per `conversation_id` (this file), but the actual
 *    payload lands in `.cursor/rules/plur-context.mdc` /
 *    `plur-reminder.mdc` — one file per WORKSPACE, loaded into every open
 *    composer. Two simultaneous conversations in the same workspace will
 *    each overwrite what the other sees. There is no clean fix within
 *    Cursor's current rules-file mechanism (it has no per-conversation
 *    context channel) — this is the same underlying gap that forced this
 *    workaround in the first place (see writeContextRule's docstring).
 * 2. conversation_id REUSE is not detected. A sentinel/reminder/stop-count
 *    file is trusted purely by existence, with no age or identity check —
 *    if Cursor ever reissues an id (a fork sharing its parent's id, or
 *    recycling after a restart), the new conversation silently inherits
 *    the old one's guard/reminder/stop-count state. Not fixed speculatively
 *    because Cursor's actual fork/reuse behavior isn't confirmed (Task 11).
 * 3. NO COORDINATION with the pre-existing Claude Code hook family if both
 *    ever act on the same editor session (Cursor is reported to be able to
 *    load Claude Code config too) — two independent sentinel schemes, two
 *    independent plur.inject() calls, no shared "already handled this turn"
 *    signal.
 * 4. MID-CONVERSATION RULE-FILE REWRITES are not independently confirmed to
 *    be re-read before a conversation ends (evaluator review — Popper
 *    lens, iteration 4, 2026-07-09). The forum-confirmed fact is narrower
 *    than the workaround's own docstring implies: `additional_context` is
 *    dropped by a race at CONVERSATION-CREATION time. Cursor's rules
 *    engine reliably loading `alwaysApply: true` rules AT THAT SAME MOMENT
 *    is the actual confirmed fact; whether a REWRITE of that file later —
 *    e.g. hook-cursor-post-tool.ts's reminder, or a second
 *    hook-cursor-session-start.ts run — is picked up live rather than the
 *    rules being snapshotted once, is not established anywhere in this
 *    codebase or its cited evidence. If rules are snapshotted, this
 *    workaround has the identical "loaded once, then frozen" failure shape
 *    one layer down. Task 11 (manual verification) settles this.
 */

export function readStdinJson(): Record<string, unknown> {
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
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

/**
 * Cursor's hook payload envelope is not fully pinned down across doc sources
 * as of 2026-07 (the hooks API is explicitly beta): some examples show
 * `conversation_id` as the per-chat identifier, a structured summary of the
 * same docs page showed `session_id`. Accept either so these hooks work
 * regardless of which one Cursor actually sends — Task 11 (manual
 * verification against real Cursor) confirms which is real; narrow this
 * fallback then if only one shows up in practice.
 */
export function cursorConversationId(input: Record<string, unknown>): string {
  const id = String(input.conversation_id ?? input.session_id ?? '')
  if (!id) {
    // Audit fix (evaluator review, 2026-07-08): with neither guessed field
    // name present, every hook silently no-ops for the rest of its run —
    // previously with zero signal anywhere that this happened. This is the
    // one place all four hooks funnel through to resolve the id, so one
    // stderr line here covers all of them without duplicating it 4x.
    process.stderr.write(
      '[plur] cursor hook: no conversation_id or session_id in hook payload — ' +
      'skipping (memory injection/enforcement inactive for this event). If this ' +
      'persists, Cursor may be sending a different field name; run `plur doctor`.\n',
    )
  }
  return id
}

/**
 * Filesystem-safe token derived from a raw conversation id. Cursor's hook
 * payload schema is documented as beta/unconfirmed (see cursorConversationId
 * above) — nothing guarantees the value is safe to interpolate directly into
 * a path. Replacing anything outside [A-Za-z0-9_-] closes both path
 * traversal (`../`, `/`) and OS-invalid characters (`:`, `|`, null bytes)
 * while leaving well-formed real ids (UUIDs, which are already in this safe
 * set) untouched (audit fix — evaluator review, 2026-07-08: previously used
 * unsanitized in every path below, so a malformed id could throw ENOENT/
 * EINVAL and, combined with every hook's `failClosed: false`, silently and
 * permanently disable that conversation's guard/injection/reminders).
 */
function safeSessionKey(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, '_')
  return safe || 'unknown'
}

/**
 * Is this tool call `plur_session_start`? Hoisted here (audit fix) because
 * the original draft of this plan implemented this check twice, differently,
 * in hook-cursor-guard.ts (an exact-match Set) and hook-cursor-post-tool.ts
 * (an endsWith check) — a real divergence risk if Task 11's manual
 * verification finds the real tool-name format needs adjusting: fixing one
 * copy and missing the other would leave the guard and the post-tool
 * sentinel-writer permanently disagreeing about whether a session started.
 * One implementation, used by both.
 */
export function isPlurSessionStartTool(toolName: string): boolean {
  return toolName === 'plur_session_start' || toolName.endsWith('__plur_session_start')
}

const STALE_SESSION_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Delete session marker files older than STALE_SESSION_FILE_MAX_AGE_MS.
 * Mirrors the equivalent cleanup already done for Claude Code's checkpoint
 * files (hook-inject.ts unlinkSync's stale ~/.plur/sessions/*.checkpoint.json)
 * — audit fix (evaluator review, iteration 3, 2026-07-09): this Cursor port
 * never had an equivalent, so every unique conversation_id left orphaned
 * .marker/.reminded/.stopcount/.guard-count files in this directory
 * forever, unbounded — worst on exactly the long-lived background-agent
 * VMs this hook family targets. Best-effort: a stat/unlink failure on one
 * file (permissions, a race with another process) must not stop the rest
 * or throw out of a hook that's expected to run in milliseconds.
 */
function pruneStaleSessions(dir: string): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const cutoff = Date.now() - STALE_SESSION_FILE_MAX_AGE_MS
  for (const entry of entries) {
    const path = join(dir, entry)
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path)
    } catch { /* ignore — permissions, or another process already removed it */ }
  }
}

export function sessionsDir(): string {
  const dir = join(tmpdir(), 'plur-cursor-sessions')
  mkdirSync(dir, { recursive: true })
  pruneStaleSessions(dir)
  return dir
}

export function sentinelPath(conversationId: string): string {
  return join(sessionsDir(), `${safeSessionKey(conversationId)}.marker`)
}

export function lastReminderPath(conversationId: string): string {
  return join(sessionsDir(), `${safeSessionKey(conversationId)}.reminded`)
}

export function stopCountPath(conversationId: string): string {
  return join(sessionsDir(), `${safeSessionKey(conversationId)}.stopcount`)
}

/**
 * Shared counter for hook-cursor-guard.ts (block count) and
 * hook-cursor-stop.ts (stop count) — hoisted (audit fix, evaluator review,
 * 2026-07-08) because both used to independently implement
 * "read-int-default-0, increment, write", a read-then-write that isn't
 * atomic across the fresh, independent process each hook invocation is: two
 * events for the same conversation close enough together can both read the
 * same stale count and one increment is lost. Appending one byte is atomic
 * on POSIX filesystems even under concurrent writers — counting file size
 * instead of parsing decimal content can't lose an increment the way
 * read-then-write can.
 */
export function incrementCounter(path: string): number {
  appendFileSync(path, '.')
  try {
    return statSync(path).size
  } catch {
    return 1
  }
}

/**
 * Mark a conversation as started: write both the guard's sentinel and reset
 * the reminder timer in one call. Three call sites need this (session-start
 * hook on the normal interactive path; post-tool hook on the explicit
 * plur_session_start path; and the guard's own deadlock-prevention fallback,
 * audit fix — see hook-cursor-guard.ts) and all three must do exactly the
 * same two writes, so it's one function instead of copy-pasted pairs.
 */
export function markSessionStarted(conversationId: string): void {
  const now = String(Date.now())
  writeFileSync(sentinelPath(conversationId), now)
  writeFileSync(lastReminderPath(conversationId), now)
}

/**
 * Write recalled engram content to the dynamic context rule file (audit fix,
 * live-evidence version — see Global Constraints). Cursor's own team
 * confirmed on their forum that `additional_context` from BOTH `sessionStart`
 * and `postToolUse` is dropped by a race condition ("runs async before the
 * composer handle is fully created") — a filed, acknowledged bug with no fix
 * timeline as of this plan's writing. The community-and-team-confirmed
 * workaround is to write the same content into a `.cursor/rules/*.mdc` file
 * instead: Cursor's rules engine reliably loads `alwaysApply: true` rules AT
 * CONVERSATION CREATION, unlike the broken hook-output channel. This is now
 * the PRIMARY delivery mechanism for hook-cursor-session-start.ts and
 * hook-cursor-post-tool.ts — not a fallback — both also still emit
 * `additional_context` too (harmless, and picks up automatically if/when
 * Cursor fixes the underlying bug).
 *
 * Narrower than it may read (audit fix — Popper-lens evaluator review,
 * iteration 4, 2026-07-09): the confirmed fact is specifically about the
 * file being loaded once at conversation start. Whether a REWRITE of this
 * file mid-conversation — which is exactly what every call after the first
 * one is — gets re-read before the conversation ends, or whether rules are
 * snapshotted once like the hook-output channel this replaces, is NOT
 * independently confirmed. See this file's "Known structural limitations"
 * item 4 above.
 *
 * Takes an explicit `path` (default `cursorContextRulePath()`) so callers can
 * target a DIFFERENT rule file instead — see `cursorReminderRulePath()`.
 * Originally this always wrote to the same session-context file regardless
 * of caller, which meant hook-cursor-post-tool.ts's periodic reminder
 * clobbered hook-cursor-session-start.ts's recalled-engram content the
 * moment the first reminder fired (audit fix — Codex adversarial review,
 * 2026-07-08). Each rule file Cursor loads is independent and additive, so
 * giving reminders their own file fixes this without needing to merge or
 * section-split file content.
 */
export function writeContextRule(content: string, path: string = cursorContextRulePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    '---\n' +
    'description: PLUR (auto-generated by plur hooks — do not edit by hand, changes are overwritten)\n' +
    'alwaysApply: true\n' +
    '---\n\n' +
    `${content}\n`,
  )
}
