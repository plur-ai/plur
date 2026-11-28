import { existsSync, readFileSync } from 'fs'
import yaml from 'js-yaml'
import { PlurConfigSchema, StoreEntrySchema, ServerStoreEntrySchema, type PlurConfig } from './schemas/config.js'
import { SENSITIVITY_CATEGORIES } from './schemas/scope-metadata.js'
import { logger } from './logger.js'
import { isServerStoreEntry, expandServerEntry, serverEntryIdentities, EXPANDED_FROM, safeOrigin } from './store-expand.js'

/**
 * Load config with per-entry tolerance for the `stores` array.
 *
 * The top-level config is parsed with a permissive `stores` placeholder and
 * each store entry is validated individually with safeParse. Invalid entries
 * are dropped with a warning naming the entry; valid entries survive. A single
 * whole-file parse would turn one bad entry (e.g. a newer entry shape an older
 * process does not know) into an empty config, which a later save would write
 * back over the file and lose every store registration. Schema drift therefore
 * loses at most the malformed entries, never the whole file.
 */
export function loadConfig(configPath: string): PlurConfig {
  if (!existsSync(configPath)) return PlurConfigSchema.parse({})
  let raw: Record<string, unknown>
  let text = ''
  try {
    text = readFileSync(configPath, 'utf8')
  } catch (err) {
    // A file that exists but cannot be read (permissions, an I/O error) may
    // hold the owner's pin restriction: the policy is `request`, as for YAML
    // whose pinning block cannot be read back.
    logger.warning(`[plur:config] cannot read ${configPath}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message} — falling back to defaults, pinning.agents request`)
    return fallbackConfig(FAIL_SAFE_PINNING)
  }
  try {
    raw = (yaml.load(text) as Record<string, unknown>) ?? {}
  } catch (err) {
    logger.warning(`[plur:config] cannot parse YAML at ${configPath}: ${(err as Error).message} — falling back to defaults`)
    return fallbackConfig(pinningFromBrokenYaml(text))
  }
  // Validate each store entry independently before the top-level parse so
  // a single bad entry can't take the whole file down.
  // Server entries (url + scopes) are expanded into one in-memory entry per
  // scope before the per-entry StoreEntrySchema check.
  if (Array.isArray(raw.stores)) {
    const validStores: unknown[] = []
    // Computed on the raw entries, exactly as persistStores does under the lock.
    const identities = serverEntryIdentities(raw.stores)
    for (let i = 0; i < raw.stores.length; i++) {
      const entry = raw.stores[i]
      if (isServerStoreEntry(entry)) {
        const serverParsed = ServerStoreEntrySchema.safeParse(entry)
        if (!serverParsed.success) {
          // Paths and codes only: a Zod message can embed the received value.
          const url = (entry as { url?: unknown })?.url
          const label = typeof url === 'string' ? safeOrigin(url) : `index ${i}`
          logger.warning(`[plur:config] dropping invalid server entry stores[${i}] (${label}) from ${configPath}: ${serverParsed.error.issues.map(it => `${it.path.join('.') || '(root)'}: ${it.code}`).join('; ')}`)
          continue
        }
        for (const expanded of expandServerEntry(serverParsed.data, identities[i]!)) {
          validStores.push(expanded)
        }
      } else {
        const parsed = StoreEntrySchema.safeParse(entry)
        if (parsed.success) {
          validStores.push(entry)
        } else {
          const label = (entry as { url?: string; path?: string; scope?: string })?.scope
            ?? (typeof (entry as { url?: unknown })?.url === 'string' ? safeOrigin((entry as { url: string }).url) : undefined)
            ?? (entry as { path?: string })?.path
            ?? `index ${i}`
          logger.warning(`[plur:config] dropping invalid stores[${i}] (${label}) from ${configPath}: ${parsed.error.issues.map(it => it.message).join('; ')}`)
        }
      }
    }
    raw.stores = validStores
  }
  let parsed: PlurConfig
  try {
    parsed = PlurConfigSchema.parse(raw)
  } catch (err) {
    logger.warning(`[plur:config] top-level config invalid at ${configPath}: ${(err as Error).message} — falling back to defaults`)
    return fallbackConfig(readablePinning(raw))
  }
  // ScopeSensitivitySchema.forbid preprocesses unknown categories away
  // (non-fatal), but the field-level preprocess can't name the SCOPE it
  // belongs to. Diff the raw `forbid` against the parsed one per entry and
  // emit a scope-named warning so an operator can find the entry.
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
 * Defaults for a config.yaml that cannot be fully read, keeping the owner's
 * pin policy (0.24 audit, finding 5): an error elsewhere in the file must
 * never relax `pinning.agents` to the `allow` default.
 */
function fallbackConfig(pinning: PlurConfig['pinning'] | undefined): PlurConfig {
  const base = PlurConfigSchema.parse({})
  return pinning ? { ...base, pinning } : base
}

const FAIL_SAFE_PINNING = { agents: 'request' } as PlurConfig['pinning']

/**
 * The owner's `pinning` section from a parsed file whose other keys may be
 * invalid: parsed alone (an invalid `agents` value already fails safe to
 * `request`); a section that cannot be read at all is `request`; no section
 * is undefined (the `allow` default stands).
 */
function readablePinning(raw: unknown): PlurConfig['pinning'] | undefined {
  if (!raw || typeof raw !== 'object' || !('pinning' in raw)) return undefined
  const parsed = PlurConfigSchema.safeParse({ pinning: (raw as { pinning: unknown }).pinning })
  return parsed.success ? parsed.data.pinning : FAIL_SAFE_PINNING
}

/**
 * The owner's `pinning` section from YAML that does not parse as a whole:
 * the top-level `pinning:` block (the key line and its indented lines) is
 * parsed on its own. A file that never mentions pinning keeps the default;
 * one that mentions it in a form that cannot be read back is `request`.
 */
function pinningFromBrokenYaml(text: string): PlurConfig['pinning'] | undefined {
  if (!/\bpinning\b/.test(text)) return undefined
  const blocks = [...text.matchAll(/^pinning[ \t]*:.*(?:\r?\n(?:[ \t]+.*|[ \t]*))*/gm)]
  if (blocks.length !== 1) return FAIL_SAFE_PINNING
  try {
    return readablePinning(yaml.load(blocks[0]![0])) ?? FAIL_SAFE_PINNING
  } catch {
    return FAIL_SAFE_PINNING
  }
}

/**
 * The token a `token_env` reference names: the variable's value, trimmed,
 * or undefined when it is unset or blank.
 */
export function tokenFromEnv(name: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!name) return undefined
  const v = (env[name] ?? '').trim()
  return v ? v : undefined
}

