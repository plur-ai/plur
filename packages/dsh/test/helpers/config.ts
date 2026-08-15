import { Config } from '../../src/config.js'

/**
 * Build a plugin config from a partial.
 *
 * Tests want to say "default config, but `autoLearn` off" without listing all
 * nine fields. Passing a bare object literal to a function typed `Config`
 * type-checks nowhere — and worse, it skips schemastery's defaults, so the code
 * under test sees `undefined` for every field the test did not mention while
 * production sees real values. Going through the real `Config` constructor
 * means the test exercises the same defaults a user gets.
 *
 * @param partial - the fields this test cares about.
 * @returns a fully-populated config.
 */
export function cfg(partial: Partial<Config> = {}): Config {
  // schemastery fills in every `.default()` for omitted fields at runtime, but
  // types `z<Config>`'s constructor as taking a COMPLETE Config. The cast is
  // that gap, in one place rather than at 59 call sites.
  return new Config(partial as Config)
}
