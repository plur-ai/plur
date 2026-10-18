# Findings: StoreEntry — server store entries (expand, collapse, rotation; #1631, plan B Task 1)

Model: `spec/formal/PlurSpec/StoreEntry.lean` (checks cleanly with `lake env lean`; no
sorry/axiom/native_decide; axioms used: propext, Quot.sound, Classical.choice).
Survey: `spec/formal/survey/store-entry.md`. Branch formal/epic-1797 at 5a0dedc3, 2026-10-18.
Tests: `packages/core/test/formal-store-entry.test.ts` (5 tests).

## C2a. A server entry's top-level metadata could make the whole config fall back to defaults — CONFIRMED+FIXED

`expandServerEntry` copied the compat scope's legacy top-level metadata from the passthrough
(unvalidated) top level (store-expand.ts:97), and loadConfig pushes expanded entries without a
per-entry check (config.ts:53–55). `description` has no `.catch`, so a `description:` left empty
(YAML null) or a number failed `PlurConfigSchema.parse` (config.ts:72) and loadConfig returned
DEFAULTS — every store hidden. The next `addStore` then wrote `stores` = [new entry] and deleted
every per-scope entry from config.yaml (server entries survive via the splice at
index.ts:12850). Contradicts config.ts:20–23 ("loses at most the malformed entries, never the
whole file").

- Theorems: `old_load_falls_back` (counterexample, pre-fix `typedOld`), `typed_normal`,
  `load_ok_fixed` (for every parse oracle that is idempotent on its output, no expanded value
  can fail the outer parse).
- Replay (red before the fix): `npx vitest run test/formal-store-entry.test.ts` →
  `3 failed | 2 passed`; `expected [] to deeply equal ['local:notes', …]`, and after an
  unrelated addStore the file held `['group:other/x', 'group:acme/team']` (local entry gone).
- Fix (store-expand.ts): the top level goes through `ScopeSettingsSchema.safeParse` (the same
  shape tolerance as a scope_settings value) before `metadataOnly`. A malformed field is dropped
  from memory; collapse leaves the raw value on disk untouched (absent = keep).
- After: 5/5 pass. Mutation check: restoring the unparsed legacy (`mut_a`) breaks
  `typed_normal`, hence `load_ok_fixed` and `roundtrip_load`.

## C1. Expand/collapse round trip — REFUTED (claim holds, proved)

- `roundtrip_load`: for every expanded scope and key, reloading `collapse(expand(e))` gives
  the same typed metadata, for any parse oracle `norm` (idempotent) and any writeback merge
  satisfying `WbOk` (writing the typed value over a disk value that parses to it, or does not
  parse, reloads as that value). `sens_wbOk` proves `WbOk` for the sensitivity merge;
  dial/description/covers use "typed wins", which satisfies it by idempotence.
- `collapse_ident`: identity fields (url, token, token_env, readonly, scopes, compat scope) are
  never touched by the collapse.
- Test: "loadConfig before and after are equal …" — a rich entry (compat scope with top-level
  dial/covers/sensitivity with an unknown category, unknown top key, pinned_scopes, enterprise,
  discovery, scope_settings with unknown keys) survives an unrelated addStore with the reload
  equal and the listed fields byte-equal; a second writeback leaves the file byte-identical.
- Note: the round trip is semantic, not syntactic: a sensitivity object without `allow` or
  `forbid` gains the schema defaults (`allow: []`, `forbid: [secrets, infra]`) on the first
  writeback — same meaning, same behaviour as per-scope entries (mergeStoresForWriteback).
- Mutation: the load round trip is robust to target-placement mutations (top level vs
  scope_settings are load-equivalent by design); the disk-level guarantees are carried by C5
  and by the test's fixed-point check.

## C2. Legacy top-level metadata reaches the compat scope; scope_settings precedence — REFUTED (holds)

- `legacy_reaches_compat`, `legacy_not_other` (only the compat scope gets it),
  `settings_precede` (a valid scope_settings value wins), `update_compat_top` (a changed value of
  a key held at the top level is written there and the reload sees it).
- Existing tests: server-entry-legacy-metadata.test.ts, server-entry-writeback-identity.test.ts
  (compat block). Design note, not a defect: top-level metadata on a server entry WITHOUT a
  compat `scope` is ignored (no scope owns it; older clients always wrote `scope`).

## C3. Stable identity under concurrent insert/reorder — REFUTED with one CONFIRMED+NEEDS-OWNER limit

- `findAux_filter` / `findId_filter`: the code's occurrence-count identity `(base, #n)` selects
  exactly the n-th entry with that base. `identity_stable`: if the other process kept the
  entries with this base in order (it may insert, remove, reorder any other entries),
  the write lands on the same physical entry. `insert_other_base` discharges that for an
  insertion of a different-base entry. `good_case` = non-vacuity.
- CONFIRMED limit, `same_base_insert_mistargets`: the token is not in the base
  (store-expand.ts:34), so an entry with the same url/scope/scopes/pinned/readonly/token_env and
  a different token, inserted BEFORE ours, takes `#0` and receives our metadata. Replay
  (scratch test, removed): disk `[{t-a, scopes:[team]}]`, load + set covers, insert
  `{t-other, same scopes}` at index 0, persistStores →
  `[["t-other",{"group:acme/team":{"covers":["mine"]}}],["t-a",null]]`.
- Changed: the `serverEntryIdentities` docstring claimed "an inserted entry never matches"; it
  now states the limit. Behaviour not changed (NEEDS-OWNER Q1).
- Mutation: position identity (`mut_c`, the round-1 finding 4 bug) breaks `findId_filter` and
  `identity_stable`.

## C4. Rotation touches exactly the selected entry; ambiguity refused, file unchanged — REFUTED (holds)

- `rotate_only_selected` (only the entry with the selected base changes, only its token),
  `rotate_two_refused` and `rotate_none_refused` (file as read), `rotate_good_case`.
  The under-lock check (index.ts:12808–12814) throws inside `withLock` before `atomicWrite`.
- Replay: persistStores with `serverEntryToken` after another process added a scope to the
  selected entry → throws "changed on disk since it was loaded", file byte-identical (scratch
  test, passed). Existing: "a scope that two server entries on one url both list is refused".
- Downgraded lead: the pre-lock "listing" check (scopes) and the locked "base" check differ;
  if another process adds a second entry listing the same scope between them, the originally
  selected entry is rotated. That is the entry the user selected; not a defect.
- Mutation: rotating every match (`mut_d`) breaks `rotate_two_refused`.

## C5. Sensitivity writeback — REFUTED (holds)

- `ordinary_keeps_forbid` (raw `forbid` restored verbatim, unknown categories kept),
  `authoritative_replaces`, `parseForbid_idem`, `sens_wbOk` (merge reloads to the typed value),
  `fwd_category_survives` (non-vacuity: load drops category 5, writeback keeps it),
  `replace_loses_category` (the round-1 finding 5 behaviour).
- Mutation: merge without the restore (`mut_b`) breaks `ordinary_keeps_forbid`.

## C6. scope_settings can never set url/token/scope/readonly — REFUTED (holds)

- `metadata_never_sets_identity`: for every legacy and settings map, a reserved key (url, token,
  token_env, scope, readonly, shared, path) of the expanded entry is the server entry's value;
  `metadata_meta_keys`: metadata keys are settings-over-legacy. `old_settings_redirects`: the
  pre-review spread order lets scope_settings redirect `url`.
- Test: "scope_settings and top-level keys named url/token/scope/readonly/path are ignored".
- Mutation (`mut_e`, settings spread after identity) breaks `metadata_never_sets_identity`.

## C8 (outside the candidate list). persistStores lock does not prevent a lost per-scope entry — CONFIRMED+NEEDS-OWNER

The stores list is computed outside the lock (addStore index.ts:13001, persistScopeMetadata
14352) and persistStores writes exactly that list for per-scope entries, so an entry another
process added in between is deleted. The docstring (12776–12781) says the lock prevents exactly
this race (session_start metadata sync vs `plur stores add`). Server entries written since load
are kept; per-scope ones are not. Replay (scratch test, removed): load `[group:acme/a]`, another
process appends `group:acme/b`, persistStores([a, c]) → disk `["group:acme/a","group:acme/c"]`.
Not fixed: it changes which entries persist on disk (Q2). Not modelled in Lean.

## Files changed

- `packages/core/src/store-expand.ts` — legacy top level parsed with ScopeSettingsSchema;
  serverEntryIdentities docstring states the same-base limit.
- New: `packages/core/test/formal-store-entry.test.ts`, `spec/formal/PlurSpec/StoreEntry.lean`,
  `spec/formal/survey/store-entry.md`, this file; `spec/formal/verify.yaml` (appended entry).
- `PlurSpec.lean` root import not added (coordinator owns it).

## NEEDS-OWNER

- Q1 (C3): two server entries that differ only in their token are indistinguishable. Should
  (a) the identity include a token fingerprint (a concurrent rotation by another process then
  makes our metadata write a no-op, re-synced next session_start), (b) collapse write nothing to
  a base that occurs more than once (as rotation already refuses), or (c) accept and keep the
  documented limit?
- Q2 (C8): should persistStores keep per-scope entries it does not know about (added by another
  process since load), with addStore's overwriteScope naming the entry it removes? Side effect:
  per-scope entries dropped at load as invalid would also stop being deleted on writeback.

### Codex round 4, finding 2 — a compat-scope change moved the old scope's metadata (2026-10-18)
`refreshServerScopes` set the compat `scope` to the personal scope `/me` lists and left the top-level metadata in place. Expansion gives top-level metadata to whichever scope holds the compat field, so a legacy team entry lost `dial: never` (and became dialable) and the personal scope inherited it, with its description, covers and sensitivity.
- Fix (`withCompatScope`, store-expand.ts; used by refreshServerScopes in index.ts): before the compat scope changes, every non-reserved top-level key moves into `scope_settings[oldScope]`, where keys already set win, and leaves the top level. No old compat scope, or no change: the entry is left as it was.
- Theorems (§1b): `recompat_keeps_old`, `recompat_new_own_only`, `recompat_others`, `fixed_team_keeps_dial` (non-vacuity), `old_moves_metadata_to_personal` (counterexample for the original).
- Replay: `packages/core/test/codex4-compat-scope-metadata.test.ts` (3 tests; 2 red on the original code).
- Mutation check: keeping the top level on the recompat'd entry breaks `recompat_new_own_only` and `fixed_team_keeps_dial`; dropping the move breaks `recompat_keeps_old`. In the code, letting moved values win over `scope_settings[oldScope]` turns the precedence test red.
- Left as is: a key whose `scope_settings[oldScope]` value is present but malformed keeps that value on disk (it wins, as an explicit value), and the schema drops it, so the top-level value it replaced is lost for that key. `recompat_keeps_old` states the well-formedness hypothesis. An entry with no compat scope keeps its ownerless top-level metadata at the top, where it now attaches to the new personal compat scope, as before.
