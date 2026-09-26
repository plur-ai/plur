import { Plur, isDirectoryTrusted, type ProjectConfig } from '@plur-ai/core'
import { join } from 'path'
import { homedir } from 'os'
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
    // `--` ends option parsing (decision S4, 2026-09-26). Everything after it
    // is passed to the command verbatim, `--` included so the command can see
    // where values start: a statement such as "--path=/elsewhere …" must never
    // select — or create — a store, and "--json" after `--` is a value.
    if (arg === '--') { args.push(...argv.slice(i)); break }
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
 * The most recent Plur built in this process (#1046).
 *
 * The CLI entrypoint needs a handle on it to drain background index work
 * before exiting, and commands construct their own instance rather than
 * receiving one. Last-wins is the working assumption: a CLI process runs one
 * command, and the commands that build more than one build them against the
 * same store — `import` with `--store` routes through createPlur precisely
 * so this stays true.
 */
let lastInstance: Plur | null = null

/** The last Plur constructed in this process, or null if none was. */
export function getLastPlurInstance(): Plur | null {
  return lastInstance
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
  lastInstance = new Plur({ path, readonly: options?.readonly })
  return lastInstance
}


/** The one question the scope gate asks — `Plur` answers it (`plur trust`). */
export interface ScopeTrustCheck {
  isDirectoryTrusted(dir: string): boolean
}

/** What a hook may adopt from `.plur.yaml`, and what to tell the user when it may not. */
export interface TrustedProjectScope {
  scope?: string
  domain?: string
  /** Set when a scope/domain was IGNORED: names the file and the trust command. */
  notice?: string
}

/**
 * Adopt a `.plur.yaml` `scope`/`domain` only from a directory the user trusted
 * (decision E3, 2026-09-26): the rule @plur-ai/opencode's `resolveTrustedScope`
 * already followed, now shared by every CLI hook adapter.
 *
 * A cloned repository's `scope: group:acme/eng` was adopted as "a local filter
 * that needs no gate" — and it is not only a filter: the hooks tell the model
 * to learn under it, so a repo could pick the (possibly remote, team) scope an
 * unscoped write lands in. Trust is checked against the directory the FILE
 * lives in (`configDir`, from `resolveProjectRemote`'s single read), and it is
 * hierarchical, so trusting the repo root once covers it. Fails closed: no
 * directory, or a throwing check, means untrusted.
 */
export function trustedProjectScope(
  trust: ScopeTrustCheck,
  config: Pick<ProjectConfig, 'scope' | 'domain'>,
  configDir: string | null,
): TrustedProjectScope {
  if (!config.scope && !config.domain) return {}
  let trusted = false
  try {
    trusted = configDir !== null && trust.isDirectoryTrusted(configDir)
  } catch {
    trusted = false
  }
  if (trusted) return { scope: config.scope, domain: config.domain }
  const file = configDir ? join(configDir, '.plur.yaml') : '.plur.yaml'
  const declared = [
    config.scope ? `scope "${config.scope}"` : null,
    config.domain ? `domain "${config.domain}"` : null,
  ].filter(Boolean).join(' / ')
  return {
    notice:
      `[PLUR] Ignored the ${declared} in ${file} — ${configDir ?? 'its directory'} is not a trusted directory, ` +
      `so the local default scope is used instead. If this project is yours, run: plur trust ${configDir ?? '<dir>'}`,
  }
}

/**
 * A trust check against the store `flags` select, without constructing a Plur
 * (the hook reminder path runs on every prompt and builds none). Same answer
 * as `Plur.isDirectoryTrusted`: the trust file lives in the store root.
 */
export function storeTrustCheck(flags: GlobalFlags): ScopeTrustCheck {
  const root = flags.path || process.env.PLUR_PATH || join(homedir(), '.plur')
  return { isDirectoryTrusted: (dir: string) => isDirectoryTrusted(dir, root) }
}
