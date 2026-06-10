import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Detect whether plur is configured for the current project.
 *
 * Walks up from `cwd` looking for a project-level plur marker:
 *   - `.mcp.json`, `.claude/settings.json`, or `.claude/settings.local.json`
 *     with a `plur` server entry
 *   - `.plur.yaml` (project config — domain/scope defaults, remote config).
 *     This lets `plur init --global` users opt individual projects in even
 *     though their MCP server lives only in global settings.
 *
 * Does NOT fall back to global `~/.claude/settings.json` because
 * `plur init --global` puts the server there, making the guard useless for
 * distinguishing plur-enabled vs non-plur projects (#247).
 *
 * Used by the session enforcement hooks (`hook-session-guard`,
 * `hook-session-remind`, `hook-session-mark`) and the injection hooks
 * (`hook-inject`, `hook-observe`, `hook-learn-check`) so they can be
 * installed into global Claude settings (issue #95) without firing for
 * non-plur projects.
 *
 * Cheap — a few `existsSync` + JSON parses, terminates at the root or the
 * first match.
 */
export function isPlurConfigured(
  cwd: string = process.cwd(),
  // Kept so tests can inject a fake home and assert the global fallback
  // stays gone (#247). Intentionally unused by the implementation.
  _home: string = homedir(),
): boolean {
  const start = resolve(cwd)
  let dir = start
  while (true) {
    if (configHasPlur(join(dir, '.mcp.json'))) return true
    if (configHasPlur(join(dir, '.claude', 'settings.json'))) return true
    if (configHasPlur(join(dir, '.claude', 'settings.local.json'))) return true
    if (existsSync(join(dir, '.plur.yaml'))) return true
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  // Fix #247: Do NOT fall back to ~/.claude/settings.json — that would always
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
