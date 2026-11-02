/**
 * What an explicit `scope:` argument means as a ROUTING TARGET.
 *
 * `forget(id, reason, { scope })` and `feedback(id, signal, scope)` both take a
 * scope to disambiguate an id that could name engrams in several stores. The
 * rule lives here, in one module, so the two cannot diverge: a divergent copy
 * can route a "local" target to a remote DELETE when the id is absent locally,
 * destroying a remote engram and reporting success.
 */

import type { StoreEntry } from './schemas/config.js'
import { resolveScopeTarget } from './store-resolver.js'

/** Scopes that name the LOCAL side of the store graph (lower case; compared folded). */
const LOCAL_FAMILY = new Set(['primary', 'local', 'global'])

/**
 * True when `scope` names something local, so a routed operation must NEVER fall
 * through to a remote store.
 * - `primary`, `local`, `global` are always local-only; comparison is case-folded
 *   (no value is rewritten).
 * - `project:*` is local-only exactly when {@link resolveScopeTarget} answers `local`
 *   (not `remote`/`conflict`/`unauthorized`), matched exactly. Without `stores`, every
 *   `project:*` is local (what `assertScopeNamesATarget` wants).
 * - Path-backed secondary stores are still walked; only the network leg is refused.
 */
export function isLocalOnlyScope(
  scope: string,
  stores?: ReadonlyArray<{ scope?: string; url?: string }>,
): boolean {
  const s = scope.toLowerCase()
  if (LOCAL_FAMILY.has(s)) return true
  if (!s.startsWith('project:')) return false
  if (!stores) return true
  return resolveScopeTarget(scope, stores as readonly StoreEntry[]).kind === 'local'
}

/**
 * Throw unless `scope` names a target that exists — a local-family scope or a
 * configured store. Load-bearing: a mistyped scope is truthy, skips the downstream
 * ambiguity guard, and would silently act on the wrong engram.
 *
 * @param verb  what the caller is doing, for the message: `retire from`, `rate in`
 * @param consequence  what silently happens if this is not caught
 */
export function assertScopeNamesATarget(
  scope: string,
  stores: ReadonlyArray<{ scope?: string }>,
  verb: string,
  consequence: string,
): void {
  if (isLocalOnlyScope(scope)) return
  if (stores.some(s => s.scope === scope)) return
  const configured = stores.map(s => s.scope).filter(Boolean)
  throw new Error(
    `Cannot ${verb} "${scope}": no configured store matches that scope. `
    + `Valid targets: primary, local, global, project:*`
    + (configured.length ? `, or a configured store scope (${configured.join(', ')})` : '')
    + `. Check for typos — an unmatched scope would silently ${consequence} instead (#831).`,
  )
}

/**
 * The ONE configured store a personal `user:` scope selects, or null (non-`user:`
 * scopes never match). Candidates: exact scope matches, else case-folded ones (incl.
 * Unicode folds). Preference is fail-safe — local path store, then writable url,
 * then readonly url; config order breaks ties — so a remote is never chosen over a
 * matching local. Used for read, write and own-namespace checks so they agree.
 */
export function personalStoreEntry<T extends { scope: string; url?: string; readonly?: boolean }>(
  scope: string | null | undefined,
  entries: readonly T[],
): T | null {
  if (!scope || !scope.toLowerCase().startsWith('user:')) return null
  const rank = (e: T): number => (!e.url ? 0 : e.readonly !== true ? 1 : 2)
  const best = (xs: readonly T[]): T | null =>
    xs.reduce<T | null>((b, e) => (b === null || rank(e) < rank(b) ? e : b), null)
  const exact = entries.filter(e => e.scope === scope)
  if (exact.length > 0) return best(exact)
  const folded = scope.toLowerCase()
  return best(entries.filter(e => typeof e.scope === 'string' && e.scope.toLowerCase() === folded))
}
