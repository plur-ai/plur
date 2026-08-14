/**
 * Local debug counters.
 *
 * "Why didn't it remember that?" is the question a memory product gets asked
 * most, and these are how it gets answered. Deliberately independent of the Web
 * tab so that cutting the tab never removes the only human-facing debug surface.
 * Purely in-process — nothing here is ever sent anywhere.
 *
 * @module
 */

/** Observable events, surfaced by `/plur`, `plur_status`, and the Web tab. */
export type CounterKey =
  | 'refresh_attempted'
  | 'blocks_written'
  | 'blocks_unchanged'
  | 'engrams_rendered'
  | 'learn_captured'
  | 'errors_swallowed'

const KEYS: readonly CounterKey[] = [
  'refresh_attempted',
  'blocks_written',
  'blocks_unchanged',
  'engrams_rendered',
  'learn_captured',
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
