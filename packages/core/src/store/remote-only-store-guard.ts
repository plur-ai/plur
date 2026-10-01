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

export interface RemoteOnlyStoreBinding {
  folder: string
  scope: string | null
  blocked?: string
}

/** True when `e` is a save queued from the remote-only folder `folder`. */
export function isQueuedForFolder(e: unknown, folder: string): boolean {
  const ob = (e as { structured_data?: { _outbox?: { remote_only?: unknown; remote_only_folder?: unknown } } } | null)
    ?.structured_data?._outbox
  return !!ob && ob.remote_only === true && ob.remote_only_folder === folder
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

  constructor(
    private readonly _inner: PrimaryStore,
    private readonly _binding: RemoteOnlyStoreBinding,
    /** The primary store holds queued saves; a secondary file store holds none. */
    private readonly _isPrimary: boolean,
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

  private _visible(e: Engram): boolean {
    return this._isPrimary && !this._binding.blocked && isQueuedForFolder(e, this._binding.folder)
  }

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

  async withExclusiveAccess<T>(fn: () => Promise<T>): Promise<T> {
    return this._inner.withExclusiveAccess ? await this._inner.withExclusiveAccess(fn) : await fn()
  }

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
