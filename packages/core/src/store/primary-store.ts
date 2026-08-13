/**
 * PrimaryStore — the source-of-truth persistence seam (convergence Phase 1).
 *
 * Until now the `Plur` class called `loadEngrams()` / `saveEngrams()` directly,
 * which hard-wired "the source of truth is a YAML file at `paths.engrams`" into
 * ~40 call sites. `StorageAdapter` could not take that role: it is an *index*
 * interface (`loadFiltered` / `searchBM25` / `searchVector` / `syncFromYaml` /
 * `reindex`) with no write operations at all, so no capability flag could turn
 * it into a store. `PrimaryStore` is that missing half.
 *
 * The split is therefore:
 *
 *   PrimaryStore    — persistence. Owns the bytes. Read and write.
 *   StorageAdapter  — query. Either derived from a PrimaryStore (`role: 'index'`)
 *                     or backed by the same engine as one (`role: 'primary'`).
 *
 * YAML stays the default (`YamlPrimaryStore`), so single-user behaviour is
 * byte-for-byte unchanged. ADR-0001 (YAML as source of truth) is not repealed —
 * it is now a *choice of implementation* rather than an assumption baked into
 * the caller.
 *
 * ### Why asynchronous (convergence Phase 2, landed)
 *
 * This interface was synchronous when Phase 1 introduced it — deliberately and
 * temporarily. Every `Plur` write path was synchronous (`withLock` +
 * `readFileSync`), so a sync contract was a faithful description of the caller.
 * It was also a hard ceiling: there is no synchronous Postgres client for Node,
 * so no network-backed store could ever satisfy it, and manufacturing one
 * (block-on-promise, a sync subprocess) would have traded a documented
 * limitation for an undocumented hazard.
 *
 * Phase 2 flipped the write path, so the ceiling is gone and the two interfaces
 * this file used to carry have collapsed into one, exactly as planned:
 * `PrimaryStore` IS the async contract, and {@link AsyncPrimaryStore} is now an
 * alias kept only so existing imports keep resolving.
 *
 * `invalidate()` stays synchronous. It drops a local cache; it does not touch
 * the backing medium, and making it async would add an interleaving point that
 * buys nothing.
 */
import type { Engram } from '../schemas/engram.js'

/** Identifier for the backing medium of a primary store. */
export type PrimaryStoreKind = 'yaml' | 'memory' | 'postgres'

/** Options for {@link PrimaryStore.save}. */
export interface SaveOptions {
  /**
   * This write is expected to remove engrams — suppress the shrink guard.
   *
   * Only the deliberate removers set it: compact, forget, retire, outbox
   * merge-back, pack uninstall. Everything else leaves it unset so that an
   * unexpectedly short corpus is refused rather than persisted (audit #794).
   */
  allowShrink?: boolean
}

/**
 * ## Implementer contract: what the engine cannot protect you from
 *
 * The engine guards the write path in three places (audit #794): the YAML
 * loader refuses an unreadable file, `saveEngrams` refuses an undeclared
 * shrink, and `_writeEngrams` refuses an undeclared *empty* corpus on any
 * backend. All three rest on the same assumption — that SOMETHING the store
 * says can be trusted.
 *
 * An implementation whose `load()` under-reports (returns `[]`, or a partial
 * set, for a store that is not actually empty) and which implements neither
 * `append`/`updateMany` nor a truthful count defeats every one of them by
 * construction: read-modify-write is the only shape available, the engine has
 * no second opinion to check the read against, and the resulting `save()`
 * legitimately looks like "the corpus is now this small". Probe
 * `probe/p10-seam-capability.ts` demonstrates exactly this with a deliberately
 * lying store, and it still loses rows — not because a guard is missing, but
 * because there is nothing left to guard with.
 *
 * So an implementation MUST do at least one of:
 *
 *   - implement `append` and `updateMany`, so single-engram changes never
 *     become whole-corpus replaces (what `PostgresAdapter` and
 *     `MemoryPrimaryStore` do); or
 *   - make `load()` fail loudly rather than under-report, so the engine can
 *     refuse instead of persisting a lie (what `YamlPrimaryStore` does via
 *     `EngramStoreUnreadableError`).
 *
 * Every store shipped in this package satisfies one or both. A custom store
 * that satisfies neither is outside what the engine can defend.
 */