/**
 * Fill each remote store's `token` from its `token_env` variable, when the
 * file names one and carries no token of its own. In memory only:
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
        // Warn once per process and store, not on every config reload.
        const once = `${s.scope}\0${s.token_env}`
        if (warnedUnsetTokenEnv.has(once)) return s
        warnedUnsetTokenEnv.add(once)
        logger.warning(`[plur:config] store "${s.scope}" (${s.url ? safeOrigin(s.url) : s.path}): token_env ${s.token_env} is unset or empty — the store has no token`)
        return s
      }
      return { ...s, token }
    }),
  }
}

/**
 * A store entry as it is written to config.yaml. An entry that names
 * `token_env` keeps the reference and drops a `token` equal to the variable's
 * value — the value it was resolved to at load — so no write-back of the
 * stores list stores the secret. A token that differs from the variable (one
 * the user wrote into the file) is kept as written. Keys left `undefined` by a
 * caller (a rotation that clears `token_env`) are removed.
 */
export function storeEntryForDisk<T extends Record<string, unknown>>(entry: T): T {
  const out: Record<string, unknown> = { ...entry }
  for (const k of ['token', 'token_env']) if (out[k] === undefined) delete out[k]
  // Remove the in-memory expansion marker so it never reaches disk.
  delete out[EXPANDED_FROM]
  const name = typeof out.token_env === 'string' ? out.token_env : undefined
  if (name && typeof out.token === 'string' && out.token === tokenFromEnv(name)) delete out.token
  return out as T
}
