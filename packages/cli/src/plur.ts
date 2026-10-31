import { Plur, isDirectoryTrusted, folderMapProblem, type ProjectConfig } from '@plur-ai/core'
import { join, resolve } from 'path'
import { homedir } from 'os'
import type { OutputOptions } from './output.js'

export interface GlobalFlags extends OutputOptions {
  path?: string
  fast?: boolean
}

/** Parse global flags from argv, return remaining positional args + flags. */
/**
 * Split `--flag=value` into `--flag` and `value`.
 *
 * Every command parses flags as `--name` followed by a separate value, so an
 * unsplit `--name=value` would match nothing and be silently dropped. Splitting
 * here covers every command at once, rather than each of the parsers.
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
    // `--` ends option parsing. Everything after it
    // is passed to the command verbatim, `--` included so the command can see
    // where values start: a statement such as "--path=/elsewhere …" must never
    // select — or create — a store, and "--json" after `--` is a value.
    if (arg === '--') { args.push(...argv.slice(i)); break }
    if (arg === '--json') { flags.json = true; i++ }
    else if (arg === '--quiet') { flags.quiet = true; i++ }
    else if (arg === '--fast') { flags.fast = true; i++ }
    else if (arg === '--path') {
      // A missing value must not leave --path unset, or the command would
      // silently run against the DEFAULT store instead of the one named.
      const value = argv[i + 1]
      if (value === undefined || /^--[A-Za-z]/.test(value)) {
        error = error ?? `--path needs a directory, but the next argument was ${value ?? '(nothing)'}.`
        i += 1
      } else { flags.path = value; i += 2 }
    }
    else {
      // A near miss on `--path` is caught for EVERY command, whether or not it
      // declares its own flags: a mistyped `--path` would pass through as a
      // positional argument and the command would run against the user's real
      // store. Every other global flag mistyped is merely ignored.
      //
      // ONLY `--path`, and only ONE edit. A wider net rejects legitimate
      // command flags (`--batch` and `--date` are two edits from `--path`).
      // This runs before the command is loaded and cannot consult what it
      // declares, so the distance must be tight enough that no declared flag
      // falls inside it; test/known-flags.test.ts sweeps every flag literal in
      // this package against this check.
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
 * The most recent Plur built in this process.
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
 * `readonly: true` opens a write-guarded engine: reads work, every
 * mutation throws `ReadonlyStoreError`, and recall skips its activation
 * refresh. Read-only commands (`list`, `status`, `tensions` list mode) pass it
 * so lazy engine side-effects cannot mutate the store from a pure query.
 *
 * `autoDiscover: false` skips the constructor's walk for a `<cwd>/.plur`
 * store, which otherwise registers that store in config.yaml. The folder
 * question passes it: asking about a folder must change nothing.
 */
export function createPlur(flags: GlobalFlags, options?: { readonly?: boolean; autoDiscover?: boolean }): Plur {
  const path = flags.path || process.env.PLUR_PATH || undefined
  lastInstance = new Plur({
    path,
    readonly: options?.readonly,
    ...(options?.autoDiscover !== undefined ? { autoDiscover: options.autoDiscover } : {}),
  })
  // Every command is bound to the folder it runs in, so
  // `plur learn`, `recall`, `inject`, `capture`, `import` … obey a remote-only
  // folder exactly as the hooks and the MCP server do. Hooks re-bind to the
  // folder their payload names, failing closed (bindHookFolder).
  //
  // A folder map that cannot be read, or a folder that cannot be resolved,
  // leaves a CLI command unbound: local memory still prints and
  // folderReadContext contacts no store. Binding only looks: it never imports
  // a legacy trust.yaml.
  const cwd = process.cwd()
  try {
    // Checked first, silently: the CLI's own notice about a broken map is
    // folderReadContext's, said once.
    if (folderMapProblem(lastInstance.storageRoot)) return lastInstance
    const policy = lastInstance.resolveFolderPolicy(cwd, { readOnly: true })
    if (policy.reason !== 'malformed-map' && policy.reason !== 'resolver-error') lastInstance.bindFolderPolicy(cwd, policy)
  } catch { /* unbound, as above */ }
  return lastInstance
}


/**
 * The one question the scope gate asks — `Plur` answers it (`plur trust`).
 * `storageRoot` (a `Plur` has it) is the store whose `trust.yaml` answers, so
 * the notice can name a command that writes to THAT store.
 */
export interface ScopeTrustCheck {
  isDirectoryTrusted(dir: string): boolean
  readonly storageRoot?: string
}

/**
 * One argument of a command printed for the user or the agent to run, or null
 * when it cannot be quoted safely. POSIX: single quotes. Windows: double quotes, which
 * PowerShell and cmd still expand for $, backtick, %, ! and the curly double
 * quotes, so a path holding one gets no command. A line break, bidi or
 * zero-width character never gets one.
 */
function shellWord(s: string, platform: NodeJS.Platform = process.platform): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(s)) return null
  if (/^[A-Za-z0-9_@+=:,./~-]+$/.test(s)) return s
  if (platform === 'win32') {
    if (/[$`%!"\u201c\u201d\u201e]/.test(s) || s.endsWith('\\')) return null
    return `"${s}"`
  }
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * The trust command a notice tells the user to run.
 *
 * `plur trust <dir>` writes `trust.yaml` in the store the CLI resolves —
 * `--path`, else `PLUR_PATH`, else `~/.plur`. A hook or server running on a
 * different store (its own `PLUR_PATH`, `--path`, an MCP config's env) checks
 * THAT store's file, and the user's shell usually has none of those set, so
 * the bare command would write a grant the adapter never reads. So when the
 * store is not the default one, the command names it.
 */
export function trustCommand(dir: string | null, storageRoot?: string, platform: NodeJS.Platform = process.platform): string | null {
  const target = dir === null ? '<dir>' : shellWord(dir, platform)
  if (target === null) return null
  if (!storageRoot || resolve(storageRoot) === resolve(join(homedir(), '.plur'))) return `plur trust ${target}`
  const store = shellWord(resolve(storageRoot), platform)
  return store === null ? null : `plur --path ${store} trust ${target}`
}

/**
 * A trust check against the store `flags` select, without constructing a Plur
 * (the hook reminder path runs on every prompt and builds none). Same answer
 * as `Plur.isDirectoryTrusted`: the trust file lives in the store root.
 */
export function storeTrustCheck(flags: GlobalFlags): ScopeTrustCheck {
  const root = flags.path || process.env.PLUR_PATH || join(homedir(), '.plur')
  return { isDirectoryTrusted: (dir: string) => isDirectoryTrusted(dir, root), storageRoot: root }
}
