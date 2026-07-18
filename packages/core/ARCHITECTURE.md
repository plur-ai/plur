# Architecture

`@plur-ai/core` is the engram engine — the in-process library that stores,
searches, decays, and injects engrams. No network, no auth, no tools — just
the data model and the algorithms.

For the user-facing intro see [README.md](README.md). For the MCP wrapper
see [`packages/mcp`](../mcp). For dev workflows see the monorepo
[CLAUDE.md](../../CLAUDE.md).

## The shape, in one paragraph

A single `Plur` class wraps an `EngramStore` (YAML or SQLite, plus optional
remote stores) and exposes `learn`, `recall*`, `inject`, `feedback`, `forget`,
`sync`, `installPack`, `capture`, `timeline`, `status`. Engrams are validated
through Zod schemas, indexed by an in-memory BM25 (`fts.ts`) and an optional
local embedding model (`embeddings.ts` — BGE-small-en-v1.5 via
`@huggingface/transformers`); hybrid search merges them via Reciprocal Rank
Fusion. Activation/decay tracking (`decay.ts`) is ACT-R inspired —
strength, frequency, last_accessed — and runs on read. Storage is plain YAML
on disk by default; the persistent state IS the source of truth, the indices
are caches you can blow away.

## Top-level layout

```
src/
├── index.ts               # Plur class — public API surface (~1450 lines, the spine)
├── types.ts               # Shared type aliases
├── logger.ts              # pino-style debug logger
│
├── schemas/               # Zod schemas — single source of truth for data shapes
│   ├── engram.ts          # Engram (with activation, temporal, entities, dual-coding)
│   ├── episode.ts         # Session timeline events
│   ├── meta-engram.ts     # Engrams about engrams (patterns across patterns)
│   ├── pack.ts            # Shareable engram bundles
│   ├── capsule.ts         # Self-contained engram + context for transfer
│   └── config.ts          # User config (stores list, search config, sync settings)
│
├── store/                 # Persistence backends
│   ├── types.ts           # EngramStore interface (what every backend implements)
│   ├── factory.ts         # createStore() — picks YamlStore or SqliteStore
│   ├── yaml-store.ts      # Default — plain YAML file, atomic write via tmp+rename
│   ├── sqlite-store.ts    # Optional — better-sqlite3 backend for scale
│   ├── remote-store.ts    # Talks to a PLUR Enterprise /api/v1/engrams server
│   ├── async-fs.ts        # AsyncFs — promisified fs with single-file write lock
│   └── async-lock.ts      # In-process mutex
│
├── storage.ts             # Legacy single-file YAML helpers (still used by tests)
├── storage-indexed.ts     # SQLite secondary index over engrams for fast load
├── storage-pglite.ts      # PGLite (WebAssembly PostgreSQL) storage layer
│
├── # — search layer —
├── fts.ts                 # In-memory BM25 over enriched engram text
├── embeddings.ts          # BGE-small-en-v1.5 local embeddings + cosine
├── hybrid-search.ts       # RRF: merge BM25 + embedding ranks
├── agentic-search.ts      # LLM-assisted reranking (recallAsync)
├── query-expansion.ts     # LLM expands one query → N variants (recallExpanded)
├── search-orchestrator.ts # Picks the right pipeline for the asked mode
├── fresh-tail.ts          # "Always include the last N" — anti-recency-bias
│
├── # — decision layer —
├── inject.ts              # Context-aware engram selection inside a token budget
├── decay.ts               # ACT-R activation update on each read; pruning
├── confidence.ts          # Heuristics for "how sure are we about this engram"
├── quality.ts             # Quality gates for new engrams (length, novelty, etc.)
├── dedup.ts               # Near-dup detection on learn()
├── content-hash.ts        # Stable hash for de-dup
├── conflict.ts            # Detects contradictions between engrams
├── polarity.ts            # do/don't polarity inversion detection
├── trust.ts               # Source trust scoring
│
├── # — lifecycle —
├── engrams.ts             # CRUD helpers (lower-level than Plur class)
├── episodes.ts            # Episodic timeline (capture / timeline)
├── learn-async.ts         # Background-promoted learning queue
├── history.ts             # Append-only log of engram changes
├── session-state.ts       # Per-session state (recent recalls, etc.)
├── packs.ts               # Pack export/install/discover
├── sync.ts                # Git-based sync between machines
├── profile.ts             # Per-user / per-agent profile preferences
│
├── # — bridges —
├── meta/                  # Meta-engram extraction (engrams about engrams)
├── migrations/            # Schema migrations on load
├── secrets.ts             # Redact secrets from learn() input
├── guardrails.ts          # Refuse to learn certain patterns (PII, etc.)
├── version-check.ts       # Auto-migrate older on-disk formats
├── model-routing.ts       # Pick LLM provider for async/expanded modes
└── summary.ts             # Summarise long engrams
```

