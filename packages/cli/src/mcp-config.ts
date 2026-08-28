import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { CLI_VERSION } from './version.js'
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
   * 'codex-hooks': Codex's ~/.codex/hooks.json — Claude Code's nested shape,
   *   but under a top-level `hooks` key alongside a `description`, and read
   *   by its own parser so a future divergence doesn't silently misreport.
   * 'codex-toml': Codex's config.toml — NOT JSON. Read-only here; doctor
   *   only greps it for an `[mcp_servers.plur]` table.
   * 'agy-hooks': Antigravity's hooks.json — a map of NAMED hook sets; PLUR
   *   owns the 'plur-memory' key and nothing else.
   */
  kind: 'claude-code' | 'claude-desktop' | 'cursor-hooks' | 'codex-hooks' | 'codex-toml' | 'agy-hooks'
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
  // npx fallback pins THIS CLI's version, never @latest (#1069 root cause).
  // An @latest entry makes npx re-resolve on every publish and REWRITE the
  // cached native binaries (better_sqlite3.node) in place — and macOS kills
  // any process that pages in a rewritten signed binary with SIGKILL
  // "CODESIGNING Invalid Page" (captured in Diagnostic Reports on
  // 2026-08-28: dyld faulting exactly better-sqlite3's 1888K mapping, ~0.5s
  // after launch, cold runs only). That was the "first cold
  // plur_session_start of the day dies" production signature: the first run
  // after a publish is the one that races the cache rewrite. A pinned
  // version's cache is immutable — upgrades happen when `plur init` rewrites
  // the config to a new pin, a moment when servers restart anyway. Same
  // convention as the hermes/python bridges' _NPX_CLI_VERSION pin.
  const spec = `@plur-ai/mcp@${CLI_VERSION}`
  if (platform() === 'win32') {
    return {
      command: 'cmd.exe',
      args: ['/c', 'npx', '-y', spec],
      ...(opts?.env ? { env: opts.env } : {}),
    }
  }
  return {
    command: '/bin/sh',
    args: ['-lc', `exec npx -y ${spec}`],
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

/**
 * Locate Codex's home directory. Honours `CODEX_HOME`, which Codex itself
 * reads — without this, `plur init --codex` would write into `~/.codex`
 * while a `CODEX_HOME`-using install looked somewhere else entirely.
 */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), '.codex')
}

/**
 * Locate Codex's hooks config.
 *
 * Codex accepts hooks from EITHER this file or a `[hooks]` table in
 * `config.toml`, and warns when both exist for the same layer. We own the
 * JSON file: no TOML dependency, the same nested shape the Claude Code hook
 * builders already emit, and PLUR's hooks stay out of the file the user
 * hand-edits for models and MCP servers.
 */
export function codexHooksConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'hooks.json')
}

/** Codex's main config file — read (not written) by `plur doctor` to check MCP registration. */
export function codexConfigTomlPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(codexHome(env), 'config.toml')
}

/**
 * Antigravity CLI's global config directory. Everything agy loads globally
 * lives here: hooks.json, mcp_config.json, skills. (The CLI itself keeps
 * runtime state in ~/.gemini/antigravity-cli/, which we never write.)
 */
export function agyConfigDir(): string {
  return join(homedir(), '.gemini', 'config')
}

/** Antigravity's global hooks config — a map of named hook sets. */
export function agyHooksConfigPath(): string {
  return join(agyConfigDir(), 'hooks.json')
}

/**
 * Antigravity's global MCP config. Same `{ mcpServers: { name: {...} } }`
 * shape as Claude Desktop / Cursor, so the existing hasPlurMcp/mergePlurMcp
 * helpers apply unchanged.
 */
export function agyMcpConfigPath(): string {
  return join(agyConfigDir(), 'mcp_config.json')
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
  const codexHooks = codexHooksConfigPath()
  const codexToml = codexConfigTomlPath()
  const agyHooks = agyHooksConfigPath()
  const agyMcp = agyMcpConfigPath()

  return [
    { label: 'Claude Code (project)', path: projectSettings, exists: existsSync(projectSettings), kind: 'claude-code' },
    { label: 'Claude Code (.mcp.json)', path: projectMcp, exists: existsSync(projectMcp), kind: 'claude-desktop' },
    { label: 'Claude Code (global)', path: globalSettings, exists: existsSync(globalSettings), kind: 'claude-code' },
    { label: 'Claude Desktop', path: desktop, exists: existsSync(desktop), kind: 'claude-desktop' },
    { label: 'Cursor (.cursor/mcp.json)', path: cursorMcp, exists: existsSync(cursorMcp), kind: 'claude-desktop' },
    { label: 'Cursor (.cursor/hooks.json)', path: cursorHooks, exists: existsSync(cursorHooks), kind: 'cursor-hooks' },
    { label: 'Codex (~/.codex/hooks.json)', path: codexHooks, exists: existsSync(codexHooks), kind: 'codex-hooks' },
    { label: 'Codex (~/.codex/config.toml)', path: codexToml, exists: existsSync(codexToml), kind: 'codex-toml' },
    { label: 'Antigravity (~/.gemini/config/hooks.json)', path: agyHooks, exists: existsSync(agyHooks), kind: 'agy-hooks' },
    { label: 'Antigravity (~/.gemini/config/mcp_config.json)', path: agyMcp, exists: existsSync(agyMcp), kind: 'claude-desktop' },
  ]
}

