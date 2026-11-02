import { readCodexEntry, configuredTokenVariables, codexMcpEnvironment, codexStorageRoot } from '../codex-config.js'
import { CLI_VERSION } from '../version.js'
import { codexConfigTomlPath } from '../mcp-config.js'
import { spawn } from 'child_process'
import { existsSync, readFileSync, realpathSync, statSync, accessSync, constants } from 'fs'
import { join, extname, dirname, resolve } from 'path'
import { homedir, platform } from 'os'
import { createRequire } from 'module'
import { createPlur, type GlobalFlags } from '../plur.js'
import { skippedStoreLines } from './stores.js'
import { outputText, outputInfo, outputJson, shouldOutputJson } from '../output.js'
import {
  type ConfigFile,
  buildMcpServerEntry,
  readPlurMcpEntry,
  type McpServerEntry,
  cursorProjectMcpConfigPath,
  hasDatacoreMcp,
  hasPlurMcp,
  knownConfigFiles,
  readConfig,
  claudeCodeUserConfigPath,
  claudeCodeGlobalSettingsPath,
} from '../mcp-config.js'
import { hasPlurCursorHooks, readCursorHooksConfig } from '../cursor-hooks.js'
import { isPlurHookCommand, isPlurHookSpec } from '../lib/hook-command.js'
import { hasPlurCodexHooks, readCodexHooksConfig } from '../codex-hooks.js'
import { hasPlurAgyHooks, readAgyHooksConfig } from '../antigravity-hooks.js'
import { codexHome, missingNodeEntryPaths, readCodexPlurMcpCommand, isOwnWin32CmdShimCommand } from '../mcp-config.js'
import { opencodeConfigDir, opencodeConfigPath, readOpencodeConfig, PLUR_OPENCODE_PLUGIN } from '../opencode-config.js'
import { computeContentHash, detectPlurStorage, loadEngrams, resolveBackendTier, loadConfig, describeNeedsAction, describeHeld, classifyStoreDuplicates, folderMapProblem, tokenFromEnv, tokenEnvUnsetDetail, tokenEnvUnsetFix, offlineByEnv } from '@plur-ai/core'
import { plurRoot } from '../lib/folder-gate.js'
import { readHookInstalls, readHookRuns, type HookTool } from '../lib/hook-runs.js'
import type { ServerStoreCheck } from '@plur-ai/core'
import { repairAdvice, repairCommandFor } from './folders.js'
import { codexInstalled } from '../lib/codex-binary.js'
import { commandSpawn } from '../lib/command-spawn.js'

/**
 * plur doctor — diagnose a Claude Code / Claude Desktop / Cursor installation.
 * Checks:
 *   1. Hooks in any settings.json, or Cursor's flat `.cursor/hooks.json`.
 *   2. `plur` MCP server registered in a known config file.
 *   3. A `datacore` MCP server alongside it (collision warning).
 *   4. Live MCP handshake (`initialize`, then `tools/list` for the tool count),
 *      run with the default env and with `PLUR_TOOL_PROFILE=cursor`.
 * Exits 0 if everything is healthy, 1 if any check fails.
 */

interface ConfigFileReport {
  label: string
  path: string
  exists: boolean
  hasPlurMcp: boolean
  hasDatacoreMcp: boolean
  hasPlurHooks: boolean
}

interface HookShimReport {
  valid: boolean
  shimPath: string
  error?: string
}

/**
 * Where Claude Code itself would find the `plur` MCP server: user scope
 * (`mcpServers` in ~/.claude.json), local scope for this folder
 * (`projects[<folder>].mcpServers` there), or a project `.mcp.json`. Never
 * ~/.claude/settings.json — Claude Code does not read MCP servers from it;
 * an entry there is reported as `legacySettingsEntry`.
 */
export interface ClaudeCodeMcpReport {
  registered: boolean
  scope: 'user' | 'local' | 'project' | null
  path: string | null
  legacySettingsEntry: boolean
  /** Set when not registered: the command that fixes it. */
  fix?: string
}

interface DoctorReport {
  serverStores?: ServerStoreCheck[]
  hookTrust?: Array<{ tool: HookTool; label: string; ok: boolean; detail: string; fix?: string }>
  configs: ConfigFileReport[]
  hooksInstalled: boolean
  /** A plur MCP server is registered somewhere a harness reads it (settings.json never counts). */
  mcpRegistered: boolean
  claudeCodeMcp: ClaudeCodeMcpReport
  datacoreCollision: boolean
  staleNpxHooks: boolean
  staleNpxMcp: boolean
  /**
   * Config files whose `plur` entry is PLUR's own Windows node form
   * (`{ command: <node.exe>, args: [<@plur-ai/mcp js entry>] }`) and
   * names a path that no longer exists — typically the version-specific
   * node binary after a Node upgrade. Checked statically, so it is reported
   * under `--no-handshake` too, and it fails `overall`.
   */
  brokenNodeMcp: Array<{ label: string; path: string; missing: string[] }>
  hookShim: HookShimReport
  mcpShim: HookShimReport
  /**
   * The live memory-server check. Three outcomes, kept apart: `ok: true` (the
   * server answered: reachable), `ok: false` with `skipped: true` (not run,
   * `--no-handshake`: unverified), `ok: false` without `skipped` (it was run
   * and failed: refused).
   */
  handshake: { ok: boolean; skipped?: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string }
  /**
   * Second handshake, forcing `PLUR_TOOL_PROFILE=cursor`, so the report can show
   * both tool counts side by side rather than guessing which profile a given
   * config file's env is actually wired to. `null` when the default handshake
   * itself failed or was skipped (--no-handshake) — no point probing a second
   * profile if the server doesn't even come up once.
   */
  cursorHandshake: { ok: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string } | null
  embedder: { available: boolean; loaded: boolean; lastError: string | null; modelLoaded: boolean; disabled: boolean; disabledReason: string | null }
  /**
   * Whether the current directory looks like a Cursor project (a `.cursor/`
   * dir exists) and, if so, whether Cursor's OWN config files — not any
   * Claude Code config elsewhere — actually have PLUR wired in. Working
   * Claude Code wiring says nothing about a missing or broken
   * `.cursor/hooks.json` (or a `.cursor/mcp.json` without the cursor tool
   * profile). `cursorWired` is only false when a `.cursor/` project IS
   * detected and its own config is incomplete; it's true (irrelevant) for
   * non-Cursor projects so `overall` isn't affected there.
   */
  cursorProjectDetected: boolean
  cursorWired: boolean
  /**
   * Whether Codex is installed (`~/.codex/`, honouring `CODEX_HOME`) and whether
   * its own `hooks.json` and `config.toml` (`[mcp_servers.plur]`) wire PLUR in.
   * Not folded into `overall` (machine-level detection; see `overall`).
   * `codexWired: true` does NOT mean the hooks run: Codex silently skips
   * unreviewed hooks until trusted via `/hooks`, so `printText` says so.
   */
  codexDetected: boolean
  codexWired: boolean
  /**
   * Codex's config.toml registers a legacy Windows `plur-mcp.cmd` shim,
   * which current Node cannot spawn (`spawn EINVAL`). `plur init --codex`
   * replaces it.
   */
  codexCmdShimMcp: boolean
  /**
   * Windows only: the editors whose PLUR hook path still
   * contains whitespace because no 8.3 short path was available — `plur
   * init` wrote PowerShell's `& "<path>"` (Codex, Cursor) or the plain path
   * (Antigravity, where no quoted form runs). Those hooks may not run.
   * Empty elsewhere and when every hook path is a single unquoted word.
   */
  windowsHookFallback: string[]
  /**
   * Antigravity CLI (agy). Same machine-level detection rationale as Codex —
   * reported as its own line, deliberately NOT folded into `overall`. Unlike
   * Codex there is no trust caveat: agy runs configured hooks immediately.
   */
  agyDetected: boolean
  agyWired: boolean
  /**
   * PGLite backend running the opt-in embedding-gemma embedder. The PGLite
   * backend keys its `engram_embeddings` table on vector DIMENSION only, so
   * it can keep serving vectors computed under embedding-gemma's earlier role
   * prefixes, where the JSON embedding cache rebuilds by itself. Advisory
   * only: it recommends a one-time `plur sync --reembed --full` and never
   * fails the overall check.
   */
  pgliteGemmaReembedNeeded: boolean
  /**
   * Engrams whose `content_hash` does not match `computeContentHash(statement)`;
   * they attract dedup of unrelated re-learns. Usually from non-ASCII text hashed
   * by an ASCII-only normalizer. Advisory only (does not fail the overall
   * check); fix with `plur reindex-hashes --apply`.
   */
  staleContentHashes: number
  /**
   * A `store.pglite` directory the resolved backend tier no longer uses —
   * orphaned disk the user may delete, ideally after `plur migrate` ports its
   * vectors. `null` when there is no such directory or when PGLite IS the
   * selected tier (by env or config.yaml — resolved through
   * resolveBackendTier). In the report struct, not just the text renderer,
   * so `--json` consumers see the advisory too. Advisory only: does not fail
   * the overall check.
   */
  pgliteOrphan: { path: string } | null
  /**
   * Local store entries in config.yaml that are ignored at load: the entry
   * names the primary engrams file (`primary: true`,
   * removable with `plur stores prune`), or repeats an earlier entry's file
   * and scope. The same list `Plur.ignoredDuplicateStores()` returns, computed
   * from config.yaml without opening the stores. Advisory only: does not fail
   * the overall check.
   */
  ignoredDuplicateStores: Array<{ path: string; scope: string; duplicateOf: string; primary: boolean }>
  /**
   * Project stores (`.plur/engrams.yaml`) found from this folder but not
   * added, because their folder has no decision of its own. Advisory only:
   * does not fail the overall check.
   */
  skippedProjectStores: Array<{ path: string; folder: string }>
  /**
   * Remote stores whose token comes from an environment variable
   * (`token_env`) that is unset or empty where doctor runs. Saves to such a
   * store wait in the outbox and recalls skip it. Names the variable, never a
   * value. It fails the overall check, as the MCP `plur_doctor` does, with the
   * same `detail` and `fix`.
   */
  tokenEnvUnset: Array<{ scope: string; url: string; variable: string; detail: string; fix: string }>
  /**
   * The `token_env` stores whose variable IS set, and where: this shell
   * (`inShell`), and/or the `env` of a PLUR MCP entry an
   * editor launches the server with (`sources`). A variable set only in an
   * entry works for that editor's server, so it is not a failure; `plur`
   * commands run from this shell still lack it. Never holds a value.
   */
  tokenEnvFound: Array<{ scope: string; url: string; variable: string; inShell: boolean; sources: string[] }>
  /**
   * opencode leg: a bare `plugin` name that fails to resolve at startup fails
   * with no error anywhere, so this is the only place a user can learn their
   * memory silently isn't loading. `null` when opencode isn't used on this
   * machine. Not folded into `overall`: like Codex, it is machine-level.
   */
  opencode: OpencodeReport | null
  /**
   * Queued team writes. `ok` is false when any entry is
   * `needs_action` — refused in a way retrying cannot fix (401/403/404/422, a
   * write refusal, no writable store) — and that FAILS `overall`: those
   * writes will never leave this machine as things stand, which is the
   * silent failure doctor exists to catch. Entries that only failed on the
   * network are `retrying` and do not. `null` when the store could not be read.
   */
  outbox?: {
    ok: boolean
    pending: number
    retrying: number
    needs_action: number
    scopes: Array<{ scope: string; count: number; reason: string; next_step: string }>
    /** Entries held on this machine for a stated reason. */
    held?: Array<{ count: number; reason: string; next_step: string }>
    /** With writes queued: why the push-claims folder cannot be written. */
    claims_problem?: string
  } | null
  /**
   * The folder map (`folders.yaml`) when it exists but cannot be used:
   * where, what in plain words, and whether `plur folders repair` fixes it.
   * While it is broken every memory surface pauses (fail safe), so this FAILS
   * `overall`. `null` when the map is fine or absent.
   */
  folderMap?: {
    file: string
    problem: string
    line?: number
    column?: number
    fixable: boolean
    /** The command that fixes it, when it can. */
    repair?: string
    /** What that repair changes (lines and keys, no values). */
    repair_summary?: string
  } | null
  /**
   * `ok`: every check passed, including the live memory-server handshake.
   * `fail`: a check failed (a handshake that was run and refused included).
   * `unverified`: every check that ran passed, but the memory connection was
   * not checked (`--no-handshake`), so the doctor cannot call it ok. Only
   * `ok` exits 0, as for `plur doctor --codex`.
   */
  overall: 'ok' | 'fail' | 'unverified'
}

