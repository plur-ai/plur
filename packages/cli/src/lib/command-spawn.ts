import { statSync } from 'fs'
import { delimiter, extname, join } from 'path'

/** An env var by name, case-insensitively (Windows spells it `Path`). */
export function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name]
  const key = Object.keys(env).find(k => k.toUpperCase() === name)
  return key === undefined ? undefined : env[key]
}

function isFile(p: string): boolean {
  try { return statSync(p).isFile() } catch { return false }
}

/**
 * Where Windows would find `name`: each PATH directory in order, each PATHEXT
 * extension in order (default `.COM;.EXE;.BAT;.CMD`). A name that already has
 * one of those extensions is tried as given first; a name with a path
 * separator is not searched on PATH. Null when nothing matches. Needed because
 * Node only searches for `.exe`/`.com` itself, so an npm-installed `codex.cmd`
 * is ENOENT to `execFileSync('codex')` (#1603).
 */
export function findWindowsCommand(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase())
  const hasExt = exts.includes(extname(name).toLowerCase())
  const candidates = (base: string) => [...(hasExt ? [base] : []), ...exts.map(ext => base + ext)]
  if (/[\\/]/.test(name)) return candidates(name).find(isFile) ?? null
  for (const raw of (envGet(env, 'PATH') ?? '').split(delimiter)) {
    const dir = raw.replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    const found = candidates(join(dir, name)).find(isFile)
    if (found) return found
  }
  return null
}

/**
 * One argument for a cmd.exe command line that runs a batch file: wrapped in
 * double quotes, so cmd treats `&|<>()^` and spaces in it literally, with
 * trailing backslashes doubled so the quote that follows is not escaped for
 * the program the batch file passes it on to. Quotes do not stop `%NAME%`
 * expansion, and a double quote or a line break cannot be carried at all, so
 * an argument with `%`, `"` or a line break is refused rather than changed.
 * (`!NAME!` is safe: the line runs with delayed expansion off, /v:off.)
 */
function cmdArg(arg: string): string {
  if (/["%\r\n]/.test(arg)) throw new Error(`argument cannot be passed through cmd.exe: ${JSON.stringify(arg)}`)
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`
}

/**
 * The one place a `cmd.exe` command line is built: `%COMSPEC%` (else
 * `cmd.exe`) `/d /v:off /s /c "<line>"`, with verbatim arguments so Node adds
 * no quoting of its own. /d skips AutoRun, /v:off turns delayed expansion
 * off, /s strips exactly the outer quotes. The caller owns `line`.
 */
export function cmdExeSpawn(line: string, env: NodeJS.ProcessEnv = process.env): { file: string; args: string[]; windowsVerbatimArguments: true } {
  return {
    file: envGet(env, 'COMSPEC') || 'cmd.exe',
    args: ['/d', '/v:off', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  }
}

/**
 * How to spawn `file` with `args`, without a shell, on this platform.
 *
 * darwin/linux: unchanged. Windows: `file` is looked up on PATH + PATHEXT; a
 * `.exe`/`.com` is spawned directly, and a `.cmd`/`.bat` (npm's shims) runs
 * through `cmd.exe /d /v:off /s /c "<quoted line>"` (cmdExeSpawn) — current
 * Node refuses to spawn a `.cmd` directly (CVE-2024-27980 hardening). Same
 * form as `claudeVersionOutput` in hook-command.ts. When nothing is found, the
 * bare name is returned, so the caller still gets its ENOENT.
 */
export function commandSpawn(
  file: string,
  args: string[],
  plat: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (plat !== 'win32') return { file, args }
  const resolved = findWindowsCommand(file, env)
  if (!resolved) return { file, args }
  return spawnResolved(resolved, args, plat, env)
}

/**
 * How to spawn an already-resolved executable path: directly, or — for a
 * Windows `.cmd`/`.bat` — through cmdExeSpawn.
 */
export function spawnResolved(
  resolved: string,
  args: string[],
  plat: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (plat !== 'win32' || !/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args }
  return cmdExeSpawn([resolved, ...args].map(cmdArg).join(' '), env)
}
