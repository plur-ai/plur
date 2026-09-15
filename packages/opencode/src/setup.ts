import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PLUGIN = '@plur-ai/opencode'

export interface WriteOpencodeConfigResult {
  created: boolean
  changed: boolean
  /**
   * False when `configPath` exists but could not be parsed as JSON — most
   * commonly an `opencode.jsonc` file using comments or trailing commas,
   * which a plain `JSON.parse` rejects. The file is left completely
   * untouched in that case: coercing it to `{}` and writing back would
   * discard whatever config the user already has (the same failure mode
   * `readConfigForWrite` in the CLI package refuses for every other host).
   * True for every other outcome, including a fresh install.
   */
  ok: boolean
}

/**
 * Add PLUR to an opencode config, preserving everything else in it.
 *
 * Writes both layers deliberately: `plugin` for automatic memory (recall
 * injected each turn, learning harvested after it — no tool calls needed),
 * and `mcp.plur` for the explicit `plur_*` tool surface from `@plur-ai/mcp`,
 * for when the user wants to query or teach memory directly. Mirrors PLUR's
 * three-layer strategy (context files + hooks/plugins + MCP tools).
 *
 * opencode merges config files rather than replacing them, and users will
 * have existing `opencode.json` files with unrelated keys (`model`, `theme`,
 * `permission`, …) — this only ever adds to `plugin` and sets `mcp.plur`,
 * never touching anything else. Idempotent: a second run with the same
 * `cliVersion` changes nothing.
 *
 * `configPath` may point at an `opencode.json` or an `opencode.jsonc` file —
 * whichever one the caller decided is the user's real config. A `.jsonc`
 * file that uses comments will fail to parse here; see `ok` above for how
 * that is handled.
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
