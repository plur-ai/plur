import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'
import { atomicWrite } from '@plur-ai/core'
import { buildMcpServerEntry, findMcpJsEntry, findMcpShim, isOwnWin32NodeEntry, isPathResolvedCommand, missingNodeEntryPaths } from './mcp-config.js'
import { parseJsonc } from './lib/jsonc.js'
import { olderOrEqual } from './lib/semver-order.js'
import { applyEdits, modify, parseTree, type Node as JsonNode, type JSONPath, type ParseError } from 'jsonc-parser'
import opencodePackage from '../../opencode/package.json'

/**
 * OpenCode's global JSON/JSONC config carries both the plugin and MCP entry.
 * Existing files are edited by token offset: comments, whitespace, other
 * plugins and user options survive. Only older exact plugin pins and PLUR's
 * own previous launch command are upgraded; remote/custom MCP entries stay.
 */

export interface WriteOpencodeConfigResult {
  created: boolean
  changed: boolean
  /** Invalid/ambiguous JSONC or incompatible field shapes are refused unchanged. */
  ok: boolean
  /** Existing remote/custom entries and their fields are never replaced. */
  mcpPlurPreserved: boolean
  /** PLUR's old npx command migrated to the installed package or Windows fallback. */
  mcpPlurUpgraded: boolean
  /**
   * PLUR's own npx entry, pinned older than this CLI, moved to this CLI's pin
   * because no installed MCP server was found to launch instead.
   */
  mcpPlurRepinned?: { from: string; to: string }
  /** A stale owned Windows node command was repaired. */
  mcpPlurRepaired: boolean
  /** True when the entry now in the file launches an installed binary, not npx. */
  mcpPlurLocal: boolean
  mcpPlurCommand?: string[]
}

/**
 * True for a JSON *object* — not an array, not `null`, not a primitive.
 * Same shape test `readConfigForWrite` in `mcp-config.ts` uses to decide a
 * parsed config is safe to merge into and write back.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The opencode config directory `plur init` writes into, resolved as opencode
 * does: `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode` (empty counts as
 * unset), else `~/.config/opencode` — so a custom location is never missed.
 * No per-project variant: one global store, one place to register it.
 */
export function opencodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  const xdgConfig = env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'opencode')
}

/**
 * The opencode config file `plur init --opencode` targets. opencode accepts
 * both `opencode.json` and `opencode.jsonc` (JSON-with-comments) as its
 * config file. If the user already has a `.jsonc` and no `.json`, target
 * THAT file — writing a second, competing `opencode.json` the user never
 * asked for would either be ignored or fork their config in two directions.
 * `.json` is the target when neither exists (a fresh install) or both do.
 */
export function opencodeConfigPath(): string {
  const dir = opencodeConfigDir()
  const jsonPath = join(dir, 'opencode.json')
  const jsoncPath = join(dir, 'opencode.jsonc')
  if (!existsSync(jsonPath) && existsSync(jsoncPath)) return jsoncPath
  return jsonPath
}

/**
 * The plugin package name `plur init --opencode` writes into `plugin: [...]`
 * and `plur doctor`'s opencode leg checks the resolvability of. Exported so
 * doctor never has to repeat this string as a second, driftable source of
 * truth (see `readOpencodeConfig` below).
 */
export const PLUR_OPENCODE_PLUGIN = '@plur-ai/opencode'
const PLUGIN = PLUR_OPENCODE_PLUGIN
export const CURRENT_OPENCODE_PLUGIN_VERSION = opencodePackage.version

/** Tags, ranges and unpinned entries remain the user's choice. */
function upgradePluginSpec(spec: unknown): unknown {
  if (typeof spec !== 'string' || !spec.startsWith(PLUGIN + '@')) return spec
  const parse = (v: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v)
  const old = parse(spec.slice(PLUGIN.length + 1)), current = parse(CURRENT_OPENCODE_PLUGIN_VERSION)
  if (!old || !current) return spec
  for (let i = 1; i <= 3; i++) {
    if (Number(old[i]) < Number(current[i])) return PLUGIN + '@' + CURRENT_OPENCODE_PLUGIN_VERSION
    if (Number(old[i]) > Number(current[i])) return spec
  }
  return old[4] && !current[4] ? PLUGIN + '@' + CURRENT_OPENCODE_PLUGIN_VERSION : spec
}

