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
import type { AsyncPrimaryStore, PrimaryStoreKind, SaveOptions } from './primary-store.js'

/**
 * Mean serialized size of one engram in `engrams.yaml`, in bytes.
 *
 * Measured 2026-07-26 on a real long-lived personal store: 9,595,797 bytes /
 * 4,009 engrams = 2,394 B. Rounded to 2,400. Used ONLY to turn a `stat()` into
 * an order-of-magnitude engram count for backend selection — never to report a
 * count to a user. Being off by 2x moves the tier boundary by 2x, which is
 * within the tolerance the thresholds were chosen with (see
 * `backend-selection.ts`); parsing a 9 MB YAML file just to decide whether to
 * build an index is exactly the cost the estimate exists to avoid.
 */
export const AVG_YAML_BYTES_PER_ENGRAM = 2400

export class YamlPrimaryStore implements AsyncPrimaryStore {
  readonly kind: PrimaryStoreKind = 'yaml'
  private readonly filePath: string
  private cache: { mtime: bigint; engrams: Engram[] } | null = null

  constructor(filePath: string) {
    this.filePath = filePath
  }

  get location(): string {
    return this.filePath
  }

  async load(): Promise<Engram[]> {
    return loadEngrams(this.filePath)
  }

  async loadCached(): Promise<Engram[]> {
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

  async save(engrams: Engram[], opts?: SaveOptions): Promise<void> {
    saveEngrams(this.filePath, engrams, { allowShrink: opts?.allowShrink })
    this.cache = null
  }

  invalidate(): void {
    this.cache = null
  }

  /**
   * Order-of-magnitude engram count, without parsing the file.
   *
   * Exact when a snapshot is already cached (free — we have the array). Else
   * `size / AVG_YAML_BYTES_PER_ENGRAM`. A missing or unreadable file is 0, not
   * an error: "no store yet" is the smallest possible store.
   */
  estimateCount(): number {
    if (this.cache) return this.cache.engrams.length
    try {
      const size = fs.statSync(this.filePath).size
      return Math.round(size / AVG_YAML_BYTES_PER_ENGRAM)
    } catch {
      return 0
    }
  }
}
