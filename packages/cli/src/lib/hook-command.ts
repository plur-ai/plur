import { spawnSync } from 'child_process'
import { join } from 'path'
import { cmdExeSpawn } from './command-spawn.js'

/**
 * The command prefix every PLUR hook entry starts with on darwin/linux,
 * given the shim path `plur init` installed. Quoted only when the path
 * contains whitespace, so a path without one stays byte-identical to what
 * earlier versions wrote. Windows never uses this: see `windowsHookCommand`
 * and `claudeHookSpec`.
 */
export function hookCommandPrefix(binPath: string): string {
  if (/\s/.test(binPath)) return `"${binPath}"`
  return binPath
}

/** The editors whose hooks are a single command string. */
export type StringHookHost = 'codex' | 'cursor' | 'agy'

/**
 * Windows hook commands never rely on shell quoting, because
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
 * The launch part of one Claude Code hook.
 *
 * darwin/linux: the shell string, `<shim> <subcommand> [args]`.
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

export {
  isPlurHookSpec,
  recordedCliEntries,
  isPlurHookCommand,
  matchesPlurHookLauncher,
  MAX_HOOK_COMMAND_LENGTH,
  PLUR_SETTINGS_SUBCOMMANDS,
  RECORDED_ENTRIES_MAX,
  nextRecordedEntries,
} from '@plur-ai/gateway/harness'
