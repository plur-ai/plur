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
import type { PrimaryStore, PrimaryStoreKind } from './primary-store.js'

export class MemoryPrimaryStore implements PrimaryStore {
  readonly kind: PrimaryStoreKind = 'memory'
  readonly location: string | null = null
  private engrams: Engram[] = []

  constructor(seed?: Engram[]) {
    if (seed) this.engrams = seed.map(e => structuredClone(e))
  }

  load(): Engram[] {
    return this.engrams.map(e => structuredClone(e))
  }

  loadCached(): Engram[] {
    return this.load()
  }

  save(engrams: Engram[]): void {
    this.engrams = engrams.map(e => structuredClone(e))
  }

  invalidate(): void {
    // Nothing is cached — the store IS the memory.
  }

  /** Exact, not an estimate — the corpus is already in memory. */
  estimateCount(): number {
    return this.engrams.length
  }
}
