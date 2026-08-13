/**
 * What an explicit `scope:` argument means as a ROUTING TARGET.
 *
 * `forget(id, reason, { scope })` and `feedback(id, signal, scope)` both take a
 * scope to disambiguate an id that could name engrams in several stores. #855
 * asked for the rule to live in one place when both landed; it did not, and the
 * two copies immediately diverged. The 2026-08-13 evaluator panel measured the
 * consequence:
 *
 *     scope="global"      threw=null  remote DELETEs=1   ← wrong-target retire, reported success
 *     scope="local"       threw=null  remote DELETEs=1
 *     scope="project:foo" threw=null  remote DELETEs=1
 *     scope="primary"     threw       remote DELETEs=0   (control)
 *
 * Three of the four targets `forget`'s own error message advertises as valid
 * routed to a remote DELETE when the id was absent locally — the caller said
 * "the local one", and the engine destroyed a remote one and reported success.
 * That is #831 verbatim, reached from the direction #855 documented itself as
 * closing. The drift IS the bug, so the rule is a module, not a convention.
 */

/** Scopes that name the LOCAL side of the store graph. */
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
 * Note the asymmetry with lookup: a local-only scope still permits the
 * secondary-store walk, because `stores:` entries without a `url` are files on
 * this disk. It is the network leg that is refused.
 */
export function isLocalOnlyScope(scope: string): boolean {
  return LOCAL_FAMILY.has(scope) || scope.startsWith('project:')
}

/**
 * Throw unless `scope` names a target that exists — a local-family scope or a
 * configured store.
 *
 * Typo protection, and load-bearing rather than cosmetic: because a mistyped
 * scope is still TRUTHY, it skipped the `if (!scope)` ambiguity guard
 * downstream and silently restored first-match-wins on exactly the id the
 * guard exists to refuse. `group:tset` for `group:test` retired the local
 * engram, issued no remote DELETE, and reported success.
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
