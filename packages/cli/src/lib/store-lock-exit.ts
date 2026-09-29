import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { hostname } from 'os'
import { pendingStoreLockOps } from '@plur-ai/core'
import { getLastPlurInstance } from '../plur.js'

/**
 * Bounded waits a hook does before it force-exits, so `process.exit()` never
 * lands inside one of this process's own store writes (#1313, #1343).
 *
 * `process.exit()` does not wait for in-flight async work. A hook that exits
 * past a missed hybrid deadline (the abandoned search still records its
 * injection) or on its watchdog timer can be mid-way through taking
 * `engrams.yaml.lock`. Measured on a 10,000-engram store: the exit left an
 * EMPTY lock file in 10 of 12 runs — the O_EXCL open had happened, the token
 * write had not — and core cannot tell who owns an empty lock, so every later
 * writer (the next hook, the MCP server) waits out its 60s stale threshold.
 *
 * A disk check is not enough on its own: see {@link storeIdle}.
 *
 * Every hook that force-exits goes through here: `hook-inject` (after an
 * abandoned hybrid, and on its watchdog) and `runCodexHook`, which is the exit
 * of every Codex and Antigravity hook.
 */

/** The Claude Code hook's bound after an abandoned hybrid (#1313), and the Codex/Antigravity exit's. */
export const EXIT_LOCK_WAIT_MS = 5_000

/**
 * Could this process hold the lock at `lockPath`, by what is on disk?
 *
 * Ours = the token names this host and pid. Empty and fresh = possibly ours,
 * mid-acquire. An empty lock older than 2s belongs to someone else.
 */
function ownLockOnDisk(lockPath: string): boolean {
  try {
    const token = readFileSync(lockPath, 'utf8').trim()
    return token === ''
      ? Date.now() - statSync(lockPath).mtimeMs < 2_000
      : token.startsWith(`${hostname()}:${process.pid}:`)
  } catch {
    return false // no lock file
  }
}

/**
 * Is this process clear of store lock work?
 *
 * The disk alone cannot say so. Between one in-process caller releasing the
 * lock and the next caller's O_EXCL create landing there is no file — yet the
 * create is already issued, and one that lands after `process.exit()` is an
 * empty lock nobody will release. Core's count of lock operations in progress
 * covers that gap; the file check covers a lock file this process owns
 * regardless (review of #1349).
 */
function storeIdle(lockPath: string | null): boolean {
  if (pendingStoreLockOps() > 0) return false
  return lockPath ? !ownLockOnDisk(lockPath) : true
}

/** Wait (bounded) while this process may hold the lock at `lockPath`. */
export async function waitForOwnStoreLock(lockPath: string, maxMs: number): Promise<void> {
  const until = Date.now() + maxMs
  while (Date.now() < until && ownLockOnDisk(lockPath)) {
    await new Promise(r => setTimeout(r, 25))
  }
}

/**
 * The store lock of the store this process opened, or null when it opened
 * none. Hooks build their Plur through `createPlur`, which records it — so no
 * hook has to remember to register its store here.
 */
export function ownStoreLockPath(): string | null {
  try {
    const plur = getLastPlurInstance()
    return plur ? join(plur.storageRoot, 'engrams.yaml.lock') : null
  } catch {
    return null
  }
}

/**
 * Wait (bounded) until this process has no store lock work in flight, then
 * call `exit` — in the SAME synchronous step as the last check, so no lock
 * operation can start between the check and the exit. Returns without calling
 * `exit` only if `exit` itself returns (tests pass a no-op).
 */
export async function exitWhenStoreIdle(
  maxMs: number = EXIT_LOCK_WAIT_MS,
  exit: () => void = () => process.exit(0),
): Promise<void> {
  const until = Date.now() + maxMs
  for (;;) {
    if (storeIdle(ownStoreLockPath()) || Date.now() >= until) {
      exit()
      return
    }
    await new Promise(r => setTimeout(r, 25))
  }
}
