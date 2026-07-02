# ADR-0002: Derived-state provenance — history JSONL is source of truth for observational events

Status: **Accepted**
Date: 2026-07-02
Authors: graph-upgrade assessment (#225 review) + #452 implementation
Related: ADR-0001 ([#226](https://github.com/plur-ai/plur/issues/226)), #200, #201, #202, #452

> ADR-0001 lives as GitHub issue [#226](https://github.com/plur-ai/plur/issues/226); this is the first ADR checked into the repo. New ADRs go in `docs/adr/`.

## Context

ADR-0001 established **YAML as the interoperability layer**: the database (PGLite/Postgres + pgvector + AGE) is always rebuildable from engram YAML, and the YAML-first write order makes "in DB but not in YAML" a forbidden state.

The graph program (#200/#201) needs **derived edges** — above all `co-fires-with` counts — whose raw data is not engram state but *observations*: which engrams were injected together (`co_injection`), and what feedback verdict followed (`injection_outcome`). Since #452 these land in `history/YYYY-MM.jsonl`, next to the existing lifecycle events (created/updated/feedback/contradiction).

That raises the question ADR-0001 doesn't answer: are history JSONLs source of truth for derived edges, or must derived state be rebuildable from engram YAML alone?

## Decision

**Two truth stores, split by kind. Engram YAML remains the sole source of truth for semantic state (what is believed). History JSONL is the append-only source of truth for observational events (what happened). Derived edges — co-fire counts, injection-outcome labels — are rebuilt from history JSONL, and are NOT required to be rebuildable from engram YAML alone.**

Concretely:

- The AGE graph's derived edges are a **pure function of history JSONL** (plus engram YAML for node existence). `plur rebuild` reconstructs the full database from `engrams.yaml + history/*.jsonl`.
- Observational events are **never folded back into engram YAML** as counters. The existing `co_accessed` associations in YAML stay what they are: a lossy, capped (5 per engram), online cache — not provenance.
- Derived edges are **never promoted to facts**: nothing derived from history may overwrite engram statements, scopes, or status.

### Why not "rebuildable from YAML alone"

1. **Category error.** Co-injection is an event stream with temporal structure. A count stored in YAML is a destructive aggregation — temporal-replay self-labeling (#202) needs the timeline (which injection, which query context, what happened after), which no YAML counter can carry.
2. **Write amplification on the read path.** Folding co-fire counters into YAML would turn every inject — a read — into a locked write across every injected engram file. The injection hot path must stay read-only.
3. **Scale shape.** Co-fire data is O(pairs); engram YAML is O(engrams). Pair data in per-engram files bloats the human-readable layer that ADR-0001 deliberately keeps small and portable.

### Why this preserves ADR-0001's invariant

ADR-0001's invariant is, in substance: *the database is always disposable, because truth lives in durable, portable, human-readable files*. History JSONL has exactly those properties — append-only plain text, one JSON object per line, monthly files. This ADR **refines the truth set** from {engram YAML} to {engram YAML (semantic state)} ∪ {history JSONL (observational events)}; the database remains fully derived and disposable. The forbidden state generalizes accordingly: nothing may exist only in the database.

## Consequences

### Positive

- #200/#201's co-fire edges get a durable, replayable data source; edge derivation is deterministic and re-runnable as the algorithm evolves.
- #202's temporal replay can consume raw `co_injection`/`injection_outcome` events without a schema migration.
- Injection stays read-only on engram YAML.

### Negative

- `history/` is now load-bearing: backup/sync scope must include it (previously it was "nice to have" audit data). Losing history loses derived edges — acceptable degradation (ranking signal, not knowledge; edges regrow from new observations), but it must be a documented one.
- Two truth stores mean rebuild reads two sources; `plur rebuild` docs/help must say so.

### Neutral

- Growth is bounded and small: measured ~325 B (5 ids) to ~625 B (20 ids) per co_injection, ~170 B per outcome; at ~50 sessions/day that is under ~1 MiB/month of JSONL.
- If monthly files ever become a scan burden, compaction may summarize months older than a retention window into derived snapshots — permitted as long as snapshots are themselves in files, not only in the database.

## Changelog

- 2026-07-02 v1 — **Accepted** with #452 (co_injection / injection_outcome logging).
