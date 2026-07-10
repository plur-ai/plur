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
 * The walk-up STOPS at `home` (audit fix — evaluator review, 2026-07-08):
 * without a home boundary, for any project nested under `$HOME` (nearly all
 * real projects), the walk-up reaches `$HOME/.claude/settings.json` and
 * silently reintroduces the #247 false-positive. The existing #247 regression
 * test used sibling temp dirs for `root`/`home` (never nested), so it passed
 * without exercising this. The home directory itself IS checked — the walk
 * stops after checking `home`, not before. Directories above `home` are
 * skipped to enforce the documented invariant.
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
    if (configHasPlur(join(dir, '.mcp.json'))) return true
    if (configHasPlur(join(dir, '.claude', 'settings.json'))) return true
    if (configHasPlur(join(dir, '.claude', 'settings.local.json'))) return true
    if (configHasPlur(join(dir, '.cursor', 'mcp.json'))) return true
    if (existsSync(join(dir, '.plur.yaml'))) return true
    const parent = dirname(dir)
    if (parent === dir) break  // filesystem root
    if (dir === homeResolved) break  // stop after checking home, not before
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
