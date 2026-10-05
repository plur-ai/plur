import { accessSync, constants, existsSync, readdirSync, statSync } from 'fs'
import { delimiter, join } from 'path'
import { codexHome } from '../mcp-config.js'
import { envGet, findWindowsCommand } from './command-spawn.js'

export interface CodexBinary {
  /** Absolute path of the binary to run. */
  path: string
  /** `path`: found on PATH; `app`: the Codex app's bundled binary. */
  source: 'path' | 'app'
}

function isExecutableFile(p: string): boolean {
  try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true) } catch { return false }
}

/** `[major, minor, patch]` from a release folder name like `0.160.0-x86_64-pc-windows-msvc`. */
function releaseVersion(name: string): number[] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(name)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/**
 * The Codex app's own binary, newest release first by version:
 * `<CODEX_HOME>/packages/app-server-daemon/releases/<ver>-<triple>/bin/codex(.exe)`.
 * It is not on PATH. Null when no release has one.
 */
export function codexAppBinary(env: NodeJS.ProcessEnv = process.env, plat: NodeJS.Platform = process.platform): string | null {
  const releases = join(codexHome(env), 'packages', 'app-server-daemon', 'releases')
  let names: string[]
  try { names = readdirSync(releases) } catch { return null }
  const exe = plat === 'win32' ? 'codex.exe' : 'codex'
  const candidates = names
    .map(name => ({ name, version: releaseVersion(name), bin: join(releases, name, 'bin', exe) }))
    .filter((c): c is { name: string; version: number[]; bin: string } => c.version !== null && existsSync(c.bin))
    .sort((a, b) => b.version[0] - a.version[0] || b.version[1] - a.version[1] || b.version[2] - a.version[2])
  return candidates[0]?.bin ?? null
}

/**
 * Which Codex binary to run (#1603), in order:
 *  1. a `codex` on PATH that this platform can execute — on Windows by PATHEXT
 *     order (`codex.exe`, `codex.cmd`, …), never npm's extensionless sh shim;
 *  2. the Codex app's bundled binary (codexAppBinary), newest release.
 * Null when neither exists.
 */
export function resolveCodexBinary(env: NodeJS.ProcessEnv = process.env, plat: NodeJS.Platform = process.platform): CodexBinary | null {
  if (plat === 'win32') {
    const onPath = findWindowsCommand('codex', env)
    if (onPath) return { path: onPath, source: 'path' }
  } else {
    for (const dir of (envGet(env, 'PATH') ?? '').split(delimiter)) {
      if (dir && isExecutableFile(join(dir, 'codex'))) return { path: join(dir, 'codex'), source: 'path' }
    }
  }
  const app = codexAppBinary(env, plat)
  return app ? { path: app, source: 'app' } : null
}

/** Is Codex installed here: a Codex home folder, or a binary resolveCodexBinary finds. */
export function codexInstalled(env: NodeJS.ProcessEnv = process.env, plat: NodeJS.Platform = process.platform): boolean {
  return existsSync(codexHome(env)) || resolveCodexBinary(env, plat) !== null
}
