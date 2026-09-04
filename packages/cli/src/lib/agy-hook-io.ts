import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync, openSync, readSync, closeSync, fstatSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { safeSessionKey } from './session-key.js'

/**
 * Shared helpers for the hook-agy-* commands (Antigravity CLI, `agy`).
 *
 * Antigravity's hook contract is a THIRD shape — not Claude Code/Codex's and
 * not Gemini CLI's (all facts below verified live against agy 1.1.21,
 * 2026-08-27, or taken from the CLI's own bundled reference at
 * `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/hooks.md`,
 * which is the authoritative doc — the public web docs are thinner):
 *
 *   - stdin payloads are camelCase protojson: `conversationId`, `stepIdx`,
 *     `toolCall`, `transcriptPath` — not snake_case.
 *   - Injection is `{"injectSteps":[{"ephemeralMessage": "..."}]}` from
 *     PreInvocation — there is no additionalContext field anywhere.
 *   - PreToolUse verdicts are a FLAT `{decision, reason}` — no
 *     hookSpecificOutput envelope — and unlike Codex, `allow`/`ask`/
 *     `force_ask` are accepted alongside `deny`.
 *   - There are only five events and NO session-start event; PreInvocation
 *     fires before EVERY model invocation (several times per user turn), so
 *     injection has to dedupe per user turn itself — see
 *     `lastUserInput()` / the step marker in hook-agy-pre-invocation.
 *   - Timeouts are seconds (default 30). Exit codes: 0 = parse stdout, 2 =
 *     system block with stderr as reason, anything else = non-fatal warning.
 *   - No trust gate: hooks run on first invocation (verified), unlike Codex.
 *
 * Sentinels live in their own directory, separate from the Claude Code,
 * Cursor and Codex hook families: one project can be open in several
 * harnesses at once, and two guards disagreeing about whether a session
 * started is worse than each nudging once.
 *
 * Generic stdin/exit plumbing (readStdinJson, runCodexHook's exit-0
 * guarantee, injectWithFallback) is imported from codex-hook-io.ts rather
 * than duplicated — the #1034 HarnessAdapter refactor is where that file
 * stops being the accidental home of the shared pieces.
 */

export { readStdinJson, runCodexHook as runAgyHook, injectWithFallback, isPlurSessionStartTool } from './codex-hook-io.js'
import { ensureSessionDir, sessionDirSafeToSweep } from './codex-hook-io.js'