## The Engram schema

The engram is the atomic unit. Defined in `src/schemas/engram.ts`. Every
field is validated by Zod — invalid engrams are refused at the boundary,
not silently coerced.

A minimal engram (everything optional defaults applied):

```yaml
id: ENG-2026-0506-001
statement: "toEqual() in Vitest is strict — use toMatchObject() for partial matching"
type: behavioral
status: active
scope: project:my-app
domain: dev/testing
created_at: 2026-05-06T08:30:00Z
```

A fully-realised engram has:

- **Activation** (ACT-R): `retrieval_strength`, `storage_strength`,
  `frequency`, `last_accessed` — drives decay and ranking
- **Temporal**: `learned_at`, `valid_from`, `valid_until` — bi-temporal,
  Zep-inspired
- **Entities**: structured refs (person/org/tech/concept/...) with optional URI
- **Knowledge type**: `memory_class` ∈ {semantic, episodic, procedural,
  metacognitive} × `cognitive_level` ∈ Bloom's taxonomy
- **Dual coding**: `example` and/or `analogy` — improves recall accuracy
- **Relations**: `broader`/`narrower`/`related`/`conflicts` — the graph
- **Provenance**: `origin`, `chain`, `signature`, `license` — for sharing
- **Feedback**: `positive`/`negative`/`neutral` counts — drives quality

When adding a field: add to Zod schema, add a migration in `migrations/`
if loading old data needs adapting, update tests. **Do not add fields
without a clear retrieval or decision use** — every field becomes
forever-load-bearing once written to user disks.

## Storage architecture

```
                    Plur (in-memory)
                         │
                         ▼
                   EngramStore                 — interface (load/save/append/getById/remove/count/close)
                   ┌─────┴──────┬───────────────┐
                   ▼            ▼               ▼
              YamlStore     SqliteStore    RemoteStore
              (default)     (optional)     (PLUR Enterprise)
                   │            │               │
            ~/.plur/         ~/.plur/      https://plur.datafund.io
            engrams.yaml     engrams.db    /api/v1/engrams
```

### YAML is the source of truth

`YamlStore` (in `src/store/yaml-store.ts`) writes the entire engram array
on every save. Atomic via tmp+rename. **The on-disk YAML is
human-readable and human-editable** — open it, version it with git, share
it with a teammate. Every other layer (BM25 index, embeddings cache) is a
derived cache that can be rebuilt from the YAML.

### Multi-store composition

