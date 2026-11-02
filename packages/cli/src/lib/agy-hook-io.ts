import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { safeSessionKey } from './session-key.js'

/**
 * Helpers for the hook-agy-* commands (Antigravity CLI); contract per its bundled
 * `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`):
 *   - stdin is camelCase protojson; injection is `{"injectSteps":[{"ephemeralMessage": ...}]}`.
 *   - PreToolUse verdicts are a FLAT `{decision, reason}`; allow/ask/force_ask/deny.
 *   - NO session-start event; PreInvocation fires before EVERY model call, so
 *     injection dedupes per user turn itself (see `lastUserInput()`).
 *   - Timeouts in seconds; exit 0 = parse stdout, 2 = block, else warning. No trust gate.
 * Sentinels live in their own directory, separate from other harnesses' hooks.
 */

export { readStdinJson, runCodexHook as runAgyHook, injectWithFallback, isPlurSessionStartTool } from './codex-hook-io.js'
import { ensureSessionDir, sessionDirSafeToSweep, sessionDirTrusted, ticketCounter } from './codex-hook-io.js'

const SESSION_DIR = join(tmpdir(), 'plur-agy-sessions')
const STALE_SESSION_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Create — and vet — the session directory (see ensureSessionDir). The stakes
 * are highest HERE because this directory holds RECALLED ENGRAM TEXT (the
 * turn cache), not just timestamps.
 */
function ensureDir(): boolean {
  return ensureSessionDir(SESSION_DIR)
}

/** Test seam — the directory agy sentinels live in. */
export function agySessionDir(): string {
  return SESSION_DIR
}

/**
 * Antigravity sends `conversationId` (camelCase) on every hook event.
 */
export function agyConversationId(input: Record<string, unknown>): string {
  const id = String(input.conversationId ?? '')
  if (!id) {
    process.stderr.write(
      '[plur] agy hook: no conversationId in hook payload — skipping (memory ' +
      'injection/enforcement inactive for this event). Run `plur doctor` if this persists.\n',
    )
  }
  return id
}

export function agySentinelPath(conversationId: string): string {
  return join(SESSION_DIR, `${safeSessionKey(conversationId)}.marker`)
}

export function agyCounterPath(conversationId: string, name: string): string {
  return join(SESSION_DIR, `${safeSessionKey(conversationId)}.${name}`)
}

export function agyMarkSessionStarted(conversationId: string): void {
  if (!ensureDir()) return // fail open — an unmarkable session costs one extra nudge
  try {
    writeFileSync(agySentinelPath(conversationId), new Date().toISOString(), { mode: 0o600 })
  } catch { /* same trade */ }
  cleanupStaleAgySessionFiles()
}

export function agyIsSessionStarted(conversationId: string): boolean {
  return sessionDirTrusted(SESSION_DIR) && existsSync(agySentinelPath(conversationId))
}

/**
 * The same counter as codex-hook-io's incrementCounter: `ticketCounter` hands each caller a distinct value, so
 * racing hooks never lose an increment, and an unpersistable counter reports itself as exceeded (fail open).
 */
export function agyIncrementCounter(path: string): number {
  if (!ensureDir()) return Number.MAX_SAFE_INTEGER
  try {
    return ticketCounter(path)
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
}

// ── Per-turn injection cache ────────────────────────────────────────────────

/** Stable identity for a user message's text. 16 hex chars of sha256 is ample for same-vs-different. */
export function agyTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export interface AgyTurnCache {
  /** The conversation this cache belongs to — REQUIRED on read. */
  conversationId: string
  step: number
  textHash: string
  message: string
  /**
   * Byte offset of the turn's USER_INPUT line in the transcript. Optional:
   * older caches lack it.
   */
  offset?: number
  /**
   * The folder mode the message was recalled under: a
   * message cached under another mode is never replayed in a remote-only
   * folder. Optional: older caches lack it.
   */
  mode?: string
  /** The folder's scope when the message was cached. */
  scope?: string
}

/**
 * Read this conversation's turn cache, or null.
 *
 * The conversationId check is load-bearing:
 * safeSessionKey maps every non-[A-Za-z0-9_-] byte to '_', so distinct ids
 * ("conv/42", "conv.42") can collide on the same PATH. The id stored INSIDE
 * the record is exact, so a collision reads as "no cache" instead of
 * injecting another conversation's recalled memory into this one.
 */
export function readAgyTurnCache(conversationId: string): AgyTurnCache | null {
  // Read-side vetting. This file's text is emitted to the model verbatim as
  // "recalled memory", so a cache planted in a symlinked, foreign or
  // group/other-writable directory is prompt injection, not a cache hit.
  // The writer refusing such a directory is not enough on its own.
  if (!sessionDirTrusted(SESSION_DIR)) return null
  try {
    const raw = JSON.parse(readFileSync(agyCounterPath(conversationId, 'turncache'), 'utf8')) as Partial<AgyTurnCache>
    if (raw.conversationId !== conversationId) return null
    // Number.isSafeInteger, not typeof: a poisoned step like 1e308 would pin
    // every future step comparison false and freeze the cache on turn one.
    // The textHash tie-break already limits the
    // damage, but a step no real transcript can produce is simply invalid.
    if (typeof raw.step !== 'number' || !Number.isSafeInteger(raw.step) || typeof raw.message !== 'string') return null
    return {
      conversationId,
      step: raw.step,
      textHash: typeof raw.textHash === 'string' ? raw.textHash : '',
      message: raw.message,
      ...(typeof raw.offset === 'number' && Number.isSafeInteger(raw.offset) ? { offset: raw.offset } : {}),
      ...(typeof raw.mode === 'string' ? { mode: raw.mode } : {}),
      ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
    }
  } catch {
    return null // missing, torn, or corrupt — degrade to a fresh recall
  }
}

export function writeAgyTurnCache(cache: AgyTurnCache): void {
  if (!ensureDir()) return // fail open — the turn re-recalls instead of replaying
  try {
    writeFileSync(agyCounterPath(cache.conversationId, 'turncache'), JSON.stringify(cache), { mode: 0o600 })
  } catch { /* same trade */ }
}

export function cleanupStaleAgySessionFiles(now: number = Date.now(), dir: string = SESSION_DIR): void {
  if (!sessionDirSafeToSweep(dir)) return
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      try {
        if (now - statSync(p).mtimeMs > STALE_SESSION_FILE_MAX_AGE_MS) unlinkSync(p)
      } catch { /* raced with another hook — fine */ }
    }
  } catch { /* dir does not exist yet */ }
}

