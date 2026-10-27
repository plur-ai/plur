# Provenance (PLUR 0.23) — `PlurSpec/Provenance.lean`

Scope: the history hash chain (`history.ts` `appendHistoryStamped`, `appendHistoryBatch`, `emitCheckpoint`), `verify-chain.ts` `verifyChain`, `session-manifest.ts` (`buildSessionManifest`, `computeRecordHash`, `verifySessionManifest`), `cli/src/commands/verify-manifest.ts` exit codes, and opt-in anchoring (`index.ts` `receiptsConfig`, `mcp/src/tools.ts` plur_session_end). Hashes are opaque; collision freedom is a hypothesis on each theorem that needs it (`HashInjective`, `RecInjective`), never an axiom.

## Holds

- Chain linkage: after any sequence of locked appends, single or batch, every event's `prev` is the hash of the event before it (`locked_run_links`). A lock-failure append sets `prev = none` whatever the log holds (`failed_append_is_gap`). A failed-lock batch has a gap on its first event only, and each later event links to the one the batch just wrote (`failed_batch_first_gap`).
- Batch equivalence, within one month file: a locked batch writes exactly what n locked single appends write (`batch_eq_singles`). Across month files it does not; see F1.
- Verification: a log written only by locked appends has no break (`locked_run_verifies`). Under any mix of lock outcomes, every break reported is a `declared_gap` (`any_run_only_gaps`). One gap after a clean chain gives exactly one break, at the gap event (`single_gap_reported`). Editing the content of a sealed event without recomputing its hash gives `hash_mismatch` at that index (`tamper_detected`).
- Checkpoints: `chain_head` is the `prev` the event chains onto, on both lock paths (`checkpoint_head_is_prev`). A locked checkpoint's head is carried by an event already in the log (`checkpoint_head_present`).
- Manifest: a written engram is listed as `written` whatever role the log gave it (`written_overrides`). `ok = false` holds exactly when some entry is CHANGED (`ok_false_iff_changed`). An engram missing from the writer's store or the verifier's store is NOT AVAILABLE and never MATCH (`writer_absent_not_available`, `verifier_absent_not_available`, `not_available_never_match`). An edit to any covered field turns MATCH into CHANGED (`covered_edit_changed`, `field_edit_changed`). A bookkeeping-only edit keeps MATCH (`bookkeeping_edit_matches`).
- `plur verify --manifest`: it exits 0 only when the manifest is ok and its integrity checks pass (`exit_zero_iff`). It exits 2 only when it cannot verify (`exit_two_iff_cannot`), and cannot-verify never exits 0 (`cannot_never_zero`). A bad content hash or an invalid notary signature exits 1 (`bad_integrity_not_zero`).
- Network: session end uploads only when the receipts store is `swarm` and a session resolves (`uploads_iff`). Any config value other than the literal `swarm` makes no call (`default_no_network`).

Boundary, not a defect: `computeRecordHash` drops `undefined`, `null` and empty arrays before hashing. A change between those three "empty" forms is therefore invisible. The model treats the covered record as already normalised.

## F1 — a batch across month files is not the same as single appends (latent, low)

`packages/core/src/history.ts:799-803`: `appendHistoryBatch` reads `findPredecessorHash(historyDir, firstFile)` once, for the first event's month. The loop at `history.ts:760-765` then chains every later event onto the event before it, including events that go into a different month file. `findPredecessorHash` (`history.ts:458-464`) chains a single append onto the tail of that event's own month file whenever the file has content. The claim at `history.ts:756-758` ("a batch is indistinguishable in the log from the same events appended one by one") therefore fails in this case.

Concrete scenario:
1. `history/2026-11.jsonl` already holds an event `x`. This happens after clock skew, or when a writer passed an explicit November timestamp.
2. A batch `[e1 @ 2026-10-31T23:59Z, e2 @ 2026-11-01T00:00Z]` is appended.
3. The batch sets `e2.prev = hash(e1)`. Two single appends would set `e2.prev = hash(x)`, the tail of the November file.
4. `verifyChain` walks October and then November, so it sees `… e1, x, e2` and reports `prev_mismatch` on `e2`. That reason is the tampering label, but nothing was tampered with.

Model: `batch_cross_month_diverges`, and `batch_cross_month_diverges_legacy` for the case where the November tail is a legacy event. Not reachable today: the only caller, `recordIdRenames` (`packages/core/src/engrams.ts:289`), stamps every event with one timestamp. Possible fixes: re-read the head when the month changes inside the batch, or split the batch per month. Source not changed.

## F2 — one declared gap is also reported as a fork (low, mislabel)

`packages/core/src/verify-chain.ts:285` keys every chained event under `prev ?? GENESIS_CLAIM`, and `:315` reports a fork for any key claimed twice. A lock-failure event has `prev = null`, the same key as the genesis event. In a store whose first chained event is genesis, a single lock failure therefore yields a `declared_gap` break and also a fork naming the genesis event and the gap event, although no two events claim one predecessor. It is not reported as tampering, but the result says "fork" where there was one sequential lock failure. The existing test (`verify-chain.test.ts` "reports prev:null mid-chain as declared_gap") checks the reasons but not `forks`, so it passes either way.

Model: `gap_after_genesis_is_fork`. Possible fix: count a null `prev` as a genesis claim only when no chained event precedes it. Source not changed.

## F3 — the constructor's `provenance` option is never read (found while drift-checking, outside the model)

`packages/core/src/index.ts:1692` declares `provenance?: { identity?: string }` on the `Plur` constructor options, documented as "Merged into the loaded config". `StatusResult.provenance_identity` (`index.ts:587-595`) says it "Shows the effective value, including a constructor override". Nothing in the constructor reads `options.provenance`, and `_configuredIdentity()` (`index.ts:3418-3421`) reads only `this.config.provenance.identity`.

Scenario: `new Plur({ path, provenance: { identity: 'agent:x' } })` with no identity in config.yaml. `status().provenance_identity` reports `agent:unidentified`, and new engrams are attributed to the unidentified marker. Found by reading the code; not run. The check that would settle it is that one-line test. Source not changed.

## Resolution (2026-10-27, same day)

- **F1 fixed** in `packages/core/src/history.ts` (`appendHistoryBatch`): when a batch moves into another month file that already has events, the next event links to that file's own tail, as a single append would; into an empty file the chain continues from the batch's previous event. Regression test: `packages/core/test/history-batch-chain.test.ts` (same links as single appends, within a month and across a boundary). The model's `batch_cross_month_diverges*` counterexamples describe the code before this fix.
- **F3 fixed**: the unused `provenance: { identity }` constructor option is removed from `Plur`'s options; identity comes from `config.yaml` (`provenance.identity`), and the `provenance-origin` tests now set it there.
- **F2 open** (low): a declared gap right after genesis is also listed as a fork of genesis. It is never reported as tampering. Left for a follow-up issue.
