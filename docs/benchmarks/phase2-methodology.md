# Local-first AI memory: Phase 2 benchmark methodology

**Status:** Draft. Scaffold only — fairness decisions proposed, harness code not yet written. Tracks [issue #46](https://github.com/plur-ai/plur/issues/46).

**Last updated:** 2026-04-23 (initial scaffold).

## Why this document exists

Phase 1 (the [feature matrix](./feature-comparison.md)) answered *what the category ships*: cell-verified, link-cited, `?` where unknown. Phase 2 answers *how well each system performs under identical conditions*. That needs an actual harness — one any reader, including upstream maintainers, can re-run to reproduce or contest our numbers.

This document is the protocol. The harness implements it. The results page publishes what comes out. All three live in [`docs/benchmarks/`](./) and [`benchmarks/phase2/`](../../benchmarks/phase2/) (pending).

## Scope

### In scope
- Systems with a programmatic surface (first-party MCP server, SDK, or CLI) — 13 of 15 from Phase 1 qualify.
- Same input corpus + same question set across all systems.
- Fair defaults: each system runs in its own recommended configuration. No tuning against the benchmark.
- Three axes: retrieval accuracy, retrieval latency, footprint.

### Out of scope (explicit)
- Subjective UX / developer-experience comparisons.
- LLM-judge scoring for long-form answers (tracked separately in `datacore-bench`).
- Cloud tiers of Mem0, Letta, Zep (Phase 1 is a local-first comparison — see [feature-comparison.md → cloud tier narrative](./feature-comparison.md)).
- Systems without any programmatic interface (e.g. Claude Code built-in memory).

## The three axes

### 1. Retrieval accuracy

**Metric:** LongMemEval-style oracle — question → expected supporting memory ID. Reported per category (single-session, preferences, multi-session, temporal, updates, assistant facts) and overall.

**Corpus:** LongMemEval public set as primary. We also define a 30-question sanity subset (same category distribution) for fast iteration during harness development.

**Top-level numbers reported:**
- `overall@10` — fraction of questions where the expected memory is in the top-10 returned.
- `hit@10` per category (6 categories).
- `mrr@10` — mean reciprocal rank, top-10 window.

**PLUR baseline:** v0.2.1 achieves LongMemEval 86.7% overall, Hit@10 93.3% (Opus hybrid, n=30 sanity subset). The harness must reproduce this within 3 pp before we publish anyone else's numbers. See [self-calibration gate](#self-calibration-gate) below.

### 2. Retrieval latency

**Metric:** wall-clock time from query submission to top-10 results returned. Reported as p50 / p95 / p99 across a warm-cache run of ≥1000 queries.

**Corpus sizes:** 100, 1 000, 10 000 engrams. The 10k point is where local-first systems typically start to diverge.

**Exclusions:** model-inference time for systems that do LLM synthesis at query time (e.g. Google Always-On Memory Agent's QueryAgent) is reported separately and not mixed with pure retrieval latency. The headline latency number is the retrieval primitive only.

**Cold-start:** reported as a secondary number (single measurement, first query after fresh process start). Interesting but noisy; not the headline.

### 3. Footprint

**Metric:** steady-state RSS (resident set size) and on-disk size after ingestion of the fixed corpus, measured after a 10-minute idle period.

**Corpus sizes:** same 100 / 1 000 / 10 000 engram tiers.

**RSS measurement:** `ps -o rss=` on the primary process, Linux. For containerized systems, sum of all processes in the container.

**On-disk measurement:** `du -sb` on the data directory after `fsync` (or equivalent flush). Does not include binary install size (that's a separate metric we don't report — it inflates with language runtimes in ways orthogonal to memory-system design).

## Fairness constraints

These are the five blocking questions from issue #46, with proposed decisions. **Each decision below is a proposal to be ratified before any results are published.** Mark each resolved / deferred in the issue.

### F1. Embedding parity — proposed: Option (a), defaults

Each system uses its own recommended default embedding (PLUR: BGE-small-en-v1.5 local; Mem0 / Graphiti / Hindsight: OpenAI `text-embedding-3-small`; etc.), clearly labelled in the result row.

**Reasoning:** option (a) reflects what users actually run. Forcing a common embedding (option b) adds a per-system reconfiguration cost that most maintainers would contest as "that's not how we ship." The default configuration is the thing worth comparing for a local-first user picking a tool off the shelf.

**Implication:** embedding-model choice is a *feature* of each system, not a confound. We publish the model name alongside the accuracy number.

**Open question:** for systems that can run either local or OpenAI-backed embeddings (MemOS, MCP Memory Service), we default to the local option to preserve local-first comparison integrity. This will be documented per-system.

### F2. Hardware — proposed: modest consumer laptop

Target spec:
- CPU: modern x86_64, ≥8 physical cores (representative: AMD Ryzen 7 / Apple M2 / Intel i7 13th gen).
- RAM: 16 GB.
- Disk: NVMe SSD.
- GPU: none required. Systems that can use a GPU run in CPU mode for parity.
- OS: Linux x86_64 (Ubuntu 22.04 LTS or later). macOS Apple Silicon results welcome as a secondary table; not the headline.

**Reasoning:** local-first means it runs on the user's laptop. 16 GB is the median working-developer spec as of 2026. A 32 GB / GPU tier might be added later but is not the headline.

**Publication:** the exact machine used for the published run is recorded in `phase2-results.md` (`CPU model`, `RAM`, `kernel`, `arch`). Any reader with comparable hardware should reproduce within noise.

### F3. Corpus construction — proposed: LongMemEval public, preprocessing documented

LongMemEval ships a corpus. Not all systems ingest it cleanly — some expect one-user-per-session, some expect raw turns, some consume a custom JSON. Per-system ingestion adapters live in `benchmarks/phase2/systems/<slug>/ingest.{py,ts,sh}`. Each adapter is the smallest faithful mapping from LongMemEval's format to the system's ingest API.

**Where preprocessing meaningfully biases a result** (e.g. concatenating turns into single memories vs. keeping them separate), the bias is called out in the results table next to the number.

**Open question:** do we inject user/agent metadata that LongMemEval carries (speaker, session id) into every system, or only into systems that have a first-class home for it? Proposed: inject where supported, document where dropped. Flag accuracy impact if material.

### F4. Query-time parity — proposed: top-k=10 default, document exceptions

Same `k=10` across all systems where configurable. Systems that don't expose `k` (they return a fixed-size set or an LLM-synthesized answer) are reported as-is, with the effective result count noted.

**LLM synthesis systems:** Google Always-On Memory Agent and similar — we measure the retrieval step only (which candidates were considered), not the final synthesized answer. If the system does not expose a pre-synthesis retrieval set, it is reported as `n/a` on accuracy and benchmarked for latency/footprint only.

### F5. Self-calibration gate — proposed: 3pp, published first, fix-harness-before-publish-others

Before any competitor number is published:

1. Run the harness against PLUR v0.2.1 with Opus hybrid on the 30-Q sanity subset.
2. Compare the harness-measured overall accuracy to the prior independent Opus-hybrid measurement (86.7% overall, 93.3% Hit@10, see `docs/reports/longmemeval-v0.2.1.md` *(pending — write-up of the existing measurement needs to land)*).
3. If the harness number is within **3 pp** of the prior number on overall accuracy, the harness is considered calibrated. Publish.
4. If the harness number diverges by **>3 pp**, the harness is broken. Fix the harness — do *not* publish any competitor row until calibration holds.

**Reasoning:** if the harness can't reproduce our own number, it can't reproduce anyone else's either. Self-calibration gate is the single most important fairness rule.

**Implication:** the first PR that adds the harness scaffold must include the PLUR row. Competitor rows are separate PRs that land after calibration is green.

## Version pinning

Every measured system has a pinned version in `benchmarks/phase2/systems/<slug>/VERSION`. Format: `slug@<git-sha-or-semver>` plus the date pulled. Dockerfiles install from the pinned version; no `latest` tags.

Where a system exposes a model choice (embedding model, LLM for synthesis), the model name + version is in the same `VERSION` file.

When a new version ships upstream, we re-measure and publish both numbers (old + new) with a note. Old rows are not overwritten silently.

## Reproduction

### Single entrypoint

```
make bench SYSTEM=plur CORPUS=longmemeval
make bench SYSTEM=mem0 CORPUS=longmemeval
make bench SYSTEM=all   CORPUS=longmemeval  # runs every pinned system
```

Each invocation produces:
- `benchmarks/phase2/results/<system>/<corpus>/<timestamp>/results.json` — raw per-query results.
- `benchmarks/phase2/results/<system>/<corpus>/<timestamp>/summary.csv` — per-category accuracy + latency percentiles + footprint.
- `benchmarks/phase2/results/<system>/<corpus>/<timestamp>/env.json` — machine + version + model-id fingerprint.

### Publication flow

1. Harness produces `summary.csv` + `env.json`.
2. A row in `docs/benchmarks/phase2-results.md` is generated from the CSV. Same cell-source discipline as Phase 1 — every cell links to the `results.json` path in the repo.
3. Maintainer-corrections invitation template (reuses Phase 1 close-out action #2) carries the reproduction command for that specific system.

## Deliverables checklist (mirrors issue #46)

- [x] `docs/benchmarks/phase2-methodology.md` — this document (draft).
- [ ] Fairness decisions F1–F5 ratified in issue #46 comments.
- [ ] `benchmarks/phase2/` harness scaffold: Dockerfile template, shared runner, shared scorer.
- [ ] PLUR baseline row published (self-calibration gate passes).
- [ ] ≥ 3 competitor systems measured (suggest: Mem0, Hindsight, Basic Memory — covers vector / graph / markdown axes).
- [ ] Maintainer-corrections invitations sent for each measured system.

## Open questions / TBD

The following decisions are proposed above but not yet ratified:

- F1: defaults-per-system over common-embedding. Open for a week; close 2026-05-01 unless contested.
- F2: 16 GB Linux x86_64 laptop headline; macOS secondary. Open for a week.
- F3: per-system ingestion adapters, document meaningful bias. Needs a concrete example to be ratifiable — defer ratification to first competitor ingest PR.
- F4: k=10 default. Open for a week.
- F5: 3 pp gate. Open for a week.

Additional open items that are **not** ratifiable yet:

- **PLUR v0.2.1 reference write-up** — the 86.7% / 93.3% number needs its own doc (`docs/reports/longmemeval-v0.2.1.md`) before we can gate the harness against it. Currently the number lives in `CLAUDE.md` only.
- **LongMemEval licensing** — public set is [CC-BY-NC-4.0](https://github.com/xiaowu0162/LongMemEval); we can redistribute a processed derivative with attribution but not commercialize. Doc required.
- **Funding the external-LLM runs** — agentic-mode competitor runs (Letta, LangMem, some Mem0 configs) call OpenAI / Anthropic. Flag against CTO budget when those land; out-of-scope for the scaffold PR.

## Non-goals (restating for clarity)

Phase 2 is not a marketing exercise. Results that make PLUR look worse on an axis are published same as results that make it look better. The purpose is a credible shared substrate for the category — useful to us *because* it's useful to everyone.