/**
 * A duplicate key makes offset edits ambiguous, even if JSON.parse accepts it:
 * JSON.parse (and opencode) keep the LAST occurrence while an offset edit
 * changes the FIRST. Also used by the enterprise legacy cleanup.
 */
export function unambiguousJsonc(text: string): boolean {
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })
  const unique = (node: JsonNode): boolean => {
    if (node.type === 'object') {
      const keys = node.children?.map(property => property.children![0].value) ?? []
      if (new Set(keys).size !== keys.length) return false
    }
    return (node.children ?? []).every(unique)
  }
  return !!tree && errors.length === 0 && unique(tree)
}

/**
 * Is this `plugin: [...]` element PLUR's plugin, in any form opencode
 * accepts: the bare name, a version- or tag-pinned spec
 * (`@plur-ai/opencode@0.1.1`, `@plur-ai/opencode@latest`), or the tuple form
 * `["@plur-ai/opencode", { ...options }]`. Compared by package name, the way
 * opencode deduplicates plugins, so a user's pin or options are recognised
 * and never shadowed by a second, bare entry appended after them.
 * Another package (`@plur-ai/opencode-extra`) does not match.
 */
export function isPlurOpencodePluginEntry(entry: unknown): boolean {
  const spec = pluginSpec(entry)
  if (typeof spec !== 'string') return false
  const at = spec.indexOf('@', 1)
  return (at === -1 ? spec : spec.slice(0, at)) === PLUGIN
}

function pluginSpec(entry: unknown): unknown {
  return Array.isArray(entry) ? entry[0] : isPlainObject(entry) ? entry.package : entry
}

function validContainers(cfg: Record<string, unknown>): boolean {
  for (const key of ['plugin', 'plugins']) {
    if (cfg[key] != null && !Array.isArray(cfg[key])) return false
  }
  if (cfg.mcp != null && !isPlainObject(cfg.mcp)) return false
  if (isPlainObject(cfg.mcp) && cfg.mcp.servers != null && !isPlainObject(cfg.mcp.servers)) return false
  return true
}

function pluginEntries(cfg: Record<string, unknown>): unknown[] {
  return [...(Array.isArray(cfg.plugin) ? cfg.plugin : []), ...(Array.isArray(cfg.plugins) ? cfg.plugins : [])]
}

/** V2 removal directives are ordered. Preserve an explicit disabled choice. */
function pluginIntent(entries: unknown[]): { declared: boolean; disabled: boolean } {
  let declared = false, disabled = false
  for (const entry of entries) {
    if (isPlurOpencodePluginEntry(entry)) { declared = true; disabled = false; continue }
    if (typeof entry !== 'string' || !entry.startsWith('-')) continue
    const pattern = entry.slice(1).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    const match = new RegExp('^' + pattern + '$')
    if (match.test('plur') || match.test(PLUGIN)) { declared = false; disabled = true }
  }
  return { declared, disabled }
}

function mcpLocation(cfg: Record<string, unknown>): { map: Record<string, unknown>; path: string[]; native: boolean } {
  const mcp = isPlainObject(cfg.mcp) ? cfg.mcp : {}
  const servers = isPlainObject(mcp.servers) ? mcp.servers : undefined
  // Native declarations win, but an existing legacy declaration must not be
  // shadowed just because unrelated native servers also exist.
  if (servers && (servers.plur != null || mcp.plur == null)) return { map: servers, path: ['mcp', 'servers'], native: true }
  return { map: mcp, path: ['mcp'], native: false }
}

/**
 * A read-only snapshot of what an opencode config file currently declares for
 * PLUR — no writes, no side effects. Exists so `plur doctor`'s opencode leg
 * can report on the SAME file `writeOpencodeConfig` would write, using the
 * SAME shape rules, without duplicating them.
 */
