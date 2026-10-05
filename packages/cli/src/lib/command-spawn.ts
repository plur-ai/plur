import { statSync } from 'fs'
import { delimiter, join } from 'path'

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
 * extension in order (default `.COM;.EXE;.BAT;.CMD`). Null when nothing
 * matches. Needed because Node only searches for `.exe`/`.com` itself, so an
 * npm-installed `codex.cmd` is ENOENT to `execFileSync('codex')` (#1603).
 */
export function findWindowsCommand(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = (envGet(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  for (const raw of (envGet(env, 'PATH') ?? '').split(delimiter)) {
    const dir = raw.replace(/^"(.*)"$/, '$1')
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (isFile(candidate)) return candidate
    }
  }
  return null
}

/**
 * One argument for a cmd.exe command line that runs a batch file: wrapped in
 * double quotes, so cmd treats `&|<>()^` and spaces in it literally, with
 * trailing backslashes doubled so the quote that follows is not escaped for
 * the program the batch file passes it on to. A double quote or a line break
 * cannot be carried through cmd safely, so it is refused rather than mangled.
 */
function cmdArg(arg: string): string {
  if (/["\r\n]/.test(arg)) throw new Error(`argument cannot be passed through cmd.exe: ${JSON.stringify(arg)}`)
  return `"${arg.replace(/(\\+)$/, '$1$1')}"`
}

/**
 * How to spawn `file` with `args`, without a shell, on this platform.
 *
 * darwin/linux: unchanged. Windows: `file` is looked up on PATH + PATHEXT; a
 * `.exe`/`.com` is spawned directly, and a `.cmd`/`.bat` (npm's shims) runs
 * through `cmd.exe /d /s /c "<quoted line>"` with verbatim arguments — current
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
 * Windows `.cmd`/`.bat` — through `cmd.exe /d /s /c "<quoted line>"`.
 */
export function spawnResolved(
  resolved: string,
  args: string[],
  plat: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (plat !== 'win32' || !/\.(cmd|bat)$/i.test(resolved)) return { file: resolved, args }
  const line = [resolved, ...args].map(cmdArg).join(' ')
  return {
    file: envGet(env, 'COMSPEC') || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    windowsVerbatimArguments: true,
  }
}
