# ADR-0003: Primary store capability — separating "the store" from "the index"

Status: **Accepted** — implemented in 0.16
Date: 2026-07-26
Authors: convergence programme, Phase 1
Related: ADR-0001 ([#226](https://github.com/plur-ai/plur/issues/226)), ADR-0002, `1-tracks/dev/2026-07-26-plur-convergence-plan.md`

## Context

A multi-tenant server deployment cannot currently run core's `Plur` class, so it
has to stand up a parallel implementation of the memory engine and share only a
few primitives with `@plur-ai/core`. Two consequences follow: core's retrieval
improvements never reach that deployment, and the published benchmarks
(LongMemEval Hit@5 90%) measure *core*, saying nothing about what such a
deployment actually serves.

The convergence plan closes that split. Its Phase 1 — this ADR — is the piece
everything downstream waits on.

### The blocker, precisely

`StorageAdapter` is named like a storage interface but is an **index**
interface. Its vocabulary gives it away:

```ts
/** Apply a YAML-to-index delta (incremental). */
syncFromYaml(): Promise<void>
/** Drop the index and rebuild from YAML. */
reindex(): Promise<void>
```

Both methods were **required**. Both encode "YAML owns the data; this backend is
a derived cache". A Postgres backend that *is* the source of truth cannot honour
either — there is no YAML to sync from and nothing to rebuild out of.

Worse, the `Plur` class did not go through any storage abstraction for its own
state. It called `loadEngrams(this.paths.engrams)` at 35 sites and
`saveEngrams(...)` at 3 more (plus 2 in `learn-async.ts`), so "the source of
truth is a YAML file at this path" was hard-coded into the caller, not into a
swappable component.

## Decision

**Split the two concerns into two interfaces, and let the adapter declare which
side of the split it is on.**

### 1. `PrimaryStore` — the new persistence seam

`packages/core/src/store/primary-store.ts`:

As shipped in 0.16 (Phase 1 introduced this seam synchronously; Phase 2b made
it asynchronous — see the amendment at the end of this ADR):

```ts
export interface PrimaryStore {
  readonly kind: PrimaryStoreKind          // 'yaml' | 'memory' | 'postgres' | …
  readonly location: string | null         // credential-free, safe to log
  load(): Promise<Engram[]>                // authoritative read, never cached
  loadCached(): Promise<Engram[]>          // cached read where the medium allows
  save(engrams: Engram[]): Promise<void>   // full replace, drops the read cache
  invalidate(): void

  // Optional capabilities. Absent = the caller falls back to the general path,
  // so a minimal store stays a valid store.
  withExclusiveAccess?<T>(fn: () => Promise<T>): Promise<T>  // ADR-0004
  updateMany?(engrams: Engram[]): Promise<void>              // targeted write
  loadByIds?(ids: string[]): Promise<Engram[]>               // targeted read
  estimateCount?(): number                                   // backend tiering
}
```

`YamlPrimaryStore` is the default and is a behaviour-preserving extraction of
what `Plur` did inline: `loadEngrams` for authoritative reads, the mtime-keyed
snapshot cache for hot reads, `saveEngrams` (atomic write) for persistence, and
cache invalidation on every write (#25 — on coarse-mtime filesystems a purely
mtime-driven cache can serve a pre-write snapshot).

`Plur` gained `new Plur({ path, store })`. Omit `store` and you get
`YamlPrimaryStore(paths.engrams)` — byte-for-byte the previous behaviour.

### 2. `StorageAdapter` — declares a role, rebuild methods become optional

```ts
export type StorageAdapterRole = 'index' | 'primary'

export interface StorageAdapter {
  readonly role: StorageAdapterRole
  syncFromYaml?(): Promise<void>   // derived indexes only
  reindex?(): Promise<void>        // derived indexes only
  // …loadFiltered / count / searchBM25 / searchVector / upsertEmbedding / close
}
```

Two helpers replace the old assumption that the methods exist:

- `requiresIndexSync(adapter)` — must a write to the store be followed by an
  index sync? False for `null` and for `role: 'primary'`.
- `asDerivedIndex(adapter)` — narrow to `DerivedIndexAdapter` (rebuild methods
  guaranteed present) or `null`.

`PGLiteAdapter` declares `role: 'index'`. Nothing else in the repo implements
the interface today.

## Why both, rather than one interface with a capability flag

The convergence plan left this open: "separate `StoreAdapter` interface, or
capability flag on `StorageAdapter`?" The answer is that the question contains a
false premise.

**`StorageAdapter` has no write methods. It never did.** There is no `save`,
`append`, `update` or `remove` anywhere on it. No capability flag can promote it
to a primary store, because the half you would be promoting does not exist. A
flag alone would produce an interface where `role: 'primary'` means "trust me,
some *other* code writes to the same database", which is precisely the implicit
coupling this phase exists to delete.

So: persistence gets its own interface, and the flag stays — but it does a
different, smaller job. `role` answers exactly one question, the one the old
design got wrong: **does a write to the source of truth leave this backend
stale?** For a derived index, yes; for a backend that IS the store of record,
no. That is what `requiresIndexSync()` encodes, and it is the only thing callers
need to branch on.

Phase 5's `PostgresAdapter` will implement **both**: `PrimaryStore` (async
successor, see below) for persistence and `StorageAdapter` with
`role: 'primary'` for querying — one class saying "my store and my query index
are the same engine".

## Why `PrimaryStore` is synchronous

Deliberately, and it is temporary.

Every `Plur` write path is synchronous today (`withLock` + `readFileSync`).
Converting them is Phase 2, kept separate on purpose: flipping ~20 methods to
async turns every `await` into an interleaving point and invalidates the
implicit atomicity the current code relies on (`_sessionScope`,
`_activeSessionId`, `autoDiscoverStores()`, the process-wide LLM circuit
breaker). Doing both at once would mean a large refactor with no clean bisect
point between "moved the seam" and "changed the concurrency model".

`PrimaryStore` is therefore shaped like the **existing** async `EngramStore`
(`store/types.ts`) minus the `Promise`s. Phase 2 becomes a mechanical
`sync → async` flip of one interface, not a rewrite of 40 call sites. A
network-backed store cannot satisfy the synchronous contract — which is why
Phase 5 lands *after* Phase 2, not before.

## Scope — what this phase does not touch

Deliberately out of scope, and why:

| Left alone | Reason |
|---|---|
| `packs.ts` YAML I/O | Operates on installed **pack directories**, not the primary store. Packs are YAML artifacts by definition. |
| `migrations/runner.ts` | Does file-level backup/restore around the migration. A non-file store needs a different migration mechanism entirely — a Phase 5 design question, not a Phase 1 mechanical move. |
| `IndexedStorage` (legacy SQLite) | Synchronous, does not implement `StorageAdapter`, and rebuilds itself from YAML by construction. It is unconditionally a derived index, so the role check is unnecessary on that branch. |
| `PGLiteAdapter` reading YAML by path | Correct for `role: 'index'` — a derived index must read the source of truth, and today that source is YAML. Teaching it to rebuild from an arbitrary `PrimaryStore` only matters once a non-YAML primary exists, i.e. Phase 5. |
| `withLock(paths.engrams, …)` | Still keyed on a filesystem path. Locking is Phase 2's problem; `learn-async.ts` now documents `engramsPath` as "lock key only". |
| Async write path | Phase 2. |
| Postgres adapter | Phase 5. |

## Folded-in hygiene

Downstream consumers pinning an older `@plur-ai/core` can move to current
safely: the shared data contract has been verified stable — `embed()` cosine
1.000000, `computeContentHash()` output identical, `EMBED_DIM` unchanged at 384.
But such a bump **fixes nothing functional**, and it is not a security fix
either: the advisories in that dependency tree declare identical version ranges
either side of it. Recorded here as hygiene belonging with this phase rather
than as a scheduled item of its own. The bump itself happens in the consuming
repository and is not part of this change.

## Consequences

### Positive

- `Plur` no longer knows where its engrams live. Phase 5 swaps a store; it does
  not edit 40 call sites.
- The YAML-owns-the-data assumption is now a *default*, not an invariant baked
  into the caller. ADR-0001 is unchanged for the single-user deployment: YAML
  remains the source of truth there, and `YamlPrimaryStore` is what makes it so.
- A caller can ask what it is persisting to (`plur.primaryStore.kind`) instead
  of assuming `engrams.yaml`.
- `MemoryPrimaryStore` makes "source-of-truth agnostic" testable rather than
  merely asserted, and is a legitimate choice for ephemeral or sandboxed
  sessions.

### Negative / accepted

- Core now has three storage-shaped interfaces: `PrimaryStore` (sync,
  source of truth), `EngramStore` (async, pre-existing, currently unused by
  `Plur`), and `StorageAdapter` (query). Phase 2 collapses the first two by
  making `PrimaryStore` async; until then the duplication is real. It is
  accepted because the alternative — adopting the async `EngramStore` now —
  forces the Phase 2 concurrency work into this phase.
- `role` is a required field on `StorageAdapter`, a compile-time break for any
  external implementor. `PGLiteAdapter` is the only implementor in-repo.

## Verification

- 2843 → 2878 tests pass; 0 failures; the suite baseline is unchanged apart from
  the 35 tests added here.
- `test/plur-source-of-truth.test.ts` runs the full learn → recall → feedback →
  forget cycle against `MemoryPrimaryStore` and asserts no `engrams.yaml` is
  created, plus a structural guard that `index.ts` and `learn-async.ts` contain
  zero direct `loadEngrams` / `saveEngrams` calls.
- `test/primary-store.test.ts` runs one shared contract suite against both
  implementations, so a Phase 5 store has something concrete to conform to.
- `test/storage-adapter-role.test.ts` pins `requiresIndexSync` /
  `asDerivedIndex` behaviour for both roles, including the malformed
  `role: 'index'` case.


## Amendment — 2026-07-28: the interface is asynchronous

This ADR was written with a synchronous `PrimaryStore`, which is what Phase 1
shipped. Phase 2b (#728) made `load` / `loadCached` / `save` return promises,
and that is what 0.16 releases.

The reason is the one this ADR exists to serve: a network-backed store cannot
satisfy a synchronous contract. There is no synchronous Postgres client for
Node, and manufacturing one (sync-over-async, a worker with `Atomics.wait`)
trades a documented limitation for an undocumented hazard. Keeping the seam
synchronous would have meant the seam could never reach the deployment it was
built for.

The cost is a hard breaking change for `@plur-ai/core` consumers, since async is
contagious across roughly twenty public `Plur` methods. `npx @plur-ai/migrate`
exists to absorb it. The block above shows the interface as shipped.

## Amendment — 2026-08-03: the write path gets the same seams ([#827](https://github.com/plur-ai/plur/issues/827), [#828](https://github.com/plur-ai/plur/issues/828))

0.16 and 0.17 gave a row store everything it needed on the **read** side —
`role: 'primary'` + `searchBM25` to answer queries from its own indexes,
`loadByIds` + `updateMany` to write back only the rows a recall touched. The
write path kept the shape this ADR set out to remove: `learn()` materialised the
corpus twice (once to look for a duplicate statement, once to derive the next
id) and `feedback()` materialised it to fetch one row by primary key. A store
could serve reads entirely from its indexes and then pay a full corpus load the
moment anyone learned something — `updateMany`'s own note puts that at 252ms at
2,000 engrams and ~6.3s at 50,000, which is the tier where a row store is
selected at all.

Two optional methods close it, in the same additive shape as the rest:

```ts
findActiveByContentHash?(hash: string, scope: string): Promise<Engram | null>
nextEngramId?(datePrefix: string): Promise<string>
```

Both are read off the same materialised corpus today, so they are jointly
required: delegating one still pays the full load for the other. They are gated
together with the 0.17 write seams (`append` + `updateMany` + `loadByIds`),
because every fallback in `learn()` takes "the corpus in hand" and turns it into
a whole-corpus `save()` when no row-level write exists — a targeted read without
a targeted write would hand a one-row array to a full replace, which is the #749
defect from the other side. `YamlPrimaryStore` and `MemoryPrimaryStore`
deliberately implement neither: their `load()` is free, so the seam would buy
nothing and cost the trade-off below.

### Two decisions worth stating rather than leaving to be discovered

**1. Cross-scope recurrence is skipped when dedup is delegated.**
`findActiveByContentHash` is scope-bound by contract — a hash match in another
scope is a different engram, and returning it would disclose it. That is exactly
the query cross-scope recurrence (#176) asks, so the seam cannot answer it and
the primary-store half of that check is not performed. The statement becomes its
own engram in its own scope instead of graduating an existing one toward
`global` + `locked`. Secondary stores and packs are unaffected; they are scanned
in memory either way.

This is the intended outcome rather than a tolerated loss. A store that wants
the seam is one where scopes are a permission boundary, and silently broadening
one scope's engram to `global` because another scope learned the same sentence
is what such a store must not do. A deployment that wants graduation declines
the seam and keeps the corpus scan. Pinned by test, not just by prose:
`test/write-path-seams.test.ts` asserts the graduation on the corpus-scanning
path and its absence on the delegated one.

**2. Id allocation and `append`'s collision check are one concern from two
ends.** `generateEngramId` derives a suffix from a snapshot and the engine then
calls `append`, whose contract says an implementation *SHOULD surface an id
collision as an error rather than absorb it* — the last line of defence for an
id that was already stale when minted. A store whose `append` is an upsert has
no such defence and silently overwrites the loser of a race; the engine's store
lock contains this within one process but not across two sharing a database.
`nextEngramId` moves allocation to the party that can make it atomic.

### Also folded in

The same `load()`-then-`find(id)` shape existed at seven other sites
(`feedback`, `updateEngram`, `updateEngramAsync`, `setPinned`, `setPinnedAsync`,
`forget`, `rescope`'s local branch, `_retireRescopedSource`, and the outbox
failure bookkeeping). All now go through one `_loadTargeted(ids)` helper that
checks `loadByIds` and `updateMany` as a pair, so the subset it returns is only
ever produced when the write consuming it is itself targeted. The one site left
alone is the outbox's local-copy REMOVAL: the only removal primitive
`PrimaryStore` has is a whole-corpus save of the array without the row, so a
targeted read there would be a full replace by an empty array. It stays a full
load until there is a `remove`/`deleteMany` seam.