export interface OpencodeConfigSnapshot {
  /** Whether `configPath` exists on disk at all. */
  exists: boolean
  /**
   * False when the file exists but doctor cannot safely read PLUR's
   * declarations out of it: invalid JSON even after JSONC comments and
   * trailing commas are allowed, a top-level value that isn't a plain
   * object, or an existing `plugin`/`mcp` field in the wrong shape. `true`
   * when the file doesn't exist — there is nothing unsafe about "not there".
   *
   * JSONC comments and trailing commas are accepted. Reading never changes
   * the document.
   */
  ok: boolean
  /** `plugin` is an array containing `PLUR_OPENCODE_PLUGIN` in any form (`isPlurOpencodePluginEntry`). False when `ok` is false. */
  pluginDeclared: boolean
  pluginDisabled?: boolean
  /** Older exact pin and the upgrade init would apply; tags/newer pins are omitted. */
  pluginUpgrade?: { from: string; to: string }
  /** `mcp.plur` is present (any non-null value). False when `ok` is false. */
  mcpPlurDeclared: boolean
  mcpPlurDisabled?: boolean
  /**
   * The paths PLUR's own win32 node-form `mcp.plur` entry names that no
   * longer exist (`missingNodeEntryPaths`): typically the version-specific
   * node binary after a Node upgrade. Empty for a healthy entry, a
   * PATH-resolved `node`, any entry that is not PLUR's node form, and off
   * win32.
   */
  mcpPlurMissingPaths: string[]
}

/**
 * Read what an opencode config currently declares for PLUR. Pure — never
 * writes, never throws. `configPath` is normally `opencodeConfigPath()`'s
 * result, but is taken as a parameter (rather than resolved internally) so a
 * caller that already resolved it once (as `plur doctor` does, alongside its
 * own directory-exists check) doesn't pay for it twice.
 */
export function readOpencodeConfig(configPath: string): OpencodeConfigSnapshot {
  if (!existsSync(configPath)) {
    return { exists: false, ok: true, pluginDeclared: false, mcpPlurDeclared: false, mcpPlurMissingPaths: [] }
  }

  let parsed: unknown
  try {
    // Read JSONC using the same syntax accepted by the writer.
    parsed = parseJsonc(readFileSync(configPath, 'utf8'))
  } catch {
    return { exists: true, ok: false, pluginDeclared: false, mcpPlurDeclared: false, mcpPlurMissingPaths: [] }
  }
  if (!isPlainObject(parsed)) {
    return { exists: true, ok: false, pluginDeclared: false, mcpPlurDeclared: false, mcpPlurMissingPaths: [] }
  }
  if (!validContainers(parsed)) {
    return { exists: true, ok: false, pluginDeclared: false, mcpPlurDeclared: false, mcpPlurMissingPaths: [] }
  }
  const entries = pluginEntries(parsed)
  const intent = pluginIntent(entries)
  const pluginDeclared = intent.declared
  const { map } = mcpLocation(parsed)
  const mcpPlurDeclared = map.plur != null
  let mcpPlurMissingPaths: string[] = []
  const entry = mcpPlurDeclared ? map.plur : null
  if (isPlainObject(entry) && entry.type === 'local' && Array.isArray(entry.command) && entry.command.length === 2 &&
      typeof entry.command[0] === 'string' && typeof entry.command[1] === 'string') {
    mcpPlurMissingPaths = missingNodeEntryPaths({ command: entry.command[0], args: [entry.command[1]] })
  }
  const oldSpec = entries.map(pluginSpec).find(spec => upgradePluginSpec(spec) !== spec)
  return { exists: true, ok: true, pluginDeclared, mcpPlurDeclared, mcpPlurMissingPaths,
    ...(intent.disabled ? { pluginDisabled: true } : {}),
    ...(isPlainObject(entry) && (entry.disabled === true || entry.enabled === false) ? { mcpPlurDisabled: true } : {}),
    ...(typeof oldSpec === 'string' ? { pluginUpgrade: { from: oldSpec, to: upgradePluginSpec(oldSpec) as string } } : {}),
  }
}

/**
 * The `mcp.plur.command` and local flag PLUR writes for opencode.
 *
 * Resolution order:
 * (1) js entry recorded by init (any platform) → [node, entry], local
 * (2) non-win32 shim at ~/.plur/bin/plur-mcp → [shim], local
 * (3) win32 → buildMcpServerEntry() (cmd.exe /c npx …), not local
 * (4) plain npx fallback, not local
 *
 * `local: true` means the entry launches an installed binary, not npx.
 */
export function opencodeMcpLaunch(cliVersion: string): { command: string[]; local: boolean } {
  const jsEntry = findMcpJsEntry()
  if (jsEntry) return { command: [process.execPath, jsEntry], local: true }
  if (platform() !== 'win32') {
    const shim = findMcpShim()
    if (shim) return { command: [shim], local: true }
  }
  if (platform() === 'win32') {
    const entry = buildMcpServerEntry()
    return { command: [entry.command, ...(entry.args ?? [])], local: false }
  }
  return { command: ['npx', '-y', `@plur-ai/mcp@${cliVersion}`], local: false }
}

