import { isSharedScope } from './scope-util.js'
import { logger } from './logger.js'
import { mergeSensitivityForWriteback } from './sensitivity-writeback.js'
import { normalizeEndpointUrl } from './store/remote-store.js'
import { ScopeSettingsSchema, type StoreEntry, type ServerStoreEntry } from './schemas/config.js'

/** In-memory marker added to each expanded entry. Value = the server entry's
 * identity ({@link serverEntryIdentities}), never its array position: another
 * process may insert or reorder entries between this load and the locked
 * reread of a writeback. Stripped by storeEntryForDisk before any writeback. */
export const EXPANDED_FROM = '_expanded_from' as const

// Safe grammar for server-supplied scope strings (#426, #408).
const SCOPE_RE = /^[\w:./-]+$/

/**
 * Returns true when a raw YAML object should be loaded as a server entry.
 * A server entry has both `url` and an own `scopes` key. The `enterprise`
 * block is NOT required (preserves the #1220 fixture).
 */
export function isServerStoreEntry(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  return 'url' in raw && 'scopes' in raw
}

/**
 * The identity of a server entry, from its raw YAML: url (canonical endpoint
 * identity, {@link normalizeEndpointUrl}), compat `scope`,
 * `scopes`, `pinned_scopes`, `readonly` and `token_env` (never the token).
 * These are what tell two server entries apart; metadata (`discovery`,
 * `enterprise`, `scope_settings`) is not part of it, so a metadata change by
 * another process does not orphan this process's entries.
 */
export function serverEntryIdentityBase(raw: unknown): string {
  const o = raw as Record<string, unknown>
  // The url by its canonical endpoint identity: two spellings of one server
  // are one identity (Codex round 3, finding 2).
  const url = typeof o.url === 'string' ? normalizeEndpointUrl(o.url) : o.url
  return JSON.stringify([url, o.scope, o.scopes, o.pinned_scopes, o.readonly, o.token_env])
}

/**
 * One identity per position of a raw `stores` array (`undefined` for an entry
 * that is not a server entry): the identity base plus `#n`, its occurrence
 * among entries with the same base. Computed the same way at load and on the
 * fresh read under the config lock, so an expanded entry finds its server
 * entry wherever it now sits, and an inserted entry with a different base
 * never matches. The token is not part of the base, so two entries that
 * differ only in their token share it; the collapse writes nothing for such a
 * base and rotation refuses it (owner decision 17;
 * spec/formal/findings/store-entry.md C3, routing-discovery.md D5).
 */
export function serverEntryIdentities(rawStores: unknown[]): (string | undefined)[] {
  const seen = new Map<string, number>()
  return rawStores.map((raw) => {
    if (!isServerStoreEntry(raw)) return undefined
    const base = serverEntryIdentityBase(raw)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return `${base}#${n}`
  })
}

/** The identity base of a `serverEntryIdentities` value. */
export function identityBaseOf(identity: string): string {
  return identity.slice(0, identity.lastIndexOf('#'))
}

/**
 * Expand one server entry into one in-memory `StoreEntry` per scope.
 *
 * Order: scopes[], then pinned_scopes[] entries not already seen, then the
 * compat `scope` if not already seen. Deduplication preserves first-seen order.
 * Scope strings failing the safe grammar are dropped with a warning.
 *
 * Each expanded entry carries `[EXPANDED_FROM]: identity` so the writeback
 * collapse step can map it back to the original server entry.
 */
