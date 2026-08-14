/**
 * The `/plur` human command.
 *
 * Dispatches without spending a model turn, so a user can check memory health
 * without persuading the model to call `plur_status`.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { Counters } from './counters.js'

/**
 * Register the command.
 *
 * @param ctx - the Cordis context whose scope owns the registration.
 * @param deps - config and counters to report.
 * @returns the disposer, or a no-op when the host exposes no command registry.
 */
export function registerCommands(
  ctx: Context,
  deps: { config: Config; counters: Counters },
): () => void {
  const commands = (ctx as { commands?: { register?: (c: unknown) => () => void } }).commands
  if (typeof commands?.register !== 'function') return () => {}
  return commands.register({
    name: 'plur',
    description: 'PLUR memory status and diagnostics.',
    execute: () => {
      const snapshot = deps.counters.snapshot()
      return [
        `scope: ${deps.config.scope}`,
        `injection: ${deps.config.injectionMode}`,
        `auto-learn: ${deps.config.autoLearn}`,
        ...Object.entries(snapshot).map(([key, value]) => `${key}: ${value}`),
      ].join('\n')
    },
  })
}
