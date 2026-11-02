/**
 * Scope-family predicates, in a dependency-free leaf module so `inject.ts`,
 * `index.ts`, `storage-indexed.ts` and `mcp/tools.ts` can import them without
 * an `index.ts → inject.ts → index.ts` cycle. `index.ts` re-exports
 * `isSharedScope`/`isPersonalScope` as public `@plur-ai/core` API.
 */

/**
 * Scopes whose engrams are visible to people *other than* the author — the team
 * store (`group:`), repo/project stores (`project:`), space stores (`space:`),
 * and org/public scopes. Personal scopes (`local`, `global`, `user:*`, `agent:*`)
 * are NOT shared: they live on the author's own machine or under their own remote
 * namespace. Used by the write-time leak guard to decide whether to scan + demote,
 * and (via the negation below) by the read-side scope filters to decide which
 * scopes always pass a project-scope recall/inject.
 */
export const SHARED_SCOPE_PREFIXES = ['group:', 'project:', 'space:', 'team:', 'org:', 'public'] as const

export function isSharedScope(scope: string): boolean {
  // Case-insensitive prefix test: the /me scope grammar admits uppercase
  // (`[\w:./-]+` in remote-store.ts), so `Group:x` must classify as
  // shared-family exactly like `group:x`; otherwise it would be filed as
  // personal and skip the write-time leak guard. Only the PREFIX comparison is
  // case-folded; the stored scope value is never mutated.
  const s = scope.toLowerCase()
  // The `group:`/`project:`/… entries carry their `:` delimiter, so `startsWith`
  // already requires a real boundary. `'public'` is the odd one out — a complete
  // scope name / namespace root, not a bare prefix — so it must match exactly or
  // on a real delimiter. A plain `startsWith('public')` would misclassify
  // personal scopes like `public-roadmap` / `publicfoobar` as shared.
  return SHARED_SCOPE_PREFIXES.some(p =>
    p === 'public'
      ? s === 'public' || s.startsWith('public:') || s.startsWith('public/')
      : s.startsWith(p),
  )
}

/**
 * Personal-family scope test — the read-side authoritative predicate.
 *
 * A scope is personal iff it is NOT a shared scope. This deliberately covers
 * MORE than just `{local, global}`: `user:alice`,
 * `agent:bot`, and any non-shared-prefixed scope are ALSO personal-family and
 * must pass a project-scope recall/inject filter. Use this everywhere a read
 * filter decides "always visible under any scoped recall" — never a hardcoded
 * {local,global} set.
 */
export function isPersonalScope(scope: string): boolean {
  return !isSharedScope(scope)
}

/**
 * Segment-aware scope membership. Does `scope` fall within the `queryScope`
 * namespace — exactly equal, or a descendant separated by a REAL delimiter
 * (`:` or `/`)? A bare `startsWith` leaks a sibling that is merely a string-prefix:
 * `project:app` would wrongly match `project:application`. This predicate matches
 * `project:app`, `project:app:sub`, and `project:app/x` but NOT `project:application`.
 *
 * Use everywhere a read-side filter or store-load gate decides scope membership.
 * The SQL paths inline the equivalent, case-sensitively like this function:
 * storage-pglite/-postgres as `scope = $n OR scope LIKE $n||':%' OR ...` (LIKE
 * is case-sensitive there), storage-indexed as `instr(scope, ?||':') = 1`
 * (SQLite LIKE case-folds).
 */
export function isScopeWithin(scope: string, queryScope: string): boolean {
  return scope === queryScope
    || scope.startsWith(queryScope + ':')
    || scope.startsWith(queryScope + '/')
}

/**
 * Read-side VISIBILITY predicate: the one in-memory implementation (SQL arms in
 * storage-indexed / -pglite / -postgres must stay in lockstep). Passes when the
 * engram is within the filter, personal-family, or within a GRANTED scope
 * mounted in config.yaml `stores:` (mounting with your own token is consent),
 * all segment-aware via `isScopeWithin`.
 * STRICTLY visibility-only: never fold into `scopeAllowFilter` authorization,
 * and an explicit `scope: 'global'` inject stays targeted to `global`.
 */
export function makeVisibilityPredicate(
  scopeFilter: string,
  grants?: readonly string[],
): (engramScope: string) => boolean {
  return (engramScope: string) =>
    isScopeWithin(engramScope, scopeFilter)
    || isPersonalScope(engramScope)
    || (grants !== undefined && grants.some(g => isScopeWithin(engramScope, g)))
}

/**
 * Permitted-scope allow-list predicate: the in-memory twin of SQL
 * `scope = ANY($n)` (see `StorageFilter.scopes`).
 *   - `undefined` → unrestricted.
 *   - `[]`        → matches NOTHING. NEVER treat an empty list as "no filter".
 *   - non-empty   → EXACT membership: no hierarchy expansion, no personal
 *                   pass-through (`['project:a']` does not admit `global`).
 * Builds the Set once so per-engram checks are O(1).
 */
export function scopeAllowFilter(scopes: readonly string[] | undefined): (scope: string) => boolean {
  if (scopes === undefined) return () => true
  const allowed = new Set(scopes)
  return (scope: string) => allowed.has(scope)
}
