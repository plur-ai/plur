/**
 * Async file-based lock using O_EXCL + async polling (no busy-wait).
 * Replaces the sync withLock() from sync.ts for the async store layer.
 */
import { writeFile, unlink, stat } from 'fs/promises'
import { constants } from 'fs'

export interface AsyncLockOptions {
  maxRetries?: number
  baseDelay?: number
  staleThreshold?: number
}

/** Sleep for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Async file-based exclusive lock using O_EXCL.
 * Retries with exponential backoff (async sleep, not busy-wait).
 */
export async function withAsyncLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options?: AsyncLockOptions,
): Promise<T> {
  const lockPath = filePath + '.lock'
  const maxRetries = options?.maxRetries ?? 5
  const baseDelay = options?.baseDelay ?? 100
  const staleThreshold = options?.staleThreshold ?? 10_000

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await writeFile(lockPath, `${process.pid}`, { flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL })
      break
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err
      // Check for stale lock
      try {
        const s = await stat(lockPath)
        if (Date.now() - s.mtimeMs > staleThreshold) {
          await unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        continue
      }
      if (attempt === maxRetries) {
        throw new Error(`Failed to acquire lock on ${filePath} after ${maxRetries} retries`)
      }
      const delay = baseDelay * Math.pow(2, attempt)
      await sleep(delay)
    }
  }

  try {
    return await fn()
  } finally {
    await unlink(lockPath).catch(() => {})
  }
}
