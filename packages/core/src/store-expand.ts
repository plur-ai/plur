import { isSharedScope } from './scope-util.js'
import { logger } from './logger.js'
import type { StoreEntry, ServerStoreEntry } from './schemas/config.js'

/** In-memory marker added to each expanded entry. Value = raw YAML array index.
 * Stripped by storeEntryForDisk before any writeback. */
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
 * Expand one server entry into one in-memory `StoreEntry` per scope.
 *
 * Order: scopes[], then pinned_scopes[] entries not already seen, then the
 * compat `scope` if not already seen. Deduplication preserves first-seen order.
 * Scope strings failing the safe grammar are dropped with a warning.
 *
 * Each expanded entry carries `[EXPANDED_FROM]: rawIndex` so the writeback
 * collapse step (efi-b01w) can map it back to the original server entry.
 */
export function expandServerEntry(entry: ServerStoreEntry, rawIndex: number): StoreEntry[] {
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
    const settings = Object.fromEntries(
      Object.entries(entry.scope_settings?.[scope] ?? {}).filter(([k]) => !RESERVED_ENTRY_KEYS.has(k)),
    )
    const expanded: Record<string, unknown> = {
      ...settings,
      url: entry.url,
      readonly: entry.readonly,
      shared: isSharedScope(scope),
      scope,
      [EXPANDED_FROM]: rawIndex,
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

/** Keys of an expanded entry that a `scope_settings` value must not set. */
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
 * Typed entries carrying `EXPANDED_FROM = i` are collected per raw index.
 * For each server entry at position i in rawStores, the per-scope metadata
 * fields (dial, description, covers, sensitivity) from the corresponding
 * typed entries are folded into `scope_settings[scope]`; all other fields
 * on the raw entry (scope, scopes, pinned_scopes, discovery, enterprise,
 * url, token, token_env, readonly) are left byte-identical.
 *
 * Returns a new rawStores array of the same length where server entry
 * positions carry the updated collapsed entry and non-server positions are
 * unchanged.
 */
export function collapseExpandedStores(typed: StoreEntry[], rawStores: unknown[]): unknown[] {
  if (!Array.isArray(rawStores) || !rawStores.length) return rawStores

  // Group typed entries by their EXPANDED_FROM raw index.
  const expandedByIndex = new Map<number, StoreEntry[]>()
  for (const entry of typed) {
    const idx = (entry as unknown as Record<string, unknown>)[EXPANDED_FROM]
    if (typeof idx === 'number') {
      const arr = expandedByIndex.get(idx)
      if (arr) arr.push(entry)
      else expandedByIndex.set(idx, [entry])
    }
  }

  if (!expandedByIndex.size) return rawStores

  return rawStores.map((raw, i) => {
    if (!isServerStoreEntry(raw)) return raw
    const entries = expandedByIndex.get(i)
    if (!entries?.length) return raw  // server entry with scopes: [] — no typed entries to process

    const rawObj = raw as Record<string, unknown>

    // Build updated scope_settings by folding per-scope fields from typed entries.
    // Start from the existing raw scope_settings so unknown fields are preserved.
    const existingSettings = rawObj.scope_settings
    const rawScopeSettings: Record<string, unknown> =
      existingSettings && typeof existingSettings === 'object' && !Array.isArray(existingSettings)
        ? { ...(existingSettings as Record<string, unknown>) }
        : {}

    for (const te of entries) {
      const existing = rawScopeSettings[te.scope]
      const perScope: Record<string, unknown> =
        existing && typeof existing === 'object' && !Array.isArray(existing)
          ? { ...(existing as Record<string, unknown>) }
          : {}

      for (const key of SCOPE_META_KEYS) {
        const v = (te as unknown as Record<string, unknown>)[key]
        if (v !== undefined) perScope[key] = v
        // absent = keep whatever was in the raw scope_settings
      }

      if (Object.keys(perScope).length > 0) {
        rawScopeSettings[te.scope] = perScope
      } else {
        delete rawScopeSettings[te.scope]
      }
    }

    const collapsed: Record<string, unknown> = { ...rawObj }
    if (Object.keys(rawScopeSettings).length > 0) {
      collapsed.scope_settings = rawScopeSettings
    } else {
      delete collapsed.scope_settings
    }

    return collapsed
  })
}