interface OpencodeReport {
  /** The config file doctor read — `opencodeConfigPath()`'s result (.json, or .jsonc when only that exists). */
  configPath: string
  /** Whether `configPath` itself exists (the directory can exist without it — see buildOpencodeReport). */
  exists: boolean
  /**
   * False when the file exists but PLUR's declarations can't be safely read
   * out of it (invalid JSON, wrong top-level shape, or a malformed
   * `plugin`/`mcp` field) — mirrors `OpencodeConfigSnapshot.ok` /
   * `WriteOpencodeConfigResult.ok` one-for-one.
   */
  ok: boolean
  /** `plugin: [...]` includes `@plur-ai/opencode` — the automatic memory layer. */
  pluginDeclared: boolean
  pluginDisabled?: boolean
  /** Resolution is not proof that the host loaded the plugin. */
  pluginLoadVerified?: false
  pluginUpgrade?: { from: string; to: string }
  /** `mcp.plur` is present — the explicit `plur_*` tool surface. */
  mcpPlurDeclared: boolean
  mcpPlurDisabled?: boolean
  /**
   * Paths PLUR's own win32 node-form `mcp.plur` entry names that no longer
   * exist — the version-specific node binary after a Node upgrade.
   * `plur init` rewrites such an entry. Empty when healthy.
   */
  mcpPlurMissingPaths: string[]
  /**
   * Whether the declared plugin will resolve when opencode starts (the
   * load-bearing check):
   *  - 'not-declared': `pluginDeclared` is false — nothing to check.
   *  - 'yes': local install or the npm registry serves it (see `resolvedVia`).
   *  - 'no': no local install and a definitive registry 404; it will not load.
   *  - 'unknown': undetermined (offline, timeout, ambiguous response, or
   *    `--no-handshake`); never coerced to 'yes' or 'no'.
   */
  pluginResolvable: 'not-declared' | 'yes' | 'no' | 'unknown'
  /** Where a 'yes' verdict came from. `null` for every other `pluginResolvable` value. */
  resolvedVia: 'local install' | 'npm registry' | null
}

function hasAnyPlurHook(config: Record<string, unknown>): boolean {
  const hooks = (config.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string; args?: unknown }> }>>
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        // The same matcher init uses: PLUR's launcher (shim, npx, or the
        // Windows exec form) plus any hook-*.
        if (isPlurHookSpec(h)) return true
      }
    }
  }
  return false
}

/** Test seam. */
export const _hasAnyPlurHook = hasAnyPlurHook

/** Every string under a `command` key, anywhere in a parsed hooks file. */
function collectHookCommands(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) collectHookCommands(v, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'command' && typeof v === 'string') out.push(v)
      else collectHookCommands(v, out)
    }
  }
  return out
}

/**
 * The string-hook editors (Cursor, Codex, Antigravity) whose PLUR hook
 * launcher path still contains whitespace — the fallback `plur init` writes
 * on Windows when no 8.3 short path exists. Such a hook relies
 * on PowerShell's `& "<path>"` (Codex, Cursor) or cannot run at all
 * (Antigravity, whose `cmd /C` escapes quotes).
 */
function windowsHookFallbackEditors(configs: ConfigFileReport[]): string[] {
  const editors: Array<[string, string]> = [
    ['Cursor', 'Cursor (.cursor/hooks.json)'],
    ['Codex', 'Codex (~/.codex/hooks.json)'],
    ['Antigravity', 'Antigravity (~/.gemini/config/hooks.json)'],
  ]
  const out: string[] = []
  for (const [name, label] of editors) {
    const c = configs.find((x) => x.label === label)
    if (!c?.exists) continue
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(c.path, 'utf8')) } catch { continue }
    const fallback = collectHookCommands(parsed).some((cmd) => {
      if (!isPlurHookCommand(cmd)) return false
      const launcher = cmd.slice(0, cmd.search(/\shook-[a-z0-9]/i)).replace(/^&\s+/, '').replace(/"/g, '')
      return /\s/.test(launcher)
    })
    if (fallback) out.push(name)
  }
  return out
}

function hasStaleNpxHooks(config: Record<string, unknown>): boolean {
  const hooks = (config.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (h.command && h.command.includes('npx') && h.command.includes('@plur-ai/cli')) return true
      }
    }
  }
  return false
}

/**
 * Detect stale npx-based MCP server registration. Returns true if
 * the plur MCP entry uses npx instead of the local shim.
 *
 * The args[] check catches both layouts we ship: `cmd.exe /c npx ...` on
 * Windows and `/bin/sh -lc 'exec npx -y @plur-ai/mcp@latest'` on unix.
 */
function hasStaleNpxMcp(config: Record<string, unknown>): boolean {
  const servers = (config.mcpServers ?? {}) as Record<string, { command?: string; args?: string[] }>
  const plur = servers.plur
  if (!plur) return false
  if (plur.command && plur.command.includes('npx')) return true
  const argsBlob = (plur.args ?? []).join(' ')
  return argsBlob.includes('npx') && argsBlob.includes('@plur-ai/mcp')
}

/** Mirror of validateHookShim() for the MCP shim. */
function validateMcpShim(): HookShimReport {
  const name = platform() === 'win32' ? 'plur-mcp.cmd' : 'plur-mcp'
  const path = join(homedir(), '.plur', 'bin', name)

  if (!existsSync(path)) {
    return { valid: false, shimPath: path, error: 'shim not found — run `plur init` to create it (requires @plur-ai/mcp installed alongside CLI)' }
  }

  const content = readFileSync(path, 'utf-8')
  const match = content.match(/"([^"]+index\.js)"/)
  if (!match) {
    return { valid: false, shimPath: path, error: 'shim has unexpected format' }
  }

  if (!existsSync(match[1])) {
    return { valid: false, shimPath: path, error: `entrypoint missing: ${match[1]} — run \`plur init\` to fix` }
  }

  return { valid: true, shimPath: path }
}

function validateHookShim(): HookShimReport {
  const name = platform() === 'win32' ? 'plur-hook.cmd' : 'plur-hook'
  const path = join(homedir(), '.plur', 'bin', name)

  if (!existsSync(path)) {
    return { valid: false, shimPath: path, error: 'shim not found — run `plur init` to create it' }
  }

  const content = readFileSync(path, 'utf-8')
  const match = content.match(/"([^"]+index\.js)"/)
  if (!match) {
    return { valid: false, shimPath: path, error: 'shim has unexpected format' }
  }

  if (!existsSync(match[1])) {
    return { valid: false, shimPath: path, error: `entrypoint missing: ${match[1]} — run \`plur init\` to fix` }
  }

  return { valid: true, shimPath: path }
}

/**
 * Is `path` a regular file that's actually executable? Used to validate a
   * committed `.cursor/mcp.json`'s absolute-path command: existsSync alone
   * can't tell a runnable shim apart from a directory, a 0-byte file, or a
   * file stripped of its execute bit — all of which would still spawn-fail.
 */
function commandIsExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Count engrams whose `content_hash` does not match the current
 * `computeContentHash(statement)` result. Pure read — no writes, no
 * lock. Errors (missing store, unreadable file) return 0 so a fresh install
 * with no engrams file does not surface a spurious advisory.
 */
function countStaleContentHashes(flags: GlobalFlags): number {
  try {
    const paths = detectPlurStorage(flags.path || process.env.PLUR_PATH || undefined)
    const engrams = loadEngrams(paths.engrams)
    let count = 0
    for (const e of engrams) {
      if (!e.statement) continue
      const stored = (e as { content_hash?: string }).content_hash
      if (stored && stored !== computeContentHash(e.statement)) count++
    }
    return count
  } catch {
    return 0
  }
}

/** Classify the outbox. Local read only; never throws. */
async function checkOutbox(flags: GlobalFlags): Promise<DoctorReport['outbox']> {
  try {
    // Discovery off: doctor only looks, so its
    // constructor must not register a project store or import trust.yaml.
    const plur = createPlur(flags, { readonly: true, autoDiscover: false })
    const summary = await plur.outboxSummary()
    // A push claim that cannot be recorded holds every queued write here.
    // Checked only when something is queued.
    const claims_problem = summary.pending > 0 ? plur.outboxClaimsProblem() : undefined
    return { ok: summary.needs_action === 0 && !claims_problem, ...summary, ...(claims_problem ? { claims_problem } : {}) }
  } catch {
    return null
  }
}

async function checkServers(flags: GlobalFlags): Promise<ServerStoreCheck[]> {
  let plur: ReturnType<typeof createPlur> | undefined
  try {
    plur = createPlur(flags, { readonly: true, autoDiscover: false })
    return await plur.checkServerStores()
  } catch {
    return [{ url: 'configuration', ok: false, checks: [{ name: 'reachable', result: 'could-not-check', detail: 'server diagnostics could not be completed' }] }]
  } finally { plur?.close() }
}

/**
 * The config.yaml store entries a Plur instance would ignore at load.
 * Reads config.yaml only — no store is opened and no directory is created.
 */
function findIgnoredDuplicateStores(flags: GlobalFlags): DoctorReport['ignoredDuplicateStores'] {
  try {
    const root = flags.path || process.env.PLUR_PATH || join(homedir(), '.plur')
    const stores = loadConfig(join(root, 'config.yaml')).stores ?? []
    return classifyStoreDuplicates(stores, join(root, 'engrams.yaml')).ignored.map(d => ({
      path: d.entry.path ?? '', scope: d.entry.scope, duplicateOf: d.duplicateOf, primary: d.primary,
    }))
  } catch {
    return []
  }
}

/**
 * Project stores found from the working folder but not added for lack of
 * their folder's own decision. Read-only: discovery is off
 * for this instance, so nothing is registered by looking.
 */
function findSkippedProjectStores(flags: GlobalFlags): DoctorReport['skippedProjectStores'] {
  try {
    return createPlur(flags, { readonly: true, autoDiscover: false }).skippedProjectStores(process.cwd())
  } catch {
    return []
  }
}

