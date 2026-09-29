/**
 * Bounded outbox flush for editor hooks (#1269).
 *
 * Team-scoped writes that could not reach their store queue locally (the
 * outbox). Until #1269 they were retried only by MCP `plur_session_start` /
 * `plur_sync` / `plur_outbox` and `plur outbox --flush`, so a user who ended
 * sessions without any of those left engrams on the laptop indefinitely.
 * Session-end and stop hooks now retry too.
 *
 * A hook runs under a harness timeout (docs/runbooks/hook-timeouts.md): the
 * Claude Code SessionEnd hook is installed with 5s, Codex clamps SessionEnd to
 * 3s, Cursor's stop hook has 3s. So this is written to never fail or slow the
 * hook:
 *
 * - **Skipped with no store load** when the store file has no queued write.
 *   Cursor's stop hook fires on every turn; the common case costs one file
 *   read and a substring search.
 * - **Bounded**: `flushOutbox({ timeoutMs })` cuts the in-flight push and
 *   starts nothing further when the budget runs out. A second, outer timer
 *   stops waiting even if the local part (load, merge-back under the store
 *   lock) is what is slow — the hook stops waiting, and the merge-back is left
 *   to finish or be killed by the harness. Nothing local is lost either way
 *   (the store write is atomic); the cost of a kill there is that an entry the
 *   remote already accepted is pushed again next time — the same exposure a
 *   request timeout already carries, and the reason the budget is not applied
 *   to the merge-back itself (see #1248 on the lock wait it sits behind).
 * - **Never throws**: every error is logged to stderr (hook output channels
 *   are advisory) and the entries stay queued.
 *
 * Knobs: `PLUR_HOOK_OUTBOX_FLUSH=0` turns it off; `PLUR_HOOK_OUTBOX_FLUSH_MS`
 * overrides the per-hook budget. Keep an override below the harness budget
 * minus process start, or the harness kills the hook before it reports.
 */
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Plur } from '@plur-ai/core'
// Type-only: the engine is loaded lazily below, so a hook with nothing queued
// never pays the import of @plur-ai/core (Cursor's stop hook fires every turn).
import type { GlobalFlags } from '../plur.js'

/** Default network budget per harness, ms — leaves room for node start-up and
 *  the store load inside each harness's hook timeout. */
export const HOOK_OUTBOX_BUDGET_MS = {
  /** Claude Code SessionEnd, installed with a 5s timeout. */
  claudeSessionEnd: 2_500,
  /** Codex SessionEnd, clamped by Codex to 3s. */
  codexSessionEnd: 1_200,
  /** Cursor stop, installed with a 3s timeout. */
  cursorStop: 1_200,
} as const

/** Extra time the outer timer allows for the local load and merge-back. */
const LOCAL_GRACE_MS = 500

/**
 * Cursor's stop hook fires on EVERY turn. With writes queued behind a dead
 * store, flushing on each one would load the store and spend the budget every
 * turn for no gain, so that hook retries at most once per interval. Session-end
 * hooks fire once and are not throttled.
 */
export const CURSOR_STOP_MIN_INTERVAL_MS = 5 * 60_000

function throttleMarker(root: string, hook: string): string {
  return join(root, 'cache', `${hook}.outbox-flush`)
}

/** True when a flush from this hook ran less than `minIntervalMs` ago. */
function recentlyFlushed(root: string, hook: string, minIntervalMs: number): boolean {
  try {
    return Date.now() - statSync(throttleMarker(root, hook)).mtimeMs < minIntervalMs
  } catch {
    return false
  }
}

function markFlushed(root: string, hook: string): void {
  try {
    mkdirSync(join(root, 'cache'), { recursive: true })
    writeFileSync(throttleMarker(root, hook), new Date().toISOString())
  } catch { /* a missed throttle only costs one extra flush */ }
}

function storeRoot(flags: GlobalFlags): string {
  return flags.path ?? process.env.PLUR_PATH ?? join(homedir(), '.plur')
}

/**
 * Could this store have queued writes? Cheap on purpose: no YAML parse, no
 * engine. A queued write is `structured_data._outbox` inside `engrams.yaml`,
 * so the key's absence proves the outbox is empty. Its presence is only a
 * "maybe" (a retired engram can still carry it) — the flush decides.
 */
export function outboxMayHaveEntries(root: string): boolean {
  const file = join(root, 'engrams.yaml')
  try {
    if (!existsSync(file)) return false
    return readFileSync(file, 'utf8').includes('_outbox')
  } catch {
    return false
  }
}

function budgetFromEnv(fallback: number): number {
  const raw = process.env.PLUR_HOOK_OUTBOX_FLUSH_MS
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export interface HookFlushOutcome {
  ran: boolean
  flushed?: number
  failed?: number
  deferred?: number
  timed_out?: boolean
  error?: string
}

/**
 * Retry queued remote writes within `budgetMs`. Never throws.
 *
 * @param hook - name used in stderr lines, e.g. "hook-session-end".
 * @param plur - reuse an engine the hook already built; otherwise one is built
 *   only after the fast path says there is something to flush.
 * @param minIntervalMs - skip when this hook flushed this store more recently.
 */
export async function flushOutboxForHook(
  flags: GlobalFlags,
  opts: { hook: string; budgetMs: number; plur?: Plur; minIntervalMs?: number },
): Promise<HookFlushOutcome> {
  try {
    if (process.env.PLUR_HOOK_OUTBOX_FLUSH === '0') return { ran: false }
    const root = storeRoot(flags)
    if (!outboxMayHaveEntries(root)) return { ran: false }
    if (opts.minIntervalMs && recentlyFlushed(root, opts.hook, opts.minIntervalMs)) return { ran: false }
    if (opts.minIntervalMs) markFlushed(root, opts.hook)

    const budgetMs = budgetFromEnv(opts.budgetMs)
    const plur = opts.plur ?? (await import('../plur.js')).createPlur(flags)
    const flush = plur.flushOutbox({ timeoutMs: budgetMs })
    // Observed either way, so a rejection after the outer timer won is not an
    // unhandled rejection that takes the process down with a non-zero exit.
    flush.catch(() => {})

    let timer: NodeJS.Timeout | undefined
    const outer = new Promise<'timeout'>(resolve => {
      timer = setTimeout(() => resolve('timeout'), budgetMs + LOCAL_GRACE_MS)
    })
    try {
      const result = await Promise.race([flush, outer])
      if (result === 'timeout') {
        process.stderr.write(
          `[plur] ${opts.hook}: outbox flush still running after ${budgetMs + LOCAL_GRACE_MS}ms — `
          + 'not waiting for it. Queued writes stay queued and retry next time.\n',
        )
        return { ran: true, timed_out: true }
      }
      if (result.flushed > 0 || result.failed > 0 || result.deferred > 0 || result.skipped > 0) {
        process.stderr.write(
          `[plur] ${opts.hook}: outbox — ${result.flushed} delivered, ${result.failed} failed, `
          + `${result.deferred} left for next time, ${result.skipped} skipped (host paused).\n`,
        )
      }
      return { ran: true, flushed: result.flushed, failed: result.failed, deferred: result.deferred }
    } finally {
      if (timer) clearTimeout(timer)
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    process.stderr.write(`[plur] ${opts.hook}: outbox flush failed, writes stay queued: ${message}\n`)
    return { ran: true, error: message }
  }
}
