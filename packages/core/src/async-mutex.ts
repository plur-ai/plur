/**
 * In-process async mutexes.
 *
 * `AsyncMutex` was written for the PGLite adapter (#271) and lived in
 * `storage-pglite.ts`. Convergence Phase 2 needs the same primitive in the
 * locking layer, and `store/async-lock.ts` importing the PGLite adapter to get
 * it would drag the adapter's module graph into every lock acquisition. So the
 * class moves here — a leaf module with no imports — and `storage-pglite.ts`
 * re-exports it unchanged.
 *
 * `KeyedAsyncMutex` is the addition: one mutex per key, created on demand and
 * dropped when its queue drains, so a long-lived process that locks thousands
 * of distinct paths does not accumulate a mutex per path forever.
 */

/**
 * Minimal async mutex — serializes async work.
 *
 * Exported for direct testing (#271); also the in-process half of
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
    // Chain, don't replace (#271, F-DIJK-002): the next caller queues after
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
 * A pool of {@link AsyncMutex}, one per key.
 *
 * Why this exists: a file lock alone does NOT serialize callers inside one
 * process well. `O_EXCL` makes the second caller fail with `EEXIST`, and the
 * only recovery is retry-with-backoff — which under real in-process contention
 * means every writer but one sleeps through an exponential backoff and, past
 * `maxRetries`, throws `Failed to acquire lock`. That is fine as a
 * *cross-process* guard (contention is rare, processes are independent) and
 * wrong as an *in-process* one, where contention is the normal case for a
 * deployment that serves several sessions from one instance.
 *
 * So: queue in-process on a mutex first (FIFO, no polling, no spurious
 * failure), and only then contend for the file lock — by which point this
 * process has exactly one candidate in flight per key.
 *
 * Entries are evicted once idle so the map tracks *live* contention rather
 * than every key ever locked.
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
