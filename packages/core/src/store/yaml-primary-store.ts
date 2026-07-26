/**
 * YamlPrimaryStore — the default `PrimaryStore` (ADR-0001: YAML as truth).
 *
 * This is a behaviour-preserving extraction of what the `Plur` class used to do
 * inline: `loadEngrams()` for authoritative reads, an mtime-keyed snapshot cache
 * for hot reads, `saveEngrams()` (atomic write) for persistence, and explicit
 * cache invalidation on every write.
 *
 * The cache and the invalidate-on-write rule are load-bearing, not an
 * optimisation — see issue #25: on CI tmpfs, mtime resolution can be coarse
 * enough that a stat() before and after a write returns the same value, so a
 * purely mtime-driven cache serves a pre-write snapshot and `getById` misses an
 * engram `learn()` just created. Writing through this class is what keeps the
 * filesystem from being a source of cache freshness.
 */
import * as fs from 'fs'
import { loadEngrams, saveEngrams } from '../engrams.js'
import type { Engram } from '../schemas/engram.js'
import type { PrimaryStore, PrimaryStoreKind } from './primary-store.js'

export class YamlPrimaryStore implements PrimaryStore {
  readonly kind: PrimaryStoreKind = 'yaml'
  private readonly filePath: string
  private cache: { mtime: bigint; engrams: Engram[] } | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  get location(): string {
    return this.filePath
  }

  load(): Engram[] {
    return loadEngrams(this.filePath)
  }

  loadCached(): Engram[] {
    let mtime: bigint
    try {
      mtime = fs.statSync(this.filePath, { bigint: true }).mtimeNs
    } catch {
      return []
    }
    if (this.cache && this.cache.mtime === mtime) return this.cache.engrams
    const engrams = loadEngrams(this.filePath)
    this.cache = { mtime, engrams }
    return engrams
  }

  save(engrams: Engram[]): void {
    saveEngrams(this.filePath, engrams)
    this.cache = null
  }

  invalidate(): void {
    this.cache = null
  }
}