/**
 * The `env` of every PLUR MCP entry an editor launches:
 * Claude Code's (~/.claude.json, or this folder's local / project scope),
 * then the other harnesses' files. A settings.json entry, which nothing
 * launches, is left out. The same files the handshake probes.
 */
function declaredPlurMcpEnvs(): Array<{ source: string; env: Record<string, string> }> {
  const out: Array<{ source: string; env: Record<string, string> }> = []
  try {
    const cc = claudeCodePlurEntry(process.cwd())
    const ccEntry = cc ? readPlurMcpEntry(cc.config) : null
    if (cc && ccEntry) out.push({ source: `Claude Code MCP entry (${cc.path})`, env: ccEntry.env ?? {} })
    for (const cf of knownConfigFiles()) {
      if (!cf.exists || cf.kind === 'cursor-hooks' || cf.kind === 'claude-user' || isClaudeSettingsFile(cf.path)) continue
      const e = readPlurMcpEntry(readConfig(cf.path))
      if (e && !out.some(o => o.source.endsWith(`(${cf.path})`))) out.push({ source: `${cf.label} MCP entry (${cf.path})`, env: e.env ?? {} })
    }
  } catch { /* an unreadable config file names no source */ }
  return out
}

/**
 * The remote stores in config.yaml that take their token from an
 * environment variable, split by whether the PLUR MCP server will see it —
 * set in this shell, or in the `env` of an MCP entry an editor launches it
 * with (the MCP plur_doctor runs with that env).
 * Reads config files only; no store is opened, no value is kept.
 */
function findTokenEnv(flags: GlobalFlags): { unset: DoctorReport['tokenEnvUnset']; found: DoctorReport['tokenEnvFound'] } {
  const unset: DoctorReport['tokenEnvUnset'] = []
  const found: DoctorReport['tokenEnvFound'] = []
  try {
    const root = flags.path || process.env.PLUR_PATH || join(homedir(), '.plur')
    const stores = loadConfig(join(root, 'config.yaml')).stores ?? []
    const entries = declaredPlurMcpEnvs()
    for (const s of stores) {
      if (!s.url || !s.token_env) continue
      const inShell = tokenFromEnv(s.token_env) !== undefined
      // An inline token in the file wins over the variable (core's rule).
      if (!inShell && s.token) continue
      const sources = entries.filter(e => tokenFromEnv(s.token_env, e.env) !== undefined).map(e => e.source)
      if (inShell || sources.length > 0) {
        found.push({ scope: s.scope, url: s.url, variable: s.token_env, inShell, sources: inShell ? ['this shell', ...sources] : sources })
      } else {
        unset.push({
          scope: s.scope, url: s.url, variable: s.token_env,
          detail: tokenEnvUnsetDetail(s.token_env, s.scope), fix: tokenEnvUnsetFix(s.url, s.token_env),
        })
      }
    }
  } catch { /* no config: nothing to report */ }
  return { unset, found }
}

function inspectConfigs(): ConfigFileReport[] {
  return knownConfigFiles().map((cf: ConfigFile) => {
    if (!cf.exists) {
      return {
        label: cf.label,
        path: cf.path,
        exists: false,
        hasPlurMcp: false,
        hasDatacoreMcp: false,
        hasPlurHooks: false,
      }
    }
    if (cf.kind === 'cursor-hooks') {
      // Cursor's hooks.json is a flat { event: [{command, ...}] } shape, not
      // Claude Code's nested { matcher, hooks: [...] } wrapper — hasAnyPlurHook
      // would silently read it as "no hooks installed" even when they are.
      const hooksConfig = readCursorHooksConfig(cf.path)
      return {
        label: cf.label,
        path: cf.path,
        exists: true,
        hasPlurMcp: false,
        hasDatacoreMcp: false,
        hasPlurHooks: hasPlurCursorHooks(hooksConfig),
      }
    }
    if (cf.kind === 'agy-hooks') {
      // agy's hooks.json is a map of NAMED hook sets — neither Claude Code's
      // nested shape nor Cursor's flat one. PLUR-present = our named key exists.
      const hooksConfig = readAgyHooksConfig(cf.path)
      return {
        label: cf.label,
        path: cf.path,
        exists: true,
        hasPlurMcp: false,
        hasDatacoreMcp: false,
        hasPlurHooks: hasPlurAgyHooks(hooksConfig),
      }
    }
    if (cf.kind === 'codex-hooks') {
      const hooksConfig = readCodexHooksConfig(cf.path)
      return {
        label: cf.label,
        path: cf.path,
        exists: true,
        hasPlurMcp: false,
        hasDatacoreMcp: false,
        hasPlurHooks: hasPlurCodexHooks(hooksConfig),
      }
    }
    if (cf.kind === 'codex-toml') {
      // config.toml is TOML, not JSON — readConfig() would return {} and the
      // report would claim Codex has no MCP server registered even when it
      // does. We only need one fact from this file (is there an
      // `[mcp_servers.plur]` table?), which a targeted regex answers without
      // pulling in a TOML parser. Deliberately narrow: a commented-out line
      // must not count, and neither must `[mcp_servers.plurality]`.
      let hasPlur = false
      try {
        const raw = readFileSync(cf.path, 'utf8')
        hasPlur = /^\s*\[mcp_servers\.plur\]\s*$/m.test(raw)
          || /^\s*\[mcp_servers\]/m.test(raw) && /^\s*plur\s*=/m.test(raw)
      } catch { /* unreadable — report as absent */ }
      return {
        label: cf.label,
        path: cf.path,
        exists: true,
        hasPlurMcp: hasPlur,
        hasDatacoreMcp: false,
        hasPlurHooks: false,
      }
    }
    const config = readConfig(cf.path)
    return {
      label: cf.label,
      path: cf.path,
      exists: true,
      hasPlurMcp: hasPlurMcp(config),
      hasDatacoreMcp: hasDatacoreMcp(config),
      hasPlurHooks: hasAnyPlurHook(config),
    }
  })
}

/**
 * The MCP entry doctor should launch: the first one declared in
 * `knownConfigFiles()` order, so the probe exercises the server the user runs.
 * Falls back to the synthesised recommendation only when nothing is declared;
 * probing it on a configured install could hide a crashing server behind a
 * good npx copy, or time out a working local build.
 */
function resolveProbeTarget(): { entry: McpServerEntry; source: string } {
  // Probe what Claude Code launches first: ~/.claude.json (user, then
  // this folder's local scope), then the other harnesses' files; a
  // settings.json entry, which nothing launches, only as a last resort.
  const files = knownConfigFiles().filter(cf => cf.exists && cf.kind !== 'cursor-hooks')
  const cc = claudeCodePlurEntry(process.cwd())
  const ccEntry = cc ? readPlurMcpEntry(cc.config) : null
  if (cc && ccEntry) return { entry: ccEntry, source: `Claude Code (${cc.scope} scope, ${cc.path})` }
  const ordered = [
    ...files.filter(cf => cf.kind !== 'claude-user' && !isClaudeSettingsFile(cf.path)),
    ...files.filter(cf => isClaudeSettingsFile(cf.path)),
  ]
  for (const cf of ordered) {
    const declared = readPlurMcpEntry(readConfig(cf.path))
    if (declared) return { entry: declared, source: isClaudeSettingsFile(cf.path) ? `${cf.label} — not read by Claude Code` : cf.label }
  }
  return { entry: buildMcpServerEntry(), source: 'recommended default (no config declares a plur server)' }
}

/**
 * Spawn the configured plur MCP server, send `initialize` then `tools/list`;
 * resolves with name, version and tool count, or an error on timeout, crash
 * or invalid response. `envOverride` forces env vars (e.g. `PLUR_TOOL_PROFILE:
 * 'cursor'`) on the child without touching `process.env`.
 * 20-second timeout: a first-run npx fetch can take 10-15s.
 */
async function mcpHandshake(
  timeoutMs = 20000,
  envOverride?: Record<string, string>,
  target?: { entry: McpServerEntry; source: string; env: NodeJS.ProcessEnv; cwd?: string },
): Promise<{ ok: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string; probed?: string; command?: string }> {
  const { entry, source } = target ?? resolveProbeTarget()
  // The entry's own env matters: a config pinning PLUR_TOOL_PROFILE=full gets a
  // different tool surface, and probing without it would report a count the
  // user never sees. envOverride still wins — it is how the cursor-profile
  // probe asks a deliberate what-if.
  const spawnEnv = target ? target.env : (entry.env || envOverride)
    ? { ...process.env, ...(entry.env ?? {}), ...(envOverride ?? {}) }
    : undefined

  return new Promise((resolve) => {
    let resolved = false
    const finish = (result: { ok: boolean; serverName?: string; serverVersion?: string; toolCount?: number; error?: string }) => {
      // Always say WHAT was probed — a handshake verdict with no subject is how
      // a green result on the wrong server gets trusted.
      result = { ...result, probed: source, command: [entry.command, ...entry.args].join(' ') } as typeof result
      if (resolved) return
      resolved = true
      try { proc.kill() } catch { /* ignore */ }
      resolve(result)
    }

    let proc: ReturnType<typeof spawn>
    try {
      // On Windows a configured `npx` or `.cmd` cannot be spawned directly
      // (ENOENT / EINVAL); resolve it the way init runs Codex.
      const spec = target ? { file: entry.command, args: entry.args, windowsVerbatimArguments: false } : commandSpawn(entry.command, entry.args)
      proc = spawn(spec.file, spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(spec.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        ...(spawnEnv ? { env: spawnEnv } : {}),
        ...(target?.cwd ? { cwd: target.cwd } : {}),
      })
    } catch (err: unknown) {
      finish({ ok: false, error: `spawn failed: ${(err as Error).message}` })
      return
    }

    const timeout = setTimeout(() => {
      finish({ ok: false, error: `timeout after ${timeoutMs}ms — server did not respond to initialize` })
    }, timeoutMs)

    let buffer = ''
    let serverInfo: { name?: string; version?: string } | null = null
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id === 1 && msg.result) {
            serverInfo = msg.result.serverInfo ?? {}
            proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
            proc.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
            continue
          }
          if (msg.id === 1 && msg.error) {
            clearTimeout(timeout)
            finish({ ok: false, error: `server error: ${msg.error.message ?? JSON.stringify(msg.error)}` })
            return
          }
          if (msg.id === 2 && msg.result) {
            clearTimeout(timeout)
            finish({
              ok: true,
              serverName: serverInfo?.name,
              serverVersion: serverInfo?.version,
              toolCount: Array.isArray(msg.result.tools) ? msg.result.tools.length : undefined,
            })
            return
          }
          if (msg.id === 2 && msg.error) {
            if (target) { finish({ ok: false, error: 'tools/list failed' }); return }
            // tools/list failed but initialize succeeded — still report as healthy, just without a count.
            clearTimeout(timeout)
            finish({ ok: true, serverName: serverInfo?.name, serverVersion: serverInfo?.version })
            return
          }
        } catch {
          // Not a JSON-RPC frame — likely a startup banner. Ignore.
        }
      }
    })

    proc.on('error', (err: Error) => {
      clearTimeout(timeout)
      finish({ ok: false, error: `spawn error: ${err.message}` })
    })

    proc.on('exit', (code: number | null) => {
      if (!resolved) {
        clearTimeout(timeout)
        finish({ ok: false, error: `server exited (code=${code}) before responding` })
      }
    })

    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'plur-doctor', version: '0.8.1' },
      },
    }
    proc.stdin?.write(JSON.stringify(initRequest) + '\n')
  })
}