const SESSION_DIR = join(tmpdir(), 'plur-agy-sessions')
const STALE_SESSION_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Create — and vet — the session directory (see ensureSessionDir, where the
 * vetting this adapter pioneered now lives so the Codex and Cursor families
 * get it too — #1060). The stakes are highest HERE because this directory
 * holds RECALLED ENGRAM TEXT (the turn cache), not just timestamps.
 */
function ensureDir(): boolean {
  return ensureSessionDir(SESSION_DIR)
}

/** Test seam — the directory agy sentinels live in. */
export function agySessionDir(): string {
  return SESSION_DIR
}

/**
 * Antigravity sends `conversationId` (camelCase) on every hook event —
 * verified in live PreInvocation and PreToolUse payloads.
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
  return existsSync(agySentinelPath(conversationId))
}

/** Same fail-open contract as codex-hook-io's incrementCounter: an unpersistable counter reports itself as exceeded. */
export function agyIncrementCounter(path: string): number {
  if (!ensureDir()) return Number.MAX_SAFE_INTEGER
  let n = 0
  try {
    n = parseInt(readFileSync(path, 'utf8').trim(), 10) || 0
  } catch { /* first increment */ }
  n += 1
  try {
    writeFileSync(path, String(n), { mode: 0o600 })
  } catch {
    return Number.MAX_SAFE_INTEGER
  }
  return n
}

// ── Per-turn injection cache ────────────────────────────────────────────────

/** Stable identity for a user message's text. 16 hex chars of sha256 is ample for same-vs-different. */
export function agyTextHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export interface AgyTurnCache {
  /** The conversation this cache belongs to — REQUIRED on read (F9). */
  conversationId: string
  step: number
  textHash: string
  message: string
}

/**
 * Read this conversation's turn cache, or null.
 *
 * The conversationId check is load-bearing (data-loss audit F9):
 * safeSessionKey maps every non-[A-Za-z0-9_-] byte to '_', so distinct ids
 * ("conv/42", "conv.42") can collide on the same PATH. The id stored INSIDE
 * the record is exact, so a collision reads as "no cache" instead of
 * injecting another conversation's recalled memory into this one.
 */
export function readAgyTurnCache(conversationId: string): AgyTurnCache | null {
  try {
    const raw = JSON.parse(readFileSync(agyCounterPath(conversationId, 'turncache'), 'utf8')) as Partial<AgyTurnCache>
    if (raw.conversationId !== conversationId) return null
    // Number.isSafeInteger, not typeof: a poisoned step like 1e308 would pin
    // every future step comparison false and freeze the cache on turn one
    // (adversarial audit F4). The textHash tie-break already limits the
    // damage, but a step no real transcript can produce is simply invalid.
    if (typeof raw.step !== 'number' || !Number.isSafeInteger(raw.step) || typeof raw.message !== 'string') return null
    return {
      conversationId,
      step: raw.step,
      textHash: typeof raw.textHash === 'string' ? raw.textHash : '',
      message: raw.message,
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
}

/**
 * The most recent user message in an Antigravity conversation transcript.
 *
 * PreInvocation's stdin payload carries NO prompt text — only counters and
 * paths — so per-prompt recall has to come from the transcript file the
 * payload points at (`transcriptPath`). The file is JSONL; user turns look
 * like (captured live, 2026-08-27):
 *
 *   {"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT",
 *    "status": "DONE", "content": "<USER_REQUEST>\n...actual text...</USER_REQUEST>"}
 *
 * Returns the LAST such entry, with the <USER_REQUEST> wrapper stripped, or
 * null when the file is missing/unreadable/contains no user turn. Callers
 * treat null as "inject the generic session batch, or stay silent" — never
 * as an error: the transcript format is Antigravity's internal file and can
 * change under us, and a hook must degrade, not break.
 */
/**
 * Never read more than this much transcript. A long agentic session's JSONL
 * grows without bound, and the entry we want is by definition near the END —
 * so past the cap, read only the trailing window. A user message larger than
 * 4MB is not a realistic prompt; a 100MB transcript is a realistic session.
 */
const TRANSCRIPT_READ_CAP = 4 * 1024 * 1024

export function lastUserInput(transcriptPath: string): AgyUserInput | null {
  let raw: string
  try {
    const fd = openSync(transcriptPath, 'r')
    try {
      const size = fstatSync(fd).size
      if (size <= TRANSCRIPT_READ_CAP) {
        raw = readFileSync(transcriptPath, 'utf8')
      } else {
        const buf = Buffer.alloc(TRANSCRIPT_READ_CAP)
        const n = readSync(fd, buf, 0, TRANSCRIPT_READ_CAP, size - TRANSCRIPT_READ_CAP)
        // The first line of the window is almost certainly torn; its
        // JSON.parse fails and it is skipped, same as any mid-write line.
        raw = buf.subarray(0, n).toString('utf8')
      }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  let found: AgyUserInput | null = null
  for (const line of raw.split('\n')) {
    if (!line.includes('"USER_INPUT"')) continue // cheap pre-filter before JSON.parse
    try {
      const d = JSON.parse(line) as { type?: string; step_index?: number; content?: string }
      if (d.type !== 'USER_INPUT' || typeof d.content !== 'string') continue
      const text = d.content
        .replace(/^\s*<USER_REQUEST>\s*/i, '')
        .replace(/\s*<\/USER_REQUEST>\s*$/i, '')
        .trim()
      if (text) found = { stepIndex: d.step_index ?? -1, text }
    } catch { /* partial line mid-write — skip */ }
  }
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
