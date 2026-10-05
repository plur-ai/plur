import { accessSync, constants, existsSync, readdirSync, statSync } from 'fs'
import { delimiter, join } from 'path'
import { codexHome } from '../mcp-config.js'
import { envGet, findWindowsCommand } from './command-spawn.js'

export interface CodexBinary {
  /** Absolute path of the binary to run. */
  path: string
  /** `path`: found on PATH; `app`: the Codex app's bundled binary (Windows only). */
  source: 'path' | 'app'
}

function isExecutableFile(p: string): boolean {
  try { return statSync(p).isFile() && (accessSync(p, constants.X_OK), true) } catch { return false }
}

/** The target-triple architecture for a Node `process.arch`, or null for one Codex does not ship. */
function tripleArch(arch: string): string | null {
  return arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'aarch64' : null
}

interface Release { core: number[]; pre: string[] | null }

/**
 * A release folder name `<semver>-<arch>-<vendor>-<os>[-<env>]`, e.g.
 * `0.160.0-x86_64-pc-windows-msvc` or `0.161.0-alpha.3-x86_64-pc-windows-msvc`.
 * Null when the version cannot be read or the architecture is not `arch`.
 */
function parseRelease(name: string, arch: string): Release | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+?))?-(x86_64|aarch64|i686|arm64)-/.exec(name)
  if (!m || m[5] !== arch) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : null }
}

/** Semver precedence: core numbers, then a release above its pre-releases, then identifiers (numeric ones numerically). */
function compareRelease(a: Release, b: Release): number {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i]
  if (!a.pre || !b.pre) return (a.pre ? -1 : 0) - (b.pre ? -1 : 0)
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
    if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y)
    if (nx !== ny) return nx ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/**
 * The Codex app's own `codex.exe` on Windows, from the newest release folder
 * built for this machine's architecture:
 * `<CODEX_HOME>/packages/app-server-daemon/releases/<ver>-<triple>/bin/codex.exe`.
 * It is not on PATH. Null elsewhere, or when no release has one.
 */
export function codexAppBinary(
  env: NodeJS.ProcessEnv = process.env,
  plat: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const want = tripleArch(arch)
  if (plat !== 'win32' || !want) return null
  const releases = join(codexHome(env), 'packages', 'app-server-daemon', 'releases')
  let names: string[]
  try { names = readdirSync(releases) } catch { return null }
  let best: { release: Release; bin: string } | null = null
  for (const name of names) {
    const release = parseRelease(name, want)
    const bin = join(releases, name, 'bin', 'codex.exe')
    if (!release || !existsSync(bin)) continue
    if (!best || compareRelease(release, best.release) > 0) best = { release, bin }
  }
  return best?.bin ?? null
}

/**
 * Which Codex binary to run (#1603).
 * Windows: a `codex` on PATH by PATHEXT order (`codex.exe`, `codex.cmd`, …),
 * never npm's extensionless sh shim; else the Codex app's codex.exe
 * (codexAppBinary). darwin/linux: an executable `codex` on PATH, as before.
 * Null when there is none.
 */
export function resolveCodexBinary(
  env: NodeJS.ProcessEnv = process.env,
  plat: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): CodexBinary | null {
  if (plat === 'win32') {
    const onPath = findWindowsCommand('codex', env)
    if (onPath) return { path: onPath, source: 'path' }
    const app = codexAppBinary(env, plat, arch)
    return app ? { path: app, source: 'app' } : null
  }
  for (const dir of (envGet(env, 'PATH') ?? '').split(delimiter)) {
    if (dir && isExecutableFile(join(dir, 'codex'))) return { path: join(dir, 'codex'), source: 'path' }
  }
  return null
}

/**
 * Is Codex installed here (doctor)? Everywhere: the Codex home folder exists.
 * Windows also: a codex init would find (PATH or the Codex app's binary).
 * darwin/linux keep the home-folder check alone (audit M1 on #1604).
 */
export function codexInstalled(
  env: NodeJS.ProcessEnv = process.env,
  plat: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  if (existsSync(codexHome(env))) return true
  return plat === 'win32' && resolveCodexBinary(env, plat, arch) !== null
}

/**
 * The `[mcp_servers.plur]` table for `entry`. A value goes in as a TOML
 * literal string (backslash-safe for Windows paths), or as a JSON-escaped basic
 * string when it holds a `'` or a control character such as a newline.
 */
export function codexTomlSnippet(entry: { command: string; args: string[]; env?: Record<string, string> }): string {
  // eslint-disable-next-line no-control-regex
  const lit = (v: string) => (/['\u0000-\u001f\u007f]/.test(v) ? JSON.stringify(v) : `'${v}'`)
  return [
    '    [mcp_servers.plur]',
    `    command = ${lit(entry.command)}`,
    `    args = [${entry.args.map(lit).join(', ')}]`,
    ...(entry.env && Object.keys(entry.env).length
      ? [`    env = { ${Object.entries(entry.env).map(([k, v]) => `${k} = ${lit(v)}`).join(', ')} }`]
      : []),
  ].join('\n')
}
