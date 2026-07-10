import { existsSync, readFileSync, realpathSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'

// Resolves symlinks so that `process.cwd()` (which the OS resolves canonically
// via getcwd()) and `homedir()` (which reads the `$HOME` env verbatim) agree
// even when `/tmp` or another component is a bind-mount or symlink (#521).
function canonicalize(p: string): string {
  try { return realpathSync(p) } catch { return resolve(p) }
}

/**
 * Detect whether plur is configured for the current project.
 *
 * Walks up from `cwd` looking for a project-level plur marker:
 *   - `.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`, or `.cursor/mcp.json`
 *     with a `plur` server entry
 *   - `.plur.yaml` (project config — domain/scope defaults, remote config).
 *     This lets `plur init --global` users opt individual projects in even
 *     though their MCP server lives only in global settings.
 *
 * Does NOT fall back to global `~/.claude/settings.json` or `~/.cursor/mcp.json` because
 * `plur init --global` puts the server there, making the guard useless for
 * distinguishing plur-enabled vs non-plur projects (#247).
 *
 * The walk-up boundary at `home` (#521 fix): config files AT home are global
 * settings (`~/.claude/settings.json`, `~/.cursor/mcp.json`). Checking them
 * during a walk-up from a nested project reintroduces the #247 false-positive.
 * So home's configs are only consulted when the walk STARTED at home (cwd ===
 * home) — i.e., the user's project root IS $HOME. For nested projects the walk
 * stops without reading home's config files.
 *
 * Used by the session enforcement hooks (`hook-session-guard`,
 * `hook-session-remind`, `hook-session-mark`) and the injection hooks
 * (`hook-inject`, `hook-observe`, `hook-learn-check`), plus the Cursor
 * hooks (`hook-cursor-session-start`, `hook-cursor-guard`,
 * `hook-cursor-post-tool`) — all gate on this to stay silent for non-plur
 * projects.
 *
 * Cheap — a few `existsSync` + JSON parses, terminates at `home`, the root, or the
 * first match.
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
    // would reintroduce the #247 false-positive for `plur init --global` users.
    if (!atHome || start === homeResolved) {
      if (configHasPlur(join(dir, '.mcp.json'))) return true
      if (configHasPlur(join(dir, '.claude', 'settings.json'))) return true
      if (configHasPlur(join(dir, '.claude', 'settings.local.json'))) return true
      if (configHasPlur(join(dir, '.cursor', 'mcp.json'))) return true
      if (existsSync(join(dir, '.plur.yaml'))) return true
    }
    if (atHome) break  // stop after (optionally) checking home
    const parent = dirname(dir)
    if (parent === dir) break  // filesystem root
    dir = parent
  }
  // Fix #247: Do NOT fall back to ~/.claude/settings.json or ~/.cursor/mcp.json — that would always
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
