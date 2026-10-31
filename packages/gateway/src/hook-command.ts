/**
 * Recognises the Claude Code hook entries PLUR writes, so `plur init` and
 * `plur-mcp init` both detect an existing install instead of adding a second
 * set, and remove only PLUR's own hooks when they rewrite settings.
 *
 * Pure apart from reading `~/.plur/bin/plur-hook.meta.json` (the exec-form
 * check), so tests can import it without loading either bin entry.
 */
import { homedir } from 'os'
import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * The subcommands `plur init` and `plur-mcp init` have written into a Claude
 * Code settings.json. The matcher claims any `hook-*` behind PLUR's launcher,
 * so this is a reference list for tests, not an allow-list.
 */
export const PLUR_SETTINGS_SUBCOMMANDS = [
  'hook-inject',
  'hook-observe',
  'hook-learn-check',
  'hook-session-remind',
  'hook-session-guard',
  'hook-session-mark',
  'hook-session-end',
  'hook-session-resume',
] as const

/**
 * Is this Claude Code hook spec one PLUR wrote? A spec with `args` is the
 * exec form: node plus the CLI js entry recorded in
 * `~/.plur/bin/plur-hook.meta.json` followed by a `hook-*`
 * subcommand, or `cmd.exe /c` plus the npx fallback. A spec without
 * `args` is a shell string, matched by `isPlurHookCommand`.
 */
export function isPlurHookSpec(spec: { command?: string; args?: unknown }): boolean {
  const command = typeof spec.command === 'string' ? spec.command : ''
  const args = Array.isArray(spec.args) ? spec.args.filter((a): a is string => typeof a === 'string') : []
  if (args.length === 0) return isPlurHookCommand(command)
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
  const cmd = norm(command)
  if (/(^|\/)cmd(\.exe)?$/.test(cmd)) return isPlurHookCommand(args.filter((a) => a.toLowerCase() !== '/c').join(' '))
  if (!/(^|\/)node(\.exe)?$/.test(cmd)) return false
  if (!/^hook-[a-z0-9][a-z0-9-]*$/.test(args[1] ?? '')) return false
  // Only a js entry `plur init` itself recorded in plur-hook.meta.json counts,
  // not any path that merely ends in `.../cli/dist/index.js`. Every recorded
  // entry counts, not only the current one, so hooks an earlier install
  // location wrote are still PLUR's and re-init replaces them (idempotent init).
  const target = normEntry(args[0])
  return recordedCliEntries().some((e) => normEntry(e) === target)
}

/** Windows paths compare without regard to slash style, quotes or case. */
function normEntry(p: string): string {
  return p.replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
}

/** The entries a parsed meta file records: `entrypoints`, else the legacy single `entrypoint`. */
function entriesOf(meta: unknown): string[] {
  if (!meta || typeof meta !== 'object') return []
  const m = meta as { entrypoint?: unknown; entrypoints?: unknown }
  if (Array.isArray(m.entrypoints)) return m.entrypoints.filter((e): e is string => typeof e === 'string' && e.length > 0)
  return typeof m.entrypoint === 'string' && m.entrypoint.length > 0 ? [m.entrypoint] : []
}

/** Every CLI js entry `plur init` has recorded next to the hook shim. */
export function recordedCliEntries(): string[] {
  try {
    return entriesOf(JSON.parse(readFileSync(join(homedir(), '.plur', 'bin', 'plur-hook.meta.json'), 'utf8')))
  } catch {
    return []
  }
}

/**
 * The matcher is anchored: the WHOLE command must be PLUR's
 * launcher, then a `hook-*` subcommand, then nothing but plain arguments.
 * A chained, piped, redirected or wrapped command (`&&`, `;`, `|`, `>`,
 * backticks, `$(`, a leading `echo`/`nice`/`env`) is the user's, even when
 * it mentions the shim. The one prefix allowed is PowerShell's `& `, which
 * init itself writes when no short path name is available.
 */

/** A path or argument character: no whitespace, quote or shell metacharacter. */
const PLAIN = '[^\\s"\'`$&;|<>()]'

/**
 * A PLUR hook subcommand — any `hook-*` prefix, so a new hook
 * needs no list update — then only plain arguments to the end. Arguments are
 * separated by spaces or tabs only: a newline or CR ends a shell command, so
 * a hook chained on the next line is the user's.
 */
const HOOK_TAIL = `[ \\t]+hook-[a-z0-9][a-z0-9-]*(?:[ \\t]+${PLAIN}+)*[ \\t]*$`

/**
 * The shim's file name: `plur-hook` or `plur-hook.cmd`, or its Windows 8.3
 * alias. On a spaced home with short names (the default on C:), init
 * writes the short path and the file name is shortened too:
 * `C:/Users/RUNNER~1/.../PLUR~1/bin/PLUR-H~1.CMD`. The alias (`plur-h~<n>.cmd`)
 * is claimed only inside PLUR's own bin directory (`.plur/bin/` or its alias
 * `plur~<n>/bin/`), so another file that shortens to the same name elsewhere
 * stays the user's.
 */
const SHIM_FILE = '(?:plur-hook(?:\\.cmd)?|(?<=/(?:\\.plur|plur~\\d+)/bin/)plur-h~\\d+\\.cmd)'

