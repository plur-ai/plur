import { existsSync, lstatSync, readFileSync, realpathSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { atomicWrite } from '@plur-ai/core'

/**
 * Support for opencode's config file: `~/.config/opencode/opencode.json`
 * (or `.jsonc`) — global only, no per-project variant.
 *
 * Structurally unlike every other host `plur init` writes into: there is no
 * hooks section to merge. opencode reads memory through two separate
 * top-level keys instead, and `plur init --opencode` writes BOTH,
 * deliberately:
 *
 *   - `plugin: ["@plur-ai/opencode"]` — the automatic layer (recall injected
 *     each turn, learning harvested after it), which needs no tool calls
 *     from the model. opencode's own installer resolves and fetches that
 *     package from npm at plugin-load time — THIS file only ever writes the
 *     package's *name* into the config; the CLI has no dependency on it and
 *     none is needed to write a string into a JSON file.
 *   - `mcp.plur` — the explicit `plur_*` tool surface from `@plur-ai/mcp`,
 *     for when the user wants to query or teach memory directly.
 *
 * Same three-layer strategy PLUR already commits to everywhere else
 * (context files + hooks/plugins + MCP tools).
 *
 * opencode merges config files rather than replacing them, and users will
 * have existing `opencode.json` files with unrelated keys (`model`, `theme`,
 * `permission`, …) — `writeOpencodeConfig` only ever adds to `plugin` and
 * sets `mcp.plur`, never touching anything else, and is idempotent.
 *
 * opencode also accepts `opencode.jsonc` (JSON-with-comments) as an
 * alternative filename. `opencodeConfigPath()` targets an existing `.jsonc`
 * over creating a competing `.json` (see its docstring for why), and
 * `writeOpencodeConfig` does a plain `JSON.parse`, which throws on real
 * JSONC syntax — that failure is reported (`ok: false`) and the file is left
 * completely untouched, never silently coerced to `{}` and written back
 * over. Same refusal shape every other host leg in `init.ts` gives for a
 * config file it cannot safely parse (#1059 class).
 */

export interface WriteOpencodeConfigResult {
  created: boolean
  changed: boolean
  /**
   * False, and the file left completely untouched, when `configPath` exists
   * but isn't safely writable as PLUR's two keys:
   *
   *   - it doesn't parse as JSON at all — most commonly an `opencode.jsonc`
   *     file using comments or trailing commas, which a plain `JSON.parse`
   *     rejects;
   *   - it parses, but the top-level value isn't a plain object (a
   *     top-level array is syntactically valid JSON and parses fine, but
   *     every property this function would set on it — `plugin`, `mcp` — is
   *     a non-index property that `JSON.stringify` silently drops. Without
   *     this check that reads back as an inert success: nothing throws,
   *     `changed` computes `false` because the serialized array never
   *     visibly differs, and the caller reports "already up to date" while
   *     PLUR was never written);
   *   - `plugin` or `mcp` is already present but the wrong shape (`plugin`
   *     not an array; `mcp` not a plain object) — coercing either to a
   *     fresh empty value would silently discard whatever the user had
   *     there, the exact same silent-loss failure the checks above exist to
   *     prevent, just one level down.
   *
   * Never coerce any of the above to `{}`/`[]` and write back — that would
   * discard whatever config the user already has (the same failure mode
   * `readConfigForWrite` in `mcp-config.ts` refuses for every other host).
   * True for every other outcome, including a fresh install.
   */
  ok: boolean
  /**
   * True when `mcp.plur` already had a non-null value BEFORE this call and
   * was left completely untouched — PLUR's own `{type: 'local', command:
   * [...]}` entry was NOT written over it (0.20.0 audit, B2).
   *
   * `mcp.plur` is the user's data, not a blank slate: the damaging case is a
   * user who pointed PLUR at a non-default store (`environment.PLUR_PATH`)
   * or an enterprise `type: 'remote'` entry with bearer headers. A remote
   * entry's fields (`type`, `url`, `headers`) don't map field-for-field onto
   * a local one's (`type`, `command`), so a partial "merge only what we own"
   * risks producing a hybrid that is neither — same refuse-don't-coerce
   * stance the shape guards above already take for `plugin`/`mcp`
   * themselves, one level down. The caller (`plur init`) surfaces this flag
   * in its output so the user is told PLUR's entry was left as-is, rather
   * than silently discovering later that memory writes went somewhere they
   * didn't expect.
   *
   * Always `false` when there was no pre-existing `mcp.plur` (including a
   * fresh `created` config) — there was nothing to preserve.
   *
   * Known tradeoff: this also means a re-run of `plur init --opencode` after
   * a CLI upgrade will NOT refresh the pinned `@plur-ai/mcp@<version>` inside
   * an existing entry (unlike the fresh-write case, which always pins
   * CLI_VERSION — see the file-level docstring, #1069). A narrower "only
   * touch it if it looks like our own previous write" heuristic was
   * considered and rejected: a user who added `environment.PLUR_PATH` on top
   * of an otherwise-standard-looking local entry would still match that
   * shape, and get silently overwritten anyway — the exact failure this
   * flag exists to prevent, just gated behind a heuristic instead of open.
   * Leaving it alone unconditionally is the version that cannot regress that
   * way; a stale pin is a much smaller cost than a lost store pointer.
   */
  mcpPlurPreserved: boolean
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
 * opencode's global config directory. Everything `plur init --opencode`
 * touches lives here — no per-project variant, same reasoning as agy's
 * config dir: one global engram store, one place to register it.
 */
export function opencodeConfigDir(): string {
  return join(homedir(), '.config', 'opencode')
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
   * declarations out of it — the exact same refusal cases
   * `WriteOpencodeConfigResult.ok` documents: invalid JSON (most commonly
   * JSONC comments/trailing commas), a top-level value that isn't a plain
   * object, or an existing `plugin`/`mcp` field in the wrong shape. `true`
   * when the file doesn't exist — there is nothing unsafe about "not there".
   */
  ok: boolean
  /** `plugin` is an array containing `PLUR_OPENCODE_PLUGIN`. False when `ok` is false. */
  pluginDeclared: boolean
  /** `mcp.plur` is present (any non-null value). False when `ok` is false. */
  mcpPlurDeclared: boolean
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
    return { exists: false, ok: true, pluginDeclared: false, mcpPlurDeclared: false }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return { exists: true, ok: false, pluginDeclared: false, mcpPlurDeclared: false }
  }
  if (!isPlainObject(parsed)) {
    return { exists: true, ok: false, pluginDeclared: false, mcpPlurDeclared: false }
  }
  if (parsed.plugin !== undefined && parsed.plugin !== null && !Array.isArray(parsed.plugin)) {
    return { exists: true, ok: false, pluginDeclared: false, mcpPlurDeclared: false }
  }
  if (parsed.mcp !== undefined && parsed.mcp !== null && !isPlainObject(parsed.mcp)) {
    return { exists: true, ok: false, pluginDeclared: false, mcpPlurDeclared: false }
  }

  const pluginDeclared = Array.isArray(parsed.plugin) && (parsed.plugin as unknown[]).includes(PLUGIN)
  const mcpPlurDeclared = isPlainObject(parsed.mcp) && parsed.mcp.plur !== undefined && parsed.mcp.plur !== null
  return { exists: true, ok: true, pluginDeclared, mcpPlurDeclared }
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
): WriteOpencodeConfigResult {
  const created = !existsSync(configPath)
  let cfg: Record<string, unknown>
  if (created) {
    cfg = { $schema: 'https://opencode.ai/config.json' }
  } else {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return { created: false, changed: false, ok: false, mcpPlurPreserved: false }
    }
    // Valid JSON, wrong shape (most commonly `[]`) — refuse rather than let
    // every property set below land as a silently-dropped non-index prop.
    // See WriteOpencodeConfigResult.ok for the full failure mode this closes.
    if (!isPlainObject(parsed)) return { created: false, changed: false, ok: false, mcpPlurPreserved: false }
    cfg = parsed
  }

  // Same refuse-don't-coerce stance for the two fields this function owns:
  // a PRESENT value of the wrong shape is the user's data, not a blank slate
  // to silently overwrite. `undefined` OR `null` is treated as "not set" for
  // both fields, consistently — that's every fresh/untouched config, plus
  // the (uncommon but real) case of a user writing `null` to mean "nothing
  // here yet." Neither is refused.
  if (cfg.plugin !== undefined && cfg.plugin !== null && !Array.isArray(cfg.plugin)) {
    return { created: false, changed: false, ok: false, mcpPlurPreserved: false }
  }
  if (cfg.mcp !== undefined && cfg.mcp !== null && !isPlainObject(cfg.mcp)) {
    return { created: false, changed: false, ok: false, mcpPlurPreserved: false }
  }

  const before = JSON.stringify(cfg)

  const plugins = Array.isArray(cfg.plugin) ? cfg.plugin as unknown[] : []
  if (!plugins.includes(PLUGIN)) plugins.push(PLUGIN)
  cfg.plugin = plugins

  const mcp: Record<string, unknown> = isPlainObject(cfg.mcp) ? cfg.mcp : {}
  // B2 (0.20.0 audit): see WriteOpencodeConfigResult.mcpPlurPreserved for the
  // full rationale. A PRESENT, non-null `mcp.plur` is left completely alone;
  // PLUR's entry is written only when there is nothing there to lose.
  const mcpPlurPreserved = mcp.plur !== undefined && mcp.plur !== null
  if (!mcpPlurPreserved) {
    mcp.plur = {
      type: 'local',
      command: ['npx', '-y', `@plur-ai/mcp@${cliVersion}`],
      enabled: true,
    }
  }
  cfg.mcp = mcp

  const changed = JSON.stringify(cfg) !== before
  if (created || changed) {
    // atomicWrite (write tmp → fsync → rename) instead of a direct
    // writeFileSync: writeFileSync opens with O_TRUNC, destroying the
    // existing config before a single byte of the new content is written —
    // a crash, OOM, full disk, or suspend in that window loses a config that
    // can carry 40+ MCP server entries (0.20.0 audit, B3). resolveWriteTarget
    // keeps this a write-through when configPath is itself a symlink.
    atomicWrite(resolveWriteTarget(configPath), JSON.stringify(cfg, null, 2) + '\n')
  }
  return { created, changed, ok: true, mcpPlurPreserved }
}
