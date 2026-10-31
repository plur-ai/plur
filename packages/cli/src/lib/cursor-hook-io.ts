import { readSync, mkdirSync, writeFileSync, existsSync, statSync, lstatSync, readFileSync, readdirSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { cursorContextRulePath, cursorReminderRulePath } from '../mcp-config.js'
import { safeSessionKey } from './session-key.js'
import { ensureSessionDir, sessionDirSafeToSweep, sessionDirTrusted, ticketCounter } from './codex-hook-io.js'

/**
 * Shared stdin-reading and sentinel-path helpers for the four hook-cursor-*
 * commands. Split out from any single hook file because all four need the
 * exact same conversation-id resolution and directory layout.
 *
 * Known structural limitations:
 *
 * 1. NO PER-CONVERSATION SCOPING of delivered content. Sentinel/reminder
 *    state IS scoped per `conversation_id`, but the payload lands in
 *    `.cursor/rules/plur-context.mdc` / `plur-reminder.mdc` — one file per
 *    WORKSPACE, loaded into every open composer. Two simultaneous
 *    conversations in the same workspace overwrite what the other sees.
 *    Cursor's rules-file mechanism has no per-conversation channel.
 * 2. conversation_id REUSE is not detected. A sentinel/reminder/stop-count
 *    file is trusted by existence alone; if Cursor reissues an id (a fork
 *    sharing its parent's id, or recycling after a restart), the new
 *    conversation inherits the old one's state.
 * 3. NO COORDINATION with the Claude Code hook family if both act on the
 *    same editor session (Cursor can load Claude Code config too) — two
 *    independent sentinel schemes, two plur.inject() calls, no shared
 *    "already handled this turn" signal.
 * 4. MID-CONVERSATION RULE-FILE REWRITES are not confirmed to be re-read.
 *    Cursor loads `alwaysApply: true` rules at conversation creation; whether
 *    a later rewrite (hook-cursor-post-tool.ts's reminder, a second
 *    hook-cursor-session-start.ts run) is picked up live, or the rules are
 *    snapshotted once, is not established.
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
 * Cursor's hook payload envelope is not fully pinned down (the hooks API is
 * beta): some docs show `conversation_id` as the per-chat identifier, others
 * `session_id`. Accept either so these hooks work whichever Cursor sends.
 */
export function cursorConversationId(input: Record<string, unknown>): string {
  const id = String(input.conversation_id ?? input.session_id ?? '')
  if (!id) {
    // With neither field present, every hook no-ops for the rest of its run.
    // All four hooks resolve the id here, so one stderr line covers them all.
    process.stderr.write(
      '[plur] cursor hook: no conversation_id or session_id in hook payload — ' +
      'skipping (memory injection/enforcement inactive for this event). If this ' +
      'persists, Cursor may be sending a different field name; run `plur doctor`.\n',
    )
  }
  return id
}

/**
 * Is this tool call `plur_session_start`? Shared by hook-cursor-guard.ts and
 * hook-cursor-post-tool.ts: two copies could drift and leave the guard and
 * the sentinel-writer disagreeing about whether a session started.
 */
export function isPlurSessionStartTool(toolName: string): boolean {
  return toolName === 'plur_session_start' || toolName.endsWith('__plur_session_start')
}

const STALE_SESSION_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Delete session marker files older than STALE_SESSION_FILE_MAX_AGE_MS.
 * Mirrors the cleanup of Claude Code's checkpoint files in hook-inject.ts.
 * Without it every conversation_id leaves .marker/.reminded/.stopcount/
 * .guard-count files behind forever — worst on long-lived background-agent
 * VMs. Best-effort: a stat/unlink failure on one file (permissions, a race
 * with another process) must not stop the rest or throw out of a hook that
 * is expected to run in milliseconds.
 */
function pruneStaleSessions(dir: string): void {
  if (!sessionDirSafeToSweep(dir)) return // never delete through a symlink or someone else's dir
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

function cursorDir(): string {
  return join(tmpdir(), 'plur-cursor-sessions')
}

/**
 * Is a sentinel for this conversation present in a directory we can trust?
 * A plain `existsSync(sentinelPath(id))` would let a sentinel planted behind
 * a symlinked or foreign `plur-cursor-sessions` switch the guard off and arm
 * the reminder writer.
 */
export function isSessionStarted(conversationId: string): boolean {
  const dir = sessionsDir()
  return sessionDirTrusted(dir) && existsSync(join(dir, `${safeSessionKey(conversationId)}.marker`))
}

/** Reset the reminder timer — only in a vetted directory, never throws. */
export function touchReminder(conversationId: string): void {
  if (!ensureSessionDir(cursorDir())) return
  try { writeFileSync(lastReminderPath(conversationId), String(Date.now()), { mode: 0o600 }) } catch { /* fail open */ }
}

export function sessionsDir(): string {
  const dir = cursorDir()
  // ensureSessionDir (shared with the Codex/agy families) creates
  // 0700 and vets symlink/ownership/mode; on refusal we still return the
  // path — writers fail open individually — but never prune, because
  // sweeping an untrusted directory is the deletion primitive the vetting
  // exists to close.
  if (ensureSessionDir(dir)) pruneStaleSessions(dir)
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
 * hook-cursor-stop.ts (stop count). A read-increment-write is not atomic
 * across the independent process each hook invocation is, so two close events
 * could both read the same count and lose an increment.
 */
export function incrementCounter(path: string): number {
  // The counter's directory must pass the same vetting as every other
  // writer. Check, never create: every caller's path builder already ran
  // ensureSessionDir.
  if (!sessionDirTrusted(dirname(path))) return Number.MAX_SAFE_INTEGER
  try {
    // A distinct value per caller: append-then-stat would let two racing
    // hooks both read the same size. See ticketCounter.
    return ticketCounter(path)
  } catch {
    // Same fail-open contract as the Codex/agy counters: a counter that
    // cannot be persisted or read cannot bound anything, so report it as
    // already exceeded. Guards fall back to allowing tools; nudge cadences go
    // quiet (no small modulus divides 2^53-1) instead of firing every turn.
    return Number.MAX_SAFE_INTEGER
  }
}

/**
 * Mark a conversation as started: write both the guard's sentinel and reset
 * the reminder timer in one call. Three call sites need this (session-start
 * hook on the normal interactive path; post-tool hook on the explicit
 * plur_session_start path; and the guard's own deadlock-prevention fallback
 * in hook-cursor-guard.ts) and all three must do exactly the same two writes.
 */
export function markSessionStarted(conversationId: string): void {
  // Never write into a refused directory — fail open instead.
  if (!ensureSessionDir(cursorDir())) return
  const now = String(Date.now())
  try {
    writeFileSync(sentinelPath(conversationId), now, { mode: 0o600 })
    writeFileSync(lastReminderPath(conversationId), now, { mode: 0o600 })
  } catch { /* fail open — an unmarkable session costs one extra nudge */ }
}

const CONTEXT_RULE_HEADER = '---\n' +
  'description: PLUR (auto-generated by plur hooks — do not edit by hand, changes are overwritten)\n' +
  'alwaysApply: true\n' +
  '---\n\n'

/** Remove our generated rules when a workspace is off, preserving user files. */
export function removeGeneratedContextRules(dir: string): void {
  try {
    // Never delete through a project-controlled .cursor/ or rules/ symlink.
    for (const p of [join(dir, '.cursor'), join(dir, '.cursor', 'rules')]) {
      if (!lstatSync(p).isDirectory()) return
    }
    for (const p of [cursorContextRulePath(dir), cursorReminderRulePath(dir)]) {
      try {
        if (lstatSync(p).isFile() && readFileSync(p, 'utf8').startsWith(CONTEXT_RULE_HEADER)) unlinkSync(p)
      } catch { /* absent or unreadable: leave it alone */ }
    }
  } catch { /* no rules directory: nothing to remove */ }
}

/**
 * Write recalled engram content to the dynamic context rule file. Cursor
 * drops `additional_context` from both `sessionStart` and `postToolUse` (it
 * "runs async before the composer handle is fully created"), but its rules
 * engine reliably loads `alwaysApply: true` rules AT CONVERSATION CREATION.
 * So this is the PRIMARY delivery mechanism for hook-cursor-session-start.ts
 * and hook-cursor-post-tool.ts; both still emit `additional_context` too,
 * which is harmless and takes effect if Cursor delivers it.
 *
 * Whether a REWRITE of this file mid-conversation is re-read is not
 * confirmed; see limitation 4 in this file's header.
 *
 * Takes an explicit `path` (default `cursorContextRulePath()`) so callers can
 * target a DIFFERENT rule file — see `cursorReminderRulePath()`. Reminders
 * have their own file so they never overwrite the session's recalled
 * engrams; Cursor loads each rule file independently and additively.
 */
export function writeContextRule(content: string, path: string = cursorContextRulePath()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    CONTEXT_RULE_HEADER + `${content}\n`,
  )
}
