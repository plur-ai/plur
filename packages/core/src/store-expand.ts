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
  for (const scope of ordered) {
    if (!SCOPE_RE.test(scope)) {
      logger.warning(`[plur:config] dropping scope "${scope}" from server entry ${entry.url}: fails safe grammar`)
      continue
    }
    const settings = entry.scope_settings?.[scope] ?? {}
    const expanded: Record<string, unknown> = {
      url: entry.url,
      readonly: entry.readonly,
      shared: isSharedScope(scope),
      scope,
      ...settings,
      [EXPANDED_FROM]: rawIndex,
    }
    if (entry.token !== undefined) expanded.token = entry.token
    if (entry.token_env !== undefined) expanded.token_env = entry.token_env
    if (entry.enterprise !== undefined) expanded.enterprise = entry.enterprise
    if (entry.discovery !== undefined) expanded.discovery = entry.discovery
    results.push(expanded as unknown as StoreEntry)
  }
  return results
}

/**
 * Collapse expanded per-scope entries back into the original server entries
 * before writing to disk.
 *
 * STUB — implemented in efi-b01w (B1-writeback). Until then, persistStores
 * falls through to mergeStoresForWriteback, which writes per-scope entries;
 * this stub exists to satisfy the public interface.
 */
export function collapseExpandedStores(typed: StoreEntry[], rawStores: unknown[]): unknown[] {
  return rawStores
}
