const level = process.env.PLUR_LOG_LEVEL || 'warning'
const levels: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3 }
const threshold = levels[level] ?? 2

export const logger = {
  debug: (...args: unknown[]) => { if (threshold <= 0) console.error('[plur:debug]', ...args) },
  info: (...args: unknown[]) => { if (threshold <= 1) console.error('[plur:info]', ...args) },
  warning: (...args: unknown[]) => { if (threshold <= 2) console.error('[plur:warning]', ...args) },
  error: (...args: unknown[]) => { if (threshold <= 3) console.error('[plur:error]', ...args) },
}