// ── Transcript access ───────────────────────────────────────────────────────

export interface AgyUserInput {
  stepIndex: number
  text: string
  /**
   * Absolute byte offset of this USER_INPUT line in the transcript. The
   * transcript is append-only JSONL, so a later user message always sits at a
   * larger offset — a turn identity that survives a missing `step_index`
   * (which collapses to -1) and an identical re-sent text (same hash), so
   * "yes" … "yes" are two turns.
   */
  offset: number
  /**
   * True when the WHOLE transcript was read and this is its only user message
   * — i.e. the conversation's genuine first turn, known from the transcript
   * itself rather than from the absence of a cache (which an unusable cache
   * dir makes permanent: every turn would be "first").
   */
  firstInTranscript: boolean
}

/**
 * Never read more than this much transcript. A long agentic session's JSONL
 * grows without bound, and the entry we want is by definition near the END —
 * so past the cap, read only the trailing window. A user message larger than
 * 4MB is not a realistic prompt; a 100MB transcript is a realistic session.
 */
const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024

/**
 * The most recent user message in an Antigravity transcript (`transcriptPath`,
 * JSONL), since PreInvocation's payload carries no prompt text. User turns have
 * `"type": "USER_INPUT"` with content wrapped in `<USER_REQUEST>…</USER_REQUEST>`.
 * Returns the LAST one, unwrapped, or null when missing/unreadable/absent.
 * Callers treat null as "generic batch or silence", never an error: the format
 * is Antigravity-internal, and a hook must degrade, not break.
 */
export function lastUserInput(transcriptPath: string): AgyUserInput | null {
  let raw: Buffer
  let base = 0
  let whole = true
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const size = fstatSync(fd).size
      if (size <= TRANSCRIPT_READ_CAP) {
        raw = readFileSync(transcriptPath)
      } else {
        const buf = Buffer.alloc(TRANSCRIPT_READ_CAP)
        base = size - TRANSCRIPT_READ_CAP
        whole = false
        const n = readSync(fd, buf, 0, TRANSCRIPT_READ_CAP, base)
        // The first line of the window is almost certainly torn; its
        // JSON.parse fails and it is skipped, same as any mid-write line.
        raw = buf.subarray(0, n)
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  let found: AgyUserInput | null = null
  let userTurns = 0
  // Walk lines on the BYTES so each line's offset is exact (a torn UTF-8
  // sequence at the window start cannot shift the offsets after it).
  let start = 0
  while (start < raw.length) {
    let end = raw.indexOf(0x0a, start)
    if (end < 0) end = raw.length
    const lineOffset = base + start
    const line = raw.subarray(start, end).toString('utf8')
    start = end + 1
    if (!line.includes('"USER_INPUT"')) continue // cheap pre-filter before JSON.parse
    try {
      const d = JSON.parse(line) as { type?: string; step_index?: number; content?: string }
      if (d.type !== 'USER_INPUT' || typeof d.content !== 'string') continue
      const text = d.content
        .replace(/^\s*<USER_REQUEST>\s*/i, '')
        .replace(/\s*<\/USER_REQUEST>\s*$/i, '')
        .trim()
      if (text) {
        userTurns++
        found = { stepIndex: d.step_index ?? -1, text, offset: lineOffset, firstInTranscript: false }
      }
    } catch { /* partial line mid-write — skip */ }
  }
  if (found) found.firstInTranscript = whole && userTurns === 1
  return found
}

/**
 * Emit a PreInvocation result injecting one ephemeral system message.
 * Ephemeral messages are transient — shown to the model for this invocation,
 * not persisted as conversation history — which is exactly right for
 * recalled-memory context that the next turn will re-derive anyway.
 */
export function emitInjectSteps(ephemeralMessage: string): void {
  process.stdout.write(JSON.stringify({ injectSteps: [{ ephemeralMessage }] }))
}
