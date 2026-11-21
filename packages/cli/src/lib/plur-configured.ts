import { existsSync, readFileSync, realpathSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Resolves symlinks so that `process.cwd()` (which the OS resolves canonically
 * via getcwd()) and `homedir()` (which reads the `$HOME` env verbatim) agree
 * even when `/tmp` or another component is a bind-mount or symlink.
 *
 * A copy of `canonicalize` in packages/core/src/project-config.ts, kept here
 * without a core import so the lightweight hooks stay cheap; a parity test
 * holds the two together. `realpathSync.native` folds letter case to
 * the on-disk name on case-insensitive filesystems; a missing path resolves
 * its deepest existing ancestor and re-appends the rest.
 */
export function canonicalize(p: string): string {
  const abs = resolve(p)
  try { return realpathSync.native(abs) } catch {}
  const tail: string[] = []
  let cur = abs
  for (;;) {
    const parent = dirname(cur)
    if (parent === cur) return abs
    tail.unshift(basename(cur))
    cur = parent
    try { return join(realpathSync.native(cur), ...tail) } catch {}
  }
}

/**
 * Detect whether plur is configured for the current project: walks up from
 * `cwd` for a `plur` server entry in `.mcp.json`, `.claude/settings.json`,
 * `.claude/settings.local.json` or `.cursor/mcp.json`, or a `.plur.yaml`.
 * Never falls back to global settings (`plur init --global` puts the server
 * there). Home's configs are read only when cwd === home. Stops at home, the
 * repository root (still checked), or the first match. Hooks gate through
 * lib/folder-gate.ts (core `findPlurMarker`, held to this walk by a parity
 * test); this is the fallback when that resolver fails.
 */
export function isPlurConfigured(
  cwd: string = process.cwd(),
  home: string = homedir(),
): boolean {
  const start = canonicalize(cwd)
  const homeResolved = canonicalize(home)
  let dir = start
  while (true) {
    const atHome = dir === homeResolved
    // At home, only check configs if the walk started here. Home's config files
    // are global settings — reading them during a walk-up from a nested project
    // would make every project look configured for `plur init --global` users.
    if (!atHome || start === homeResolved) {
      if (configHasPlur(join(dir, '.mcp.json'))) return true
      if (configHasPlur(join(dir, '.claude', 'settings.json'))) return true
      if (configHasPlur(join(dir, '.claude', 'settings.local.json'))) return true
      if (configHasPlur(join(dir, '.cursor', 'mcp.json'))) return true
      if (existsSync(join(dir, '.plur.yaml'))) return true
    }
    if (atHome) break  // stop after (optionally) checking home
    // Stop at the repository root, like the `.plur.yaml` lookup: a
    // marker above a cloned repository does not configure it.
    if (existsSync(join(dir, '.git'))) break
    const parent = dirname(dir)
    if (parent === dir) break  // filesystem root
    dir = parent
  }
  // Do NOT fall back to ~/.claude/settings.json or ~/.cursor/mcp.json — that would always
  // return true after `plur init --global`, blocking all non-plur projects.
  return false
}

function configHasPlur(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return false
    const servers = (parsed as { mcpServers?: Record<string, unknown> }).mcpServers
    if (!servers || typeof servers !== 'object') return false
    return Object.prototype.hasOwnProperty.call(servers, 'plur')
  } catch {
    return false
  }
}
