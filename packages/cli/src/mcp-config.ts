import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { CLI_VERSION } from './version.js'
import { olderOrEqual } from './lib/semver-order.js'
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
   * - 'claude-code': mcpServers + hooks (nested {matcher, hooks:[]} shape).
   * - 'claude-desktop' / Cursor mcp.json: mcpServers only.
   * - 'cursor-hooks': Cursor's hooks.json, flat {event: [{command,...}]} shape.
   * - 'codex-hooks': ~/.codex/hooks.json — nested shape under top-level `hooks`; own parser.
   * - 'codex-toml': Codex config.toml — read-only; doctor only greps `[mcp_servers.plur]`.
   * - 'agy-hooks': Antigravity hooks.json; PLUR owns only the 'plur-memory' key.
   * - 'claude-user': ~/.claude.json — user (`mcpServers`) and local
   *   (`projects[folder].mcpServers`) MCP servers; no hooks.
   */
  kind: 'claude-code' | 'claude-desktop' | 'cursor-hooks' | 'codex-hooks' | 'codex-toml' | 'agy-hooks' | 'claude-user'
}

/**
 * Locate the local MCP shim installed by `plur init`.
 * Returns the shim path if it exists, null otherwise.
 *
 * The shim at ~/.plur/bin/plur-mcp calls `node <mcp-dist>/index.js` directly,
 * avoiding the npx cache race (ENOTEMPTY) on @plur-ai/mcp version bumps.
 */
export function findMcpShim(): string | null {
  const name = platform() === 'win32' ? 'plur-mcp.cmd' : 'plur-mcp'
  const path = join(homedir(), '.plur', 'bin', name)
  return existsSync(path) ? path : null
}

/**
 * The @plur-ai/mcp js entry `plur init` resolved when it installed the MCP
 * shim, read from `~/.plur/bin/plur-mcp.meta.json`. Null when the metadata is
 * missing or unreadable, or the file it names no longer exists (the package
 * was moved or uninstalled).
 */
export function findMcpJsEntry(): string | null {
  const recorded = recordedMcpJsEntry()
  return recorded && existsSync(recorded) ? recorded : null
}

/** The entry path plur-mcp.meta.json records, whether or not it still exists. */
function recordedMcpJsEntry(): string | null {
  try {
    const meta = JSON.parse(readFileSync(join(homedir(), '.plur', 'bin', 'plur-mcp.meta.json'), 'utf8')) as { entrypoint?: unknown }
    if (typeof meta.entrypoint === 'string' && meta.entrypoint.length > 0) return meta.entrypoint
  } catch { /* no metadata — caller falls back */ }
  return null
}

/**
 * Build the MCP server entry to register for the `plur` server.
 * - Preferred: the local shim ~/.plur/bin/plur-mcp from `plur init` (no npx races).
 * - Windows: `{ command: <node.exe>, args: [<@plur-ai/mcp js entry>] }` when resolvable,
 *   never the `.cmd` shim; else `cmd.exe /c npx ...`.
 * - Fallback elsewhere: npx via a login shell, so GUI-launched clients get the
 *   user's PATH (nvm/brew/volta/asdf).
 */
