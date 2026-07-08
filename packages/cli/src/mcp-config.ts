import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, platform } from 'os'

/**
 * Shared logic for managing the `plur` MCP server registration in
 * Claude Code and Claude Desktop config files.
 *
 * Used by `plur init` (write) and `plur doctor` (read + verify).
 */

export interface McpServerEntry {
  command: string
  args: string[]
  env?: Record<string, string>
}

export interface ConfigFile {
  /** Human-readable label for `plur doctor` output. */
  label: string
  /** Absolute path to the config file. */
  path: string
  /** Whether this config exists on disk right now. */
  exists: boolean
  /**
   * 'claude-code': mcpServers + hooks, Claude's nested {matcher, hooks:[]} shape.
   * 'claude-desktop' / Cursor mcp.json: mcpServers only, no hooks section.
   * 'cursor-hooks': Cursor's separate hooks.json, flat {event: [{command,...}]} shape.
   */
  kind: 'claude-code' | 'claude-desktop' | 'cursor-hooks'
}

/**
 * Locate the local MCP shim installed by `plur init` (#234 fix).
 * Returns the shim path if it exists, null otherwise.
 *
 * The shim at ~/.plur/bin/plur-mcp calls `node <mcp-dist>/index.js` directly,
 * eliminating the npx cache race that ENOTEMPTY'd Claude Code sessions
 * on @plur-ai/mcp version bumps (#234, same bug class as #178).
 */
export function findMcpShim(): string | null {
  const name = platform() === 'win32' ? 'plur-mcp.cmd' : 'plur-mcp'
  const path = join(homedir(), '.plur', 'bin', name)
  return existsSync(path) ? path : null
}

/**
 * Build the MCP server entry to register for the `plur` server.
 *
 * Preferred: local shim at ~/.plur/bin/plur-mcp installed by `plur init`.
 * No npx, no cache, no race conditions (#234).
 *
 * Fallback: npx with a login-shell wrapper on macOS/Linux so that PATH
 * (nvm/brew/volta/asdf) is loaded — Claude Desktop launches GUI apps
 * without the user's shell PATH, which would cause `npx` to fail with
 * "command not found". On Windows, uses `cmd.exe /c npx ...` which
 * inherits the system PATH.
 */
export function buildMcpServerEntry(opts?: { env?: Record<string, string> }): McpServerEntry {
  // Prefer the local shim if `plur init` has installed it.
  const shim = findMcpShim()
  if (shim) {
    return { command: shim, args: [], ...(opts?.env ? { env: opts.env } : {}) }
  }
  if (platform() === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/c', 'npx', '-y', '@plur-ai/mcp@latest'],
      ...(opts?.env ? { env: opts.env } : {}),
    }
  }
  return {
    command: '/bin/sh',
    args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'],
    ...(opts?.env ? { env: opts.env } : {}),
  }
}

/**
 * Locate the Claude Desktop config file for the current platform.
 */
export function claudeDesktopConfigPath(): string {
  const p = platform()
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  }
  if (p === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'Claude', 'claude_desktop_config.json')
  }
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json')
}

/**
 * Locate the Claude Code global settings.json file.
 */
export function claudeCodeGlobalSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/** Locate the project-level Cursor MCP config file. */
export function cursorProjectMcpConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, '.cursor', 'mcp.json')
}

/** Locate the project-level Cursor hooks config file. */
export function cursorProjectHooksConfigPath(cwd: string = process.cwd()): string {
  return join(cwd, '.cursor', 'hooks.json')
}

/** Locate the static PLUR rules file `plur init --cursor` writes once, at install time. */
export function cursorRulesPath(cwd: string = process.cwd()): string {
  return join(cwd, '.cursor', 'rules', 'plur-memory.mdc')
}

