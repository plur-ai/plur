/**
 * RemoteOnlyStoreGuard — the storage-layer backstop for remote-only folders
 * (re-audit of #1521, owner 2026-10-01).
 *
 * The method guards in `Plur` are the first layer: they refuse with a message
 * that names the folder and the operation. This wrapper is the second: while
 * a `Plur` instance is bound to a remote-only folder, EVERY local store it
 * opens — the primary store and each secondary file store — is wrapped, so a
 * code path nobody thought of still cannot reach a personal row.
 *
 *  (a) Reads see only the folder's own queued saves: primary-store rows whose
 *      `_outbox` is marked `remote_only` for THIS folder. A secondary file
 *      store is personal by definition and reads as empty. Personal rows are
 *      invisible to `load`, `loadCached`, `loadByIds` and
 *      `findActiveByContentHash`.
 *  (b) Writes may only create, change or delete those queued rows. A write
 *      whose result is not such a row (a new personal row, a queued row that
 *      lost its marker) or that touches a hidden row throws
 *      RemoteOnlyWriteError. A whole-corpus `save` re-inserts the hidden rows
 *      exactly as they were, in their original order, so a caller that only
 *      saw the queued rows can never delete the rest.
 *
 * Like ReadonlyStoreGuard this is a WHITELIST, for the reason given there: a
 * member missing from a safety guard must fail closed. The query-adapter
 * surface (`role`, `searchBM25`, …) is deliberately not forwarded, so search
 * pushdown into the full store is never used through this guard.
 * `nextEngramId` is forwarded: it returns an id, not content, and a queued
 * row's id must not collide with a hidden one.
 */
import type { Engram } from '../schemas/engram.js'
import type { PrimaryStore, PrimaryStoreKind, SaveOptions } from './primary-store.js'
import { RemoteOnlyWriteError } from '../remote-only.js'
import { logger } from '../logger.js'

export interface RemoteOnlyStoreBinding {
  folder: string
  scope: string | null
  blocked?: string
}

/** True when `e` is marked as a save queued from the remote-only folder `folder`. */
export function isQueuedForFolder(e: unknown, folder: string): boolean {
  const ob = (e as { structured_data?: { _outbox?: { remote_only?: unknown; remote_only_folder?: unknown } } } | null)
    ?.structured_data?._outbox
  return !!ob && ob.remote_only === true && ob.remote_only_folder === folder
}

/**
 * True when `e` is a well-formed queued save of `folder` (re-audit 2 of #1521,
 * R2-B2): marked for the folder, ACTIVE, and in the team scope its queue entry
 * targets — the folder's scope or another shared scope. Anything else is not
 * a deliverable queued save, so the guard does not accept it.
 */
export function isDeliverableQueuedSave(e: unknown, folder: string, isDeliverableScope: (scope: string) => boolean): boolean {
  if (!isQueuedForFolder(e, folder)) return false
  return isWellFormedQueuedSave(e, isDeliverableScope)
}

/** Active, in the scope its queue entry targets, and that scope is deliverable. */
export function isWellFormedQueuedSave(e: unknown, isDeliverableScope: (scope: string) => boolean): boolean {
  const row = e as { status?: string; scope?: string; structured_data?: { _outbox?: { target_scope?: string } } }
  if (row.status !== 'active') return false
  const target = row.structured_data?._outbox?.target_scope
  if (!row.scope || row.scope !== target) return false
  return isDeliverableScope(row.scope)
}

function marker(e: unknown): Record<string, unknown> | undefined {
  return (e as { structured_data?: { _outbox?: Record<string, unknown> } } | null)?.structured_data?._outbox
}

/**
 * The queue hold (re-audit 3 of #1521, owner 2026-10-02): why writing `next`
 * over `stored` would break a remote-only queued save, or null when it does
 * not. A row carrying the remote-only queue marker may be written back only
 * with the same scope, status `active` and the same marker (its delivery
 * bookkeeping may change); deleting it (delivery, forget) is not a write and
 * is always allowed. A row that newly carries the marker must be a
 * well-formed queued save.
 */
export function queueHoldViolation(
  stored: Engram | undefined, next: Engram, isDeliverableScope: (scope: string) => boolean,
): string | null {
  const was = marker(stored)
  const now = marker(next)
  if (was?.remote_only === true) {
    if (now?.remote_only !== true) return 'its queue entry would be removed'
    for (const k of ['remote_only_folder', 'target_scope', 'target_url']) {
      if (now[k] !== was[k]) return `its queue entry's ${k} would change`
    }
    if (next.scope !== stored!.scope) return `its scope would change to "${next.scope}"`
    if (next.status !== 'active') return `it would be ${next.status}`
    return null
  }
  if (now?.remote_only === true && !isWellFormedQueuedSave(next, isDeliverableScope)) {
    return 'it is not a well-formed queued save (active, in a team scope served by a writable team store)'
  }
  return null
}