export interface PrimaryStore {
  /** Backing medium — for diagnostics and `status()` reporting. */
  readonly kind: PrimaryStoreKind

  /**
   * This store's `load()` FAILS rather than under-reporting.
   *
   * Set it only if a read that cannot see the whole corpus throws instead of
   * returning a short array — `YamlPrimaryStore` qualifies because
   * `loadEngrams` raises {@link EngramStoreUnreadableError} rather than
   * treating an unparseable file as empty.
   *
   * It is the second of the two ways to satisfy the implementer contract above,
   * and it is checked at attachment: a store that declares neither this nor the
   * `append`/`updateMany` pair is refused, because nothing the engine can
   * observe would distinguish a genuinely small corpus from a bad read.
   *
   * Declaring it falsely is worse than not declaring it — it tells the engine a
   * short read can be trusted, which is precisely the assumption that destroys
   * corpora.
   */
  readonly refusesUnreadable?: boolean

  /**
   * Human-readable location of the store (a file path for YAML, a schema
   * identifier for Postgres). Used for diagnostics and for lock keys while
   * locking is still path-based. `null` when the store has no such location.
   */
  readonly location: string | null

  /**
   * Authoritative read — always goes to the backing medium, never a cache.
   * Used inside write transactions where a stale snapshot would lose data.
   */
  load(): Promise<Engram[]>

  /**
   * Cached read. May return a previously-loaded snapshot when the backing
   * medium is provably unchanged. An implementation with no cheap
   * change-detection MUST delegate to `load()` rather than serve a snapshot it
   * cannot prove is current.
   */
  loadCached(): Promise<Engram[]>

  /**
   * Replace the entire contents of the store, and drop any read cache.
   *
   * File-backed implementations refuse a write that would shrink the corpus by
   * more than a tolerance unless `opts.allowShrink` is set — see the guard on
   * `saveEngrams` (audit #794). Row stores have no equivalent exposure and may
   * ignore the option.
   */
  save(engrams: Engram[], opts?: SaveOptions): Promise<void>

  /** Drop any read cache without writing. Synchronous — see the note above. */
  invalidate(): void

  /**
   * Run `fn` with EXCLUSIVE access to this store, across every process that
   * shares it. Optional; when absent the caller falls back to its own
   * path-based file lock.
   *
   * ## Why this is on the store
   *
   * `Plur`'s write methods are read-modify-write: load the corpus, change one
   * engram, save the corpus. That is only safe under mutual exclusion, and
   * until now `Plur` provided it with `withAsyncLock(this.paths.engrams, …)` —
   * an in-process mutex plus an `O_EXCL` lock file on the LOCAL filesystem.
   *
   * That is a YAML assumption compiled into the engine. It is correct for
   * `YamlPrimaryStore`, where the path being locked IS the data. It protects
   * nothing when the data lives in a shared database: two containers share
   * neither the mutex nor the lock file, so both load, both mutate, and both
   * save — and because `save()` replaces the whole corpus, the loser does not
   * merely lose its own update, it DELETES rows the winner committed.
   *
   * Measured, not theorised: with two `Plur` instances over one Postgres
   * schema, a concurrent `feedback` + `learn` reverted the feedback increment
   * in 5 runs out of 5, and a concurrent *read-only* `recall()` + `learn`
   * permanently deleted the learned engram in 2 out of 5 — because `recall()`
   * updates activation, which is itself a whole-corpus write.
   *
   * So the lock has to be the store's business. A store that spans processes
   * implements this with something those processes actually share — a Postgres
   * advisory lock, a row lock, a lease. A single-file store can leave it
   * undefined and keep the file lock.
   *
   * Implementations MUST be reentrant-safe from the caller's perspective in the
   * sense that `fn` may itself call `load`/`save` on the same store, and MUST
   * release on throw.
   */
  withExclusiveAccess?<T>(fn: () => Promise<T>): Promise<T>

