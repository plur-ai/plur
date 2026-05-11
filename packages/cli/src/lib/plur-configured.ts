import { existsSync, readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { homedir } from 'os'

/**
 * Detect whether plur is registered as an MCP server for the current project.
 *
 * Walks up from `cwd` looking for `.mcp.json` or `.claude/settings.json` with
 * a `plur` server entry, then falls back to the global `~/.claude/settings.json`.
 *
 * Used by the session enforcement hooks (`hook-session-guard`,
 * `hook-session-remind`, `hook-session-mark`) so they can be installed into
 * global Claude settings (issue #95) without firing for non-plur projects.
 *
 * Cheap — a few `existsSync` + JSON parses, terminates at the root or the
 * first match.
 */
export function isPlurConfigured(
  cwd: string = process.cwd(),
  home: string = homedir(),
): boolean {
  const start = resolve(cwd)
  let dir = start
  while (true) {
    if (configHasPlur(join(dir, '.mcp.json'))) return true
    if (configHasPlur(join(dir, '.claude', 'settings.json'))) return true
    if (configHasPlur(join(dir, '.claude', 'settings.local.json'))) return true
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return configHasPlur(join(home, '.claude', 'settings.json'))
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