`Plur` can hold a primary store plus N additional stores (configured via
`config.yaml`'s `stores` list, or `plur_stores_add`). Each store has:

- `path` OR `url` (mutually exclusive — see `StoreEntrySchema` in
  `schemas/config.ts`)
- `scope` — only engrams for this scope are ever read from that store
- `shared`: bool — whether engrams here are visible to other agents
- `readonly`: bool — refuses writes

This is the mechanism that lets a local PLUR install attach to a remote
PLUR Enterprise — `RemoteStore` is just another `EngramStore` impl.

### RemoteStore

`src/store/remote-store.ts`. Talks HTTP to `/api/v1/engrams` of a PLUR
Enterprise server. Critical properties:

- **Never throws on network failure** — returns empty array, lets the
  rest of the system continue working
- **60-second TTL cache** — successive `load()` calls within 60s reuse
  the cached page (paginated load fetches all pages in one go)
- **In-flight dedup** — concurrent loads share a single network request
- **save() throws** — RemoteStore is append-only; full-array overwrites
  are not legal across the network. `append()` is the only write path.
- **Schema reshape** — the server wraps each engram as `{id, scope, data: {...}}`;
  RemoteStore unwraps to flat Engram shape on read

## Search architecture

Five `recall*` modes, all available from a single `Plur` instance:

| Mode | Pipeline | Cost | Latency |
|---|---|---|---|
| `recall(query)` | BM25 only | $0 | <10ms |
| `recallSemantic(query)` | embeddings + cosine | $0 | ~200ms |
| `recallHybrid(query)` | BM25 + embeddings → RRF | $0 | ~200ms |
| `recallAsync(query, {llm})` | hybrid + LLM rerank | 1 LLM call | ~1s |
| `recallExpanded(query, {llm})` | LLM expand → 3-5 hybrid → RRF | 3-5 LLM calls | ~3s |

`recallHybrid` is the default for a reason: it dominates the
[LongMemEval benchmark](https://plur.ai/benchmark.html) at zero cost.
Single-mode is only better when you know your queries are pure-keyword
(use `recall`) or pure-semantic with no good keywords (`recallSemantic`).

### BM25 (fts.ts)

In-memory inverted index over enriched engram text:
`statement + entities + tags + dual-coding example + analogy`. Recomputes
on every load — cheap because the corpus is in the thousands, not
millions. If that ever stops being true, persisting the index is a
one-file change.

### Embeddings (embeddings.ts)

BGE-small-en-v1.5 via `@huggingface/transformers`. Lazy-loaded — the
~30MB model only initialises when an embedding mode is first called.
Embeddings are cached per-engram in `~/.plur/embeddings.cache` keyed by
content hash; recomputed on engram update.

`@huggingface/transformers` is an **optional** peer dep. If it's not
installed, `recallSemantic` and `recallHybrid` log a warning and fall
back to BM25-only.

### RRF (hybrid-search.ts)

Reciprocal Rank Fusion: each engram gets a score `Σ 1/(k + rank_in_list)`
across BM25 and embeddings rankings (k=60 by default — see
[Cormack 2009](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)).
Cheap to compute, robust to score-scale differences between BM25 and
cosine.

## Injection algorithm (inject.ts)

`plur.inject(task, options)` is what runs at session start. Given a task
description and a token budget, it returns the best engrams to put in
the system prompt.

Stages:

1. **Scope filter**: only consider engrams in `options.scopes` (defaults
   to all readable scopes)
2. **Hybrid recall** against the task description
3. **Spreading activation**: for each top hit, also pull in engrams
   linked via `:related:` / `:broader:` (depth-limited)
4. **Quality gate**: drop engrams below confidence threshold
5. **Conflict resolution**: when two engrams contradict (`:conflicts:`
   relation, or auto-detected polarity inversion), pick the most-recent
   higher-confidence one
6. **Fresh tail**: prepend the last N learned engrams in this scope —
   counters the recency bias of pure relevance ranking
7. **Token-budget pack**: greedy-fill within `budget`, structured as
   `directives` (high-confidence) + `also consider` (lower-confidence)

Output is a structured object with `directives`, `consider`,
`tokens_used`, `injected_ids` — the IDs are what `feedback()` will rate.

## Decay and activation (decay.ts)

ACT-R inspired:

```
strength_t = base + Σ_i 1/sqrt(time_since_access_i)
```

On every read of an engram, `last_accessed` updates to now and `frequency`
increments. Engrams that aren't read for a long time decay; those used
often stay strong. `forget()` is graceful retirement (status → `retired`)
not deletion — history is preserved.

Decay runs lazily on read, not on a cron: effective strength is
`decayedStrength(stored, daysSince(last_accessed))`, computed per candidate at
inject time, and reinforcement re-anchors `last_accessed` on access. There is no
scheduled decay job — a prior `batchDecay()` that materialized decay back into
the store was removed (2026-07-14): it was redundant with the read-time model
and double-counted (it lowered stored strength without advancing
`last_accessed`), and rewriting the whole store on a schedule was a data-loss and
provenance hazard. If physical archival of long-cold engrams is ever needed it
should be an explicit, reversible, logged maintenance op — not a cron.

## Sync (sync.ts)

Git-based. The user's `~/.plur/` is a git repo (or pointed at one). The
`sync()` op is roughly:

1. `git pull --rebase` (with conflict resolution — engrams that diverged
   merge by feedback-count + last-accessed)
2. `git add . && git commit` if local changes
3. `git push`

YAML diffs cleanly because engrams are stored as ordered keys. The
secondary indices (SQLite, embeddings cache) are gitignored — they
rebuild on first load.

For multi-user (real teams), use PLUR Enterprise instead of git sync.

## Pack system (packs.ts)

A pack is a YAML file + a manifest, exportable from one user's engrams
and installable into another's. Used to share curated knowledge — e.g.
the `dips-v1` pack is 747 engrams about Datacore conventions.

```
plur.exportPack(engramIds, '/tmp/my-pack', { name, version, license })
plur.installPack('/path/to/pack.yaml')
```

Installed packs are mounted as additional stores at a pack-specific
scope, so they don't pollute the user's primary engram set.

## Quality, dedup, conflict, polarity

- `quality.ts` — gates new engrams on length, novelty, presence of
  context. Failing engrams go to `candidates.yaml` for later review.
- `dedup.ts` — content-hash + fuzzy match against existing engrams; on
  match, reinforces the existing engram's `frequency` instead of
  creating a new one
- `conflict.ts` — detects pairs that contradict; flags but does not
  auto-resolve
- `polarity.ts` — "always X" vs "never X" detection; surfaces a
  contradiction even when worded differently

These run inside `learn()`. Bypassing them means writing engrams via the
lower-level `EngramStore` directly — only do that for migrations or
import.

## Optional dependencies

| Package | What it enables | Without it |
|---|---|---|
| `@huggingface/transformers` | Local embeddings | `recallSemantic`/`recallHybrid` warn + fall back to BM25 |
| `better-sqlite3` | SQLite store backend | YAML-only |

Both are real optional deps in `package.json`. Production builds (the
plur.ai docker images, PLUR Enterprise) include them; minimal CLI users
can skip the ~50MB transformers download.

## What's NOT here

Things that look like they should exist in core but don't, with reasons:

- **No auth, no users, no scopes-as-permissions** — `scope` here is just
  a string for organisation. Per-user access control is PLUR Enterprise.
- **No HTTP server** — that's `@plur-ai/mcp` (MCP/SSE) and PLUR
  Enterprise (REST/admin)
- **No tool definitions** — `learn`/`recall`/etc. are JS methods. The
  MCP tool wrappers live in `@plur-ai/mcp`
- **No LLM client** — `recallAsync` and `recallExpanded` accept an `llm`
  callback. Core never imports an SDK. `model-routing.ts` is just
  configuration plumbing.
- **No background scheduler** — decay, dedup, sync are all explicit
  operations. The host (MCP, claw, enterprise) decides when to run them.

## How this fits with the rest of PLUR

```
@plur-ai/core      — engram engine (this package)
   │
   ├── used by @plur-ai/mcp        — wraps Plur as MCP tools
   ├── used by @plur-ai/claw       — wraps Plur as OpenClaw plugin
   └── used by plur-ai/enterprise  — wraps Plur as multi-user HTTP server
                                     (also: enterprise's RemoteStore is
                                      core's RemoteStore — same module)
```

Anything inherently single-user, in-process, and content-related
belongs here. Anything multi-user, network, or auth belongs in
`plur-ai/enterprise`. Anything that's a transport adapter (MCP, OpenClaw)
belongs in its own package.

## See also

- [README.md](README.md) — public-facing intro and full method table
- [../../CLAUDE.md](../../CLAUDE.md) — monorepo dev conventions
- [`packages/mcp`](../mcp) — MCP server adapter
- [`packages/claw`](../claw) — OpenClaw plugin adapter
- [`plur-ai/enterprise`](https://github.com/plur-ai/enterprise) — multi-user server