/**
 * Resolve the CLI's JavaScript entry path for subprocess spawning.
 *
 * `process.argv[1]` is the script Node was told to run, but:
 *   - npx/global installs route through bin shims (often symlinks)
 *   - pkg/bun/nexe compile the entire CLI into a single binary — no .js file exists
 *
 * Strategy: realpath the argv[1] symlink chain, then check the extension.
 * If the resolved path is not a Node-executable script, return null and let
 * the caller fall back gracefully.
 */
function resolveCliJsEntry(): string | null {
  const argv1 = process.argv[1]
  if (!argv1) return null
  let resolved: string
  try {
    resolved = realpathSync(argv1)
  } catch {
    return null
  }
  const ext = extname(resolved).toLowerCase()
  if (ext !== '.js' && ext !== '.mjs' && ext !== '.cjs') return null
  return resolved
}

// 300s: on a FRESH install this probe is the only sanctioned path that
// downloads the ~133MB embedding model — the hooks race an 8s deadline and
// force-exit, so they can never complete it, and there is no resume. A short
// timeout on a slow connection would leave hybrid permanently unavailable.
const DEFAULT_PROBE_TIMEOUT_MS = 300_000

/**
 * Resolve the probe timeout from PLUR_DOCTOR_TIMEOUT (seconds). Invalid values
 * (garbage, empty string, zero, negative) fall back to the default — a NaN
 * delay would make setTimeout fire after 1ms, instantly failing the probe
 * with a spurious "probe timeout". Exported for tests.
 */
export function resolveProbeTimeoutMs(envValue = process.env.PLUR_DOCTOR_TIMEOUT): number {
  const parsed = Number.parseInt(envValue ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : DEFAULT_PROBE_TIMEOUT_MS
}

/**
 * Probe the embedder in a subprocess: onnxruntime-node can SIGABRT on macOS
 * at exit, which in-process would make doctor exit 134; a dead probe is
 * reported as degraded instead.
 * Timeout: DEFAULT_PROBE_TIMEOUT_MS (cold model downloads can take minutes);
 * override with PLUR_DOCTOR_TIMEOUT (seconds).
 */
async function checkEmbedder(_flags: GlobalFlags, timeoutMs = resolveProbeTimeoutMs()): Promise<{ available: boolean; loaded: boolean; lastError: string | null; modelLoaded: boolean; disabled: boolean; disabledReason: string | null }> {
  return new Promise((resolve) => {
    const fallback = (lastError: string) => ({
      available: false,
      loaded: false,
      lastError,
      modelLoaded: false,
      disabled: false,
      disabledReason: null,
    })

    const cliEntry = resolveCliJsEntry()
    if (!cliEntry) {
      // Compiled binary, missing entry, or unresolvable symlink. We can't spawn
      // a subprocess that re-enters the CLI. Report skipped — the user will
      // see this in the doctor output and know to investigate manually.
      resolve(fallback('embedder probe skipped: CLI entry is not a JS file (compiled binary?)'))
      return
    }

    let resolved = false
    const finish = (result: ReturnType<typeof fallback>) => {
      if (resolved) return
      resolved = true
      try { proc.kill() } catch { /* ignore */ }
      resolve(result)
    }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(process.execPath, [cliEntry, '_embedder-probe'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        // Mark the subprocess as the parent-spawned probe — the probe checks
        // this and refuses to run if invoked directly by a curious user.
        env: { ...process.env, PLUR_INTERNAL_PROBE: '1' },
      })
    } catch (err: unknown) {
      finish(fallback(`spawn failed: ${(err as Error).message}`))
      return
    }

    const timeout = setTimeout(() => {
      finish(fallback(`probe timeout after ${timeoutMs}ms`))
    }, timeoutMs)

    let stdoutBuf = ''
    let stderrBuf = ''
    proc.stdout?.on('data', (chunk: Buffer) => { stdoutBuf += chunk.toString('utf8') })
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8') })

    proc.on('error', (err: Error) => {
      clearTimeout(timeout)
      finish(fallback(`probe spawn error: ${err.message}`))
    })

    proc.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timeout)
      // Parse the LAST line starting with `{` — defends against any stdout
      // pollution (logs, warnings) that might precede the result line.
      const lines = stdoutBuf.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'))
      const resultLine = lines[lines.length - 1]
      if (resultLine) {
        try {
          const parsed = JSON.parse(resultLine)
          finish({
            available: !!parsed.available,
            loaded: !!parsed.loaded,
            lastError: parsed.lastError ?? null,
            modelLoaded: !!parsed.modelLoaded,
            disabled: !!parsed.disabled,
            disabledReason: parsed.disabledReason ?? null,
          })
          return
        } catch { /* fall through */ }
      }
      // No parseable output — crash or timeout. Report degraded with diagnostics.
      const detail = signal ? `signal ${signal}` : `exit ${code}`
      const stderrTrim = stderrBuf.trim().slice(0, 200)
      finish(fallback(`embedder probe failed (${detail})${stderrTrim ? `: ${stderrTrim}` : ''}`))
    })
  })
}

/**
 * Best-effort check that Node module resolution finds `pkg` from opencode's
 * config directory or the home directory.
 * - Not `process.cwd()`: the operator's directory is unrelated to where
 *   opencode resolves plugins and would give false "local install" answers.
 * - Does not see Bun-only global installs or Bun's cache (undocumented layout).
 * `true` is confident; `false` is not proof — the registry check decides.
 */
function opencodePluginLocallyResolvable(pkg: string): boolean {
  const req = createRequire(import.meta.url)
  const candidateDirs = [opencodeConfigDir(), homedir()]
  for (const dir of candidateDirs) {
    try {
      req.resolve(pkg, { paths: [dir] })
      return true
    } catch {
      // Not found from this root — try the next one.
    }
  }
  return false
}

/**
 * Bounded npm-registry lookup (`registry.npmjs.org/<pkg>/latest`) for whether
 * `pkg` is published. A 404 guarantees opencode's bare-name fetch fails; a 200
 * does not guarantee success. Timeouts, DNS, 5xx and aborts map to 'unknown'.
 * Not reusing core's `checkForUpdate`: it conflates 404 with network errors.
 * 3s timeout so doctor never visibly hangs. Exported for tests.
 */