/**
 * The shim path in the forms any command may use, whoever's machine wrote it:
 *  - unquoted, no whitespace (darwin/linux, and Windows short or space-free paths);
 *  - quoted, any characters but a quote (a path with whitespace).
 * An unquoted path with a space or a shell metacharacter is not in this
 * pattern: it is claimed only when it is this machine's own shim (see
 * `homeShimPaths`).
 */
const SHIM_PATH = [
  `(?:${PLAIN}*/)?${SHIM_FILE}`,
  `"(?:[^"]*/)?${SHIM_FILE}"`,
].join('|')

const SHIM_FORM = new RegExp(`^(?:&[ \\t]+)?(?:${SHIM_PATH})${HOOK_TAIL}`)

/** The `npx [-y] @plur-ai/cli[@version] hook-*` fallback, in every form init wrote. */
const NPX_FORM = new RegExp(`^npx(?:[ \\t]+-y)?[ \\t]+@plur-ai/cli(?:@${PLAIN}+)?${HOOK_TAIL}`)

/** The subcommand and arguments after this home's own shim path. */
const HOME_SHIM_TAIL = new RegExp(`^${HOOK_TAIL}`)

/**
 * This machine's own shim, `<homedir>/.plur/bin/plur-hook` (`.cmd` on
 * Windows), normalised like the command (forward slashes, lower case). Init
 * writes it unquoted whenever it holds no whitespace (hookCommandPrefix,
 * windowsHookCommand), and older installs wrote it unquoted even with
 * spaces (as does the Antigravity fallback). Such a path can
 * hold a space (`C:\Users\John Smith`) or a character PLAIN rejects
 * (`C:\Users\O'Brien`, `a&b`, `x(1)`), so the patterns cannot recognise it.
 * A command is claimed through this path only when it STARTS with it,
 * compared as a literal string (never built into a regex), followed by the
 * hook tail, which still admits no separator or newline. A space alone
 * cannot tell a path from an argument, which is why this is the only way an
 * unquoted spaced path is claimed: `/usr/bin/time ~/.plur/bin/plur-hook
 * hook-x` and `C:/Tools/log.exe %USERPROFILE%/.plur/bin/plur-hook.cmd hook-x`
 * are another binary running the shim. When in doubt the command is the
 * user's: a PLUR hook left unclaimed costs at worst a duplicate entry, a
 * user's hook wrongly claimed is deleted by init.
 */
function homeShimPaths(): string[] {
  const bin = `${homedir().replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')}/.plur/bin/`
  if (/[\r\n]/.test(bin)) return []
  return [`${bin}plur-hook.cmd`, `${bin}plur-hook`]
}

/**
 * The longest command ever claimed. A PLUR hook command is one shim path
 * plus a subcommand and a few short arguments. A path is at most 4096 bytes
 * on Linux (PATH_MAX) and 1024 on macOS, and `cmd.exe`, which runs the
 * Windows string hooks, accepts at most 8191 characters in all. Anything
 * longer is not a hook PLUR wrote, so it is the user's without running the
 * patterns at all — a guard on top of the patterns being linear.
 */
export const MAX_HOOK_COMMAND_LENGTH = 8192

/**
 * Is this hook command one PLUR wrote? The whole command must be PLUR's own
 * launcher (the plur-hook shim in any slash, quote or case form, or the
 * `npx @plur-ai/cli` fallback) followed by any `hook-*` subcommand and plain
 * arguments only. A hook run by any other binary
 * is the user's, whatever its subcommand is called, and so is a look-alike
 * such as `plur-hook-backup.ps1`. A command longer than
 * MAX_HOOK_COMMAND_LENGTH is the user's.
 */
export function isPlurHookCommand(command: string): boolean {
  return command.length <= MAX_HOOK_COMMAND_LENGTH && matchesPlurHookLauncher(command)
}

/**
 * The patterns of `isPlurHookCommand` without the length cap. Exported so
 * the linear-time test can run them on inputs far above the cap: every
 * pattern must stay linear on its own, since the cap may be raised.
 */
export function matchesPlurHookLauncher(command: string): boolean {
  const normalised = command.trim().replace(/\\/g, '/').toLowerCase()
  if (SHIM_FORM.test(normalised) || NPX_FORM.test(normalised)) return true
  return homeShimPaths().some((p) => normalised.startsWith(p) && HOME_SHIM_TAIL.test(normalised.slice(p.length)))
}

/** How many CLI js entries plur-hook.meta.json remembers (most recent kept). */
export const RECORDED_ENTRIES_MAX = 10

/**
 * The `entrypoints` list to write into plur-hook.meta.json when init records
 * `current`: every entry recorded before (a legacy single-entry file becomes
 * a list of one), with `current` moved or appended to the end, trimmed to
 * the RECORDED_ENTRIES_MAX most recent. Only PLUR's own init writes this list,
 * so a foreign checkout is never in it.
 */
export function nextRecordedEntries(previousMeta: unknown, current: string): string[] {
  const kept = entriesOf(previousMeta).filter((e) => normEntry(e) !== normEntry(current))
  return [...kept, current].slice(-RECORDED_ENTRIES_MAX)
}
