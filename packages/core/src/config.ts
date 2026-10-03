import { existsSync, readFileSync } from 'fs'
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
  if (!existsSync(configPath)) return PlurConfigSchema.parse({})
  let raw: Record<string, unknown>
  try {
    raw = (yaml.load(readFileSync(configPath, 'utf8')) as Record<string, unknown>) ?? {}
  } catch (err) {
    logger.warning(`[plur:config] cannot parse YAML at ${configPath}: ${(err as Error).message} — falling back to defaults`)
    return PlurConfigSchema.parse({})
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
        const label = (entry as { url?: string; path?: string; scope?: string })?.scope
          ?? (entry as { url?: string; path?: string })?.url
          ?? (entry as { path?: string })?.path
          ?? `index ${i}`
        logger.warning(`[plur:config] dropping invalid stores[${i}] (${label}) from ${configPath}: ${parsed.error.issues.map(it => it.message).join('; ')}`)
      }
    }
    raw.stores = validStores
  }
  let parsed: PlurConfig
  try {
    parsed = PlurConfigSchema.parse(raw)
  } catch (err) {
    logger.warning(`[plur:config] top-level config invalid at ${configPath}: ${(err as Error).message} — falling back to defaults`)
    return PlurConfigSchema.parse({})
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
  return resolveStoreTokens(parsed)
}

/**
 * The token a `token_env` reference names (#1561): the variable's value,
 * trimmed, or undefined when it is unset or blank.
 */
export function tokenFromEnv(name: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!name) return undefined
  const v = (env[name] ?? '').trim()
  return v ? v : undefined
}

/**
 * Fill each remote store's `token` from its `token_env` variable, when the
 * file names one and carries no token of its own (#1561). In memory only:
 * {@link storeEntryForDisk} keeps the resolved value out of every write-back.
 */
const warnedUnsetTokenEnv = new Set<string>()

function resolveStoreTokens(config: PlurConfig): PlurConfig {
  if (!config.stores?.some(s => s.token_env && !s.token)) return config
  return {
    ...config,
    stores: config.stores.map((s) => {
      if (!s.token_env || s.token) return s
      const token = tokenFromEnv(s.token_env)
      if (!token) {
        // Once per process and store: every config reload used to repeat it.
        const once = `${s.scope}\0${s.token_env}`
        if (warnedUnsetTokenEnv.has(once)) return s
        warnedUnsetTokenEnv.add(once)
        logger.warning(`[plur:config] store "${s.scope}" (${s.url ?? s.path}): token_env ${s.token_env} is unset or empty — the store has no token`)
        return s
      }
      return { ...s, token }
    }),
  }
}

/**
 * A store entry as it is written to config.yaml (#1561). An entry that names
 * `token_env` keeps the reference and drops a `token` equal to the variable's
 * value — the value it was resolved to at load — so no write-back of the
 * stores list stores the secret. A token that differs from the variable (one
 * the user wrote into the file) is kept as written. Keys left `undefined` by a
 * caller (a rotation that clears `token_env`) are removed.
 */
export function storeEntryForDisk<T extends Record<string, unknown>>(entry: T): T {
  const out: Record<string, unknown> = { ...entry }
  for (const k of ['token', 'token_env']) if (out[k] === undefined) delete out[k]
  const name = typeof out.token_env === 'string' ? out.token_env : undefined
  if (name && typeof out.token === 'string' && out.token === tokenFromEnv(name)) delete out.token
  return out as T
}
