const levels: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 }

/** Used when `PLUR_LOG_LEVEL` is unset or unrecognised. */
const DEFAULT_THRESHOLD = 2

/**
 * Resolve the threshold PER CALL rather than once at module load.
 *
 * It used to be a module-level `const`, so `PLUR_LOG_LEVEL` was read exactly
 * once — at first import — and could never change afterwards. Two consequences,
 * one of which cost real debugging time:
 *
 *   - A test that raises the level to assert on `logger.info` output gets
 *     nothing, because the threshold was fixed before the test file ran. That
 *     does not fail visibly: the spy stays empty, and an assertion of the form
 *     `expect(output).not.toContain(secret)` PASSES against `''`. An audit
 *     found exactly that — a credential-leak guard that could not have caught
 *     a leak, because the line it inspected was suppressed and it was matching
 *     against an empty string.
 *   - A long-running process cannot raise its own log level to diagnose
 *     something without a restart.
 *
 * The cost is one env read and an object lookup per call, on a path that is
 * already about to write to stderr. Not a trade worth making the other way.
 */
function threshold(): number {
  const level = process.env.PLUR_LOG_LEVEL
  if (!level) return DEFAULT_THRESHOLD
  return levels[level] ?? DEFAULT_THRESHOLD
}

export const logger = {
  debug: (...args: unknown[]) => { if (threshold() <= 0) console.error('[plur:debug]', ...args) },
  info: (...args: unknown[]) => { if (threshold() <= 1) console.error('[plur:info]', ...args) },
  warning: (...args: unknown[]) => { if (threshold() <= 2) console.error('[plur:warning]', ...args) },
  error: (...args: unknown[]) => { if (threshold() <= 3) console.error('[plur:error]', ...args) },
}