  /**
   * Replace exactly these engrams, leaving every other row untouched.
   * Optional; when absent the caller falls back to a whole-corpus `save()`.
   *
   * `save()` is a full replace — it rewrites every row and deletes anything
   * absent from the array. That is the right contract for "here is the corpus",
   * and the wrong one for "these three engrams changed".
   *
   * It matters most on the read path. `recall()` updates activation on the
   * engrams it returned, which under `save()` meant rewriting the ENTIRE corpus
   * on every read, while holding the global write lock: measured at 252ms for
   * 2,000 engrams, extrapolating to ~6.3s at 50,000 — the corpus size at which
   * this tier is selected in the first place. Every writer queues behind every
   * reader.
   *
   * Implementations MUST NOT delete rows absent from `engrams`, and MUST be
   * safe to call inside `withExclusiveAccess`.
   */
  updateMany?(engrams: Engram[]): Promise<void>

  /**
   * Insert exactly one NEW engram, leaving every other row untouched.
   * Optional; when absent the caller falls back to a whole-corpus `save()` of
   * the corpus it already holds — never a fresh load-and-reparse.
   *
   * The companion to {@link updateMany} for the write path (#740): `learn()`
   * constructs a brand-new engram, and on a row store that should be a
   * single-row INSERT, not a corpus replace. It is deliberately NOT expressed
   * as `updateMany([engram])`: `updateMany` is an upsert, so a duplicate id
   * would silently overwrite an unrelated existing row. `append` carries the
   * "this row is new" intent, and an implementation SHOULD surface an id
   * collision as an error rather than absorb it.
   *
   * `YamlPrimaryStore` intentionally does not implement it. A single-file
   * store rewrites the whole file either way, and every in-engine caller
   * already holds a freshly loaded corpus under the store lock — the fallback
   * reuses that corpus, so implementing `append` here would only add a second
   * full parse of a file the caller just parsed (the #745 regression).
   *
   * Implementations with a read cache MUST invalidate it after writing, and
   * MUST be safe to call inside `withExclusiveAccess`.
   */
  append?(engram: Engram): Promise<void>

  /**
   * Load exactly these engrams by id. Optional; when absent the caller falls
   * back to `load()` and filters in memory.
   *
   * The counterpart to {@link updateMany}, and needed for the same reason: a
   * read-modify-write that touches a handful of rows should not have to
   * materialise the corpus to find them. Ids absent from the store are simply
   * not returned — a missing engram is not an error here.
   */
  loadByIds?(ids: string[]): Promise<Engram[]>

  /**
   * The engram carrying this content hash IN THIS SCOPE with
   * `status === 'active'`, or `null`. Optional; when absent the caller falls
   * back to scanning the loaded corpus.
   *
   * The status filter is the predicate, not a nicety: re-learning a RETIRED
   * statement must create a fresh engram rather than resurrect the retired one
   * (#107), and the local half of a completed rescope is retired precisely so
   * its hash cannot pull the statement back (#676). An implementation that
   * matches retired rows undoes both.
   *
   * `learn()` asks one question before it writes anything: "do we already have
   * this exact statement in this scope?" On a single YAML file, answering it by
   * scanning the parsed corpus is free — the file was parsed either way. On a
   * row store it is a full table scan standing in for an index lookup on
   * `(content_hash, scope)`, paid on every learn, at the corpus size where a row
   * store gets selected in the first place (see {@link updateMany}: 252ms at
   * 2,000 engrams, ~6.3s at 50,000).
   *
   * ### Scope-bound, deliberately
   *
   * A hash match in ANOTHER scope is a different engram, and returning it would
   * disclose it. Implementations MUST restrict the lookup to `scope` exactly —
   * not a prefix, not a parent, not "any scope this caller could read".
   *
   * That has a consequence worth stating plainly rather than discovering:
   * `learn()`'s CROSS-scope recurrence check (#176 — the same statement
   * re-learned under a different scope graduates the existing engram toward
   * `global` + `locked` instead of creating a second row) asks the opposite
   * question, and this seam is defined so it cannot answer it. So when a store
   * implements this method, the primary-store half of cross-scope recurrence is
   * SKIPPED: a same-hash engram in another scope is not found, and the new
   * statement becomes a new engram in its own scope. Secondary stores and packs
   * are unaffected — they are scanned in memory either way.
   *
   * That is the intended outcome, not a tolerated loss. A store that wants this
   * seam is one where scopes are a permission boundary; silently broadening one
   * tenant's engram to `global` because another tenant learned the same
   * sentence is precisely what such a store must not do. A store that wants
   * cross-scope graduation should not implement this method, and pays the
   * corpus scan that makes it possible.
   *
   * @see nextEngramId — the other half of the `learn()` seam; both are required
   *   before the engine will skip the corpus load.
   */
  findActiveByContentHash?(hash: string, scope: string): Promise<Engram | null>