/**
 * Locate the DYNAMIC rules file the hook commands rewrite every session
 * (audit fix, live-evidence version): Cursor's own team confirmed
 * `additional_context` from `sessionStart` AND `postToolUse` is dropped by a
 * race condition ("runs async before the composer handle is fully created")
 * — see Global Constraints. The community-and-team-confirmed workaround is
 * to write recalled content into a `.cursor/rules/*.mdc` file instead, since
 * Cursor's rules engine (unlike the broken hook-output channel) reliably
 * loads `alwaysApply: true` rules. Kept as a SEPARATE file from
 * `cursorRulesPath()`'s static, install-time rule so the hooks rewriting
 * this one every session never clobber the human-authored one.
 */
export function cursorContextRulePath(cwd: string = process.cwd()): string {
  return join(cwd, '.cursor', 'rules', 'plur-context.mdc')
}

/**
 * Locate the separate reminder rule file `hook-cursor-post-tool.ts` rewrites
 * on its periodic nudge (audit fix — Codex adversarial review, 2026-07-08:
 * both hooks used to call `writeContextRule()` against
 * `cursorContextRulePath()`, so the first reminder overwrote the recalled
 * engram content `hook-cursor-session-start.ts` had written there, silently
 * dropping the session's injected memory for the rest of the conversation).
 * Kept as its own file, also `alwaysApply: true` and also loaded by Cursor's
 * rules engine, so the two can never clobber each other again.
 */
export function cursorReminderRulePath(cwd: string = process.cwd()): string {
  return join(cwd, '.cursor', 'rules', 'plur-reminder.mdc')
}

/**
 * List all known config files (existing or not) so the doctor command
 * can report on each.
 */
export function knownConfigFiles(cwd: string = process.cwd()): ConfigFile[] {
  const projectSettings = join(cwd, '.claude', 'settings.json')
  const projectMcp = join(cwd, '.mcp.json')
  const globalSettings = claudeCodeGlobalSettingsPath()
  const desktop = claudeDesktopConfigPath()
  const cursorMcp = cursorProjectMcpConfigPath(cwd)
  const cursorHooks = cursorProjectHooksConfigPath(cwd)

  return [
    { label: 'Claude Code (project)', path: projectSettings, exists: existsSync(projectSettings), kind: 'claude-code' },
    { label: 'Claude Code (.mcp.json)', path: projectMcp, exists: existsSync(projectMcp), kind: 'claude-desktop' },
    { label: 'Claude Code (global)', path: globalSettings, exists: existsSync(globalSettings), kind: 'claude-code' },
    { label: 'Claude Desktop', path: desktop, exists: existsSync(desktop), kind: 'claude-desktop' },
    { label: 'Cursor (.cursor/mcp.json)', path: cursorMcp, exists: existsSync(cursorMcp), kind: 'claude-desktop' },
    { label: 'Cursor (.cursor/hooks.json)', path: cursorHooks, exists: existsSync(cursorHooks), kind: 'cursor-hooks' },
  ]
}

/**
 * Read a JSON config file. Returns {} if missing or unparseable.
 */
export function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Write a JSON config file, creating parent directories if needed.
 */
export function writeConfig(path: string, data: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n')
}

/**
 * Check whether the `plur` MCP server is registered in a config object.
 */
export function hasPlurMcp(config: Record<string, unknown>): boolean {
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  return 'plur' in servers
}

/**
 * Detect a `datacore` MCP server entry — used by doctor to surface the
 * "plur ≠ datacore" collision warning that has confused users in the wild.
 */
export function hasDatacoreMcp(config: Record<string, unknown>): boolean {
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  return 'datacore' in servers
}

/**
 * Merge the `plur` MCP server entry into a config object. Idempotent.
 * Returns true if a change was made, false if `plur` was already present.
 */
export function mergePlurMcp(config: Record<string, unknown>, opts?: { env?: Record<string, string> }): boolean {
  const servers = (config.mcpServers ?? {}) as Record<string, McpServerEntry>
  if ('plur' in servers) return false
  servers.plur = buildMcpServerEntry(opts)
  config.mcpServers = servers
  return true
}