/**
 * QueueHoldStore — the write choke point for the queue hold. EVERY internal
 * access to the primary store goes through it, in every instance, bound to a
 * folder or not. Reads and the query surface pass through unchanged; each
 * write is checked against the rows as stored now (read under the caller's
 * lock) and refused with RemoteOnlyWriteError when it would break a queued
 * remote-only save. The public `Plur.primaryStore` handle is the store as
 * passed in, not this wrapper (its identity is part of the API).
 */
export class QueueHoldStore implements PrimaryStore {
  readonly kind: PrimaryStoreKind
  readonly location: string | null
  readonly refusesUnreadable?: boolean
  // Optional members are DECLARED, not initialised: every non-write member of
  // the inner store (capabilities and the whole query-adapter surface, e.g.
  // role / searchBM25 / corpusStats) is forwarded generically below, so a
  // member added to a store later is never silently dropped (the #830/#753
  // lesson of ReadonlyStoreGuard). Only the three writes are wrapped.
  declare readonly loadByIds?: (ids: string[]) => Promise<Engram[]>
  declare readonly estimateCount?: () => number
  declare readonly append?: (engram: Engram) => Promise<void>
  declare readonly updateMany?: (engrams: Engram[]) => Promise<void>
  declare readonly findActiveByContentHash?: (hash: string, scope: string) => Promise<Engram | null>
  declare readonly nextEngramId?: (datePrefix: string) => Promise<string>
  declare readonly withExclusiveAccess?: <T>(fn: () => Promise<T>) => Promise<T>
  declare readonly afterCommit?: (callback: () => void) => void

  constructor(
    readonly inner: PrimaryStore,
    private readonly _isDeliverableScope: (scope: string) => boolean,
  ) {
    this.kind = inner.kind
    this.location = inner.location
    this.refusesUnreadable = inner.refusesUnreadable
    const writes = new Set(['save', 'append', 'updateMany'])
    const names = new Set<string>()
    for (let o: object | null = inner; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const n of Object.getOwnPropertyNames(o)) names.add(n)
    }
    for (const n of names) {
      if (n === 'constructor' || writes.has(n) || n in this) continue
      Object.defineProperty(this, n, {
        configurable: true,
        enumerable: false,
        get: () => {
          const v = (inner as unknown as Record<string, unknown>)[n]
          return typeof v === 'function' ? (v as Function).bind(inner) : v
        },
      })
    }
    if (inner.append) {
      Object.defineProperty(this, 'append', {
        configurable: true,
        value: async (engram: Engram) => {
          this._check([engram], await this._current([engram.id]))
          await inner.append!(engram)
        },
      })
    }
    if (inner.updateMany) {
      Object.defineProperty(this, 'updateMany', {
        configurable: true,
        value: async (engrams: Engram[]) => {
          this._check(engrams, await this._current(engrams.map(e => e.id)))
          await inner.updateMany!(engrams)
        },
      })
    }
  }

  private async _current(ids: string[]): Promise<Map<string, Engram>> {
    const rows = this.inner.loadByIds ? await this.inner.loadByIds(ids) : await this.inner.loadCached()
    return new Map(rows.map(e => [e.id, e]))
  }

  private _check(next: Engram[], current: Map<string, Engram>): void {
    for (const e of next) {
      const stored = current.get(e.id)
      const why = queueHoldViolation(stored, e, this._isDeliverableScope)
      if (why) {
        const ob = marker(stored) ?? marker(e) ?? {}
        throw new RemoteOnlyWriteError(
          String(ob.remote_only_folder ?? 'a remote-only folder'), String(ob.target_scope ?? e.scope), undefined,
          'queued-stays-remote', `${e.id} (${why})`)
      }
    }
  }

  load(): Promise<Engram[]> { return this.inner.load() }
  loadCached(): Promise<Engram[]> { return this.inner.loadCached() }
  invalidate(): void { this.inner.invalidate() }

  async save(engrams: Engram[], opts?: SaveOptions): Promise<void> {
    // Fresh read: the caller holds the store lock, so this is the state the
    // write replaces. Deleted rows are not checked (delivery and forget).
    const current = new Map((await this.inner.load()).map(e => [e.id, e]))
    this._check(engrams, current)
    await this.inner.save(engrams, opts)
  }
}

export class RemoteOnlyStoreGuard implements PrimaryStore {
  readonly kind: PrimaryStoreKind
  readonly location: string | null
  readonly refusesUnreadable?: boolean
  readonly loadByIds?: (ids: string[]) => Promise<Engram[]>
  readonly append?: (engram: Engram) => Promise<void>
  readonly updateMany?: (engrams: Engram[]) => Promise<void>
  readonly findActiveByContentHash?: (hash: string, scope: string) => Promise<Engram | null>
  readonly nextEngramId?: (datePrefix: string) => Promise<string>
  /**
   * Forwarded ONLY when the inner store has it (re-audit 2 of #1521, R2-B1).
   * Implementing it unconditionally made `_withStoreLock` skip its own lock
   * for a YAML store, and concurrent bound writes lost saves.
   */
  readonly withExclusiveAccess?: <T>(fn: () => Promise<T>) => Promise<T>

