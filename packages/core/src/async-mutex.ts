/**
 * In-process async mutexes.
 *
 * A leaf module with no imports, so the locking layer can use these without
 * pulling in a storage adapter's module graph. `storage-pglite.ts` re-exports
 * `AsyncMutex`.
 *
 * `KeyedAsyncMutex` keeps one mutex per key, created on demand and
 * dropped when its queue drains, so a long-lived process that locks thousands
 * of distinct paths does not accumulate a mutex per path forever.
 */

/**
 * Minimal async mutex — serializes async work.
 *
 * Exported for direct testing; also the in-process half of
 * {@link KeyedAsyncMutex}.
 */
export class AsyncMutex {
  private queue: Promise<void> = Promise.resolve()
  /** Number of runs queued or executing. Drives KeyedAsyncMutex eviction. */
  private depth = 0

  /** True when nothing is queued or running. */
  get idle(): boolean {
    return this.depth === 0
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void
    const wait = new Promise<void>((res) => { release = res })
    // Chain, don't replace: the next caller queues after
    // both `prev` AND this run. `wait` only resolves when release() fires in
    // the finally below, so `prev.then(() => wait)` reads in execution order.
    // (The read-then-write of `this.queue` is safe from interleaving — this
    // method body runs synchronously up to the first await.)
    const prev = this.queue
    this.queue = prev.then(() => wait)
    this.depth++
    await prev
    try {
      return await fn()
    } finally {
      this.depth--
      release!()
    }
  }
}

/**
 * A pool of {@link AsyncMutex}, one per key. In-process callers queue here (FIFO, no polling)
 * before contending for the file lock, whose `O_EXCL` retry-with-backoff is fine across
 * processes but fails under normal in-process contention. Idle entries are evicted.
 */
export class KeyedAsyncMutex {
  private mutexes = new Map<string, AsyncMutex>()

  /** Number of keys with work queued or running. Test/diagnostic seam. */
  get size(): number {
    return this.mutexes.size
  }

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(key)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.mutexes.set(key, mutex)
    }
    try {
      return await mutex.run(fn)
    } finally {
      // Drop the entry only when nothing else is waiting on it. Checked after
      // `run` settles, so `idle` reflects this run having already decremented.
      // A racing acquirer that arrived while we held it kept depth > 0 and
      // keeps its own mutex instance, so eviction can never split two waiters
      // across two mutexes.
      if (mutex.idle && this.mutexes.get(key) === mutex) this.mutexes.delete(key)
    }
  }
}
