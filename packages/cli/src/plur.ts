import { Plur } from '@plur-ai/core'
import type { OutputOptions } from './output.js'

export interface GlobalFlags extends OutputOptions {
  path?: string
  fast?: boolean
}

/** Parse global flags from argv, return remaining positional args + flags. */
/**
 * Split `--flag=value` into `--flag` and `value` (#986).
 *
 * Every command parses flags as `--name` followed by a separate value, and an
 * argument written as `--name=value` matched nothing and was silently dropped.
 * A tester wrote `learn "..." --license=cc-by-4.0 --domain=ops.test` and got a
 * successful exit with no licence and no domain. The `=` form is what most
 * command-line tools accept, so people reach for it.
 *
 * Splitting here fixes it for every command at once, rather than in each of the
 * forty-odd parsers.
 *
 * Only the first `=` splits, so a value may contain one. Only tokens that look
 * like a long flag are touched, so a positional argument containing `=` and the
 * `--` separator both pass through untouched.
 */
export function expandEqualsFlags(argv: string[]): string[] {
  const out: string[] = []
  let seenSeparator = false
  for (const arg of argv) {
    if (arg === '--') { seenSeparator = true; out.push(arg); continue }
    const m = seenSeparator ? null : /^(--[A-Za-z][A-Za-z0-9-]*)=([\s\S]*)$/.exec(arg)
    if (m) { out.push(m[1], m[2]) } else { out.push(arg) }
  }
  return out
}

export function parseGlobalFlags(rawArgv: string[]): { flags: GlobalFlags; args: string[] } {
  const argv = expandEqualsFlags(rawArgv)
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
export function createPlur(flags: GlobalFlags, options?: { readonly?: boolean }): Plur {
  const path = flags.path || process.env.PLUR_PATH || undefined
  return new Plur({ path, readonly: options?.readonly })
}
