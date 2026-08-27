import { readSync, readFileSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { safeSessionKey } from './session-key.js'

/**
 * Shared stdin-reading and sentinel helpers for the four hook-codex-*
 * commands.
 *
 * Codex's hook contract is close to a straight port of Claude Code's — same
 * nested `{ matcher, hooks: [...] }` config shape, same snake_case stdin
 * payload, same `hookSpecificOutput.additionalContext` on stdout — so this
 * file is deliberately much thinner than its Cursor counterpart. Cursor
 * needed a whole `.mdc`-rewrite channel because `additional_context` from
 * `sessionStart` is dropped by a race in Cursor's composer; Codex delivers
 * it correctly (verified against codex-cli 0.149.1, 2026-08-27: strings
 * emitted from both SessionStart and UserPromptSubmit were read back
 * verbatim by the model in the same turn), so the standard channel is the
 * only channel here.
 *
 * Sentinels live under a Codex-specific directory rather than sharing
 * Claude Code's `~/.plur/sessions/` or the Cursor hooks' tmpdir namespace:
 * a project can legitimately be open in more than one harness at once, and
 * two guards disagreeing about whether a session has started is worse than
 * two guards each nudging once.
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
 * Codex sends `session_id` on every hook event (verified on 0.149.1 across
 * SessionStart, UserPromptSubmit and PreToolUse payloads). `conversation_id`
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
 * pinned down across versions — there is a `non_prefixed_mcp_tool_names`
 * feature flag in 0.149.1, which means the prefixing scheme is something
 * Codex is actively changing — so match on the suffix rather than on any one
 * spelling of the prefix, and accept the bare name for the unprefixed case
 * that flag turns on.
 */
export function isPlurSessionStartTool(toolName: string): boolean {
  if (toolName === 'plur_session_start') return true
  return /(^|[^a-z0-9])plur_session_start$/.test(toolName)
}

const SESSION_DIR = join(tmpdir(), 'plur-codex-sessions')
const STALE_SESSION_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

function ensureDir(): void {
  mkdirSync(SESSION_DIR, { recursive: true })
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
  ensureDir()
  writeFileSync(sentinelPath(sessionId), new Date().toISOString())
  cleanupStaleSessionFiles()
}

export function isSessionStarted(sessionId: string): boolean {
  return existsSync(sentinelPath(sessionId))
}

/**
 * Read-modify-write a small integer counter file. Used for the guard's
 * block count and the learn-nudge cadence. Not atomic — two hooks racing on
 * the same counter can lose an increment, which costs at most one extra
 * nudge and is not worth a lock file.
 */
export function incrementCounter(path: string): number {
  ensureDir()
  let n = 0
  try {
    n = parseInt(readFileSync(path, 'utf8').trim(), 10) || 0
  } catch { /* first increment */ }
  n += 1
  try { writeFileSync(path, String(n)) } catch { /* best effort */ }
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
 *
 * Codex reads the exit code as the hook's verdict, and a non-zero one is not
 * a warning — it DISCARDS the hook's output entirely (`hook: X Failed`), and
 * on PreToolUse an exit code of 2 means BLOCK THE TOOL, with stderr as the
 * blocking reason. So a crash in an unrelated part of the engine does not
 * degrade to "no memory this turn"; it degrades to "every tool call is
 * blocked by a hook that has nothing to say".
 *
 * That is not hypothetical. Verified 2026-08-27: on a machine whose PGLite
 * index was corrupt, `plur status` and every hook exited 1 — PGLite's WASM
 * layer aborts during teardown, long after the hook has already written
 * perfectly good JSON to stdout. Codex reported `SessionStart Failed` and
 * dropped the engrams, with the injected block sitting complete and unread
 * in the discarded output.
 *
 * So: catch everything, report to stderr (never stdout — Codex parses that as
 * the result), flush, and exit 0 explicitly rather than letting a background
 * handle decide the exit code.
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
  if (process.env.PLUR_HOOK_NO_EXIT === '1') {
    process.exitCode = 0
    return
  }
  process.exit(0)
}

const DEADLINE_MISSED = Symbol('plur.hybrid.deadline')

/**
 * Is hybrid injection allowed? Default YES since #1040 was fixed.
 *
 * Hybrid is worth its cost — measured 2026-08-27 on a 5,775-engram store,
 * fresh process per run: ~4.7s vs ~1.6s for BM25, and the injected set
 * diverges from BM25 on ~10% of entries for keyword-rich prompts and ~22% for
 * vague ones ("this keeps breaking in the same way"), which is precisely when
 * the user is leaning on memory rather than supplying the keywords.
 *
 * It shipped switched OFF for one release because loading the ONNX embedder
 * killed the process with SIGABRT (exit 134) during native teardown, after
 * the JS work had finished and `process.exit(0)` had been called — and Codex
 * DISCARDS the output of any hook that exits non-zero, so hybrid produced a
 * correct payload that was then thrown away. That was `@huggingface/transformers`
 * 3.8.1 / onnxruntime-node 1.21; 4.2.0 / 1.24.3 exits 0 with bit-identical
 * embedding vectors. See #1040.
 *
 * `PLUR_CODEX_HYBRID=0` forces BM25 — the escape hatch if a future runtime
 * regresses the same way, or on a machine where the embedder is unavailable
 * and the fallback's wasted attempt is not worth paying for.
 */
export function hybridEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PLUR_CODEX_HYBRID !== '0'
}

