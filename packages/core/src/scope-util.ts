/**
 * Scope-family predicates — extracted to a leaf module to break a module cycle.
 *
 * `inject.ts` needs `isPersonalScope` for its read-side scope filter, but
 * `index.ts` imports from `inject.ts`. If these predicates lived in `index.ts`,
 * `inject.ts` importing them would create an `index.ts → inject.ts → index.ts`
 * cycle. Keeping them here (a dependency-free leaf) lets `inject.ts`, `index.ts`,
 * `storage-indexed.ts`, and `mcp/tools.ts` all import them without any cycle.
 *
 * `index.ts` re-exports `isSharedScope`/`isPersonalScope` so the public
 * `@plur-ai/core` API surface is unchanged.
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
  // The `group:`/`project:`/… entries carry their `:` delimiter, so `startsWith`
  // already requires a real boundary. `'public'` is the odd one out — a complete
  // scope name / namespace root, not a bare prefix — so it must match exactly or
  // on a real delimiter. A plain `startsWith('public')` misclassifies personal
  // scopes like `public-roadmap` / `publicfoobar` as shared (#403).
  return SHARED_SCOPE_PREFIXES.some(p =>
    p === 'public'
      ? scope === 'public' || scope.startsWith('public:') || scope.startsWith('public/')
      : scope.startsWith(p),
  )
}

/**
 * Personal-family scope test — the read-side authoritative predicate (#353).
 *
 * A scope is personal iff it is NOT a shared scope. This deliberately covers
 * MORE than the historical hardcoded `{local, global}` set: `user:alice`,
 * `agent:bot`, and any non-shared-prefixed scope are ALSO personal-family and
 * must pass a project-scope recall/inject filter. Use this everywhere a read
 * filter decides "always visible under any scoped recall" — never a hardcoded
 * {local,global} set.
 */
export function isPersonalScope(scope: string): boolean {
  return !isSharedScope(scope)
}

/**
 * Segment-aware scope membership (#383). Does `scope` fall within the `queryScope`
 * namespace — exactly equal, or a descendant separated by a REAL delimiter
 * (`:` or `/`)? A bare `startsWith` leaks a sibling that is merely a string-prefix:
 * `project:app` would wrongly match `project:application`. This predicate matches
 * `project:app`, `project:app:sub`, and `project:app/x` but NOT `project:application`.
 *
 * Use everywhere a read-side filter or store-load gate decides scope membership.
 * The SQL paths (storage-indexed, storage-pglite) inline the equivalent:
 *   `scope = ? OR scope LIKE ?||':%' OR scope LIKE ?||'/%'`.
 */
export function isScopeWithin(scope: string, queryScope: string): boolean {
  return scope === queryScope
    || scope.startsWith(queryScope + ':')
    || scope.startsWith(queryScope + '/')
}
