/** What `withDeadline` resolves to when the deadline passes first. */
export const DEADLINE_MISSED: unique symbol = Symbol('plur.deadline.missed')

/**
 * Resolve with `p`'s value, or with DEADLINE_MISSED once `ms` have passed,
 * whichever comes first. A rejection of `p` before the deadline propagates.
 * `p` keeps running after a miss; attach a `.catch` to it if a late rejection
 * must not surface as unhandled.
 *
 * The timer is cleared on settle and is deliberately not unref'd: a caller
 * awaiting this at top level must not see Node exit with the race unsettled.
 * A sentinel rather than undefined, because a legitimate value may be falsy.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | typeof DEADLINE_MISSED> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof DEADLINE_MISSED>(resolve => {
    timer = setTimeout(() => resolve(DEADLINE_MISSED), ms)
  })
  return Promise.race([p, deadline]).finally(() => { if (timer) clearTimeout(timer) })
}