export function buildMcpServerEntry(opts?: { env?: Record<string, string> }): McpServerEntry {
  if (platform() === 'win32') {
    // Windows never gets the `.cmd` shim as a command: current Node refuses
    // to spawn a `.cmd` directly (`spawn EINVAL`, the CVE-2024-27980
    // hardening), and MCP clients spawn without a shell. The node binary plus
    // @plur-ai/mcp's js entry (recorded by `plur init` in plur-mcp.meta.json)
    // is launched directly instead. When that entry cannot be resolved, the
    // pinned `cmd.exe /c npx` fallback below applies (cmd.exe is a real executable).
    const entrypoint = findMcpJsEntry()
    if (entrypoint) {
      return { command: process.execPath, args: [entrypoint], ...(opts?.env ? { env: opts.env } : {}) }
    }
  } else {
    // Prefer the local shim if `plur init` has installed it.
    const shim = findMcpShim()
    if (shim) {
      return { command: shim, args: [], ...(opts?.env ? { env: opts.env } : {}) }
    }
  }
  // npx fallback pins THIS CLI's version, never @latest. An @latest entry
  // makes npx re-resolve on every publish and rewrite the cached native
  // binaries (better_sqlite3.node) in place, and macOS kills any process that
  // pages in a rewritten signed binary (SIGKILL "CODESIGNING Invalid Page").
  // A pinned version's cache is immutable; upgrades happen when `plur init`
  // rewrites the config to a new pin: every run moves an older-or-equal PLUR
  // pin to this CLI's version (see plurNpxPin). Same convention as the
  // hermes/python bridges' _NPX_CLI_VERSION pin.
  // The constant is compile-time, but it reaches a /bin/sh -lc string, so a
  // version that is not release-shaped is refused: it can be neither pinned
  // safely nor replaced by @latest.
  const version = /^\d+\.\d+\.\d+([.-][0-9A-Za-z.]+)?$/.test(CLI_VERSION) ? CLI_VERSION : null
  if (version === null) {
    throw new Error(`plur: cannot pin the npx MCP entry to CLI version ${JSON.stringify(CLI_VERSION)} (not a release version)`)
  }
  const spec = `@plur-ai/mcp@${version}`
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

/**
 * Claude Code's user config, `~/.claude.json` — where Claude Code reads
 * user-scoped MCP servers (`mcpServers`) and local-scoped ones
 * (`projects[<folder>].mcpServers`). It is what `claude mcp add --scope user`
 * writes. Claude Code does NOT read MCP servers from `~/.claude/settings.json`.
 */
export function claudeCodeUserConfigPath(): string {
  return join(homedir(), '.claude.json')
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
 * Locate the DYNAMIC rules file the hook commands rewrite every session.
 * Cursor drops `additional_context` from `sessionStart` and `postToolUse`
 * (a race: the hook runs before the composer handle exists), so recalled
 * content is written into a `.cursor/rules/*.mdc` file instead, which Cursor's
 * rules engine reliably loads as an `alwaysApply: true` rule. Kept SEPARATE
 * from `cursorRulesPath()`'s static, install-time rule so the hooks rewriting
 * this one every session never clobber the human-authored one.
 */
export function cursorContextRulePath(cwd: string = process.cwd()): string {
  return join(cwd, '.cursor', 'rules', 'plur-context.mdc')
}

/**
 * Locate the separate reminder rule file `hook-cursor-post-tool.ts` rewrites
 * on its periodic nudge. It is its own file (also `alwaysApply: true`) so a
 * reminder never overwrites the recalled engram content
 * `hook-cursor-session-start.ts` writes to `cursorContextRulePath()`.
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
  const userConfig = claudeCodeUserConfigPath()
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
    { label: 'Claude Code (~/.claude.json)', path: userConfig, exists: existsSync(userConfig), kind: 'claude-user' },
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
 * silently destroyed".
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
  /** false when the file EXISTS but is not a JSON object — merging into the coerced {} and writing back would destroy the user's other entries. */
  ok: boolean
}

/**
 * Read a JSON config file that the caller intends to modify and write back.
 * A missing file is a fresh install (`ok: true`, empty config); a file that
 * exists but fails to parse — or parses to something other than an object —
 * is the user's damaged-but-recoverable data, and the only safe move is to
 * refuse the leg and tell them (`ok: false`). The hooks.json legs apply the
 * same refusal.
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
 * The `plur` MCP entry a config file actually declares, so doctor probes what the
 * user launches rather than `buildMcpServerEntry`'s recommended reconstruction.
 * Returns null when the entry has no `command` (nothing runnable to probe).
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
 * "plur ≠ datacore" collision warning.
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
 * Heal an EXISTING plur entry that init itself wrote: only when it is recognizably
 * ours (an npx invocation of @plur-ai/mcp at `@latest`, untagged, or pinned to a
 * version older than or equal to this CLI — a newer pin and custom commands are
 * never touched) and differs from what we would write today (the shim, or this
 * CLI's pin). Re-pinning older pins is what makes a global upgrade reach every
 * tool config on the next `plur init`, the rule the Codex writer applies
 * (codexLaunchKind). On Windows also heals the `plur-mcp.cmd` entry and a
 * node-form entry whose node binary or js entry is gone or changed.
 * The existing env is kept when the caller supplies none.
 * Returns true when the entry was rewritten (caller persists the config).
 */
export function upgradePlurMcpEntry(config: Record<string, unknown>, opts?: { env?: Record<string, string> }): boolean {
  return healPlurMcpEntry(config, opts) !== null
}

/**
 * `upgradePlurMcpEntry`, returning init's status line for what was healed, or null:
 *   - `upgraded stale npx entry` — the @latest/bare npx entry;
 *   - `updated the npx pin <old> → <new>` / `replaced the pinned npx entry (<old>)
 *     with the installed MCP server` — an older PLUR pin;
 *   - `healed the old plur-mcp.cmd entry …` — Windows;
 *   - `repaired the node.exe entry …` — Windows, node binary or js entry gone/changed.
 * Windows lines also name what was written (node.exe launcher or pinned npx fallback).
 */
export function healPlurMcpEntry(config: Record<string, unknown>, opts?: { env?: Record<string, string> }): string | null {
  const servers = (config.mcpServers ?? {}) as Record<string, McpServerEntry | undefined>
  const existing = servers.plur
  if (!existing) return null
  const ownNodeEntry = isOwnWin32NodeEntry(existing)
  const npxPin = plurNpxPin(existing)
  const racey = npxPin === 'latest'
  const oldPin = npxPin !== null && npxPin !== 'latest' && olderOrEqual(npxPin, CLI_VERSION) ? npxPin : null
  const cmdShim = isOwnWin32CmdShimEntry(existing)
  if (!racey && !oldPin && !cmdShim && !ownNodeEntry) return null
  if (ownNodeEntry && !nodeEntryNeedsHealing(existing)) return null
  const effectiveOpts = opts ?? (existing.env ? { env: existing.env } : undefined)
  const recommended = buildMcpServerEntry(effectiveOpts)
  if (recommended.command === existing.command &&
      JSON.stringify(recommended.args) === JSON.stringify(existing.args ?? [])) return null
  // Field-level MERGE, not object replacement: a user entry can carry keys we
  // never modeled (type, cwd, timeout, disabled, envFile) that replacement
  // would destroy. Only the launch triple changes hands.
  servers.plur = {
    ...existing,
    command: recommended.command,
    args: recommended.args,
    // env is MERGED too: a caller-supplied env (the Cursor leg passes
    // PLUR_TOOL_PROFILE) sets its keys, but the user's other keys —
    // PLUR_PATH above all — are theirs.
    ...(recommended.env ? { env: { ...(existing.env ?? {}), ...recommended.env } } : {}),
  }
  config.mcpServers = servers as Record<string, unknown>
  if (racey) return 'upgraded stale npx entry'
  if (oldPin) {
    const newPin = plurNpxPin(recommended)
    return newPin !== null && newPin !== 'latest'
      ? `updated the npx pin ${oldPin} → ${newPin}`
      : `replaced the pinned npx entry (${oldPin}) with the installed MCP server`
  }
  const now = recommended.command.toLowerCase() === 'cmd.exe'
    ? 'the pinned cmd.exe /c npx fallback (@plur-ai/mcp\'s js entry could not be resolved)'
    : 'node.exe + @plur-ai/mcp'
  if (cmdShim) return `healed the old plur-mcp.cmd entry (current Node cannot start a .cmd); now ${now}`
  return `repaired the node.exe entry (the node binary or @plur-ai/mcp path it named was stale); now ${now}`
}

/**
 * Is this PLUR's Windows `.cmd` MCP shim entry
 * (`~/.plur/bin/plur-mcp.cmd`, no args)? Current Node cannot spawn it
 * (`spawn EINVAL`), so re-running init heals it to the node.exe form.
 * Matches only our own shim path, in either slash style; any other command is
 * the user's and is never touched.
 */
export function isOwnWin32CmdShimEntry(entry: McpServerEntry): boolean {
  return isOwnWin32CmdShimCommand(entry.command ?? '') && (entry.args ?? []).length === 0
}

/**
 * Is this command PLUR's old Windows `plur-mcp.cmd` shim? The detection half
 * of `isOwnWin32CmdShimEntry`, without the "nothing else in the entry" rule
 * that only the automatic heal needs: whatever else the entry carries, that
 * command cannot start (`spawn EINVAL`), so `plur doctor` flags it.
 */
export function isOwnWin32CmdShimCommand(command: string): boolean {
  if (platform() !== 'win32') return false
  return command.replace(/\\/g, '/').replace(/"/g, '').toLowerCase().endsWith('/.plur/bin/plur-mcp.cmd')
}

/**
 * The `command` of the `[mcp_servers.plur]` table in Codex's config.toml, or
 * null. Lenient where `readCodexPlurMcpEntry` is strict: other keys,
 * subtables and multi-line arrays in the table are ignored. For detection
 * only (doctor's `codexCmdShimMcp`, init's refusal message), never to decide
 * that an entry is safe to remove and re-add.
 */
export function readCodexPlurMcpCommand(toml: string): string | null {
  const lines = toml.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*\[mcp_servers\.plur\]\s*(#.*)?$/.test(l))
  if (start === -1) return null
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break
    const m = /^\s*command\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/.exec(line)
    if (m) return m[2] !== undefined ? m[2] : m[1].replace(/\\(["\\])/g, '$1')
  }
  return null
}

/**
 * The `[mcp_servers.plur]` table in Codex's config.toml, as a launch entry. A narrow
 * reader, not a TOML parser: exact header only, `command` plus a single-line `args`
 * array, basic (`\\`, `\"`) and literal strings. Anything else returns null ("not
 * PLUR's entry") — incl. any other key, inline `env`, a `mcp_servers.plur.*`
 * subtable, or multi-line `args` — because healing via `codex mcp remove`/`add`
 * would drop those settings (a lost `PLUR_PATH` silently moves the user's memory).
 */
export function readCodexPlurMcpEntry(toml: string): McpServerEntry | null {
  const lines = toml.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*\[mcp_servers\.plur\]\s*(#.*)?$/.test(l))
  if (start === -1) return null
  if (lines.some((l) => /^\s*\[\[?\s*mcp_servers\.plur\./.test(l))) return null
  const STRING = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g
  let command: string | null = null
  let args: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break
    if (/^\s*(#.*)?$/.test(line)) continue
    const kv = /^\s*(command|args)\s*=\s*(.*)$/.exec(line)
    if (!kv) return null
    // Everything outside the strings must be the expected punctuation: one
    // string for command, a closed `[...]` for args, then an optional comment.
    const rest = kv[2].replace(STRING, '""')
    const shape = kv[1] === 'command' ? /^""\s*(#.*)?$/ : /^\[\s*(""\s*,\s*)*(""\s*)?\]\s*(#.*)?$/
    if (!shape.test(rest)) return null
    const values: string[] = []
    for (const m of kv[2].matchAll(STRING)) {
      values.push(m[2] !== undefined ? m[2] : m[1].replace(/\\(["\\])/g, '$1'))
    }
    if (kv[1] === 'command') command = values[0] ?? null
    else args = values
  }
  return command ? { command, args } : null
}

/** Windows paths compare without regard to slash style or case. */
function sameWin32Path(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Is this the Windows node-form MCP entry `plur init` writes:
 * `{ command: <node.exe>, args: [<@plur-ai/mcp js entry>] }`? Scoped as
 * tightly as isOwnWin32CmdShimEntry: the command must be a `node`/`node.exe`
 * binary and the single argument must be an `@plur-ai/mcp/dist/index.js`
 * path, or the exact entry plur-mcp.meta.json recorded (the workspace
 * layout). Anything else — extra args, another script, another launcher — is
 * the user's own entry and is never rewritten.
 */
export function isOwnWin32NodeEntry(entry: McpServerEntry): boolean {
  if (platform() !== 'win32') return false
  const args = entry.args ?? []
  if (typeof entry.command !== 'string' || args.length !== 1 || typeof args[0] !== 'string') return false
  const command = entry.command.replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
  if (!/(^|\/)node(\.exe)?$/.test(command)) return false
  const script = args[0].replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
  if (script.endsWith('/@plur-ai/mcp/dist/index.js')) return true
  const recorded = recordedMcpJsEntry()
  return recorded !== null && sameWin32Path(recorded, args[0])
}

/**
 * The paths a PLUR node-form entry names that no longer exist. The node
 * binary is version-specific (`process.execPath`), so a Node upgrade or a
 * version-manager switch removes it, and the @plur-ai/mcp entry goes with
 * an uninstall or a move. Empty for a healthy entry and for any entry that is
 * not PLUR's own node form.
 */
export function missingNodeEntryPaths(entry: McpServerEntry): string[] {
  if (!isOwnWin32NodeEntry(entry)) return []
  // A bare `node` / `node.exe` is resolved through PATH at spawn time, so
  // existsSync on it says nothing about whether it runs.
  const paths = isPathResolvedCommand(entry.command) ? [entry.args[0]] : [entry.command, entry.args[0]]
  return paths.filter((p) => !existsSync(p))
}

/**
 * A command with no path separator (`node`, `node.exe`) is looked up through
 * PATH when it is spawned. PLUR itself always writes an absolute node path
 * (`process.execPath`), so an entry naming a bare `node` was written by the
 * user: it keeps working across Node upgrades, and init must never pin it to
 * a version-specific path or replace it with the npx fallback.
 */
export function isPathResolvedCommand(command: string): boolean {
  return !/[\\/]/.test(command)
}

/**
 * Does PLUR's own node-form entry need rewriting? Yes when the node binary or
 * the js entry it names is gone, or when the js entry differs from the one
 * `plur init` resolved this run (plur-mcp.meta.json). A working entry is left
 * alone when nothing resolves now. A PATH-resolved `node` is the user's own
 * choice and is never rewritten.
 */
function nodeEntryNeedsHealing(entry: McpServerEntry): boolean {
  if (isPathResolvedCommand(entry.command)) return false
  if (missingNodeEntryPaths(entry).length > 0) return true
  const resolvedNow = findMcpJsEntry()
  return resolvedNow !== null && !sameWin32Path(resolvedNow, entry.args[0])
}

/**
 * The @plur-ai/mcp version an npx entry PLUR wrote launches: `'latest'` for the
 * RACEY shapes (exactly `@plur-ai/mcp` at `@latest` or untagged), the version for
 * an exact SemVer pin, or null for anything that is not PLUR's npx entry.
 * Deliberately narrow:
 *   - only the exact argv PLUR writes, with nothing else in it:
 *     `npx [-y|--yes] <spec>`, `cmd.exe /c npx -y <spec>`, `/bin/sh -lc 'exec npx -y <spec>'`;
 *   - anchored package spec, so forks, tags, ranges and mentions never match.
 * The caller decides what a pin means: the healer re-pins one older than or equal
 * to this CLI and keeps a newer one (the Codex rule).
 */
export function plurNpxPin(entry: McpServerEntry): string | null {
  const SPEC = /^@plur-ai\/mcp(?:@(.+))?$/
  const args = entry.args ?? []
  // Only the exact argv shapes PLUR writes, as codexLaunchKind matches them:
  // anything more (an extra argument, `-p <pkg> <bin>`, `--package`) is a
  // custom entry whose arguments a rewrite would drop.
  let spec: string | undefined
  if (entry.command === '/bin/sh') {
    // init's POSIX shape: /bin/sh -lc 'exec npx -y <spec>'.
    if (args.length === 2 && args[0] === '-lc') spec = /^\s*(?:exec\s+)?npx\s+(?:-y\s+)?(\S+)\s*$/.exec(args[1])?.[1]
  } else if (entry.command === 'npx') {
    // A user's or plur-mcp init's argv: npx [-y|--yes] <spec>.
    if (args.length === 1) spec = args[0]
    else if (args.length === 2 && (args[0] === '-y' || args[0] === '--yes')) spec = args[1]
  } else if (entry.command === 'cmd.exe') {
    // init's win32 shape: cmd.exe /c npx -y <spec>.
    if (args.length === 4 && args[0] === '/c' && args[1] === 'npx' && args[2] === '-y') spec = args[3]
  }
  const m = spec ? SPEC.exec(spec) : null
  if (!m) return null
  const tag = m[1]
  if (tag === undefined || tag === 'latest') return 'latest'
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(tag) ? tag : null
}
