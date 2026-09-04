# ADR-0005: The Postgres tier, and what happens to exact search

Status: **Accepted** — implemented in 0.16; amended 2026-07-28, see
[Update — Phases 2 and 4 have landed](#what-this-phase-does-not-do-and-why);
the amendment's embeddings gap is closed by #762 (see its Closure note)
Date: 2026-07-26
Authors: convergence programme, Phase 5
Related: ADR-0001 ([#226](https://github.com/plur-ai/plur/issues/226)), ADR-0003,
ADR-0004 (the Phase 2 async flip), [#223](https://github.com/plur-ai/plur/issues/223)
(halfvec tier), [#711](https://github.com/plur-ai/plur/issues/711) (Phase 4 BM25
pushdown)

## Context

Two problems, one phase.

### 1. The default backend does nothing

`Plur._resolveBackend()` read `PLUR_BACKEND`, then `config.backend`, then
returned `'sqlite'`. The corpus never entered the decision. And because
`PlurConfigSchema` is `.partial()` — which neutralises Zod defaults —
`config.index` is `undefined` in a default install, so the `'sqlite'` branch
(`else if (this.config.index)`) never fired either.

The net effect of the "default backend" was **no backend**. Every recall loaded
the entire corpus into the process and brute-forced cosine over it. Measured:
~350 MB resident per process at ~4,700 engrams — paid again by every process
that opens the store, and growing linearly.

### 2. `StorageAdapter` could not describe a store of record

ADR-0003 fixed the interface half of this: `role: 'index' | 'primary'`, with the
rebuild methods optional, so a backend that IS the source of truth is
expressible. It left the implementation to this phase, and left one question
open that it could not answer from where it stood: what happens to *search
quality* when the backend changes.

Core has always been exact. `searchVector()` scans every candidate and returns
the true top-k, so recall is 1.0 by construction. Nobody has ever had to ask,
because there has never been an alternative. A server-scale backend does not
have that option: at hundreds of thousands of vectors an exact scan is not a
slower answer, it is not an answer. The industry-standard alternative —
pgvector's HNSW — is *approximate*, and its recall is a tuning outcome rather
than a property.

That is a real behavioural difference between two deployments of the same
engine. Undocumented, it is the exact class of divergence this programme exists
to remove.

## Decision

### 1. `PostgresAdapter` implements both interfaces

`packages/core/src/storage-postgres.ts`:

```ts
export class PostgresAdapter implements StorageAdapter, AsyncPrimaryStore {
  readonly role = 'primary' as const     // query side: store and index are one engine
  readonly kind = 'postgres'             // store side
  // load / loadCached / save / invalidate   — AsyncPrimaryStore
  // loadFiltered / count / searchBM25 / searchVector / upsertEmbedding / close
}
```

It deliberately does **not** implement `syncFromYaml()` / `reindex()`. There is
no file to rebuild from. `requiresIndexSync()` returns false for `role:
'primary'` precisely so no caller tries.

The schema mirrors the PGLite adapter's — `engrams` (hot filter columns plus a
`data` JSONB) and `engram_embeddings` (one vector per engram, `ON DELETE
CASCADE`). Sameness is the point: it is what lets a corpus move between tiers,
and what makes the two adapters testable against each other.

`save()` is upsert-then-prune rather than truncate-then-insert. Truncating would
cascade away every embedding and force a full re-embed of an unchanged corpus;
upserting leaves surviving engrams' vectors in place and lets the cascade remove
exactly the ones whose engram genuinely went away.

### 2. Size-based tier selection

`packages/core/src/backend-selection.ts` — a pure, total function:

> ### Amendment — 2026-08-27 (#1046): PGLite is opt-in; the size-selected tier is SQLite
>
> The ladder below shipped as designed and then failed in the field: PGLite
> boots a full Postgres-in-WASM **per process** (~1.3s fresh, ~244ms reopen),
> and PLUR's CLI and hooks are a fresh process per invocation — measured at
> 0.61s (sqlite) vs 300s+ (pglite) per command on a 5,775-engram store, the
> latter compounded by an unawaited constructor-time full-corpus resync that
> never converged. The per-query engine was never the problem (0.135ms,
> faster than better-sqlite3 single-row inserts); the per-process boot is
> structural and unfixable for this process model.
>
> The size ladder is now **yaml → sqlite → postgres**. `SQLITE_MIN_ENGRAMS`
> replaces `PGLITE_MIN_ENGRAMS` at the same 5,000 (that threshold was always
> "index vs brute-force scan", which stands). PGLite is reachable only via
> `PLUR_BACKEND=pglite` / `backend: pglite` — a capability choice (pgvector,
> AGE) and the Postgres adapter's CI test double, never a consequence of
> growth. The `wanted: 'postgres'` loud-fallback now lands on sqlite.
>
> Honesty note carried from the review: the SQLite tier is a METADATA index.
> Vector search remains brute-force JS cosine over the in-RAM embeddings
> cache (~768 MB at 500k × 384d fp32, more as parsed JSON), so the eventual
> escape from that memory curve is the postgres tier's HNSW — not a larger
> local index. §1's original complaint (the default backend built no index at
> all) recurred once during this change and is now pinned by
> `pglite-backend-selection.test.ts`'s "materialises its index" test.
>
> The table and thresholds BELOW are preserved as written for the record; the
> Verification section's claims about `pglite-backend-selection.test.ts` now
> hold with sqlite in place of pglite.

| Tier | Store | Query | Fits |
|---|---|---|---|
| `yaml` | YAML file | in-memory BM25 + exact cosine | a personal store |
| `sqlite` | YAML file | better-sqlite3 metadata index | legacy, explicit only |
| `pglite` | YAML file | PGLite (WASM pg + pgvector) | a large single-user store |
| `postgres` | Postgres | Postgres + pgvector | a multi-process / multi-tenant deployment |

Thresholds, and why these numbers:

- **`PGLITE_MIN_ENGRAMS = 5,000`.** The brute-force tier's cost is linear in
  corpus size and paid per process; the measured pain point is ~4,700 engrams /
  ~350 MB. Below 5,000 an index costs more (WASM boot, a second copy on disk)
  than the scan it replaces. Above it, the scan is the dominant cost.
- **`POSTGRES_MIN_ENGRAMS = 50,000`.** Not a performance cliff — PGLite is still
  competent there — but the point past which a *single-process WASM* engine is
  the wrong shape. PGLite is one writer, in one process, with no shared buffer
  cache, so N agent processes pay the index cost N times; a server hands all of
  them one engine. Chosen as an order of magnitude above the PGLite threshold
  rather than measured, and deliberately conservative: escalating to a network
  store is a far bigger operational change than building a local index, so the
  automatic path should be reluctant.

Both are round numbers standing in for a range. A 10% move either way should not
matter, and if it does, the threshold is not the thing that needs fixing.

The size estimate comes from `PrimaryStore.estimateCount()` — a new optional
method that MUST NOT parse the corpus. `YamlPrimaryStore` derives it from
`statSync().size / 2,400 B` (measured mean: 9,595,797 B / 4,009 engrams on a
real long-lived store). Deciding which backend to build must not cost what the
wrong backend would have cost.

**Overrides always win.** `PLUR_BACKEND` beats `config.backend`, which beats the
estimate. The automatic path exists to make the default sane, not to overrule a
decision someone made on purpose. An explicit `backend: postgres` with no
connection string is honoured and fails at connect time; only the *automatic*
path declines, and when it does it reports `wanted: 'postgres'` rather than
silently landing somewhere else.

### 3. The vector-index strategy is a declared adapter property

`StorageAdapter` gains a **required** field:

```ts
readonly vectorIndex: VectorIndexStrategy   // kind, exact, recallTarget, format, params
```

`PGLiteAdapter` reports `{ kind: 'exact', exact: true, recallTarget: null }`.
`PostgresAdapter` reports exact or HNSW depending on what it actually built —
resolved at init from the store's real row count, not from what was requested.

Required, not optional, and that is a compile-time break for any external
implementor — the same trade ADR-0003 made for `role`, for the same reason. An
optional field means a caller cannot rely on asking, which defeats the purpose.

`recallTarget` for the HNSW tier is **0.95**, at pgvector's default build
parameters (`m = 16`, `ef_construction = 64`). It is a *target*, not a
measurement: it has not been measured on PLUR's corpus with PLUR's embedder, and
this ADR does not claim it has.

**How it would be measured** (and what would refute it): fix a corpus and an
embedder; take a query set of at least 200 real recall queries; for each, run
the exact scan (`enable_indexscan = off`) as ground truth and the HNSW scan at
the shipped `ef_search`; recall@k is the mean of `|approx ∩ exact| / k` over the
query set. Report at k = 10, 20 and 50 — recall degrades as k approaches
`ef_search`, so a single-k number hides the failure. A measured recall below the
target at any of those k values falsifies the constant, and the fix is to raise
`ef_search` (query-time, cheap) before raising `m` / `ef_construction`
(build-time, requires a reindex). The Postgres test suite runs exactly this
comparison at k = 20 on a small corpus as a smoke check; it is a guard, not the
measurement.

### 4. `ef_search` is raised to at least the requested limit

pgvector's `hnsw.ef_search` defaults to **40**. An HNSW scan visits at most
`ef_search` candidates, so a query with `LIMIT 50` returns at most 40 rows — no
error, no warning, and a result set that looks perfectly plausible.

`efSearchFor(limit, configured)` in `storage-adapter.ts` is the shared guard:

- floor of `limit` — below it, returning `limit` rows is arithmetically
  impossible;
- times `EF_SEARCH_FILTER_HEADROOM = 2`, because `searchVector()` post-filters
  on `status = 'active'` (and a scope predicate, once Phase 3's pushdown lands).
  The index cannot evaluate those, so candidates are removed *after* the scan
  and `ef_search = limit` can still come back short;
- never below an operator-configured value — tuning up is honoured, tuning down
  below the limit is not.

It is applied per query via `SET LOCAL hnsw.ef_search`, so a pooled connection is
never left carrying another query's tuning.

This is the same constant Phase 3's scope pushdown needs, which is why it lives
on the shared module rather than inside the Postgres adapter.

### 5. The fp16 tier is a format difference, not a size knob

Core already has a `halfvec(N)` precision tier ([#223](https://github.com/plur-ai/plur/issues/223)):
2 bytes per dimension instead of 4, ~50% smaller, −0.2 to −0.5pp recall. It
rounds every stored element to fp16 — so a tier running `halfvec` and a tier
running `vector` do not merely differ in size, they **store different numbers**
and score the same query slightly differently.

That is now part of `VectorIndexStrategy` as `format`. Two deployments of the
same engine can be diffed on it without reading either one's source. If it is
ever enabled on one tier and not another, that shows up as a declared difference
rather than as an unexplained scoring delta, which is exactly the failure mode
this field exists to prevent.

## What this phase does NOT do, and why

> ### Update — Phases 2 and 4 have landed
>
> *Added 2026-07-27. The rest of this section is the record as written at Phase
> 5 and is kept for the reasoning; the two deferrals it describes are no longer
> in force. Where the two disagree, this block is what the code does.*
>
> **`PostgresAdapter` IS accepted by `new Plur({ store })`.** Convergence
> Phase 2 flipped `Plur`'s write path, so the synchronous ceiling described
> below is gone. The two interfaces collapsed exactly as planned:
> `PrimaryStore` *is* the async contract, and `AsyncPrimaryStore` is now a
> deprecated alias for it (`packages/core/src/store/primary-store.ts`). The
> acceptance test is `new Plur({ path: dir, store: adapter })` in
> `test/postgres-primary-store.test.ts` — it writes through the adapter and
> reads the row back from a second `Plur` over the same schema, proving the
> data is in the database rather than in a process-local cache.
>
> The three-point consequence list below therefore no longer describes an
> unconditional fallback. Backend selection still never *constructs* a
> connection implicitly — a connection has credentials and a lifecycle, and
> manufacturing one inside a constructor hides failure at a surprising moment —
> so the caller still passes the adapter in. What changed is the branch taken
> when it does not: `Plur` logs one message naming the tier and how to run on
> it, rather than reporting a limitation. Points 2 and 3 still hold as written:
> the query index is PGLite even on the Postgres tier, and persistence goes
> through the configured `PrimaryStore` — which may now be the adapter itself.
>
> **BM25 pushdown (Phase 4) has landed too**, and did not cost the property the
> last paragraph below exists to protect. `PostgresAdapter.searchBM25()` narrows
> the candidate set in the database with `pg_trgm` where it is available, then
> still scores in core through `fts.ts`, using corpus-wide statistics from
> `StorageAdapter.corpusStats` so the narrowing cannot change the ranking. Where
> `pg_trgm` is absent it loads the active set and scores locally, which is
> exactly the behaviour described below. There is still one tokenizer and one
> IDF computation across every backend.
>
> Only the vector path remains a declared behavioural difference between tiers,
> which is what `VectorIndexStrategy` is for.

*As written at Phase 5 (2026-07-26):*

**`PostgresAdapter` is not yet accepted by `new Plur({ store })`.**

`PrimaryStore` is synchronous (ADR-0003: deliberately, temporarily). Node has no
synchronous Postgres client, and the ways to fake one — blocking on a promise, a
subprocess per query — trade a documented limitation for an undocumented hazard.
So the adapter implements `AsyncPrimaryStore`, the async successor with the same
four operations and the same semantics, which convergence Phase 2 collapses back
into `PrimaryStore` when it makes `Plur`'s write path async.

Consequently, when the tier resolves to `postgres`, `Plur`:

1. logs one warning naming the reason and the fallback;
2. runs the PGLite index — a real, wired, working backend — instead of nothing;
3. keeps persisting through its configured `PrimaryStore`.

Not half-wiring the adapter into the query path is the point. An adapter with
`role: 'primary'` whose engine nothing writes to would answer every query with
an empty result set — silently, and correctly by its own contract. A loud
fallback to a working tier is strictly better than a silent one to a correct-but-
empty one.

Also out of scope, deliberately: the async write-path conversion (Phase 2) and
BM25 pushdown (Phase 4). `searchBM25()` here loads the active set and scores it
through `fts.ts`, exactly as the PGLite adapter does, so BM25 ranking has one
tokenizer and one IDF computation across every backend. A second ranking
authority is the same class of silent divergence as an undeclared recall
difference.

## Consequences

### Positive

- The default install stops brute-forcing a growing corpus in every process.
- A deployment can ask what it is running (`plur.backendSelection()`) and what
  its search actually guarantees (`adapter.vectorIndex`) instead of inferring
  either.
- Recall differences between tiers become declared data, comparable across
  deployments, with a stated measurement protocol.
- The pgvector `ef_search` trap is closed once, in shared code, for every
  current and future consumer of an HNSW index.

### Negative / accepted

- `vectorIndex` is a required field on `StorageAdapter` — a compile-time break
  for external implementors. Two implementors in-repo.
- `PostgresAdapter.buildFilterClause` is a copy of `PGLiteAdapter`'s. A copy is a
  divergence waiting to happen; the mitigation is a behavioural cross-adapter
  parity test (same corpus, same filters, identical result sets) rather than a
  shared-code extraction, which would collide with the Phase 3/4 work in flight.
  The extraction should happen once those land.
- `HNSW_RECALL_TARGET` is asserted, not measured, on PLUR's corpus. Stated
  plainly here rather than presented as a result.
- `pg` becomes an optional dependency of `@plur-ai/core`, imported lazily. A
  personal install never loads it.
- The Postgres suite is skipped unless `PLUR_TEST_POSTGRES_URL` is set. CI sets
  it against a `pgvector/pgvector:pg16` service container, so the suite is
  proven rather than nominally present; a database that is present but broken
  fails the run instead of skipping.

## Verification

- `test/backend-selection.test.ts` — the resolver as a pure function:
  thresholds, override precedence, totality on degenerate input, and
  `estimateCount()` producing a count without parsing the corpus.
- `test/pglite-backend-selection.test.ts` — what the decision actually builds: a
  store past the threshold gets a PGLite index; a store below it gets none; the
  Postgres tier degrades with a warning that names the reason and never leaks
  the DSN password.
- `test/vector-index-strategy.test.ts` — `efSearchFor` never returns below the
  requested limit, defeats pgvector's default where it would truncate, and
  honours an operator raising the floor but not lowering it; adapters declare
  their strategy; construction guards reject unsafe identifiers and tuning
  values.
- `test/postgres-adapter.test.ts` — against a real Postgres 16 + pgvector 0.8.2:
  the primary-role contract, `save()`/`load()` round trip and full-replace
  semantics, embedding preservation across a re-save, scope/domain/status filter
  semantics, the `#335` dimension guard, exact-search ordering, and the HNSW
  tier — including a test that **demonstrates the truncation** at pgvector's
  default `ef_search` and one that shows the guard fixing it, plus a recall
  check against the exact answer.
- `PGLite × Postgres` filter parity across ten filter shapes, including the
  personal-family pass-through (#402) and sibling-prefix (#383) cases.


## Amendment — 2026-07-28: the engine does not populate vectors on this tier

This ADR reasons at length about the exact-vs-HNSW trade-off, and that analysis
holds — but it assumed embeddings would be present. On a Postgres PRIMARY store
they are not.

`PostgresAdapter` implements `upsertEmbedding`, `hasEmbedding` and
`searchVector`, and they work. What is missing is the caller: core's only
`upsertEmbedding` call site is `_autoEmbedNewEngrams`, reached solely through
the PGLite derived-index path. Measured on 0.16: five engrams learned through
`Plur` against a `PostgresAdapter` leave `engram_embeddings` with zero rows.

Consequences as shipped:

- `vectorIndex: 'auto'` correctly builds nothing, since the row count is zero.
- `vectorIndex: 'hnsw'` builds an ANN index over an empty table.
- `recallSemantic` / `recallHybrid` still return correct results, via the
  in-memory embedding path — which is the O(N) behaviour this tier was chosen
  to escape.

0.16 makes the gap loud (a warning at schema init) rather than closing it. The
fix is not a one-liner: `_autoEmbedNewEngrams` loads the whole corpus and probes
`hasEmbedding` per id on every write. That is acceptable for PGLite and would be
a serious regression at the 50,000-engram threshold that selects Postgres. It
needs a set-based "which active ids have no embedding" query, and a decision
about whether a server tier should pay embedding cost on the write path at all —
which is a deployment question, not just an implementation one.

### Closure — #762

The gap above is closed, on exactly the terms this amendment demanded:

- **The set-based query exists.** `PostgresAdapter.listEngramsMissingEmbeddings`
  is one bounded anti-join between the two tables' primary keys (active rows
  with no embedding row, `ORDER BY id LIMIT n`). Cost scales with the gap, not
  the corpus; the `LIMIT 1` shape doubles as a completeness probe.
- **The write path does NOT pay embedding cost.** Every primary-store write
  kicks a fire-and-track background pass (`_syncIndex` → the coalescing
  `_kickPrimaryAutoEmbed`) that drains the anti-join in bounded batches.
  Back-to-back writes coalesce into one follow-up sweep instead of stacking
  passes. Failures land in `lastIndexError()` / `status().index_error`, never
  in the write.
- **Backfill needs no operator step.** The first semantic recall probes
  completeness; a store migrated in with rows but no embeddings starts the
  backfill from the read side and converges without a single write.
- **`recallSemantic` reads the table** — `_primarySemanticRecall` pushes the
  k-NN into `searchVector` (scope allow-list, visibility scope, and mounted
  grants all inside the query) once the table is complete, and degrades to the
  in-memory path while it fills — partial vector answers are never served.
- **Opt-outs hold.** `PLUR_DISABLE_EMBEDDINGS` / `embeddings.enabled: false`
  skips the pass before any query (one loud notice per instance), and an
  embedder/column dimension mismatch skips rather than persist wrong-shape
  vectors (#335). The schema-init warning this amendment introduced is gone —
  the condition it warned about no longer exists when the engine drives the
  adapter.
