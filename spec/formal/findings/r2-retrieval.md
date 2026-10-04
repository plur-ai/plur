# R2-Retrieval findings (round 2, 2026-09-26)

Model: `spec/formal/PlurSpec/R2Retrieval.lean` (namespace `PlurSpec.R2Retrieval`).
Check: `cd spec/formal && lake env lean PlurSpec/R2Retrieval.lean`.
Tests: `npx vitest run --testTimeout=120000 packages/core/test/formal-r2-retrieval-*.test.ts`.
Mutation copies live in the session scratchpad (not committed).

Also done: `ScopeInject.lean` §6 (miss-signal; the ROUND2 note calls it §7)
`pglite_null_is_noResults` relabelled as a pre-I4 historical counterexample
(index.ts now returns `rrfScoreOf(...)` as `topScore` on the PGLite path). The theorem
statement is unchanged; the whole file re-checks cleanly.

## 1. Telemetry counters races (core-retrieval#7) — CONFIRMED+FIXED

Invariant: per date, counts shipped + counts still on disk (counters.json, pending/,
in-flight claims) = events recorded.

Replay (pre-fix, `packages/core/test/formal-r2-retrieval-telemetry.test.ts`; interleavings
forced through a pass-through `node:fs` mock that runs a second call between the first
call's read and write, plus real child processes; POSTs go to an in-process stub):
```
(1) rollover, two recorders on the same stale snapshot: pending D learn = 6, recorded 3
(2) 4 child processes x 40 learns, same day:            counters learn = 122, recorded 160
(3) two concurrent flushIfNeeded:                        POSTs for D = [1, 1]
(4) merge into pending D while its POST is in flight:   shipped 3 of 5 (2 deleted unsent)
```
The survey's "resurrection after delete" is the other ordering of (4) (merge reads the
file before the delete, writes after it → the sent 3 are re-sent); the same claim fixes both.

Fix:
- `telemetry-counters.ts`: every read-modify-write of counters.json / pending/ (recordEvent,
  migrateStaleCounters, getCounters, resetCounters, the new claim functions) runs under
  one lock, `<countersPath>.lock`, reusing `withLock` from sync.ts (pid-liveness steal,
  heartbeat, token-checked release). The clock is read under the lock.
- Flush claims: `claimPending` renames `pending/<d>.json` →
  `<d>.json.sending.<host>.<pid>.<uuid>` under the lock before the POST;
  `completeClaim` deletes it on 2xx; `releaseClaim` merges it back on failure;
  `recoverOrphanClaims` merges back claims whose owner pid is dead on this host
  (at-least-once after a crash mid-POST, the same guarantee a pending file left by a crash
  always had). Claims from another host / unprobeable owners are never guessed dead.
- `telemetry-flush.ts`: recover orphans → migrate → for each pending date: claim, POST,
  complete or release.

Engineering choices (conservative, recorded):
- Lock contended for ~1 s (8 retries, 2 ms base): the event is DROPPED, not written
  unlocked. Callers (claw) call `recordEvent` without try/catch and telemetry must never
  block or fail a tool call; an undercount is the conservative error.
- The same-date merge in `moveToPending` stays (sum learn/recall, max session): under the
  lock the two snapshots it merges are disjoint event sets.

Theorems (`Telemetry`): `step_preserves`, `conserved` (every interleaving of locked
recorders/flushers from an invariant state keeps it), `shipped_le_recorded`, `empty_inv`,
`good_case` (non-vacuity: 3 events → rollover → claim → ack ships exactly 3). Pre-fix
counterexamples: `old_rollover_double_counts` (includes `Inv s0`: one stale write from a
good state breaks it), `old_same_day_loses`, `old_double_post`, `old_merge_during_post_lost`.

Mutation-check: (a) `claim` without removing the pending file (the pre-fix
"send without claim") → `step_preserves` fails (omega, claim case) and `good_case` is
refuted by `decide`. (b) adding the unlocked write `writeFrom` as a `Step` → the theorem
is false, witnessed by `old_rollover_double_counts` (a single stale step from `Inv s0`).

Tests: `formal-r2-retrieval-telemetry.test.ts` (6 tests; (1)–(5) failed before the fix,
all 6 pass after). Regression: telemetry-counters, telemetry-flush, telemetry-atomic-write,
telemetry (38 pass together with the new file); claw telemetry-wiring (3 pass).
No pre-existing test changed.

Files: packages/core/src/telemetry-counters.ts, packages/core/src/telemetry-flush.ts.

