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

/** Create Plur instance from flags. */
export function createPlur(flags: GlobalFlags): Plur {
  const path = flags.path || process.env.PLUR_PATH || undefined
  return new Plur({ path })
}
