/**
 * MemoryPrimaryStore — an in-process `PrimaryStore` with no filesystem backing.
 *
 * Its job is to make "the `Plur` class is source-of-truth agnostic" a claim that
 * can be *tested* rather than asserted: inject one, run the full learn/recall/
 * update/forget surface, and observe that no `engrams.yaml` is ever created.
 * It is also a legitimate production choice for ephemeral or sandboxed sessions
 * where nothing should be persisted to disk.
 *
 * Engrams are cloned on the way in and out so callers cannot mutate stored state
 * by holding a reference — the YAML store gets that property for free from
 * serialisation, and a memory store that skipped it would be a subtly different
 * source of truth, which is exactly what this class exists to rule out.
 */
import type { Engram } from '../schemas/engram.js'
import type { AsyncPrimaryStore, PrimaryStoreKind } from './primary-store.js'

export class MemoryPrimaryStore implements AsyncPrimaryStore {
  readonly kind: PrimaryStoreKind = 'memory'
  readonly location: string | null = null
  private engrams: Engram[] = []

  constructor(seed?: Engram[]) {
    if (seed) this.engrams = seed.map(e => structuredClone(e))
  }

  async load(): Promise<Engram[]> {
    return this.engrams.map(e => structuredClone(e))
  }

  async loadCached(): Promise<Engram[]> {
    return this.load()
  }

  async save(engrams: Engram[]): Promise<void> {
    this.engrams = engrams.map(e => structuredClone(e))
  }

  /**
   * O(1) insert of one new engram. Duplicate ids are a caller bug — surface
   * them (see `PrimaryStore.append`: an upsert here would silently overwrite
   * an unrelated row, which is exactly what `append` exists to rule out).
   */
  async append(engram: Engram): Promise<void> {
    if (this.engrams.some(e => e.id === engram.id)) {
      throw new Error(`append: engram ${engram.id} already exists — use updateMany to replace it`)
    }
    this.engrams.push(structuredClone(engram))
  }

  /**
   * Targeted upsert — replace matching rows by id, insert the rest, delete
   * nothing. Same semantics as `PostgresAdapter.updateMany` (INSERT ... ON
   * CONFLICT DO UPDATE), so engine behaviour is identical across capability
   * stores: a mutation handed to `updateMany` can never be silently dropped —
   * an id that has vanished from the store is re-inserted, not lost.
   */
  async updateMany(engrams: Engram[]): Promise<void> {
    for (const engram of engrams) {
      const idx = this.engrams.findIndex(e => e.id === engram.id)
      if (idx === -1) this.engrams.push(structuredClone(engram))
      else this.engrams[idx] = structuredClone(engram)
    }
  }

  /** Targeted read — ids absent from the store are simply not returned. */
  async loadByIds(ids: string[]): Promise<Engram[]> {
    const wanted = new Set(ids)
    return this.engrams.filter(e => wanted.has(e.id)).map(e => structuredClone(e))
  }

  invalidate(): void {
    // Nothing is cached — the store IS the memory.
  }

  /** Exact, not an estimate — the corpus is already in memory. */
  estimateCount(): number {
    return this.engrams.length
  }
}
