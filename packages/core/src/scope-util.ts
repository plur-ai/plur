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
  // Case-insensitive prefix test (scope-audit 2026-07-24): the /me scope grammar
  // admits uppercase (`[\w:./-]+` in remote-store.ts), so `Group:x` must classify
  // as shared-family exactly like `group:x` — a case-sensitive test silently
  // filed it as personal (never offerable, and NOT scanned by the write-time
  // leak guard). Only the PREFIX comparison is case-folded; the stored scope
  // value is never mutated.
  const s = scope.toLowerCase()
  // The `group:`/`project:`/… entries carry their `:` delimiter, so `startsWith`
  // already requires a real boundary. `'public'` is the odd one out — a complete
  // scope name / namespace root, not a bare prefix — so it must match exactly or
  // on a real delimiter. A plain `startsWith('public')` misclassifies personal
  // scopes like `public-roadmap` / `publicfoobar` as shared (#403).
  return SHARED_SCOPE_PREFIXES.some(p =>
    p === 'public'
      ? s === 'public' || s.startsWith('public:') || s.startsWith('public/')
      : s.startsWith(p),
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

/**
 * Read-side VISIBILITY predicate under a scope filter (#775) — the ONE
 * in-memory implementation every visibility call site uses (inject scoring,
 * the YAML arm of `_filterEngrams`, `_engramsOutsidePrimaryStore`). The SQL
 * arms (storage-indexed / storage-pglite / storage-postgres) inline the
 * equivalent clause and must stay in lockstep with this.
 *
 * An engram passes a `scopeFilter` (e.g. `project:plur/plur-ai/enterprise`
 * from .plur.yaml) when ANY of:
 *   1. it falls within the filter itself (segment-aware, #383);
 *   2. it is personal-family (`local`, `global`, `user:*`, `agent:*`, …) —
 *      the #353 pass-through;
 *   3. it falls within a GRANTED scope — a scope explicitly mounted in
 *      `~/.plur/config.yaml` `stores:` (path AND url entries alike). Mounting
 *      a store with your own token is the consent act, so its scope passes a
 *      project-scope visibility filter exactly like the personal family.
 *      Without this, a project scope filter zeroed every `group:*` engram and
 *      team engrams from mounted enterprise stores never survived injection
 *      or recall.
 *
 * Grant matching is segment-aware via `isScopeWithin`: a grant for
 * `group:acme/eng` admits `group:acme/eng` and true descendants
 * (`group:acme/eng/x`, `group:acme/eng:x`) but NEVER the sibling
 * string-prefix `group:acme/eng-private` (#383).
 *
 * STRICTLY visibility-only. This predicate must NEVER be consulted by (or
 * folded into) the `scopeAllowFilter` authorization allow-list below —
 * grants widen what a scope filter shows, never what a principal is
 * permitted to see. The `INJECT_GLOBAL_IS_TARGETED` branch in inject.ts is
 * likewise untouched: an explicit `scope: 'global'` inject stays targeted to
 * `global` only, grants or no grants (D1-ASYMMETRY).
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
 * Permitted-scope allow-list predicate — the in-memory twin of the SQL
 * `scope = ANY($n)` pushdown (see `StorageFilter.scopes` in
 * storage-adapter.ts).
 *
 * Returns a predicate so every read path — SQL-backed adapters and the
 * in-memory YAML path alike — agrees on the same three cases:
 *   - `undefined` → unrestricted (predicate always true)
 *   - `[]`        → matches NOTHING (predicate always false). Security-
 *                   relevant: a principal with no permitted scopes must see
 *                   nothing. NEVER treat an empty list as "no filter".
 *   - non-empty   → EXACT membership. No hierarchy expansion, no personal-
 *                   family pass-through: the list is the fully-resolved
 *                   authorization decision, so `['project:a']` does NOT admit
 *                   `project:a:sub`, `global`, or `local`.
 *
 * The Set is built once so the per-engram check is O(1) — the caller may be
 * filtering a whole corpus against a list of tens of scopes.
 */
export function scopeAllowFilter(scopes: readonly string[] | undefined): (scope: string) => boolean {
  if (scopes === undefined) return () => true
  const allowed = new Set(scopes)
  return (scope: string) => allowed.has(scope)
}
