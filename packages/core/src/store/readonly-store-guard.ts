/**
 * ReadonlyStoreGuard — blocks every write to a `PrimaryStore` for read-only commands.
 * - Reads and the query-adapter surface (`role`, `searchBM25`, ...) delegate unchanged;
 *   without them `recall()` falls back to `_filterEngrams()` and throws on a primary adapter.
 * - Optional capabilities mirror the inner store (never invent an `estimateCount` of 0).
 * - `withExclusiveAccess` runs the callback WITHOUT locking (no `.lock` file on a read path).
 * - All writes reject with one typed error, distinct from real store failures.
 * - A WHITELIST on purpose (fail closed): a missed deny-list entry would permit a write.
 *   `readonly-query-adapter.test.ts` enumerates the surface so new members fail there.
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
   * Query-adapter surface. All READS, all delegating unchanged.
   *
   * `role` is what `_primaryQueryAdapter()` keys on; without it a read-only
   * instance over a primary query store loses search pushdown and the
   * fallback path has no index to read.
   */
  readonly role?: string
  readonly searchBM25?: (query: string, opts: { limit: number } & Record<string, unknown>) => Promise<Engram[]>
  /** Pure read — the _filterEngrams pushdown calls this on any primary query
   *  adapter. Not forwarding it would demote every guarded query-capable store
   *  to the whole-corpus fallback. */
  readonly loadFiltered?: (filter: Record<string, unknown>) => Promise<Engram[]>
  /**
   * Also a read. `recall()`'s widening loop uses it to stop as soon as the
   * adapter reports the candidate set exhausted; without it a guarded store
   * keeps widening 3L → 9L → 27L and re-ranks the same rows two extra times,
   * a silent 2-3x cost regression rather than a visible failure.
   */
  readonly searchBM25Exhaustive?: (
    query: string,
    opts: { limit: number } & Record<string, unknown>,
  ) => Promise<{ rows: Engram[]; exhausted: boolean }>
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

    // Query-adapter surface — reads, forwarded verbatim like loadByIds.
    const inner = _inner as unknown as {
      role?: string
      searchBM25?: (q: string, o: { limit: number } & Record<string, unknown>) => Promise<Engram[]>
      loadFiltered?: (f: Record<string, unknown>) => Promise<Engram[]>
      searchBM25Exhaustive?: (
        q: string,
        o: { limit: number } & Record<string, unknown>,
      ) => Promise<{ rows: Engram[]; exhausted: boolean }>
      searchVector?: (...a: unknown[]) => Promise<unknown>
      vectorIndex?: unknown
    }
    if (inner.role !== undefined) this.role = inner.role
    if (inner.searchBM25) this.searchBM25 = (q, o) => inner.searchBM25!(q, o)
    if (inner.loadFiltered) this.loadFiltered = (f) => inner.loadFiltered!(f)
    if (inner.searchBM25Exhaustive) {
      this.searchBM25Exhaustive = (q, o) => inner.searchBM25Exhaustive!(q, o)
    }
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
