/** Shared filesystem lock transitions. Both sync and async callers use this
 * short synchronous operation; waiting and protected work remain caller-owned.
 *
 * Creating, inspecting and reclaiming the data lock all require the guard.
 * Moving a supposedly stale lock before checking its token is unsafe: another
 * contender may already have replaced it with a live lock. The guard removes
 * that pathname race instead of trying to restore a live lock after moving it.
 * A crashed guard fails closed and requires manual removal after stopping its
 * owner. Reclaiming the guard would need another guard and the same proof.
 */
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { hostname } from 'os'

let tokenCounter = 0
export function makeToken(): string {
  return `${hostname()}:${process.pid}:${Date.now()}:${tokenCounter++}`
}

export function holderIsAlive(token: string): boolean | undefined {
  const [host, rawPid] = token.split(':')
  if (host !== hostname()) return undefined
  const pid = Number(rawPid)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  try { process.kill(pid, 0); return true } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false
    return undefined // permission/OS failures are not evidence of death
  }
}

export type LockAttempt = { acquired: true } | { acquired: false; holder: string; retryNow?: boolean }

export function tryFileLock(lockPath: string, token: string, staleThreshold: number): LockAttempt {
  const guard = `${lockPath}.guard`
  let fd: number
  try {
    fd = openSync(guard, 'wx', 0o600)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    return { acquired: false, holder: `transition guard ${guard}; if abandoned, stop its owner before removing it` }
  }
  try {
    writeFileSync(fd, token)
    try {
      writeFileSync(lockPath, token, { flag: 'wx', mode: 0o600 })
      return { acquired: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    let holder: string
    let mtime: number
    try {
      holder = readFileSync(lockPath, 'utf8').trim()
      mtime = statSync(lockPath).mtimeMs
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      return { acquired: false, holder: '', retryNow: true }
    }
    const alive = holderIsAlive(holder)
    // Timestamp expiry is only a compatibility path for legacy malformed
    // tokens. A token with a host/PID must be proved dead on that host.
    const legacy = !holder.includes(':')
    if (alive === false || (legacy && Date.now() - mtime > staleThreshold)) {
      unlinkSync(lockPath)
      return { acquired: false, holder, retryNow: true }
    }
    return { acquired: false, holder }
  } finally {
    try { closeSync(fd) } finally { unlinkSync(guard) }
  }
}

export function releaseFileLock(lockPath: string, token: string): void {
  try {
    // A valid live token cannot be reclaimed, so no cooperating writer can
    // replace this pathname between the comparison and our unlink.
    if (readFileSync(lockPath, 'utf8').trim() === token) unlinkSync(lockPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