/**
 * The `mcp.plur.command` array PLUR writes for opencode (a single argv, not
 * `command` + `args` like the other hosts). Wrapper around `opencodeMcpLaunch`.
 */
export function opencodeMcpCommand(cliVersion: string): string[] {
  return opencodeMcpLaunch(cliVersion).command
}

/**
 * Is this PLUR's legacy `mcp.plur` npx entry (`{ type: 'local', command:
 * ['npx', '-y', '@plur-ai/mcp@<version>'] }`)? Shell-less spawns on Windows
 * cannot resolve bare `npx`. As tight as `isOwnWin32CmdShimEntry`: exactly
 * those three elements with a pinned version, else it is the user's and never
 * touched. Extra fields are kept, since only `command` is replaced.
 */
function isOwnLegacyNpxEntry(entry: unknown): entry is Record<string, unknown> {
  if (!isPlainObject(entry)) return false
  if (entry.type !== 'local') return false
  const cmd = entry.command
  return Array.isArray(cmd) && cmd.length === 3 &&
    cmd[0] === 'npx' && cmd[1] === '-y' &&
    typeof cmd[2] === 'string' && /^@plur-ai\/mcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cmd[2])
}

/** The entry's argv is exactly `expected`. */
function sameCommand(cmd: unknown, expected: string[]): boolean {
  return Array.isArray(cmd) && cmd.length === expected.length && cmd.every((c, i) => c === expected[i])
}

