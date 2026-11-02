const levels: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 }

/** Used when `PLUR_LOG_LEVEL` is unset or unrecognised. */
const DEFAULT_THRESHOLD = 2

/**
 * Resolve the threshold per call rather than once at module load, so a change
 * to `PLUR_LOG_LEVEL` takes effect immediately. Tests that raise the level to
 * assert on output depend on this (otherwise the spy stays empty and a
 * `not.toContain(secret)` assertion passes vacuously), and a long-running
 * process can raise its level without a restart. The cost is one env read per
 * call on a path that is already writing to stderr.
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
