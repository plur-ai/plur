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
  /** Hard bound in ms; the call resolves `undefined` once it elapses. */
  timeoutMs: number
  /** Observer for the swallowed failure. Its own throw is contained too. */
  onError?: (error: unknown) => void
}

/**
 * Run one PLUR call so it can never fail the host's turn.
 *
 * Resolves `undefined` on ANY failure — a synchronous throw raised before the
 * promise exists, a rejection, or the timeout elapsing. Never rejects. The timer
 * is always cleared, so a fast success leaves nothing pending (an uncleared
 * 5-second timer per turn would keep the event loop alive and delay host exit).
 *
 * @param fn - the call to contain; may throw synchronously or reject.
 * @param opts - timeout bound and optional failure observer.
 * @returns the value, or `undefined` if anything at all went wrong.
 */
export async function guard<T>(
  fn: () => Promise<T> | T,
  opts: GuardOptions,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // A distinct sentinel, not `undefined`: a timeout used to resolve through the
  // SUCCESS path, so it bumped no counter and called no observer. Timeout is
  // the dominant failure mode on a large store — a slow injection on a
  // multi-thousand-engram corpus reaches 5s under ordinary contention — and it
  // was the one failure nothing anywhere recorded. "It forgot and I cannot
  // find out why" is the report that follows.
  const TIMED_OUT = Symbol('timeout')
  try {
    const timeout = new Promise<typeof TIMED_OUT>(resolve => {
      timer = setTimeout(() => resolve(TIMED_OUT), opts.timeoutMs)
    })
    // Promise.resolve().then(fn) also captures a synchronous throw from fn().
    const result = await Promise.race([Promise.resolve().then(fn), timeout])
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

/** Serializes writes so concurrent sessions cannot interleave against one store. */
export type WriteQueue = <T>(fn: () => Promise<T>) => Promise<T | undefined>

/**
 * Serialize writes against the one on-disk PLUR store.
 *
 * Running PLUR in-process means several live dsh sessions share this module, so
 * two auto-learn paths can otherwise read-modify-write the same YAML
 * concurrently — a hazard the subprocess-per-call competitor does not have and
 * that our in-process choice introduces. Each queued call runs to settlement
 * before the next starts; a rejection is contained so it cannot poison the chain
 * or leave an unhandled rejection behind.
 *
 * @returns an enqueue function that resolves `undefined` on failure.
 */
export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    const run = tail.then(async (): Promise<T | undefined> => {
      try {
        return await fn()
      } catch {
        return undefined
      }
    })
    // `run` never rejects, but keep the chain defensive so a future change
    // cannot silently break serialization for every later caller.
    tail = run.catch(() => undefined)
    return run
  }
}