/** Soft deadline for the hybrid leg before falling back to BM25. Override for tests/slow machines. */
export const HYBRID_DEADLINE_MS =
  parseInt(process.env.PLUR_CODEX_HYBRID_DEADLINE_MS ?? '', 10) || 8_000

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
 *
 * Why hybrid at all, when the Cursor and Claude Code event hooks are
 * deliberately BM25-only: their comments justify that with "the BGE embedder
 * costs ~20s to load in a cold CLI process". Measured on 2026-08-27 against a
 * 5,775-engram store, fresh node process per run, that is now ~4.7s for the
 * whole hybrid inject versus ~1.6s for BM25 — a ~3s marginal cost, not 20s.
 * The 20s figure predates several rounds of work on the load path and should
 * not be inherited without re-measuring.
 *
 * Why it is worth 3s: on keyword-ish prompts hybrid and BM25 agree on ~90% of
 * the injected set, but on vague, low-keyword prompts ("this keeps breaking in
 * the same way", "what did we agree on") agreement drops to ~78% — exactly the
 * prompts where a user is relying on memory rather than telling you the
 * keywords. The divergence roughly doubles where recall matters most.
 *
 * Why a deadline rather than just calling injectHybrid: 4.7s is this machine
 * and this store. A slower machine, a larger corpus, or a cold model download
 * turns that into a hook Codex kills at its timeout — and a killed hook
 * injects NOTHING, which is strictly worse than BM25 results. The race bounds
 * the worst case at deadline + BM25 (~10s here) while keeping the typical case
 * at hybrid speed. The abandoned hybrid promise is harmless: `runCodexHook`
 * force-exits the process immediately afterwards.
 */
export async function injectWithFallback<O, R>(
  plur: Injectable<O, R>,
  task: string,
  opts: O,
  deadlineMs: number = HYBRID_DEADLINE_MS,
): Promise<InjectOutcome<R>> {
  if (!hybridEnabled()) return { result: await plur.inject(task, opts), mode: 'bm25' }

  let timer: NodeJS.Timeout | undefined
  try {
    const deadline = new Promise<typeof DEADLINE_MISSED>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE_MISSED), deadlineMs)
      timer.unref?.()
    })
    // A sentinel, not null: R is unconstrained, so a legitimate hybrid result
    // could itself be falsy and would otherwise read as a deadline miss.
    const raced = await Promise.race([plur.injectHybrid(task, opts), deadline])
    if (raced !== DEADLINE_MISSED) return { result: raced, mode: 'hybrid' }
    process.stderr.write(
      `[plur] hybrid injection exceeded ${deadlineMs}ms — falling back to BM25 for this turn. ` +
      'Raise PLUR_CODEX_HYBRID_DEADLINE_MS if this is routine on your machine.\n',
    )
  } catch (err: unknown) {
    // A hybrid-specific failure (embedder unavailable, index mid-rebuild) must
    // not cost the turn its memory — BM25 needs neither.
    process.stderr.write(
      `[plur] hybrid injection failed (${(err as Error)?.message ?? 'unknown'}) — using BM25.\n`,
    )
  } finally {
    if (timer) clearTimeout(timer)
  }
  return { result: await plur.inject(task, opts), mode: 'bm25' }
}
