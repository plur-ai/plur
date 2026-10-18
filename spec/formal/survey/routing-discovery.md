# Survey: scope routing resolver and server scope discovery (#1631)

Slice: `packages/core/src/store-resolver.ts`, `packages/core/src/server-discovery.ts`,
`packages/core/src/index.ts` (resolver callers 2465–2530, 5264, 5357, outbox `routeFor`
11100–11190, `refreshServerScopes` 13892–13998 and helpers 1215–1258),
`packages/core/src/store-expand.ts` (collapse, owner decision 17). Surveyed 2026-10-18 on
branch formal2/epic-1797 (b22f01d0). Leads, not findings.

1. **resolveScopeTarget is total, and conflict/unauthorized mean what they say (S)** —
   store-resolver.ts:96–121. Claims: 14 "Two or more distinct servers claim exactly this
   scope: refuse the write"; 16 "Under a company server's org … but not granted to you";
   93–94 "Matching is exact throughout". Structure: five ordered rules (personal selection,
   url groups ≥2 / =1, enterprise org, path entry, else). Suspicion: rule 1 runs before the
   grouping (97–100), so a `user:` scope that two servers claim answers `remote`, not
   `conflict`. Tests: store-resolver.test.ts, routing-shared-resolver.test.ts.
2. **Leak guard: nothing reaches a server the resolver did not answer `remote` for (M)** —
   index.ts:2465–2474 (router: only `remote && writable`), 2520 (scan gate = any url group),
   outbox `routeFor` 11155–11160 (`find(url && scope === target && !readonly)`, ignores
   `target_url` and the personal selection). Claim 2513–2517 "Scanning there too can only
   demote … it never lets one out". Suspicion: the flush pushes a queued personal-scope row
   to the url store while the resolver now answers `local` (a path store shares the scope),
   and pushes a row queued for server A to a server B that replaced A. Tests:
   routing-shared-resolver.test.ts (conflict hold only).
3. **acceptDiscoveredScopes decision table (S)** — server-discovery.ts:84–115. Claims 9–16
   "A failed, unauthorised … answer never replaces the cache"; "An answer with no `org_id`
   … never replaces a non-empty cache"; 17 "Accepted scopes are filtered to the server's
   org". Structure: error → keep; no org (not not_synced) → degraded; ok → filter; not_synced
   / absent-empty → keep unless cache empty. Tests: server-discovery.test.ts (20).
4. **refreshServerScopes writes only what changed; refused answers keep discovered_at (S)** —
   index.ts:13923–13970, `discoveryChanged` 1247–1257. Claim 13878–13881 "An answer that
   changes nothing but the timestamps writes nothing … refreshed at most once a day".
   Suspicion: every answer is applied to the FIRST entry with the answer's normalized url
   (13927 `findIndex`), so two server entries on one url (different keys) both write into
   the first one, the last answer winning, and the second entry is never updated.
   Tests: refresh-server-scopes.test.ts (23).
5. **Collapse for an ambiguous identity (owner decision 17) (S)** — store-expand.ts:181–248,
   identity 48–57. Known limit (StoreEntry.lean `same_base_insert_mistargets`): two entries
   that differ only in their token share a base; collapse writes our metadata to whichever is
   `#0`. Decision 17: write nothing for such a base, as rotation (index.ts:12841–12846)
   already refuses. Tests: server-entry-writeback-identity.test.ts.

Ranking: 4 and 5 (confirmed-shape defects, S), 2 (M, policy-shaped), 1, 3.
