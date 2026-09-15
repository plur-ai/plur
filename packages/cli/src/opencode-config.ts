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
   * False when `configPath` exists but could not be parsed as JSON — most
   * commonly an `opencode.jsonc` file using comments or trailing commas,
   * which a plain `JSON.parse` rejects. The file is left completely
   * untouched in that case: coercing it to `{}` and writing back would
   * discard whatever config the user already has (the same failure mode
   * `readConfigForWrite` in `mcp-config.ts` refuses for every other host).
   * True for every other outcome, including a fresh install.
   */
  ok: boolean
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
  let cfg: any
  if (created) {
    cfg = { $schema: 'https://opencode.ai/config.json' }
  } else {
    try {
      cfg = JSON.parse(readFileSync(configPath, 'utf8'))
    } catch {
      return { created: false, changed: false, ok: false }
    }
  }
  const before = JSON.stringify(cfg)

  cfg.plugin = Array.isArray(cfg.plugin) ? cfg.plugin : []
  if (!cfg.plugin.includes(PLUGIN)) cfg.plugin.push(PLUGIN)

  cfg.mcp = cfg.mcp ?? {}
  cfg.mcp.plur = {
    type: 'local',
    command: ['npx', '-y', `@plur-ai/mcp@${cliVersion}`],
    enabled: true,
  }

  const changed = JSON.stringify(cfg) !== before
  if (created || changed) {
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
  }
  return { created, changed, ok: true }
}
