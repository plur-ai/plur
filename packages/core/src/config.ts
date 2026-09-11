import { readFileSync } from 'fs'
import yaml from 'js-yaml'
import { PlurConfigSchema, StoreEntrySchema, type PlurConfig } from './schemas/config.js'
import { SENSITIVITY_CATEGORIES } from './schemas/scope-metadata.js'
import { logger } from './logger.js'

/**
 * Load config with per-entry tolerance for the `stores` array.
 *
 * Why per-entry: previously this was a single PlurConfigSchema.parse() that
 * threw on any single invalid `stores` entry — and the catch returned an
 * empty config, silently dropping every other valid entry too. In the wild
 * that meant a pre-0.9.5 MCP process running against a 0.9.6+ config (which
 * has `url`-based remote stores its schema doesn't know about) would: load
 * → throw → fall back to empty → save back over the file → permanently lose
 * the user's remote store registration.
 *
 * New behavior: parse the top-level config with a permissive `stores`
 * placeholder, then validate each store entry individually with safeParse.
 * Invalid entries are dropped with a loud warning naming the entry; valid
 * entries survive. The end result: forward/backward schema drift loses at
 * most the malformed entries, never the whole file.
 */
export function loadConfig(configPath: string): PlurConfig {
  let raw: Record<string, unknown>
  try {
    raw = yaml.load(readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return PlurConfigSchema.parse({})
    // YAML parser errors can include the source line, including tokens. Do
    // not render them, and never enable default capture/routing after failure.
    throw new Error(`[plur:config] cannot read or parse configuration at ${configPath}; repair it before continuing`)
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`[plur:config] configuration at ${configPath} must be a mapping`)
  }
  // Validate each store entry independently before the top-level parse so
  // a single bad entry can't take the whole file down.
  if (Array.isArray(raw.stores)) {
    const validStores: unknown[] = []
    for (let i = 0; i < raw.stores.length; i++) {
      const entry = raw.stores[i]
      const parsed = StoreEntrySchema.safeParse(entry)
      if (parsed.success) {
        validStores.push(entry)
      } else {
        logger.warning(`[plur:config] dropping invalid stores[${i}] from ${configPath}: ${parsed.error.issues.map(it => `${it.path.join('.')}: ${it.code}`).join('; ')}`)
      }
    }
    raw.stores = validStores
  }
  let parsed: PlurConfig
  try {
    parsed = PlurConfigSchema.parse(raw)
  } catch (err) {
    throw new Error(`[plur:config] invalid configuration at ${configPath}; repair it before continuing`)
  }
  // PR-3 (#353) scope-naming pass. ScopeSensitivitySchema.forbid now preprocesses
  // unknown categories away (non-fatal), but the field-level preprocess can't
  // name the SCOPE it belongs to. Diff the raw `forbid` against the parsed one
  // per entry and emit a scope-named warning so an operator can find the entry.
  if (Array.isArray(raw.stores) && parsed.stores) {
    for (let i = 0; i < parsed.stores.length; i++) {
      const rawEntry = (raw.stores as unknown[])[i] as { sensitivity?: { forbid?: unknown } } | undefined
      const rawForbid = rawEntry?.sensitivity?.forbid
      if (!Array.isArray(rawForbid)) continue
      const dropped = rawForbid.filter((c) => !(SENSITIVITY_CATEGORIES as readonly string[]).includes(c as string))
      if (dropped.length) {
        logger.warning(`[plur:config] scope=${parsed.stores[i].scope}: dropped unknown sensitivity categor${dropped.length > 1 ? 'ies' : 'y'} ${JSON.stringify(dropped)} from forbid (entry kept, url/token intact)`)
      }
    }
  }
  return parsed
}
