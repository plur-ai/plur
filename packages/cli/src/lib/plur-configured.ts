import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'

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
 * The walk-up STOPS before reaching `home` (audit fix — evaluator review,
 * 2026-07-08): `home` used to be accepted but never actually consulted, so
 * for the overwhelmingly common case — any project nested under `$HOME`,
 * which is nearly all real projects — the walk-up reached `$HOME/.claude/
 * settings.json` anyway once it climbed that far, silently reintroducing
 * exactly the #247 false-positive the "no fallback" comment claims doesn't
 * happen. The existing #247 regression test used sibling temp dirs for
 * `root`/`home` (never nested), so it passed without ever exercising this.
 * Stopping the walk at `home` itself restores the documented invariant for
 * real project layouts, not just artificially-unrelated test directories.
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
  const start = resolve(cwd)
  const homeResolved = resolve(home)
  let dir = start
  while (true) {
    if (dir === homeResolved) break
    if (configHasPlur(join(dir, '.mcp.json'))) return true
    if (configHasPlur(join(dir, '.claude', 'settings.json'))) return true
    if (configHasPlur(join(dir, '.claude', 'settings.local.json'))) return true
    if (configHasPlur(join(dir, '.cursor', 'mcp.json'))) return true
    if (existsSync(join(dir, '.plur.yaml'))) return true
    const parent = dirname(dir)
    if (parent === dir) break
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
