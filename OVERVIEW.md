# PLUR monorepo

*Last updated: 2026-08-03*

## Purpose

`@plur-ai/core`, `@plur-ai/mcp`, and `@plur-ai/claw` — the engram memory engine and its MCP/OpenClaw wrappers, plus CLI, Hermes, and Python/LangChain adapters. Persistent, composable memory for AI agents: an agent corrected on Monday remembers on Tuesday, across sessions and tools. YAML is always the source of truth; search is fully local (BM25 + BGE embeddings + RRF), zero API calls in core. For the full package table, dependency graph, and version-bump checklist, see `CLAUDE.md` — this file is decisions, pitfalls, and orientation for someone picking the project up cold.

## Architecture

pnpm monorepo, seven packages (four npm, three PyPI) — see `CLAUDE.md` for the dependency graph. The load-bearing abstraction as of 0.16–0.17 is `PrimaryStore` (persistence) split from `StorageAdapter` (query index), so a row-backed store (Postgres, etc.) can plug in without `Plur` knowing where its engrams live — see `docs/adr/ADR-0003-primary-store-capability.md`, which now covers both the read path (0.16) and the write path (0.17.1, #827/#828).

## Key Decisions

| Decision | Rationale |
|----------|-----------|
| `PrimaryStore` split from `StorageAdapter` (ADR-0003) | A row-backed store needs its own persistence contract distinct from the query index — the split lets core stop hard-coding "the source of truth is a YAML file at this path." |
| Optional store capabilities gated as *sets*, not individual methods | A store either implements a whole fallback-sharing group or none of it. Partial implementation of a shared-state group silently turns a targeted optimization into a full-corpus write — see Pitfalls. |
| Cross-scope recurrence intentionally skipped when dedup is delegated to a store | `findActiveByContentHash` is scope-bound by contract; answering the cross-scope check (#176) would disclose another tenant's engram. Deliberate trade-off, documented in ADR-0003's 2026-08-03 amendment and the 0.17.1 CHANGELOG entry. |

## Pitfalls

- **A capability check on a pair misses a five-member set**: `loadByIds`+`updateMany` are checked together (#749) because a targeted read feeding a whole-corpus write deletes the corpus if only one side ships. The write-path seams (#827/#828) needed `findActiveByContentHash` + `nextEngramId` + `append` + `updateMany` + `loadByIds` checked as one set — when several fallbacks share "the thing in hand," gate the whole set or none of it.
- **A scope-bound lookup silently disables the feature built on the wider query**: `findActiveByContentHash(hash, scope)` cannot answer the cross-scope recurrence check (#176) by design — it would disclose another tenant's engram if it did. Any store implementing the dedup seam loses that feature's primary-store half without an error; it's a deliberate trade-off, not a bug, but it has to be documented at every layer (JSDoc, call site, ADR, CHANGELOG) or it gets "discovered" later as a regression.
- **A latency assertion is not a structural assertion**: "zero full-corpus loads" is the right acceptance test; a timing threshold for the same claim will flake. If you build a counting spy store, don't layer it on an existing store whose "targeted" methods call `load()` internally — the counter will report a full load per query and prove nothing.
- **A benchmark nobody runs rots silently**: `benchmark/micro.ts` was broken on main since #794 hardened the YAML loader (it seeds `engrams.yaml` with a bare `[]`, which the loader now refuses). Nothing failed CI because nothing runs it in CI — always baseline on main before attributing a benchmark break to your own change.
- **`release.sh` step 5b can false-positive on npm propagation lag**: `npx` returning `ETARGET` after all 6 retries doesn't always mean the publish failed — `npm view` may already show the version live under the `@next` dist-tag. Verify by hand before burning a version number on a "fix." Recovery documented in `RELEASING.md`; this has now happened twice (0.14.0, 0.17.1) — treat a third occurrence as a signal to fix the retry logic itself.

## Getting Started

See `CLAUDE.md` §Development for install/build/test, and `RELEASING.md` for the publish procedure. Before touching the store layer, read `docs/adr/ADR-0003-primary-store-capability.md` in full — it's the single most load-bearing design doc in the repo right now.
