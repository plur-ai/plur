/**
 * Local debug counters.
 *
 * "Why didn't it remember that?" is the question a memory product gets asked
 * most, and these are how it gets answered. Deliberately independent of the memory
 * viewer, so that a host without one still has a human-facing debug surface.
 * Purely in-process — nothing here is ever sent anywhere.
 *
 * @module
 */

/** Observable events, surfaced by `/plur` and `plur_status`. */
export type CounterKey =
  | 'refresh_attempted'
  | 'blocks_written'
  | 'blocks_unchanged'
  | 'engrams_rendered'
  | 'learn_captured'
  | 'compaction_learned'
  | 'errors_swallowed'

const KEYS: readonly CounterKey[] = [
  'refresh_attempted',
  'blocks_written',
  'blocks_unchanged',
  'engrams_rendered',
  'learn_captured',
  'compaction_learned',
  'errors_swallowed',
]

/** Per-process counters. */
export interface Counters {
  bump(key: CounterKey): void
  snapshot(): Record<CounterKey, number>
}

/**
 * Create the counter set, all keys initialised to zero.
 *
 * @returns fresh counters.
 */
export function createCounters(): Counters {
  const values = new Map<CounterKey, number>(KEYS.map(key => [key, 0]))
  return {
    bump(key) {
      values.set(key, (values.get(key) ?? 0) + 1)
    },
    snapshot() {
      return Object.fromEntries(KEYS.map(key => [key, values.get(key) ?? 0])) as Record<CounterKey, number>
    },
  }
}