## 2. Query rewrite drops non-ASCII content words (core-retrieval#8) — CONFIRMED+FIXED

`tokenCore` (intent/rewrite.ts) kept only `[a-z0-9]`; `stripScaffolding` drops tokens with
an empty core, so every CJK / Cyrillic / Devanagari / Thai word was removed from the BM25
query of a question, although `ftsTokenize` indexes those scripts (its Unicode L/N/M fix).
The ≥2-token guard passed on the remaining ASCII words.

Replay (pre-fix, `npx tsx $SCRATCH/replay2.ts`, calls `rewriteLexicalQuery` from src):
```
"What is the 部署 process for kubernetes?" -> "is the process for kubernetes"   fts: [what, process, kubernetes, 部署]
"what did 田中 say about déploiement?"     -> "say about déploiement"           fts: [..., déploiement, 田中]
```
Accented Latin survived only by accident (non-empty ASCII remainder: "café" → "caf").

Fix: `tokenCore` uses `[^\p{L}\p{N}\p{M}]/gu` — the class `ftsTokenize` keeps. Interrogative
and auxiliary matching is unchanged (all ASCII).

Theorems (`Rewrite`): `content_kept` (every token with a word character that is not
scaffolding survives, for every class oracle and scaffold lexicon), `scaffold_dropped`
(non-vacuity), `old_drops_cjk` / `new_keeps_cjk` (concrete).
Mutation-check: stating `content_kept` over the ASCII class (the pre-fix core) → does not
prove (unsolved goals); `old_drops_cjk` is the witness that it is false.

Tests: `formal-r2-retrieval-rewrite.test.ts` (4 tests; 3 failed before, all pass after).
Regression: intent-rewrite, intent-classifier, intent-routing — 79 pass with the new file.
Files: packages/core/src/intent/rewrite.ts. No pre-existing test changed.

## 3. recallAuto label / expandedSearch limit (core-retrieval#9) — CONFIRMED+FIXED (both halves)

(a) `hybridSearchWithMeta` no longer throws when the embedder fails: it returns the
lexical-only fusion with `mode: 'hybrid-degraded'` (or `'bm25-only'` when the user disabled
embeddings). `recallAuto` called `hybridSearch` (engrams only) and labelled every such run
`strategy_used: 'hybrid'`.

(b) `expandedSearch` returned `max(limit, 50)` for aggregation queries. Decided a bug, not
design: #770/#774 ("recall limit floor leak — slice(0, limit) on all hybrid paths") made
"the returned list is always capped at `limit`" the contract and documented the 50 floor as
an internal over-fetch; the expansion path (reached via `recallExpanded` and
`recallAutoSearch`) kept the pre-#770 "aggregation returns more results" slice. No test pins
the >limit return; `query-expansion.test.ts` "respects limit parameter" pins the cap for
non-aggregation queries. The per-variant floor of 50 (the widening) is kept.

Replay (pre-fix, `formal-r2-retrieval-labels.test.ts`, offline: stub embedder that throws /
embeddings disabled):
```
failing embedder, NL query:   strategy_used = 'hybrid'   (embedderStatus().available = false)
embeddings disabled:          strategy_used = 'hybrid'
aggregation, limit 5, 80 hits: expandedSearch returned 50
```

Fix: search-orchestrator.ts `runHybrid` calls `hybridSearchWithMeta` and labels a run
`hybrid` only in mode `'hybrid'`, else `'bm25'` (the type has no degraded label; the results
are lexical-only). Routing unchanged — labels only. query-expansion.ts returns
`merged.slice(0, limit)`.

Observation, not changed (routing, would change behaviour for opt-out installs): on the
keyword path a degraded hybrid run with ≥3 results is returned instead of falling through to
the LLM expansion that the `catch { /* hybrid unavailable */ }` branch was written for.

Theorems (`Labels`): `hybrid_label_truthful` (label `hybrid` ⇒ a hybrid run in mode
`hybrid`, over every branch of `recallAuto`), `hybrid_label_reachable`,
`old_degraded_is_hybrid`; `expanded_capped`, `expanded_full` (non-vacuity),
`old_expanded_leaks`.
Mutation-check: `hybrid_label_truthful` over `labelOld` → fails; `expandedNew` with
`max limit 50` → `expanded_capped` and `expanded_full` fail (omega).

