import { Plur } from '@plur-ai/core'
import type { OutputOptions } from './output.js'

export interface GlobalFlags extends OutputOptions {
  path?: string
  fast?: boolean
}

/** Parse global flags from argv, return remaining positional args + flags. */
export function parseGlobalFlags(argv: string[]): { flags: GlobalFlags; args: string[] } {
  const flags: GlobalFlags = {}
  const args: string[] = []
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '--json') { flags.json = true; i++ }
    else if (arg === '--quiet') { flags.quiet = true; i++ }
    else if (arg === '--fast') { flags.fast = true; i++ }
    else if (arg === '--path' && i + 1 < argv.length) { flags.path = argv[i + 1]; i += 2 }
    else { args.push(arg); i++ }
  }
  return { flags, args }
}

/**
 * Create Plur instance from flags.
 *
 * `readonly: true` opens a write-guarded engine (#731): reads work, every
 * mutation throws `ReadonlyStoreError`, and recall skips its activation
 * refresh. Read-only commands (`list`, `status`, `tensions` list mode) pass it
 * so lazy engine side-effects cannot mutate the store from a pure query.
 */
/**
 * The most recent Plur built in this process (#1046).
 *
 * The CLI entrypoint needs a handle on it to drain background index work
 * before exiting, and commands construct their own instance rather than
 * receiving one. Last-wins is right here: a CLI process runs one command, and
 * the commands that build more than one build them against the same store.
 */
let lastInstance: Plur | null = null

/** The last Plur constructed in this process, or null if none was. */
export function getLastPlurInstance(): Plur | null {
  return lastInstance
}

export function createPlur(flags: GlobalFlags, options?: { readonly?: boolean }): Plur {
  const path = flags.path || process.env.PLUR_PATH || undefined
  lastInstance = new Plur({ path, readonly: options?.readonly })
  return lastInstance
}
