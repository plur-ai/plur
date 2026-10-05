import { homedir } from 'os'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { cmdExeSpawn } from './command-spawn.js'

/**
 * The command prefix every PLUR hook entry starts with on darwin/linux,
 * given the shim path `plur init` installed. Quoted only when the path
 * contains whitespace, so a path without one stays byte-identical to what
 * earlier versions wrote. Windows never uses this: see `windowsHookCommand`
 * and `claudeHookSpec` (decision H3).
 */
export function hookCommandPrefix(binPath: string): string {
  if (/\s/.test(binPath)) return `"${binPath}"`
  return binPath
}

/** The editors whose hooks are a single command string. */
export type StringHookHost = 'codex' | 'cursor' | 'agy'

/**
 * Decision H3: Windows hook commands never rely on shell quoting, because
 * the editors run them through different shells — Codex through
 * `pwsh -Command`, Cursor reportedly through PowerShell, Antigravity through
 * `cmd /C` with its quotes backslash-escaped — and a quoted path breaks in
 * PowerShell (it is an expression, not a call) and in Antigravity (the
 * escaped quote becomes part of the name).
 *
 * The command is the shim path with forward slashes, unquoted. When the
 * path contains whitespace, its 8.3 short name is used instead
 * (`C:/Users/TESTUS~1/...`), which has none. When no short name is
 * available (8.3 names disabled on the volume), the fallback is `& "<path>"`
 * for the PowerShell editors (Codex, Cursor) and the plain path for
 * Antigravity, for which no quoted form works; `fallback: true` marks it,
 * and `plur doctor` reports it.
 */
export function windowsHookCommand(
  shimPath: string,
  host: StringHookHost,
  shortPath: (p: string) => string | null = resolveShortPath,
): { command: string; fallback: boolean } {
  const fwd = (p: string) => p.replace(/\\/g, '/')
  if (!/\s/.test(shimPath)) return { command: fwd(shimPath), fallback: false }
  const short = shortPath(shimPath)
  if (short && !/\s/.test(short)) return { command: fwd(short), fallback: false }
  if (host === 'agy') return { command: fwd(shimPath), fallback: true }
  return { command: `& "${fwd(shimPath)}"`, fallback: true }
}

/**
 * The Windows 8.3 short form of an existing path, from `cmd`'s `%~s`
 * modifier. Null when it cannot be had: not on Windows, `cmd.exe` missing,
 * or the command failed. The caller also treats a result that still
 * contains whitespace as unavailable (short names disabled on the volume).
 */