Tests: `formal-r2-retrieval-labels.test.ts` (4 tests; 3 failed before, all pass after).
Regression: search-orchestrator, query-expansion, hybrid-search — pass (14 + 12).
Files: packages/core/src/search-orchestrator.ts, packages/core/src/query-expansion.ts.
No pre-existing test changed.

## 4. Importer dry run vs real run, re-import idempotency (core-retrieval#10) — CONFIRMED+FIXED (dry-run parity) / CONFIRMED+NEEDS-OWNER (re-import mutates)

Survey lead partly DOWNGRADED: "dry run omits the sensitivity guard and scope-dependent
dedup" does not change the report on a YAML-backed store. The sensitivity guard never
errors — it demotes a shared/remote scope to `local` and the record is still `imported` in
both modes; and learn()'s dedup reports a same-scope repeat (write_count bump) and a
cross-scope repeat (recurrence) alike as a pre-existing id → `skipped`, which is what the
scope-blind dry run predicts. The divergences that DO exist, replayed:

Replay (pre-fix, `formal-r2-retrieval-importer.test.ts`, dry run and real run on two fresh
stores with identical seed):
```
['🎉🎉🎉', '!!! ???'] (unhashable, #896):  dry 1 imported + 1 skipped   real 2 imported
source = 'notes from password=… session':  dry imported                 real error (learn scans context fields)
```

Fix (importers/engine.ts): one `importContext(record, scope, opts)` builds the LearnContext
for both modes; the dry run scans `statement + learnContextContent(context)` exactly as
`_hardScanText` does, and skips hash dedup when `!isHashable(statement)`. Building the
context is inside the per-record error handling in both modes (a malformed field is an
`error` row, never a thrown import). The dry-run secret message now reads "Secret detected
in statement or context: <pattern>" (the old "statement/domain/tags" wording was not pinned).

Residual, not fixed (needs index.ts): on a DELEGATING primary store (Postgres/PGLite with
`findActiveByContentHash`), learn() deliberately does not detect a cross-scope repeat in the
primary store, so the real run imports a new engram where the dry run says `skipped`. The
engine cannot see the store's capability set; exposing it would be a Plur API addition.

NEEDS-OWNER — re-import mutates the store while reporting "skipped". Replay
(`npx tsx $SCRATCH/replay4.mts`):
```
re-import 2: imported=0 skipped=2  [['idem one', write_count 3, sources 3], ['idem two', 3, 3]]
cross-scope re-import (--scope project:other): imported=0 skipped=1  ['idem one', global, write_count 4, recurrence_count 1]
```
The engine header documents the bump ("same scope → write_count bump"); the test
`importers.test.ts` "re-importing the same file is idempotent (all skipped)" claims
idempotency and checks only the row count; the report says `skipped`. Question: should
importing a record that already exists count as a re-affirmation?
(A) No — a true skip: check the hash before calling learn() and leave the existing engram
untouched (re-import idempotent; cross-scope repeats no longer graduate engrams via import).
(B) Yes — keep the bump/recurrence, but report it (`action: 'reinforced'`, a report-schema
change the CLI prints).
(C) Keep as is.
Recommendation: (A) — re-running an import is usually a retry, not new evidence, and an
import that silently graduates existing engrams to global is surprising.

Theorems (`Importer`): `newDryStep_eq`, `dry_predicts_real` (for every store state and
record sequence the dry run's actions equal the real run's), `outcomes_reachable`
(non-vacuity), `old_unhashable_diverges`, `old_source_secret_diverges`.
Mutation-check: dedup on the empty hash restored (Mut4a) or the context-field scan dropped
(Mut4b) → `newDryStep_eq` fails.

Tests: `formal-r2-retrieval-importer.test.ts` (3 tests; 2 failed before, all pass after).
Regression: importers.test.ts — 49 pass with the new file. `packages/cli/test/import.test.ts`
imports core's built dist, not run here (coordinator's full suite).
Files: packages/core/src/importers/engine.ts. No pre-existing test changed.

## 5. Capsule integrity naming (core-retrieval#11) — CONFIRMED+FIXED (docs only, as instructed)

`verifyCapsuleIntegrity` is `readCapsule` not throwing: structure, flag/header agreement,
payload size and payload SHA-256 against the header. The Ed25519 trailer is length-checked
and never verified, and nothing covers the header. Exported (index.ts), unused internally.

Replay (`npx tsx $SCRATCH/replay5.mts`):
```
zero signature verifies: true                       # SIGNED capsule, 64 zero bytes, "signer" AAAA
orig ok true | forged ok true someone-else          # header + payload rewritten, hash recomputed
```
The existing test (capsule.test.ts "returns … false for tamper") flips a header byte, which
fails as malformed JSON — a parse failure, not header integrity.

