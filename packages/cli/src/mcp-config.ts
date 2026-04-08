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
  /** Whether this is the Claude Desktop format (mcpServers only) vs Claude Code (mcpServers + hooks). */
  kind: 'claude-code' | 'claude-desktop'
}

/**
 * Build the MCP server entry to register for the `plur` server.
 *
 * Uses a login-shell wrapper on macOS/Linux so that PATH (nvm/brew/volta/asdf)
 * is loaded — Claude Desktop launches GUI apps without the user's shell PATH,
 * which would otherwise cause `npx` to fail with "command not found".
 *
 * On Windows, uses `cmd.exe /c npx ...` which inherits the system PATH that
 * already includes Node from the installer.
 */
export function buildMcpServerEntry(): McpServerEntry {
  if (platform() === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/c', 'npx', '-y', '@plur-ai/mcp@latest'],
    }
  }
  return {
    command: '/bin/sh',
    args: ['-lc', 'exec npx -y @plur-ai/mcp@latest'],
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

/**
 * List all known config files (existing or not) so the doctor command
 * can report on each.
 */
export function knownConfigFiles(cwd: string = process.cwd()): ConfigFile[] {
  const projectSettings = join(cwd, '.claude', 'settings.json')
  const projectMcp = join(cwd, '.mcp.json')
  const globalSettings = claudeCodeGlobalSettingsPath()
  const desktop = claudeDesktopConfigPath()

  return [
    {
      label: 'Claude Code (project)',
      path: projectSettings,
      exists: existsSync(projectSettings),
      kind: 'claude-code',
    },
    {
      label: 'Claude Code (.mcp.json)',
      path: projectMcp,
      exists: existsSync(projectMcp),
      kind: 'claude-desktop', // same shape: just mcpServers
    },
    {
      label: 'Claude Code (global)',
      path: globalSettings,
      exists: existsSync(globalSettings),
      kind: 'claude-code',
    },
    {
      label: 'Claude Desktop',
      path: desktop,
      exists: existsSync(desktop),
      kind: 'claude-desktop',
    },
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
export function mergePlurMcp(config: Record<string, unknown>): boolean {
  const servers = (config.mcpServers ?? {}) as Record<string, McpServerEntry>
  if ('plur' in servers) return false
  servers.plur = buildMcpServerEntry()
  config.mcpServers = servers
  return true
}
