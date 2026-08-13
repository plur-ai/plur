/**
 * ReadonlyStoreGuard — wraps a `PrimaryStore` and blocks every write.
 *
 * Used when `Plur` is opened for a read-only command (`plur list`, `plur
 * status`, `plur tensions` list mode, `new Plur({ readonly: true })`) so that
 * lazy engine writes — index sync side-effects, cache refresh, migration
 * fix-ups — are caught rather than silently mutating the store (#731).
 *
 * Design rules, each load-bearing:
 *
 * - **Reads delegate unchanged** (`load`, `loadCached`, `invalidate`, and
 *   `loadByIds` when the inner store has it).
 * - **Optional capabilities mirror the inner store.** `estimateCount` and
 *   `loadByIds` are only present when the inner store implements them — a
 *   guard must not invent an estimate of 0 for a store that declined to give
 *   one (backend selection has its own "treat as small" fallback and must see
 *   the absence, not a fabricated number). Likewise the write capabilities
 *   `append`/`updateMany`/`nextEngramId` are only declared when the inner store
 *   declares them, so capability probes (`store.updateMany && store.loadByIds`)
 *   see the same shape as the unwrapped store.
 * - **`withExclusiveAccess` runs the callback WITHOUT acquiring anything.**
 *   Exclusive access exists to serialize read-modify-write cycles; on a store
 *   that cannot be written there is no write to serialize, and acquiring the
 *   fallback file lock would create `.lock` files on a pure read path — a
 *   disk write from a read-only engine. Any write attempted inside the
 *   callback still rejects at the store method itself.
 * - **All writes reject with the same typed error**, so callers can
 *   distinguish "this instance is read-only" from a real store failure.
 * - **The query-adapter surface delegates unchanged** (`role`, `searchBM25`,
 *   `searchVector`, `vectorIndex`). These are reads, so they need no guarding —
 *   exactly like `loadByIds`. Omitting them was #830: `_primaryQueryAdapter()`
 *   keys on `role === 'primary' && typeof searchBM25 === 'function'`, so a
 *   guarded store failed that check, `recall()` fell back to `_filterEngrams()`,
 *   and for a store that answers queries ITSELF — which therefore has no
 *   `indexedStorage`, since `indexTier` resolves to 'none' when a primary query
 *   store is present — that path had nothing to read and threw. Readonly is the
 *   documented way to say "this recall must not write", and it was unusable
 *   exactly where it is most wanted: shared multi-tenant storage, where core's
 *   per-read activation write is a real cost.
 *
 * A note on the shape, since it looks like the wrong one: this is a WHITELIST,
 * and a whitelist is why #830 happened — a new read member is silently dropped
 * until someone remembers to add it. A Proxy forwarding everything except a
 * write deny-list would not have this failure mode. It is still the right shape
 * HERE, because the two failure modes are not symmetric: a missed entry on a
 * whitelist loses functionality and is discovered; a missed entry on a
 * deny-list PERMITS A WRITE on a path whose entire purpose is that it cannot
 * write. On a safety guard, fail closed.
 */
import type { Engram } from '../schemas/engram.js'
import type { PrimaryStore, PrimaryStoreKind } from './primary-store.js'

export class ReadonlyStoreError extends Error {
  constructor() {
    super('This Plur instance is read-only — use a writable instance for mutations.')
    this.name = 'ReadonlyStoreError'
  }
}

export class ReadonlyStoreGuard implements PrimaryStore {
  readonly kind: PrimaryStoreKind
  readonly location: string | null

  /** Mirrors the inner store: wrapping does not change how its reads fail. */
  readonly refusesUnreadable?: boolean

  /** Present only when the inner store implements it — see file header. */
  readonly loadByIds?: (ids: string[]) => Promise<Engram[]>
  /** Present only when the inner store implements it — see file header. */
  readonly estimateCount?: () => number
  /** Present (and rejecting) only when the inner store implements it. */
  readonly append?: (engram: Engram) => Promise<void>
  /** Present (and rejecting) only when the inner store implements it. */
  readonly updateMany?: (engrams: Engram[]) => Promise<void>
  /**
   * A READ — present and delegating, like `loadByIds`. It answers "is this
   * statement already stored here", which a read-only instance may ask.
   */
  readonly findActiveByContentHash?: (hash: string, scope: string) => Promise<Engram | null>
  /**
   * Present (and rejecting) only when the inner store implements it.
   *
   * Unlike `findActiveByContentHash` this is NOT a read: an implementation that
   * makes allocation collision-safe does so by CONSUMING the id (a sequence
   * bump, a reservation row), which is a mutation of the store. Delegating it
   * from a read-only guard would burn ids on a path that can never write one.
   */
  readonly nextEngramId?: (datePrefix: string) => Promise<string>

  /**
   * Query-adapter surface (#830). All READS, all delegating unchanged.
   *
   * `role` is what `_primaryQueryAdapter()` keys on, so dropping it silently
   * disabled search pushdown for every read-only instance over a primary query
   * store — and then crashed, because the fallback path has no index to read.
   */
  readonly role?: string
  readonly searchBM25?: (query: string, opts: { limit: number } & Record<string, unknown>) => Promise<Engram[]>
  readonly searchVector?: (...args: unknown[]) => Promise<unknown>
  readonly vectorIndex?: unknown

  constructor(private readonly _inner: PrimaryStore) {
    this.kind = _inner.kind
    this.location = _inner.location
    this.refusesUnreadable = _inner.refusesUnreadable
    if (_inner.loadByIds) this.loadByIds = ids => _inner.loadByIds!(ids)
    if (_inner.estimateCount) this.estimateCount = () => _inner.estimateCount!()
    if (_inner.append) this.append = () => Promise.reject(new ReadonlyStoreError())
    if (_inner.updateMany) this.updateMany = () => Promise.reject(new ReadonlyStoreError())
    if (_inner.findActiveByContentHash) {
      this.findActiveByContentHash = (hash, scope) => _inner.findActiveByContentHash!(hash, scope)
    }
    if (_inner.nextEngramId) this.nextEngramId = () => Promise.reject(new ReadonlyStoreError())

    // Query-adapter surface (#830) — reads, forwarded verbatim like loadByIds.
    const inner = _inner as unknown as {
      role?: string
      searchBM25?: (q: string, o: { limit: number } & Record<string, unknown>) => Promise<Engram[]>
      searchVector?: (...a: unknown[]) => Promise<unknown>
      vectorIndex?: unknown
    }
    if (inner.role !== undefined) this.role = inner.role
    if (inner.searchBM25) this.searchBM25 = (q, o) => inner.searchBM25!(q, o)
    if (inner.searchVector) this.searchVector = (...a: unknown[]) => inner.searchVector!(...a)
    if (inner.vectorIndex !== undefined) this.vectorIndex = inner.vectorIndex
  }

  load(): Promise<Engram[]> { return this._inner.load() }
  loadCached(): Promise<Engram[]> { return this._inner.loadCached() }
  invalidate(): void { this._inner.invalidate() }

  /** No lock acquisition — nothing can write, so there is nothing to serialize. */
  async withExclusiveAccess<T>(fn: () => Promise<T>): Promise<T> {
    return await fn()
  }

  save(_engrams: Engram[]): Promise<void> { return Promise.reject(new ReadonlyStoreError()) }
}