  /**
   * The next unused engram id for `datePrefix` (e.g. `'ENG-2026-08-03-'`).
   * Optional; when absent the caller falls back to deriving it from the loaded
   * corpus.
   *
   * The performance half is the obvious one — `generateEngramId` scans the
   * whole corpus for the maximum suffix, which a row store answers with
   * `SELECT MAX(...) WHERE id LIKE '<datePrefix>%'`.
   *
   * ### The sharper half is collision safety
   *
   * `generateEngramId` derives its suffix from a SNAPSHOT and the engine then
   * calls {@link append}. Those are the same concern from opposite ends:
   * `append` says an implementation *SHOULD surface an id collision as an error
   * rather than absorb it*, which is the last line of defence for an id that
   * was already stale when it was minted. A store whose `append` is really an
   * upsert has no such defence and silently overwrites the loser of a race.
   * The engine's store lock contains this within one process; it is not a
   * property callers should have to rely on, and it does not survive two
   * processes sharing one database.
   *
   * `nextEngramId` moves allocation to the party that can make it atomic —
   * for a row store, a sequence or an `INSERT ... RETURNING` in the same
   * transaction. Implementations SHOULD make allocation collision-safe under
   * concurrency rather than returning a value derived from a stale read.
   *
   * ### Contract
   *
   * - The returned id MUST begin with `datePrefix` and MUST be unused in this
   *   store.
   * - The engine passes the canonical `ENG-YYYY-MM-DD-` form. A store also
   *   holding legacy `ENG-YYYY-MMDD-` ids may account for them but need not:
   *   the two forms cannot collide as strings.
   * - Allocation is scoped to the PRIMARY store. Unlike the fallback, ids held
   *   by installed packs are not consulted — `append`'s collision check is the
   *   backstop.
   *
   * @see findActiveByContentHash — the other half of the `learn()` seam.
   */
  nextEngramId?(datePrefix: string): Promise<string>

  /**
   * Cheap, approximate size of the store — for choosing a backend, never for
   * reporting a count to a user.
   *
   * MUST NOT load or parse the corpus: the whole point is to decide which
   * backend to build *before* paying the cost the wrong backend would impose.
   * `YamlPrimaryStore` derives it from the file size; an in-memory store knows
   * it exactly. Optional so an implementation with no cheap estimate can stay
   * silent, in which case backend selection treats the store as small.
   *
   * @see resolveBackendTier in `../backend-selection.js`
   */
  estimateCount?(): number
}

/**
 * @deprecated Use {@link PrimaryStore}. This is now an alias for it.
 *
 * Phase 1 shipped two structurally identical interfaces — a synchronous
 * `PrimaryStore` describing what `Plur` could actually call, and this async
 * successor that only `PostgresAdapter` could satisfy — with the explicit plan
 * that Phase 2 would collapse them. Phase 2 has landed, so it has: there is one
 * contract, and the distinction the two names drew no longer exists.
 *
 * The alias stays because the name is used across `packages/core/src` and by
 * out-of-tree consumers; removing it would be a breaking change that buys
 * nothing. Prefer `PrimaryStore` in new code.
 */
export type AsyncPrimaryStore = PrimaryStore