  constructor(
    private readonly _inner: PrimaryStore,
    private readonly _binding: RemoteOnlyStoreBinding,
    /** The primary store holds queued saves; a secondary file store holds none. */
    private readonly _isPrimary: boolean,
    /** The one rule for a deliverable team scope (Plur._isDeliverableTeamScope). */
    private readonly _isDeliverableScope: (scope: string) => boolean = () => false,
  ) {
    this.kind = _inner.kind
    this.location = _inner.location
    this.refusesUnreadable = _inner.refusesUnreadable
    if (_inner.loadByIds) this.loadByIds = async ids => (await _inner.loadByIds!(ids)).filter(e => this._visible(e))
    if (_inner.findActiveByContentHash) {
      this.findActiveByContentHash = async (hash, scope) => {
        const hit = await _inner.findActiveByContentHash!(hash, scope)
        return hit && this._visible(hit) ? hit : null
      }
    }
    if (_inner.nextEngramId) this.nextEngramId = prefix => _inner.nextEngramId!(prefix)
    if (_inner.withExclusiveAccess) this.withExclusiveAccess = fn => _inner.withExclusiveAccess!(fn)
    if (_inner.append) {
      this.append = async engram => {
        this._assertQueued(engram, 'Saving a new memory on this machine')
        const ids = new Set((await _inner.loadCached()).map(e => e.id))
        if (ids.has(engram.id)) this._refuse('Saving over a memory kept on this machine')
        await _inner.append!(engram)
      }
    }
    if (_inner.updateMany) {
      this.updateMany = async engrams => {
        const current = new Map((await _inner.loadCached()).map(e => [e.id, e]))
        for (const e of engrams) {
          const stored = current.get(e.id)
          if (stored && !this._visible(stored)) this._refuse('Changing a memory kept on this machine')
          this._assertQueued(e, 'Changing a queued save into a memory kept on this machine')
        }
        await _inner.updateMany!(engrams)
      }
    }
  }

  /**
   * Only WELL-FORMED queued saves of this folder are visible (re-audit 3,
   * R3-3): a malformed one (retired, moved off its target, or targeting a
   * scope no writable team store serves) is treated like a hidden row —
   * carried through unchanged — so it cannot block every save in the folder.
   * It is reported once; forgetting it by id removes it.
   */
  private _visible(e: Engram): boolean {
    if (!this._isPrimary || this._binding.blocked || !isQueuedForFolder(e, this._binding.folder)) return false
    if (isDeliverableQueuedSave(e, this._binding.folder, this._isDeliverableScope)) return true
    if (!RemoteOnlyStoreGuard._warned.has(e.id)) {
      RemoteOnlyStoreGuard._warned.add(e.id)
      logger.warning(`[plur] ${e.id} is a queued save from ${this._binding.folder} that can no longer be delivered ` +
        `(its scope or status changed, or no writable team store serves it). It is set aside; forget it by id to remove it.`)
    }
    return false
  }
  private static _warned = new Set<string>()

  private _refuse(what: string): never {
    const b = this._binding
    throw b.blocked
      ? new RemoteOnlyWriteError(b.folder, b.scope, undefined, 'blocked', b.blocked)
      : new RemoteOnlyWriteError(b.folder, b.scope, undefined, 'local-row', what)
  }

  private _assertQueued(e: Engram, what: string): void {
    if (!this._visible(e)) this._refuse(what)
  }

  async load(): Promise<Engram[]> { return (await this._inner.load()).filter(e => this._visible(e)) }
  async loadCached(): Promise<Engram[]> { return (await this._inner.loadCached()).filter(e => this._visible(e)) }
  invalidate(): void { this._inner.invalidate() }

  /** Every id the store holds — ids only, never content — for collision-free id minting. */
  async allIds(): Promise<string[]> {
    return (await this._inner.loadCached()).map(e => e.id)
  }

  /**
   * A whole-corpus save of the VISIBLE rows. Hidden rows are written back
   * unchanged and in place; the visible rows the caller passes replace,
   * delete (by absence) or add queued saves only.
   */
  async save(engrams: Engram[], opts?: SaveOptions): Promise<void> {
    const all = await this._inner.load()
    const hiddenIds = new Set(all.filter(e => !this._visible(e)).map(e => e.id))
    for (const e of engrams) {
      if (hiddenIds.has(e.id)) this._refuse('Changing a memory kept on this machine')
      this._assertQueued(e, 'Saving a memory on this machine')
    }
    const incoming = new Map(engrams.map(e => [e.id, e]))
    const merged: Engram[] = []
    for (const e of all) {
      if (!this._visible(e)) { merged.push(e); continue }
      const next = incoming.get(e.id)
      if (next) { merged.push(next); incoming.delete(e.id) }
    }
    for (const e of incoming.values()) merged.push(e)
    await this._inner.save(merged, { ...(opts ?? {}), allowShrink: true } as SaveOptions)
  }
}
