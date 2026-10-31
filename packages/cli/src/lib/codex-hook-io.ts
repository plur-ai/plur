import { readSync, readFileSync, mkdirSync, writeFileSync, existsSync, statSync, lstatSync, chmodSync, readdirSync, unlinkSync, openSync, writeSync, closeSync, constants as fsConstants } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { tmpdir } from 'os'
import { safeSessionKey } from './session-key.js'
import { exitWhenStoreIdle, EXIT_LOCK_WAIT_MS } from './store-lock-exit.js'
import { withDeadline, DEADLINE_MISSED } from '@plur-ai/core'

/**
 * Shared stdin-reading and sentinel helpers for the four hook-codex-* commands.
 * Codex's hook contract mirrors Claude Code's (nested `{ matcher, hooks }`
 * config, snake_case stdin, `hookSpecificOutput.additionalContext`), and Codex
 * delivers that context reliably, so no Cursor-style `.mdc` side channel is needed.
 * Sentinels live in a Codex-specific directory: a project can be open in several
 * harnesses at once, and guards disagreeing about session start is worse than
 * each nudging once.
 */

export function readStdinJson(): Record<string, unknown> {
  try {
    const chunks: Buffer[] = []
    const buf = Buffer.alloc(65536)
    for (;;) {
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
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/**
 * Codex sends `session_id` on every hook event. `conversation_id`
 * is accepted as a fallback purely because Cursor uses that name and the two
 * payloads are otherwise near-identical — cheap insurance against Codex
 * renaming toward the same word, not evidence that it ever sends it.
 */
export function codexSessionId(input: Record<string, unknown>): string {
  const id = String(input.session_id ?? input.conversation_id ?? '')
  if (!id) {
    process.stderr.write(
      '[plur] codex hook: no session_id in hook payload — skipping (memory injection/' +
      'enforcement inactive for this event). Run `plur doctor` if this persists.\n',
    )
  }
  return id
}

/**
 * Codex prefixes MCP tools with the server name. The exact separator is not
 * pinned down across versions — Codex has a `non_prefixed_mcp_tool_names`
 * feature flag — so match on the suffix rather than on any one
 * spelling of the prefix, and accept the bare name for the unprefixed case
 * that flag turns on.
 */
export function isPlurSessionStartTool(toolName: string): boolean {
  if (toolName === 'plur_session_start') return true
  return /(^|[^a-z0-9])plur_session_start$/.test(toolName)
}

const SESSION_DIR = join(tmpdir(), 'plur-codex-sessions')
const STALE_SESSION_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

/**
 * Create and vet a hook-family session directory under os.tmpdir(). Returns
 * false when it cannot be trusted; writers then skip persistence (fail open).
 * On Linux /tmp is world-writable, so refuse:
 * - a pre-planted symlink (mkdirSync accepts symlink-to-dir; lstat and refuse);
 * - a directory owned by another user or world-writable (planted sentinels,
 *   readable session state).
 * The dir is created 0700 and files 0600.
 */
export function ensureSessionDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') {
      const st = lstatSync(dir)
      if (st.isSymbolicLink() || !st.isDirectory()) return false
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
      if ((st.mode & 0o077) !== 0) {
        // Our own dir with loose modes is an existing install (mkdirSync's
        // default 0755), not an attack — refusing it would permanently
        // disable persistence for those users. Tighten in place; refuse only
        // if that fails.
        try { chmodSync(dir, 0o700) } catch { return false }
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * May a stale-file sweep run over this directory? Weaker than
 * ensureSessionDir — it never creates and never chmods, it only refuses to
 * DELETE through a path that is a symlink or belongs to someone else. This
 * is the check that turns cleanupStaleSessionFiles from an
 * arbitrary-file-deletion primitive (pre-plant a symlink, wait seven days)
 * back into a tmp janitor.
 */
export function sessionDirSafeToSweep(dir: string): boolean {
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return false
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
    return true
  } catch {
    return false // missing — nothing to sweep
  }
}

/**
 * May the CONTENTS of this directory be believed? The read-side check
 * (ensureSessionDir guards writers only); without it a planted sentinel could
 * switch the session guard off or a planted cache be emitted as memory.
 * Never creates or chmods. Trusted = a real directory (not a symlink), owned by
 * this user, not group- or other-writable.
 */
export function sessionDirTrusted(dir: string): boolean {
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) return false
    if (process.platform !== 'win32') {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
      if ((st.mode & 0o022) !== 0) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Create-or-overwrite a small state file WITHOUT following a symlink at the
 * final path component (O_NOFOLLOW), mode 0600. For state files that live
 * directly in a shared tmpdir (the Claude Code sentinel), where a planted
 * `plur-session-<id>` symlink would otherwise make writeFileSync truncate
 * whatever it points at. Returns false instead of throwing; callers fail open.
 */
export function writeFileNoFollow(path: string, data: string): boolean {
  let fd: number | undefined
  try {
    const noFollow = (fsConstants as Record<string, number>).O_NOFOLLOW ?? 0
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 0o600)
    if (data) writeSync(fd, data)
    return true
  } catch {
    return false
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* nothing to do */ }
  }
}

/**
 * Does this state file exist AND belong to this user (and is not a symlink)?
 * For the sentinel that lives directly in a shared tmpdir, where any user can
 * create a file of that name.
 */
export function ownFileExists(path: string): boolean {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) return false
    if (process.platform !== 'win32' && typeof process.getuid === 'function' && st.uid !== process.getuid()) return false
    return true
  } catch {
    return false
  }
}

