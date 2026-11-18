# Strengthen: definitional theorems restated over the code's branches

Each theorem keeps its name (the inventory cites it) and now proves a statement
quantified over the inputs the code branches on. Every one was mutation-checked
on a scratch copy (script: scratchpad `mut/run.py`); "breaks" = the named
theorem, or a lemma its proof uses, stops proving. No source bug was found, so
no replay of a current defect and no source edit; each `*_orig`/counterexample
theorem added is the shape the mutation puts back.

| Theorem | New statement | Mutation | Result |
|---|---|---|---|
| Adapters `cursor_keeps_extra` | hooks.json as a key/value object: every key other than `hooks`/`version` reads back unchanged, a present `version` is kept, `hooks` is the merged list (`mergeCursorHooks`) | merge rebuilt from `version`+`hooks` only | breaks |
| Adapters `fixed_ambiguous_no_default` | for every registry: open sessions ≠ 1 ⇒ no default whatever the process slot; exactly one ⇒ its registration (`_resolveWriteSession`) | unresolved session reads `r.dflt` | breaks |
| Outbox `no_keyless_post` | `_persistMissingOutboxKeys` + flush, all disk/snapshot/save cases: the key a POST sends is the key on the disk row | drop the `_outboxRowStillQueued` key comparison | breaks |
| Outbox `conflict_untouched` | stores as a list: whenever two different urls claim the target scope, in any order, `routeFor` gives no route and every flush (forced too) keeps the entry | `conflictB := false` | breaks (`conflict_of_two`) |
| Outbox `changed_key_retries` | iff over all inputs: hold lifted ⇔ not held, or auth refusal with both fingerprints known and different (`heldBack`) | drop the auth-refusal condition | breaks |
| R2CoreA `private_always_withheld` | private ⇒ withheld for every scope/backing, and the summary of its record (answered or older) never says it may leave | check `leaves` before `private` | breaks |
| R2CoreA `summary_agrees_with_record` | over all record shapes (no node / answered / older): summary "may leave" ⇒ node present and the record would not withhold | no node ⇒ may leave | breaks |
| R2CoreA `dry_predicts_real_store` | importer: dry run (fixed store + in-file map keyed per `dedupScopeFor`) reports exactly the real run's actions (growing store), for every store, file and dedup policy; incl. secret/unhashable | scope-blind in-file key | breaks (`parity`) |
| R2CoreB `remote_origin_is_store` | rows as key/value lists with any shipped keys: `stampStoreRow` origin is exactly the store | stamp without the `_` strip | breaks |
| R2Integrations `absent_allowed` | `hostIsAllowed` over raw headers: an empty-name request is allowed iff it has no Host (absent/blank); `:80` refused | allow `norm raw == ""` | breaks |
| R2Integrations `user_value_never_discarded` | five config keys, nested only under objects: setup/repair never changes a non-object value, and the refusal names a key holding one (`configShapeProblem`) | drop the shape check; drop the `mcp.servers` check | both break |
| UploadLocal `dry_run_no_mutation` | `uploadLocal` per-id branches over any id list: dry run writes no row, selects nothing (no flush), and reports the real run's preparation outcomes | secret branch demotes on dry run | breaks |
| WorkspaceChoice `ambiguous_write_refused` | iff over all decisions/calls: refused ⇔ roots disagree and no scope | allow disagree | breaks |
| WorkspaceChoice `partial_batch_refused` | any batch: refused ⇔ some item unscoped, and then nothing is written | per-item filter; `any` for `all` | both break |
| WorkspaceChoice `unmatched_stays_local` | `_startRemoteRecall` gate, iff over all inputs: no dial ⇔ Git default local and no scope/context/session/remote-only; all-unmatched roots give empty context | drop `contexts.isEmpty` | breaks |
| GitFolder `refreshed_local_stays_local` | any start binding and re-read history: last read local/unknown ⇒ write 0; unreadable ⇒ refused | unreadable keeps old binding | breaks |

## Added: `_hitHolder`'s choice (R2CoreA §5a)

`hitHolder` models `_hitHolder` branch for branch. `cache_row_yields_to_local_store`:
for a url-store cache row, persistable ⇔ writable url entry ∧ cached for the
scope written ∧ `_isRemoteWriteScope(scope)`; with a local store selected the
row is never mutated and the write gets its own row. Mutation (drop
`_isRemoteWriteScope`) breaks it. `own_remote_reachable` is non-vacuity.
`every_write_durable` holds for every hit kind and does not check this choice;
inventory: cite the new theorem and the existing test "L2: a cached remote row
does not swallow a write that the selection keeps local" (passes).

## Notes
- `session_end` refuses only its unscoped items and saves the scoped ones,
  unlike `plur_learn_batch` (all or nothing). Both match EFI-8 (a named scope is
  a chosen destination); not modelled as a defect.
- Conflict model covers non-personal scopes; `user:` scopes take
  `personalStoreEntry`.
