import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'
import { computeContentHash } from '../content-hash.js'

/**
 * Recompute content_hash for all engrams using the Unicode-aware normalizer (v2).
 *
 * The v1 normalizer used JS \w (ASCII-only), which stripped accented and non-Latin
 * characters before hashing. This caused false-positive dedup collisions between
 * genuinely different statements like "déploiement" and "dploiement". See #896.
 */
export const migration: Migration = {
  id: '20260813-006-recompute-content-hashes',
  description: 'Recompute content_hash with Unicode-aware normalizer (fixes #896)',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      const clone = { ...e } as any
      clone.content_hash = computeContentHash(e.statement)
      return clone as Engram
    })
  },
  // The v1 hashes were wrong — restoring them would reintroduce the bug.
  // down() is a no-op: hashes remain at v2 values, which are correct.
  down(engrams: Engram[]): Engram[] {
    return engrams
  },
}