/**
 * A counter that hands every caller a DISTINCT value: each caller appends one
 * line with a unique token (atomic O_APPEND) and its value is the position of
 * ITS OWN line, so values after n appends are exactly 1..n. Append-then-stat
 * would hand two racers the same value. See PlurSpec/R2CLI.lean §4.
 * Throws on I/O failure — callers keep their fail-open handling.
 */
export function ticketCounter(path: string): number {
  const token = `${process.pid}-${randomBytes(6).toString('hex')}`
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o600)
  try {
    writeSync(fd, `${token}\n`)
  } finally {
    closeSync(fd)
  }
  const lines = readFileSync(path, 'utf8').split('\n')
  // endsWith, not ===: a file left by an append-a-dot counter has no
  // trailing newline, so our first line reads '....<token>'. Tokens are
  // random, so a suffix match cannot hit someone else's line.
  const idx = lines.findIndex(l => l.endsWith(token))
  if (idx < 0) throw new Error('counter file lost our append')
  return idx + 1
}

function ensureDir(): boolean {
  return ensureSessionDir(SESSION_DIR)
}

export function sentinelPath(sessionId: string): string {
  return join(SESSION_DIR, `${safeSessionKey(sessionId)}.marker`)
}

/**
 * Path for a named per-session counter file (guard block count, learn-nudge
 * cadence). Built from the sanitized key rather than by string-munging
 * `sentinelPath()`, so it stays correct on Windows path separators.
 */
export function counterPath(sessionId: string, name: string): string {
  return join(SESSION_DIR, `${safeSessionKey(sessionId)}.${name}`)
}

export function markSessionStarted(sessionId: string): void {
  if (!ensureDir()) return // fail open — an unmarkable session costs one extra nudge
  try {
    writeFileSync(sentinelPath(sessionId), new Date().toISOString(), { mode: 0o600 })
  } catch { /* same trade */ }
  cleanupStaleSessionFiles()
}

export function isSessionStarted(sessionId: string): boolean {
  // Read-side vetting: a sentinel in a directory someone else could
  // have written is not evidence that THIS user's session started.
  return sessionDirTrusted(SESSION_DIR) && existsSync(sentinelPath(sessionId))
}

/**
 * Read-modify-write a small integer counter file. Used for the guard's
 * block count and the learn-nudge cadence. Not atomic — two hooks racing on
 * the same counter can lose an increment, which costs at most one extra
 * nudge and is not worth a lock file.
 */
export function incrementCounter(path: string): number {
  if (!ensureDir()) return Number.MAX_SAFE_INTEGER // untrustable dir — same fail-open as an unwritable one
  let n = 0
  try {
    n = parseInt(readFileSync(path, 'utf8').trim(), 10) || 0
  } catch { /* first increment */ }
  n += 1
  try {
    writeFileSync(path, String(n), { mode: 0o600 })
  } catch {
    // A counter that cannot be persisted cannot bound anything: returning 1
    // here would never exceed MAX_BLOCKS_BEFORE_FALLBACK, and the guard would
    // deny every tool call for the rest of the session. Report it as already
    // exceeded so callers fail OPEN (the documented posture for these hooks).
    return Number.MAX_SAFE_INTEGER
  }
  return n
}

/**
 * Delete session marker files older than STALE_SESSION_FILE_MAX_AGE_MS.
 * Mirrors the equivalent cleanup in the Claude Code and Cursor hook
 * families — without it every unique session_id leaves orphaned files in
 * tmpdir forever.
 */
export function cleanupStaleSessionFiles(
  now: number = Date.now(),
  dir: string = SESSION_DIR,
): void {
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

/** Test seam — the directory sentinels live in. */
export function sessionDir(): string {
  return SESSION_DIR
}

/**
 * Emit a Codex hook result carrying model-visible context.
 *
 * `hookEventName` MUST match the firing event or Codex rejects the output
 * ("hook returned invalid <event> JSON output"). Writing nothing at all is
 * always a valid "no opinion" result, so callers with nothing to say should
 * simply not call this.
 */
export function emitContext(hookEventName: string, additionalContext: string): void {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName, additionalContext },
  }))
}

