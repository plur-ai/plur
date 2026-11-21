/**
 * Containment primitives.
 *
 * This plugin runs inside someone else's coding agent. The governing rule is
 * that a PLUR failure must never fail the host's turn — so every call into
 * `@plur-ai/core`, retrieval AND rendering, goes through {@link guard}.
 *
 * @module
 */

/** Options for one guarded call. */
export interface GuardOptions {
  /**
   * Bound in ms; the call resolves `undefined` once it elapses. `Infinity`
   * means no timer: containment only (see {@link contain}).
   */
  timeoutMs: number
  /** Observer for the swallowed failure. Its own throw is contained too. */
  onError?: (error: unknown) => void
}

/**
 * Run one PLUR call so it can never fail the host's turn: resolves `undefined`
 * on any sync throw, rejection or timeout; never rejects. The timer is always
 * cleared so it cannot keep the event loop alive.
 * @param fn - the call to contain; may throw synchronously or reject.
 * @param opts - timeout bound and optional failure observer.
 * @returns the value, or `undefined` if anything at all went wrong.
 */
export async function guard<T>(
  fn: () => Promise<T> | T,
  opts: GuardOptions,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // A distinct sentinel, not `undefined`, so a timeout goes through the
  // failure path (counter and observer) instead of the success path. Timeout
  // is the dominant failure mode on a large store: a slow injection on a
  // multi-thousand-engram corpus reaches 5s under ordinary contention.
  const TIMED_OUT = Symbol('timeout')
  try {
    // Promise.resolve().then(fn) also captures a synchronous throw from fn().
    const work = Promise.resolve().then(fn)
    // A non-finite bound means "no timer" — setTimeout would coerce Infinity
    // to 1ms, the opposite of what was asked.
    const result = Number.isFinite(opts.timeoutMs)
      ? await Promise.race([work, new Promise<typeof TIMED_OUT>(resolve => {
        timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs)
      })])
      : await work
    if (result === TIMED_OUT) {
      try {
        opts.onError?.(new Error(`PLUR call exceeded ${opts.timeoutMs}ms`))
      } catch {
        // An observer must never escalate a contained failure into a live one.
      }
      return undefined
    }
    return result
  } catch (error: unknown) {
    try {
      opts.onError?.(error)
    } catch {
      // An observer must never escalate a contained failure into a live one.
    }
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Contain a call with no timer: resolves `undefined` on a throw or rejection
 * and reports it to `onError`, but waits for the call however long it takes.
 * For writes inside the write queue, whose slot is bounded by the queue's hard
 * cap rather than by the soft `timeoutMs`.
 */
export function contain<T>(fn: () => Promise<T> | T, onError?: (error: unknown) => void): Promise<T | undefined> {
  return guard(fn, { timeoutMs: Number.POSITIVE_INFINITY, onError })
}

/** Serializes writes so concurrent sessions cannot interleave against one store. */
export type WriteQueue = <T>(fn: () => Promise<T>) => Promise<T | undefined>

/**
 * How long one write may hold the write-queue slot: 60 s. The soft bound
 * (`timeoutMs`) is how long a caller waits; the write keeps running, so
 * releasing then would overlap writes, while holding until settlement lets a
 * hung write wedge the queue. 60 s matches core's `DEFAULT_STALE_THRESHOLD`.
 * A constant on purpose: a smaller value would allow overlapping writes; the
 * plugin uses `max(WRITE_HARD_CAP_MS, timeoutMs)`, so it can only be raised.
 */
export const WRITE_HARD_CAP_MS = 60_000

/** Options for {@link createWriteQueue}. */
export interface WriteQueueOptions {
  /** How long one write may hold the slot before the queue moves on. Default {@link WRITE_HARD_CAP_MS}. */
  hardCapMs?: number
  /** Called when a write is released at the hard cap (still running). Its throw is contained. */
  onRelease?: (hardCapMs: number) => void
}

/**
 * Serialize writes against the one on-disk PLUR store: in-process, several dsh
 * sessions could otherwise read-modify-write the same YAML concurrently. Each
 * call holds the slot until it settles or `hardCapMs` elapses; at the cap the
 * slot is released, `onRelease` is told, and the call resolves `undefined`.
 * Rejections are contained so they cannot poison the chain.
 * @returns an enqueue function that resolves `undefined` on failure or release.
 */
export function createWriteQueue(opts: WriteQueueOptions = {}): WriteQueue {
  const hardCapMs = opts.hardCapMs ?? WRITE_HARD_CAP_MS
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    const run = tail.then(async (): Promise<T | undefined> => {
      const RELEASED = Symbol('released')
      let timer: ReturnType<typeof setTimeout> | undefined
      const work = Promise.resolve().then(fn).catch(() => undefined)
      try {
        const result = await Promise.race([work, new Promise<typeof RELEASED>(resolve => {
          timer = setTimeout(() => resolve(RELEASED), hardCapMs)
          // A hung write must not keep the host process alive.
          ;(timer as { unref?: () => void }).unref?.()
        })])
        if (result === RELEASED) {
          try { opts.onRelease?.(hardCapMs) } catch { /* contained */ }
          return undefined
        }
        return result
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    })
    // `run` never rejects, but keep the chain defensive so a future change
    // cannot silently break serialization for every later caller.
    tail = run.catch(() => undefined)
    return run
  }
}

/**
 * Can `plur` actually perform the write `method`?
 *
 * The engine facade (engine.ts) deliberately resolves a write to a no-op when
 * core cannot load — pinned by engine.test.ts, so a missing engine never
 * rejects into the host. That makes "the call resolved" useless as "the write
 * happened": a write tool would report "Stored." and auto-learn would count a
 * capture with no engine at all. Ask instead: the method exists AND, when the
 * client can say so (`ready()`), the engine is loaded. An injected client
 * without `ready()` is trusted.
 */
export async function writable(plur: unknown, method: string): Promise<boolean> {
  const p = plur as Record<string, unknown> | null | undefined
  if (typeof p?.[method] !== 'function') return false
  const ready = p.ready
  if (typeof ready !== 'function') return true
  try {
    return (await (ready as () => Promise<unknown>).call(p)) === true
  } catch {
    return false
  }
}
