/**
 * YamlPrimaryStore: the default `PrimaryStore` (ADR-0001: YAML as truth).
 *
 * Provides `loadEngrams()` for authoritative reads, an mtime-keyed snapshot
 * cache for hot reads, `saveEngrams()` (atomic write) for persistence, and
 * explicit cache invalidation on every write.
 *
 * The invalidate-on-write rule is required for correctness: on filesystems with
 * coarse mtime resolution (e.g. tmpfs), a stat() before and after a write can
 * return the same value, so a purely mtime-driven cache would serve a pre-write
 * snapshot and `getById` would miss an engram `learn()` just created.
 */
import * as fs from 'fs'
import { loadEngrams, saveEngrams } from '../engrams.js'
import type { Engram } from '../schemas/engram.js'
import type { AsyncPrimaryStore, PrimaryStoreKind, SaveOptions } from './primary-store.js'

/**
/**
 * Mean serialized size of one engram in `engrams.yaml`, in bytes.
 *
 * Measured on a large real store (~2,394 B), rounded. Used ONLY to turn a
 * `stat()` into an order-of-magnitude engram count for backend selection, never
 * to report a count to a user. Being off by 2x is within the tolerance of the
 * thresholds in `backend-selection.ts`, and it avoids parsing a multi-MB YAML
 * file just to decide whether to build an index.
 */
export const AVG_YAML_BYTES_PER_ENGRAM = 2400

export class YamlPrimaryStore implements AsyncPrimaryStore {
  readonly kind: PrimaryStoreKind = 'yaml'

  /**
   * `loadEngrams` throws `EngramStoreUnreadableError` rather than reporting an
   * unreadable file as an empty corpus, so a short read from this store is
   * always a real one. That is what lets a whole-corpus `save()` be safe here
   * despite the absence of `append`/`updateMany`.
   */
  readonly refusesUnreadable = true
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
   * Exact when a snapshot is already cached. Else
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
