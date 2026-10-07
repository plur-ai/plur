import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { homedir, platform } from 'os'
import { atomicWrite } from '@plur-ai/core'
import { buildMcpServerEntry, findMcpJsEntry, isOwnWin32NodeEntry, isPathResolvedCommand, missingNodeEntryPaths } from './mcp-config.js'
import { parseJsonc } from './lib/jsonc.js'
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
  /** A stale owned Windows node command was repaired. */
  mcpPlurRepaired: boolean
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
 * The opencode config directory `plur init` writes into, resolved the way
 * opencode resolves it: `OPENCODE_CONFIG_DIR` when set (opencode loads
 * `opencode.json(c)` from that directory on top of the global one), else the
 * global directory `$XDG_CONFIG_HOME/opencode`, falling back to
 * `~/.config/opencode` (opencode's `packages/core/src/global.ts` joins
 * `xdg-basedir`'s `xdgConfig` with "opencode"; `xdg-basedir` treats an empty
 * `XDG_CONFIG_HOME` as unset). Without this, a user with a custom location
 * and a leftover `~/.config/opencode` got a config written where opencode
 * never reads it, and a success line (#1311 review). No per-project
 * variant: one global engram store, one place to register it.
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

/** A duplicate key makes offset edits ambiguous, even if JSON.parse accepts it. */
function unambiguousJsonc(text: string): boolean {
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
 * and never shadowed by a second, bare entry appended after them (#1335).
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
 * SAME shape rules, without duplicating them (see the file-level docstring's
 * warning about the two drifting apart).
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
   * node binary after a Node upgrade (#1339). Empty for a healthy entry, a
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
 * The `mcp.plur.command` array PLUR writes for opencode (a single argv, not
 * `command` + `args` like the other hosts).
 *
 * Prefer Node plus the installed MCP entry recorded by init on every platform.
 * Without it, darwin/linux retain the version-pinned npx fallback (#1069).
 *
 * win32 (#1311): the same entry `buildMcpServerEntry` builds for every other
 * host since #1267 — `<node.exe> <@plur-ai/mcp js entry>` when the entry is
 * resolvable, else the pinned `cmd.exe /c npx …` fallback. Never a bare
 * `npx`: a shell-less spawn on Windows does not resolve it to `npx.cmd`.
 */
export function opencodeMcpCommand(cliVersion: string): string[] {
  const local = findMcpJsEntry()
  if (local) return [process.execPath, local]
  if (platform() === 'win32') {
    const entry = buildMcpServerEntry()
    return [entry.command, ...(entry.args ?? [])]
  }
  return ['npx', '-y', `@plur-ai/mcp@${cliVersion}`]
}

/**
 * Is this the `mcp.plur` npx entry an older `plur init` wrote?
 * Before #1311 it was `{ type: 'local', command: ['npx', '-y',
 * '@plur-ai/mcp@<version>'], enabled: true }` on every platform, and a
 * shell-less spawn on Windows cannot resolve a bare `npx` to `npx.cmd`.
 *
 * Scoped as tightly as `isOwnWin32CmdShimEntry` in mcp-config.ts (#1267): a
 * local entry whose command is exactly those three elements with a pinned
 * version. Any other command (another launcher, extra args, another package,
 * an unpinned spec) or a remote entry is the user's and is never touched.
 * Other fields (`environment`, `timeout`, …) do not disqualify the entry:
 * the upgrade replaces `command` only, so they are kept.
 */
function isOwnLegacyNpxEntry(entry: unknown): entry is Record<string, unknown> {
  if (!isPlainObject(entry)) return false
  if (entry.type !== 'local') return false
  const cmd = entry.command
  return Array.isArray(cmd) && cmd.length === 3 &&
    cmd[0] === 'npx' && cmd[1] === '-y' &&
    typeof cmd[2] === 'string' && /^@plur-ai\/mcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(cmd[2])
}

/** Windows paths compare without regard to slash style, quotes or case. */
function sameWin32Path(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/"/g, '').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * The `command` to repair PLUR's own win32 node-form `mcp.plur` entry to, or
 * null to leave it alone (#1311). The same rules #1270 applies to the Claude
 * Code entry, through its own predicates: the entry must be
 * `[<node(.exe)>, <@plur-ai/mcp js entry>]` (`isOwnWin32NodeEntry`); it is
 * rewritten when a path it names is gone (`missingNodeEntryPaths`), or when
 * today's command is itself the node form and names a different js entry. A working entry is never replaced by the npx fallback, and an entry
 * whose node is PATH-resolved (a bare `node`) is never rewritten. Any
 * other shape — another script, extra args, another launcher — is the
 * user's and is never touched.
 */
function staleOwnWin32NodeCommand(entry: unknown, cliVersion: string): string[] | null {
  if (!isPlainObject(entry) || entry.type !== 'local') return null
  const cmd = entry.command
  if (!Array.isArray(cmd) || cmd.length !== 2 || typeof cmd[0] !== 'string' || typeof cmd[1] !== 'string') return null
  const asEntry = { command: cmd[0], args: [cmd[1]] }
  if (!isOwnWin32NodeEntry(asEntry)) return null
  // A bare `node` resolves through PATH and survives Node upgrades; PLUR
  // never writes one, so it is the user's and is left alone (#1339).
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
 * Resolve the real path to write to. `writeFileSync` used to write THROUGH a
 * symlink (open the target, truncate, write); `atomicWrite`'s rename instead
 * REPLACES whatever sits at the given path — including a symlink itself,
 * which would orphan the file it pointed to and leave a plain file where the
 * symlink was (0.20.0 audit, B3). Dotfiles-managed users symlink
 * `opencode.json` into a dotfiles repo, so resolve to the real target file
 * first and hand atomicWrite THAT path — the rename then lands on the same
 * file `writeFileSync` would have written through to, and the symlink
 * survives untouched.
 *
 * Only meaningful when `path` already exists as a symlink; a path that
 * doesn't exist yet (a fresh config) has nothing to resolve, and
 * `realpathSync` would throw ENOENT on it anyway.
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
 * file-level docstring for the two layers this writes and the JSONC
 * decision. `configPath` may point at an `opencode.json` or an
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
      return { created: false, changed: false, ok: false, mcpPlurPreserved: false, mcpPlurUpgraded: false, mcpPlurRepaired: false }
    }
    // Valid JSON, wrong shape (most commonly `[]`) — refuse rather than let
    // every property set below land as a silently-dropped non-index prop.
    // See WriteOpencodeConfigResult.ok for the full failure mode this closes.
    if (!isPlainObject(parsed)) return { created: false, changed: false, ok: false, mcpPlurPreserved: false, mcpPlurUpgraded: false, mcpPlurRepaired: false }
    cfg = parsed
  }

  // Same refuse-don't-coerce stance for the two fields this function owns:
  // a PRESENT value of the wrong shape is the user's data, not a blank slate
  // to silently overwrite. `undefined` OR `null` is treated as "not set" for
  // both fields, consistently — that's every fresh/untouched config, plus
  // the (uncommon but real) case of a user writing `null` to mean "nothing
  // here yet." Neither is refused.
  if (!validContainers(cfg)) {
    return { created: false, changed: false, ok: false, mcpPlurPreserved: false, mcpPlurUpgraded: false, mcpPlurRepaired: false }
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
  // B2 (0.20.0 audit): see WriteOpencodeConfigResult.mcpPlurPreserved for the
  // full rationale. A PRESENT, non-null `mcp.plur` is left completely alone;
  // PLUR's entry is written only when there is nothing there to lose.
  // Upgrade only the command of our old npx entry, preserving environment
  // and all other user fields. Use the installed package on every platform.
  let mcpPlurUpgraded = false
  if ((platform() === 'win32' || findMcpJsEntry()) && isOwnLegacyNpxEntry(mcp.plur)) {
    mcp.plur = { ...mcp.plur, command: opencodeMcpCommand(cliVersion) }
    mcpPlurUpgraded = true
    edits.push({ path: [...mcpPath, 'plur', 'command'], value: (mcp.plur as { command: string[] }).command })
  }
  // #1311: and PLUR's own win32 node-form entry, once it has gone stale.
  let mcpPlurRepaired = false
  const repaired = mcpPlurUpgraded ? null : staleOwnWin32NodeCommand(mcp.plur, cliVersion)
  if (repaired) {
    mcp.plur = { ...(mcp.plur as Record<string, unknown>), command: repaired }
    mcpPlurRepaired = true
    edits.push({ path: [...mcpPath, 'plur', 'command'], value: repaired })
  }
  const rewritten = mcpPlurUpgraded || mcpPlurRepaired
  const mcpPlurPreserved = !rewritten && mcp.plur !== undefined && mcp.plur !== null
  if (!mcpPlurPreserved && !rewritten) {
    mcp.plur = {
      type: 'local',
      command: opencodeMcpCommand(cliVersion),
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
    // can carry 40+ MCP server entries (0.20.0 audit, B3). resolveWriteTarget
    // keeps this a write-through when configPath is itself a symlink.
    let output = created ? JSON.stringify(cfg, null, 2) + '\n' : source
    if (!created) for (const edit of edits) output = applyEdits(output, modify(output, edit.path, edit.value, {}))
    atomicWrite(resolveWriteTarget(configPath), bom + output)
  }
  return {
    created, changed, ok: true, mcpPlurPreserved, mcpPlurUpgraded, mcpPlurRepaired,
    ...(rewritten ? { mcpPlurCommand: (mcp.plur as { command: string[] }).command } : {}),
  }
}

/**
 * The `plur init` line describing what happened to `mcp.plur`, naming what
 * was actually written when the entry was rewritten: the node.exe launcher,
 * or the pinned `cmd.exe /c npx` fallback used when @plur-ai/mcp's js entry
 * cannot be resolved (#1311 review). Empty when there is nothing to say.
 */
export function opencodeMcpNote(result: WriteOpencodeConfigResult): string {
  const written = result.mcpPlurCommand ?? []
  const form = written[0]?.toLowerCase() === 'cmd.exe'
    ? `the pinned cmd.exe /c npx fallback (@plur-ai/mcp's js entry could not be resolved): ${written.join(' ')}`
    : `the local launcher (node/node.exe + installed @plur-ai/mcp): ${written.join(' ')}`
  if (result.mcpPlurUpgraded) return `\n  mcp.plur: upgraded to ${form}; other fields kept`
  if (result.mcpPlurRepaired) {
    return `\n  mcp.plur: repaired (the node.exe or @plur-ai/mcp path it named was stale), now ${form}; other fields kept`
  }
  // B2 (0.20.0 audit): an existing mcp.plur (a non-default PLUR_PATH, or an
  // enterprise remote store with bearer headers) is left untouched. Say so,
  // so the user learns it from init rather than from where writes landed.
  if (result.mcpPlurPreserved) return '\n  mcp.plur: left as-is (an entry already existed — not overwritten)'
  return ''
}