export function expandServerEntry(entry: ServerStoreEntry, identity: string): StoreEntry[] {
  const seen = new Set<string>()
  const ordered: string[] = []

  for (const scope of entry.scopes ?? []) {
    if (!seen.has(scope)) { seen.add(scope); ordered.push(scope) }
  }
  for (const scope of entry.pinned_scopes ?? []) {
    if (!seen.has(scope)) { seen.add(scope); ordered.push(scope) }
  }
  if (entry.scope && !seen.has(entry.scope)) {
    seen.add(entry.scope); ordered.push(entry.scope)
  }

  const results: StoreEntry[] = []
  let badScopes = 0
  for (const scope of ordered) {
    if (!SCOPE_RE.test(scope)) { badScopes++; continue }
    // Per-scope settings carry metadata only: a key that names the entry's
    // identity or credentials (url, scope, token, …) is ignored, so a
    // scope_settings value can never redirect a scope or swap its token.
    const settings = metadataOnly(entry.scope_settings?.[scope])
    // The compat `scope` also owns the entry's top-level metadata (dial,
    // description, covers, sensitivity, unknown keys): an older client wrote
    // it there for that scope, and dropping it would, for one, lose a
    // `dial: never` and dial a server the user excluded. An explicit
    // `scope_settings[scope]` value takes precedence.
    // The top level is not validated by ServerStoreEntrySchema (passthrough),
    // so it goes through the same shape tolerance as a scope_settings value:
    // a malformed field (`description:` left empty, a number) is dropped. An
    // unvalidated one would fail the whole config's parse, and loadConfig
    // would fall back to defaults — losing every store registration.
    const legacy = scope === entry.scope ? metadataOnly(legacyMetadata(entry)) : {}
    const expanded: Record<string, unknown> = {
      ...legacy,
      ...settings,
      url: entry.url,
      readonly: entry.readonly,
      shared: isSharedScope(scope),
      scope,
      [EXPANDED_FROM]: identity,
    }
    if (entry.token !== undefined) expanded.token = entry.token
    if (entry.token_env !== undefined) expanded.token_env = entry.token_env
    if (entry.enterprise !== undefined) expanded.enterprise = entry.enterprise
    if (entry.discovery !== undefined) expanded.discovery = entry.discovery
    results.push(expanded as unknown as StoreEntry)
  }
  // Never log the scope text itself: it may carry control characters that forge
  // log lines (#408). The url is reduced to its origin, so no userinfo reaches the log.
  if (badScopes) {
    logger.warning(`[plur:config] dropping ${badScopes} scope(s) that fail the safe grammar from server entry ${safeOrigin(entry.url)}`)
  }
  return results
}

// Per-scope metadata fields managed by the collapse step.
const SCOPE_META_KEYS = ['dial', 'description', 'covers', 'sensitivity'] as const

/** A server entry's top level, with its metadata fields shape-checked like a
 *  scope_settings value (ScopeSettingsSchema never fails on a field's value). */
function legacyMetadata(entry: ServerStoreEntry): object {
  const parsed = ScopeSettingsSchema.safeParse(entry)
  return parsed.success ? parsed.data : {}
}

/** The metadata keys of a scope_settings value or of a server entry's top level. */
function metadataOnly(obj: object | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([k, v]) => v !== undefined && !RESERVED_ENTRY_KEYS.has(k)))
}

/** Keys of an expanded entry that metadata (scope_settings or top level) must not set. */
const RESERVED_ENTRY_KEYS = new Set<string>([
  'url', 'path', 'scope', 'scopes', 'pinned_scopes', 'token', 'token_env', 'readonly', 'shared',
  'enterprise', 'discovery', 'scope_settings', EXPANDED_FROM,
])

/** `scheme://host[:port]` of a url, without userinfo, path or query. */
export function safeOrigin(url: string): string {
  try { return new URL(url).origin } catch { return '<invalid url>' }
}