/**
 * Run a Codex hook body and guarantee the process ends with exit code 0.
 * Codex discards output on a non-zero exit, and on PreToolUse exit 2 BLOCKS THE
 * TOOL, so any crash (even a native abort during teardown) must not leak into
 * the exit code. Catch everything, report to stderr (never stdout — Codex parses
 * it), flush, and exit 0 explicitly.
 */
export async function runCodexHook(
  name: string,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body()
  } catch (err: unknown) {
    process.stderr.write(`[plur] ${name} failed: ${(err as Error)?.message ?? 'unknown error'}\n`)
  }
  // Flush before exiting: process.exit() truncates a pipe that has buffered
  // writes pending, which would turn our valid JSON into a parse error —
  // the same failure by a different route.
  await new Promise<void>((resolve) => {
    if (process.stdout.write('')) resolve()
    else process.stdout.once('drain', () => resolve())
  })

  // The force-exit is the whole point of this wrapper, so it cannot be
  // conditional on anything a user's environment might set by accident.
  // Tests, which call run() in-process, would take the whole runner down
  // with it — hence one explicit, purpose-named opt-out rather than
  // sniffing for a test runner.
  //
  // Not while this process may be inside a store write: a missed
  // hybrid deadline leaves that search running, and it records its injection
  // under `engrams.yaml.lock`. Exiting mid-acquire leaves an empty lock that
  // stalls every later writer for 60s. Bounded, and free when the store is idle.
  const noExit = process.env.PLUR_HOOK_NO_EXIT === '1'
  await exitWhenStoreIdle(EXIT_LOCK_WAIT_MS, noExit ? () => { process.exitCode = 0 } : () => process.exit(0))
}


/**
 * Is hybrid injection allowed? Default YES (see injectWithFallback for why
 * it is worth its cost).
 *
 * `PLUR_HOOK_HYBRID=0` forces BM25 — the escape hatch if the native embedder
 * runtime crashes on teardown (Codex DISCARDS the output of any hook that
 * exits non-zero), or on a machine where the embedder is unavailable and the
 * fallback's wasted attempt is not worth paying for. `PLUR_CODEX_HYBRID` is
 * honoured as an alias. "Off" accepts the obvious spellings — an escape hatch
 * someone reaches for mid-incident must not fail on `false` vs `0`.
 */
export function hybridEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PLUR_HOOK_HYBRID ?? env.PLUR_CODEX_HYBRID
  if (raw === undefined) return true
  const v = raw.trim().toLowerCase()
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no')
}

/** Soft deadline for the hybrid leg before falling back to BM25. Override for tests/slow machines. */
export const HYBRID_DEADLINE_MS =
  parseInt(process.env.PLUR_HOOK_HYBRID_DEADLINE_MS ?? process.env.PLUR_CODEX_HYBRID_DEADLINE_MS ?? '', 10) || 8_000

export interface InjectOutcome<R> {
  result: R
  mode: 'hybrid' | 'bm25'
}

/** The two inject entry points this helper races, structurally typed so `Plur` satisfies it. */
export interface Injectable<O, R> {
  inject: (task: string, opts: O) => Promise<R>
  injectHybrid: (task: string, opts: O) => Promise<R>
}

/**
 * Inject with hybrid search, falling back to BM25 if hybrid misses a soft deadline.
 * Hybrid matters most on vague, low-keyword prompts, where it diverges from
 * BM25 most. The deadline exists because Codex kills a hook at its timeout, and
 * a killed hook injects NOTHING; the race bounds the worst case at deadline + BM25.
 * The abandoned hybrid promise is harmless: `runCodexHook` force-exits afterwards.
 */
export async function injectWithFallback<O, R>(
  plur: Injectable<O, R>,
  task: string,
  opts: O,
  deadlineMs: number = HYBRID_DEADLINE_MS,
): Promise<InjectOutcome<R>> {
  if (!hybridEnabled()) return { result: await plur.inject(task, opts), mode: 'bm25' }

  try {
    const raced = await withDeadline(plur.injectHybrid(task, opts), deadlineMs)
    if (raced !== DEADLINE_MISSED) return { result: raced, mode: 'hybrid' }
    process.stderr.write(
      `[plur] hybrid injection exceeded ${deadlineMs}ms — falling back to BM25 for this turn. ` +
      'If this is routine, raise PLUR_HOOK_HYBRID_DEADLINE_MS — and keep it below your ' +
      'harness hook timeout (Codex 25s, Antigravity 20s), or the hook gets killed and injects nothing.\n',
    )
  } catch (err: unknown) {
    // A hybrid-specific failure (embedder unavailable, index mid-rebuild) must
    // not cost the turn its memory — BM25 needs neither.
    process.stderr.write(
      `[plur] hybrid injection failed (${(err as Error)?.message ?? 'unknown'}) — using BM25.\n`,
    )
  }
  return { result: await plur.inject(task, opts), mode: 'bm25' }
}
