import type { Migration } from './types.js'
import type { Engram } from '../schemas/engram.js'
import { computeContentHash, isHashable } from '../content-hash.js'

/**
 * Recompute `content_hash` under the Unicode-aware normalizer (v2).
 *
 * v1 hashes on disk are stale for any statement containing a character the
 * old ASCII `\w` stripped. `Plur.repairContentHashes` (`plur reindex-hashes`)
 * repairs them on demand; this migration folds the same repair into
 * `plur migrate`, which runs under the corpus lock with a backup and rollback.
 *
 * ## It must agree with `repairContentHashes`, not merely resemble it
 *
 * Both run over the same corpus from different entry points, so any divergence
 * makes the store's hashes depend on which one ran. Change these three rules
 * together with that method or not at all.
 *
 * 1. **Skip statement-less rows.** Nothing to hash.
 *
 * 2. **Skip unhashable statements**: those that normalize away entirely (all
 *    punctuation, all emoji). Hashing them stamps SHA-256 of the empty string
 *    onto every one, so they share a hash and dedup absorbs them into a single
 *    engram.
 *
 *    Any SHA-256("") value already stamped on such a row is left in place,
 *    matching `repairContentHashes`. It is inert because every matcher
 *    (`_hashDedup`, the cross-scope recurrence path, `learn`'s primary-delegate
 *    check) refuses to match an unhashable statement before comparing hashes.
 *
 * 3. **Only rewrite when the value actually changes.** An ASCII statement's v2
 *    hash is byte-identical to its v1 hash, which covers most rows; rewriting
 *    them would touch every row to change nothing.
 *
 * ## down()
 *
 * A no-op. v1 hashes were wrong, and v1's output cannot be recovered from
 * v2's, so "restore" could only mean recomputing under the faulty normalizer.
 */
export const migration: Migration = {
  id: '20260813-006-recompute-content-hashes',
  description: 'Recompute content_hash with the Unicode-aware normalizer (#896, #911)',
  up(engrams: Engram[]): Engram[] {
    return engrams.map(e => {
      if (!e.statement || !isHashable(e.statement)) return e
      const correct = computeContentHash(e.statement)
      if ((e as { content_hash?: string }).content_hash === correct) return e
      return { ...e, content_hash: correct } as Engram
    })
  },
  down(engrams: Engram[]): Engram[] {
    return engrams
  },
}