Fix (capsule.ts): JSDoc on `verifyCapsuleIntegrity` states what it checks and, explicitly,
that it verifies neither the signature nor the header and is not an authenticity check;
the layout comment says the signature is carried, not verified, and the hash covers the
payload only. No signature verification invented; the name is kept (renaming an exported
API is a breaking change — optional owner call, not needed for truthfulness).

Theorems (`Capsule`): `signature_ignored`, `header_not_covered` (the two documented
limits, for every hash oracle), `payload_tamper_detected` (what it does catch),
`good_verifies` (non-vacuity).
Mutation-check: a `verify` that consults the trailer/header info → `signature_ignored` and
`header_not_covered` fail (so the theorems pin exactly the documented limits).
Tests: none added (documentation-only change); capsule.test.ts 13 pass.
Files: packages/core/src/capsule.ts.

## 6. Embedding cache merge / silent BM25-only inject (core-retrieval#12) — CONFIRMED+FIXED (merge) / CONFIRMED+NEEDS-FILE (inject)

(a) `mergeEmbeddingsIntoCache` skipped any import whose engram already had a cache entry,
justified as "written against the same text and at least as fresh". False when the engram's
text changed since that entry: the caller (`exportPgliteEmbeddingsToCache`) verified the
import against the CURRENT text, the stale entry blocked it, and the next search missed the
cache and re-embedded — the cost the export exists to avoid. Self-healing, low severity.

Replay (pre-fix, `formal-r2-retrieval-embcache.test.ts`): cache entry hashed from "old text",
import for "new text" → `written = 0`, entry unchanged.

Fix (embeddings.ts): an existing entry wins only when its hash equals the import's
`hashStatement(searchText)`; otherwise the import replaces it. Docstring corrected. The
"safe to re-run without clobbering newer cache entries" test (pglite-embeddings-export)
still holds: a re-run imports the same text, so hashes match and nothing is written.

(b) `injectHybrid` (index.ts, not owned): when the embedder fails, `embed()` swallows the
error and `embeddingSearchWithScores` returns `[]`, so the injection silently runs on
keyword matching only; the `catch { /* Embeddings unavailable */ }` also swallows the other
failures (e.g. the dimension-mismatch throw) without a log line. Replay
(`npx tsx $SCRATCH/replay6.mts`): stub embedder that throws → `embedderStatus()`
`available=false, lastError='model crashed'`; the InjectionResult has no warning or mode
field and nothing is logged.

NEEDS-FILE (packages/core/src/index.ts, owner R2-CoreA), `injectHybrid`:
```ts
let embedFailure: string | null = null
try { …existing embedding block… }
catch (err) {
  embedFailure = (err as Error)?.message ?? String(err)
  logger.warning(`[plur] injectHybrid: embeddings failed (${embedFailure}) — keyword-only injection.`)
}
const st = embedderStatus()
if (!embedFailure && !st.disabled && !st.available) embedFailure = st.lastError ?? 'embedder unavailable'
const remote = await this._remoteInjectCandidates(remotePromise, options)
const result = await this._formatInjection(task, options, embeddingBoosts, remote)
if (embedFailure) result.warnings = [...(result.warnings ?? []), `hybrid-degraded: ${embedFailure} — injected by keyword match only`]
return result
```
(If `warnings` should stay tension-only, the alternative is `mode: 'hybrid' | 'hybrid-degraded'
| 'bm25-only'` + `embedder_error` on InjectionResult, mirroring `HybridSearchResult` — the
index.ts owner's call; user-disabled embeddings must NOT be flagged.)

Theorems (`EmbCache`): `merge_fresh_hits` (after merging a verified-fresh import the next
search is a cache hit, for every prior cache state), `merge_keeps_equal` (non-vacuity:
an equally fresh existing entry still wins), `old_stale_blocks`.
Mutation-check: `mergeNew` with "existing always wins" restored → `merge_fresh_hits` fails.

Tests: `formal-r2-retrieval-embcache.test.ts` (2 tests; 1 failed before, both pass after).
Regression: pglite-embeddings-export (10 incl. the new file and embeddings-save-cache-path;
one run under parallel load timed out a PGLite case, which passed alone and on rerun —
the known PGLite contention the vitest config documents).
Files: packages/core/src/embeddings.ts.
