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

/** Long flags every command understands. */
const GLOBAL_NAMES = ['--json', '--quiet', '--fast', '--path', '--help', '--version']

/** Edit distance, for catching a near miss like `--pathh`. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)))
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1])
    }
  }
  return rows[a.length][b.length]
}

export function parseGlobalFlags(rawArgv: string[]): {
  flags: GlobalFlags; args: string[]; error?: string
} {
  const argv = expandEqualsFlags(rawArgv)
  const flags: GlobalFlags = {}
  const args: string[] = []
  let error: string | undefined
  let i = 0
  while (i < argv.length) {
    const arg = argv[i]
    if (arg === '--json') { flags.json = true; i++ }
    else if (arg === '--quiet') { flags.quiet = true; i++ }
    else if (arg === '--fast') { flags.fast = true; i++ }
    else if (arg === '--path') {
      // A missing value used to leave --path unset, so the command silently ran
      // against the DEFAULT store instead of the one the operator named. That
      // is the only defect here that writes outside the directory they asked
      // for, and it happens on a typo.
      const value = argv[i + 1]
      if (value === undefined || /^--[A-Za-z]/.test(value)) {
        error = error ?? `--path needs a directory, but the next argument was ${value ?? '(nothing)'}.`
        i += 1
      } else { flags.path = value; i += 2 }
    }
    else {
      // A near miss on a global flag is caught for EVERY command, whether or
      // not that command declares its own flags. `--pathh` was passed through
      // as a positional argument and the command then ran against the user's
      // real store — silently, with a success exit.
      // ONLY `--path`, and only a single typo. A wider net produces false
      // positives on legitimate command flags — `--session` is two edits from
      // `--version` and was rejected outright — and this check exists for one
      // specific harm: a mistyped `--path` is passed through as a positional
      // argument, `--path` is never set, and the command runs against the
      // user's real store. Every other global flag mistyped is merely ignored.
      //
      // "A single typo" means ONE edit. At two, `--batch` (feedback) and
      // `--date` (restore) were both rejected as misspellings of `--path`, so a
      // real flag on a real command could not be used at all. This runs before
      // the command is loaded and cannot consult what it declares, so the
      // distance has to be tight enough that no declared flag falls inside it;
      // test/known-flags.test.ts sweeps every flag literal in this package
      // against this check.
      if (/^--[A-Za-z]/.test(arg) && !GLOBAL_NAMES.includes(arg) && editDistance(arg, '--path') <= 1) {
        error = error ?? `Unrecognised flag ${arg} — did you mean --path? `
          + 'Left as it is, this command would run against your default store rather than the one you named.'
      }
      args.push(arg); i++
    }
  }
  return { flags, args, error }
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