export async function checkOpencodePluginPublished(
  pkg: string = PLUR_OPENCODE_PLUGIN,
  timeoutMs = 3000,
): Promise<'published' | 'not-published' | 'unknown'> {
  // Declared offline (PLUR_OFFLINE, HF_HUB_OFFLINE, TRANSFORMERS_OFFLINE):
  // no request at all, and the honest answer is that we cannot tell.
  if (offlineByEnv()) return 'unknown'
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (res.status === 404) return 'not-published'
    if (res.ok) return 'published'
    return 'unknown'
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Build the opencode leg of the report. Returns `null` when opencode isn't
 * in use on this machine at all (don't warn a non-user about a tool they
 * don't have) — neither its global config directory nor
 * its config file exists.
 *
 * `skipNetworkCheck` (wired to `--no-handshake`, the flag that already means
 * "skip live/network verification" for the MCP handshake) skips the npm
 * registry lookup so tests — and any offline run — get a deterministic
 * 'unknown' instead of a real network call, never a silently wrong 'no'.
 */
async function buildOpencodeReport(skipNetworkCheck: boolean): Promise<OpencodeReport | null> {
  const dirExists = existsSync(opencodeConfigDir())
  const configPath = opencodeConfigPath()
  const snapshot = readOpencodeConfig(configPath)

  if (!dirExists && !snapshot.exists) return null

  let pluginResolvable: OpencodeReport['pluginResolvable'] = 'not-declared'
  let resolvedVia: OpencodeReport['resolvedVia'] = null

  if (snapshot.pluginDeclared) {
    if (opencodePluginLocallyResolvable(PLUR_OPENCODE_PLUGIN)) {
      pluginResolvable = 'yes'
      resolvedVia = 'local install'
    } else if (skipNetworkCheck) {
      pluginResolvable = 'unknown'
    } else {
      const registry = await checkOpencodePluginPublished(PLUR_OPENCODE_PLUGIN)
      if (registry === 'published') {
        pluginResolvable = 'yes'
        resolvedVia = 'npm registry'
      } else if (registry === 'not-published') {
        pluginResolvable = 'no'
      } else {
        pluginResolvable = 'unknown'
      }
    }
  }

  return {
    configPath,
    exists: snapshot.exists,
    ok: snapshot.ok,
    pluginDeclared: snapshot.pluginDeclared,
    pluginLoadVerified: false,
    ...(snapshot.pluginDisabled ? { pluginDisabled: true } : {}),
    ...(snapshot.mcpPlurDisabled ? { mcpPlurDisabled: true } : {}),
    ...(snapshot.pluginUpgrade ? { pluginUpgrade: snapshot.pluginUpgrade } : {}),
    mcpPlurDeclared: snapshot.mcpPlurDeclared,
    mcpPlurMissingPaths: snapshot.mcpPlurMissingPaths,
    pluginResolvable,
    resolvedVia,
  }
}

/**
 * Which harnesses actually carry PLUR hooks, named by the config file's label
 * ("Claude Code (global)" → "Claude Code"). `hooksInstalled` alone is a
 * `.some()` over the Cursor, Codex and Antigravity files too, so it cannot
 * say which harness is ready.
 */
export function hookHarnesses(configs: Array<{ label: string; hasPlurHooks: boolean }>): string[] {
  const names = configs.filter(c => c.hasPlurHooks).map(c => c.label.replace(/\s*\(.*$/, ''))
  return [...new Set(names)]
}

/**
 * The healthy verdict, naming only harnesses whose hooks are installed.
 * `unwired` names editors installed on this machine that PLUR is not wired
 * into (today: Codex). They stay advisory — the exit code does not change —
 * but the closing line names them instead of reading as plain "Healthy".
 */
export function readyLine(harnesses: string[], unwired: string[] = []): string {
  if (!unwired.length) {
    if (harnesses.includes('Claude Code')) return '✓ Healthy. plur is ready to use in Claude Code.'
    const where = harnesses.length ? harnesses.join(', ') : 'no harness'
    return `✓ Healthy. plur is ready to use in ${where}. Claude Code has no plur hooks — run \`plur init\` to add them.`
  }
  const where = harnesses.length ? harnesses.join(', ') : 'no editor'
  const names = unwired.join(', ')
  const fixes = unwired.map(n => `\`plur init --${n.toLowerCase()}\``).join(', ')
  return `⚠ plur is ready to use in ${where}, but NOT in ${names}: it is installed and PLUR is not wired into it. Fix: run ${fixes}.`
}

/**
 * Proxy advice for an embedding-model download that failed on the network.
 * transformers.js downloads with Node's built-in fetch (undici),
 * which ignores HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is set — supported
 * from Node 24.0.0 and 22.21.0 (Node's cli.md). Empty for any other error.
 */
export function embeddingNetworkHint(
  lastError: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  nodeVersion: string = process.versions.node,
  execArgv: string[] = process.execArgv,
): string[] {
  if (!lastError || !/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_CONNECT/i.test(lastError)) return []
  const [major, minor] = nodeVersion.split('.').map(Number)
  const supported = major >= 24 || (major === 22 && minor >= 21)
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy
  // The flag form (`--use-env-proxy`, Node 24.5+ / 22.21+) turns it on as well.
  const useEnvProxy = env.NODE_USE_ENV_PROXY === '1' || execArgv.includes('--use-env-proxy') ||
    /(^|\s)--use-env-proxy(\s|$)/.test(env.NODE_OPTIONS ?? '')
  const lines = [
    '  Network error. The model is downloaded with Node\'s built-in fetch, which ignores',
    '  HTTPS_PROXY unless NODE_USE_ENV_PROXY=1 is also set.',
  ]
  if (!supported) {
    lines.push(`  This Node (v${nodeVersion}) has no NODE_USE_ENV_PROXY; behind a proxy, use Node 22.21+ or 24+`)
    lines.push('  and set HTTPS_PROXY=http://<proxy>:<port> plus NODE_USE_ENV_PROXY=1.')
  } else if (proxy && !useEnvProxy) {
    lines.push('  HTTPS_PROXY is set, but the download will ignore it: set NODE_USE_ENV_PROXY=1 as well.')
  } else if (proxy) {
    lines.push('  HTTPS_PROXY is set and proxy use is on (NODE_USE_ENV_PROXY=1 or --use-env-proxy): check that the proxy is reachable')
    lines.push('  and allows huggingface.co.')
  } else {
    lines.push('  Behind a proxy? Set HTTPS_PROXY=http://<proxy>:<port> and NODE_USE_ENV_PROXY=1.')
  }
  lines.push('  Set them where your editor starts PLUR as well (its MCP server env), not only in this shell.')
  return lines
}

/** Config files Claude Code reads hooks and settings from, but never MCP servers. */
function isClaudeSettingsFile(path: string): boolean {
  return path === claudeCodeGlobalSettingsPath() || path === join(process.cwd(), '.claude', 'settings.json')
}

/** The folder Claude Code keys local scope by: the git root above `dir`, else `dir` itself. */
function claudeProjectRoot(dir: string): string {
  let cur = dir
  for (;;) {
    if (existsSync(join(cur, '.git'))) return cur
    const parent = dirname(cur)
    if (parent === cur) return dir
    cur = parent
  }
}

/** The local-scope `plur` entry for `cwd` in a parsed ~/.claude.json, if any. */
function localScopePlur(config: Record<string, unknown>, cwd: string): Record<string, unknown> | null {
  const projects = config.projects
  if (!projects || typeof projects !== 'object') return null
  // Claude Code keys local scope by the git root, not the folder it runs in;
  // either spelling of the path may be the key.
  const keys = new Set<string>([claudeProjectRoot(cwd), cwd])
  try {
    const real = realpathSync(cwd)
    keys.add(claudeProjectRoot(real))
    keys.add(real)
  } catch { /* keep cwd */ }
  for (const key of keys) {
    const p = (projects as Record<string, unknown>)[key] as { mcpServers?: unknown } | undefined
    const servers = p?.mcpServers
    if (servers && typeof servers === 'object' && !Array.isArray(servers) && 'plur' in (servers as object)) {
      return { mcpServers: { plur: (servers as Record<string, unknown>).plur } }
    }
  }
  return null
}

/** The nearest `.mcp.json` with a plur entry, walking up from `cwd` as Claude Code does. */
function projectMcpJson(cwd: string): string | null {
  let cur = cwd
  for (;;) {
    const p = join(cur, '.mcp.json')
    if (existsSync(p) && hasPlurMcp(readConfig(p))) return p
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/**
 * The plur entry Claude Code would launch from `cwd`, in its own precedence
 * order — local scope, then project `.mcp.json`, then user scope — with
 * where it came from.
 */
function claudeCodePlurEntry(cwd: string): { scope: 'local' | 'project' | 'user'; path: string; config: Record<string, unknown> } | null {
  const userPath = claudeCodeUserConfigPath()
  const user = readConfig(userPath)
  const local = localScopePlur(user, cwd)
  if (local) return { scope: 'local', path: userPath, config: local }
  const project = projectMcpJson(cwd)
  if (project) return { scope: 'project', path: project, config: readConfig(project) }
  if (hasPlurMcp(user)) return { scope: 'user', path: userPath, config: user }
  return null
}

export function inspectClaudeCodeMcp(cwd: string = process.cwd()): ClaudeCodeMcpReport {
  const userPath = claudeCodeUserConfigPath()
  const legacySettingsEntry = hasPlurMcp(readConfig(claudeCodeGlobalSettingsPath()))
  const found = claudeCodePlurEntry(cwd)
  if (found) return { registered: true, scope: found.scope, path: found.path, legacySettingsEntry }
  return {
    registered: false, scope: null, path: null, legacySettingsEntry,
    fix: legacySettingsEntry
      ? `run \`plur init\` — it moves the plur entry from ${claudeCodeGlobalSettingsPath()} (which Claude Code does not read for MCP servers) to ${userPath}`
      : `run \`plur init\` — it registers the plur MCP server in ${userPath}, where Claude Code reads it`,
  }
}

function buildReport(skipHandshake: boolean, flags: GlobalFlags): Promise<DoctorReport> {
  const configs = inspectConfigs()
  const hooksInstalled = configs.some((c) => c.hasPlurHooks)
  const claudeCodeMcp = inspectClaudeCodeMcp()
  // A settings.json entry is not a registration: no harness launches it.
  const mcpRegistered = claudeCodeMcp.registered || configs.some((c) => c.hasPlurMcp && !isClaudeSettingsFile(c.path))
  // Claude Code's hooks without its MCP server is a broken half-install:
  // hooks run, but the plur_* tools never appear.
  const claudeCodeHooks = hookHarnesses(configs).includes('Claude Code')
  const datacoreCollision = configs.some((c) => c.hasDatacoreMcp)

  // Check for stale npx hooks across all existing configs
  const staleNpxHooks = configs.some((c) => {
    if (!c.exists) return false
    const config = readConfig(c.path)
    return hasStaleNpxHooks(config)
  })

  // Check for stale npx-based MCP server registration
  const staleNpxMcp = configs.some((c) => {
    if (!c.exists) return false
    const config = readConfig(c.path)
    return hasStaleNpxMcp(config)
  })

  // PLUR's Windows node-form entry pins a version-specific node binary:
  // a Node upgrade leaves it pointing at nothing.
  const brokenNodeMcp: DoctorReport['brokenNodeMcp'] = []
  const seenConfigs = new Set<string>()
  for (const c of configs) {
    if (!c.exists || !c.hasPlurMcp) continue
    // Run from HOME, the project and global Claude Code settings are one file.
    let real = c.path
    try { real = realpathSync(c.path) } catch { /* keep the path as given */ }
    if (seenConfigs.has(real)) continue
    seenConfigs.add(real)
    const entry = readPlurMcpEntry(readConfig(c.path))
    const missing = entry ? missingNodeEntryPaths(entry) : []
    if (missing.length > 0) brokenNodeMcp.push({ label: c.label, path: c.path, missing })
  }

  const hookShim = validateHookShim()
  const mcpShim = validateMcpShim()

  // Cursor-specific health, computed from Cursor's OWN two config files only
  // — not folded into hooksInstalled/mcpRegistered's cross-config `.some()`,
  // which a working Claude Code setup elsewhere would satisfy regardless of
  // whether THIS project's `.cursor/` wiring is present at all.
  const cursorMcpConfig = configs.find((c) => c.label === 'Cursor (.cursor/mcp.json)')
  const cursorHooksConfigReport = configs.find((c) => c.label === 'Cursor (.cursor/hooks.json)')
  const cursorProjectDetected = existsSync(join(process.cwd(), '.cursor'))

  // Beyond "entry exists":
  //   1. Its env must set PLUR_TOOL_PROFILE=cursor, or Cursor silently gets the
  //      full tool surface instead of the reduced one.
  //   2. An absolute command (the local shim, see buildMcpServerEntry) must
  //      exist on THIS machine: `.cursor/mcp.json` is committed but the shim
  //      path is machine-local. A cheap existsSync, not another handshake.
  let cursorEntryEnvCorrect = false
  let cursorEntryCommandExists = true
  if (cursorMcpConfig?.exists) {
    const parsed = readConfig(cursorProjectMcpConfigPath())
    const servers = (parsed.mcpServers ?? {}) as Record<string, { command?: string; env?: Record<string, string> }>
    const plurEntry = servers.plur
    cursorEntryEnvCorrect = plurEntry?.env?.PLUR_TOOL_PROFILE === 'cursor'
    if (plurEntry?.command && (plurEntry.command.startsWith('/') || /^[A-Za-z]:\\/.test(plurEntry.command))) {
      // existsSync alone reports true for a directory, a 0-byte file, or a
      // file stripped of its execute bit (an interrupted `plur init
      // --cursor`, a botched reinstall, an AV quarantine placeholder) — the
      // "config looks healthy but the server can't actually start" failure
      // this check exists to catch. Also check it's a regular, executable file.
      cursorEntryCommandExists = commandIsExecutableFile(plurEntry.command)
    }
  }
  const cursorWired = Boolean(
    cursorMcpConfig?.exists && cursorMcpConfig.hasPlurMcp && cursorEntryEnvCorrect && cursorEntryCommandExists &&
    cursorHooksConfigReport?.exists && cursorHooksConfigReport.hasPlurHooks,
  )

  // Codex health, from Codex's OWN two files only.
  // A Codex home, a codex on PATH, or the Codex app's bundled binary — the
  // same places `plur init --codex` looks.
  const codexDetected = codexInstalled()
  const codexHooksReport = configs.find((c) => c.label === 'Codex (~/.codex/hooks.json)')
  const codexTomlReport = configs.find((c) => c.label === 'Codex (~/.codex/config.toml)')
  // A legacy Windows `plur-mcp.cmd` entry is registered but cannot start
  // (spawn EINVAL). Only PLUR's own shim command is matched, whatever else
  // the entry carries (env, other keys, args): it fails either way, even
  // when init will not heal it automatically.
  let codexCmdShimMcp = false
  if (codexTomlReport?.exists && codexTomlReport.hasPlurMcp) {
    try {
      const command = readCodexPlurMcpCommand(readFileSync(codexTomlReport.path, 'utf8'))
      codexCmdShimMcp = command !== null && isOwnWin32CmdShimCommand(command)
    } catch { /* unreadable — nothing to flag */ }
  }
  const codexWired = Boolean(
    codexHooksReport?.exists && codexHooksReport.hasPlurHooks &&
    codexTomlReport?.exists && codexTomlReport.hasPlurMcp && !codexCmdShimMcp,
  )

  // On Windows a string-editor hook must be a single unquoted
  // path. When init had to fall back (the path has whitespace and no 8.3
  // short name exists), name the editor: its hooks may not run.
  const windowsHookFallback = platform() === 'win32' ? windowsHookFallbackEditors(configs) : []

  // Antigravity health, from agy's OWN two files only.
  const agyDetected = existsSync(join(homedir(), '.gemini', 'antigravity-cli'))
  const agyHooksReport = configs.find((c) => c.label === 'Antigravity (~/.gemini/config/hooks.json)')
  const agyMcpReport = configs.find((c) => c.label === 'Antigravity (~/.gemini/config/mcp_config.json)')
  const agyWired = Boolean(
    agyHooksReport?.exists && agyHooksReport.hasPlurHooks &&
    agyMcpReport?.exists && agyMcpReport.hasPlurMcp,
  )

  const handshakePromise = skipHandshake
    ? Promise.resolve({ ok: false, skipped: true, error: 'skipped (--no-handshake)' })
    : mcpHandshake()

  return Promise.all([handshakePromise, checkEmbedder(flags), buildOpencodeReport(skipHandshake)]).then(async ([handshake, embedder, opencode]) => {
    // Probe the cursor tool profile too, so the report shows both tool
    // counts side by side instead of guessing which one a given config
    // file's env is actually wired to (see mcpHandshake's doc comment).
    // Only worth a second spawn if the default handshake actually came up —
    // no point probing a profile variant of a server that doesn't start —
    // AND only if this is actually a Cursor project, so the common
    // Claude-Code-only case does not pay for a second spawn (up to +20s on a
    // cold npx fetch).
    const cursorHandshake = (handshake.ok && cursorProjectDetected)
      ? await mcpHandshake(20000, { PLUR_TOOL_PROFILE: 'cursor' })
      : null

    // Wiring overall: hooks + MCP + handshake + (if a Cursor project is
    // detected) Cursor's own config actually being wired. Embedder status is
    // reported separately as a warning — a degraded embedder doesn't fail
    // the overall doctor check (BM25 still works); it just signals semantic
    // recall is disabled until the model loads.
    const outbox = await checkOutbox(flags)
    const serverStores = await checkServers(flags)
    const installs = readHookInstalls(plurRoot(flags)), runs = readHookRuns(plurRoot(flags))
    const hookTrust: NonNullable<DoctorReport['hookTrust']> = []
    for (const [tool, label, wired] of [
      ['claude', 'Claude Code', claudeCodeHooks && claudeCodeMcp.registered],
      ['codex', 'Codex', !!codexHooksReport?.hasPlurHooks && configs.some(c => c.label.startsWith('Codex') && c.hasPlurMcp)],
      ['cursor', 'Cursor', !!cursorHooksConfigReport?.hasPlurHooks && configs.some(c => c.label.startsWith('Cursor') && c.hasPlurMcp)],
    ] as const) {
      if (!wired) continue
      const installed = Date.parse(installs[tool] ?? ''), ran = Date.parse(runs[tool] ?? '')
      // No install record (hooks installed before install records were
      // kept): any real run counts.
      const ok = Number.isFinite(ran) && ran <= Date.now() && (!Number.isFinite(installed) || ran > installed)
      hookTrust.push({ tool, label, ok, detail: ok ? `hooks ran ${runs[tool]}` : 'hooks have not run yet after installation',
        ...(!ok ? { fix: tool === 'codex' ? 'run /hooks and trust PLUR, then start a new session in Codex' : `start a new session in ${label}` } : {}) })
    }
    // A broken folders.yaml pauses memory everywhere — a real failure.
    let folderMap: NonNullable<DoctorReport['folderMap']> | null = null
    try {
      const p = folderMapProblem(plurRoot(flags))
      if (p) {
        folderMap = {
          file: p.file, problem: p.problem,
          ...(p.line !== undefined ? { line: p.line } : {}),
          ...(p.column !== undefined ? { column: p.column } : {}),
          fixable: p.fixable,
          ...(p.fixable ? { repair: repairCommandFor(flags) } : {}),
          ...(p.repair_summary ? { repair_summary: p.repair_summary } : {}),
        }
      }
    } catch { /* doctor never fails on its own probe */ }
    const { unset: tokenEnvUnset, found: tokenEnvFound } = findTokenEnv(flags)
    // Every check except the live handshake. The handshake then decides
    // between ok (reachable), fail (refused) and unverified (not run): a
    // connection the doctor did not check is never reported as ok.
    const staticChecksPass =
      folderMap === null &&
      serverStores.every(s => s.ok) && hookTrust.every(h => h.ok) &&
      hooksInstalled && mcpRegistered &&
      (!claudeCodeHooks || claudeCodeMcp.registered) &&
      brokenNodeMcp.length === 0 &&
      (!cursorProjectDetected || cursorWired) &&
      // A queued write no retry will deliver is a real failure.
      (outbox?.ok ?? true) &&
      // A team store with no token cannot work; MCP plur_doctor says not ok too.
      tokenEnvUnset.length === 0
    const overall: DoctorReport['overall'] =
      !staticChecksPass ? 'fail' : skipHandshake ? 'unverified' : handshake.ok ? 'ok' : 'fail'
    // codexWired is NOT in `overall`, unlike cursorWired: `.cursor/` is in this
    // project, while `~/.codex/` is machine-level and would turn doctor red for
    // users who merely installed Codex once. It gets its own line.
    // PGLite + embedding-gemma: the vector cache is keyed on dimension only, so
    // the role-prefix change needs a one-time re-embed. The backend half uses
    // the real resolver (config or PLUR_BACKEND); the embedder half is env-only.
    const gemmaRoot = process.env.PLUR_PATH || join(homedir(), '.plur')
    const pgliteGemmaReembedNeeded =
      resolveBackendTier({
        env: process.env.PLUR_BACKEND,
        config: loadConfig(join(gemmaRoot, 'config.yaml')).backend,
        engramCount: 0,
        postgresConfigured: false,
      }).tier === 'pglite' && process.env.PLUR_EMBEDDER === 'embedding-gemma'

    // Count engrams whose content_hash is out of step with their statement
    // under the current normalizer; such engrams are dedup attractors.
    // Advisory: does not fail overall.
    const staleContentHashes = countStaleContentHashes(flags)

    // Orphaned-PGLite advisory — computed HERE, not in the text renderer, so
    // `--json` consumers see it too. "Selected" goes through the real
    // resolver: `backend: pglite` in config.yaml counts exactly as
    // PLUR_BACKEND=pglite does.
    const orphanRoot = process.env.PLUR_PATH || join(homedir(), '.plur')
    const orphanPglitePath = join(orphanRoot, 'store.pglite')
    const pgliteSelected = resolveBackendTier({
      env: process.env.PLUR_BACKEND,
      config: loadConfig(join(orphanRoot, 'config.yaml')).backend,
      engramCount: 0, // irrelevant: pglite is never size-selected
      postgresConfigured: false, // ditto — pglite selection needs no connection string
    }).tier === 'pglite'
    const pgliteOrphan = existsSync(orphanPglitePath) && !pgliteSelected
      ? { path: orphanPglitePath }
      : null

    const ignoredDuplicateStores = findIgnoredDuplicateStores(flags)
    const skippedProjectStores = findSkippedProjectStores(flags)

    return {
      configs, hooksInstalled, mcpRegistered, claudeCodeMcp, datacoreCollision, staleNpxHooks, staleNpxMcp, brokenNodeMcp,
      hookShim, mcpShim, handshake, cursorHandshake, embedder,
      cursorProjectDetected, cursorWired, codexDetected, codexWired, codexCmdShimMcp, windowsHookFallback, agyDetected, agyWired,
      pgliteGemmaReembedNeeded, staleContentHashes, pgliteOrphan, ignoredDuplicateStores, skippedProjectStores, tokenEnvUnset, tokenEnvFound, opencode, outbox, folderMap, overall, serverStores, hookTrust,
    }
  })
}

/**
 * Render the report. Exported for tests: text mode cannot be exercised
 * through a spawned CLI (piped stdout auto-selects JSON), and calling run()
 * in-process would spawn the embedder probe against the test runner's argv.
 *
 * --quiet: only the title banner is suppressed — everything else in
 * this report IS the diagnosis the user asked for, including the ✓ lines
 * (absence of a ✓ would read as "not checked", not "healthy").
 */
export function printText(report: DoctorReport, flags?: GlobalFlags): void {
  const tick = (b: boolean) => (b ? '✓' : '✗')

  outputInfo('plur doctor — Claude Code / Claude Desktop / Cursor / Codex / Antigravity / opencode diagnostic', flags)
  outputInfo('', flags)
  outputText('Config files:')
  for (const c of report.configs) {
    if (!c.exists) {
      outputText(`  - ${c.label}: not present (${c.path})`)
      continue
    }
    const flags: string[] = []
    if (c.hasPlurMcp) flags.push('plur MCP')
    if (c.hasPlurHooks) flags.push('plur hooks')
    if (c.hasDatacoreMcp) flags.push('datacore MCP')
    outputText(`  ${tick(c.hasPlurMcp || c.hasPlurHooks)} ${c.label}: ${flags.length ? flags.join(', ') : '(empty)'}`)
    outputText(`     ${c.path}`)
  }

  outputText('')
  // The folder map first, because while it is broken no memory runs anywhere.
  if (report.folderMap) {
    const m = report.folderMap
    outputText(`✗ Folder map: ${m.file} ${m.problem}`)
    outputText('  Memory is paused in every folder until it is fixed (nothing is read or written).')
    outputText(`  ${repairAdvice(m, flags ?? {})}`)
    if (m.repair_summary) outputText(`  The repair changes ${m.repair_summary}.`)
  }
  outputText(`${tick(report.hooksInstalled)} Hooks installed`)
  for (const h of report.hookTrust ?? []) {
    outputText(`${tick(h.ok)} hooks — ${h.label}: ${h.detail}`)
    if (h.fix) outputText(`  ${h.fix}`)
  }
  for (const server of report.serverStores ?? []) for (const c of server.checks) {
    outputText(`${tick(c.result === 'ok')} ${server.url} — ${c.name}: ${c.result === 'could-not-check' ? 'could not check: ' : ''}${c.detail}`)
  }
  // Queued team writes.
  if (report.outbox && report.outbox.pending > 0) {
    const o = report.outbox
    const heldLines = describeHeld({ ...o })
    outputText(`${tick(o.ok)} Outbox: ${o.pending} queued write(s)` + (o.needs_action > 0 ? `, ${o.needs_action} will not deliver by retrying` : heldLines.length > 0 ? ', held on this machine' : ', retrying'))
    if (o.claims_problem) outputText(`  The push-claims folder cannot be written (${o.claims_problem}), so queued writes cannot be sent from here. Check disk space and permissions of the PLUR store's cache folder.`)
    for (const line of heldLines) outputText(`  ${line}`)
    if (!o.ok) {
      for (const line of describeNeedsAction({ ...o })) outputText(`  ${line}`)
      outputText('  Nothing is dropped automatically. `plur outbox` lists them.')
    }
  }
  outputText(`${tick(report.mcpRegistered)} plur MCP server registered`)
  const cc = report.claudeCodeMcp
  if (cc) {
    if (cc.registered) {
      outputText(`${tick(true)} Claude Code sees the plur MCP server (${cc.scope} scope, ${cc.path})`)
    } else if (cc.legacySettingsEntry || hookHarnesses(report.configs).includes('Claude Code')) {
      outputText(`${tick(false)} Claude Code does not see the plur MCP server — the plur_* tools will be missing`)
      if (cc.legacySettingsEntry) outputText('  Its entry is in ~/.claude/settings.json, which Claude Code does not read for MCP servers.')
      if (cc.fix) outputText(`  Fix: ${cc.fix}`)
    }
  }

  if (report.cursorProjectDetected) {
    outputText(`${tick(report.cursorWired)} Cursor: this project's .cursor/mcp.json + .cursor/hooks.json wired to plur`)
    if (!report.cursorWired) {
      outputText('  A Claude Code config being healthy elsewhere does NOT cover Cursor —')
      outputText('  this project has a .cursor/ directory but its own config is incomplete.')
      outputText('  Fix: run `plur init --cursor` from this project.')
    }
  }

  // PGLite is never size-selected, so a store directory built for it while
  // another tier is selected is orphaned disk (often hundreds of MB). This
  // advisory is the only signal those users get — the runtime opt-in log
  // line fires only for explicit selections. Computed in buildReport so
  // --json sees it.
  if (report.pgliteOrphan) {
    outputText('')
    outputText(`ℹ  ${report.pgliteOrphan.path} exists but PGLite is no longer selected by store size (v0.19).`)
    outputText('   Nothing to do — embeddings rebuild automatically — and this directory is an')
    outputText('   orphaned index you can delete whenever convenient. YAML remains the source of')
    outputText('   truth. (Optional: `plur migrate` ports the old vectors over, skipping the rebuild.)')
  }

  if (report.agyDetected) {
    outputText(`${tick(report.agyWired)} Antigravity: ~/.gemini/config hooks.json + mcp_config.json wired to plur`)
    if (!report.agyWired) {
      outputText('  Antigravity CLI (agy) is installed but PLUR is not wired into it — it')
      outputText('  would get no injection, enforcement, or learn nudges. If you use agy,')
      outputText('  run `plur init --antigravity`. (Advisory: does not fail the check above.)')
    }
  }

  if (report.codexDetected) {
    outputText(`${tick(report.codexWired)} Codex: ~/.codex/hooks.json + config.toml wired to plur`)
    if (report.codexCmdShimMcp) {
      outputText('  config.toml registers the old ~/.plur/bin/plur-mcp.cmd shim, which current Node')
      outputText('  cannot start (spawn EINVAL). Fix: run `plur init --codex`. It replaces a plain entry')
      outputText('  through `codex mcp remove` + `codex mcp add`; an entry that also carries other settings')
      outputText('  (env, other keys, a multi-line args array) is left alone, and init prints the command')
      outputText('  and args lines to change by hand so those settings are kept.')
    } else if (!report.codexWired) {
      outputText('  Codex is installed on this machine but PLUR is not wired into it — it')
      outputText('  would get MCP tools with no injection, enforcement, or learn nudges.')
      outputText('  If you use Codex, run `plur init --codex`. (Advisory: this does not')
      outputText('  fail the check above — having Codex installed is not the same as')
      outputText('  using it on this project.)')
    } else {
      // A green tick here is genuinely weaker than it looks, so say so every
      // time rather than only on failure. Codex skips untrusted hooks with
      // NO warning and exit 0, and nothing on disk distinguishes trusted
      // from untrusted — so a config that reads as perfect can still be
      // completely inert. This is the single most likely reason a user
      // reports "I ran plur init --codex and nothing happens".
      outputText('  Note: wired ≠ running. Codex skips hooks it has not been told to trust,')
      outputText('  silently. If memory never loads, open Codex, run /hooks, and trust the')
      outputText('  PLUR entries.')
    }
  }

  if (report.opencode) {
    const oc = report.opencode
    outputText(`${tick(oc.pluginDeclared)} opencode: plugin declared (${oc.configPath})`)
    outputText(`${tick(oc.mcpPlurDeclared)} opencode: mcp.plur declared`)
    if (oc.mcpPlurMissingPaths.length > 0) {
      outputText('  ✗ opencode\'s mcp.plur points at a path that no longer exists:')
      for (const m of oc.mcpPlurMissingPaths) outputText(`     ${m}`)
      outputText('    The node binary path is version-specific, so a Node upgrade or a version-manager')
      outputText('    switch breaks it. Fix: re-run `plur init`, which rewrites the entry.')
    }
    if (!oc.ok) {
      outputText('  Config exists but PLUR could not safely read it — invalid JSON/JSONC or a')
      outputText('  `plugin`/`mcp` field in an unexpected shape. Run `plur init --opencode` after')
      outputText('  fixing it by hand.')
    }
    if (oc.pluginUpgrade) {
      outputText(`! opencode: ${oc.pluginUpgrade.from} is older than ${oc.pluginUpgrade.to}. Run \`plur init --opencode\` to upgrade (omit --keep-opencode-plugin).`)
    }
    if (oc.mcpPlurDisabled) outputText('  The PLUR MCP server is explicitly disabled in OpenCode; plur init preserves that choice.')
    if (oc.pluginDeclared) {
      outputText('  OpenCode V2 requires @plur-ai/opencode 0.21.4 or later. After upgrading, restart OpenCode and its background service.')
      if (oc.pluginResolvable === 'yes') {
        outputText(`  ✓ ${PLUR_OPENCODE_PLUGIN} resolves (${oc.resolvedVia}) — package available; host loading is not verified.`)
      } else if (oc.pluginResolvable === 'no') {
        outputText(`  ✗ ${PLUR_OPENCODE_PLUGIN} does NOT resolve — the npm registry has no such package.`)
        outputText('    The configured package is unavailable. Check the version and restart OpenCode after installation.')
      } else {
        outputText(`  ? Could not verify whether ${PLUR_OPENCODE_PLUGIN} resolves (network unreachable,`)
        outputText('    timed out, or the check was skipped with --no-handshake). This is NOT a clean')
        outputText('    bill of health — re-run doctor with network access to confirm either way.')
      }
    } else if (oc.pluginDisabled) {
      outputText('  The plugin is disabled by an OpenCode removal directive; plur init preserves that choice.')
    } else if (oc.ok) {
      outputText('  opencode is configured but the plugin entry is not declared — memory is not')
      outputText('  automatic here. Run `plur init --opencode` to add it.')
    }
  }

  if (report.datacoreCollision) {
    outputText('')
    outputText('⚠  datacore MCP server detected alongside plur.')
    outputText('   plur and datacore are SEPARATE MCP servers with separate tool namespaces.')
    outputText('   plur tools are prefixed plur_* (plur_learn, plur_recall, etc.).')
    outputText('   datacore tools are prefixed datacore_*. They do NOT share memory.')
    outputText('   If your agent confuses them, this is the cause.')
  }

  // Hook shim status
  outputText('')
  if (report.hookShim.valid) {
    outputText(`✓ Hook shim: ${report.hookShim.shimPath}`)
  } else {
    outputText(`✗ Hook shim: ${report.hookShim.error}`)
  }

  if (report.staleNpxHooks) {
    outputText('')
    outputText('⚠  Hooks still use npx — slow (200-2000ms per hook) and vulnerable to cache corruption.')
    outputText('   Fix: run `plur init` to migrate to the local hook binary (<5ms per hook).')
  }

  // MCP shim status — same problem on MCP launch, same fix pattern
  if (report.mcpShim.valid) {
    outputText(`✓ MCP shim:  ${report.mcpShim.shimPath}`)
  } else {
    outputText(`✗ MCP shim:  ${report.mcpShim.error}`)
  }

  for (const editor of report.windowsHookFallback ?? []) {
    outputText('')
    outputText(`✗ ${editor} hooks: the PLUR hook path contains a space and no 8.3 short name is available,`)
    outputText(editor === 'Antigravity'
      ? '   and Antigravity runs hooks through cmd /C, where no quoted path works — its hooks will not run.'
      : '   so init wrote PowerShell\'s `& "<path>"` form, which runs only if the editor uses PowerShell.')
    outputText('   Fix: enable 8.3 names on the volume (`fsutil 8dot3name set`), or install to a path without spaces,')
    outputText('   then re-run `plur init`.')
  }

  for (const b of report.brokenNodeMcp) {
    outputText('')
    outputText(`✗ plur MCP entry in ${b.label} (${b.path}) points at a path that no longer exists:`)
    for (const m of b.missing) outputText(`   ${m}`)
    outputText('   The node binary path is version-specific, so a Node upgrade or a version-manager')
    outputText('   switch breaks it. Fix: re-run `plur init`, which rewrites the entry.')
  }

  if (report.staleNpxMcp) {
    outputText('')
    outputText('⚠  plur MCP still launched via npx — vulnerable to ENOTEMPTY cache corruption on version bumps (#234).')
    outputText('   This is the same bug class as #178 (which fixed hooks). Symptom: Claude Code')
    outputText('   sessions silently lose PLUR memory after a new @plur-ai/mcp publish.')
    outputText('   Fix: run `plur init` to migrate to the local MCP binary (no npx, no race).')
  }

  if (report.pgliteGemmaReembedNeeded) {
    outputText('')
    outputText('⚠  PGLite backend + embedding-gemma: stored vectors may be stale (#483).')
    outputText('   embedding-gemma\'s role prefixes were corrected in 0.14.0 (#483), but the PGLite')
    outputText('   backend keys its embedding cache on vector dimension (unchanged at 768d), so it')
    outputText('   does NOT auto-rebuild — recall keeps serving the old (wrong-prefix) embedding')
    outputText('   space silently. The SQLite/flat-file backend auto-rebuilds; PGLite cannot.')
    outputText('   Fix: run `plur sync --reembed --full` once to rebuild the vectors.')
  }

  if (report.staleContentHashes > 0) {
    outputText('')
    outputText(`⚠  ${report.staleContentHashes} engram${report.staleContentHashes === 1 ? '' : 's'} have a stale content_hash (#896, #911).`)
    outputText('   This happens after upgrading from a version where normalizeStatement used ASCII \\w')
    outputText('   — any statement containing non-ASCII letters hashes differently under the new')
    outputText('   normalizer. Stale hashes act as dedup attractors: re-learns that hash-match the')
    outputText('   old value are absorbed into the wrong engram. Pure-ASCII stores are unaffected.')
    outputText('   Fix: run `plur migrate` (migration 006 recomputes them, with backup and rollback)')
    outputText('   or `plur reindex-hashes --apply` for the repair alone.')
  }

  if (report.ignoredDuplicateStores.length > 0) {
    const n = report.ignoredDuplicateStores.length
    outputText('')
    outputText(`⚠  config.yaml lists ${n} store entr${n === 1 ? 'y' : 'ies'} that ${n === 1 ? 'is' : 'are'} ignored at load (#1319):`)
    for (const d of report.ignoredDuplicateStores) {
      outputText(`   - "${d.scope}" (${d.path}): the same file as ${d.duplicateOf}`)
    }
    outputText(n === 1
      ? '   Loading it would inject the same engrams twice, so plur skips it and warns on every run.'
      : '   Loading them would inject the same engrams twice, so plur skips them and warns on every run.')
    if (report.ignoredDuplicateStores.some(d => d.primary)) {
      outputText('   Fix: run `plur stores prune` to remove the entries that name the primary store file.')
    }
    if (report.ignoredDuplicateStores.some(d => !d.primary)) {
      outputText('   Remove an entry that repeats another store\'s file and scope from config.yaml by hand.')
    }
  }

  for (const line of skippedStoreLines(report.skippedProjectStores, plurRoot(flags))) outputText(line.startsWith('Found') ? `⚠  ${line}` : line)

  if (report.tokenEnvUnset.length > 0) {
    outputText('')
    // The same detail and fix plur_doctor gives over MCP.
    for (const t of report.tokenEnvUnset) {
      outputText(`✗ remote store: ${t.url} — ${t.detail}`)
      outputText(`   Fix: ${t.fix}`)
    }
  }
  const entryOnly = (report.tokenEnvFound ?? []).filter(t => !t.inShell)
  if (entryOnly.length > 0) {
    outputText('')
    for (const t of entryOnly) {
      outputText(`✓ remote store: ${t.url} — its token comes from ${t.variable}, set in the env of: ${t.sources.join('; ')}.`)
      outputText(`   ${t.variable} is not set in this shell, so \`plur\` commands run here queue that store's saves in the outbox.`)
    }
  }

  outputText('')
  if (report.handshake.ok) {
    outputText(`✓ MCP handshake: ${report.handshake.serverName} v${report.handshake.serverVersion}`)
  } else if (report.handshake.skipped) {
    outputText('? MCP handshake: not run (--no-handshake) — the memory connection is unverified.')
    outputText('  Run `plur doctor` without --no-handshake to check it.')
  } else {
    outputText(`✗ MCP handshake failed: ${report.handshake.error}`)
    outputText('  Likely causes:')
    outputText('    - npx not on PATH (Claude Desktop launches GUI without your shell PATH)')
    outputText('    - @plur-ai/mcp not yet downloaded — first run can take a few seconds')
    outputText('    - Network blocked — try `npx -y @plur-ai/mcp` manually')
  }

  // Live tool-budget report — both profiles side by side (Cursor caps a
  // workspace at ~40 MCP tools total across every server). Printing both
  // counts, rather than trying to infer which profile a config file's env
  // actually activates, sidesteps guessing at hand-edited/partially-migrated
  // configs: the user can just compare the two numbers themselves.
  if (report.handshake.ok && report.handshake.toolCount !== undefined) {
    outputText(`MCP tools exposed (default/full profile): ${report.handshake.toolCount}`)
  }
  if (report.cursorHandshake?.ok && report.cursorHandshake.toolCount !== undefined) {
    outputText(`MCP tools exposed (PLUR_TOOL_PROFILE=cursor): ${report.cursorHandshake.toolCount}`)
  }
  // Gated on cursorProjectDetected: a Cursor-specific warning must not fire
  // for every Claude-Code-only install whose default handshake reports >15
  // tools.
  if (report.cursorProjectDetected && report.handshake.ok && report.handshake.toolCount !== undefined && report.handshake.toolCount > 15) {
    outputText(
      `  Cursor caps a workspace at ~40 MCP tools total across every server. If .cursor/mcp.json's ` +
      `plur entry doesn't set PLUR_TOOL_PROFILE=cursor in its env, Cursor is getting the full ` +
      `${report.handshake.toolCount}-tool surface above, not the ~11-tool one. Run \`plur init --cursor\` to fix, ` +
      `or set the env var directly if you registered the server by hand.`,
    )
  }

  outputText('')
  if (report.embedder.disabled) {
    outputText(`○ Embedding layer DISABLED — ${report.embedder.disabledReason ?? 'embeddings disabled'}`)
    outputText('  Hybrid recall is running in BM25-only mode (this is intentional).')
    outputText('  Re-enable: unset PLUR_DISABLE_EMBEDDINGS or set embeddings.enabled: true in ~/.plur/config.yaml')
  } else if (report.embedder.modelLoaded) {
    outputText('✓ Embedding model loaded — hybrid search is fully operational')
  } else {
    outputText('✗ Embedding model NOT loaded — hybrid search will silently degrade to BM25-only')
    if (report.embedder.lastError) {
      outputText(`  Last error: ${report.embedder.lastError}`)
    }
    for (const line of embeddingNetworkHint(report.embedder.lastError)) outputText(line)
    outputText('  Likely causes:')
    outputText('    - First-run download not completed (try again in a few seconds)')
    outputText('    - Network blocked HuggingFace Hub — check huggingface.co connectivity')
    outputText('    - @huggingface/transformers package failed to load (ONNX runtime issue)')
    outputText('    - pnpm hoisting: onnxruntime-node not findable from transformers package root')
    outputText('  To opt out (run BM25-only intentionally): set PLUR_DISABLE_EMBEDDINGS=1')
    outputText('    or write `embeddings: { enabled: false }` to ~/.plur/config.yaml')
  }

  outputText('')
  if (report.overall === 'unverified') {
    outputText('? Unverified: the other checks passed, but the memory connection was not checked (--no-handshake).')
    outputText('  Run `plur doctor` without --no-handshake to verify it.')
  } else if (report.overall === 'ok') {
    outputText(readyLine(hookHarnesses(report.configs), report.codexDetected && !report.codexWired ? ['Codex'] : []))
  } else {
    outputText('✗ Issues detected.')
    if (!report.hooksInstalled || !report.mcpRegistered) {
      outputText('  Fix: run `npx @plur-ai/cli init`')
    } else if (report.claudeCodeMcp && !report.claudeCodeMcp.registered && hookHarnesses(report.configs).includes('Claude Code')) {
      outputText(`  Fix: ${report.claudeCodeMcp.fix ?? 'run `plur init`'}`)
    }
    if (report.hooksInstalled && report.mcpRegistered && !report.handshake.ok && !report.handshake.skipped) {
      outputText('  Fix: ensure `npx` is reachable from Claude Desktop')
      outputText('       — try launching Claude from your terminal once,')
      outputText('       — or replace the plur entry command with an absolute path to your shell.')
    }
    if (report.outbox && !report.outbox.ok) {
      outputText(report.outbox.claims_problem
        ? '  Fix: make the PLUR store\'s cache/outbox-claims folder writable (disk space, permissions), then `plur outbox --flush`.'
        : '  Fix: see the Outbox line above — queued team writes need a person to act.')
    }
    for (const t of report.tokenEnvUnset ?? []) outputText(`  Fix: ${t.fix}`)
    if (report.folderMap) {
      outputText(`  Fix: ${report.folderMap.fixable ? `run \`${report.folderMap.repair}\`` : 'edit the folder map by hand'} — see the Folder map line above.`)
    }
    if (report.cursorProjectDetected && !report.cursorWired) {
      outputText('  Fix: run `plur init --cursor` from this project — this project\'s own')
      outputText('       .cursor/ config is incomplete even though other checks above passed.')
    }
    if (!report.embedder.modelLoaded && !report.embedder.disabled) {
      outputText('  Fix: from the @plur-ai/core package directory, run a script that imports')
      outputText('       @huggingface/transformers and calls pipeline() once to trigger the')
      outputText('       BGE-small-en-v1.5 download (~130MB).')
    }
  }
}

/** Explicit Codex check: never substitute another editor or a recommended entry. */
async function codexReport(skipHandshake: boolean) {
  const path = codexConfigTomlPath()
  const report = {
    target: 'codex', configPath: path, cliVersion: CLI_VERSION,
    verificationScope: 'User config, local stdio, and this process environment. Project/profile overrides, desktop environment, hook trust and end-to-end remote writes require verification in the actual Codex session.',
    registered: false, enabled: true, storageRoot: null as string | null,
    tokenVariables: [] as Array<{ name: string; available: boolean; fix?: string }>,
    handshake: { ok: false, skipped: skipHandshake } as { ok: boolean; skipped: boolean; serverVersion?: string; toolCount?: number; error?: string },
    versionMatches: null as boolean | null,
    problems: [] as string[], overall: 'fail' as 'ok' | 'fail' | 'unverified',
  }
  try {
    const entry = existsSync(path) ? readCodexEntry(readFileSync(path, 'utf8')) : null
    if (!entry) { report.problems.push('Codex has no user PLUR MCP registration. Run `plur init --codex`.'); return report }
    report.registered = true
    if (entry.url) { report.problems.push('HTTP MCP registration preserved; this diagnostic checks local stdio only. Verify this server in Codex.'); return report }
    report.enabled = entry.enabled !== false
    if (!report.enabled) { report.problems.push('Codex PLUR MCP is explicitly disabled.'); return report }
    const env = codexMcpEnvironment(entry)
    // Codex does not inherit arbitrary PLUR_PATH from the invoking shell.
    const envValue = (name: string) => process.platform === 'win32'
      ? Object.entries(env).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1] : env[name]
    const inheritedRoot = envValue('PLUR_PATH')
      ? resolve(entry.cwd ?? process.cwd(), envValue('PLUR_PATH')!)
      : join(envValue(process.platform === 'win32' ? 'USERPROFILE' : 'HOME') || homedir(), '.plur')
    report.storageRoot = codexStorageRoot(entry, inheritedRoot)
    for (const name of configuredTokenVariables(report.storageRoot)) {
      const available = !!envValue(name)?.trim()
      const forwarded = Object.hasOwn(entry.env ?? {}, name) || (entry.env_vars ?? []).some(v => (typeof v === 'string' ? v : v.name) === name)
      report.tokenVariables.push({ name, available, ...(!available ? { fix: forwarded
        ? `Set ${name} in the environment that launches Codex, then restart Codex. A terminal variable does not establish desktop availability.`
        : `Run plur init --codex to add ${name} to env_vars, then restart Codex.` } : {}) })
    }
    if (report.tokenVariables.some(v => !v.available)) report.problems.push('Remote token variables are unavailable to the configured Codex subprocess; writes may remain queued.')
    if (!skipHandshake) {
      const result = await mcpHandshake(20000, undefined, { entry, source: `Codex user config (${path})`, env, cwd: entry.cwd })
      // No command, server errors or stderr: custom arguments may contain secrets.
      report.handshake = { ok: result.ok, skipped: false, serverVersion: result.serverVersion, toolCount: result.toolCount,
        ...(!result.ok ? { error: 'Configured Codex MCP failed initialize/tools/list. Check its command, paths and environment.' } : {}) }
      report.versionMatches = result.ok && result.serverVersion === CLI_VERSION
      if (!result.ok) report.problems.push(report.handshake.error!)
      else if (!report.versionMatches) report.problems.push(`Codex MCP version ${result.serverVersion ?? 'unknown'} differs from CLI ${CLI_VERSION}. Run plur init --codex and restart Codex; check deliberate newer/custom pins manually.`)
    }
    report.overall = report.problems.length ? 'fail' : skipHandshake ? 'unverified' : 'ok'
  } catch {
    report.problems.push('Codex configuration or storage could not be read safely. Check config.toml and PLUR config.yaml; nothing was changed.')
  }
  return report
}

export async function run(args: string[], flags: GlobalFlags): Promise<void> {
  const skipHandshake = args.includes('--no-handshake')
  if (args.includes('--codex')) {
    const report = await codexReport(skipHandshake)
    if (shouldOutputJson(flags)) outputJson(report)
    else {
      outputText(`Codex MCP: ${report.overall} (${report.configPath})`)
      outputText(`CLI ${report.cliVersion}; MCP ${report.handshake.serverVersion ?? 'not verified'}`)
      for (const problem of report.problems) outputText(problem)
      for (const variable of report.tokenVariables) if (variable.fix) outputText(variable.fix)
      outputText(report.verificationScope)
    }
    process.exit(report.overall === 'ok' ? 0 : 1)
  }
  const report = await buildReport(skipHandshake, flags)

  if (shouldOutputJson(flags)) {
    outputJson(report)
  } else {
    printText(report, flags)
  }

  process.exit(report.overall === 'ok' ? 0 : 1)
}