/** Windows paths compare without regard to slash style, quotes or case. */
function sameWin32Path(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The `command` to repair PLUR's own win32 node-form `mcp.plur` entry to, or
 * null. Same rules as the Claude Code heal: only `[<node(.exe)>, <@plur-ai/mcp
 * js entry>]` (`isOwnWin32NodeEntry`), rewritten when a named path is gone or
 * the current node form names a different js entry. Never replaces a working
 * entry with npx, never rewrites a PATH-resolved `node`; other shapes are the user's.
 */
function staleOwnWin32NodeCommand(entry: unknown, cliVersion: string): string[] | null {
  if (!isPlainObject(entry) || entry.type !== 'local') return null
  const cmd = entry.command
  if (!Array.isArray(cmd) || cmd.length !== 2 || typeof cmd[0] !== 'string' || typeof cmd[1] !== 'string') return null
  const asEntry = { command: cmd[0], args: [cmd[1]] }
  if (!isOwnWin32NodeEntry(asEntry)) return null
  // A bare `node` resolves through PATH and survives Node upgrades; PLUR
  // never writes one, so it is the user's and is left alone.
  if (isPathResolvedCommand(cmd[0])) return null
  const now = opencodeMcpCommand(cliVersion)
  if (missingNodeEntryPaths(asEntry).length > 0) return now
  // Only the js entry is compared, like the Claude Code heal
  // (nodeEntryNeedsHealing): a different node binary that still exists is
  // not stale, and replacing it whenever another install ran init would flip
  // the entry between Node installs (nvm-windows, Volta) on every run.
  const nowIsNodeForm = now.length === 2 && isOwnWin32NodeEntry({ command: now[0], args: [now[1]] })
  if (nowIsNodeForm && !sameWin32Path(now[1], cmd[1])) return now
  return null
}

/**
 * Resolve the real path to write to. `atomicWrite`'s rename replaces a symlink
 * itself (orphaning its target), and dotfiles users symlink `opencode.json`, so
 * write to the symlink's real target. A path that does not exist yet has
 * nothing to resolve.
 */
function resolveWriteTarget(path: string): string {
  try {
    if (lstatSync(path).isSymbolicLink()) return realpathSync(path)
  } catch {
    // Doesn't exist yet, or some other stat failure — write at the given path.
  }
  return path
}

/**
 * Add PLUR to an opencode config, preserving everything else in it. See the
 * file-level docstring for how existing files are edited. `configPath` may
 * point at an `opencode.json` or an
 * `opencode.jsonc` file — whichever `opencodeConfigPath()` decided is the
 * user's real config.
 */
export function writeOpencodeConfig(
  configPath: string,
  cliVersion: string,
  options: { upgradePlugin?: boolean } = {},
): WriteOpencodeConfigResult {
  const created = !existsSync(configPath)
  let cfg: Record<string, unknown>
  let source = '', bom = ''
  const edits: Array<{ path: JSONPath; value: unknown }> = []
  if (created) {
    cfg = { $schema: 'https://opencode.ai/config.json' }
  } else {
    let parsed: unknown
    try {
      source = readFileSync(configPath, 'utf8')
      if (source.charCodeAt(0) === 0xfeff) { bom = source[0]; source = source.slice(1) }
      if (!unambiguousJsonc(source)) throw new Error('Invalid or ambiguous JSONC')
      parsed = parseJsonc(source)
    } catch {
      return { created: false, changed: false, ok: false, mcpPlurPreserved: false, mcpPlurUpgraded: false, mcpPlurRepaired: false, mcpPlurLocal: false }
    }
    // Valid JSON, wrong shape (most commonly `[]`) — refuse rather than let
    // every property set below land as a silently-dropped non-index prop.
    if (!isPlainObject(parsed)) return { created: false, changed: false, ok: false, mcpPlurPreserved: false, mcpPlurUpgraded: false, mcpPlurRepaired: false, mcpPlurLocal: false }
    cfg = parsed
  }

  // Same refuse-don't-coerce stance for the two fields this function owns:
  // a PRESENT value of the wrong shape is the user's data, not a blank slate
  // to silently overwrite. `undefined` OR `null` is treated as "not set" for
  // both fields and is not refused.
  if (!validContainers(cfg)) {
    return { created: false, changed: false, ok: false, mcpPlurPreserved: false, mcpPlurUpgraded: false, mcpPlurRepaired: false, mcpPlurLocal: false }
  }

  const before = JSON.stringify(cfg)

  if (options.upgradePlugin !== false) {
    for (const key of ['plugin', 'plugins']) {
      const entries = Array.isArray(cfg[key]) ? cfg[key] as unknown[] : []
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i], spec = pluginSpec(entry), upgraded = upgradePluginSpec(spec)
        if (upgraded === spec) continue
        let path: JSONPath = [key, i]
        if (Array.isArray(entry)) { entry[0] = upgraded; path = [...path, 0] }
        else if (isPlainObject(entry)) { entry.package = upgraded; path = [...path, 'package'] }
        else entries[i] = upgraded
        edits.push({ path, value: upgraded })
      }
    }
  }
  const intent = pluginIntent(pluginEntries(cfg))
  if (!intent.declared && !intent.disabled) {
    const key = Array.isArray(cfg.plugins) ? 'plugins' : 'plugin'
    const existing = Array.isArray(cfg[key])
    const entries = existing ? cfg[key] as unknown[] : []
    entries.push(PLUGIN); cfg[key] = entries
    edits.push({ path: existing ? [key, entries.length - 1] : [key], value: existing ? PLUGIN : entries })
  }

  const rootMcp: Record<string, unknown> = isPlainObject(cfg.mcp) ? cfg.mcp : {}
  const location = mcpLocation(cfg)
  const mcp = location.map
  const mcpPath = location.path
  // A PRESENT, non-null `mcp.plur` is left alone (it may carry a non-default
  // PLUR_PATH or remote-store headers); PLUR's entry is written only when
  // there is nothing there to lose. The exception is our own old npx entry:
  // only its command is upgraded, keeping environment and all other fields.
  // That happens whenever an installed binary is there to launch, and on
  // win32 always: a bare `npx` cannot be spawned shell-less there, so the
  // cmd.exe fallback is a repair too.
  const launch = opencodeMcpLaunch(cliVersion)
  let mcpPlurUpgraded = false
  let mcpPlurRepinned: { from: string; to: string } | undefined
  if ((launch.local || platform() === 'win32') && isOwnLegacyNpxEntry(mcp.plur)) {
    mcp.plur = { ...mcp.plur, command: launch.command }
    mcpPlurUpgraded = true
    edits.push({ path: [...mcpPath, 'plur', 'command'], value: (mcp.plur as { command: string[] }).command })
  } else if (isOwnLegacyNpxEntry(mcp.plur)) {
    // No installed MCP server to launch (macOS/Linux): npx stays, but the pin
    // follows the CLI that ran init, so a global upgrade reaches opencode on
    // the next `plur init`. Same rule as every other writer:
    // an older pin moves, a newer pin is the user's and stays.
    const from = ((mcp.plur as { command: string[] }).command[2]).slice('@plur-ai/mcp@'.length)
    if (from !== cliVersion && olderOrEqual(from, cliVersion)) {
      mcp.plur = { ...mcp.plur, command: launch.command }
      mcpPlurRepinned = { from, to: cliVersion }
      edits.push({ path: [...mcpPath, 'plur', 'command'], value: launch.command })
    }
  }
  // PLUR's own win32 node-form entry is repaired once it has gone stale.
  let mcpPlurRepaired = false
  const repaired = mcpPlurUpgraded ? null : staleOwnWin32NodeCommand(mcp.plur, cliVersion)
  if (repaired) {
    mcp.plur = { ...(mcp.plur as Record<string, unknown>), command: repaired }
    mcpPlurRepaired = true
    edits.push({ path: [...mcpPath, 'plur', 'command'], value: repaired })
  }
  const rewritten = mcpPlurUpgraded || mcpPlurRepaired || mcpPlurRepinned !== undefined
  const mcpPlurPreserved = !rewritten && mcp.plur !== undefined && mcp.plur !== null
  if (!mcpPlurPreserved && !rewritten) {
    mcp.plur = {
      type: 'local',
      command: launch.command,
      ...(location.native ? { disabled: false } : { enabled: true }),
    }
    edits.push({ path: cfg.mcp === null || cfg.mcp === undefined ? ['mcp'] : [...mcpPath, 'plur'], value: cfg.mcp === null || cfg.mcp === undefined ? mcp : mcp.plur })
  }
  if (location.native) rootMcp.servers = mcp
  cfg.mcp = location.native ? rootMcp : mcp

  const changed = JSON.stringify(cfg) !== before
  if (created || changed) {
    // atomicWrite (write tmp → fsync → rename) instead of a direct
    // writeFileSync: writeFileSync opens with O_TRUNC, destroying the
    // existing config before a single byte of the new content is written —
    // a crash, OOM, full disk, or suspend in that window loses a config that
    // can carry many MCP server entries. resolveWriteTarget
    // keeps this a write-through when configPath is itself a symlink.
    let output = created ? JSON.stringify(cfg, null, 2) + '\n' : source
    if (!created) for (const edit of edits) output = applyEdits(output, modify(output, edit.path, edit.value, {}))
    atomicWrite(resolveWriteTarget(configPath), bom + output)
  }
  return {
    created, changed, ok: true, mcpPlurPreserved, mcpPlurUpgraded, mcpPlurRepaired,
    ...(mcpPlurRepinned ? { mcpPlurRepinned } : {}),
    mcpPlurLocal: launch.local && sameCommand((mcp.plur as { command?: unknown } | undefined)?.command, launch.command),
    ...(rewritten ? { mcpPlurCommand: (mcp.plur as { command: string[] }).command } : {}),
  }
}