/**
 * Collapse expanded per-scope entries back into the original server entries
 * before writing to disk.
 *
 * Typed entries are grouped by their `EXPANDED_FROM` identity and matched to
 * the raw entry with the same identity in the freshly read `rawStores`; an
 * identity with no raw match (the entry was changed or removed since load)
 * writes nothing, and neither does an identity base two server entries share
 * (on disk now, or at load). For each matched server entry the per-scope metadata
 * fields (dial, description, covers, sensitivity) from its typed entries are
 * written back; every other field (scope, scopes, pinned_scopes, discovery,
 * enterprise, url, token, token_env, readonly) is left byte-identical.
 *
 * Where a field is written: `scope_settings[scope]`, except for the compat
 * `scope`, whose field stays at the top level when that is where it already
 * is (an older client reads it there) and no `scope_settings` value overrides it.
 *
 * `sensitivity` follows the per-scope writeback rule
 * ({@link mergeSensitivityForWriteback}): unknown `forbid` categories and
 * nested keys on disk survive, unless the scope is in
 * `serverSensitivityScopes` (the server's policy was just synced).
 *
 * Returns a new rawStores array of the same length where server entry
 * positions carry the updated collapsed entry and non-server positions are
 * unchanged.
 */
export function collapseExpandedStores(
  typed: StoreEntry[],
  rawStores: unknown[],
  serverSensitivityScopes?: Set<string>,
): unknown[] {
  if (!Array.isArray(rawStores) || !rawStores.length) return rawStores

  // Group typed entries by their EXPANDED_FROM identity.
  const expandedById = new Map<string, StoreEntry[]>()
  for (const entry of typed) {
    const id = (entry as unknown as Record<string, unknown>)[EXPANDED_FROM]
    if (typeof id === 'string') {
      const arr = expandedById.get(id)
      if (arr) arr.push(entry)
      else expandedById.set(id, [entry])
    }
  }

  if (!expandedById.size) return rawStores
  const ids = serverEntryIdentities(rawStores)

  // Owner decision 17: a base shared by two server entries (they differ only
  // in their token) cannot say which of them a typed entry came from, so
  // nothing is written for it — the same refusal as key rotation. Ambiguous
  // in the fresh read (two on disk now) or at load (a typed entry from `#1`
  // or later). Model: spec/formal/PlurSpec/StoreEntry.lean §3.
  const ambiguous = new Set<string>()
  const rawBases = new Set<string>()
  for (const id of ids) {
    if (id === undefined) continue
    const base = identityBaseOf(id)
    if (rawBases.has(base)) ambiguous.add(base)
    rawBases.add(base)
  }
  for (const id of expandedById.keys()) {
    if (!id.endsWith('#0')) ambiguous.add(identityBaseOf(id))
  }

  return rawStores.map((raw, i) => {
    const id = ids[i]
    if (id === undefined) return raw
    if (ambiguous.has(identityBaseOf(id))) return raw
    const entries = expandedById.get(id)
    if (!entries?.length) return raw  // server entry with scopes: [] — no typed entries to process

    const rawObj = raw as Record<string, unknown>
    const collapsed: Record<string, unknown> = { ...rawObj }

    // Build updated scope_settings by folding per-scope fields from typed entries.
    // Start from the existing raw scope_settings so unknown fields are preserved.
    const existingSettings = rawObj.scope_settings
    const rawScopeSettings: Record<string, unknown> = isPlainObject(existingSettings)
      ? { ...existingSettings }
      : {}

    for (const te of entries) {
      const existing = rawScopeSettings[te.scope]
      const perScope: Record<string, unknown> = isPlainObject(existing) ? { ...existing } : {}
      const isCompat = te.scope === rawObj.scope

      for (const key of SCOPE_META_KEYS) {
        const v = (te as unknown as Record<string, unknown>)[key]
        if (v === undefined) continue  // absent = keep whatever is on disk
        // The compat scope's legacy top-level field stays where it is.
        const target = isCompat && !(key in perScope) && key in rawObj ? collapsed : perScope
        target[key] = key === 'sensitivity'
          ? mergeSensitivityForWriteback(target[key], v as object, serverSensitivityScopes?.has(te.scope) === true)
          : v
      }

      if (Object.keys(perScope).length > 0) {
        rawScopeSettings[te.scope] = perScope
      } else {
        delete rawScopeSettings[te.scope]
      }
    }

    if (Object.keys(rawScopeSettings).length > 0) {
      collapsed.scope_settings = rawScopeSettings
    } else {
      delete collapsed.scope_settings
    }

    return collapsed
  })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
}