export function resolveShortPath(path: string): string | null {
  try {
    // Verbatim arguments: Node's own quoting would backslash-escape the inner
    // quotes, which cmd does not understand.
    const spec = cmdExeSpawn(`for %I in ("${path}") do @echo %~sI`)
    const r = spawnSync(spec.file, spec.args, {
      encoding: 'utf8', timeout: 5000, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const out = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : ''
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * The first Claude Code release with exec-form hooks: anthropics/claude-code
 * CHANGELOG.md, 2.1.139 — "Added hook `args: string[]` field (exec form)
 * that spawns the command directly without a shell". An older Claude Code
 * ignores `args` and would run `node.exe` with no script.
 */
export const CLAUDE_EXEC_FORM_MIN = '2.1.139'

/** The `X.Y.Z` in `claude --version` output, or null. */
export function parseClaudeVersion(output: string): string | null {
  return /(\d+)\.(\d+)\.(\d+)/.exec(output)?.[0] ?? null
}

/**
 * Should Claude Code's hooks on Windows use the exec form? Yes when the
 * installed Claude Code is known to support it (>= CLAUDE_EXEC_FORM_MIN);
 * no when it is known to be older. When the version is unknown (`claude`
 * not on PATH at init time), the unquoted short-path string is preferred,
 * because it runs in every shell Claude Code may use (Git Bash or
 * PowerShell) and in any version; exec form is used only when that string
 * would itself be the fallback (no 8.3 short name).
 */
export function useClaudeExecForm(versionOutput: string | null, stringIsFallback: boolean): boolean {
  const version = versionOutput === null ? null : parseClaudeVersion(versionOutput)
  if (version === null) return stringIsFallback
  const [a, b, c] = version.split('.').map(Number)
  const [x, y, z] = CLAUDE_EXEC_FORM_MIN.split('.').map(Number)
  return a !== x ? a > x : b !== y ? b > y : c >= z
}

/**
 * `claude --version` output, or null when it cannot be had. On Windows the
 * `claude` on PATH may be an npm `.cmd` shim, which Node cannot spawn
 * directly, so it runs through `cmd.exe`.
 */
export function claudeVersionOutput(plat: NodeJS.Platform = process.platform): string | null {
  try {
    const spec = plat === 'win32' ? cmdExeSpawn('claude --version') : { file: 'claude', args: ['--version'], windowsVerbatimArguments: false }
    const r = spawnSync(spec.file, spec.args, { encoding: 'utf8', timeout: 10000, windowsVerbatimArguments: spec.windowsVerbatimArguments, stdio: ['ignore', 'pipe', 'ignore'] })
    return r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim() ? r.stdout : null
  } catch {
    return null
  }
}

/** What `claudeHookSpec` needs to build a Claude Code hook. */
export interface ClaudeHookContext {
  plat: NodeJS.Platform
  /** The darwin/linux command prefix (quoted shim path, or the npx fallback). */
  shellCmd: string
  /** The node binary running init (`process.execPath`). */
  node: string
  /** The CLI's js entry, or null when it could not be resolved. */
  cliEntry: string | null
  /** Windows: use the exec form (default true); see useClaudeExecForm. */
  execForm?: boolean
  /** Windows, when `execForm` is false: the unquoted string prefix (windowsHookCommand). */
  stringCmd?: string
}

/**
 * The launch part of one Claude Code hook (decision H3).
 *
 * darwin/linux: the unchanged shell string, `<shim> <subcommand> [args]`.
 *
 * Windows: the documented exec form — `command` plus `args`, spawned with
 * no shell, so nothing is tokenised or quoted
 * (https://code.claude.com/docs/en/hooks, "exec form and shell form"). The
 * docs require `command` to be a real executable there, not a `.cmd`, and
 * recommend node plus the script path: so `node.exe <CLI js entry>
 * <subcommand>`. Without a js entry (the shim could not be installed), the
 * npx fallback is launched through `cmd.exe`, still in exec form. With
 * `execForm: false` (a Claude Code older than CLAUDE_EXEC_FORM_MIN, or an
 * unknown version with a usable short path) the hook is the unquoted
 * short-path string instead.
 */
export function claudeHookSpec(ctx: ClaudeHookContext, sub: string, ...extra: string[]): { command: string; args?: string[] } {
  if (ctx.plat !== 'win32') return { command: [ctx.shellCmd, sub, ...extra].join(' ') }
  if (ctx.execForm === false && ctx.stringCmd) return { command: [ctx.stringCmd, sub, ...extra].join(' ') }
  if (ctx.cliEntry) return { command: ctx.node, args: [ctx.cliEntry, sub, ...extra] }
  return { command: 'cmd.exe', args: ['/c', ...ctx.shellCmd.split(/\s+/), sub, ...extra] }
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

// BEGIN shared hook matcher — packages/mcp/src/hook-command.ts keeps a
// byte-identical copy of this region (the mcp package cannot import the
// CLI); test/hook-decisions-h2-h3.test.ts fails when they drift.

/**
 * Is this Claude Code hook spec one PLUR wrote? A spec with `args` is the
 * exec form (decision H3): node plus the CLI js entry recorded in
 * `~/.plur/bin/plur-hook.meta.json` (decision F4) followed by a `hook-*`
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
  // Decision F4: only a js entry `plur init` itself recorded in
  // plur-hook.meta.json — not any path that merely ends in
  // `.../cli/dist/index.js`. Every entry PLUR has recorded counts, not only
  // the current one, so hooks an earlier install location wrote are still
  // PLUR's and re-init replaces them (idempotent init).
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
 * The matcher is anchored (decision F4): the WHOLE command must be PLUR's
 * launcher, then a `hook-*` subcommand, then nothing but plain arguments.
 * A chained, piped, redirected or wrapped command (`&&`, `;`, `|`, `>`,
 * backticks, `$(`, a leading `echo`/`nice`/`env`) is the user's, even when
 * it mentions the shim. The one prefix allowed is PowerShell's `& `, which
 * init itself writes (decision H3's no-short-name fallback).
 */

/** A path or argument character: no whitespace, quote or shell metacharacter. */
const PLAIN = '[^\\s"\'`$&;|<>()]'

/**
 * A PLUR hook subcommand — any `hook-*` (decision H2 "prefix"), so a new hook
 * needs no list update — then only plain arguments to the end. Arguments are
 * separated by spaces or tabs only: a newline or CR ends a shell command, so
 * a hook chained on the next line is the user's.
 */
const HOOK_TAIL = `[ \\t]+hook-[a-z0-9][a-z0-9-]*(?:[ \\t]+${PLAIN}+)*[ \\t]*$`

/**
 * The shim's file name: `plur-hook` or `plur-hook.cmd`, or its Windows 8.3
 * alias. On a spaced home with short names (the default on C:), decision H3
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
 * windowsHookCommand), and versions before #1267 wrote it unquoted even with
 * spaces (as does the Antigravity fallback of decision H3). Such a path can
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
 * `npx @plur-ai/cli` fallback) followed by any `hook-*` subcommand (decision
 * H2) and plain arguments only (decision F4). A hook run by any other binary
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

// END shared hook matcher
