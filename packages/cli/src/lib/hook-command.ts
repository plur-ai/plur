import { homedir } from 'os'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

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
    const r = spawnSync('cmd.exe', ['/d', '/s', '/c', `"for %I in ("${path}") do @echo %~sI"`], {
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
    const r = plat === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', '"claude --version"'], { encoding: 'utf8', timeout: 10000, windowsVerbatimArguments: true, stdio: ['ignore', 'pipe', 'ignore'] })
      : spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] })
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

/**
 * Is this Claude Code hook spec one PLUR wrote? A spec with `args` is the
 * exec form (decision H3): node plus PLUR's CLI js entry followed by a
 * `hook-*` subcommand, or `cmd.exe /c` plus the npx fallback. A spec without
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
  const entry = norm(args[0])
  if (entry.endsWith('/@plur-ai/cli/dist/index.js') || entry.endsWith('/packages/cli/dist/index.js')) return true
  const recorded = recordedCliEntry()
  return recorded !== null && norm(recorded) === entry
}

/** The CLI entry `plur init` recorded next to the hook shim, if any. */
function recordedCliEntry(): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(homedir(), '.plur', 'bin', 'plur-hook.meta.json'), 'utf8')) as { entrypoint?: unknown }
    return typeof meta.entrypoint === 'string' ? meta.entrypoint : null
  } catch {
    return null
  }
}

// BEGIN shared hook matcher — packages/mcp/src/hook-command.ts keeps a
// byte-identical copy of this region (the mcp package cannot import the
// CLI); test/hook-decisions-h2-h3.test.ts fails when they drift.

/**
 * A PLUR hook subcommand: any `hook-*` (decision H2 "prefix"), so a new hook
 * needs no list update here. It must be a whole word.
 */
const HOOK_SUBCOMMAND = '(?:hook-[a-z0-9][a-z0-9-]*)(?:\\s|$)'

/**
 * The shim as a whole path segment — `plur-hook` or `plur-hook.cmd`, at the
 * start of the command, after a slash or after an opening quote — optionally
 * closed by a quote, then whitespace and a hook subcommand. The path before
 * it may contain spaces: versions before #1267 wrote it unquoted on Windows.
 *
 * Or its Windows 8.3 alias. On a spaced home with short names (the default on
 * C:), decision H3 writes the short path, and the file name is shortened too:
 * `C:/Users/RUNNER~1/.../PLUR~1/bin/PLUR-H~1.CMD hook-inject`. The alias
 * (`plur-h~<n>.cmd`) is claimed only inside PLUR's own bin directory
 * (`.plur/bin/` or its alias `plur~<n>/bin/`), so another file that happens
 * to shorten to the same name elsewhere stays the user's.
 */
const SHIM_FORM = new RegExp(
  `(?:(?:^|[/"])plur-hook(?:\\.cmd)?|/(?:\\.plur|plur~\\d+)/bin/plur-h~\\d+\\.cmd)"?\\s+${HOOK_SUBCOMMAND}`,
)

/** The `npx @plur-ai/cli[@version] hook-*` fallback, in every form init wrote. */
const NPX_FORM = new RegExp(`(?:^|\\s)@plur-ai/cli(?:@\\S+)?\\s+${HOOK_SUBCOMMAND}`)

/**
 * Is this hook command one PLUR wrote? PLUR's own launcher (the plur-hook
 * shim as a whole path segment, in any slash, quote or case form, or the
 * `npx @plur-ai/cli` fallback) immediately followed by any `hook-*`
 * subcommand (decision H2). A hook run by any other binary is the user's,
 * whatever its subcommand is called, and so is a look-alike such as
 * `plur-hook-backup.ps1`.
 */
export function isPlurHookCommand(command: string): boolean {
  const normalised = command.replace(/\\/g, '/').toLowerCase()
  return SHIM_FORM.test(normalised) || NPX_FORM.test(normalised)
}

// END shared hook matcher
