import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'

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

const PLUGIN = '@plur-ai/opencode'

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
      return { created: false, changed: false, ok: false }
    }
    // Valid JSON, wrong shape (most commonly `[]`) — refuse rather than let
    // every property set below land as a silently-dropped non-index prop.
    // See WriteOpencodeConfigResult.ok for the full failure mode this closes.
    if (!isPlainObject(parsed)) return { created: false, changed: false, ok: false }
    cfg = parsed
  }

  // Same refuse-don't-coerce stance for the two fields this function owns:
  // a PRESENT value of the wrong shape is the user's data, not a blank slate
  // to silently overwrite. Absent (`undefined`) is the normal case and is
  // NOT refused — that's every fresh/untouched config.
  if (cfg.plugin !== undefined && !Array.isArray(cfg.plugin)) {
    return { created: false, changed: false, ok: false }
  }
  if (cfg.mcp !== undefined && cfg.mcp !== null && !isPlainObject(cfg.mcp)) {
    return { created: false, changed: false, ok: false }
  }

  const before = JSON.stringify(cfg)

  const plugins = Array.isArray(cfg.plugin) ? cfg.plugin as unknown[] : []
  if (!plugins.includes(PLUGIN)) plugins.push(PLUGIN)
  cfg.plugin = plugins

  const mcp: Record<string, unknown> = isPlainObject(cfg.mcp) ? cfg.mcp : {}
  mcp.plur = {
    type: 'local',
    command: ['npx', '-y', `@plur-ai/mcp@${cliVersion}`],
    enabled: true,
  }
  cfg.mcp = mcp

  const changed = JSON.stringify(cfg) !== before
  if (created || changed) {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
  }
  return { created, changed, ok: true }
}
