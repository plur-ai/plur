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

### Registration and fold — plan B Task 5 (#1631, 2026-10-18)
`Plur.registerEnterpriseServer` (index.ts) runs `registerServerEntry` and `foldStoresIntoServerEntry` (server-discovery.ts) inside `_updateRawStores`: one locked read-modify-write of the raw `stores`, written atomically only when something changed. The compat `scope` is set at registration from the caller's `personalScope` (owner decision O6).
- Theorems (§6): `fold_preserves_routing` (every scope has the same url/key/readonly routes before and after; no scope is dropped), `fold_preserves_metadata` and `fold_md_untouched` (a folded entry's metadata lands in `scope_settings[scope]`, every other scope's settings are unchanged), `fold_kept` (entries kept separate are byte-for-byte the input), `fold_keeps_server`, `register_only_selected` (only the selected server entry's key changes; it always carries the compat scope), `register_two_refused`.
- Counterexample: `foldAll_breaks_routing` — folding a same-server entry that holds another key moves its scope onto the server entry's key. Replayed: `register-enterprise-server.test.ts` ("keeps an entry with a different token separate"). `rekeyAll_changes_other_route`: rekeying every entry on the url moves a per-scope entry's old key.
- Mutation checks: dropping the key from `fmatch` breaks `fmatch_eq`/`fold_preserves_routing` and `fold_keeps_other_key`; not pinning the folded scope breaks `serves_foldOne`/`fold_preserves_routing`; letting existing `scope_settings` win breaks `fold_md`/`fold_preserves_metadata`. In the code, removing the inline-key comparison in `keptReason` turns 3 tests red.
- Left out of the model: the `shared` and grammar refusals (they only keep more entries separate), the compat-scope metadata move (§1b), entry order.

#### Gate review: order (2026-10-18)
The §6 routes are a set, but a write takes the FIRST entry in config order that serves its scope (`remoteOf`; `personalStoreEntry` ties). Two cases moved a scope onto another key while every route triple survived: folding an entry while an entry that stays serves the same scope with another key ahead of the server entry, and moving the server entry to the first folded entry's place, ahead of an entry that serves one of its scopes with another key.
- Fix: the server entry stays where it is (a new one is appended), and an entry is folded only when no entry that stays serves its scope (new `kept_separate` reason `scope-served-elsewhere`; `user:` scopes compared case-folded, as the personal selection does).
- Theorem (§6b): `ordered_fold_preserves_first` — with those two rules, the first entry serving any scope has the same route before and after.
- Counterexamples: `fold_moves_first_route`, `move_server_moves_first_route`. Replayed: `register-enterprise-server.test.ts`, "a per-scope entry is not folded while another entry …" and "folding never moves the server entry ahead of …" (both red on the code before the fix).
- Mutation check: dropping the `hnoother` hypothesis (the `scope-served-elsewhere` rule) breaks `ordered_fold_preserves_first`.

#### Codex audit round 1 (2026-10-18)
- A new personal scope replaced the old compat scope; when nothing else on the entry listed it, its route was dropped or passed to another entry with another key. Fix: the old compat scope is pinned. Model: `rekey` (used by `register`), theorem `rekey_keeps_served`, mutation `rekey_unpinned_drops` (and dropping the pin breaks `rekey_keeps_served`). Replayed: "a new personal scope keeps the old compat scope served by the entry (pinned)".
- Folding two same-key entries for one scope with different metadata, or one whose metadata differs from the server entry's own settings for the scope, changed the policy in force (the first declaring entry in config order wins, `getScopeMetadata`) — e.g. a weaker sensitivity `allow`. Fix: such entries are kept separate (`metadata-differs`). Like the `shared`/grammar refusals this only keeps more entries separate, so §6 still holds; the policy-in-force selection is not modelled. Replayed: the two `metadata-differs` tests.
- A YAML error's reason can name an alias or tag from config.yaml; the error now names the line number only (code, not modelled).

#### Codex audit round 2 (2026-10-18)
- Claiming the new compat scope could take a personal scope's writes from another entry (another server or key) that served it first. Fix: `registerServerEntry` computes the personal route as `personalStoreEntry` selects it, before and after, and refuses (nothing written) when an existing route would move, unless the entry already served that scope (a re-run with a new key changes that entry's key by design). Code and tests only; the refusal is not modelled (the caller writes nothing, as in `register_two_refused`).
- A `__proto__` scope was folded into `scope_settings['__proto__']`, which sets the object's prototype, and its metadata was lost. Fix: kept separate (`invalid-scope`).
- Model: `PerScope.ok` now stands for the code's other eligibility checks and `fmatch` requires it, so `fold_kept` and `fold_preserves_metadata` describe the code's retained list and settings. New `fold_md_keeps_set`: with the `metadata-differs` check (every folding entry agrees with the server entry's value or has none), a value the server entry had stays. Mutation: dropping that hypothesis breaks the proof.

#### Codex audit round 3 (2026-10-18)
- The personal-route check selected among raw entries, so an entry the loader drops (the primary store's path entry, a schema-invalid one) could hide a takeover. Now judged conservatively on every raw entry: refused when this entry would rank ahead of any other url entry serving the personal scope exactly, or when any entry serves it only in another letter case.
- A server entry that does not load (e.g. `readonly: "false"`) was folded into, turning a working per-scope route local. The resulting server entry is now validated (`ServerStoreEntrySchema`) and the registration refused, writing nothing.
- On POSIX, a config.yaml readable by others is made owner-only before the key is written (atomicWrite keeps an existing file's mode). Windows ACLs remain B1b.
- `queued_by_scope` is built from a Map, so a scope named like an Object property counts as a number.
All code-level refusals and checks; replayed by the round-3 tests in `register-enterprise-server.test.ts`. Not modelled (the caller writes nothing on a refusal, as in `register_two_refused`).

#### Codex audit round 4 (2026-10-18)
- The re-run exemption trusted an entry the loader had rejected; only an entry that passes `ServerStoreEntrySchema` counts as already serving the personal scope.
- The owner-only step now runs inside the config lock, right before atomicWrite reads the mode it keeps.
- An existing server entry whose url carries a user name or password is refused, and config.ts's unset-`token_env` warning names the url by its origin only.
Code-level; replayed by the round-4 tests. Not modelled.

#### Codex audit round 5 (2026-10-18)
- A per-scope entry the loader rejects (e.g. `readonly: "true"`) was folded, so its scope would start going to the server; such an entry is now kept separate (`invalid-entry`, `StoreEntrySchema`).
- `dial` is read per entry, so its absence counts: entries whose dial differs from each other, or from the server entry's when it serves the scope, are kept separate (`metadata-differs`).
- The outbox is read before the write, so an unreadable outbox fails the registration with nothing written.
Code-level (eligibility is `PerScope.ok` in §6); replayed by the round-5 tests.

#### Codex audit round 6 (2026-10-18, PASS with one medium, fixed)
- An entry serving the personal scope in another letter case (with `dial: never`) was folded in, and the new exact compat scope took its selection. The takeover check now also refuses when the server entry itself, after the fold, serves the personal scope in another case. Replayed by the round-6 test.

#### Codex audit round 7 (2026-10-18, PASS with one medium, fixed)
- A personal scope in another letter case could still be folded into a server entry that already served the scope, reordering the case-folded personal selection (and its dial). The fold now keeps an entry separate when any entry, the server entry and other folding entries included, serves its personal scope in another letter case (`scope-served-elsewhere`). Replayed by the round-7 tests.
