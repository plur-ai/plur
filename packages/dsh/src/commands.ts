/**
 * The `/plur` and `/plur-memory` human commands.
 *
 * Dispatch without spending a model turn, so a user can check memory health
 * or read their engrams without persuading the model to call a tool.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.js'
import type { Counters } from './counters.js'
import type { ViewerController } from './viewer.js'

/**
 * Register the command.
 *
 * @param ctx - the Cordis context whose scope owns the registration.
 * @param deps - config and counters to report.
 * @returns the disposer, or a no-op when the host exposes no command registry.
 */
export function registerCommands(
  ctx: Context,
  deps: { config: Config; counters: Counters; viewer?: ViewerController },
): () => void {
  const commands = (ctx as { commands?: { register?: (c: unknown) => () => void } }).commands
  if (typeof commands?.register !== 'function') return () => {}
  const register = commands.register.bind(commands)

  const disposers = [
    register({
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
    }),
    register({
      name: 'plur-memory',
      description: 'Open the PLUR memory viewer in a browser.',
      execute: async () => {
        if (!deps.viewer) return 'The memory viewer is unavailable: PLUR is not installed.'
        try {
          const url = await deps.viewer.open()
          return `PLUR memory viewer: ${url}\n(local to this machine, read-only)`
        } catch (error: unknown) {
          // A viewer that cannot start must report why, not take the host down.
          return `Could not start the memory viewer: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    }),
  ]

  return () => { for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } } }
}
