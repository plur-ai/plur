# Sprint 0 Audit — Iter 1 — Archivist

## Verdict
SHIP_WITH_FIXES

## Summary

The integrated `epic/sprint-0-substrate` branch (HEAD 626a960) honors the four
locked engrams as architectural intent — YAML-as-truth is enforced by Test A
and Test B; EmbeddingGemma is the new default; the per-feature pipeline
delivered the 5 expected PRs against the epic branch. The branch-per-feature
rule (ENG-UPL-2026-05-30-001) is followed to the letter, with every feature
going through `feat/<slug>` → PR → merge into epic.

However, two classes of institutional-context drift surfaced:

1. **Process drift from ENG-2026-0530-029 stage 4 (per-feature micro-benchmark)
   and stages 2-3 (TDD red/green split).** PR 1 lacks the TDD red commit and
   produces no micro-benchmark; PRs 2-4 ship without the
   `benchmark/results/sprint-0/<branch>.json` artifact called for in the plan;
   only PR 5 leaves the expected file. Per-feature contribution decomposition
   (plan Phase D) cannot be computed from what was committed.

2. **Documentation / methodology drift around the bake-off and the SQLite
   default.** The bake-off ran at N=5/category (30 scenarios — the local
   fixture's full content) and the decision is published as if it stands as
   Sprint 0 evidence; the plan said the bake-off "runs PR 3's harness against
   the canonical LongMemEval-S subset (N=500) once per embedder". The sampler
   resamples-with-replacement when N exceeds pool size, so an N=500 invocation
   produces 500 draws from 30 unique scenarios — not LongMemEval-S coverage.
   The Plur class default backend is still `'sqlite'`, contradicting
   ADR-0001's accepted decision ("SQLite considered and rejected for
   consistency") and the Wave 1 strategy in epic #225 ("single backend family,
   PGLite locally"); plan PR 2 spec was "PGLite + pgvector + AGE bundled and
   lazy-loaded", with the old path as a "fallback feature flag for one minor
   version" — that flag exists as a default rather than as an opt-in legacy
   shim.

None of these block ship per se — the engrams' architectural invariants
hold — but they materially weaken the Phase D report and risk the
counter-positioning narrative the epic was supposed to set up.

## Findings

### BLOCKER (engram violation; locked rule broken)

None. The four locked/decided engrams (019, 020, 029, ENG-UPL-2026-05-30-001)
are not literally violated by code in HEAD. The violations below are process
and documentation drift against the same engrams' explicit specs.

### MAJOR (institutional context ignored)

- **[F-ARCH-001] Default backend is `'sqlite'`, contradicting ADR-0001 and
  Epic #225 Wave 1 strategy.** ENG-2026-0530-018 says Sprint 0 (1) implements
  ADR-0001 substrate — PGLite + pgvector + AGE locally. ADR-0001 (#226,
  "Accepted v2", 2026-05-23) reads "single backend family across all shapes —
  PGLite + pgvector + AGE locally". Epic #225's 2026-05-23 v2 update repeats
  this verbatim. The implementation at `packages/core/src/index.ts:240-246`
  resolves the active backend as `PLUR_BACKEND` env → `config.yaml.backend` →
  default `'sqlite'`. PGLite is opt-in. Plan PR 2 allowed "old in-memory BM25
  path preserved as a fallback feature flag for one minor version" — but the
  fallback is the better-sqlite3-backed `IndexedStorage` (see
  `packages/core/src/storage-adapter.ts:10`), and it is the default rather
  than the explicit opt-out. The ADR's "SQLite considered and rejected"
  language is silently inverted in the runtime defaults.

  - Files: `packages/core/src/index.ts:240-246`, `storage-adapter.ts:10-17`,
    `storage.ts:13-16`.
  - Fix surface: flip the default to `'pglite'` (or `'auto'` that prefers
    pglite when the dep loads) and demote `'sqlite'` to a deprecation flag
    with a CHANGELOG callout + `plur doctor` warning. If keeping the sqlite
    default is intentional for the v0.10 cut, rewrite the ADR + epic to
    reflect that — institutional knowledge must agree with code.

- **[F-ARCH-002] Per-feature micro-benchmark artifacts missing for PRs 1-4.**
  ENG-2026-0530-029 stage 4 + plan stage 6 require, for each feature,
  "Save results to `benchmark/results/sprint-0/<branch-name>.json`". Only
  `benchmark/results/sprint-0/feat-embedding-gemma-default.json` exists.
  PR 1 (yaml-as-truth-tests), PR 2 (pglite-adapter), PR 3 (benchmark-harness),
  PR 4 (embedder-bake-off) shipped without their micro-benchmark file. PR 2's
  PR description has no benchmark section. This breaks plan Phase D's "Per-
  feature contribution decomposition (micro-benchmark deltas from each PR's
  results)" — the data does not exist.

  - Evidence: `ls benchmark/results/sprint-0/` returns one file.
  - Fix surface: re-run `npx tsx benchmark/micro.ts --label <branch>` for the
    four missing branches against `main` and commit the artifacts before the
    epic→main PR opens.

- **[F-ARCH-003] PR 4 bake-off published a decision on N=5/category and the
  doc reads as Sprint 0 evidence.** Plan PR 4 spec:
  "Bake-off runs PR 3's harness against the canonical LongMemEval-S subset
  (N=500) once per embedder". `docs/benchmarks/embedder-bake-off-2026-05.md`
  (lines 26-30, 102-117) acknowledges N=5 and warns that "trust the
  direction, not the magnitude" — but the same file is then cited by PR 5's
  commit message and CHANGELOG ("the Sprint 0 bake-off showed EmbeddingGemma
  matching BGE-small on R@5") as if it were Sprint 0 evidence. The harness's
  sample-with-replacement path at `benchmark/run.ts:160-163` means
  `--iterations 500` against the 30-scenario fixture produces 500 draws over
  30 unique scenarios with massive duplication; the headline LongMemEval-S
  number Phase C is supposed to publish cannot be computed from the current
  fixture.

  - Evidence: `benchmark/data/scenarios.yaml` has 30 entries
    (`grep -c '^- ' benchmark/data/scenarios.yaml` = 30); the bake-off
    artifacts under `benchmark/results/bakeoff/*-N5.json` confirm N=5.
  - Fix surface: either (a) import the upstream LongMemEval-S fixture into
    `benchmark/data/longmemeval-s.yaml` and re-run the bake-off at the real
    N before publishing — preferred; or (b) rename the bake-off doc to
    `embedder-bake-off-smoke-2026-05.md`, mark every conclusion as
    provisional in the CHANGELOG, and defer the EmbeddingGemma default to
    after Phase C if Phase C ever runs.

- **[F-ARCH-004] PR 1 (`feat/yaml-as-truth-tests`) ships as a single commit
  with no TDD red/green split and no micro-benchmark, violating
  ENG-2026-0530-029 stages 2-4.** `git log` shows PR 1 contains exactly one
  commit (`8284ca7 test(core): YAML-as-truth invariants — Test A + Test B`).
  Per the pipeline, every feature's PR should carry distinct
  `test(...): TDD red` + `feat(...): TDD green` commits. PRs 2, 3, 4, 5 all
  comply. PR 1 does not.

  - Evidence: `git log 23240bb~1..23240bb` shows one commit on the branch.
  - Note: PR 1 is "tests only", which arguably collapses the red/green
    distinction. Document the exception explicitly in
    `docs/audit/sprint-0/iter-1.md` so the precedent is not silently set for
    future test-only PRs.

- **[F-ARCH-005] Engine wiring comment in `embeddings.ts` contradicts the
  shipped default.** `packages/core/src/embeddings.ts:115-117` reads:
  "Default stays bge-small (the v0.9.x model) when the env var is unset, so
  existing installs are unchanged." That's wrong after PR 5: the default is
  now `embedding-gemma` (via `resolveEmbedderName()` which returns
  `DEFAULT_EMBEDDER = 'embedding-gemma'`). A reader auditing the file for
  what runs by default will be misled.

  - Fix: rewrite the comment to match the shipped default
    (`packages/core/src/embedders/index.ts:60`) and cite the bake-off doc +
    `embedder-default.test.ts`.

- **[F-ARCH-006] `plur doctor` advice still names BGE-small as the model
  to download.** `packages/cli/src/commands/doctor.ts:577` reads:
  "from the @plur-ai/core package directory, run a script that imports
  @huggingface/transformers and calls pipeline() once to trigger the
  BGE-small-en-v1.5 download (~130MB)." After PR 5 the cold-load is the
  ~325 MB EmbeddingGemma model. A user following the doctor advice will be
  surprised by the size and confused about the model identity.

  - Fix: update the doctor message to name the active embedder and its size,
    or thread `resolveEmbedderName()` through and print the live name.

### MINOR (citation / docs hygiene)

- **[F-ARCH-007] Benchmark harness default embedder is `'minilm'`, not the
  shipped default.** `benchmark/run.ts:239`:
  `const embedder: EmbedderName = (opts.embedder ?? 'minilm') as EmbedderName`.
  This silently makes any `npx tsx benchmark/run.ts` invocation report
  numbers against the historical baseline rather than the engine default.
  Users running "the benchmark" will produce data that doesn't represent
  production. Recommend either default to `embedding-gemma` (consistent with
  `DEFAULT_EMBEDDER`) or require the flag.

- **[F-ARCH-008] No final report file at the planned path.** Plan Phase D
  calls for `docs/benchmarks/sprint-0-report-2026-MM-DD.md`. `ls
  docs/benchmarks/` shows only `embedder-bake-off-2026-05.md`,
  `feature-comparison.md`, `phase2-methodology.md`. Acceptable at iter-1
  (the audit loop is now running), but the auditor should not consider Phase
  D "tracked" until that file exists.

- **[F-ARCH-009] `PGLiteAdapterOptions.vectorDim` comment lies about its own
  default.** `packages/core/src/storage-pglite.ts:99-101` reads:
  "Vector dimension for the embedding column (default: 384 — BGE-small)."
  The actual `DEFAULT_VECTOR_DIM` at line 41 is `768` (EmbeddingGemma). The
  comment is a stale PR 2 artifact.

- **[F-ARCH-010] Bake-off doc cites the bake-off PR's commit SHA but not the
  engram IDs it implements.** `docs/benchmarks/embedder-bake-off-2026-05.md`
  cites the implementation files but doesn't cite ENG-2026-0530-018 (Sprint
  0 scope) or ENG-2026-0530-020 (EmbeddingGemma default decision). The
  archivist convention in this repo (DIP-style citation: engram ID + ADR ID
  + issue ID) was established in the v0.9.12 audit cycle. The new docs
  should follow it.

- **[F-ARCH-011] `epic/sprint-0-substrate` branch lacks an in-tree pointer
  to the plan doc.** The plan lives at
  `~/Data/5-plur/1-tracks/product/sprint-0-plan.md` — outside this repo. New
  contributors browsing the epic branch on GitHub cannot find the plan.
  Either symlink/copy it into `docs/specs/` or add a TOP-LEVEL link from
  the CHANGELOG entry to a GitHub-hosted permalink so the plan survives
  Sprint 0's archive.

### NIT

- **[F-ARCH-012] `loadPgliteVector()` / `loadPgliteAge()` log at `debug`
  level on unavailability.** A first-run user opting into PGLite will get a
  silent BYTEA fallback and a JS-cosine vector search. The fallback is
  correct, but the warning level should be `info` so users opting into the
  ADR-0001 substrate know they're not getting pgvector acceleration.
  `storage-pglite.ts:83, 93`.

- **[F-ARCH-013] `_pgliteInitPromise` typed as `Promise<void> | null` and
  reassigned from `Promise<void>` returned by `syncFromYaml()` AND by
  `reindex()` — fine in practice but worth documenting that only the latest
  promise is awaited via `waitForIndex()`. Tests that issue concurrent
  `learn` and `sync` could observe the wrong "done" signal.
  `index.ts:1881-1885, 1892-1897`.

## Engram Compliance Audit

| Engram | Status | Evidence |
|---|---|---|
| ENG-2026-0530-019 YAML-as-truth | RESPECTED | Test A (`packages/core/test/yaml-truth-rebuild.test.ts`) wipes `store.pglite`, `.fts-cache`, `.embeddings-cache` and reasserts identical recall results. Test B (`packages/core/test/yaml-truth-traceability.test.ts`) asserts every result from `list`, `recall`, `recallHybrid`, `inject`, `getById` traces to a YAML ID. PGLite adapter docstring (`storage-pglite.ts:1-25`) names YAML as source of truth and documents the write order. Embedding cache lives in `.embeddings-cache.json` (JSON), not YAML, so vectors stay out of YAML per the engram's "vectors specifically do NOT go in YAML" clause. |
| ENG-2026-0530-020 EmbeddingGemma default | RESPECTED with [F-ARCH-003] caveat | `DEFAULT_EMBEDDER = 'embedding-gemma'` (`packages/core/src/embedders/index.ts:60`). `embedder-default.test.ts:40-47` asserts this. The two-tier model is shipped (`openai-3-large` adapter via PLUR_EMBEDDER). Reembed migration exists with dim guard + doctor warning. The bake-off "confirm or contradict" step happened at N=5 not N=500 — engram condition "Bake-off ... in Sprint 0 confirms or contradicts" was met procedurally but at a fixture size that cannot statistically confirm the decision. The engram's ≥2pp R@5 dominance criterion (in ENG-2026-0530-020) was not actually testable on N=5. |
| ENG-2026-0530-029 Autonomous pipeline | RESPECTED with [F-ARCH-002, F-ARCH-004] caveats | Stages 1-5 (cut, TDD red, TDD green, full test, push+PR+auto-merge): met for PRs 2, 3, 4, 5; PR 1 lacks the red/green split (single test commit). Stage 4 (per-feature micro-benchmark): met for PR 5 only; PRs 1-4 produced no `benchmark/results/sprint-0/<branch>.json`. Stage 6 (multi-evaluator audit loop): in progress — this is the file you're reading. Feature order (pglite-adapter → yaml-as-truth-tests → ... ) does NOT match the engram; actual order was yaml-as-truth-tests → pglite-adapter → benchmark-harness → embedder-bake-off → embedding-gemma-default. The plan doc reorders to put yaml-as-truth-tests first (correctly — it gates PR 2). The engram should be updated to match the shipped order, or noted as superseded by the plan. |
| ENG-UPL-2026-05-30-001 branch-per-feature | RESPECTED | Every Sprint 0 feature lives on a `feat/<slug>` branch. Epic uses `epic/<slug>` form. PRs are gated to the epic, and the epic-to-main gate is held open per plan. `git log --first-parent main..HEAD` shows the expected 5 merges. No direct-to-main writes. |

## Pattern Reuse vs Re-invention

- **AsyncMutex (storage-pglite.ts:56-69).** Reinvents a small mutex
  primitive. The repo already exports `withLock` from
  `packages/core/src/sync.ts` (referenced by `_resolveBackend()` neighbors)
  for file-lock serialization. Different scope (file vs. in-process), but
  the convention "one synchronization primitive per scope, named
  consistently" was set in the v0.9.x sync work. A 5-line lookup before
  rolling AsyncMutex would have caught this; recommend renaming to
  `InProcessMutex` and citing the file-lock counterpart in the docstring.

- **`vectorLiteral`, `float32ToBytes`, `bytesToFloat32`, `cosine`
  (storage-pglite.ts:544-582).** `cosine` is implemented locally but
  `cosineSimilarity` already exists in `packages/core/src/embeddings.ts:152`.
  Two implementations of the same metric, slightly different shape (the new
  one handles unnormalized vectors; the old one assumes pre-normalized).
  Worth either consolidating or commenting "pglite path can receive
  unnormalized vectors when the embedder adapter doesn't normalize, so we
  recompute denominators here".

- **Embedder cache + soft retry (`embeddings.ts:107-128`).** Existing
  pattern: lazy singleton + fail-soft retry. PR 5 layered a second cache
  (`adapterCache` in `embedders/index.ts:63`) without removing or unifying
  the older `embedPipeline` global. Two caches that hold the same kind of
  object. Recommend dropping `embedPipeline` and letting `getEmbedder(name)`
  be the only cache; the test-time `_resetEmbedderCache()` already exists.

- **Backend resolution (`index.ts:240-246`).** Mirrors the resolution
  pattern from `resolveEmbedderName()` (env → config → default) — same
  shape, different domain. Good reuse, but the two paths should be
  factored into a shared `resolveSetting<T>` helper if a third one ever
  lands. Not actionable for Sprint 0.

## Documentation Drift

- **README.md / CHANGELOG / CLAUDE.md vs new behavior.**
  - `packages/plur/CLAUDE.md:154-156` lists "Key files" including
    `packages/core/src/embeddings.ts | BGE-small-en-v1.5 local embeddings`.
    After PR 5 the active default is EmbeddingGemma. Update the table.
  - `packages/plur/CLAUDE.md:131-138` "Current numbers (v0.2.1)" still
    cites the pre-Sprint-0 LongMemEval/A-B numbers. v0.10 has new headline
    numbers (or will, post Phase C). Either update or stamp "as of v0.2.1".
  - `CHANGELOG.md:5-37` ("Unreleased / Sprint 0") cites the bake-off doc as
    evidence for the default flip — flag that the doc is N=5/category and
    Phase C is still pending so external readers don't take the numbers as
    final.
  - `packages/core/src/embeddings.ts:13-22` (file header) reads
    "Default model (Sprint 0 PR 5 / #219): EmbeddingGemma-300M ... the
    historical default (BGE-small-en-v1.5, 384d) is still available as
    `PLUR_EMBEDDER=bge-small`" — this is correct. The contradiction is at
    line 115-117 (see F-ARCH-005); reconcile the two.

- **storage-pglite.ts:99-101 PGLiteAdapterOptions docstring** says
  "default: 384 — BGE-small" while `DEFAULT_VECTOR_DIM = 768` (line 41).
  Drift across PR 2 → PR 5.

- **doctor.ts:577 fix-it advice** still names "BGE-small-en-v1.5
  download (~130MB)" — drifted from the new default
  (~325 MB EmbeddingGemma). User-visible CLI string.

- **Plan doc location.** The plan at
  `~/Data/5-plur/1-tracks/product/sprint-0-plan.md` is referenced from
  commit messages and CHANGELOG with a relative path
  (`../../../5-plur/1-tracks/product/sprint-0-plan.md` in PR descriptions)
  that does not resolve on GitHub. Future external auditors of the epic
  cannot follow the link.

- **No `docs/audit/sprint-0/iter-N.md` index doc.** The plan calls for
  per-iteration logs; this is iter-1-archivist.md, but no parent
  `iter-1.md` consolidator file exists yet. Expected before iter-2 starts.

- **ADR-0001 still says "Status: Accepted" with SQLite dropped.** Code
  ships with sqlite as the default backend. Either:
  - Update ADR-0001 with a v3 status: "Accepted, deferred default to v0.11
    behind compatibility flag", citing the v0.10 migration note; or
  - Flip the default to pglite (preferred — ADR-0001 is locked
    institutional context, not a draft).

  This is the highest-leverage doc/code reconciliation in the audit.
