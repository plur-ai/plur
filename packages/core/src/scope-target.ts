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
 * True when `scope` names something local, so a routed operation must NEVER
 * fall through to a remote store.
 *
 * `primary` is the explicit "the local primary store, and only it" target.
 * `local`, `global` and `project:*` are the scopes an engram carries when it
 * lives on this machine; naming one of them is equally a statement about
 * WHERE, not just about which namespace. Both readings agree that a remote
 * DELETE is not what the caller asked for.
 *
 * Case-folded, like `isSharedScope` — `GLOBAL` and `Project:x` are the same
 * family as `global` and `project:x`. Only the comparison folds; no scope
 * value is rewritten.
 *
 * `project:*` is local-only exactly when write routing keeps it local, i.e.
 * when {@link resolveScopeTarget} (store-resolver.ts) answers `local` for it.
 * It is NOT local-only when a url store claims exactly this scope (`remote`),
 * two servers do (`conflict`, the write path refuses it), or it is under a
 * company server's org without a grant (`unauthorized`). Matching is exact,
 * like the resolver: no containment, no case fold, so forget and feedback
 * never dial a server that a write to the same scope would not reach. Pass the
 * configured `stores`; omitting them keeps the config-free family (every
 * `project:*` local), which is what `assertScopeNamesATarget` wants — a
 * project scope always names a target. `primary` / `local` / `global` never
 * depend on stores.
 *
 * Note the asymmetry with lookup: a local-only scope still permits the
 * secondary-store walk, because `stores:` entries without a `url` are files on
 * this disk. It is the network leg that is refused.
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
 * configured store.
 *
 * Typo protection, and load-bearing rather than cosmetic: a mistyped scope is
 * still TRUTHY, so it would skip the `if (!scope)` ambiguity guard downstream
 * and silently fall back to first-match-wins on exactly the id the guard
 * exists to refuse (e.g. `group:tset` for `group:test` retiring the local
 * engram and reporting success).
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
 * The ONE configured store a personal `user:` scope selects, or null.
 *
 * Candidates are first the entries whose scope equals `scope` exactly, and
 * only when there are none, the entries equal to it case-folded (folding as
 * in {@link isLocalOnlyScope} — only the comparison folds; a
 * Unicode fold such as the Kelvin sign counts too). Within the candidates the
 * preference is fail-safe: a LOCAL path-backed store, then a writable url
 * store, then a readonly url store; config order breaks ties. So an exact or
 * ambiguous match never selects a remote store when a local one matches.
 *
 * The selected entry is used for the read dial, the write target and the
 * "own remote namespace" check alike, so the three can never disagree.
 * Non-`user:` scopes never match.
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