/**
 * Read a JSON config file. Returns {} if missing or unparseable.
 *
 * For READ-ONLY consumers (doctor's checks) this coercion is the right
 * degradation. Any caller that intends to WRITE the config back must use
 * readConfigForWrite instead: writing through this function's {} turns "one
 * trailing comma" into "every other MCP server the user had registered is
 * silently destroyed" (#1059).
 */
export function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

export interface ConfigReadResult {
  config: Record<string, unknown>
  /** false when the file EXISTS but is not a JSON object — merging into the coerced {} and writing back would destroy the user's other entries (#1059). */
  ok: boolean
}

/**
 * Read a JSON config file that the caller intends to modify and write back.
 * A missing file is a fresh install (`ok: true`, empty config); a file that
 * exists but fails to parse — or parses to something other than an object —
 * is the user's damaged-but-recoverable data, and the only safe move is to
 * refuse the leg and tell them (`ok: false`). This is the same refusal the
 * hooks.json legs have carried since the 0.19.0 adversarial audit (ADV-F2);
 * #1059 is that finding un-propagated to the MCP legs of the same functions.
 */
export function readConfigForWrite(path: string): ConfigReadResult {
  if (!existsSync(path)) return { config: {}, ok: true }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { config: parsed as Record<string, unknown>, ok: true }
    }
  } catch { /* fall through to the refusal */ }
  return { config: {}, ok: false }
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
 * The `plur` MCP entry a config file actually declares, if any.
 *
 * `hasPlurMcp` answers whether one exists; this returns the thing itself, so a
 * caller can launch what the user launches instead of a reconstruction of it
 * (#764). `buildMcpServerEntry` synthesises a *recommended* entry — the shim,
 * else npx — which is right for `plur init` writing a config and wrong for
 * doctor verifying one: an install that runs the server some other way gets
 * diagnosed on a path it never uses.
 *
 * Returns null when the entry exists but has no `command`, since there is
 * nothing runnable to probe and guessing would defeat the purpose.
 */
export function readPlurMcpEntry(config: Record<string, unknown>): McpServerEntry | null {
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>
  const entry = servers.plur as { command?: unknown; args?: unknown; env?: unknown } | undefined
  if (!entry || typeof entry.command !== 'string' || entry.command.length === 0) return null
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === 'string') : []
  const env = entry.env && typeof entry.env === 'object'
    ? Object.fromEntries(
        Object.entries(entry.env as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string') as [string, string][],
      )
    : undefined
  return { command: entry.command, args, ...(env && Object.keys(env).length > 0 ? { env } : {}) }
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

/**
 * Heal an EXISTING plur entry that init itself wrote via the npx fallback.
 *
 * "Entry exists" is not "entry is correct" — the same trap the Cursor leg's
 * PLUR_TOOL_PROFILE patch already documents. Every MCP leg used to skip on
 * `hasPlurMcp`, which left the `@latest` entries older inits wrote in place
 * FOREVER: re-running `plur init` on an affected machine reported "already
 * registered" while the #1069 rewrite race stayed armed. Upgrade the entry
 * when (a) it is recognizably OURS (an npx invocation of @plur-ai/mcp — a
 * hand-rolled custom command is never touched), and (b) it differs from what
 * we would write today (shim, or the current version pin). The existing
 * entry's env is preserved when the caller doesn't supply one.
 *
 * Returns true when the entry was rewritten (caller persists the config).
 */
export function upgradePlurMcpEntry(config: Record<string, unknown>, opts?: { env?: Record<string, string> }): boolean {
  const servers = (config.mcpServers ?? {}) as Record<string, McpServerEntry | undefined>
  const existing = servers.plur
  if (!existing) return false
  const blob = `${existing.command ?? ''} ${(existing.args ?? []).join(' ')}`
  if (!/\bnpx\b/.test(blob) || !blob.includes('@plur-ai/mcp')) return false
  const effectiveOpts = opts ?? (existing.env ? { env: existing.env } : undefined)
  const recommended = buildMcpServerEntry(effectiveOpts)
  const recommendedBlob = `${recommended.command} ${(recommended.args ?? []).join(' ')}`
  if (recommendedBlob === blob) return false
  servers.plur = recommended
  config.mcpServers = servers as Record<string, unknown>
  return true
}
