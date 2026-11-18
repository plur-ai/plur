import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { hostname } from 'os'
import { pendingStoreLockOps } from '@plur-ai/core'
import { getLastPlurInstance } from '../plur.js'

/**
 * Bounded waits before a hook force-exits, so `process.exit()` never lands
 * inside this process's own store write: exiting between the O_EXCL open and
 * the token write leaves an EMPTY `engrams.yaml.lock` that every later writer
 * waits out (60s stale threshold). A disk check alone is not enough (see
 * {@link storeIdle}). Every force-exiting hook uses this: `hook-inject` and
 * `runCodexHook` (all Codex and Antigravity hooks).
 */

/** The Claude Code hook's bound after an abandoned hybrid, and the Codex/Antigravity exit's (ms). */
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
 * regardless.
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
