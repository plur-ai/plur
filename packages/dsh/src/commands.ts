/**
 * The `/plur` and `/plur-memory` human commands.
 *
 * Dispatch without spending a model turn, so a user can check memory health or
 * read their engrams without persuading the model to call a tool.
 *
 * The host contract is `CommandDefinition` from `@deepseek-ai/dsh-commands`:
 * the executable field is **`handler`**, and it returns a `CommandResult` — a
 * union discriminated on `kind`, not a bare string. An earlier version passed
 * `execute` returning a string. Registration threw
 * ("command 'plur' handler must be a function"), Cordis contained the throw
 * inside the injected child fiber, and BOTH commands silently failed to
 * register on every install. Nothing surfaced it, because the only tests were
 * against a `{ register: () => () => {} }` double that accepted anything.
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandDefinition, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Config } from './config.js'
import type { Counters } from './counters.js'
import type { ViewerController } from './viewer.js'

/** The registry slice we use, structurally, so a host without it is fine. */
interface CommandRegistryLike {
  register?: (definition: CommandDefinition) => () => void
}

/** How the scope is described when it is derived rather than configured. */
const DERIVED_SCOPE = 'derived per workspace (.plur.yaml, else project:<dir>)'

/**
 * Register the commands.
 *
 * @param ctx - the Cordis context whose scope owns the registration.
 * @param deps - config, counters, and the viewer controller.
 * @returns a disposer for every command registered.
 */
export function registerCommands(
  ctx: Context,
  deps: { config: Config; counters: Counters; viewer?: ViewerController },
): () => void {
  const commands = (ctx as { commands?: CommandRegistryLike }).commands
  if (typeof commands?.register !== 'function') return () => {}
  const register = commands.register.bind(commands)

  const definitions: CommandDefinition[] = [
    {
      name: 'plur',
      description: 'PLUR memory status and diagnostics.',
      handler: (): CommandResult => {
        const snapshot = deps.counters.snapshot()
        return {
          kind: 'success',
          text: [
            // NOT config.scope alone: it is unset in the default configuration,
            // because the scope is derived per workspace. Printing it rendered
            // the literal "scope: undefined" on the one surface someone checks
            // when memory looks wrong.
            `scope: ${deps.config.scope ?? DERIVED_SCOPE}`,
            `injection: ${deps.config.injectionMode}`,
            `auto-learn: ${deps.config.autoLearn}`,
            ...Object.entries(snapshot).map(([key, value]) => `${key}: ${value}`),
          ].join('\n'),
        }
      },
    },
  ]

  if (deps.config.viewerEnabled !== false) {
    definitions.push({
      name: 'plur-memory',
      description: 'Open the PLUR memory viewer in a browser.',
      handler: async (): Promise<CommandResult> => {
        if (!deps.viewer) {
          return { kind: 'error', text: 'The memory viewer is unavailable: PLUR is not installed.' }
        }
        try {
          const url = await deps.viewer.open()
          return { kind: 'success', text: `PLUR memory viewer: ${url}\n(local to this machine, read-only)` }
        } catch (error: unknown) {
          // A viewer that cannot start reports why. It must settle as a result,
          // never throw: the host records a thrown handler as kind:'error' but
          // the user gets no reason.
          return {
            kind: 'error',
            text: `Could not start the memory viewer: ${error instanceof Error ? error.message : String(error)}`,
          }
        }
      },
    })
  }

  const disposers: Array<() => void> = []
  for (const definition of definitions) {
    // Registered one at a time: an unwrapped throw on the first entry used to
    // abandon the rest of the array, so one bad definition took out every
    // command rather than only itself.
    try {
      disposers.push(register(definition))
    } catch {
      // A host that rejects one command must not stop the others mounting.
    }
  }
  return () => { for (const dispose of disposers) { try { dispose() } catch { /* already gone */ } } }
}