/**
 * The `plur init` line describing what happened to `mcp.plur`, naming what
 * was actually written when the entry was rewritten: the node.exe launcher,
 * or the pinned `cmd.exe /c npx` fallback used when @plur-ai/mcp's js entry
 * cannot be resolved. Empty when there is nothing to say.
 */
export function opencodeMcpNote(result: WriteOpencodeConfigResult): string {
  const written = result.mcpPlurCommand ?? []
  const form = written[0]?.toLowerCase() === 'cmd.exe'
    ? `the pinned cmd.exe /c npx fallback (@plur-ai/mcp's js entry could not be resolved): ${written.join(' ')}`
    : `the local launcher (node/node.exe + installed @plur-ai/mcp): ${written.join(' ')}`
  if (result.mcpPlurUpgraded) return `\n  mcp.plur: upgraded to ${form}; other fields kept`
  if (result.mcpPlurRepinned) {
    return `\n  mcp.plur: updated the npx pin ${result.mcpPlurRepinned.from} → ${result.mcpPlurRepinned.to}; other fields kept`
  }
  if (result.mcpPlurRepaired) {
    return `\n  mcp.plur: repaired (the node.exe or @plur-ai/mcp path it named was stale), now ${form}; other fields kept`
  }
  // An existing mcp.plur (a non-default PLUR_PATH, or an enterprise remote
  // store with bearer headers) is left untouched. Say so,
  // so the user learns it from init rather than from where writes landed.
  if (result.mcpPlurPreserved) return '\n  mcp.plur: left as-is (an entry already existed — not overwritten)'
  return ''
}
